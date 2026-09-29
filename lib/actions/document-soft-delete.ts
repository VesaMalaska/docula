"use server";

import { FieldValue } from "firebase-admin/firestore";
import {
    verifyIdToken,
    authorizeSpaceContributor,
    getDocumentContentUrls,
} from "../server/document-authorization";
import { getAdminFirestore } from "../server/firebase-admin";
import { softDeleteImages, restoreImages } from "./s3";
import {
    calculateSubtreeHeightFromPaths,
    MAX_LIFECYCLE_DOCUMENT_LIMIT,
    MAX_LIFECYCLE_IMAGE_LIMIT,
} from "../utils/hierarchy";
import type { RestoreDestination } from "../types";

const S3_CONCURRENCY_LIMIT = 10;

async function processImagesInBoundedChunks(
    idToken: string | undefined,
    spaceId: string,
    items: { docId: string; urls: string[] }[],
    actionFn: (idToken: string | undefined, spaceId: string, docId: string, urls: string[]) => Promise<void>,
    chunkSize: number = S3_CONCURRENCY_LIMIT
): Promise<void> {
    for (const item of items) {
        for (let i = 0; i < item.urls.length; i += chunkSize) {
            const chunk = item.urls.slice(i, i + chunkSize);
            await actionFn(idToken, spaceId, item.docId, chunk);
        }
    }
}

export async function getDocumentDescendantSummaryAction(
    idToken: string | undefined,
    spaceId: string,
    docId: string
): Promise<{ descendantCount: number; totalAffectedCount: number }> {
    if (!spaceId || typeof spaceId !== "string" || !docId || typeof docId !== "string") {
        throw new Error("Invalid request identifiers");
    }

    const { uid } = await verifyIdToken(idToken);
    await authorizeSpaceContributor(uid, spaceId);

    const db = getAdminFirestore();
    const docRef = db.collection("documents").doc(docId);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
        throw new Error("Document not found");
    }

    const docData = docSnap.data();
    if (!docData || docData.spaceId !== spaceId) {
        throw new Error("Document does not belong to the specified space");
    }

    const descendantsSnap = await db
        .collection("documents")
        .where("spaceId", "==", spaceId)
        .where("path", "array-contains", docId)
        .get();

    const activeDescendants = descendantsSnap.docs.filter((d) => {
        const data = d.data();
        return !data?.deleted && data?.deletedAt == null;
    });

    const descendantCount = activeDescendants.length;
    return {
        descendantCount,
        totalAffectedCount: descendantCount + 1,
    };
}

