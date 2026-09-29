"use server";

import { S3Client, CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminFirestore } from "../server/firebase-admin";
import {
    verifyIdToken,
    authorizeSpaceContributor,
    authorizeSpaceReader,
    getAndVerifyDocument,
    extractCanonicalKey,
    verifyLegacyKeyOwnership,
    authorizeDocumentCleanup,
    isModernDocumentScopedKey,
} from "../server/document-authorization";
import { extractImageUrls } from "../utils";
import crypto from "crypto";

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

const getBucket = () => {
    const bucket = process.env.AWS_BUCKET_NAME;
    if (!bucket) throw new Error("AWS_BUCKET_NAME is not configured");
    return bucket;
};

// Map of allowed MIME types to their extensions
const ALLOWED_MIME_TYPES: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
};

const MAX_RETIRED_IMAGE_KEYS = 200;

export async function getPresignedGetUrl(idToken: string | undefined, spaceId: string, docId: string, key: string) {
    const bucket = getBucket();
    const { uid } = await verifyIdToken(idToken);

    // Authorization: Must be an active space reader
    await authorizeSpaceReader(uid, spaceId);

    // Verification: Must be the correct document, and the key must belong to this document
    await getAndVerifyDocument(spaceId, docId);

    const normalizedKey = key.startsWith('/') ? key.substring(1) : key;

    // If it's a temporary key belonging to THIS caller, they can view it before saving.
    // If it's a legacy or uploaded key, it must exist in the document content.
    const isTemp = normalizedKey.startsWith("temp/");
    if (isTemp) {
        // temp/{spaceId}/{docId}/{uid}/{uuid}.ext
        const expectedPrefix = `temp/${spaceId}/${docId}/${uid}/`;
        if (!normalizedKey.startsWith(expectedPrefix)) {
            throw new Error("Permission denied: unowned temporary key");
        }
    } else {
        const ownsKey = await verifyLegacyKeyOwnership(docId, normalizedKey);
        if (!ownsKey) {
            throw new Error("Permission denied: key does not belong to this document");
        }
    }

    const command = new GetObjectCommand({
        Bucket: bucket,
        Key: normalizedKey,
    });

    try {
        const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 }); // 1 hour
        return url;
    } catch {
        console.error("AWS SDK error generating presigned GET URL");
        throw new Error("Failed to generate access URL");
    }
}

export async function getPresignedUrl(idToken: string | undefined, spaceId: string, docId: string, fileType: string, sourceFileType?: string) {
    const bucket = getBucket();
    const { uid } = await verifyIdToken(idToken);

    // Authorization: Must be an active space contributor
    await authorizeSpaceContributor(uid, spaceId);
    await getAndVerifyDocument(spaceId, docId);

    const ext = ALLOWED_MIME_TYPES[fileType];
    if (!ext) {
        throw new Error("Unsupported file type");
    }

    if (sourceFileType && !ALLOWED_MIME_TYPES[sourceFileType]) {
        throw new Error("Unsupported source file type");
    }

    const randomUuid = crypto.randomUUID();
    const key = `temp/${spaceId}/${docId}/${uid}/${randomUuid}.${ext}`;

    try {
        const { url, fields } = await createPresignedPost(s3Client, {
            Bucket: bucket,
            Key: key,
            Conditions: [
                ["content-length-range", 1, 5242880], // 1 byte to 5MB
                ["eq", "$Content-Type", fileType],
            ],
            Fields: {
                "Content-Type": fileType,
            },
            Expires: 300, // 5 minutes
        });

        return { url, fields, key };
    } catch {
        console.error("AWS SDK error generating presigned POST");
        throw new Error("Failed to generate upload URL");
    }
}

const S3_CONCURRENCY_LIMIT = 10;

function isS3NotFound(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as {
        name?: string;
        Code?: string;
        code?: string;
        $metadata?: { httpStatusCode?: number };
        statusCode?: number;
    };
    return (
        e.name === "NoSuchKey" ||
        e.name === "NotFound" ||
        e.Code === "NoSuchKey" ||
        e.Code === "NotFound" ||
        e.code === "NoSuchKey" ||
        e.code === "NotFound" ||
        e.$metadata?.httpStatusCode === 404 ||
        e.statusCode === 404
    );
}

