"use server";

import { S3Client, CopyObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { verifyIdToken, authorizeSpaceContributor, authorizeSpaceReader, getAndVerifyDocument, extractCanonicalKey, verifyLegacyKeyOwnership, authorizeDocumentCleanup } from "../server/document-authorization";
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

export async function permanentizeImages(idToken: string | undefined, spaceId: string, docId: string, urls: string[]) {
    if (!urls || urls.length === 0) return {};
    const bucket = getBucket();
    const { uid } = await verifyIdToken(idToken);

    await authorizeSpaceContributor(uid, spaceId);
    await getAndVerifyDocument(spaceId, docId);

    const mapping: Record<string, string> = {};
    const expectedPrefix = `temp/${spaceId}/${docId}/${uid}/`;

    const results = await Promise.allSettled(urls.map(async (url) => {
        const path = extractCanonicalKey(url);
        if (!path) return;

        const oldKey = `temp/${path}`;
        if (!oldKey.startsWith(expectedPrefix)) {
            // Not owned by this caller — skip silently (not a security error)
            return;
        }

        // Derive destination key: uploads/{spaceId}/{docId}/{uuid}.ext
        const filename = oldKey.substring(expectedPrefix.length);
        const newKey = `uploads/${spaceId}/${docId}/${filename}`;

        const copySource = `/${bucket}/${encodeURIComponent(oldKey).replace(/%2F/g, "/")}`;

        // Copy first; if this fails the source is still intact — safely retryable
        await s3Client.send(new CopyObjectCommand({
            Bucket: bucket,
            CopySource: copySource,
            Key: newKey,
        }));

        // Delete source after successful copy.
        // NOTE: If this delete fails, both keys temporarily exist. A subsequent retry
        // will re-copy (idempotent on S3) and re-attempt the delete.
        await s3Client.send(new DeleteObjectCommand({
            Bucket: bucket,
            Key: oldKey,
        }));

        const newUrl = url.replace(oldKey, newKey);
        mapping[url] = newUrl;
    }));

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

    const results = await Promise.allSettled(urls.map(async (url) => {
        const path = extractCanonicalKey(url);
        if (!path) return;

        // This function is ONLY for cleaning up session temp images
        const key = `temp/${path}`;
        if (!key.startsWith(expectedPrefix)) {
            return; // Not owned by this caller — silently skip
        }

        await s3Client.send(new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
        }));
    }));

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
    const keysToSoftDelete: string[] = [];
    for (const url of urls) {
        const rawKey = extractCanonicalKey(url);
        if (!rawKey) {
            throw new Error("Invalid key format");
        }
        const key = `uploads/${rawKey}`;
        const ownsKey = await verifyLegacyKeyOwnership(docId, key);
        if (!ownsKey) {
            throw new Error("Permission denied: key does not belong to this document");
        }
        keysToSoftDelete.push(key);
    }

    const results = await Promise.allSettled(keysToSoftDelete.map(async (key) => {
        const newKey = `deleted/${key}`;
        const copySource = `/${bucket}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;

        // Copy first — source remains intact on failure
        await s3Client.send(new CopyObjectCommand({
            Bucket: bucket,
            CopySource: copySource,
            Key: newKey,
        }));

        // Delete source after successful copy.
        // NOTE: If delete fails, both uploads/ and deleted/ keys exist.
        // A retry will re-copy (idempotent) and re-attempt the delete.
        await s3Client.send(new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
        }));
    }));

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
        console.error(`softDeleteImages: ${failures.length} of ${urls.length} operations failed`);
        throw new Error("One or more images could not be soft-deleted. Please try again.");
    }
}

export async function permanentDeleteImages(idToken: string | undefined, spaceId: string, docId: string, urls: string[]) {
    if (!urls || urls.length === 0) return;
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

    // Pre-authorize every requested key. All authorization must finish before the first AWS operation.
    const keysToDelete: { activeKey: string; deletedKey: string }[] = [];
    for (const url of urls) {
        const rawKey = extractCanonicalKey(url);
        if (!rawKey) {
            throw new Error("Invalid key format");
        }
        const activeKey = `uploads/${rawKey}`;
        const ownsKey = await verifyLegacyKeyOwnership(docId, activeKey);
        if (!ownsKey) {
            throw new Error("Permission denied: key does not belong to this document");
        }
        keysToDelete.push({
            activeKey,
            deletedKey: `deleted/${activeKey}`,
        });
    }

    const results = await Promise.allSettled(keysToDelete.flatMap(({ activeKey, deletedKey }) => [
        s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: activeKey })),
        s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: deletedKey })),
    ]));

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
        console.error(`permanentDeleteImages: ${failures.length} of ${urls.length} operations failed`);
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
    const keysToRestore: string[] = [];
    for (const url of urls) {
        const rawKey = extractCanonicalKey(url);
        if (!rawKey) {
            throw new Error("Invalid key format");
        }
        const activeKey = `uploads/${rawKey}`;
        const ownsKey = await verifyLegacyKeyOwnership(docId, activeKey);
        if (!ownsKey) {
            throw new Error("Permission denied: key does not belong to this document");
        }
        keysToRestore.push(activeKey);
    }

    const results = await Promise.allSettled(keysToRestore.map(async (activeKey) => {
        const deletedKey = `deleted/${activeKey}`;
        const copySource = `/${bucket}/${encodeURIComponent(deletedKey).replace(/%2F/g, "/")}`;

        // Copy from deleted/ back to uploads/ first
        await s3Client.send(new CopyObjectCommand({
            Bucket: bucket,
            CopySource: copySource,
            Key: activeKey,
        }));

        // Delete the deleted/ variant after successful copy.
        // NOTE: If delete fails, both keys exist. Retrying will re-copy and re-attempt delete.
        await s3Client.send(new DeleteObjectCommand({
            Bucket: bucket,
            Key: deletedKey,
        }));
    }));

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
        console.error(`restoreImages: ${failures.length} of ${urls.length} operations failed`);
        throw new Error("One or more images could not be restored. Please try again.");
    }
}