export async function softDeleteDocumentAction(
    idToken: string | undefined,
    spaceId: string,
    docId: string,
    strategy: "move-descendants" | "delete-subtree",
    destinationParentId?: string | null
): Promise<{ success: boolean; affectedCount: number }> {
    if (!spaceId || typeof spaceId !== "string" || !docId || typeof docId !== "string") {
        throw new Error("Invalid request identifiers");
    }
    if (strategy !== "move-descendants" && strategy !== "delete-subtree") {
        throw new Error("Invalid deletion strategy");
    }
    if (strategy === "move-descendants" && destinationParentId !== null && typeof destinationParentId !== "string") {
        throw new Error("Destination parent ID must be specified for move strategy");
    }

    // 1. Verify token & Space contributor authorization
    const { uid } = await verifyIdToken(idToken);
    let spaceData: { ownerId?: string } | undefined;
    try {
        spaceData = await authorizeSpaceContributor(uid, spaceId);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "";
        if (msg === "Space is deleted") {
            throw new Error("Cannot delete document from a soft-deleted space.");
        }
        throw err;
    }
    const isSpaceOwner = spaceData?.ownerId === uid;

    const db = getAdminFirestore();
    const targetRef = db.collection("documents").doc(docId);

    // 2. Commit root lifecycle claim FIRST before querying descendants (Claim-Before-Query ordering & Retry Identity)
    let opId: string = "";
    let targetPath: string[] = [];
    await db.runTransaction(async (tx) => {
        const targetSnap = await tx.get(targetRef);
        if (!targetSnap.exists) {
            throw new Error("Document not found");
        }
        const targetData = targetSnap.data();
        if (!targetData) {
            throw new Error("Document data is missing");
        }
        if (targetData.spaceId !== spaceId) {
            throw new Error("Document does not belong to the specified space");
        }
        if (targetData.deleted === true || targetData.deletedAt != null) {
            throw new Error("Cannot delete an already deleted document");
        }
        if (targetData.permanentDeletionClaim != null) {
            throw new Error("Cannot delete a document pending permanent deletion");
        }
        if (targetData.lifecycleClaim) {
            const canAdopt =
                (targetData.lifecycleClaim.claimedBy === uid || isSpaceOwner) &&
                targetData.lifecycleClaim.operation === "soft-delete";
            if (!canAdopt) {
                throw new Error("Document is currently locked by another lifecycle operation");
            }
            if (targetData.lifecycleClaim.strategy && targetData.lifecycleClaim.strategy !== strategy) {
                throw new Error("Cannot change strategy on an active lifecycle claim");
            }
            opId = targetData.lifecycleClaim.opId || crypto.randomUUID();
        } else {
            opId = crypto.randomUUID();
        }
        targetPath = Array.isArray(targetData.path) ? targetData.path : [];

        tx.update(targetRef, {
            lifecycleClaim: {
                claimedAt: FieldValue.serverTimestamp(),
                claimedBy: uid,
                operation: "soft-delete" as const,
                strategy,
                opId,
            },
        });
    });

    // 3. Query complete subtree from trusted Firestore data
    // Because the root document now has an active lifecycleClaim in Firestore, Firestore Rules
    // prevent any direct client from creating or moving documents beneath this root.
    const descendantsSnap = await db
        .collection("documents")
        .where("spaceId", "==", spaceId)
        .where("path", "array-contains", docId)
        .get();

    const allDescDocs = descendantsSnap.docs;

    // Distinguish active descendants from historical already-deleted descendants
    const activeDescDocs = allDescDocs.filter((d) => {
        const data = d.data();
        return !data.deleted && data.deletedAt == null;
    });

    let affectedDescDocs: typeof allDescDocs = [];
    let pathRewriteOnlyDocs: typeof allDescDocs = [];

    if (strategy === "delete-subtree") {
        // "delete-subtree":
        // Only active descendants participate in the new deletion group.
        // Historical already-deleted descendants remain independent, untouched, and are not absorbed.
        affectedDescDocs = activeDescDocs;
        pathRewriteOnlyDocs = [];
    } else {
        // "move-descendants":
        // Select ONLY active direct children of docId for reparenting.
        const activeDirectChildren = activeDescDocs.filter((d) => d.data().parentId === docId);

        if (activeDirectChildren.length === 0) {
            // Leaf deletion: no active direct children exist to move.
            // Historical already-deleted descendants remain untouched.
            affectedDescDocs = [];
            pathRewriteOnlyDocs = [];
        } else {
            const activeDirectChildIds = new Set(activeDirectChildren.map((d) => d.id));

            // Any document in allDescDocs whose path contains an activeDirectChild ID
            // (or is an activeDirectChild itself) is in the moving subtrees.
            const movingDocs = allDescDocs.filter((d) => {
                if (activeDirectChildIds.has(d.id)) return true;
                const path = Array.isArray(d.data().path) ? d.data().path : [];
                return path.some((id: string) => activeDirectChildIds.has(id));
            });

            // Active moving descendants
            affectedDescDocs = movingDocs.filter((d) => {
                const data = d.data();
                return !data.deleted && data.deletedAt == null;
            });

            // Historical already-deleted descendants beneath a moving active child.
            // These require only a canonical path rewrite relative to their unchanged parent.
            pathRewriteOnlyDocs = movingDocs.filter((d) => {
                const data = d.data();
                return data.deleted === true || data.deletedAt != null;
            });
        }
    }

    const totalAffectedCount = 1 + affectedDescDocs.length;
    const totalDocsToWrite = 1 + affectedDescDocs.length + pathRewriteOnlyDocs.length;

    // 4. Safe write limit check before external mutations
    if (totalDocsToWrite > MAX_LIFECYCLE_DOCUMENT_LIMIT) {
        // Release root claim so user can delete subdocuments in smaller batches
        await targetRef.update({ lifecycleClaim: null });
        throw new Error(
            `Operation exceeds safe atomic limit of ${MAX_LIFECYCLE_DOCUMENT_LIMIT} documents. Please delete subdocuments in smaller batches.`
        );
    }

    const docsToOperate = [...affectedDescDocs, ...pathRewriteOnlyDocs];

    // 5. Verify all operating descendants belong to the same space and are not claimed by other operations
    for (const desc of docsToOperate) {
        const dData = desc.data();
        if (dData.spaceId !== spaceId) {
            throw new Error("Subtree document belongs to a different space");
        }
        if (dData.permanentDeletionClaim != null) {
            throw new Error("A subdocument is pending permanent deletion");
        }
        if (dData.lifecycleClaim) {
            const canAdopt =
                (dData.lifecycleClaim.claimedBy === uid || isSpaceOwner) &&
                (dData.lifecycleClaim.opId === opId || !dData.lifecycleClaim.opId) &&
                (!dData.lifecycleClaim.strategy || dData.lifecycleClaim.strategy === strategy);
            if (!canAdopt) {
                throw new Error("A subdocument is currently locked by another lifecycle operation");
            }
        }
    }

    // 6. Pre-flight strategy-specific validation
    let destDepth = 0;

    if (strategy === "move-descendants" && docsToOperate.length > 0) {
        if (destinationParentId === docId) {
            throw new Error("Cannot move subdocuments under the document being deleted");
        }

        if (!destinationParentId) {
            destDepth = 0;
        } else {
            if (docsToOperate.some((d) => d.id === destinationParentId)) {
                throw new Error("Cannot move subdocuments under a document in the deleted subtree");
            }

            const destRef = db.collection("documents").doc(destinationParentId);
            const destSnap = await destRef.get();
            if (!destSnap.exists) {
                throw new Error("Destination document not found");
            }
            const destData = destSnap.data();
            if (!destData) {
                throw new Error("Destination document data is missing");
            }
            if (destData.spaceId !== spaceId) {
                throw new Error("Cannot move subdocuments to a different space");
            }
            if (destData.deleted === true || destData.deletedAt != null) {
                throw new Error("Cannot move subdocuments under a deleted document");
            }
            if (destData.permanentDeletionClaim != null || destData.lifecycleClaim != null) {
                throw new Error("Destination document is locked by another lifecycle operation");
            }

            const rawDestPath = Array.isArray(destData.path) ? destData.path : [];
            for (const ancId of rawDestPath) {
                if (ancId === docId || docsToOperate.some((d) => d.id === ancId)) {
                    throw new Error("Cannot move subdocuments under a descendant of the deleted document");
                }
                const ancSnap = await db.collection("documents").doc(ancId).get();
                if (!ancSnap.exists) {
                    throw new Error("Destination ancestor document not found");
                }
                const ancData = ancSnap.data();
                if (
                    ancData?.spaceId !== spaceId ||
                    ancData?.deleted === true ||
                    ancData?.permanentDeletionClaim != null ||
                    ancData?.lifecycleClaim != null
                ) {
                    throw new Error("Destination ancestor document is deleted or claimed");
                }
            }

            destDepth = rawDestPath.length + 1;
        }

        for (const desc of docsToOperate) {
            const dData = desc.data();
            const dPath = Array.isArray(dData.path) ? dData.path : [];
            const targetIdx = dPath.indexOf(docId);
            if (targetIdx === -1) continue;
            const relativeDepth = dPath.length - targetPath.length;
            if (destDepth + relativeDepth > 4) {
                throw new Error("Moving subdocuments to this destination exceeds the maximum hierarchy depth of 4 levels");
            }
        }
    }

    // 7. Establish concurrency claims across operating descendants
    if (docsToOperate.length > 0) {
        const claimBatch = db.batch();
        const claimData = {
            claimedAt: FieldValue.serverTimestamp(),
            claimedBy: uid,
            operation: "soft-delete" as const,
            strategy,
            opId,
        };
        for (const desc of docsToOperate) {
            claimBatch.update(desc.ref, { lifecycleClaim: claimData });
        }
        await claimBatch.commit();
    }

    // 8. Bounded S3 Phase
    const docImagesList: { docId: string; urls: string[] }[] = [];
    let totalImageCount = 0;

    if (strategy === "move-descendants") {
        const urls = await getDocumentContentUrls(docId);
        if (urls.length > 0) {
            docImagesList.push({ docId, urls });
            totalImageCount += urls.length;
        }
    } else {
        const allDocsToDelete = [{ id: docId }, ...affectedDescDocs];
        for (const d of allDocsToDelete) {
            const urls = await getDocumentContentUrls(d.id);
            if (urls.length > 0) {
                docImagesList.push({ docId: d.id, urls });
                totalImageCount += urls.length;
            }
        }
    }

    if (totalImageCount > MAX_LIFECYCLE_IMAGE_LIMIT) {
        throw new Error(
            `Operation exceeds safe atomic limit of ${MAX_LIFECYCLE_IMAGE_LIMIT} images. Found ${totalImageCount} images.`
        );
    }

    try {
        await processImagesInBoundedChunks(idToken, spaceId, docImagesList, softDeleteImages, S3_CONCURRENCY_LIMIT);
    } catch (err) {
        // Fail closed: retain lifecycle claim on S3 failure to protect state and allow safe retry
        throw err;
    }

    // 9. Final Admin Firestore Transaction (Close destination TOCTOU window)
    const deletionGroupId = strategy === "delete-subtree" ? crypto.randomUUID() : null;

    try {
        await db.runTransaction(async (tx) => {
            // Re-read root doc & verify claim identity
            const freshRootSnap = await tx.get(targetRef);
            if (!freshRootSnap.exists) {
                throw new Error("Root document not found during final commit");
            }
            const freshRootData = freshRootSnap.data();
            if (
                !freshRootData ||
                freshRootData.lifecycleClaim?.opId !== opId ||
                freshRootData.lifecycleClaim?.operation !== "soft-delete" ||
                freshRootData.lifecycleClaim?.strategy !== strategy
            ) {
                throw new Error("Root document lifecycle claim has been modified or invalidated");
            }

            // Re-read destination (if moving descendants)
            let txDestPath: string[] = [];

            if (strategy === "move-descendants" && docsToOperate.length > 0) {
                if (!destinationParentId) {
                    txDestPath = [];
                } else {
                    const destRef = db.collection("documents").doc(destinationParentId);
                    const freshDestSnap = await tx.get(destRef);
                    if (!freshDestSnap.exists) {
                        throw new Error("Destination document no longer exists");
                    }
                    const freshDestData = freshDestSnap.data();
                    if (!freshDestData) {
                        throw new Error("Destination document data is missing");
                    }
                    if (freshDestData.spaceId !== spaceId) {
                        throw new Error("Destination document belongs to a different space");
                    }
                    if (freshDestData.deleted === true || freshDestData.deletedAt != null) {
                        throw new Error("Destination document has been deleted");
                    }
                    if (freshDestData.permanentDeletionClaim != null || freshDestData.lifecycleClaim != null) {
                        throw new Error("Destination document has been locked by another lifecycle operation");
                    }

                    const freshRawDestPath = Array.isArray(freshDestData.path) ? freshDestData.path : [];
                    if (freshRawDestPath.includes(docId) || destinationParentId === docId) {
                        throw new Error("Destination document is within the deleted subtree");
                    }

                    for (const ancId of freshRawDestPath) {
                        const ancSnap = await tx.get(db.collection("documents").doc(ancId));
                        if (!ancSnap.exists) {
                            throw new Error("Destination ancestor document no longer exists");
                        }
                        const ancData = ancSnap.data();
                        if (
                            ancData?.spaceId !== spaceId ||
                            ancData?.deleted === true ||
                            ancData?.permanentDeletionClaim != null ||
                            ancData?.lifecycleClaim != null
                        ) {
                            throw new Error("Destination ancestor document has been deleted or claimed");
                        }
                    }

                    txDestPath = [...freshRawDestPath, destinationParentId];
                }
            }

            // Re-read operating descendants and verify subtree membership
            const freshAffectedList: { ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown>; id: string }[] = [];
            for (const desc of affectedDescDocs) {
                const freshSnap = await tx.get(desc.ref);
                if (!freshSnap.exists) {
                    throw new Error(`Descendant document ${desc.id} no longer exists`);
                }
                const freshData = freshSnap.data()!;
                if (freshData.spaceId !== spaceId) {
                    throw new Error(`Descendant document ${desc.id} belongs to a different space`);
                }
                if (
                    freshData.lifecycleClaim?.opId !== opId ||
                    freshData.lifecycleClaim?.operation !== "soft-delete" ||
                    freshData.lifecycleClaim?.strategy !== strategy
                ) {
                    throw new Error(`Descendant document ${desc.id} lifecycle claim was altered`);
                }
                const currentPath = Array.isArray(freshData.path) ? freshData.path : [];
                if (!currentPath.includes(docId)) {
                    throw new Error(`Descendant document ${desc.id} is no longer in the deleted subtree`);
                }
                freshAffectedList.push({ ref: desc.ref, data: freshData, id: desc.id });
            }

            const freshPathRewriteList: { ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown>; id: string }[] = [];
            for (const desc of pathRewriteOnlyDocs) {
                const freshSnap = await tx.get(desc.ref);
                if (!freshSnap.exists) {
                    throw new Error(`Descendant document ${desc.id} no longer exists`);
                }
                const freshData = freshSnap.data()!;
                if (freshData.spaceId !== spaceId) {
                    throw new Error(`Descendant document ${desc.id} belongs to a different space`);
                }
                if (
                    freshData.lifecycleClaim?.opId !== opId ||
                    freshData.lifecycleClaim?.operation !== "soft-delete" ||
                    freshData.lifecycleClaim?.strategy !== strategy
                ) {
                    throw new Error(`Descendant document ${desc.id} lifecycle claim was altered`);
                }
                const currentPath = Array.isArray(freshData.path) ? freshData.path : [];
                if (!currentPath.includes(docId)) {
                    throw new Error(`Descendant document ${desc.id} is no longer in the deleted subtree`);
                }
                freshPathRewriteList.push({ ref: desc.ref, data: freshData, id: desc.id });
            }

            // Recalculate canonical paths and recheck 4-level limit
            if (strategy === "move-descendants") {
                for (const item of [...freshAffectedList, ...freshPathRewriteList]) {
                    const dPath = Array.isArray(item.data.path) ? item.data.path : [];
                    const targetIdx = dPath.indexOf(docId);
                    const remainingPath = targetIdx !== -1 ? dPath.slice(targetIdx + 1) : [];
                    const newPath = [...txDestPath, ...remainingPath];
                    const newDepth = newPath.length + 1;
                    if (newDepth > 4) {
                        throw new Error("Moving subdocuments to this destination exceeds the maximum hierarchy depth of 4 levels");
                    }
                }
            }

            // Write atomic updates in transaction
            const originalParentId = (freshRootData.parentId ?? null) as string | null;

            // Write atomic updates in transaction
            if (strategy === "move-descendants") {
                tx.update(targetRef, {
                    deleted: true,
                    deletedAt: FieldValue.serverTimestamp(),
                    deletedBy: uid,
                    parentId: null,
                    path: [],
                    restoreParentId: originalParentId,
                    lifecycleClaim: null,
                });

                for (const item of freshAffectedList) {
                    const dPath = Array.isArray(item.data.path) ? item.data.path : [];
                    const targetIdx = dPath.indexOf(docId);
                    const remainingPath = targetIdx !== -1 ? dPath.slice(targetIdx + 1) : [];
                    const newPath = [...txDestPath, ...remainingPath];

                    const updates: Record<string, unknown> = {
                        path: newPath,
                        lifecycleClaim: null,
                        updatedAt: FieldValue.serverTimestamp(),
                    };

                    if (item.data.parentId === docId) {
                        updates.parentId = destinationParentId ?? null;
                    }

                    tx.update(item.ref, updates);
                }

                for (const item of freshPathRewriteList) {
                    const dPath = Array.isArray(item.data.path) ? item.data.path : [];
                    const targetIdx = dPath.indexOf(docId);
                    const remainingPath = targetIdx !== -1 ? dPath.slice(targetIdx + 1) : [];
                    const newPath = [...txDestPath, ...remainingPath];

                    // Preserve parentId, deleted, deletedAt, deletedBy, deletionGroupId, deletionGroupRootId, deletionGroupCount!
                    tx.update(item.ref, {
                        path: newPath,
                        lifecycleClaim: null,
                        updatedAt: FieldValue.serverTimestamp(),
                    });
                }
            } else {
                tx.update(targetRef, {
                    deleted: true,
                    deletedAt: FieldValue.serverTimestamp(),
                    deletedBy: uid,
                    deletionGroupId,
                    deletionGroupRootId: docId,
                    deletionGroupCount: totalAffectedCount,
                    parentId: null,
                    path: [],
                    restoreParentId: originalParentId,
                    lifecycleClaim: null,
                });

                for (const item of freshAffectedList) {
                    const dPath = Array.isArray(item.data.path) ? item.data.path : [];
                    const targetIdx = dPath.indexOf(docId);
                    const trashLocalPath = targetIdx !== -1 ? dPath.slice(targetIdx) : [docId];
                    tx.update(item.ref, {
                        deleted: true,
                        deletedAt: FieldValue.serverTimestamp(),
                        deletedBy: uid,
                        deletionGroupId,
                        deletionGroupRootId: docId,
                        path: trashLocalPath,
                        lifecycleClaim: null,
                    });
                }
            }
        });
    } catch (err) {
        // Fail closed: retain lifecycle claim on transaction failure
        throw err;
    }

    return {
        success: true,
        affectedCount: totalAffectedCount,
    };
}

