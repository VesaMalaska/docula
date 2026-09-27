import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Custom resolver hook to support extensionless TS imports in Node ESM
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

// ── Environment ────────────────────────────────────────────────────────────────
process.env.AWS_BUCKET_NAME = "test-bucket";
process.env.AWS_REGION = "us-east-1";

// ── S3 SDK mocks ───────────────────────────────────────────────────────────────
const s3SendMock = mock.fn();

mock.module("@aws-sdk/client-s3", {
    exports: {
        S3Client: class { send = s3SendMock; },
        CopyObjectCommand: class {
            params: Record<string, unknown>;
            constructor(params: Record<string, unknown>) { this.params = params; }
        },
        DeleteObjectCommand: class {
            params: Record<string, unknown>;
            constructor(params: Record<string, unknown>) { this.params = params; }
        },
        GetObjectCommand: class {
            params: Record<string, unknown>;
            constructor(params: Record<string, unknown>) { this.params = params; }
        },
        HeadObjectCommand: class {
            params: Record<string, unknown>;
            constructor(params: Record<string, unknown>) { this.params = params; }
        },
        ListObjectsV2Command: class {
            params: Record<string, unknown>;
            constructor(params: Record<string, unknown>) { this.params = params; }
        },
    },
});

const createPresignedPostMock = mock.fn();
mock.module("@aws-sdk/s3-presigned-post", {
    exports: { createPresignedPost: createPresignedPostMock },
});

const getSignedUrlMock = mock.fn();
mock.module("@aws-sdk/s3-request-presigner", {
    exports: { getSignedUrl: getSignedUrlMock },
});

// Mock server-only so importing real document-authorization works in test environment
mock.module("server-only", {
    exports: {},
});

// ── document-authorization mocks ───────────────────────────────────────────────
const verifyIdTokenMock = mock.fn();
const authorizeSpaceContributorMock = mock.fn();
const authorizeSpaceReaderMock = mock.fn();
const getAndVerifyDocumentMock = mock.fn();
const extractCanonicalKeyMock = mock.fn();
const verifyLegacyKeyOwnershipMock = mock.fn();
const authorizeDocumentCleanupMock = mock.fn();
const getDocumentContentUrlsMock = mock.fn();
const isModernDocumentScopedKeyMock = mock.fn();

mock.module("../server/document-authorization", {
    exports: {
        verifyIdToken: verifyIdTokenMock,
        authorizeSpaceContributor: authorizeSpaceContributorMock,
        authorizeSpaceReader: authorizeSpaceReaderMock,
        getAndVerifyDocument: getAndVerifyDocumentMock,
        extractCanonicalKey: extractCanonicalKeyMock,
        verifyLegacyKeyOwnership: verifyLegacyKeyOwnershipMock,
        authorizeDocumentCleanup: authorizeDocumentCleanupMock,
        getDocumentContentUrls: getDocumentContentUrlsMock,
        isModernDocumentScopedKey: isModernDocumentScopedKeyMock,
    },
});

// Import actions under test after mocks are registered
const {
    getPresignedUrl,
    getPresignedGetUrl,
    permanentizeImages,
    deleteImages,
    softDeleteImages,
    restoreImages,
    permanentDeleteImages,
} = await import("../actions/s3");

// Also import the real document-authorization functions to test validation rules directly
// Note: We bypass the mock for direct unit testing of extractCanonicalKey
const realDocAuth = await import("../server/document-authorization.ts?bypass-mock=1");
const { extractCanonicalKey: realExtractCanonicalKey } = realDocAuth;

// ── Helpers ────────────────────────────────────────────────────────────────────
function resetAllMocks() {
    s3SendMock.mock.resetCalls();
    createPresignedPostMock.mock.resetCalls();
    getSignedUrlMock.mock.resetCalls();
    verifyIdTokenMock.mock.resetCalls();
    authorizeSpaceContributorMock.mock.resetCalls();
    authorizeSpaceReaderMock.mock.resetCalls();
    getAndVerifyDocumentMock.mock.resetCalls();
    extractCanonicalKeyMock.mock.resetCalls();
    verifyLegacyKeyOwnershipMock.mock.resetCalls();
    authorizeDocumentCleanupMock.mock.resetCalls();
}

