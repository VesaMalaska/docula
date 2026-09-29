"use server";

import { FieldValue, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import {
    verifyIdToken,
    authorizeSpaceContributor,
    getDocumentContentUrls,
} from "../server/document-authorization";
import { getAdminFirestore } from "../server/firebase-admin";
import { permanentDeleteImages } from "./s3";

export async function permanentlyDeleteDocumentAction(
    idToken: string | undefined,
    spaceId: string,
    docId: string
): Promise<{ success: boolean }> {
    if (!spaceId || typeof spaceId !== "string" || !docId || typeof docId !== "string") {
        throw new Error("Invalid request identifiers");
    }

    // 1. Verify token
    const { uid } = await verifyIdToken(idToken);

    // 2. Verify Space and caller initial check
    try {
        await authorizeSpaceContributor(uid, spaceId);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "";
        if (msg === "Space is deleted") {
            throw new Error("Cannot permanently delete document from a soft-deleted space. Use space purge.");
        }
        throw err;
    }

    const db = getAdminFirestore();

    // 3. Transactionally claim the still-soft-deleted document
    await db.runTransaction(async (transaction) => {
        // Re-read Space
        const spaceRef = db.collection("spaces").doc(spaceId);
        const spaceSnap = await transaction.get(spaceRef);
        if (!spaceSnap.exists) {
            throw new Error("Space not found");
        }
        const spaceData = spaceSnap.data();
        if (!spaceData) {
            throw new Error("Space data is missing");
        }
        if (spaceData.deletedAt != null) {
            throw new Error("Cannot permanently delete document from a soft-deleted space. Use space purge.");
        }
        const isOwner = spaceData.ownerId === uid;
        const isMember = Array.isArray(spaceData.userIds) && spaceData.userIds.includes(uid);
        if (!isOwner && !isMember) {
            throw new Error("Permission denied: not a space contributor");
        }

        // Re-read Document
        const docRef = db.collection("documents").doc(docId);
        const docSnap = await transaction.get(docRef);
        if (!docSnap.exists) {
            throw new Error("Document not found");
        }
        const docData = docSnap.data();
        if (!docData) {
            throw new Error("Document data is missing");
        }
        if (docData.spaceId !== spaceId) {
            throw new Error("Document does not belong to the specified space");
        }

        // Verify document remains soft-deleted
        const isSoftDeleted = docData.deleted === true && docData.deletedAt != null;
        if (!isSoftDeleted) {
            throw new Error("Cannot permanently delete an active document. Soft-delete it first.");
        }

        // Verify document is not claimed by an incompatible operation
        const existingClaim = docData.permanentDeletionClaim;
        if (existingClaim && existingClaim.claimedBy && existingClaim.claimedBy !== uid) {
            if (!isOwner) {
                throw new Error("Document is already being permanently deleted by another operation");
            }
        }

        // Establish / update the claim
        transaction.update(docRef, {
            permanentDeletionClaim: {
                claimedAt: FieldValue.serverTimestamp(),
                claimedBy: uid,
            },
        });
    });

    // 4. Query descendants across all lifecycle states
    let descendantsSnap;
    try {
        descendantsSnap = await db
            .collection("documents")
            .where("path", "array-contains", docId)
            .limit(1)
            .get();
    } catch {
        // Fail closed: unexpected descendant-query failure fails closed and does not clear the claim
        throw new Error("Failed to check document descendants");
    }

    // 5. If descendants exist, clear the claim and reject safely
    if (!descendantsSnap.empty) {
        await db.runTransaction(async (transaction) => {
            const docRef = db.collection("documents").doc(docId);
            const docSnap = await transaction.get(docRef);
            if (docSnap.exists) {
                const data = docSnap.data();
                if (data?.permanentDeletionClaim?.claimedBy === uid) {
                    transaction.update(docRef, {
                        permanentDeletionClaim: null,
                    });
                }
            }
        });

        throw new Error("This document still contains subdocuments. Permanently delete the subdocuments first.");
    }

    // 6. Resolve trusted image keys from Firestore content
    const imageUrls = await getDocumentContentUrls(docId);

    // 7. Perform S3 cleanup (leaves claim in place on failure)
    await permanentDeleteImages(idToken, spaceId, docId, imageUrls || []);

    // 8. Discover matching targets in bounded pages using reverse backlink query
    const PAGE_SIZE = 100;
    const MAX_BATCH_SIZE = 450;
    const pendingTargets: string[] = [];
    let lastDoc: QueryDocumentSnapshot | undefined = undefined;

    while (true) {
        let pageQuery = db
            .collection("documents")
            .where("backlinks", "array-contains", docId);

        if (typeof pageQuery.orderBy !== "function" || typeof pageQuery.limit !== "function") {
            throw new Error("Firestore query pagination is unavailable");
        }

        pageQuery = pageQuery.orderBy("__name__").limit(PAGE_SIZE);

        if (lastDoc) {
            if (typeof pageQuery.startAfter !== "function") {
                throw new Error("Firestore query pagination cursor is unavailable");
            }
            pageQuery = pageQuery.startAfter(lastDoc);
        }

        const pageSnap = await pageQuery.get();
        if (pageSnap.empty) {
            break;
        }

        for (const snap of pageSnap.docs) {
            if (snap.id === docId) {
                continue;
            }
            const data = typeof snap.data === "function"
                ? (snap.data() as Record<string, unknown> | undefined)
                : (snap as unknown as { data?: Record<string, unknown> }).data;

            // Never mutate a cross-Space document (Requirement 2)
            if (!data || data.spaceId !== spaceId) {
                continue;
            }

            const backlinks = Array.isArray(data.backlinks) ? data.backlinks : [];
            if (backlinks.includes(docId)) {
                pendingTargets.push(snap.id);
            }
        }

        // Commit intermediate batches while keeping at most MAX_BATCH_SIZE targets in pendingTargets
        while (pendingTargets.length > MAX_BATCH_SIZE) {
            const chunk = pendingTargets.splice(0, MAX_BATCH_SIZE);
            const batch = db.batch();
            for (const targetId of chunk) {
                const targetRef = db.collection("documents").doc(targetId);
                batch.update(targetRef, {
                    backlinks: FieldValue.arrayRemove(docId),
                });
            }
            await batch.commit();
        }

        lastDoc = pageSnap.docs[pageSnap.docs.length - 1];
        if (pageSnap.docs.length < PAGE_SIZE) {
            break;
        }
    }

    const contentRef = db.collection("documents").doc(docId).collection("content").doc("main");
    const docRef = db.collection("documents").doc(docId);

    const pendingFinalTargetSet = new Set(pendingTargets);

    // Complete verification pass across all matching documents in bounded pages
    let verifyLastDoc: QueryDocumentSnapshot | undefined = undefined;
    while (true) {
        let verifyQuery = db
            .collection("documents")
            .where("backlinks", "array-contains", docId);

        if (typeof verifyQuery.orderBy !== "function" || typeof verifyQuery.limit !== "function") {
            throw new Error("Firestore query pagination is unavailable");
        }

        verifyQuery = verifyQuery.orderBy("__name__").limit(PAGE_SIZE);

        if (verifyLastDoc) {
            if (typeof verifyQuery.startAfter !== "function") {
                throw new Error("Firestore query pagination cursor is unavailable");
            }
            verifyQuery = verifyQuery.startAfter(verifyLastDoc);
        }

        const verifySnap = await verifyQuery.get();
        if (verifySnap.empty) {
            break;
        }

        for (const snap of verifySnap.docs) {
            if (snap.id === docId) {
                continue;
            }
            const data = typeof snap.data === "function"
                ? (snap.data() as Record<string, unknown> | undefined)
                : (snap as unknown as { data?: Record<string, unknown> }).data;

            if (data && data.spaceId === spaceId && !pendingFinalTargetSet.has(snap.id)) {
                throw new Error("Uncleared same-Space target backlinks remain");
            }
        }

        verifyLastDoc = verifySnap.docs[verifySnap.docs.length - 1];
        if (verifySnap.docs.length < PAGE_SIZE) {
            break;
        }
    }

    // Final batch: atomically removes the last target references and deletes source content and metadata
    const finalBatch = db.batch();
    for (const targetId of pendingTargets) {
        const targetRef = db.collection("documents").doc(targetId);
        finalBatch.update(targetRef, {
            backlinks: FieldValue.arrayRemove(docId),
        });
    }
    finalBatch.delete(contentRef);
    finalBatch.delete(docRef);
    await finalBatch.commit();

    // 9. Return success
    return { success: true };
}