async function checkObjectExists(bucket: string, key: string): Promise<boolean> {
    try {
        await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
    } catch (err: unknown) {
        if (isS3NotFound(err)) {
            return false;
        }
        throw err;
    }
}

async function executeRetryableMove(
    bucket: string,
    srcKey: string,
    destKey: string
): Promise<void> {
    const copySource = `/${bucket}/${encodeURIComponent(srcKey).replace(/%2F/g, "/")}`;
    let copySucceeded = false;

    try {
        await s3Client.send(new CopyObjectCommand({
            Bucket: bucket,
            CopySource: copySource,
            Key: destKey,
        }));
        copySucceeded = true;
    } catch (err: unknown) {
        if (isS3NotFound(err)) {
            // Source is missing. Check if destination already exists (prior successful copy/delete on earlier attempt).
            const destExists = await checkObjectExists(bucket, destKey);
            if (destExists) {
                // Destination exists: ensure source is deleted (idempotent cleanup in case of ghost)
                try {
                    await s3Client.send(new DeleteObjectCommand({
                        Bucket: bucket,
                        Key: srcKey,
                    }));
                } catch {
                    // Safe to ignore if source delete fails when it already does not exist
                }
                return;
            }
            // Neither source nor destination exists!
            throw new Error(`Image missing from storage: neither source (${srcKey}) nor destination (${destKey}) exists`);
        }
        // Unexpected S3 error (e.g. 500, network failure, 403)
        throw err;
    }

    if (copySucceeded) {
        // Delete source after successful copy.
        // If this delete fails, both keys exist (State C). Retrying will re-copy and re-attempt delete.
        await s3Client.send(new DeleteObjectCommand({
            Bucket: bucket,
            Key: srcKey,
        }));
    }
}

async function runWithBoundedConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = [];
    for (let i = 0; i < items.length; i += limit) {
        const chunk = items.slice(i, i + limit);
        const chunkResults = await Promise.allSettled(chunk.map((item) => fn(item)));
        results.push(...chunkResults);
    }
    return results;
}

async function validateAndAuthorizeDocumentKeys(
    spaceId: string,
    docId: string,
    urls: string[]
): Promise<{ activeKey: string; deletedKey: string }[]> {
    const keys: { activeKey: string; deletedKey: string }[] = [];
    for (const url of urls) {
        const rawKey = extractCanonicalKey(url);
        if (!rawKey) {
            throw new Error("Invalid key format");
        }
        const segments = rawKey.split("/");
        if (segments.length === 3) {
            if (segments[0] !== spaceId) {
                throw new Error("Permission denied: key belongs to another space");
            }
            if (segments[1] !== docId) {
                throw new Error("Permission denied: key belongs to another document");
            }
        } else if (segments.length !== 1) {
            throw new Error("Invalid key format");
        }
        const activeKey = `uploads/${rawKey}`;
        const ownsKey = await verifyLegacyKeyOwnership(docId, activeKey);
        if (!ownsKey) {
            throw new Error("Permission denied: key does not belong to this document");
        }
        keys.push({
            activeKey,
            deletedKey: `deleted/${activeKey}`,
        });
    }
    return keys;
}

export async function permanentizeImages(idToken: string | undefined, spaceId: string, docId: string, urls: string[]) {
    if (!urls || urls.length === 0) return {};
    const bucket = getBucket();
    const { uid } = await verifyIdToken(idToken);

    await authorizeSpaceContributor(uid, spaceId);
    const docData = await getAndVerifyDocument(spaceId, docId);

    // Concurrency / Lifecycle protection:
    // Once a document is soft-deleted or claimed by a lifecycle operation,
    // prevent late-arriving temp uploads from being promoted into uploads/.
    if (
        docData.deleted === true ||
        docData.deletedAt != null ||
        docData.permanentDeletionClaim != null ||
        docData.lifecycleClaim != null
    ) {
        throw new Error("Cannot save images to a deleted or locked document");
    }

    const mapping: Record<string, string> = {};
    const expectedPrefix = `temp/${spaceId}/${docId}/${uid}/`;

    const tasks: { originalUrl: string; oldKey: string; newKey: string; newUrl: string }[] = [];

    for (const url of urls) {
        const path = extractCanonicalKey(url);
        if (!path) continue;

        const oldKey = `temp/${path}`;
        if (!oldKey.startsWith(expectedPrefix)) {
            // Not owned by this caller — skip silently (not a security error)
            continue;
        }

        // Derive destination key: uploads/{spaceId}/{docId}/{uuid}.ext
        const filename = oldKey.substring(expectedPrefix.length);
        const newKey = `uploads/${spaceId}/${docId}/${filename}`;
        const newUrl = url.replace(oldKey, newKey);
        tasks.push({ originalUrl: url, oldKey, newKey, newUrl });
    }

    if (tasks.length === 0) return {};

    const results = await runWithBoundedConcurrency(tasks, S3_CONCURRENCY_LIMIT, async (task) => {
        await executeRetryableMove(bucket, task.oldKey, task.newKey);
        mapping[task.originalUrl] = task.newUrl;
    });

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
        console.error(`permanentizeImages: ${failures.length} of ${urls.length} operations failed`);
        throw new Error("One or more images could not be saved. Please try again.");
    }

    return mapping;
}