function setDefaultSuccessMocks(uid = "user1") {
    verifyIdTokenMock.mock.mockImplementation(async (token: string) => {
        if (token === "valid") return { uid };
        throw new Error("Invalid token");
    });
    authorizeSpaceContributorMock.mock.mockImplementation(async () => ({}));
    authorizeSpaceReaderMock.mock.mockImplementation(async () => ({}));
    getAndVerifyDocumentMock.mock.mockImplementation(async () => ({}));
    extractCanonicalKeyMock.mock.mockImplementation((k: string) =>
        k.replace(/^(temp|uploads|deleted)\//, "")
    );
    verifyLegacyKeyOwnershipMock.mock.mockImplementation(async () => true);
    authorizeDocumentCleanupMock.mock.mockImplementation(async () => ({}));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Canonical Key and URL Validation (Hardening)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Canonical Key and URL Validation", () => {
    test("rejects another customer's S3 bucket with identical pathname", () => {
        const url = "https://another-customer-bucket.s3.us-east-1.amazonaws.com/uploads/s1/d1/img.png";
        assert.strictEqual(realExtractCanonicalKey(url), null);
    });

    test("rejects arbitrary external hostname", () => {
        const url = "https://evil.attacker.com/uploads/s1/d1/img.png";
        assert.strictEqual(realExtractCanonicalKey(url), null);
    });

    test("rejects HTTP instead of HTTPS", () => {
        const url = "http://test-bucket.s3.us-east-1.amazonaws.com/uploads/s1/d1/img.png";
        assert.strictEqual(realExtractCanonicalKey(url), null);
    });

    test("rejects directory traversal '..'", () => {
        assert.strictEqual(realExtractCanonicalKey("uploads/../secret.png"), null);
        assert.strictEqual(realExtractCanonicalKey("uploads/s1/d1/../../other.png"), null);
    });

    test("rejects encoded traversal '%2e%2e'", () => {
        assert.strictEqual(realExtractCanonicalKey("uploads/%2e%2e/secret.png"), null);
        assert.strictEqual(realExtractCanonicalKey("uploads/s1/%2e%2e/other.png"), null);
    });

    test("rejects encoded slash '%2f'", () => {
        assert.strictEqual(realExtractCanonicalKey("uploads/s1%2fd1/img.png"), null);
        assert.strictEqual(realExtractCanonicalKey("temp/s1%2fd1/u1/img.png"), null);
    });

    test("rejects backslashes", () => {
        assert.strictEqual(realExtractCanonicalKey("uploads\\s1\\d1\\img.png"), null);
        assert.strictEqual(realExtractCanonicalKey("uploads/s1\\d1/img.png"), null);
    });

    test("rejects control characters", () => {
        assert.strictEqual(realExtractCanonicalKey("uploads/s1/d1/img\x00.png"), null);
        assert.strictEqual(realExtractCanonicalKey("uploads/s1/d1/img\x1f.png"), null);
        assert.strictEqual(realExtractCanonicalKey("uploads/s1/d1/img\x7f.png"), null);
    });

    test("rejects duplicate prefixes", () => {
        assert.strictEqual(realExtractCanonicalKey("uploads/uploads/s1/d1/img.png"), null);
        assert.strictEqual(realExtractCanonicalKey("temp/temp/s1/d1/u1/img.png"), null);
        assert.strictEqual(realExtractCanonicalKey("deleted/deleted/uploads/img.png"), null);
        assert.strictEqual(realExtractCanonicalKey("uploads/temp/s1/d1/img.png"), null);
    });

    test("accepts valid legacy Docula URLs and keys", () => {
        // Virtual-hosted style
        assert.strictEqual(
            realExtractCanonicalKey("https://test-bucket.s3.us-east-1.amazonaws.com/uploads/diagram.png"),
            "diagram.png"
        );
        assert.strictEqual(
            realExtractCanonicalKey("https://test-bucket.s3.amazonaws.com/uploads/s1/d1/photo.jpg"),
            "s1/d1/photo.jpg"
        );
        // Path-style
        assert.strictEqual(
            realExtractCanonicalKey("https://s3.us-east-1.amazonaws.com/test-bucket/uploads/s1/d1/photo.jpg"),
            "s1/d1/photo.jpg"
        );
        // Raw key
        assert.strictEqual(
            realExtractCanonicalKey("uploads/s1/d1/photo.jpg"),
            "s1/d1/photo.jpg"
        );
        assert.strictEqual(
            realExtractCanonicalKey("/uploads/s1/d1/photo.jpg"),
            "s1/d1/photo.jpg"
        );
        assert.strictEqual(
            realExtractCanonicalKey("s1/d1/photo.jpg"),
            "s1/d1/photo.jpg"
        );
        assert.strictEqual(
            realExtractCanonicalKey("temp/s1/d1/user1/temp-uuid.png"),
            "s1/d1/user1/temp-uuid.png"
        );
    });

    test("accepts S3 presigned URLs with query parameters including encoded slashes in credential", () => {
        const presignedUrl = "https://test-bucket.s3.us-east-1.amazonaws.com/uploads/s1/d1/photo.webp?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260910%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260910T120000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=abcd1234efgh";
        assert.strictEqual(
            realExtractCanonicalKey(presignedUrl),
            "s1/d1/photo.webp"
        );
    });

    test("same basename in different documents produces distinct canonical keys", () => {
        const keyA = realExtractCanonicalKey("uploads/space-a/doc-a/image.png");
        const keyB = realExtractCanonicalKey("uploads/space-b/doc-b/image.png");
        assert.notStrictEqual(keyA, keyB);
        assert.strictEqual(keyA, "space-a/doc-a/image.png");
        assert.strictEqual(keyB, "space-b/doc-b/image.png");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getPresignedUrl
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("getPresignedUrl", () => {
    test.beforeEach(() => { resetAllMocks(); setDefaultSuccessMocks(); });

    test("rejects missing/invalid token — no AWS call", async () => {
        await assert.rejects(
            getPresignedUrl("invalid", "s1", "d1", "image/png"),
            /Invalid token/
        );
        assert.strictEqual(createPresignedPostMock.mock.callCount(), 0);
    });

    test("rejects public non-member mutation — no AWS call", async () => {
        authorizeSpaceContributorMock.mock.mockImplementation(async () => {
            throw new Error("Permission denied: not a space contributor");
        });
        await assert.rejects(
            getPresignedUrl("valid", "s1", "d1", "image/png"),
            /Permission denied/
        );
        assert.strictEqual(createPresignedPostMock.mock.callCount(), 0);
    });

    test("rejects removed member — no AWS call", async () => {
        authorizeSpaceContributorMock.mock.mockImplementation(async () => {
            throw new Error("Permission denied: not a space contributor");
        });
        await assert.rejects(
            getPresignedUrl("valid", "s1", "d1", "image/png"),
            /Permission denied/
        );
        assert.strictEqual(createPresignedPostMock.mock.callCount(), 0);
    });

    test("rejects cross-Space document — no AWS call", async () => {
        getAndVerifyDocumentMock.mock.mockImplementation(async () => {
            throw new Error("Document does not belong to the specified space");
        });
        await assert.rejects(
            getPresignedUrl("valid", "s1", "foreign-doc", "image/png"),
            /Document does not belong to the specified space/
        );
        assert.strictEqual(createPresignedPostMock.mock.callCount(), 0);
    });

    test("rejects unsupported MIME type — no AWS call", async () => {
        await assert.rejects(
            getPresignedUrl("valid", "s1", "d1", "image/svg+xml"),
            /Unsupported file type/
        );
        await assert.rejects(
            getPresignedUrl("valid", "s1", "d1", "image/avif"),
            /Unsupported file type/
        );
        await assert.rejects(
            getPresignedUrl("valid", "s1", "d1", "image/webp", "image/avif"),
            /Unsupported source file type/
        );
        assert.strictEqual(createPresignedPostMock.mock.callCount(), 0);
    });

    test("succeeds and enforces server-generated key and POST policy", async () => {
        createPresignedPostMock.mock.mockImplementation(async () => ({
            url: "https://post.example.com",
            fields: { key: "temp/x" },
        }));
        const res = await getPresignedUrl("valid", "s1", "d1", "image/png");

        assert.strictEqual(res.url, "https://post.example.com");
        assert.strictEqual(createPresignedPostMock.mock.callCount(), 1);

        const args = createPresignedPostMock.mock.calls[0].arguments[1] as {
            Bucket: string;
            Key: string;
            Conditions: [string, ...unknown[]][];
            Expires: number;
        };
        assert.strictEqual(args.Bucket, "test-bucket");
        assert.match(args.Key, /^temp\/s1\/d1\/user1\//);
        assert.ok(args.Key.endsWith(".png"));
        assert.strictEqual(args.Expires, 300);

        const sizeCondition = args.Conditions.find(
            (c: [string, ...unknown[]]) => c[0] === "content-length-range"
        );
        assert.ok(sizeCondition, "size condition must be present");
        assert.strictEqual(sizeCondition[2], 5242880, "max size must be 5 MiB");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getPresignedGetUrl
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("getPresignedGetUrl", () => {
    test.beforeEach(() => { resetAllMocks(); setDefaultSuccessMocks(); });

    test("rejects invalid token — no AWS call", async () => {
        await assert.rejects(
            getPresignedGetUrl("invalid", "s1", "d1", "temp/s1/d1/user1/uuid.png"),
            /Invalid token/
        );
        assert.strictEqual(getSignedUrlMock.mock.callCount(), 0);
    });

    test("authenticated public non-member can read space image", async () => {
        getSignedUrlMock.mock.mockImplementation(async () => "https://signed.example.com/get");
        const key = "temp/s1/d1/user1/uuid.png";
        const res = await getPresignedGetUrl("valid", "s1", "d1", key);
        assert.strictEqual(res, "https://signed.example.com/get");
        assert.strictEqual(getSignedUrlMock.mock.callCount(), 1);
    });

    test("rejects non-member from private space — no AWS call", async () => {
        authorizeSpaceReaderMock.mock.mockImplementation(async () => {
            throw new Error("Permission denied: not a space reader");
        });
        await assert.rejects(
            getPresignedGetUrl("valid", "s1", "d1", "uploads/s1/d1/file.png"),
            /Permission denied/
        );
        assert.strictEqual(getSignedUrlMock.mock.callCount(), 0);
    });

    test("rejects cross-Space document — no AWS call", async () => {
        getAndVerifyDocumentMock.mock.mockImplementation(async () => {
            throw new Error("Document does not belong to the specified space");
        });
        await assert.rejects(
            getPresignedGetUrl("valid", "s1", "foreign-doc", "uploads/s1/d1/file.png"),
            /Document does not belong to the specified space/
        );
        assert.strictEqual(getSignedUrlMock.mock.callCount(), 0);
    });

    test("allows owner temp key in correct space/doc/uid prefix", async () => {
        getSignedUrlMock.mock.mockImplementation(async () => "https://signed.example.com/get");
        const key = "temp/s1/d1/user1/uuid.png";
        const res = await getPresignedGetUrl("valid", "s1", "d1", key);
        assert.strictEqual(res, "https://signed.example.com/get");
    });

    test("rejects foreign temporary key (other user) — no AWS call", async () => {
        const key = "temp/s1/d1/other-user/uuid.png";
        await assert.rejects(
            getPresignedGetUrl("valid", "s1", "d1", key),
            /Permission denied: unowned temporary key/
        );
        assert.strictEqual(getSignedUrlMock.mock.callCount(), 0);
    });

    test("rejects cross-document temp key — no AWS call", async () => {
        const key = "temp/s1/other-doc/user1/uuid.png";
        await assert.rejects(
            getPresignedGetUrl("valid", "s1", "d1", key),
            /Permission denied: unowned temporary key/
        );
        assert.strictEqual(getSignedUrlMock.mock.callCount(), 0);
    });

    test("rejects cross-space temp key — no AWS call", async () => {
        const key = "temp/other-space/d1/user1/uuid.png";
        await assert.rejects(
            getPresignedGetUrl("valid", "s1", "d1", key),
            /Permission denied: unowned temporary key/
        );
        assert.strictEqual(getSignedUrlMock.mock.callCount(), 0);
    });

    test("rejects foreign legacy key not in document content — no AWS call", async () => {
        verifyLegacyKeyOwnershipMock.mock.mockImplementation(async () => false);
        const key = "uploads/s1/d1/foreign.png";
        await assert.rejects(
            getPresignedGetUrl("valid", "s1", "d1", key),
            /Permission denied: key does not belong to this document/
        );
        assert.strictEqual(getSignedUrlMock.mock.callCount(), 0);
    });

    test("accepts key with leading slash (/uploads/s1/d1/file.png) and generates signed URL", async () => {
        getSignedUrlMock.mock.mockImplementation(async () => "https://signed.example.com/get-leading");
        const key = "/uploads/s1/d1/file.png";
        const res = await getPresignedGetUrl("valid", "s1", "d1", key);
        assert.strictEqual(res, "https://signed.example.com/get-leading");
        assert.strictEqual(getSignedUrlMock.mock.callCount(), 1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// permanentizeImages
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("permanentizeImages", () => {
    test.beforeEach(() => { resetAllMocks(); setDefaultSuccessMocks(); });

    test("rejects invalid token — no AWS call", async () => {
        await assert.rejects(
            permanentizeImages("invalid", "s1", "d1", ["temp/s1/d1/user1/x.png"]),
            /Invalid token/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("rejects non-contributor — no AWS call", async () => {
        authorizeSpaceContributorMock.mock.mockImplementation(async () => {
            throw new Error("Permission denied: not a space contributor");
        });
        await assert.rejects(
            permanentizeImages("valid", "s1", "d1", ["temp/s1/d1/user1/x.png"]),
            /Permission denied/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("skips unowned temp key without error — no AWS call", async () => {
        s3SendMock.mock.mockImplementation(async () => ({}));
        const res = await permanentizeImages(
            "valid", "s1", "d1",
            ["temp/s1/d1/other-user/x.png"]
        );
        assert.deepStrictEqual(res, {});
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("succeeds: copy then delete, returns URL mapping", async () => {
        s3SendMock.mock.mockImplementation(async () => ({}));
        const url = "temp/s1/d1/user1/uuid.png";
        const res = await permanentizeImages("valid", "s1", "d1", [url]);

        assert.strictEqual(s3SendMock.mock.callCount(), 2); // CopyObjectCommand + DeleteObjectCommand
        assert.ok(res[url], "must return a URL mapping entry");
        assert.ok(res[url].startsWith("uploads/"), "destination must start with uploads/");
    });

    test("propagates S3 failure — rejects overall call", async () => {
        s3SendMock.mock.mockImplementation(async () => {
            throw new Error("S3 network error");
        });
        await assert.rejects(
            permanentizeImages("valid", "s1", "d1", ["temp/s1/d1/user1/uuid.png"]),
            /images could not be saved/
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// deleteImages
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("deleteImages", () => {
    test.beforeEach(() => { resetAllMocks(); setDefaultSuccessMocks(); });

    test("rejects invalid token — no AWS call", async () => {
        await assert.rejects(
            deleteImages("invalid", "s1", "d1", ["temp/s1/d1/user1/x.png"]),
            /Invalid token/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("silently skips non-temp keys and unowned keys — no AWS call", async () => {
        s3SendMock.mock.mockImplementation(async () => ({}));
        // uploads/ key (not temp), and a temp key for another user
        await deleteImages("valid", "s1", "d1", [
            "uploads/s1/d1/uuid.png",
            "temp/s1/d1/other/uuid.png",
        ]);
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("deletes owned temp keys", async () => {
        s3SendMock.mock.mockImplementation(async () => ({}));
        await deleteImages("valid", "s1", "d1", ["temp/s1/d1/user1/uuid.png"]);
        assert.strictEqual(s3SendMock.mock.callCount(), 1);
    });

    test("propagates S3 failure", async () => {
        s3SendMock.mock.mockImplementation(async () => {
            throw new Error("S3 error");
        });
        await assert.rejects(
            deleteImages("valid", "s1", "d1", ["temp/s1/d1/user1/uuid.png"]),
            /images could not be deleted/
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// softDeleteImages
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("softDeleteImages", () => {
    test.beforeEach(() => { resetAllMocks(); setDefaultSuccessMocks(); });

    test("rejects invalid token — no AWS call", async () => {
        await assert.rejects(
            softDeleteImages("invalid", "s1", "d1", ["uploads/s1/d1/x.png"]),
            /Invalid token/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("rejects non-contributor — no AWS call", async () => {
        authorizeSpaceContributorMock.mock.mockImplementation(async () => {
            throw new Error("Permission denied");
        });
        await assert.rejects(
            softDeleteImages("valid", "s1", "d1", ["uploads/s1/d1/x.png"]),
            /Permission denied/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("rejects cross-Space document — no AWS call", async () => {
        getAndVerifyDocumentMock.mock.mockImplementation(async () => {
            throw new Error("Document does not belong to the specified space");
        });
        await assert.rejects(
            softDeleteImages("valid", "s1", "foreign-doc", ["uploads/s1/d1/x.png"]),
            /Document does not belong to the specified space/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("rejects foreign legacy key — no AWS call", async () => {
        verifyLegacyKeyOwnershipMock.mock.mockImplementation(async () => false);
        await assert.rejects(
            softDeleteImages("valid", "s1", "d1", ["uploads/s1/d1/foreign.png"]),
            /key does not belong to this document/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("rejects foreign space key — no AWS call", async () => {
        await assert.rejects(
            softDeleteImages("valid", "s1", "d1", ["uploads/foreign-space/d1/owned.png"]),
            /key belongs to another space/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("rejects foreign document key — no AWS call", async () => {
        await assert.rejects(
            softDeleteImages("valid", "s1", "d1", ["uploads/s1/foreign-doc/owned.png"]),
            /key belongs to another document/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("copy-then-delete for owned key", async () => {
        s3SendMock.mock.mockImplementation(async () => ({}));
        await softDeleteImages("valid", "s1", "d1", ["uploads/s1/d1/owned.png"]);
        assert.strictEqual(s3SendMock.mock.callCount(), 2); // Copy + Delete
    });

    test("propagates S3 failure", async () => {
        s3SendMock.mock.mockImplementation(async () => {
            throw new Error("S3 error");
        });
        await assert.rejects(
            softDeleteImages("valid", "s1", "d1", ["uploads/s1/d1/x.png"]),
            /images could not be soft-deleted/
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// restoreImages
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("restoreImages", () => {
    test.beforeEach(() => { resetAllMocks(); setDefaultSuccessMocks(); });

    test("rejects invalid token — no AWS call", async () => {
        await assert.rejects(
            restoreImages("invalid", "s1", "d1", ["uploads/s1/d1/x.png"]),
            /Invalid token/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("rejects non-contributor — no AWS call", async () => {
        authorizeSpaceContributorMock.mock.mockImplementation(async () => {
            throw new Error("Permission denied");
        });
        await assert.rejects(
            restoreImages("valid", "s1", "d1", ["uploads/s1/d1/x.png"]),
            /Permission denied/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("rejects foreign key — no AWS call", async () => {
        verifyLegacyKeyOwnershipMock.mock.mockImplementation(async () => false);
        await assert.rejects(
            restoreImages("valid", "s1", "d1", ["uploads/s1/d1/foreign.png"]),
            /key does not belong to this document/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("rejects foreign space key — no AWS call", async () => {
        await assert.rejects(
            restoreImages("valid", "s1", "d1", ["uploads/foreign-space/d1/owned.png"]),
            /key belongs to another space/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("rejects foreign document key — no AWS call", async () => {
        await assert.rejects(
            restoreImages("valid", "s1", "d1", ["uploads/s1/foreign-doc/owned.png"]),
            /key belongs to another document/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("copy-then-delete for owned key", async () => {
        s3SendMock.mock.mockImplementation(async () => ({}));
        await restoreImages("valid", "s1", "d1", ["uploads/s1/d1/owned.png"]);
        assert.strictEqual(s3SendMock.mock.callCount(), 2);
    });

    test("propagates S3 failure", async () => {
        s3SendMock.mock.mockImplementation(async () => {
            throw new Error("S3 error");
        });
        await assert.rejects(
            restoreImages("valid", "s1", "d1", ["uploads/s1/d1/x.png"]),
            /images could not be restored/
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// permanentDeleteImages
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("permanentDeleteImages", () => {
    test.beforeEach(() => { resetAllMocks(); setDefaultSuccessMocks(); });

    test("rejects invalid token — no AWS call", async () => {
        await assert.rejects(
            permanentDeleteImages("invalid", "s1", "d1", ["uploads/s1/d1/x.png"]),
            /Invalid token/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("active space: ordinary member can delete owned key", async () => {
        s3SendMock.mock.mockImplementation(async () => ({}));
        await permanentDeleteImages("valid", "s1", "d1", ["uploads/s1/d1/owned.png"]);
        const deleteCalls = s3SendMock.mock.calls.filter((c: { arguments: unknown[] }) => (c.arguments[0] as { constructor?: { name?: string } })?.constructor?.name === "DeleteObjectCommand");
        assert.strictEqual(deleteCalls.length, 2);
    });

    test("active space: rejects ordinary member of soft-deleted space — no AWS call", async () => {
        authorizeSpaceContributorMock.mock.mockImplementation(async () => {
            throw new Error("Space is deleted");
        });
        authorizeDocumentCleanupMock.mock.mockImplementation(async () => {
            throw new Error("Permission denied: only owner can cleanup deleted space");
        });
        await assert.rejects(
            permanentDeleteImages("valid", "s1", "d1", ["uploads/s1/d1/x.png"]),
            /only owner can cleanup deleted space/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("cleanup mode: owner can delete owned key from soft-deleted space", async () => {
        authorizeSpaceContributorMock.mock.mockImplementation(async () => {
            throw new Error("Space is deleted");
        });
        authorizeDocumentCleanupMock.mock.mockImplementation(async () => ({}));
        s3SendMock.mock.mockImplementation(async () => ({}));

        await permanentDeleteImages("valid", "s1", "d1", ["uploads/s1/d1/owned.png"]);
        const deleteCalls = s3SendMock.mock.calls.filter((c: { arguments: unknown[] }) => (c.arguments[0] as { constructor?: { name?: string } })?.constructor?.name === "DeleteObjectCommand");
        assert.strictEqual(deleteCalls.length, 2);
        assert.strictEqual(getAndVerifyDocumentMock.mock.callCount(), 1);
    });

    test("cleanup mode: owner cannot use document from another space — no AWS call", async () => {
        authorizeSpaceContributorMock.mock.mockImplementation(async () => {
            throw new Error("Space is deleted");
        });
        authorizeDocumentCleanupMock.mock.mockImplementation(async () => ({}));
        getAndVerifyDocumentMock.mock.mockImplementation(async () => {
            throw new Error("Document does not belong to the specified space");
        });

        await assert.rejects(
            permanentDeleteImages("valid", "s1", "d1", ["uploads/s1/d1/x.png"]),
            /Document does not belong to the specified space/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("rejects cross-document / foreign key not in document content — no AWS call", async () => {
        verifyLegacyKeyOwnershipMock.mock.mockImplementation(async () => false);
        await assert.rejects(
            permanentDeleteImages("valid", "s1", "d1", ["uploads/s1/d1/foreign.png"]),
            /key does not belong to this document/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("rejects foreign space key — no AWS call", async () => {
        await assert.rejects(
            permanentDeleteImages("valid", "s1", "d1", ["uploads/foreign-space/d1/owned.png"]),
            /key belongs to another space/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("rejects foreign document key — no AWS call", async () => {
        await assert.rejects(
            permanentDeleteImages("valid", "s1", "d1", ["uploads/s1/foreign-doc/owned.png"]),
            /key belongs to another document/
        );
        assert.strictEqual(s3SendMock.mock.callCount(), 0);
    });

    test("propagates S3 failure", async () => {
        s3SendMock.mock.mockImplementation(async () => {
            throw new Error("S3 error");
        });
        await assert.rejects(
            permanentDeleteImages("valid", "s1", "d1", ["uploads/s1/d1/owned.png"]),
            /images could not be permanently deleted/
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S3 Failure Propagation Blocking Firestore Transitions
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("S3 Failure Propagation and Lifecycle Blocking", () => {
    test.beforeEach(() => { resetAllMocks(); setDefaultSuccessMocks(); });

    test("S3 failure in softDeleteImages blocks following Firestore update", async () => {
        s3SendMock.mock.mockImplementation(async () => {
            throw new Error("S3 Service Unavailable");
        });

        let firestoreUpdated = false;
        async function mockCallerDeleteDocument() {
            // Document action fetches image URLs and calls softDeleteImages before Firestore update
            await softDeleteImages("valid", "s1", "d1", ["uploads/s1/d1/img.png"]);
            firestoreUpdated = true; // Should not be reached
        }

        await assert.rejects(mockCallerDeleteDocument(), /images could not be soft-deleted/);
        assert.strictEqual(firestoreUpdated, false, "Firestore transition must not execute when S3 fails");
    });

    test("S3 failure in permanentDeleteImages blocks following Firestore document deletion", async () => {
        s3SendMock.mock.mockImplementation(async () => {
            throw new Error("S3 Internal Error");
        });

        let firestoreDocumentDeleted = false;
        async function mockCallerPermanentlyDeleteDocument() {
            await permanentDeleteImages("valid", "s1", "d1", ["uploads/s1/d1/img.png"]);
            firestoreDocumentDeleted = true; // Should not be reached
        }

        await assert.rejects(mockCallerPermanentlyDeleteDocument(), /images could not be permanently deleted/);
        assert.strictEqual(firestoreDocumentDeleted, false, "Firestore document must not be deleted when S3 fails");
    });

    test("S3 failure in restoreImages blocks following Firestore restore", async () => {
        s3SendMock.mock.mockImplementation(async () => {
            throw new Error("S3 Network Timeout");
        });

        let firestoreRestored = false;
        async function mockCallerRestoreDocument() {
            await restoreImages("valid", "s1", "d1", ["uploads/s1/d1/img.png"]);
            firestoreRestored = true; // Should not be reached
        }

        await assert.rejects(mockCallerRestoreDocument(), /images could not be restored/);
        assert.strictEqual(firestoreRestored, false, "Firestore document must not be restored when S3 fails");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Retryable Copy/Delete Lifecycle States & Invariants
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Retryable Copy/Delete Lifecycle States & Invariants", () => {
    test.beforeEach(() => { resetAllMocks(); setDefaultSuccessMocks(); });

    test("softDeleteImages: copy succeeds, source delete fails, then retry completes successfully", async () => {
        let attempts = 0;
        s3SendMock.mock.mockImplementation(async (cmd: { constructor: { name: string } }) => {
            const cmdName = cmd.constructor.name;
            if (cmdName === "CopyObjectCommand") {
                return {};
            }
            if (cmdName === "DeleteObjectCommand") {
                attempts++;
                if (attempts === 1) {
                    throw new Error("S3 Delete Transient Error");
                }
                return {};
            }
            return {};
        });

        // First attempt: copy succeeds, delete source fails
        await assert.rejects(
            softDeleteImages("valid", "s1", "d1", ["uploads/s1/d1/img.png"]),
            /images could not be soft-deleted/
        );

        // Retry attempt: copy succeeds (overwriting destination), delete source succeeds
        await softDeleteImages("valid", "s1", "d1", ["uploads/s1/d1/img.png"]);
        assert.strictEqual(attempts, 2);
    });

    test("softDeleteImages: destination already exists on retry when source is missing", async () => {
        // Simulate source missing on CopyObject (NoSuchKey), but destination exists on HeadObject
        s3SendMock.mock.mockImplementation(async (cmd: { constructor: { name: string } }) => {
            const cmdName = cmd.constructor.name;
            if (cmdName === "CopyObjectCommand") {
                const err = new Error("The specified key does not exist.");
                err.name = "NoSuchKey";
                throw err;
            }
            if (cmdName === "HeadObjectCommand") {
                // Destination exists!
                return { ContentLength: 1234 };
            }
            if (cmdName === "DeleteObjectCommand") {
                return {};
            }
            return {};
        });

        // Must succeed without throwing
        await softDeleteImages("valid", "s1", "d1", ["uploads/s1/d1/img.png"]);
    });

    test("softDeleteImages: fails visibly when neither source nor destination exists", async () => {
        // Both source missing (CopyObject throws NoSuchKey) and destination missing (HeadObject throws NotFound)
        s3SendMock.mock.mockImplementation(async (cmd: { constructor: { name: string } }) => {
            const cmdName = cmd.constructor.name;
            if (cmdName === "CopyObjectCommand") {
                const err = new Error("The specified key does not exist.");
                err.name = "NoSuchKey";
                throw err;
            }
            if (cmdName === "HeadObjectCommand") {
                const err = new Error("Not Found");
                err.name = "NotFound";
                (err as { $metadata?: { httpStatusCode: number } }).$metadata = { httpStatusCode: 404 };
                throw err;
            }
            return {};
        });

        await assert.rejects(
            softDeleteImages("valid", "s1", "d1", ["uploads/s1/d1/img.png"]),
            /images could not be soft-deleted/
        );
    });

    test("restoreImages: destination already exists on retry when source is missing", async () => {
        // Source (deleted/) is gone, destination (uploads/) exists
        s3SendMock.mock.mockImplementation(async (cmd: { constructor: { name: string } }) => {
            const cmdName = cmd.constructor.name;
            if (cmdName === "CopyObjectCommand") {
                const err = new Error("NoSuchKey");
                err.name = "NoSuchKey";
                throw err;
            }
            if (cmdName === "HeadObjectCommand") {
                return { ContentLength: 5678 };
            }
            if (cmdName === "DeleteObjectCommand") {
                return {};
            }
            return {};
        });

        await restoreImages("valid", "s1", "d1", ["uploads/s1/d1/img.png"]);
    });

    test("restoreImages: fails visibly when neither source nor destination exists", async () => {
        s3SendMock.mock.mockImplementation(async (cmd: { constructor: { name: string } }) => {
            const cmdName = cmd.constructor.name;
            if (cmdName === "CopyObjectCommand") {
                const err = new Error("NoSuchKey");
                err.name = "NoSuchKey";
                throw err;
            }
            if (cmdName === "HeadObjectCommand") {
                const err = new Error("NotFound");
                err.name = "NotFound";
                return Promise.reject(err);
            }
            return {};
        });

        await assert.rejects(
            restoreImages("valid", "s1", "d1", ["uploads/s1/d1/img.png"]),
            /images could not be restored/
        );
    });

    test("permanentizeImages: destination already exists on retry returns mapping", async () => {
        s3SendMock.mock.mockImplementation(async (cmd: { constructor: { name: string } }) => {
            const cmdName = cmd.constructor.name;
            if (cmdName === "CopyObjectCommand") {
                const err = new Error("The specified key does not exist.");
                err.name = "NoSuchKey";
                throw err;
            }
            if (cmdName === "HeadObjectCommand") {
                return { ContentLength: 999 };
            }
            if (cmdName === "DeleteObjectCommand") {
                return {};
            }
            return {};
        });

        const url = "temp/s1/d1/user1/test.png";
        const mapping = await permanentizeImages("valid", "s1", "d1", [url]);
        assert.strictEqual(mapping[url], "uploads/s1/d1/test.png");
    });

    test("permanentizeImages: fails visibly when neither source nor destination exists", async () => {
        s3SendMock.mock.mockImplementation(async (cmd: { constructor: { name: string } }) => {
            const cmdName = cmd.constructor.name;
            if (cmdName === "CopyObjectCommand") {
                const err = new Error("NoSuchKey");
                err.name = "NoSuchKey";
                throw err;
            }
            if (cmdName === "HeadObjectCommand") {
                const err = new Error("NotFound");
                err.name = "NotFound";
                throw err;
            }
            return {};
        });

        await assert.rejects(
            permanentizeImages("valid", "s1", "d1", ["temp/s1/d1/user1/test.png"]),
            /images could not be saved/
        );
    });

    test("partial failure among multiple images rejects and allows retry", async () => {
        let attempt = 0;
        s3SendMock.mock.mockImplementation(async (cmd: { constructor: { name: string }; params?: { Key?: string } }) => {
            const cmdName = cmd.constructor.name;
            const key = cmd.params?.Key;

            if (cmdName === "CopyObjectCommand" && key?.includes("img2")) {
                if (attempt === 0) {
                    throw new Error("S3 Error on img2");
                }
            }
            return {};
        });

        const urls = [
            "uploads/s1/d1/img1.png",
            "uploads/s1/d1/img2.png",
            "uploads/s1/d1/img3.png",
        ];

        // Attempt 1 fails because img2 fails
        await assert.rejects(
            softDeleteImages("valid", "s1", "d1", urls),
            /images could not be soft-deleted/
        );

        // Attempt 2 succeeds when img2 is fixed
        attempt = 1;
        await softDeleteImages("valid", "s1", "d1", urls);
    });

    test("repeat permanent deletion after partial prior success", async () => {
        let deleteAttempts = 0;
        s3SendMock.mock.mockImplementation(async (cmd: { constructor: { name: string }; params?: { Key?: string } }) => {
            const cmdName = cmd.constructor.name;
            if (cmdName === "ListObjectsV2Command") return { Contents: [] };
            if (cmdName === "DeleteObjectCommand") {
                const key = cmd.params?.Key;
                deleteAttempts++;
                if (deleteAttempts === 2 && key?.includes("img1")) {
                    throw new Error("S3 Delete Failure");
                }
            }
            return {};
        });

        const urls = ["uploads/s1/d1/img1.png"];

        // Attempt 1 fails on second delete call
        await assert.rejects(
            permanentDeleteImages("valid", "s1", "d1", urls),
            /images could not be permanently deleted/
        );

        // Attempt 2 succeeds
        s3SendMock.mock.mockImplementation(async () => ({}));
        await permanentDeleteImages("valid", "s1", "d1", urls);
    });
});
