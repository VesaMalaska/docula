import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Register custom resolver hook for Next.js path aliases and extensionless TS imports
const rootUrl = pathToFileURL(process.cwd() + "/").href;
const hookCode = `
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith("@/")) {
        const target = new URL(specifier.slice(2), "${rootUrl}").href;
        try {
            return await nextResolve(target, context);
        } catch {
            return await nextResolve(target + ".ts", context);
        }
    }
    try {
        return await nextResolve(specifier, context);
    } catch (err) {
        if (specifier.startsWith(".") || specifier.startsWith("${rootUrl}")) {
            try {
                return await nextResolve(specifier + ".ts", context);
            } catch {}
        }
        throw err;
    }
}
`;
register("data:text/javascript," + encodeURIComponent(hookCode));

import test, { mock } from "node:test";
import assert from "node:assert";
import { Readable } from "node:stream";

process.env.AWS_BUCKET_NAME = "test-bucket";
process.env.AWS_REGION = "us-east-1";

const s3SendMock = mock.fn();
mock.module("@aws-sdk/client-s3", {
    exports: {
        S3Client: class { send = s3SendMock; },
        GetObjectCommand: class {
            Bucket: string;
            Key: string;
            constructor(opts: { Bucket: string; Key: string }) {
                this.Bucket = opts.Bucket;
                this.Key = opts.Key;
            }
        },
    },
});

const verifyIdTokenMock = mock.fn();
const authorizeSpaceReaderMock = mock.fn();
const getAndVerifyDocumentMock = mock.fn();
const verifyLegacyKeyOwnershipMock = mock.fn();
const extractCanonicalKeyMock = mock.fn();

mock.module("@/lib/server/document-authorization", {
    exports: {
        verifyIdToken: verifyIdTokenMock,
        authorizeSpaceReader: authorizeSpaceReaderMock,
        getAndVerifyDocument: getAndVerifyDocumentMock,
        verifyLegacyKeyOwnership: verifyLegacyKeyOwnershipMock,
        extractCanonicalKey: extractCanonicalKeyMock,
    },
});

const { NextRequest } = await import("next/server");
const { GET } = await import("../../app/api/document-image/route");

function createMockStream(chunks: (Uint8Array | Buffer)[]): Readable {
    return Readable.from(chunks);
}

