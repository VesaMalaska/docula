"use server";

import { FieldValue, type Transaction, type Firestore } from "firebase-admin/firestore";
import { getAdminFirestore } from "../server/firebase-admin";
import {
    verifyIdToken,
} from "../server/document-authorization";
import { cleanupRemovedDocumentImages } from "./s3";
import { extractImageUrls } from "../utils";
import type { UpdateDocumentData, UpdateDocumentOptions, UpdateDocumentResult } from "./document";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractLinks(content: any): string[] {
    const links = new Set<string>();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function traverse(node: any) {
        if (node.marks) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            node.marks.forEach((mark: any) => {
                if (mark.type === "link") {
                    const href = mark.attrs?.href;
                    if (href && href.includes("/doc/")) {
                        const id = href.split("/doc/")[1];
                        if (id) links.add(id);
                    }
                }
            });
        }
        if (node.content) {
            node.content.forEach(traverse);
        }
    }

    if (content) traverse(content);
    return Array.from(links);
}

function normalizeImageKey(urlOrKey: string): string {
    try {
        const urlObj = new URL(urlOrKey);
        let path = decodeURIComponent(urlObj.pathname);
        if (path.startsWith("/")) path = path.substring(1);
        if (path.startsWith("deleted/uploads/")) path = path.substring(16);
        else if (path.startsWith("uploads/")) path = path.substring(8);
        return path;
    } catch {
        let path = urlOrKey.startsWith("/") ? urlOrKey.substring(1) : urlOrKey;
        if (path.startsWith("deleted/uploads/")) path = path.substring(16);
        else if (path.startsWith("uploads/")) path = path.substring(8);
        return path;
    }
}

function getTimestampMillis(ts: unknown): number | null {
    if (!ts) return null;
    if (typeof ts === "number") return ts;
    if (ts instanceof Date) return ts.getTime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (ts as any).toMillis === "function") return (ts as any).toMillis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (ts as any).toDate === "function") return (ts as any).toDate().getTime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (ts as any).seconds === "number") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (ts as any).seconds * 1000 + Math.floor(((ts as any).nanoseconds || 0) / 1_000_000);
    }
    return null;
}

const PROTECTED_FIELDS = new Set([
    "spaceId",
    "parentId",
    "path",
    "createdAt",
    "updatedAt",
    "revision",
    "deleted",
    "deletedAt",
    "deletedBy",
    "deletionGroupId",
    "deletionGroupRootId",
    "deletionGroupCount",
    "restoreParentId",
    "permanentDeletionClaim",
    "lifecycleClaim",
    "imageCleanupClaim",
    "pendingImageCleanup",
    "retiredImageKeys",
    "backlinks",
    "outboundLinks",
    "lock",
]);