export async function deleteImages(idToken: string | undefined, spaceId: string, docId: string, urls: string[]) {
    if (!urls || urls.length === 0) return;
    const bucket = getBucket();
    const { uid } = await verifyIdToken(idToken);

    await authorizeSpaceContributor(uid, spaceId);
    await getAndVerifyDocument(spaceId, docId);

    const expectedPrefix = `temp/${spaceId}/${docId}/${uid}/`;
    const keysToDelete: string[] = [];

    for (const url of urls) {
        const path = extractCanonicalKey(url);
        if (!path) continue;

        // This function is ONLY for cleaning up session temp images
        const key = `temp/${path}`;
        if (!key.startsWith(expectedPrefix)) {
            continue; // Not owned by this caller — silently skip
        }
        keysToDelete.push(key);
    }

    if (keysToDelete.length === 0) return;

    const results = await runWithBoundedConcurrency(keysToDelete, S3_CONCURRENCY_LIMIT, async (key) => {
        await s3Client.send(new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
        }));
    });

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
        console.error(`deleteImages: ${failures.length} of ${urls.length} operations failed`);
        throw new Error("One or more temporary images could not be deleted.");
    }
}

export async function softDeleteImages(idToken: string | undefined, spaceId: string, docId: string, urls: string[]) {
    if (!urls || urls.length === 0) return;
    const bucket = getBucket();
    const { uid } = await verifyIdToken(idToken);

    await authorizeSpaceContributor(uid, spaceId);
    await getAndVerifyDocument(spaceId, docId);

    // Pre-authorize every requested key. All authorization must finish before the first AWS operation.
    const keys = await validateAndAuthorizeDocumentKeys(spaceId, docId, urls);

    const results = await runWithBoundedConcurrency(keys, S3_CONCURRENCY_LIMIT, async ({ activeKey, deletedKey }) => {
        await executeRetryableMove(bucket, activeKey, deletedKey);
    });

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
        console.error(`softDeleteImages: ${failures.length} of ${urls.length} operations failed`);
        throw new Error("One or more images could not be soft-deleted. Please try again.");
    }
}

const MAX_DOC_SCOPED_IMAGE_LIMIT = 500;

interface DiscoveredScopedKeys {
    keys: string[];
    hasMore: boolean;
}

async function listDocumentScopedKeys(
    bucket: string,
    spaceId: string,
    docId: string,
    limit: number = MAX_DOC_SCOPED_IMAGE_LIMIT
): Promise<DiscoveredScopedKeys> {
    const prefixes = [
        `uploads/${spaceId}/${docId}/`,
        `deleted/uploads/${spaceId}/${docId}/`,
    ];
    const discoveredKeys: string[] = [];
    let hasMore = false;

    for (const prefix of prefixes) {
        if (discoveredKeys.length >= limit) {
            hasMore = true;
            break;
        }

        let continuationToken: string | undefined = undefined;
        do {
            const remaining = limit - discoveredKeys.length;
            if (remaining <= 0) {
                hasMore = true;
                break;
            }

            // Request remaining + 1 to detect whether more objects exist beyond the limit
            const command: ListObjectsV2Command = new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken,
                MaxKeys: Math.min(1000, remaining + 1),
            });

            const resp = await s3Client.send(command);
            const contents = resp.Contents || [];

            for (const item of contents) {
                if (item.Key) {
                    if (discoveredKeys.length < limit) {
                        discoveredKeys.push(item.Key);
                    } else {
                        hasMore = true;
                        break;
                    }
                }
            }

            if (hasMore) {
                break;
            }

            if (resp.IsTruncated) {
                if (discoveredKeys.length >= limit) {
                    hasMore = true;
                    break;
                }
                continuationToken = resp.NextContinuationToken;
            } else {
                continuationToken = undefined;
            }
        } while (continuationToken);

        if (hasMore) {
            break;
        }
    }

    return { keys: discoveredKeys, hasMore };
}

