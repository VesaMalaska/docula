"use server";

import { FieldValue } from "firebase-admin/firestore";
import { verifyIdToken, getDocumentContentUrls } from "../server/document-authorization";
import { getAdminFirestore } from "../server/firebase-admin";
import { permanentDeleteImages } from "./s3";

export interface PurgeSpaceStepResult {
    success: boolean;
    done: boolean;
    processedCount: number;
}

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 50;

const SAFE_PURGE_ERROR_MESSAGES = new Set([
    "Invalid space identifier",
    "Missing ID token",
    "Invalid or expired ID token",
    "Space not found",
    "Permission denied: only space owner can permanently delete this space",
    "Cannot permanently delete an active space. Soft-delete it first.",
    "Failed to delete space images during permanent purge. Please try again.",
]);

export async function purgeSpaceStepAction(
    idToken: string | undefined,
    spaceId: string,
    batchSize: number = DEFAULT_BATCH_SIZE
): Promise<PurgeSpaceStepResult> {
    if (!spaceId || typeof spaceId !== "string") {
        throw new Error("Invalid space identifier");
    }

    try {
        // 1. Verify token
        const { uid } = await verifyIdToken(idToken);

        const db = getAdminFirestore();
        const spaceRef = db.collection("spaces").doc(spaceId);

        // 2. Authorize caller & check Space state inside a transaction
        // Also establish persistent purgeState BEFORE deleting any documents
        await db.runTransaction(async (transaction) => {
            const spaceSnap = await transaction.get(spaceRef);
            if (!spaceSnap.exists) {
                throw new Error("Space not found");
            }
            const spaceData = spaceSnap.data();
            if (!spaceData) {
                throw new Error("Space data is missing");
            }
            if (spaceData.ownerId !== uid) {
                throw new Error("Permission denied: only space owner can permanently delete this space");
            }
            if (!spaceData.deletedAt) {
                throw new Error("Cannot permanently delete an active space. Soft-delete it first.");
            }

            // Persistent purge state before deleting its first document
            if (spaceData.purgeState !== "purging") {
                transaction.update(spaceRef, {
                    purgeState: "purging",
                    purgeStartedAt: FieldValue.serverTimestamp(),
                    updatedAt: FieldValue.serverTimestamp(),
                });
            }
        });

        // 3. Process documents in a bounded step
        const safeBatchSize = typeof batchSize === "number" && Number.isFinite(batchSize) ? Math.floor(batchSize) : DEFAULT_BATCH_SIZE;
        const boundedLimit = Math.max(1, Math.min(safeBatchSize, MAX_BATCH_SIZE));
        const docsSnap = await db
            .collection("documents")
            .where("spaceId", "==", spaceId)
            .limit(boundedLimit)
            .get();

        let processedCount = 0;

        for (const docSnap of docsSnap.docs) {
            const docId = docSnap.id;
            const docData = docSnap.data();

            if (docData?.spaceId !== spaceId) {
                continue;
            }

            const docRef = db.collection("documents").doc(docId);
            const checkDoc = await docRef.get();
            if (!checkDoc.exists) {
                // Document was already deleted by a concurrent tab/worker
                continue;
            }

            // a. Extract required image URLs from document content
            const imageUrls = await getDocumentContentUrls(docId);

            // b. Complete required S3 cleanup before deleting content and metadata
            if (imageUrls && imageUrls.length > 0) {
                try {
                    await permanentDeleteImages(idToken, spaceId, docId, imageUrls);
                } catch (err) {
                    // If another worker deleted the document concurrently, skip gracefully
                    try {
                        const recheckDoc = await docRef.get();
                        if (!recheckDoc.exists) {
                            continue;
                        }
                    } catch {
                        // Ignore recheck errors and proceed to handle S3 cleanup failure
                    }
                    console.error(`S3 cleanup failed for document ${docId} during space purge:`, err);
                    // If cleanup fails, retain the Firestore records needed for retry and show a useful generic error.
                    throw new Error("Failed to delete space images during permanent purge. Please try again.");
                }
            }

            // c. Atomically delete content record and document metadata
            // Using a transaction ensures only one worker deletes the document and increments processedCount
            const contentRef = db.collection("documents").doc(docId).collection("content").doc("main");
            const wasDeleted = await db.runTransaction(async (transaction) => {
                const currentDoc = await transaction.get(docRef);
                if (!currentDoc.exists) {
                    return false;
                }
                transaction.delete(contentRef);
                transaction.delete(docRef);
                return true;
            });

            if (wasDeleted) {
                processedCount++;
            }
        }

        // 4. Fresh server-side check to confirm whether documents remain
        const remainingSnap = await db
            .collection("documents")
            .where("spaceId", "==", spaceId)
            .limit(1)
            .get();

        if (!remainingSnap.empty) {
            // Documents still remain to be processed in subsequent steps
            return {
                success: true,
                done: false,
                processedCount,
            };
        }

        // 5. Delete the Space record only after fresh server-side check confirms NO documents remain
        await db.runTransaction(async (transaction) => {
            const finalSnap = await transaction.get(spaceRef);
            if (!finalSnap.exists) {
                return;
            }
            const finalData = finalSnap.data();
            if (!finalData) {
                throw new Error("Space data is missing");
            }
            if (finalData.ownerId !== uid) {
                throw new Error("Permission denied: only space owner can permanently delete this space");
            }
            transaction.delete(spaceRef);
        });

        return {
            success: true,
            done: true,
            processedCount,
        };
    } catch (err: unknown) {
        if (err instanceof Error && SAFE_PURGE_ERROR_MESSAGES.has(err.message)) {
            throw err;
        }
        console.error(`Unexpected error during space purge step for space ${spaceId}:`, err);
        throw new Error("Failed to permanently delete space. Please try again.");
    }
}