const ALLOWED_DATA_FIELDS = new Set([
    "id",
    "title",
    "tags",
    "content",
    "baseRevision",
    "baseUpdatedAt",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function canAffectTargetBacklink(targetSnap: any, docSpaceId: string): boolean {
    if (!targetSnap || !targetSnap.exists) return false;
    const targetData = typeof targetSnap.data === "function" ? targetSnap.data() : targetSnap.data;
    if (!targetData) return false;
    if (targetData.spaceId !== docSpaceId) return false;
    if (targetData.deleted === true || targetData.deletedAt != null) return false;
    if (targetData.permanentDeletionClaim || targetData.lifecycleClaim) return false;
    return true;
}

async function verifyAncestorsActive(
    transaction: Transaction,
    db: Firestore,
    path: unknown,
    parentId: unknown,
    docSpaceId: string
): Promise<void> {
    const rawPath = Array.isArray(path) ? path : [];
    const ancestorIds = [...rawPath];
    if (typeof parentId === "string" && parentId && !ancestorIds.includes(parentId)) {
        ancestorIds.push(parentId);
    }

    for (const ancestorId of ancestorIds) {
        if (!ancestorId || typeof ancestorId !== "string") continue;
        const ancestorRef = db.collection("documents").doc(ancestorId);
        const ancestorSnap = await transaction.get(ancestorRef);
        if (!ancestorSnap.exists) {
            throw new Error(`Cannot save document: ancestor "${ancestorId}" not found.`);
        }
        const ancestorData = ancestorSnap.data();
        if (!ancestorData) {
            throw new Error(`Cannot save document: ancestor "${ancestorId}" data missing.`);
        }
        if (ancestorData.spaceId !== docSpaceId) {
            throw new Error(`Cannot save document: ancestor "${ancestorId}" belongs to a different space.`);
        }
        if (ancestorData.deleted === true || ancestorData.deletedAt != null) {
            throw new Error(`Cannot save document: ancestor "${ancestorId}" is deleted.`);
        }
        if (ancestorData.permanentDeletionClaim || ancestorData.lifecycleClaim) {
            throw new Error(`Cannot save document: ancestor "${ancestorId}" is currently locked for a lifecycle operation.`);
        }
    }
}

export async function updateDocumentAction(
    idToken: string | undefined,
    id: string,
    data: UpdateDocumentData,
    options?: UpdateDocumentOptions
): Promise<UpdateDocumentResult> {
    if (!id || typeof id !== "string") {
        throw new Error("Invalid document ID");
    }

    if (!data || typeof data !== "object") {
        throw new Error("Invalid document data");
    }

    if (data.id !== undefined && data.id !== id) {
        throw new Error("Cannot update document: document ID mismatch.");
    }

    for (const key of Object.keys(data)) {
        if (PROTECTED_FIELDS.has(key)) {
            throw new Error(`Cannot update document: field "${key}" is protected and cannot be modified directly.`);
        }
        if (!ALLOWED_DATA_FIELDS.has(key)) {
            throw new Error(`Cannot update document: field "${key}" is not allowed.`);
        }
    }

    if (data.title !== undefined && typeof data.title !== "string") {
        throw new Error("Cannot update document: title must be a string.");
    }

    if (
        data.tags !== undefined &&
        (!Array.isArray(data.tags) || !data.tags.every((t) => typeof t === "string"))
    ) {
        throw new Error("Cannot update document: tags must be an array of strings.");
    }

    const { uid } = await verifyIdToken(idToken);

    const db = getAdminFirestore();
    const docRef = db.collection("documents").doc(id);
    const contentRef = docRef.collection("content").doc("main");

    const contentField = data.content;
    const baseRevision = options?.baseRevision !== undefined ? options.baseRevision : data.baseRevision;
    const baseUpdatedAt = options?.baseUpdatedAt !== undefined ? options.baseUpdatedAt : data.baseUpdatedAt;

    if (contentField !== undefined) {
        // Mandatory base revision validation for all content saves
        if (
            baseRevision === undefined ||
            baseRevision === null ||
            typeof baseRevision !== "number" ||
            !Number.isInteger(baseRevision) ||
            baseRevision < 0
        ) {
            throw new Error("Cannot save document: missing or invalid base revision for content save.");
        }

        const newOutboundLinks = extractLinks(contentField);
        let hasPendingCleanup = false;
        let docSpaceId = "";

        await db.runTransaction(async (transaction) => {
            // Phase 1: READ ALL
            const docSnap = await transaction.get(docRef);
            if (!docSnap.exists) throw new Error("Doc not found");

            const currentDoc = docSnap.data()!;

            // Check lifecycle claims and soft-deletion
            if (currentDoc.deleted === true || currentDoc.deletedAt != null) {
                throw new Error("Cannot save a deleted document.");
            }
            if (currentDoc.permanentDeletionClaim || currentDoc.lifecycleClaim) {
                throw new Error("Cannot save document: document is currently locked for a lifecycle operation.");
            }

            // Authorize contributor
            docSpaceId = currentDoc.spaceId;
            const spaceRef = db.collection("spaces").doc(docSpaceId);
            const spaceSnap = await transaction.get(spaceRef);
            if (!spaceSnap.exists) throw new Error("Space not found");
            const spaceData = spaceSnap.data();
            if (!spaceData || spaceData.deletedAt != null || spaceData.purgeState != null) {
                throw new Error("Cannot save document in a deleted or purging space.");
            }
            const isOwner = spaceData.ownerId === uid;
            const isMember = Array.isArray(spaceData.userIds) && spaceData.userIds.includes(uid);
            if (!isOwner && !isMember) {
                throw new Error("Permission denied: not a space contributor.");
            }

            // Verify all ancestors named by trusted path are active and unclaimed
            await verifyAncestorsActive(transaction, db, currentDoc.path, currentDoc.parentId, docSpaceId);

            const currentRevision = typeof currentDoc.revision === "number" ? currentDoc.revision : 0;

            // Rule 0: Mandatory Stale-save protection (Optimistic Concurrency Control via Revision)
            if (baseRevision !== currentRevision) {
                throw new Error(
                    "Cannot save document: document has been modified by another edit. Please reload before saving."
                );
            }

            const oldOutboundLinks = currentDoc.outboundLinks || [];
            const added = newOutboundLinks.filter((l: string) => !oldOutboundLinks.includes(l));
            const removed = oldOutboundLinks.filter((l: string) => !newOutboundLinks.includes(l));

            // Pre-fetch all target documents for backlinks in Phase 1 (excluding self)
            const allTargetIds = [...new Set([...added, ...removed])].filter((targetId) => targetId !== id);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const targetSnaps: Record<string, any> = {};

            for (const targetId of allTargetIds) {
                const targetRef = db.collection("documents").doc(targetId);
                targetSnaps[targetId] = await transaction.get(targetRef);
            }

            // Read previous content in Phase 1
            const contentSnap = await transaction.get(contentRef);
            const previousContent = contentSnap.exists ? contentSnap.data()?.content : null;
            const oldImageUrls = extractImageUrls(previousContent);
            const newImageUrls = extractImageUrls(contentField);

            const newImageKeysSet = new Set(newImageUrls.map(normalizeImageKey));

            // Rule 1A: Check if new content attempts to reference an image claimed for S3 deletion.
            const activeClaim = currentDoc.imageCleanupClaim;
            if (activeClaim && Array.isArray(activeClaim.keys) && activeClaim.keys.length > 0) {
                const claimedKeysSet = new Set(activeClaim.keys.map(normalizeImageKey));
                for (const newKey of Array.from(newImageKeysSet)) {
                    if (claimedKeysSet.has(newKey)) {
                        throw new Error(
                            "Cannot save document: image is currently being deleted by a prior edit. Please re-upload the image."
                        );
                    }
                }
            }

            // Rule 1B: Check if new content attempts to reference an image that was already retired
            const retiredKeys = currentDoc.retiredImageKeys;
            if (Array.isArray(retiredKeys) && retiredKeys.length > 0) {
                const retiredKeysSet = new Set(retiredKeys.map(normalizeImageKey));
                for (const newKey of Array.from(newImageKeysSet)) {
                    if (retiredKeysSet.has(newKey)) {
                        throw new Error(
                            "Cannot save document: image has been deleted by a prior edit. Please re-upload the image."
                        );
                    }
                }
            }

            const newlyRemoved = oldImageUrls.filter((u: string) => !newImageKeysSet.has(normalizeImageKey(u)));

            const pendingSet = new Set<string>(
                Array.isArray(currentDoc.pendingImageCleanup) ? currentDoc.pendingImageCleanup : []
            );
            for (const url of newlyRemoved) {
                pendingSet.add(url);
            }

            // Rule 2: If new content contains/re-adds any previously pending image (not in active claim), rescue it
            for (const key of Array.from(pendingSet)) {
                if (newImageKeysSet.has(normalizeImageKey(key))) {
                    pendingSet.delete(key);
                }
            }

            hasPendingCleanup = pendingSet.size > 0;

            // Phase 2: WRITE ALL
            const nextRevision = currentRevision + 1;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const docUpdatePayload: Record<string, any> = {
                updatedAt: FieldValue.serverTimestamp(),
                revision: nextRevision,
                outboundLinks: newOutboundLinks,
            };
            if (data.title !== undefined) {
                docUpdatePayload.title = data.title;
            }
            if (data.tags !== undefined) {
                docUpdatePayload.tags = data.tags;
            }
            if (hasPendingCleanup) {
                docUpdatePayload.pendingImageCleanup = Array.from(pendingSet);
            } else if (currentDoc.pendingImageCleanup !== undefined) {
                docUpdatePayload.pendingImageCleanup = FieldValue.delete();
            }

            transaction.update(docRef, docUpdatePayload);

            // Write to subcollection
            transaction.set(contentRef, { content: contentField });

            // Update added backlinks
            for (const targetId of added) {
                if (targetId === id) continue;
                const targetSnap = targetSnaps[targetId];
                if (canAffectTargetBacklink(targetSnap, docSpaceId)) {
                    const targetRef = db.collection("documents").doc(targetId);
                    const targetData = typeof targetSnap.data === "function" ? targetSnap.data() : targetSnap.data;
                    const backlinks = Array.isArray(targetData.backlinks) ? targetData.backlinks : [];
                    if (!backlinks.includes(id)) {
                        transaction.update(targetRef, {
                            backlinks: [...backlinks, id],
                        });
                    }
                }
            }

            // Update removed backlinks
            for (const targetId of removed) {
                if (targetId === id) continue;
                const targetSnap = targetSnaps[targetId];
                if (canAffectTargetBacklink(targetSnap, docSpaceId)) {
                    const targetRef = db.collection("documents").doc(targetId);
                    const targetData = typeof targetSnap.data === "function" ? targetSnap.data() : targetSnap.data;
                    const backlinks = Array.isArray(targetData.backlinks) ? targetData.backlinks : [];
                    if (backlinks.includes(id)) {
                        const newBacklinks = backlinks.filter((bid: string) => bid !== id);
                        transaction.update(targetRef, {
                            backlinks: newBacklinks,
                        });
                    }
                }
            }
        });

        if (hasPendingCleanup && docSpaceId) {
            try {
                const cleanupResult = await cleanupRemovedDocumentImages(idToken, docSpaceId, id);
                if (cleanupResult && cleanupResult.remainingPendingCount > 0) {
                    return { contentSaved: true, cleanupPending: true };
                }
                return { contentSaved: true, cleanupPending: false };
            } catch (cleanupErr) {
                console.warn(
                    "Storage cleanup for removed images failed post-save; pendingImageCleanup retained for retry:",
                    cleanupErr
                );
                return {
                    contentSaved: true,
                    cleanupPending: true,
                    cleanupError: cleanupErr instanceof Error ? cleanupErr.message : "Cleanup failed",
                };
            }
        }

        return { contentSaved: true, cleanupPending: false };
    } else {
        // Metadata only update
        await db.runTransaction(async (transaction) => {
            const docSnap = await transaction.get(docRef);
            if (!docSnap.exists) throw new Error("Doc not found");
            const currentDoc = docSnap.data()!;

            if (currentDoc.deleted === true || currentDoc.deletedAt != null) {
                throw new Error("Cannot update a deleted document.");
            }
            if (currentDoc.permanentDeletionClaim || currentDoc.lifecycleClaim) {
                throw new Error("Cannot update document: document is currently locked for a lifecycle operation.");
            }

            const docSpaceId = currentDoc.spaceId;
            const spaceRef = db.collection("spaces").doc(docSpaceId);
            const spaceSnap = await transaction.get(spaceRef);
            if (!spaceSnap.exists) throw new Error("Space not found");
            const spaceData = spaceSnap.data();
            if (!spaceData || spaceData.deletedAt != null || spaceData.purgeState != null) {
                throw new Error("Cannot update document in a deleted or purging space.");
            }
            const isOwner = spaceData.ownerId === uid;
            const isMember = Array.isArray(spaceData.userIds) && spaceData.userIds.includes(uid);
            if (!isOwner && !isMember) {
                throw new Error("Permission denied: not a space contributor.");
            }

            // Verify all ancestors named by trusted path are active and unclaimed
            await verifyAncestorsActive(transaction, db, currentDoc.path, currentDoc.parentId, docSpaceId);

            const currentRevision = typeof currentDoc.revision === "number" ? currentDoc.revision : 0;
            let shouldBumpRevision = false;
            if (baseRevision !== undefined && baseRevision !== null) {
                if (
                    typeof baseRevision !== "number" ||
                    !Number.isInteger(baseRevision) ||
                    baseRevision < 0 ||
                    baseRevision !== currentRevision
                ) {
                    throw new Error(
                        "Cannot save document: document has been modified by another edit. Please reload before saving."
                    );
                }
                shouldBumpRevision = true;
            } else if (baseUpdatedAt !== undefined && baseUpdatedAt !== null) {
                const currentMillis =
                    getTimestampMillis(currentDoc.updatedAt) ?? getTimestampMillis(currentDoc.createdAt);
                const baseMillis = getTimestampMillis(baseUpdatedAt);
                if (currentMillis !== null && baseMillis !== null && currentMillis !== baseMillis) {
                    throw new Error(
                        "Cannot save document: document has been modified by another edit. Please reload before saving."
                    );
                }
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const docUpdatePayload: Record<string, any> = {
                updatedAt: FieldValue.serverTimestamp(),
            };
            if (data.title !== undefined) {
                docUpdatePayload.title = data.title;
            }
            if (data.tags !== undefined) {
                docUpdatePayload.tags = data.tags;
            }
            if (shouldBumpRevision) {
                docUpdatePayload.revision = currentRevision + 1;
            }

            transaction.update(docRef, docUpdatePayload);
        });

        return { contentSaved: true, cleanupPending: false };
    }
}