export async function permanentDeleteImages(
    idToken: string | undefined,
    spaceId: string,
    docId: string,
    urls: string[] = []
) {
    const bucket = getBucket();
    const { uid } = await verifyIdToken(idToken);

    // Determine whether this is an active-space operation or a deleted-space owner cleanup.
    // Both paths MUST verify the document exists and belongs to the specified space.
    try {
        await authorizeSpaceContributor(uid, spaceId);
    } catch {
        // Space may be soft-deleted — only owner may perform cleanup
        await authorizeDocumentCleanup(uid, spaceId);
    }

    // Always verify the document regardless of path.
    // This prevents a deleted-space owner from using a document from another space
    // as authorization evidence for key deletion.
    await getAndVerifyDocument(spaceId, docId);

    // 1. Authorize explicitly requested keys (from content/main), including legacy keys.
    // Legacy keys (with 1 segment) are strictly validated via verifyLegacyKeyOwnership.
    const explicitKeys: string[] = [];
    if (urls && urls.length > 0) {
        const validated = await validateAndAuthorizeDocumentKeys(spaceId, docId, urls);
        explicitKeys.push(...validated.flatMap(({ activeKey, deletedKey }) => [activeKey, deletedKey]));
    }

    // 2. Discover modern document-scoped objects under uploads/{spaceId}/{docId}/ and deleted/uploads/{spaceId}/{docId}/.
    // This cleans up modern images removed from TipTap content prior to permanent deletion, bounded to
    // MAX_DOC_SCOPED_IMAGE_LIMIT per step to ensure resumability without hitting execution timeouts.
    let discoveredScopedKeys: string[] = [];
    let hasMoreScopedKeys = false;
    try {
        const listResult = await listDocumentScopedKeys(bucket, spaceId, docId);
        discoveredScopedKeys = listResult.keys;
        hasMoreScopedKeys = listResult.hasMore;
    } catch (err) {
        console.error(`permanentDeleteImages: failed to list scoped keys for space ${spaceId} doc ${docId}:`, err);
        throw new Error("One or more images could not be permanently deleted. Please try again.");
    }

    // 3. Union explicit keys and discovered scoped keys into a deduplicated set.
    const allDeleteOps = Array.from(new Set([...explicitKeys, ...discoveredScopedKeys]));

    if (allDeleteOps.length === 0 && !hasMoreScopedKeys) return;

    if (allDeleteOps.length > 0) {
        const results = await runWithBoundedConcurrency(allDeleteOps, S3_CONCURRENCY_LIMIT, async (key) => {
            await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        });

        const failures = results.filter((r) => r.status === "rejected");
        if (failures.length > 0) {
            console.error(`permanentDeleteImages: ${failures.length} of ${allDeleteOps.length} operations failed`);
            throw new Error("One or more images could not be permanently deleted. Please try again.");
        }
    }

    // If more scoped keys remain beyond the per-step ceiling, throw so the caller retains
    // Firestore records and claim, allowing retry to make forward progress.
    if (hasMoreScopedKeys) {
        console.warn(`permanentDeleteImages: deleted batch of ${allDeleteOps.length} keys, but more keys remain for space ${spaceId} doc ${docId}; retry to continue cleanup`);
        throw new Error("One or more images could not be permanently deleted. Please try again.");
    }
}

export async function restoreImages(idToken: string | undefined, spaceId: string, docId: string, urls: string[]) {
    if (!urls || urls.length === 0) return;
    const bucket = getBucket();
    const { uid } = await verifyIdToken(idToken);

    await authorizeSpaceContributor(uid, spaceId);
    await getAndVerifyDocument(spaceId, docId);

    // Pre-authorize every requested key. All authorization must finish before the first AWS operation.
    const keys = await validateAndAuthorizeDocumentKeys(spaceId, docId, urls);

    const results = await runWithBoundedConcurrency(keys, S3_CONCURRENCY_LIMIT, async ({ activeKey, deletedKey }) => {
        await executeRetryableMove(bucket, deletedKey, activeKey);
    });

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
        console.error(`restoreImages: ${failures.length} of ${urls.length} operations failed`);
        throw new Error("One or more images could not be restored. Please try again.");
    }
}