function resetMocks() {
    s3SendMock.mock.resetCalls();
    verifyIdTokenMock.mock.resetCalls();
    authorizeSpaceReaderMock.mock.resetCalls();
    getAndVerifyDocumentMock.mock.resetCalls();
    verifyLegacyKeyOwnershipMock.mock.resetCalls();
    extractCanonicalKeyMock.mock.resetCalls();

    verifyIdTokenMock.mock.mockImplementation(async (token: string) => {
        if (token === "valid-token") return { uid: "user-123" };
        throw new Error("Invalid or expired ID token");
    });
    authorizeSpaceReaderMock.mock.mockImplementation(async () => ({}));
    getAndVerifyDocumentMock.mock.mockImplementation(async () => ({}));
    verifyLegacyKeyOwnershipMock.mock.mockImplementation(async () => true);
    extractCanonicalKeyMock.mock.mockImplementation((k: string) => {
        const stripped = k.startsWith("/") ? k.substring(1) : k;
        return stripped.replace(/^(uploads|temp|deleted)\//, "");
    });
}

test.describe("/api/document-image route", () => {
    test.beforeEach(() => {
        resetMocks();
    });

    test("missing Authorization header returns 401 without calling AWS", async () => {
        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=uploads/s1/d1/img.png");
        const res = await GET(req);
        assert.strictEqual(res.status, 401);
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("undefined or empty Bearer token returns 401 without calling AWS", async () => {
        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=uploads/s1/d1/img.png", {
            headers: { Authorization: "Bearer undefined" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 401);
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("invalid or forged token is rejected (401) without calling AWS", async () => {
        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=uploads/s1/d1/img.png", {
            headers: { Authorization: "Bearer forged-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 401);
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("private-space non-member is rejected without calling AWS", async () => {
        authorizeSpaceReaderMock.mock.mockImplementation(async () => {
            throw new Error("Permission denied: not a space reader");
        });
        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=uploads/s1/d1/img.png", {
            headers: { Authorization: "Bearer valid-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 403);
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("removed member is rejected without calling AWS", async () => {
        authorizeSpaceReaderMock.mock.mockImplementation(async () => {
            throw new Error("Permission denied: not a space reader");
        });
        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=uploads/s1/d1/img.png", {
            headers: { Authorization: "Bearer valid-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 403);
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("public authenticated reader can read an owned document image", async () => {
        const sampleImageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
        s3SendMock.mock.mockImplementation(async () => ({
            Body: createMockStream([sampleImageBytes]),
            ContentType: "image/png",
            ContentLength: sampleImageBytes.length,
        }));

        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=pub-s1&docId=d1&key=uploads/pub-s1/d1/img.png", {
            headers: { Authorization: "Bearer valid-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get("Content-Type"), "image/png");
        assert.strictEqual(s3SendMock.mock.callCount(), 1);
    });

    test("foreign document/key is rejected without calling AWS", async () => {
        verifyLegacyKeyOwnershipMock.mock.mockImplementation(async () => false);
        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=uploads/s1/d1/foreign.png", {
            headers: { Authorization: "Bearer valid-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 403);
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("arbitrary external URL or hostname is rejected without calling AWS", async () => {
        extractCanonicalKeyMock.mock.mockImplementation(() => null);
        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=https://evil.com/img.png", {
            headers: { Authorization: "Bearer valid-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 400);
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("invalid MIME type is rejected (415)", async () => {
        s3SendMock.mock.mockImplementation(async () => ({
            Body: createMockStream([new Uint8Array([1, 2, 3])]),
            ContentType: "application/pdf",
        }));
        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=uploads/s1/d1/file.pdf", {
            headers: { Authorization: "Bearer valid-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 415);
    });

    test("streams body and returns 200 when ContentLength is missing", async () => {
        const chunk1 = new Uint8Array([1, 2, 3, 4]);
        const chunk2 = new Uint8Array([5, 6, 7, 8]);
        s3SendMock.mock.mockImplementation(async () => ({
            Body: createMockStream([chunk1, chunk2]),
            ContentType: "image/jpeg",
            // ContentLength omitted intentionally
        }));
        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=uploads/s1/d1/img.jpg", {
            headers: { Authorization: "Bearer valid-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get("Content-Type"), "image/jpeg");
        const body = await res.arrayBuffer();
        assert.strictEqual(body.byteLength, 8);
    });

    test("returns 413 and stops/destroys stream when actual body exceeds 5 MiB (without ContentLength)", async () => {
        const largeChunk = Buffer.alloc(3 * 1024 * 1024); // 3 MiB
        let wasDestroyed = false;
        const stream = Readable.from([largeChunk, largeChunk]);
        const origDestroy = stream.destroy.bind(stream);
        stream.destroy = function (this: Readable, ...args: unknown[]) {
            wasDestroyed = true;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (origDestroy as any).apply(this, args);
        };

        s3SendMock.mock.mockImplementation(async () => ({
            Body: stream,
            ContentType: "image/png",
            // ContentLength omitted intentionally
        }));
        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=uploads/s1/d1/large.png", {
            headers: { Authorization: "Bearer valid-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 413);
        assert.strictEqual(wasDestroyed || stream.destroyed, true, "Stream must be destroyed when limit is exceeded");
    });

    test("returns 413 early when declared ContentLength exceeds 5 MiB without consuming body", async () => {
        let readCalled = false;
        const stream = new Readable({
            read() {
                readCalled = true;
                this.push(Buffer.from("data"));
            },
        });

        s3SendMock.mock.mockImplementation(async () => ({
            Body: stream,
            ContentType: "image/png",
            ContentLength: 6 * 1024 * 1024, // 6 MiB
        }));
        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=uploads/s1/d1/large.png", {
            headers: { Authorization: "Bearer valid-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 413);
        assert.strictEqual(readCalled, false, "Stream body must not be consumed when ContentLength exceeds limit");
    });

    test("supports leading-slash key format (/uploads/s1/d1/img.png) and sets Cache-Control", async () => {
        const sampleBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        s3SendMock.mock.mockImplementation(async () => ({
            Body: createMockStream([sampleBytes]),
            ContentType: "image/png",
            ContentLength: sampleBytes.length,
        }));

        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=%2Fuploads%2Fs1%2Fd1%2Fimg.png", {
            headers: { Authorization: "Bearer valid-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get("Cache-Control"), "private, max-age=3600");
        assert.strictEqual(s3SendMock.mock.callCount(), 1);
    });

    test("rejects cross-space key with status 400", async () => {
        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=uploads/foreign-space/d1/img.png", {
            headers: { Authorization: "Bearer valid-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 400);
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("rejects cross-document key with status 400", async () => {
        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=uploads/s1/foreign-doc/img.png", {
            headers: { Authorization: "Bearer valid-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 400);
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("rejects invalid key path structure (2 segments) with status 400", async () => {
        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=uploads/s1/img.png", {
            headers: { Authorization: "Bearer valid-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 400);
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("accepts valid legacy 1-segment key", async () => {
        const sampleBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        s3SendMock.mock.mockImplementation(async () => ({
            Body: createMockStream([sampleBytes]),
            ContentType: "image/png",
            ContentLength: sampleBytes.length,
        }));

        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=uploads/legacy-file.png", {
            headers: { Authorization: "Bearer valid-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(s3SendMock.mock.callCount(), 1);
    });

    test("combines multiple Uint8Array and Buffer chunks correctly", async () => {
        const chunk1 = new Uint8Array([0x89, 0x50]);
        const chunk2 = Buffer.from([0x4e, 0x47]);
        const stream = Readable.from([chunk1, chunk2]);

        s3SendMock.mock.mockImplementation(async () => ({
            Body: stream,
            ContentType: "image/png",
        }));

        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=uploads/s1/d1/img.png", {
            headers: { Authorization: "Bearer valid-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 200);
        const bytes = new Uint8Array(await res.arrayBuffer());
        assert.deepStrictEqual(Array.from(bytes), [0x89, 0x50, 0x4e, 0x47]);
    });

    test("stream consumption failure returns 500, never 403", async () => {
        const stream = new Readable({
            read() {
                this.destroy(new Error("Stream connection reset"));
            },
        });

        s3SendMock.mock.mockImplementation(async () => ({
            Body: stream,
            ContentType: "image/png",
        }));

        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=uploads/s1/d1/img.png", {
            headers: { Authorization: "Bearer valid-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 500);
    });

    test("unexpected S3 GetObject failure returns 500, never 403", async () => {
        s3SendMock.mock.mockImplementation(async () => {
            throw new Error("AWS ServiceUnavailable");
        });

        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=uploads/s1/d1/img.png", {
            headers: { Authorization: "Bearer valid-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 500);
    });

    test("S3 NoSuchKey returns 404", async () => {
        const err = new Error("The specified key does not exist.");
        err.name = "NoSuchKey";
        s3SendMock.mock.mockImplementation(async () => {
            throw err;
        });

        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=uploads/s1/d1/img.png", {
            headers: { Authorization: "Bearer valid-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 404);
    });

    test("supports Web ReadableStream body as well", async () => {
        const sampleBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        const webStream = new ReadableStream({
            start(controller) {
                controller.enqueue(sampleBytes);
                controller.close();
            },
        });

        s3SendMock.mock.mockImplementation(async () => ({
            Body: webStream,
            ContentType: "image/png",
            ContentLength: sampleBytes.length,
        }));

        const req = new NextRequest("http://localhost:3000/api/document-image?spaceId=s1&docId=d1&key=uploads/s1/d1/img.png", {
            headers: { Authorization: "Bearer valid-token" },
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 200);
    });
});