export async function restoreDocumentAction(
    idToken: string | undefined,
    spaceId: string,
    docId: string,
    destination: RestoreDestination
): Promise<{ success: boolean; restoredCount: number; requiresDestination?: boolean }> {
    if (!spaceId || typeof spaceId !== "string" || !docId || typeof docId !== "string") {
        throw new Error("Invalid request identifiers");
    }

    if (!destination || typeof destination !== "object" || !("kind" in destination)) {
        throw new Error("Invalid restoration destination: explicit tagged destination object required");
    }
    if (destination.kind !== "original" && destination.kind !== "root" && destination.kind !== "document") {
        throw new Error(`Invalid restoration destination kind: ${(destination as { kind: unknown }).kind}`);
    }
    if (destination.kind === "document" && (!destination.parentId || typeof destination.parentId !== "string")) {
        throw new Error("Invalid restoration destination: parentId string required for document destination");
    }

    // 1. Verify token & Space contributor authorization
    const { uid } = await verifyIdToken(idToken);
    let spaceData: { ownerId?: string } | undefined;
    try {
        spaceData = await authorizeSpaceContributor(uid, spaceId);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "";
        if (msg === "Space is deleted") {
            throw new Error("Cannot restore document from a soft-deleted space.");
        }
        throw err;
    }
    const isSpaceOwner = spaceData?.ownerId === uid;

    const db = getAdminFirestore();

    // 2. Read target document
    const targetRef = db.collection("documents").doc(docId);
    const targetSnap = await targetRef.get();
    if (!targetSnap.exists) {
        throw new Error("Document not found");
    }
    const targetData = targetSnap.data();
    if (!targetData) {
        throw new Error("Document data is missing");
    }
    if (targetData.spaceId !== spaceId) {
        throw new Error("Document does not belong to the specified space");
    }
    if (targetData.deleted !== true || targetData.deletedAt == null) {
        throw new Error("Document is not soft-deleted");
    }
    if (targetData.permanentDeletionClaim != null) {
        throw new Error("Cannot restore a document that is pending permanent deletion");
    }

    // Determine / adopt retry identity
    let opId: string;
    if (targetData.lifecycleClaim) {
        const canAdopt =
            (targetData.lifecycleClaim.claimedBy === uid || isSpaceOwner) &&
            targetData.lifecycleClaim.operation === "restore";
        if (!canAdopt) {
            throw new Error("Document is currently locked by another lifecycle operation");
        }
        opId = targetData.lifecycleClaim.opId || crypto.randomUUID();
    } else {
        opId = crypto.randomUUID();
    }

    // Claim target root document first
    await targetRef.update({
        lifecycleClaim: {
            claimedAt: FieldValue.serverTimestamp(),
            claimedBy: uid,
            operation: "restore" as const,
            opId,
        },
    });

    // 3. Determine if document is part of a deletion group
    const deletionGroupId = targetData.deletionGroupId;

    if (deletionGroupId) {
        // Reject non-root group restoration
        if (targetData.deletionGroupRootId !== docId) {
            await targetRef.update({ lifecycleClaim: null });
            throw new Error("This document is part of a deleted subtree. Restore the entire group from the root document.");
        }

        // Load all group members
        const groupSnap = await db
            .collection("documents")
            .where("spaceId", "==", spaceId)
            .where("deletionGroupId", "==", deletionGroupId)
            .get();

        const groupDocs = groupSnap.docs;
        const totalCount = groupDocs.length;

        if (totalCount > MAX_LIFECYCLE_DOCUMENT_LIMIT) {
            await targetRef.update({ lifecycleClaim: null });
            throw new Error(
                `Operation exceeds safe atomic limit of ${MAX_LIFECYCLE_DOCUMENT_LIMIT} documents.`
            );
        }

        // Verify all group members belong to space and are not claimed by others
        for (const gDoc of groupDocs) {
            const gd = gDoc.data();
            if (gd.spaceId !== spaceId || gd.deletionGroupId !== deletionGroupId) {
                throw new Error("Inconsistent deletion group membership detected");
            }
            if (gd.permanentDeletionClaim != null) {
                throw new Error("A group document is pending permanent deletion");
            }
            if (gd.lifecycleClaim) {
                const canAdopt =
                    (gd.lifecycleClaim.claimedBy === uid || isSpaceOwner) &&
                    (gd.lifecycleClaim.opId === opId || !gd.lifecycleClaim.opId);
                if (!canAdopt) {
                    throw new Error("A group document is locked by another lifecycle operation");
                }
            }
        }

        // 4. Resolve and validate external destination parent
        let originalParentId: string | null;
        if ("restoreParentId" in targetData) {
            originalParentId = targetData.restoreParentId ?? null;
        } else {
            originalParentId = targetData.parentId ?? null; // legacy fallback
        }

        let effectiveParentId: string | null;

        if (destination.kind === "original") {
            effectiveParentId = originalParentId;
        } else if (destination.kind === "root") {
            effectiveParentId = null;
        } else if (destination.kind === "document") {
            effectiveParentId = destination.parentId;
        } else {
            throw new Error("Unsupported restoration destination kind");
        }

        let destDepth = 0;

        if (effectiveParentId === null) {
            destDepth = 0;
        } else {
            const parentRef = db.collection("documents").doc(effectiveParentId);
            const parentSnap = await parentRef.get();

            if (
                !parentSnap.exists ||
                parentSnap.data()?.spaceId !== spaceId ||
                parentSnap.data()?.deleted === true ||
                parentSnap.data()?.deletedAt != null ||
                parentSnap.data()?.permanentDeletionClaim != null ||
                parentSnap.data()?.lifecycleClaim != null
            ) {
                if (destination.kind === "original") {
                    await targetRef.update({ lifecycleClaim: null });
                    return { success: false, restoredCount: 0, requiresDestination: true };
                }
                throw new Error("Selected destination parent is deleted, claimed, or unavailable");
            }

            const pData = parentSnap.data();
            const pPath = Array.isArray(pData?.path) ? pData.path : [];

            for (const ancId of pPath) {
                const ancSnap = await db.collection("documents").doc(ancId).get();
                if (
                    !ancSnap.exists ||
                    ancSnap.data()?.spaceId !== spaceId ||
                    ancSnap.data()?.deleted === true ||
                    ancSnap.data()?.deletedAt != null ||
                    ancSnap.data()?.permanentDeletionClaim != null ||
                    ancSnap.data()?.lifecycleClaim != null
                ) {
                    if (destination.kind === "original") {
                        await targetRef.update({ lifecycleClaim: null });
                        return { success: false, restoredCount: 0, requiresDestination: true };
                    }
                    throw new Error("Selected destination parent ancestor is deleted or claimed");
                }
            }

            destDepth = pPath.length + 1;
        }

        // Depth check
        const groupPaths = groupDocs.map((d) => (Array.isArray(d.data().path) ? d.data().path : []));
        const groupSubtreeHeight = calculateSubtreeHeightFromPaths(docId, groupPaths);
        if (destDepth + groupSubtreeHeight > 4) {
            if (destination.kind === "original") {
                await targetRef.update({ lifecycleClaim: null });
                return { success: false, restoredCount: 0, requiresDestination: true };
            }
            throw new Error("Restoring to this destination exceeds the maximum hierarchy depth of 4 levels");
        }

        // 5. Establish claims across group
        const claimBatch = db.batch();
        for (const gDoc of groupDocs) {
            claimBatch.update(gDoc.ref, {
                lifecycleClaim: {
                    claimedAt: FieldValue.serverTimestamp(),
                    claimedBy: uid,
                    operation: "restore" as const,
                    opId,
                },
            });
        }
        await claimBatch.commit();

        // 6. Bounded S3 Phase
        const docImagesList: { docId: string; urls: string[] }[] = [];
        let totalImageCount = 0;
        for (const gDoc of groupDocs) {
            const urls = await getDocumentContentUrls(gDoc.id);
            if (urls.length > 0) {
                docImagesList.push({ docId: gDoc.id, urls });
                totalImageCount += urls.length;
            }
        }

        if (totalImageCount > MAX_LIFECYCLE_IMAGE_LIMIT) {
            throw new Error(
                `Operation exceeds safe atomic limit of ${MAX_LIFECYCLE_IMAGE_LIMIT} images. Found ${totalImageCount} images.`
            );
        }

        try {
            await processImagesInBoundedChunks(idToken, spaceId, docImagesList, restoreImages, S3_CONCURRENCY_LIMIT);
        } catch (err) {
            // Fail closed: retain lifecycle claim on S3 failure
            throw err;
        }

        // 7. Final Admin Firestore Transaction (Close TOCTOU window)
        try {
            await db.runTransaction(async (tx) => {
                // Re-read root doc
                const freshRootSnap = await tx.get(targetRef);
                if (!freshRootSnap.exists) {
                    throw new Error("Root document not found during final restore commit");
                }
                const freshRootData = freshRootSnap.data();
                if (
                    !freshRootData ||
                    freshRootData.lifecycleClaim?.opId !== opId ||
                    freshRootData.lifecycleClaim?.operation !== "restore"
                ) {
                    throw new Error("Root document lifecycle claim has been modified or invalidated");
                }

                // Re-read destination parent if not Space root
                let txNewRootPath: string[] = [];
                if (effectiveParentId !== null) {
                    const parentRef = db.collection("documents").doc(effectiveParentId);
                    const freshParentSnap = await tx.get(parentRef);
                    if (!freshParentSnap.exists) {
                        throw new Error("Selected destination parent no longer exists");
                    }
                    const freshParentData = freshParentSnap.data();
                    if (!freshParentData || freshParentData.spaceId !== spaceId) {
                        throw new Error("Selected destination parent belongs to a different space");
                    }
                    if (freshParentData.deleted === true || freshParentData.deletedAt != null) {
                        throw new Error("Selected destination parent has been deleted");
                    }
                    if (freshParentData.permanentDeletionClaim != null || freshParentData.lifecycleClaim != null) {
                        throw new Error("Selected destination parent has been locked by another lifecycle operation");
                    }

                    const freshPPath = Array.isArray(freshParentData.path) ? freshParentData.path : [];
                    for (const ancId of freshPPath) {
                        const ancSnap = await tx.get(db.collection("documents").doc(ancId));
                        if (!ancSnap.exists) {
                            throw new Error("Destination ancestor document no longer exists");
                        }
                        const ancData = ancSnap.data();
                        if (
                            ancData?.spaceId !== spaceId ||
                            ancData?.deleted === true ||
                            ancData?.permanentDeletionClaim != null ||
                            ancData?.lifecycleClaim != null
                        ) {
                            throw new Error("Destination ancestor document is deleted or claimed");
                        }
                    }

                    txNewRootPath = [...freshPPath, effectiveParentId];
                }

                // Re-read all group members
                const freshGroupList: { ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown>; id: string }[] = [];
                for (const gDoc of groupDocs) {
                    const freshSnap = await tx.get(gDoc.ref);
                    if (!freshSnap.exists) {
                        throw new Error(`Group document ${gDoc.id} no longer exists`);
                    }
                    const freshData = freshSnap.data()!;
                    if (freshData.spaceId !== spaceId || freshData.deletionGroupId !== deletionGroupId) {
                        throw new Error(`Group document ${gDoc.id} membership was modified`);
                    }
                    if (freshData.lifecycleClaim?.opId !== opId) {
                        throw new Error(`Group document ${gDoc.id} claim was modified`);
                    }
                    freshGroupList.push({ ref: gDoc.ref, data: freshData, id: gDoc.id });
                }

                // Recalculate paths & recheck 4-level limit
                for (const item of freshGroupList) {
                    if (item.id === docId) {
                        if (txNewRootPath.length + 1 > 4) {
                            throw new Error("Restoring to this destination exceeds the maximum hierarchy depth of 4 levels");
                        }
                    } else {
                        const gOldPath = Array.isArray(item.data.path) ? item.data.path : [];
                        const targetIdx = gOldPath.indexOf(docId);
                        const relativePath = targetIdx !== -1 ? gOldPath.slice(targetIdx) : [docId];
                        const calcPath = [...txNewRootPath, ...relativePath];
                        if (calcPath.length + 1 > 4) {
                            throw new Error("Restoring to this destination exceeds the maximum hierarchy depth of 4 levels");
                        }
                    }
                }

                // Commit atomic updates
                for (const item of freshGroupList) {
                    const isRoot = item.id === docId;
                    const gOldPath = Array.isArray(item.data.path) ? item.data.path : [];

                    const updates: Record<string, unknown> = {
                        deleted: false,
                        deletedAt: null,
                        deletedBy: null,
                        deletionGroupId: null,
                        deletionGroupRootId: null,
                        deletionGroupCount: null,
                        lifecycleClaim: null,
                        restoreParentId: FieldValue.delete(),
                        updatedAt: FieldValue.serverTimestamp(),
                    };

                    if (isRoot) {
                        updates.parentId = effectiveParentId;
                        updates.path = txNewRootPath;
                    } else {
                        const targetIdx = gOldPath.indexOf(docId);
                        const relativePath = targetIdx !== -1 ? gOldPath.slice(targetIdx) : [docId];
                        updates.path = [...txNewRootPath, ...relativePath];
                    }

                    tx.update(item.ref, updates);
                }
            });
        } catch (err) {
            // Fail closed: retain lifecycle claim on transaction failure
            throw err;
        }

        return {
            success: true,
            restoredCount: totalCount,
        };
    } else {
        // Single document restoration
        let originalParentId: string | null;
        if ("restoreParentId" in targetData) {
            originalParentId = targetData.restoreParentId ?? null;
        } else {
            originalParentId = targetData.parentId ?? null; // legacy fallback
        }

        let effectiveParentId: string | null;

        if (destination.kind === "original") {
            effectiveParentId = originalParentId;
        } else if (destination.kind === "root") {
            effectiveParentId = null;
        } else if (destination.kind === "document") {
            effectiveParentId = destination.parentId;
        } else {
            throw new Error("Unsupported restoration destination kind");
        }

        if (effectiveParentId !== null) {
            const parentRef = db.collection("documents").doc(effectiveParentId);
            const parentSnap = await parentRef.get();

            if (
                !parentSnap.exists ||
                parentSnap.data()?.spaceId !== spaceId ||
                parentSnap.data()?.deleted === true ||
                parentSnap.data()?.deletedAt != null ||
                parentSnap.data()?.permanentDeletionClaim != null ||
                parentSnap.data()?.lifecycleClaim != null
            ) {
                if (destination.kind === "original") {
                    await targetRef.update({ lifecycleClaim: null });
                    return { success: false, restoredCount: 0, requiresDestination: true };
                }
                throw new Error("Selected destination parent is deleted, claimed, or unavailable");
            }

            const pData = parentSnap.data();
            const pPath = Array.isArray(pData?.path) ? pData.path : [];

            for (const ancId of pPath) {
                const ancSnap = await db.collection("documents").doc(ancId).get();
                if (
                    !ancSnap.exists ||
                    ancSnap.data()?.spaceId !== spaceId ||
                    ancSnap.data()?.deleted === true ||
                    ancSnap.data()?.deletedAt != null ||
                    ancSnap.data()?.permanentDeletionClaim != null ||
                    ancSnap.data()?.lifecycleClaim != null
                ) {
                    if (destination.kind === "original") {
                        await targetRef.update({ lifecycleClaim: null });
                        return { success: false, restoredCount: 0, requiresDestination: true };
                    }
                    throw new Error("Selected destination parent ancestor is deleted or claimed");
                }
            }

            if (pPath.length + 1 > 3) {
                if (destination.kind === "original") {
                    await targetRef.update({ lifecycleClaim: null });
                    return { success: false, restoredCount: 0, requiresDestination: true };
                }
                throw new Error("Restoring to this destination exceeds the maximum hierarchy depth of 4 levels");
            }
        }

        // Bounded S3 Phase
        const urls = await getDocumentContentUrls(docId);
        if (urls.length > MAX_LIFECYCLE_IMAGE_LIMIT) {
            throw new Error(
                `Operation exceeds safe atomic limit of ${MAX_LIFECYCLE_IMAGE_LIMIT} images. Found ${urls.length} images.`
            );
        }

        try {
            if (urls.length > 0) {
                await processImagesInBoundedChunks(idToken, spaceId, [{ docId, urls }], restoreImages, S3_CONCURRENCY_LIMIT);
            }
        } catch (err) {
            throw err;
        }

        // Final Admin Firestore Transaction
        try {
            await db.runTransaction(async (tx) => {
                const freshSnap = await tx.get(targetRef);
                if (!freshSnap.exists) {
                    throw new Error("Document not found during final restore commit");
                }
                const freshData = freshSnap.data();
                if (
                    !freshData ||
                    freshData.lifecycleClaim?.opId !== opId ||
                    freshData.lifecycleClaim?.operation !== "restore"
                ) {
                    throw new Error("Document lifecycle claim has been modified or invalidated");
                }

                let txNewPath: string[] = [];
                if (effectiveParentId !== null) {
                    const parentRef = db.collection("documents").doc(effectiveParentId);
                    const freshParentSnap = await tx.get(parentRef);
                    if (!freshParentSnap.exists) {
                        throw new Error("Selected destination parent no longer exists");
                    }
                    const freshParentData = freshParentSnap.data();
                    if (!freshParentData || freshParentData.spaceId !== spaceId) {
                        throw new Error("Selected destination parent belongs to a different space");
                    }
                    if (freshParentData.deleted === true || freshParentData.deletedAt != null) {
                        throw new Error("Selected destination parent has been deleted");
                    }
                    if (freshParentData.permanentDeletionClaim != null || freshParentData.lifecycleClaim != null) {
                        throw new Error("Selected destination parent is locked by another lifecycle operation");
                    }
                    const pPath = Array.isArray(freshParentData.path) ? freshParentData.path : [];
                    for (const ancId of pPath) {
                        const ancSnap = await tx.get(db.collection("documents").doc(ancId));
                        if (!ancSnap.exists) {
                            throw new Error("Destination ancestor document no longer exists");
                        }
                        const ancData = ancSnap.data();
                        if (
                            ancData?.spaceId !== spaceId ||
                            ancData?.deleted === true ||
                            ancData?.permanentDeletionClaim != null ||
                            ancData?.lifecycleClaim != null
                        ) {
                            throw new Error("Destination ancestor document is deleted or claimed");
                        }
                    }
                    if (pPath.length + 1 > 3) {
                        throw new Error("Restoring to this destination exceeds the maximum hierarchy depth of 4 levels");
                    }
                    txNewPath = [...pPath, effectiveParentId];
                }

                const updates: Record<string, unknown> = {
                    deleted: false,
                    deletedAt: null,
                    deletedBy: null,
                    lifecycleClaim: null,
                    restoreParentId: FieldValue.delete(),
                    parentId: effectiveParentId,
                    path: txNewPath,
                    updatedAt: FieldValue.serverTimestamp(),
                };

                tx.update(targetRef, updates);
            });
        } catch (err) {
            throw err;
        }

        return {
            success: true,
            restoredCount: 1,
        };
    }
}