export async function cleanupRemovedDocumentImages(
    idToken: string | undefined,
    spaceId: string,
    docId: string
): Promise<{ success: boolean; cleanedCount: number; remainingPendingCount: number }> {
    if (!spaceId || typeof spaceId !== "string" || !docId || typeof docId !== "string") {
        throw new Error("Invalid request identifiers");
    }

    const bucket = getBucket();
    const { uid } = await verifyIdToken(idToken);

    await authorizeSpaceContributor(uid, spaceId);
    const docData = await getAndVerifyDocument(spaceId, docId);

    // If document is soft-deleted, claimed, or locked by a lifecycle operation, do not perform edit cleanup
    if (
        docData.deleted === true ||
        docData.deletedAt != null ||
        docData.permanentDeletionClaim != null ||
        docData.lifecycleClaim != null
    ) {
        throw new Error("Cannot cleanup images on a deleted or locked document");
    }

    const db = getAdminFirestore();
    const docRef = db.collection("documents").doc(docId);
    const contentRef = docRef.collection("content").doc("main");

    let totalCleanedCount = 0;
    let finalRemainingPendingCount = 0;
    const MAX_ROUNDS = 2;

    for (let round = 0; round < MAX_ROUNDS; round++) {
        const claimId = crypto.randomUUID();
        let keysToClean: string[] = [];
        let activeClaimDetected = false;
        let initialPendingCount = 0;

        // Phase 1: Atomic Claim Transaction
        // Atomically check content and claim candidate modern scoped keys to delete.
        await db.runTransaction(async (transaction) => {
            const currentDocSnap = await transaction.get(docRef);
            if (!currentDocSnap.exists) {
                throw new Error("Document not found");
            }
            const currentData = currentDocSnap.data() || {};

            if (
                currentData.deleted === true ||
                currentData.deletedAt != null ||
                currentData.permanentDeletionClaim != null ||
                currentData.lifecycleClaim != null
            ) {
                throw new Error("Cannot cleanup images on a deleted or locked document");
            }

            const pendingList: string[] = Array.isArray(currentData.pendingImageCleanup)
                ? currentData.pendingImageCleanup
                : [];
            initialPendingCount = pendingList.length;
            if (pendingList.length === 0) {
                return;
            }

            // Check active cleanup claim TTL (30 seconds)
            const existingClaim = currentData.imageCleanupClaim;
            if (existingClaim && existingClaim.claimedAt) {
                const claimTime = typeof existingClaim.claimedAt.toDate === "function"
                    ? existingClaim.claimedAt.toDate().getTime()
                    : (existingClaim.claimedAt instanceof Date ? existingClaim.claimedAt.getTime() : 0);
                if (Date.now() - claimTime < 30_000 && existingClaim.claimId !== claimId) {
                    // Another cleanup is actively in flight
                    activeClaimDetected = true;
                    return;
                }
            }

            // Read current authoritative content in same transaction
            const contentSnap = await transaction.get(contentRef);
            const content = contentSnap.exists ? contentSnap.data()?.content : null;
            const currentUrls = content ? extractImageUrls(content) : [];
            const currentCanonicalKeys = new Set(
                currentUrls.map((u) => extractCanonicalKey(u)).filter((k): k is string => Boolean(k))
            );

            const candidateKeys: string[] = [];
            const nonScopedOrActiveKeysToRemove: string[] = [];

            for (const rawKey of pendingList) {
                const canonical = extractCanonicalKey(rawKey);
                if (!canonical) {
                    nonScopedOrActiveKeysToRemove.push(rawKey);
                    continue;
                }

                // If actively referenced in authoritative content, do NOT delete from S3
                if (currentCanonicalKeys.has(canonical)) {
                    nonScopedOrActiveKeysToRemove.push(rawKey);
                    continue;
                }

                // Must be strictly modern document-scoped key: uploads/${spaceId}/${docId}/${fileName}
                if (!isModernDocumentScopedKey(spaceId, docId, canonical)) {
                    nonScopedOrActiveKeysToRemove.push(rawKey);
                    continue;
                }

                candidateKeys.push(`uploads/${canonical}`);
            }

            if (candidateKeys.length === 0) {
                const remaining = pendingList.filter((k) => !nonScopedOrActiveKeysToRemove.includes(k));
                const updates: Record<string, unknown> = {
                    imageCleanupClaim: FieldValue.delete(),
                };
                if (remaining.length === 0) {
                    updates.pendingImageCleanup = FieldValue.delete();
                } else {
                    updates.pendingImageCleanup = remaining;
                }
                transaction.update(docRef, updates);
                return;
            }

            keysToClean = candidateKeys;
            transaction.update(docRef, {
                imageCleanupClaim: {
                    claimId,
                    keys: candidateKeys,
                    claimedAt: FieldValue.serverTimestamp(),
                },
            });
        });

        if (keysToClean.length === 0) {
            finalRemainingPendingCount = activeClaimDetected ? initialPendingCount : 0;
            break;
        }

        // Phase 2: S3 Deletions (bounded concurrency)
        const results = await runWithBoundedConcurrency(keysToClean, S3_CONCURRENCY_LIMIT, async (key) => {
            await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        });

        const succeededKeys: string[] = [];
        const failedKeys: string[] = [];

        results.forEach((res, index) => {
            const key = keysToClean[index];
            if (res.status === "fulfilled") {
                succeededKeys.push(key);
            } else {
                failedKeys.push(key);
            }
        });

        totalCleanedCount += succeededKeys.length;

        let wasFencedOut = false;

        // Phase 3: Atomic Finalize Transaction
        // Re-read current pendingImageCleanup, remove ONLY succeededKeys, preserving any newer work.
        await db.runTransaction(async (transaction) => {
            const currentDocSnap = await transaction.get(docRef);
            if (!currentDocSnap.exists) return;
            const currentData = currentDocSnap.data() || {};

            // Fencing check: verify this worker still owns the claim.
            // If the claim was taken over by a newer recovery worker or cleared,
            // this worker is stale and MUST NOT clear or overwrite the newer worker's claim or pending keys.
            const currentClaim = currentData.imageCleanupClaim;
            if (!currentClaim || currentClaim.claimId !== claimId) {
                console.warn(
                    `cleanupRemovedDocumentImages: worker with claimId ${claimId} was fenced out (current claim: ${currentClaim?.claimId})`
                );
                wasFencedOut = true;
                return;
            }

            const currentPending: string[] = Array.isArray(currentData.pendingImageCleanup)
                ? currentData.pendingImageCleanup
                : [];

            const succeededCanonicalSet = new Set(
                succeededKeys.map((k) => extractCanonicalKey(k)).filter((k): k is string => Boolean(k))
            );

            const updatedPending = currentPending.filter((k) => {
                const canonical = extractCanonicalKey(k);
                return !canonical || !succeededCanonicalSet.has(canonical);
            });

            finalRemainingPendingCount = updatedPending.length;

            // Bounded, durable retired keys: append newly deleted canonical keys
            const currentRetired: string[] = Array.isArray(currentData.retiredImageKeys)
                ? currentData.retiredImageKeys
                : [];
            const retiredSet = new Set(currentRetired);
            for (const key of Array.from(succeededCanonicalSet)) {
                retiredSet.add(key);
            }
            const updatedRetired = Array.from(retiredSet).slice(-MAX_RETIRED_IMAGE_KEYS);

            const updates: Record<string, unknown> = {
                imageCleanupClaim: FieldValue.delete(),
                retiredImageKeys: updatedRetired,
            };

            if (updatedPending.length === 0) {
                updates.pendingImageCleanup = FieldValue.delete();
            } else {
                updates.pendingImageCleanup = updatedPending;
            }

            transaction.update(docRef, updates);
        });

        if (wasFencedOut) {
            break;
        }

        if (failedKeys.length > 0) {
            console.error(
                `cleanupRemovedDocumentImages: ${failedKeys.length} of ${keysToClean.length} deletions failed for space ${spaceId} doc ${docId}`
            );
            throw new Error("One or more removed images could not be deleted from storage. Please try again.");
        }

        if (finalRemainingPendingCount === 0) {
            break;
        }
    }

    return { success: true, cleanedCount: totalCleanedCount, remainingPendingCount: finalRemainingPendingCount };
}
