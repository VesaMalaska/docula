"use server";

import { FieldValue } from "firebase-admin/firestore";
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

export async function updateDocumentAction(
    idToken: string | undefined,
    id: string,
    data: UpdateDocumentData,
    options?: UpdateDocumentOptions
): Promise<UpdateDocumentResult> {
    if (!id || typeof id !== "string") {
        throw new Error("Invalid document ID");
    }

    const { uid } = await verifyIdToken(idToken);

    const db = getAdminFirestore();
    const docRef = db.collection("documents").doc(id);
    const contentRef = docRef.collection("content").doc("main");

    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
    const { id: _, content: contentField, baseRevision: dataBaseRevision, baseUpdatedAt: dataBaseUpdatedAt, ...updateData } = data as any;
    const baseRevision = options?.baseRevision !== undefined ? options.baseRevision : dataBaseRevision;
    const baseUpdatedAt = options?.baseUpdatedAt !== undefined ? options.baseUpdatedAt : dataBaseUpdatedAt;

    updateData.updatedAt = FieldValue.serverTimestamp();

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

            // Pre-fetch all target documents for backlinks in Phase 1
            const allTargetIds = [...new Set([...added, ...removed])];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const targetSnaps: Record<string, any> = {};

            for (const targetId of allTargetIds) {
                if (targetId === id) {
                    targetSnaps[targetId] = docSnap;
                } else {
                    const targetRef = db.collection("documents").doc(targetId);
                    targetSnaps[targetId] = await transaction.get(targetRef);
                }
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
                ...updateData,
                revision: nextRevision,
                outboundLinks: newOutboundLinks,
            };
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
                const targetRef = db.collection("documents").doc(targetId);
                const targetSnap = targetSnaps[targetId];

                if (targetSnap && targetSnap.exists) {
                    const targetData = targetSnap.data();
                    const backlinks = targetData.backlinks || [];
                    if (!backlinks.includes(id)) {
                        transaction.update(targetRef, {
                            backlinks: [...backlinks, id],
                        });
                    }
                }
            }

            // Update removed backlinks
            for (const targetId of removed) {
                const targetRef = db.collection("documents").doc(targetId);
                const targetSnap = targetSnaps[targetId];

                if (targetSnap && targetSnap.exists) {
                    const targetData = targetSnap.data();
                    const backlinks = targetData.backlinks || [];
                    const newBacklinks = backlinks.filter((bid: string) => bid !== id);
                    transaction.update(targetRef, {
                        backlinks: newBacklinks,
                    });
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

            const currentRevision = typeof currentDoc.revision === "number" ? currentDoc.revision : 0;
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
                updateData.revision = currentRevision + 1;
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

            transaction.update(docRef, updateData);
        });

        return { contentSaved: true, cleanupPending: false };
    }
}
