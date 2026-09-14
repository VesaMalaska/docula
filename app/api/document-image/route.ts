import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { verifyIdToken, authorizeSpaceReader, getAndVerifyDocument, verifyLegacyKeyOwnership, extractCanonicalKey } from "@/lib/server/document-authorization";

export const runtime = "nodejs";

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

// Allowed MIME types for responses
const ALLOWED_MIME_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp"
]);

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MiB

export async function GET(request: NextRequest) {
    try {
        const authHeader = request.headers.get("Authorization");
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return new NextResponse("Missing or invalid Authorization header", { status: 401 });
        }
        const idToken = authHeader.substring(7).trim();
        if (!idToken || idToken === "undefined" || idToken === "null") {
            return new NextResponse("Missing or invalid ID token", { status: 401 });
        }

        const spaceId = request.nextUrl.searchParams.get("spaceId");
        const docId = request.nextUrl.searchParams.get("docId");
        const rawKey = request.nextUrl.searchParams.get("key");

        if (!spaceId || !docId || !rawKey) {
            return new NextResponse("Missing required parameters", { status: 400 });
        }

        // Authentication
        let uid: string;
        try {
            const authUser = await verifyIdToken(idToken);
            uid = authUser.uid;
        } catch {
            return new NextResponse("Unauthorized: Invalid ID token", { status: 401 });
        }

        // Authorization
        try {
            await authorizeSpaceReader(uid, spaceId);
            await getAndVerifyDocument(spaceId, docId);
        } catch {
            return new NextResponse("Forbidden: Access denied to space or document", { status: 403 });
        }

        // Parse key
        const path = extractCanonicalKey(rawKey);
        if (!path) {
            return new NextResponse("Invalid key format", { status: 400 });
        }

        // Validate key path segments against space and document
        const segments = path.split("/");
        if (segments.length === 3) {
            if (segments[0] !== spaceId || segments[1] !== docId) {
                return new NextResponse("Key does not match space and document", { status: 400 });
            }
        } else if (segments.length !== 1) {
            return new NextResponse("Invalid key path structure", { status: 400 });
        }

        // We only serve active images (uploads/) through this route
        const activeKey = `uploads/${path}`;
        const ownsKey = await verifyLegacyKeyOwnership(docId, activeKey);
        if (!ownsKey) {
            return new NextResponse("Forbidden: Key not owned by document", { status: 403 });
        }

        const bucket = getBucket();
        const command = new GetObjectCommand({
            Bucket: bucket,
            Key: activeKey,
        });

        let s3Response;
        try {
            s3Response = await s3Client.send(command);
        } catch (s3Error: unknown) {
            const isNotFound = Boolean(
                s3Error &&
                typeof s3Error === "object" &&
                (("name" in s3Error && (s3Error.name === "NoSuchKey" || s3Error.name === "NotFound")) ||
                 ("$metadata" in s3Error && (s3Error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404))
            );
            if (isNotFound) {
                return new NextResponse("Image not found", { status: 404 });
            }
            console.error(
                "document-image S3 GetObject failed:",
                s3Error instanceof Error ? s3Error.message : "S3 error"
            );
            return new NextResponse("Internal Server Error", { status: 500 });
        }

        if (!s3Response.Body) {
            return new NextResponse("Image body empty", { status: 404 });
        }

        const contentType = s3Response.ContentType || "application/octet-stream";
        if (!ALLOWED_MIME_TYPES.has(contentType)) {
            return new NextResponse("Unsupported media type", { status: 415 });
        }

        // Early-exit on known ContentLength to avoid buffering
        if (s3Response.ContentLength && s3Response.ContentLength > MAX_BODY_BYTES) {
            return new NextResponse("Image too large", { status: 413 });
        }

        // Bounded consumption of Node.js Readable / async-iterable stream or Web ReadableStream
        const body = s3Response.Body;
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        let sizeExceeded = false;

        try {
            if (Symbol.asyncIterator in (body as object)) {
                const asyncIterable = body as AsyncIterable<Uint8Array | Buffer>;
                for await (const rawChunk of asyncIterable) {
                    const chunk = rawChunk instanceof Uint8Array ? rawChunk : Buffer.from(rawChunk);
                    totalBytes += chunk.byteLength;
                    if (totalBytes > MAX_BODY_BYTES) {
                        sizeExceeded = true;
                        if (typeof (body as { destroy?: () => void }).destroy === "function") {
                            (body as { destroy: () => void }).destroy();
                        } else if (typeof (body as { cancel?: () => Promise<unknown> }).cancel === "function") {
                            (body as { cancel: () => Promise<unknown> }).cancel().catch(() => {});
                        }
                        break;
                    }
                    chunks.push(chunk);
                }
            } else if (typeof (body as { getReader?: () => unknown }).getReader === "function") {
                const reader = (body as ReadableStream<Uint8Array>).getReader();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value) {
                        const chunk = value instanceof Uint8Array ? value : Buffer.from(value);
                        totalBytes += chunk.byteLength;
                        if (totalBytes > MAX_BODY_BYTES) {
                            sizeExceeded = true;
                            reader.cancel().catch(() => {});
                            break;
                        }
                        chunks.push(chunk);
                    }
                }
            } else {
                console.error("document-image unsupported body stream format");
                return new NextResponse("Internal Server Error", { status: 500 });
            }
        } catch (streamError) {
            if (sizeExceeded) {
                return new NextResponse("Image too large", { status: 413 });
            }
            console.error(
                "document-image stream consumption error:",
                streamError instanceof Error ? streamError.message : "Stream error"
            );
            return new NextResponse("Internal Server Error", { status: 500 });
        }

        if (sizeExceeded) {
            return new NextResponse("Image too large", { status: 413 });
        }

        const combined = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
        }

        return new NextResponse(combined, {
            headers: {
                "Content-Type": contentType,
                "Cache-Control": "private, max-age=3600",
            },
        });

    } catch (error) {
        console.error(
            "document-image unexpected error:",
            error instanceof Error ? error.message : "Unexpected error"
        );
        return new NextResponse("Internal Server Error", { status: 500 });
    }
}
