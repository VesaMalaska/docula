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

import test, { mock, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Mock server-only
mock.module("server-only", { exports: {} });

// ── Environment ────────────────────────────────────────────────────────────────
process.env.AWS_BUCKET_NAME = "test-bucket";
process.env.AWS_REGION = "us-east-1";

// ── S3 Store & Mock ────────────────────────────────────────────────────────────
const s3Bucket = new Map<string, string>();
let s3FailNextCopy: Error | null = null;
let s3FailNextDelete: Error | null = null;
let s3FailNextHead: Error | null = null;
let s3FailNextList: Error | null = null;
let s3FailDeleteForKey: string | null = null;
let s3ListPageSize: number | null = null;
let s3OnDeleteHook: ((key: string) => Promise<void> | void) | null = null;

const s3SendMock = mock.fn(async (cmd: {
    constructor: { name: string };
    params?: Record<string, unknown>;
    Bucket?: string;
    Key?: string;
    CopySource?: string;
    Prefix?: string;
    ContinuationToken?: string;
    MaxKeys?: number;
}) => {
    const cmdName = cmd.constructor.name;
    const bucket = (cmd.params?.Bucket || cmd.Bucket) as string;
    const key = (cmd.params?.Key || cmd.Key) as string;

    if (cmdName === "CopyObjectCommand") {
        if (s3FailNextCopy) {
            const err = s3FailNextCopy;
            s3FailNextCopy = null;
            throw err;
        }
        const rawSource = (cmd.params?.CopySource || cmd.CopySource) as string;
        const prefix = `/${bucket}/`;
        const encodedSrc = rawSource.startsWith(prefix) ? rawSource.substring(prefix.length) : rawSource;
        const sourceKey = decodeURIComponent(encodedSrc);

        if (!s3Bucket.has(sourceKey)) {
            const err = new Error("The specified key does not exist.");
            err.name = "NoSuchKey";
            throw err;
        }
        s3Bucket.set(key, s3Bucket.get(sourceKey)!);
        return {};
    }

    if (cmdName === "DeleteObjectCommand") {
        if (s3OnDeleteHook) {
            await s3OnDeleteHook(key);
        }
        if (s3FailDeleteForKey && key === s3FailDeleteForKey) {
            s3FailDeleteForKey = null;
            throw new Error(`S3 Delete failure for ${key}`);
        }
        if (s3FailNextDelete) {
            const err = s3FailNextDelete;
            s3FailNextDelete = null;
            throw err;
        }
        s3Bucket.delete(key);
        return {};
    }

    if (cmdName === "HeadObjectCommand") {
        if (s3FailNextHead) {
            const err = s3FailNextHead;
            s3FailNextHead = null;
            throw err;
        }
        if (!s3Bucket.has(key)) {
            const err = new Error("Not Found");
            err.name = "NotFound";
            (err as { $metadata?: { httpStatusCode: number } }).$metadata = { httpStatusCode: 404 };
            throw err;
        }
        return { ContentLength: s3Bucket.get(key)!.length };
    }

    if (cmdName === "GetObjectCommand") {
        if (!s3Bucket.has(key)) {
            const err = new Error("NoSuchKey");
            err.name = "NoSuchKey";
            throw err;
        }
        return { Body: s3Bucket.get(key) };
    }

    if (cmdName === "ListObjectsV2Command") {
        if (s3FailNextList) {
            const err = s3FailNextList;
            s3FailNextList = null;
            throw err;
        }
        const prefix = ((cmd.params?.Prefix ?? cmd.Prefix) as string) || "";
        const continuationToken = (cmd.params?.ContinuationToken ?? cmd.ContinuationToken) as string | undefined;
        const requestedMax = (cmd.params?.MaxKeys ?? cmd.MaxKeys) as number | undefined;
        const maxKeys = s3ListPageSize || requestedMax || 1000;

        const matchingKeys = Array.from(s3Bucket.keys())
            .filter((k) => k.startsWith(prefix))
            .sort();

        let startIndex = 0;
        if (continuationToken) {
            const parsed = parseInt(continuationToken, 10);
            if (!isNaN(parsed)) {
                startIndex = parsed;
            }
        }

        const pageKeys = matchingKeys.slice(startIndex, startIndex + maxKeys);
        const nextIndex = startIndex + pageKeys.length;
        const isTruncated = nextIndex < matchingKeys.length;

        return {
            Contents: pageKeys.map((k) => ({ Key: k })),
            IsTruncated: isTruncated,
            NextContinuationToken: isTruncated ? String(nextIndex) : undefined,
        };
    }

    return {};
});

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

mock.module("@aws-sdk/s3-presigned-post", {
    exports: {
        createPresignedPost: mock.fn(async () => ({
            url: "https://post.example.com",
            fields: { key: "temp/mock" },
        })),
    },
});

mock.module("@aws-sdk/s3-request-presigner", {
    exports: {
        getSignedUrl: mock.fn(async () => "https://signed.example.com/get"),
    },
});

// ── In-Memory Firestore Stores ─────────────────────────────────────────────────
const spacesStore = new Map<string, Record<string, unknown>>();
const documentsStore = new Map<string, Record<string, unknown>>();
const contentStore = new Map<string, unknown>();

let firestoreFailNextTransaction = false;
let firestoreFailNextBatch = false;
let firestoreTransactionCount = 0;
let firestoreFailOnTransactionNumber: number | null = null;

function applyFieldValueUpdates(
    existing: Record<string, unknown> | undefined,
    data: Record<string, unknown>
): Record<string, unknown> {
    const updated = { ...(existing || {}) };
    for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === "object" && (v as { _type?: string })._type === "delete") {
            delete updated[k];
        } else if (v && typeof v === "object" && (v as { _type?: string })._type === "serverTimestamp") {
            updated[k] = new Date();
        } else {
            updated[k] = v;
        }
    }
    return updated;
}

function createDocRef(colName: string, docId: string) {
    return {
        id: docId,
        path: `${colName}/${docId}`,
        get: mock.fn(async () => {
            const store = colName === "spaces" ? spacesStore : documentsStore;
            const data = store.get(docId);
            if (!data) return { exists: false, data: () => undefined, id: docId, ref: createDocRef(colName, docId) };
            return { exists: true, data: () => ({ ...data }), id: docId, ref: createDocRef(colName, docId) };
        }),
        update: mock.fn(async (data: Record<string, unknown>) => {
            const store = colName === "spaces" ? spacesStore : documentsStore;
            const existing = store.get(docId);
            if (existing) {
                store.set(docId, applyFieldValueUpdates(existing, data));
            }
        }),
        delete: mock.fn(async () => {
            const store = colName === "spaces" ? spacesStore : documentsStore;
            store.delete(docId);
        }),
        collection: mock.fn((subCol: string) => ({
            doc: mock.fn((subDocId: string) => ({
                id: subDocId,
                path: `${colName}/${docId}/${subCol}/${subDocId}`,
                get: mock.fn(async () => {
                    const key = `${docId}/${subCol}/${subDocId}`;
                    const content = contentStore.get(key);
                    if (content === undefined) {
                        return { exists: false, data: () => undefined };
                    }
                    return { exists: true, data: () => ({ content }) };
                }),
                set: mock.fn(async (d: { content: unknown }) => {
                    const key = `${docId}/${subCol}/${subDocId}`;
                    contentStore.set(key, d.content);
                }),
                delete: mock.fn(async () => {
                    const key = `${docId}/${subCol}/${subDocId}`;
                    contentStore.delete(key);
                }),
            })),
        })),
    };
}

const fakeBatch = {
    update: mock.fn((ref: { id: string; path: string }, data: Record<string, unknown>) => {
        if (ref.path.startsWith("documents/")) {
            const existing = documentsStore.get(ref.id);
            if (existing) {
                documentsStore.set(ref.id, applyFieldValueUpdates(existing, data));
            }
        }
    }),
    delete: mock.fn((ref: { id: string; path: string }) => {
        if (ref.path.startsWith("documents/") && ref.path.includes("/content/")) {
            const parts = ref.path.split("/");
            contentStore.delete(`${parts[1]}/content/main`);
        } else if (ref.path.startsWith("documents/")) {
            documentsStore.delete(ref.id);
        } else if (ref.path.startsWith("spaces/")) {
            spacesStore.delete(ref.id);
        }
    }),
    commit: mock.fn(async () => {
        if (firestoreFailNextBatch) {
            firestoreFailNextBatch = false;
            throw new Error("Firestore batch commit failed");
        }
    }),
};

const fakeAdminFirestore = {
    collection: mock.fn((colName: string) => {
        const queryState = {
            filters: [] as { field: string; op: string; val: unknown }[],
            limitVal: undefined as number | undefined,
            startAfterId: undefined as string | undefined,
            isOrdered: false,
        };

        const createQuery = () => ({
            where: mock.fn((field: string, op: string, val: unknown) => {
                queryState.filters.push({ field, op, val });
                return createQuery();
            }),
            orderBy: mock.fn(() => {
                queryState.isOrdered = true;
                return createQuery();
            }),
            limit: mock.fn((n: number) => {
                queryState.limitVal = n;
                return createQuery();
            }),
            startAfter: mock.fn((snap: { id: string } | string) => {
                queryState.startAfterId = typeof snap === "string" ? snap : snap?.id;
                return createQuery();
            }),
            get: mock.fn(async () => {
                const store = colName === "spaces" ? spacesStore : documentsStore;
                let matched: { id: string; ref: ReturnType<typeof createDocRef>; data: () => Record<string, unknown> }[] = [];
                for (const [id, data] of store.entries()) {
                    let match = true;
                    for (const f of queryState.filters) {
                        if (f.op === "==") {
                            if (data[f.field] !== f.val) { match = false; break; }
                        } else if (f.op === "array-contains") {
                            const arr = data[f.field];
                            if (!Array.isArray(arr) || !arr.includes(f.val)) { match = false; break; }
                        }
                    }
                    if (match) {
                        matched.push({
                            id,
                            ref: createDocRef(colName, id),
                            data: () => ({ ...data }),
                        });
                    }
                }
                if (queryState.isOrdered || queryState.startAfterId) {
                    matched.sort((a, b) => a.id.localeCompare(b.id));
                }
                if (queryState.startAfterId) {
                    const idx = matched.findIndex((d) => d.id === queryState.startAfterId);
                    if (idx !== -1) {
                        matched = matched.slice(idx + 1);
                    }
                }
                if (queryState.limitVal) {
                    matched = matched.slice(0, queryState.limitVal);
                }
                return { docs: matched, empty: matched.length === 0 };
            }),
        });

        return {
            ...createQuery(),
            doc: mock.fn((docId: string) => createDocRef(colName, docId)),
        };
    }),
    batch: mock.fn(() => fakeBatch),
    runTransaction: mock.fn(async <T>(cb: (tx: {
        get: (ref: { id: string; path: string; get?: () => Promise<unknown> }) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
        update: (ref: { id: string; path: string }, data: Record<string, unknown>) => void;
        delete: (ref: { id: string; path: string }) => void;
    }) => Promise<T>): Promise<T> => {
        firestoreTransactionCount++;
        if (
            firestoreFailNextTransaction ||
            (firestoreFailOnTransactionNumber !== null && firestoreTransactionCount === firestoreFailOnTransactionNumber)
        ) {
            firestoreFailNextTransaction = false;
            firestoreFailOnTransactionNumber = null;
            throw new Error("Firestore transaction conflict or failure");
        }

        const stagedUpdates: { ref: { id: string; path: string }; data: Record<string, unknown> }[] = [];
        const stagedDeletes: { ref: { id: string; path: string } }[] = [];

        const tx = {
            get: mock.fn(async (ref: { id: string; path: string; get?: () => Promise<unknown> }) => {
                if (ref.path.startsWith("spaces/")) {
                    const data = spacesStore.get(ref.id);
                    if (!data) return { exists: false, data: () => undefined };
                    return { exists: true, data: () => ({ ...data }) };
                }
                if (ref.path.includes("/content/")) {
                    const parts = ref.path.split("/");
                    const content = contentStore.get(`${parts[1]}/content/main`);
                    if (content === undefined) return { exists: false, data: () => undefined };
                    return { exists: true, data: () => ({ content }) };
                }
                if (ref.path.startsWith("documents/")) {
                    const data = documentsStore.get(ref.id);
                    if (!data) return { exists: false, data: () => undefined };
                    return { exists: true, data: () => ({ ...data }) };
                }
                return { exists: false, data: () => undefined };
            }),
            update: mock.fn((ref: { id: string; path: string }, data: Record<string, unknown>) => {
                stagedUpdates.push({ ref, data });
            }),
            delete: mock.fn((ref: { id: string; path: string }) => {
                stagedDeletes.push({ ref });
            }),
        };

        const result = await cb(tx);

        for (const update of stagedUpdates) {
            if (update.ref.path.startsWith("spaces/")) {
                const existing = spacesStore.get(update.ref.id);
                if (existing) spacesStore.set(update.ref.id, applyFieldValueUpdates(existing, update.data));
            } else if (update.ref.path.startsWith("documents/")) {
                const existing = documentsStore.get(update.ref.id);
                if (existing) documentsStore.set(update.ref.id, applyFieldValueUpdates(existing, update.data));
            }
        }

        for (const del of stagedDeletes) {
            if (del.ref.path.includes("/content/")) {
                const parts = del.ref.path.split("/");
                contentStore.delete(`${parts[1]}/content/main`);
            } else if (del.ref.path.startsWith("documents/")) {
                documentsStore.delete(del.ref.id);
            } else if (del.ref.path.startsWith("spaces/")) {
                spacesStore.delete(del.ref.id);
            }
        }

        return result;
    }),
};

mock.module("../server/firebase-admin", {
    exports: {
        getAdminFirestore: () => fakeAdminFirestore,
        getAdminAuth: () => ({
            verifyIdToken: async (token: string) => {
                if (token === "valid" || token === "valid-user") return { uid: "user-123" };
                if (token === "other-user") return { uid: "user-other" };
                throw new Error("Invalid or expired ID token");
            },
        }),
    },
});

mock.module("firebase-admin/firestore", {
    exports: {
        FieldValue: {
            serverTimestamp: () => ({ _type: "serverTimestamp" }),
            delete: () => ({ _type: "delete" }),
        },
    },
});

// Import the actions to test
const { softDeleteDocumentAction, restoreDocumentAction } = await import("../actions/document-soft-delete");
const { permanentlyDeleteDocumentAction } = await import("../actions/document-permanent-delete");
const { purgeSpaceStepAction } = await import("../actions/space-purge");
const { permanentizeImages, cleanupRemovedDocumentImages, deleteImages } = await import("../actions/s3");

// ── Helpers ────────────────────────────────────────────────────────────────────
function createTipTapContentWithImages(imageUrls: string[]) {
    return {
        type: "doc",
        content: [
            {
                type: "paragraph",
                content: [{ type: "text", text: "Test document content" }],
            },
            ...imageUrls.map((url) => ({
                type: "image",
                attrs: { src: url },
            })),
        ],
    };
}

function resetEnvironment() {
    s3Bucket.clear();
    spacesStore.clear();
    documentsStore.clear();
    contentStore.clear();
    s3SendMock.mock.resetCalls();
    s3FailNextCopy = null;
    s3FailNextDelete = null;
    s3FailNextHead = null;
    s3FailNextList = null;
    s3FailDeleteForKey = null;
    s3ListPageSize = null;
    s3OnDeleteHook = null;
    firestoreFailNextTransaction = false;
    firestoreFailNextBatch = false;
    firestoreTransactionCount = 0;
    firestoreFailOnTransactionNumber = null;

    // Default space setup
    spacesStore.set("s1", {
        id: "s1",
        ownerId: "user-123",
        userIds: ["user-123"],
        name: "Test Space",
        deletedAt: null,
        purgeState: null,
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Soft-Delete Document Image Lifecycle & Retry Consistency
// ═══════════════════════════════════════════════════════════════════════════════
describe("Soft-Delete Document Image Lifecycle & Retry Consistency", () => {
    beforeEach(() => { resetEnvironment(); });

    test("copy succeeds, source delete fails: both keys exist, operation fails retaining claim; retry finishes delete and marks doc deleted", async () => {
        const docId = "doc-1";
        const imgKey = "uploads/s1/doc-1/diagram.png";
        const imgUrl = `https://test-bucket.s3.amazonaws.com/${imgKey}`;
        const deletedKey = `deleted/${imgKey}`;

        // Populate S3 store
        s3Bucket.set(imgKey, "image-content-bytes");

        // Populate Firestore
        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc with image",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([imgUrl]));

        // Fail the source delete on the first attempt
        s3FailDeleteForKey = imgKey;

        // 1. Initial soft-delete attempt: copy succeeds, delete fails
        await assert.rejects(
            softDeleteDocumentAction("valid", "s1", docId, "delete-subtree"),
            /images could not be soft-deleted/
        );

        // Assert S3 state: Both source and destination exist (State C)
        assert.strictEqual(s3Bucket.has(imgKey), true, "Source must still exist because delete failed");
        assert.strictEqual(s3Bucket.has(deletedKey), true, "Destination must exist because copy succeeded");

        // Assert Firestore state: Document remains NOT deleted, lifecycle claim is retained
        const docAfterFailure = documentsStore.get(docId)!;
        assert.strictEqual(docAfterFailure.deleted, false, "Document must not be marked deleted on S3 failure");
        assert.ok(docAfterFailure.lifecycleClaim != null, "Lifecycle claim must be retained for retry");
        assert.strictEqual((docAfterFailure.lifecycleClaim as { operation: string }).operation, "soft-delete");

        // 2. Retry soft-delete: delete succeeds this time
        const result = await softDeleteDocumentAction("valid", "s1", docId, "delete-subtree");
        assert.strictEqual(result.success, true);

        // Assert S3 state: Destination only exists (State A -> C -> B completed)
        assert.strictEqual(s3Bucket.has(imgKey), false, "Source must be deleted after retry");
        assert.strictEqual(s3Bucket.has(deletedKey), true, "Destination must exist");

        // Assert Firestore state: Document is now marked deleted, claim is cleared
        const docAfterRetry = documentsStore.get(docId)!;
        assert.strictEqual(docAfterRetry.deleted, true);
        assert.strictEqual(docAfterRetry.lifecycleClaim, null, "Lifecycle claim must be cleared after final commit");
    });

    test("copy and source delete succeed, final Firestore transaction fails: retry recognizes destination already exists and completes", async () => {
        const docId = "doc-2";
        const imgKey = "uploads/s1/doc-2/chart.png";
        const imgUrl = `https://test-bucket.s3.amazonaws.com/${imgKey}`;
        const deletedKey = `deleted/${imgKey}`;

        s3Bucket.set(imgKey, "chart-bytes");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc with chart",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([imgUrl]));

        // Fail the final Firestore transaction (transaction #2, after claim transaction #1) on the first attempt
        firestoreFailOnTransactionNumber = 2;

        // 1. Initial attempt fails at final Firestore commit
        await assert.rejects(
            softDeleteDocumentAction("valid", "s1", docId, "delete-subtree"),
            /Firestore transaction conflict or failure/
        );

        // Assert S3 state: S3 work completed (State B: destination exists, source deleted)
        assert.strictEqual(s3Bucket.has(imgKey), false, "Source was successfully deleted");
        assert.strictEqual(s3Bucket.has(deletedKey), true, "Destination was successfully created");

        // Assert Firestore state: Document is still active, claim is retained
        const docAfterFailure = documentsStore.get(docId)!;
        assert.strictEqual(docAfterFailure.deleted, false);
        assert.ok(docAfterFailure.lifecycleClaim != null);

        // 2. Retry soft-delete: S3 recognizes destination already exists, completes without error
        const result = await softDeleteDocumentAction("valid", "s1", docId, "delete-subtree");
        assert.strictEqual(result.success, true);

        // Assert S3 state remains intact
        assert.strictEqual(s3Bucket.has(deletedKey), true);
        assert.strictEqual(s3Bucket.has(imgKey), false);

        // Assert Firestore state: Document marked deleted, claim cleared
        const docAfterRetry = documentsStore.get(docId)!;
        assert.strictEqual(docAfterRetry.deleted, true);
        assert.strictEqual(docAfterRetry.lifecycleClaim, null);
    });

    test("source and destination both missing: fails visibly and retains Firestore claim", async () => {
        const docId = "doc-missing";
        const imgKey = "uploads/s1/doc-missing/vanished.png";
        const imgUrl = `https://test-bucket.s3.amazonaws.com/${imgKey}`;

        // DO NOT put the image in s3Bucket (neither source nor destination exists)
        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc with missing image",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([imgUrl]));

        // Must fail visibly
        await assert.rejects(
            softDeleteDocumentAction("valid", "s1", docId, "delete-subtree"),
            /images could not be soft-deleted/
        );

        // Firestore record must remain intact with claim for recovery
        const docAfterFailure = documentsStore.get(docId)!;
        assert.strictEqual(docAfterFailure.deleted, false);
        assert.ok(docAfterFailure.lifecycleClaim != null);
    });

    test("partial failure among multiple images halts operation, retains claim across subtree, and succeeds on retry", async () => {
        const rootDocId = "root-doc";
        const childDocId = "child-doc";

        const img1Key = "uploads/s1/root-doc/img1.png";
        const img2Key = "uploads/s1/child-doc/img2.png";

        s3Bucket.set(img1Key, "img1-bytes");
        s3Bucket.set(img2Key, "img2-bytes");

        documentsStore.set(rootDocId, {
            id: rootDocId,
            spaceId: "s1",
            title: "Root",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
        });
        contentStore.set(`${rootDocId}/content/main`, createTipTapContentWithImages([`https://test-bucket.s3.amazonaws.com/${img1Key}`]));

        documentsStore.set(childDocId, {
            id: childDocId,
            spaceId: "s1",
            title: "Child",
            deleted: false,
            deletedAt: null,
            parentId: rootDocId,
            path: [rootDocId],
        });
        contentStore.set(`${childDocId}/content/main`, createTipTapContentWithImages([`https://test-bucket.s3.amazonaws.com/${img2Key}`]));

        // Fail delete of img2
        s3FailDeleteForKey = img2Key;

        // 1. Initial attempt fails
        await assert.rejects(
            softDeleteDocumentAction("valid", "s1", rootDocId, "delete-subtree"),
            /images could not be soft-deleted/
        );

        // Both documents must retain their claims and not be deleted
        assert.strictEqual(documentsStore.get(rootDocId)!.deleted, false);
        assert.strictEqual(documentsStore.get(childDocId)!.deleted, false);
        assert.ok(documentsStore.get(rootDocId)!.lifecycleClaim != null);
        assert.ok(documentsStore.get(childDocId)!.lifecycleClaim != null);

        // 2. Retry succeeds
        const result = await softDeleteDocumentAction("valid", "s1", rootDocId, "delete-subtree");
        assert.strictEqual(result.success, true);

        // Both documents now deleted, claims cleared
        assert.strictEqual(documentsStore.get(rootDocId)!.deleted, true);
        assert.strictEqual(documentsStore.get(childDocId)!.deleted, true);
        assert.strictEqual(documentsStore.get(rootDocId)!.lifecycleClaim, null);
        assert.strictEqual(documentsStore.get(childDocId)!.lifecycleClaim, null);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Restore Document Image Lifecycle & Retry Consistency
// ═══════════════════════════════════════════════════════════════════════════════
describe("Restore Document Image Lifecycle & Retry Consistency", () => {
    beforeEach(() => { resetEnvironment(); });

    test("restore copy succeeds, source delete fails: retry completes delete and restores document", async () => {
        const docId = "restore-doc";
        const activeKey = "uploads/s1/restore-doc/file.png";
        const deletedKey = `deleted/${activeKey}`;

        // Image is currently soft-deleted (in deleted/uploads/...)
        s3Bucket.set(deletedKey, "file-bytes");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Soft deleted doc",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([`https://test-bucket.s3.amazonaws.com/${activeKey}`]));

        // Fail delete of deletedKey during restore
        s3FailDeleteForKey = deletedKey;

        // 1. Initial attempt fails at delete
        await assert.rejects(
            restoreDocumentAction("valid", "s1", docId, { kind: "root" }),
            /images could not be restored/
        );

        // S3 State: Both exist
        assert.strictEqual(s3Bucket.has(activeKey), true, "Destination must exist from copy");
        assert.strictEqual(s3Bucket.has(deletedKey), true, "Source must exist because delete failed");

        // Firestore: Still deleted, claim retained
        const docAfterFailure = documentsStore.get(docId)!;
        assert.strictEqual(docAfterFailure.deleted, true);
        assert.ok(docAfterFailure.lifecycleClaim != null);

        // 2. Retry succeeds
        const result = await restoreDocumentAction("valid", "s1", docId, { kind: "root" });
        assert.strictEqual(result.success, true);

        // S3 State: Active only
        assert.strictEqual(s3Bucket.has(activeKey), true);
        assert.strictEqual(s3Bucket.has(deletedKey), false);

        // Firestore: Restored to active, claim cleared
        const docAfterRetry = documentsStore.get(docId)!;
        assert.strictEqual(docAfterRetry.deleted, false);
        assert.strictEqual(docAfterRetry.lifecycleClaim, null);
    });

    test("restore S3 succeeds, final Firestore transaction fails: retry recognizes destination already exists and completes", async () => {
        const docId = "restore-toctou";
        const activeKey = "uploads/s1/restore-toctou/file.png";
        const deletedKey = `deleted/${activeKey}`;

        s3Bucket.set(deletedKey, "file-bytes");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Soft deleted doc",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([`https://test-bucket.s3.amazonaws.com/${activeKey}`]));

        // Fail final transaction
        firestoreFailNextTransaction = true;

        // 1. Fails at transaction
        await assert.rejects(
            restoreDocumentAction("valid", "s1", docId, { kind: "root" }),
            /Firestore transaction conflict or failure/
        );

        // S3 State: Already moved to active (destination only)
        assert.strictEqual(s3Bucket.has(activeKey), true);
        assert.strictEqual(s3Bucket.has(deletedKey), false);

        // Firestore: Still deleted with claim
        assert.strictEqual(documentsStore.get(docId)!.deleted, true);
        assert.ok(documentsStore.get(docId)!.lifecycleClaim != null);

        // 2. Retry recognizes destination already exists
        const result = await restoreDocumentAction("valid", "s1", docId, { kind: "root" });
        assert.strictEqual(result.success, true);

        // Firestore: Restored, claim cleared
        assert.strictEqual(documentsStore.get(docId)!.deleted, false);
        assert.strictEqual(documentsStore.get(docId)!.lifecycleClaim, null);
    });

    test("restore fails visibly when neither source nor destination exists", async () => {
        const docId = "restore-ghost";
        const activeKey = "uploads/s1/restore-ghost/file.png";

        // Image not in bucket
        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Soft deleted doc",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([`https://test-bucket.s3.amazonaws.com/${activeKey}`]));

        await assert.rejects(
            restoreDocumentAction("valid", "s1", docId, { kind: "root" }),
            /images could not be restored/
        );

        assert.strictEqual(documentsStore.get(docId)!.deleted, true);
        assert.ok(documentsStore.get(docId)!.lifecycleClaim != null);
    });

    test("subtree grouped restore: S3 failure retains claims across entire group; retry succeeds and restores all documents", async () => {
        const rootDocId = "root-restore";
        const childDocId = "child-restore";
        const groupId = "group-restore-1";

        const rootActiveKey = `uploads/s1/${rootDocId}/root.png`;
        const rootDeletedKey = `deleted/${rootActiveKey}`;
        const childActiveKey = `uploads/s1/${childDocId}/child.png`;
        const childDeletedKey = `deleted/${childActiveKey}`;

        s3Bucket.set(rootDeletedKey, "root-bytes");
        s3Bucket.set(childDeletedKey, "child-bytes");

        documentsStore.set(rootDocId, {
            id: rootDocId,
            spaceId: "s1",
            title: "Root Doc",
            deleted: true,
            deletedAt: new Date(),
            deletionGroupId: groupId,
            deletionGroupRootId: rootDocId,
            deletionGroupCount: 2,
            parentId: null,
            path: [],
            restoreParentId: null,
        });
        documentsStore.set(childDocId, {
            id: childDocId,
            spaceId: "s1",
            title: "Child Doc",
            deleted: true,
            deletedAt: new Date(),
            deletionGroupId: groupId,
            deletionGroupRootId: rootDocId,
            parentId: rootDocId,
            path: [rootDocId],
            restoreParentId: rootDocId,
        });

        contentStore.set(`${rootDocId}/content/main`, createTipTapContentWithImages([`https://test-bucket.s3.amazonaws.com/${rootActiveKey}`]));
        contentStore.set(`${childDocId}/content/main`, createTipTapContentWithImages([`https://test-bucket.s3.amazonaws.com/${childActiveKey}`]));

        // Fail delete of child's deleted key during restore
        s3FailDeleteForKey = childDeletedKey;

        // 1. Initial attempt fails
        await assert.rejects(
            restoreDocumentAction("valid", "s1", rootDocId, { kind: "root" }),
            /images could not be restored/
        );

        // Root image was completely restored to active
        assert.strictEqual(s3Bucket.has(rootActiveKey), true);
        assert.strictEqual(s3Bucket.has(rootDeletedKey), false);
        // Child image had copy succeed, delete fail -> both exist
        assert.strictEqual(s3Bucket.has(childActiveKey), true);
        assert.strictEqual(s3Bucket.has(childDeletedKey), true);

        // Firestore: Both documents remain deleted with lifecycle claims retained
        const rootAfterFail = documentsStore.get(rootDocId)!;
        const childAfterFail = documentsStore.get(childDocId)!;
        assert.strictEqual(rootAfterFail.deleted, true);
        assert.ok(rootAfterFail.lifecycleClaim != null);
        assert.strictEqual(childAfterFail.deleted, true);
        assert.ok(childAfterFail.lifecycleClaim != null);

        // 2. Retry succeeds
        const result = await restoreDocumentAction("valid", "s1", rootDocId, { kind: "root" });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.restoredCount, 2);

        // S3 State: Both active only
        assert.strictEqual(s3Bucket.has(rootActiveKey), true);
        assert.strictEqual(s3Bucket.has(rootDeletedKey), false);
        assert.strictEqual(s3Bucket.has(childActiveKey), true);
        assert.strictEqual(s3Bucket.has(childDeletedKey), false);

        // Firestore: Both restored and claims cleared
        const rootFinal = documentsStore.get(rootDocId)!;
        const childFinal = documentsStore.get(childDocId)!;
        assert.strictEqual(rootFinal.deleted, false);
        assert.strictEqual(rootFinal.lifecycleClaim, null);
        assert.strictEqual(childFinal.deleted, false);
        assert.strictEqual(childFinal.lifecycleClaim, null);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Permanent Deletion & Space Purge Consistency
// ═══════════════════════════════════════════════════════════════════════════════
describe("Permanent Deletion & Space Purge Consistency", () => {
    beforeEach(() => { resetEnvironment(); });

    test("permanentlyDeleteDocumentAction: S3 deletion failure leaves Firestore records and claim intact", async () => {
        const docId = "perm-doc";
        const activeKey = "uploads/s1/perm-doc/photo.png";

        s3Bucket.set(activeKey, "photo-bytes");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc to permanently delete",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([`https://test-bucket.s3.amazonaws.com/${activeKey}`]));

        // Fail S3 delete
        s3FailDeleteForKey = activeKey;

        // Permanent deletion must reject
        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", docId),
            /images could not be permanently deleted/
        );

        // Firestore document and content records MUST remain intact
        assert.ok(documentsStore.has(docId), "Document record must not be deleted on S3 failure");
        assert.ok(contentStore.has(`${docId}/content/main`), "Content record must not be deleted on S3 failure");

        // Permanent deletion claim must remain on document for retry
        const doc = documentsStore.get(docId)!;
        assert.ok(doc.permanentDeletionClaim != null, "Claim must remain intact");
    });

    test("permanentlyDeleteDocumentAction: repeat deletion after partial prior success succeeds", async () => {
        const docId = "perm-partial";
        const key1 = "uploads/s1/perm-partial/img1.png";
        const key2 = "uploads/s1/perm-partial/img2.png";

        s3Bucket.set(key1, "img1-bytes");
        s3Bucket.set(key2, "img2-bytes");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc with multiple images",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
        });
        contentStore.set(
            `${docId}/content/main`,
            createTipTapContentWithImages([
                `https://test-bucket.s3.amazonaws.com/${key1}`,
                `https://test-bucket.s3.amazonaws.com/${key2}`,
            ])
        );

        // Fail on key2 during attempt 1
        s3FailDeleteForKey = key2;

        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", docId),
            /images could not be permanently deleted/
        );

        // Firestore still holds document
        assert.ok(documentsStore.has(docId));

        // Attempt 2 (retry) with S3 recovered
        const result = await permanentlyDeleteDocumentAction("valid", "s1", docId);
        assert.deepEqual(result, { success: true });

        // Firestore records completely removed
        assert.strictEqual(documentsStore.has(docId), false);
        assert.strictEqual(contentStore.has(`${docId}/content/main`), false);
    });

    test("purgeSpaceStepAction: S3 failure retains document records and leaves space in purgeState for retry", async () => {
        const spaceId = "s1";
        const docId = "purge-doc-1";
        const imgKey = "uploads/s1/purge-doc-1/img.png";

        s3Bucket.set(imgKey, "purge-bytes");

        // Soft-deleted space
        spacesStore.set(spaceId, {
            id: spaceId,
            ownerId: "user-123",
            userIds: ["user-123"],
            name: "Deleted Space",
            deletedAt: new Date(),
            purgeState: null,
        });

        documentsStore.set(docId, {
            id: docId,
            spaceId,
            title: "Purge Doc",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([`https://test-bucket.s3.amazonaws.com/${imgKey}`]));

        // Fail S3 delete during purge
        s3FailDeleteForKey = imgKey;

        // Purge step must fail with generic actionable error
        await assert.rejects(
            purgeSpaceStepAction("valid", spaceId, 10),
            /Failed to delete space images during permanent purge/
        );

        // Document and Space records must remain intact
        assert.ok(documentsStore.has(docId), "Document must be retained on S3 cleanup failure");
        assert.ok(contentStore.has(`${docId}/content/main`), "Content must be retained on S3 cleanup failure");
        assert.ok(spacesStore.has(spaceId), "Space must not be deleted while document cleanup failed");
        assert.strictEqual(spacesStore.get(spaceId)!.purgeState, "purging");

        // Retry after S3 recovers
        const step1 = await purgeSpaceStepAction("valid", spaceId, 10);
        assert.strictEqual(step1.success, true);
        assert.strictEqual(step1.done, true);
        assert.strictEqual(step1.processedCount, 1);

        // Everything deleted
        assert.strictEqual(documentsStore.has(docId), false);
        assert.strictEqual(contentStore.has(`${docId}/content/main`), false);
        assert.strictEqual(spacesStore.has(spaceId), false);
    });

    test("permanentlyDeleteDocumentAction: cleans up modern document-scoped key removed from TipTap content (0 content images)", async () => {
        const docId = "perm-orphan";
        const orphanKey = "uploads/s1/perm-orphan/removed-from-content.png";

        s3Bucket.set(orphanKey, "orphan-bytes");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc with image removed from content",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
        });
        // Content references zero images
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        const result = await permanentlyDeleteDocumentAction("valid", "s1", docId);
        assert.deepEqual(result, { success: true });

        // Orphaned modern document-scoped key was discovered and deleted
        assert.strictEqual(s3Bucket.has(orphanKey), false, "Unreferenced modern key must be deleted");
        assert.strictEqual(documentsStore.has(docId), false);
        assert.strictEqual(contentStore.has(`${docId}/content/main`), false);
    });

    test("permanentlyDeleteDocumentAction: empty URL list with 0 content images and 0 S3 objects completes cleanly", async () => {
        const docId = "perm-empty";

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc with zero images",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        const result = await permanentlyDeleteDocumentAction("valid", "s1", docId);
        assert.deepEqual(result, { success: true });

        assert.strictEqual(documentsStore.has(docId), false);
        assert.strictEqual(contentStore.has(`${docId}/content/main`), false);
    });

    test("permanentlyDeleteDocumentAction: cleans up keys in both uploads/ and deleted/uploads/ prefixes", async () => {
        const docId = "perm-both-prefixes";
        const activeKey = "uploads/s1/perm-both-prefixes/active.png";
        const deletedKey = "deleted/uploads/s1/perm-both-prefixes/soft-deleted.png";

        s3Bucket.set(activeKey, "active-bytes");
        s3Bucket.set(deletedKey, "deleted-bytes");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc with both prefixes",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        const result = await permanentlyDeleteDocumentAction("valid", "s1", docId);
        assert.deepEqual(result, { success: true });

        assert.strictEqual(s3Bucket.has(activeKey), false, "Active prefix key must be deleted");
        assert.strictEqual(s3Bucket.has(deletedKey), false, "Deleted prefix key must be deleted");
        assert.strictEqual(documentsStore.has(docId), false);
        assert.strictEqual(contentStore.has(`${docId}/content/main`), false);
    });

    test("permanentlyDeleteDocumentAction: paginates through multiple pages using NextContinuationToken and deletes all discovered keys", async () => {
        const docId = "perm-paged";
        const keys = [
            "uploads/s1/perm-paged/img1.png",
            "uploads/s1/perm-paged/img2.png",
            "uploads/s1/perm-paged/img3.png",
            "deleted/uploads/s1/perm-paged/img4.png",
            "deleted/uploads/s1/perm-paged/img5.png",
        ];

        for (const k of keys) {
            s3Bucket.set(k, "img-bytes");
        }

        // Force page size of 2 to exercise multi-page pagination
        s3ListPageSize = 2;

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc with paged keys",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        const result = await permanentlyDeleteDocumentAction("valid", "s1", docId);
        assert.deepEqual(result, { success: true });

        for (const k of keys) {
            assert.strictEqual(s3Bucket.has(k), false, `Key ${k} must be deleted via pagination`);
        }
        assert.strictEqual(documentsStore.has(docId), false);
        assert.strictEqual(contentStore.has(`${docId}/content/main`), false);
    });

    test("permanentlyDeleteDocumentAction: S3 listing failure retains Firestore document and claim; retry completes deletion", async () => {
        const docId = "perm-list-fail";
        const key = "uploads/s1/perm-list-fail/photo.png";

        s3Bucket.set(key, "photo-bytes");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc with list failure",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        // Fail S3 ListObjectsV2
        s3FailNextList = new Error("S3 ListObjectsV2 AccessDenied or RateExceeded");

        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", docId),
            /images could not be permanently deleted/
        );

        // Firestore document remains intact with claim
        assert.ok(documentsStore.has(docId));
        assert.ok(documentsStore.get(docId)!.permanentDeletionClaim != null);
        assert.ok(contentStore.has(`${docId}/content/main`));
        assert.strictEqual(s3Bucket.has(key), true);

        // Retry after listing recovers
        const retryResult = await permanentlyDeleteDocumentAction("valid", "s1", docId);
        assert.deepEqual(retryResult, { success: true });

        assert.strictEqual(s3Bucket.has(key), false);
        assert.strictEqual(documentsStore.has(docId), false);
        assert.strictEqual(contentStore.has(`${docId}/content/main`), false);
    });

    test("permanentlyDeleteDocumentAction: isolates deletion to target document prefix, preserving keys from other documents, spaces, and legacy keys", async () => {
        const targetDocId = "doc-target";
        const targetActiveKey = "uploads/s1/doc-target/target.png";
        const targetDeletedKey = "deleted/uploads/s1/doc-target/target-del.png";
        const otherDocKey = "uploads/s1/other-doc/other.png";
        const otherSpaceKey = "uploads/other-space/doc-target/foreign.png";
        const legacyKey = "uploads/legacy-preserved.png";

        s3Bucket.set(targetActiveKey, "target-active");
        s3Bucket.set(targetDeletedKey, "target-deleted");
        s3Bucket.set(otherDocKey, "other-doc");
        s3Bucket.set(otherSpaceKey, "other-space");
        s3Bucket.set(legacyKey, "legacy");

        documentsStore.set(targetDocId, {
            id: targetDocId,
            spaceId: "s1",
            title: "Target Doc",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
        });
        contentStore.set(`${targetDocId}/content/main`, createTipTapContentWithImages([]));

        const result = await permanentlyDeleteDocumentAction("valid", "s1", targetDocId);
        assert.deepEqual(result, { success: true });

        // Target document keys deleted
        assert.strictEqual(s3Bucket.has(targetActiveKey), false, "Target active key deleted");
        assert.strictEqual(s3Bucket.has(targetDeletedKey), false, "Target deleted key deleted");

        // Isolated keys must be untouched
        assert.strictEqual(s3Bucket.has(otherDocKey), true, "Other document in same space must be untouched");
        assert.strictEqual(s3Bucket.has(otherSpaceKey), true, "Same document ID in other space must be untouched");
        assert.strictEqual(s3Bucket.has(legacyKey), true, "Legacy key must never be swept");
    });

    test("purgeSpaceStepAction: cleans up modern document-scoped keys removed from TipTap content", async () => {
        const spaceId = "s1";
        const docId = "purge-orphan-doc";
        const orphanActiveKey = "uploads/s1/purge-orphan-doc/orphan-active.png";
        const orphanDeletedKey = "deleted/uploads/s1/purge-orphan-doc/orphan-deleted.png";

        s3Bucket.set(orphanActiveKey, "orphan-active-bytes");
        s3Bucket.set(orphanDeletedKey, "orphan-deleted-bytes");

        spacesStore.set(spaceId, {
            id: spaceId,
            ownerId: "user-123",
            userIds: ["user-123"],
            name: "Deleted Space",
            deletedAt: new Date(),
            purgeState: null,
        });

        documentsStore.set(docId, {
            id: docId,
            spaceId,
            title: "Purge Orphan Doc",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
        });
        // Content has 0 images
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        const stepResult = await purgeSpaceStepAction("valid", spaceId, 10);
        assert.strictEqual(stepResult.success, true);
        assert.strictEqual(stepResult.done, true);
        assert.strictEqual(stepResult.processedCount, 1);

        // Both unreferenced scoped keys deleted
        assert.strictEqual(s3Bucket.has(orphanActiveKey), false);
        assert.strictEqual(s3Bucket.has(orphanDeletedKey), false);
        assert.strictEqual(documentsStore.has(docId), false);
        assert.strictEqual(contentStore.has(`${docId}/content/main`), false);
        assert.strictEqual(spacesStore.has(spaceId), false);
    });

    test("permanentlyDeleteDocumentAction: 501 scoped objects ceiling is bounded and retry makes forward progress to completion", async () => {
        const docId = "perm-501";
        const TOTAL_OBJECTS = 501;

        for (let i = 0; i < TOTAL_OBJECTS; i++) {
            s3Bucket.set(`uploads/s1/${docId}/img_${String(i).padStart(4, "0")}.png`, `bytes_${i}`);
        }

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc with 501 images",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        // Attempt 1: Reaches safe per-step ceiling (500), deletes 500 objects, and pauses for retry
        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", docId),
            /images could not be permanently deleted/
        );

        // Verification of Attempt 1 progress:
        // Exactly 500 objects deleted from S3; exactly 1 object remains
        assert.strictEqual(s3Bucket.size, 1, "Attempt 1 must make bounded progress by deleting first 500 objects");
        assert.strictEqual(s3Bucket.has(`uploads/s1/${docId}/img_${String(TOTAL_OBJECTS - 1).padStart(4, "0")}.png`), true);

        // Firestore document, content, and claim remain intact on failure
        assert.ok(documentsStore.has(docId), "Document must be retained for retry");
        assert.ok(contentStore.has(`${docId}/content/main`), "Content must be retained for retry");
        assert.ok(documentsStore.get(docId)!.permanentDeletionClaim != null, "Claim must remain intact for retry");

        // Attempt 2 (Retry): Deletes remaining 1 object and completes Firestore deletion
        const retryResult = await permanentlyDeleteDocumentAction("valid", "s1", docId);
        assert.deepEqual(retryResult, { success: true });

        // Verification of Attempt 2 completion:
        assert.strictEqual(s3Bucket.size, 0, "All 501 objects must be deleted from S3 after retry");
        assert.strictEqual(documentsStore.has(docId), false, "Document must be deleted from Firestore");
        assert.strictEqual(contentStore.has(`${docId}/content/main`), false, "Content must be deleted from Firestore");
    });

    test("purgeSpaceStepAction: 501 scoped objects ceiling is bounded and retry makes forward progress to completion", async () => {
        const spaceId = "purge-501-space";
        const docId = "purge-501-doc";
        const TOTAL_OBJECTS = 501;

        for (let i = 0; i < TOTAL_OBJECTS; i++) {
            s3Bucket.set(`uploads/${spaceId}/${docId}/img_${String(i).padStart(4, "0")}.png`, `bytes_${i}`);
        }

        spacesStore.set(spaceId, {
            id: spaceId,
            ownerId: "user-123",
            userIds: ["user-123"],
            name: "501 Images Purge Space",
            deletedAt: new Date(),
            purgeState: null,
        });

        documentsStore.set(docId, {
            id: docId,
            spaceId,
            title: "Doc with 501 images in purge",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        // Step 1: Processes docId, deletes 500 objects, halts because more remain
        await assert.rejects(
            purgeSpaceStepAction("valid", spaceId, 10),
            /Failed to delete space images during permanent purge/
        );

        // Progress made: 500 deleted, 1 remaining in S3
        assert.strictEqual(s3Bucket.size, 1, "Step 1 must delete 500 objects and leave 1");
        assert.ok(documentsStore.has(docId), "Document must be retained");
        assert.ok(spacesStore.has(spaceId), "Space must be retained");
        assert.strictEqual(spacesStore.get(spaceId)!.purgeState, "purging");

        // Step 2 (Retry): Deletes remaining 1 object, commits document deletion, and finalizes space purge
        const step2 = await purgeSpaceStepAction("valid", spaceId, 10);
        assert.strictEqual(step2.success, true);
        assert.strictEqual(step2.done, true);
        assert.strictEqual(step2.processedCount, 1);

        assert.strictEqual(s3Bucket.size, 0, "All objects deleted from S3");
        assert.strictEqual(documentsStore.has(docId), false);
        assert.strictEqual(contentStore.has(`${docId}/content/main`), false);
        assert.strictEqual(spacesStore.has(spaceId), false);
    });

    test("permanentlyDeleteDocumentAction: S3 AccessDenied (403) on ListObjectsV2 retains Firestore records and claim; retry after IAM grant completes deletion", async () => {
        const docId = "perm-access-denied";
        const key = "uploads/s1/perm-access-denied/photo.png";

        s3Bucket.set(key, "photo-bytes");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc with AccessDenied listing",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        // Inject simulated AWS 403 AccessDenied error during ListObjectsV2
        const accessDeniedErr = new Error("Access Denied");
        accessDeniedErr.name = "AccessDenied";
        (accessDeniedErr as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 403 };
        s3FailNextList = accessDeniedErr;

        // Permanent deletion must reject with sanitized error without exposing raw AWS error
        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", docId),
            /images could not be permanently deleted/
        );

        // Firestore document remains intact with claim
        assert.ok(documentsStore.has(docId));
        assert.ok(documentsStore.get(docId)!.permanentDeletionClaim != null);
        assert.ok(contentStore.has(`${docId}/content/main`));
        assert.strictEqual(s3Bucket.has(key), true);

        // Retry after IAM permission is granted (fault cleared)
        const retryResult = await permanentlyDeleteDocumentAction("valid", "s1", docId);
        assert.deepEqual(retryResult, { success: true });

        assert.strictEqual(s3Bucket.has(key), false);
        assert.strictEqual(documentsStore.has(docId), false);
        assert.strictEqual(contentStore.has(`${docId}/content/main`), false);
    });

    test("purgeSpaceStepAction: S3 AccessDenied (403) on ListObjectsV2 retains Firestore records and space in purging state; retry after IAM grant completes purge", async () => {
        const spaceId = "purge-denied-space";
        const docId = "purge-denied-doc";
        const key = `uploads/${spaceId}/${docId}/img.png`;

        s3Bucket.set(key, "img-bytes");

        spacesStore.set(spaceId, {
            id: spaceId,
            ownerId: "user-123",
            userIds: ["user-123"],
            name: "Denied Space",
            deletedAt: new Date(),
            purgeState: null,
        });

        documentsStore.set(docId, {
            id: docId,
            spaceId,
            title: "Doc in Denied Space",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        // Inject 403 AccessDenied
        const accessDeniedErr = new Error("Access Denied");
        accessDeniedErr.name = "AccessDenied";
        (accessDeniedErr as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 403 };
        s3FailNextList = accessDeniedErr;

        await assert.rejects(
            purgeSpaceStepAction("valid", spaceId, 10),
            /Failed to delete space images during permanent purge/
        );

        assert.ok(documentsStore.has(docId));
        assert.ok(spacesStore.has(spaceId));
        assert.strictEqual(spacesStore.get(spaceId)!.purgeState, "purging");
        assert.strictEqual(s3Bucket.has(key), true);

        // Retry after IAM permission is granted
        const retryResult = await purgeSpaceStepAction("valid", spaceId, 10);
        assert.strictEqual(retryResult.success, true);
        assert.strictEqual(retryResult.done, true);
        assert.strictEqual(s3Bucket.has(key), false);
        assert.strictEqual(documentsStore.has(docId), false);
        assert.strictEqual(spacesStore.has(spaceId), false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Key Isolation & Content Authorization Invariants
// ═══════════════════════════════════════════════════════════════════════════════
describe("Key Isolation & Content Authorization Invariants", () => {
    beforeEach(() => { resetEnvironment(); });

    test("stale or changing content cannot authorize deletion of newly referenced or foreign key", async () => {
        const docId = "doc-auth";
        const validKey = "uploads/s1/doc-auth/valid.png";

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Auth test doc",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([`https://test-bucket.s3.amazonaws.com/${validKey}`]));

        const { permanentDeleteImages, softDeleteImages, restoreImages } = await import("../actions/s3");

        // Foreign Space key rejected
        await assert.rejects(
            permanentDeleteImages("valid", "s1", docId, ["uploads/foreign-space/doc-auth/img.png"]),
            /Permission denied: key belongs to another space/
        );

        await assert.rejects(
            softDeleteImages("valid", "s1", docId, ["uploads/foreign-space/doc-auth/img.png"]),
            /Permission denied: key belongs to another space/
        );

        await assert.rejects(
            restoreImages("valid", "s1", docId, ["uploads/foreign-space/doc-auth/img.png"]),
            /Permission denied: key belongs to another space/
        );

        // Foreign Document key rejected
        await assert.rejects(
            permanentDeleteImages("valid", "s1", docId, ["uploads/s1/other-doc/img.png"]),
            /Permission denied: key belongs to another document/
        );

        await assert.rejects(
            softDeleteImages("valid", "s1", docId, ["uploads/s1/other-doc/img.png"]),
            /Permission denied: key belongs to another document/
        );

        await assert.rejects(
            restoreImages("valid", "s1", docId, ["uploads/s1/other-doc/img.png"]),
            /Permission denied: key belongs to another document/
        );

        // Key not in current authoritative content rejected
        await assert.rejects(
            permanentDeleteImages("valid", "s1", docId, ["uploads/s1/doc-auth/unmentioned.png"]),
            /Permission denied: key does not belong to this document/
        );

        await assert.rejects(
            softDeleteImages("valid", "s1", docId, ["uploads/s1/doc-auth/unmentioned.png"]),
            /Permission denied: key does not belong to this document/
        );

        await assert.rejects(
            restoreImages("valid", "s1", docId, ["uploads/s1/doc-auth/unmentioned.png"]),
            /Permission denied: key does not belong to this document/
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Upload Finalization & Save Retry Consistency (permanentizeImages)
// ═══════════════════════════════════════════════════════════════════════════════
describe("Upload Finalization & Save Retry Consistency", () => {
    beforeEach(() => { resetEnvironment(); });

    test("permanentizeImages: destination already exists on retry returns mapping so save can finalize", async () => {
        const docId = "doc-save";
        const tempKey = "temp/s1/doc-save/user-123/uuid-1.png";
        const uploadedKey = "uploads/s1/doc-save/uuid-1.png";
        const tempUrl = `https://test-bucket.s3.amazonaws.com/${tempKey}`;

        // Attempt 1 previously completed: uploadedKey exists in S3, tempKey was deleted
        s3Bucket.set(uploadedKey, "final-image-bytes");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc save retry",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
        });

        // Caller retries permanentizeImages with temp URL
        const mapping = await permanentizeImages("valid", "s1", docId, [tempUrl]);

        assert.strictEqual(
            mapping[tempUrl],
            `https://test-bucket.s3.amazonaws.com/${uploadedKey}`,
            "Mapping must return the permanent uploaded URL"
        );
    });

    test("permanentizeImages: copy succeeds, source delete fails: retry completes delete and returns mapping", async () => {
        const docId = "doc-copy-ok-del-fail";
        const tempKey = "temp/s1/doc-copy-ok-del-fail/user-123/uuid-split.png";
        const uploadedKey = "uploads/s1/doc-copy-ok-del-fail/uuid-split.png";
        const tempUrl = `https://test-bucket.s3.amazonaws.com/${tempKey}`;

        s3Bucket.set(tempKey, "split-image-bytes");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc split save",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
        });

        // Fail delete of temp key
        s3FailDeleteForKey = tempKey;

        // 1. Initial attempt fails at delete
        await assert.rejects(
            permanentizeImages("valid", "s1", docId, [tempUrl]),
            /One or more images could not be saved/
        );

        // State C: Both keys exist in S3
        assert.strictEqual(s3Bucket.has(uploadedKey), true, "Uploaded destination was created");
        assert.strictEqual(s3Bucket.has(tempKey), true, "Temp source still exists because delete failed");

        // 2. Retry attempt succeeds
        const mapping = await permanentizeImages("valid", "s1", docId, [tempUrl]);
        assert.strictEqual(mapping[tempUrl], `https://test-bucket.s3.amazonaws.com/${uploadedKey}`);

        // State B resolved: source deleted, destination remains
        assert.strictEqual(s3Bucket.has(uploadedKey), true);
        assert.strictEqual(s3Bucket.has(tempKey), false, "Temp source deleted on retry");
    });

    test("permanentizeImages: fails visibly when neither source nor destination exists", async () => {
        const docId = "doc-save-missing";
        const tempKey = "temp/s1/doc-save-missing/user-123/missing.png";
        const tempUrl = `https://test-bucket.s3.amazonaws.com/${tempKey}`;

        // Neither exists
        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc save missing",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
        });

        await assert.rejects(
            permanentizeImages("valid", "s1", docId, [tempUrl]),
            /One or more images could not be saved. Please try again./
        );
    });

    test("permanentizeImages: rejects when document is soft-deleted, claimed, or locked", async () => {
        const docId = "doc-locked";
        const tempKey = "temp/s1/doc-locked/user-123/uuid-1.png";
        const tempUrl = `https://test-bucket.s3.amazonaws.com/${tempKey}`;
        s3Bucket.set(tempKey, "temp-bytes");

        // 1. Soft-deleted document
        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Deleted Doc",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
        });

        await assert.rejects(
            permanentizeImages("valid", "s1", docId, [tempUrl]),
            /Cannot save images to a deleted or locked document/
        );

        // 2. Document with permanentDeletionClaim
        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Claimed Doc",
            deleted: false,
            deletedAt: null,
            permanentDeletionClaim: { claimedAt: new Date(), claimedBy: "user-123" },
            parentId: null,
            path: [],
        });

        await assert.rejects(
            permanentizeImages("valid", "s1", docId, [tempUrl]),
            /Cannot save images to a deleted or locked document/
        );

        // 3. Document with lifecycleClaim
        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Lifecycle Claimed Doc",
            deleted: false,
            deletedAt: null,
            lifecycleClaim: { claimedAt: new Date(), claimedBy: "user-123", operation: "soft_delete" },
            parentId: null,
            path: [],
        });

        await assert.rejects(
            permanentizeImages("valid", "s1", docId, [tempUrl]),
            /Cannot save images to a deleted or locked document/
        );
    });

    test("deleteImages: forced S3 delete failure halts operation, retains temporary object, and retry completes deletion", async () => {
        const docId = "doc-del-temp-fail";
        const tempKey = "temp/s1/doc-del-temp-fail/user-123/uuid-temp.png";
        const tempUrl = `https://test-bucket.s3.amazonaws.com/${tempKey}`;
        s3Bucket.set(tempKey, "temp-image-bytes");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc del temp fail",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
        });

        // 1. Force S3 delete failure for tempKey
        s3FailDeleteForKey = tempKey;

        await assert.rejects(
            deleteImages("valid", "s1", docId, [tempUrl]),
            /One or more temporary images could not be deleted/
        );

        // Object is NOT silently treated as deleted; it remains in S3
        assert.strictEqual(s3Bucket.has(tempKey), true, "Temp object must remain in S3 when deleteImages fails");

        // 2. Retry deleteImages succeeds and removes the object
        await deleteImages("valid", "s1", docId, [tempUrl]);
        assert.strictEqual(s3Bucket.has(tempKey), false, "Temp object must be removed on retry");
    });

    test("staged images: rejected save leaves object in uploads/ without false cleanup, enabling editor save retry or eventual collection on permanent delete", async () => {
        const docId = "doc-staged-audit";
        const tempKey = "temp/s1/doc-staged-audit/user-123/uuid-audit.png";
        const uploadedKey = "uploads/s1/doc-staged-audit/uuid-audit.png";
        const tempUrl = `https://test-bucket.s3.amazonaws.com/${tempKey}`;
        const uploadedUrl = `https://test-bucket.s3.amazonaws.com/${uploadedKey}`;

        s3Bucket.set(tempKey, "staged-image-bytes");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc Staged Audit",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
            revision: 1,
        });

        // 1. Editor stages image: permanentizeImages promotes temp/ to uploads/
        const mapping = await permanentizeImages("valid", "s1", docId, [tempUrl]);
        assert.strictEqual(mapping[tempUrl], uploadedUrl);
        assert.strictEqual(s3Bucket.has(uploadedKey), true, "Object exists in uploads/ in S3");
        assert.strictEqual(s3Bucket.has(tempKey), false, "Temp object was cleaned up by move");

        // 2. Passing uploaded URL to deleteImages is a no-op (deleteImages only handles temp/ keys)
        await deleteImages("valid", "s1", docId, [uploadedUrl]);
        assert.strictEqual(s3Bucket.has(uploadedKey), true, "deleteImages must not delete uploads/ object");

        // 3. Document in Firestore content was NEVER updated with this image (e.g. updateDocument rejected on baseRevision conflict)
        // Verify state: image exists in uploads/, but is unreferenced in content/main.

        // 4. Recovery Path A (Save Retry): If editor retries save after resolving conflict,
        // the object in uploads/ remains valid and ready to be referenced.
        assert.strictEqual(s3Bucket.has(uploadedKey), true);

        // 5. Recovery Path B (Permanent Deletion / Purge): If the draft is abandoned and the document
        // is permanently deleted, document-scoped listing cleans up the unreferenced staged object.
        await softDeleteDocumentAction("valid", "s1", docId, "delete-subtree");
        await permanentlyDeleteDocumentAction("valid", "s1", docId);
        assert.strictEqual(s3Bucket.has(uploadedKey), false, "Staged object in uploads/ is collected upon permanent document deletion");
    });
});

describe("S3 Lifecycle Consistency: Edit Save Removed Image Cleanup", () => {
    beforeEach(() => {
        resetEnvironment();
        // Setup standard space
        spacesStore.set("s1", {
            id: "s1",
            ownerId: "user-123",
            userIds: ["user-123"],
            isPublic: false,
        });
    });

    test("cleanupRemovedDocumentImages: successfully cleans up modern scoped image removed from document", async () => {
        const docId = "doc-edit-1";
        const scopedKey = `uploads/s1/${docId}/uuid-1.png`;
        s3Bucket.set(scopedKey, "image-content");

        // Document content saved without the image, pendingImageCleanup recorded
        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc Edit 1",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
            pendingImageCleanup: [scopedKey],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        const result = await cleanupRemovedDocumentImages("valid", "s1", docId);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.cleanedCount, 1);

        // S3 object deleted
        assert.strictEqual(s3Bucket.has(scopedKey), false, "S3 object should be deleted");

        // Firestore document: pendingImageCleanup cleared
        const updatedDoc = documentsStore.get(docId);
        assert.strictEqual(updatedDoc?.pendingImageCleanup, undefined, "pendingImageCleanup should be cleared");
    });

    test("cleanupRemovedDocumentImages: preserves images still referenced in authoritative content", async () => {
        const docId = "doc-edit-2";
        const keptKey = `uploads/s1/${docId}/kept.png`;
        const removedKey = `uploads/s1/${docId}/removed.png`;
        s3Bucket.set(keptKey, "kept-bytes");
        s3Bucket.set(removedKey, "removed-bytes");

        // Authoritative content still references keptKey
        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc Edit 2",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
            pendingImageCleanup: [removedKey],
        });
        contentStore.set(
            `${docId}/content/main`,
            createTipTapContentWithImages([`https://test-bucket.s3.amazonaws.com/${keptKey}`])
        );

        const result = await cleanupRemovedDocumentImages("valid", "s1", docId);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.cleanedCount, 1);

        // removedKey deleted from S3, keptKey preserved in S3
        assert.strictEqual(s3Bucket.has(removedKey), false, "Removed key should be deleted");
        assert.strictEqual(s3Bucket.has(keptKey), true, "Referenced key must be preserved");

        const updatedDoc = documentsStore.get(docId);
        assert.strictEqual(updatedDoc?.pendingImageCleanup, undefined, "pendingImageCleanup should be cleared");
    });

    test("cleanupRemovedDocumentImages: concurrent edit protection - preserves image if re-added or saved concurrently", async () => {
        const docId = "doc-edit-3";
        const concurrentKey = `uploads/s1/${docId}/concurrent.png`;
        s3Bucket.set(concurrentKey, "concurrent-bytes");

        // pendingImageCleanup has the key, BUT authoritative content in Firestore contains it (concurrent save)
        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc Edit 3",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
            pendingImageCleanup: [concurrentKey],
        });
        contentStore.set(
            `${docId}/content/main`,
            createTipTapContentWithImages([`https://test-bucket.s3.amazonaws.com/${concurrentKey}`])
        );

        const result = await cleanupRemovedDocumentImages("valid", "s1", docId);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.cleanedCount, 0);

        // Object must NOT be deleted because authoritative content still references it!
        assert.strictEqual(s3Bucket.has(concurrentKey), true, "Concurrent image must be preserved in S3");

        // pendingImageCleanup is cleared since the image is actively referenced
        const updatedDoc = documentsStore.get(docId);
        assert.strictEqual(updatedDoc?.pendingImageCleanup, undefined, "pendingImageCleanup should be cleared");
    });

    test("cleanupRemovedDocumentImages: S3 delete failure records retryable state in Firestore, retry succeeds", async () => {
        const docId = "doc-edit-4";
        const failKey = `uploads/s1/${docId}/fail.png`;
        const succeedKey = `uploads/s1/${docId}/succeed.png`;
        s3Bucket.set(failKey, "fail-bytes");
        s3Bucket.set(succeedKey, "succeed-bytes");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc Edit 4",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
            pendingImageCleanup: [failKey, succeedKey],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        // Inject failure on deleting failKey
        s3FailDeleteForKey = failKey;

        // 1. Initial attempt fails
        await assert.rejects(
            cleanupRemovedDocumentImages("valid", "s1", docId),
            /One or more removed images could not be deleted from storage. Please try again./
        );

        // Partial success: succeedKey was deleted from S3, failKey remains in S3
        assert.strictEqual(s3Bucket.has(succeedKey), false, "Succeed key should be deleted");
        assert.strictEqual(s3Bucket.has(failKey), true, "Failed key should remain in S3");

        // Firestore document: pendingImageCleanup updated to retain ONLY the failed key
        const docAfterFailure = documentsStore.get(docId);
        assert.deepStrictEqual(
            docAfterFailure?.pendingImageCleanup,
            [failKey],
            "pendingImageCleanup must retain failed keys for retry"
        );

        // 2. Retry attempt succeeds
        const retryResult = await cleanupRemovedDocumentImages("valid", "s1", docId);
        assert.strictEqual(retryResult.success, true);
        assert.strictEqual(retryResult.cleanedCount, 1);

        // failKey is now deleted from S3
        assert.strictEqual(s3Bucket.has(failKey), false, "Failed key deleted on retry");

        // Firestore document: pendingImageCleanup cleared
        const docAfterRetry = documentsStore.get(docId);
        assert.strictEqual(docAfterRetry?.pendingImageCleanup, undefined, "pendingImageCleanup cleared after retry");
    });

    test("cleanupRemovedDocumentImages: never deletes shared legacy keys removed from content", async () => {
        const docId = "doc-edit-5";
        const legacyKey = "uploads/shared-legacy-logo.png";
        s3Bucket.set(legacyKey, "legacy-bytes");

        // Document pendingImageCleanup includes the legacy key
        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc Edit 5",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
            pendingImageCleanup: [legacyKey],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        const result = await cleanupRemovedDocumentImages("valid", "s1", docId);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.cleanedCount, 0);

        // Legacy key must NEVER be deleted from S3!
        assert.strictEqual(s3Bucket.has(legacyKey), true, "Shared legacy key must never be deleted from S3");

        const updatedDoc = documentsStore.get(docId);
        assert.strictEqual(updatedDoc?.pendingImageCleanup, undefined, "pendingImageCleanup cleared");
    });

    test("cleanupRemovedDocumentImages: isolates foreign document and foreign space keys", async () => {
        const docId = "doc-edit-6";
        const foreignSpaceKey = "uploads/other-space/doc-edit-6/foreign1.png";
        const foreignDocKey = "uploads/s1/other-doc/foreign2.png";
        s3Bucket.set(foreignSpaceKey, "foreign-bytes-1");
        s3Bucket.set(foreignDocKey, "foreign-bytes-2");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc Edit 6",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
            pendingImageCleanup: [foreignSpaceKey, foreignDocKey],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        const result = await cleanupRemovedDocumentImages("valid", "s1", docId);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.cleanedCount, 0);

        // Neither foreign key must be touched in S3
        assert.strictEqual(s3Bucket.has(foreignSpaceKey), true, "Foreign space key preserved");
        assert.strictEqual(s3Bucket.has(foreignDocKey), true, "Foreign doc key preserved");

        const updatedDoc = documentsStore.get(docId);
        assert.strictEqual(updatedDoc?.pendingImageCleanup, undefined, "pendingImageCleanup cleared");
    });

    test("cleanupRemovedDocumentImages: rejects on soft-deleted or locked document", async () => {
        const docId = "doc-edit-locked";
        const key = `uploads/s1/${docId}/img.png`;
        s3Bucket.set(key, "bytes");

        // 1. Soft-deleted
        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Deleted Doc",
            deleted: true,
            deletedAt: new Date(),
            parentId: null,
            path: [],
            pendingImageCleanup: [key],
        });
        await assert.rejects(
            cleanupRemovedDocumentImages("valid", "s1", docId),
            /Cannot cleanup images on a deleted or locked document/
        );
        assert.strictEqual(s3Bucket.has(key), true);

        // 2. Claimed for permanent deletion
        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Claimed Doc",
            deleted: false,
            deletedAt: null,
            permanentDeletionClaim: { claimedAt: new Date(), claimedBy: "user-123" },
            parentId: null,
            path: [],
            pendingImageCleanup: [key],
        });
        await assert.rejects(
            cleanupRemovedDocumentImages("valid", "s1", docId),
            /Cannot cleanup images on a deleted or locked document/
        );
        assert.strictEqual(s3Bucket.has(key), true);
    });

    test("cleanupRemovedDocumentImages: empty or null pendingImageCleanup is a no-op", async () => {
        const docId = "doc-edit-empty";
        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Empty Pending Doc",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
            pendingImageCleanup: null,
        });

        const result = await cleanupRemovedDocumentImages("valid", "s1", docId);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.cleanedCount, 0);
    });

    test("cleanupRemovedDocumentImages: interleaving where concurrent save appends new pending image during S3 deletion (never loses newer cleanup work)", async () => {
        const docId = "doc-interleaving-1";
        const key1 = `uploads/s1/${docId}/img1.png`;
        const key2 = `uploads/s1/${docId}/img2.png`;
        s3Bucket.set(key1, "bytes1");
        s3Bucket.set(key2, "bytes2");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc Interleaving 1",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
            pendingImageCleanup: [key1],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        // When key1 is being deleted in S3, a concurrent save commits key2 into pendingImageCleanup
        s3OnDeleteHook = async (deletedKey) => {
            if (deletedKey === key1) {
                const current = documentsStore.get(docId)!;
                documentsStore.set(docId, {
                    ...current,
                    pendingImageCleanup: [...((current.pendingImageCleanup as string[]) || []), key2],
                });
            }
        };

        const result = await cleanupRemovedDocumentImages("valid", "s1", docId);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.cleanedCount, 2, "Both initial and concurrently appended keys should be cleaned");
        assert.strictEqual(result.remainingPendingCount, 0);

        // Both keys deleted from S3
        assert.strictEqual(s3Bucket.has(key1), false, "key1 deleted from S3");
        assert.strictEqual(s3Bucket.has(key2), false, "key2 deleted from S3");

        // Firestore document: pendingImageCleanup and claim cleared
        const updatedDoc = documentsStore.get(docId);
        assert.strictEqual(updatedDoc?.pendingImageCleanup, undefined, "pendingImageCleanup fully cleared");
        assert.strictEqual(updatedDoc?.imageCleanupClaim, undefined, "imageCleanupClaim cleared");
    });

    test("cleanupRemovedDocumentImages: concurrent save append preserves newer key when second key deletion fails, retry succeeds", async () => {
        const docId = "doc-interleaving-fail";
        const key1 = `uploads/s1/${docId}/img1.png`;
        const key2 = `uploads/s1/${docId}/img2.png`;
        s3Bucket.set(key1, "bytes1");
        s3Bucket.set(key2, "bytes2");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc Interleaving Fail",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
            pendingImageCleanup: [key1],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        // Concurrently append key2 during key1 deletion, and simulate key2 S3 failure
        s3OnDeleteHook = async (deletedKey) => {
            if (deletedKey === key1) {
                const current = documentsStore.get(docId)!;
                documentsStore.set(docId, {
                    ...current,
                    pendingImageCleanup: [...((current.pendingImageCleanup as string[]) || []), key2],
                });
                s3FailDeleteForKey = key2;
            }
        };

        await assert.rejects(
            cleanupRemovedDocumentImages("valid", "s1", docId),
            /One or more removed images could not be deleted from storage. Please try again./
        );

        // key1 was deleted from S3, key2 remains in S3
        assert.strictEqual(s3Bucket.has(key1), false, "key1 deleted from S3");
        assert.strictEqual(s3Bucket.has(key2), true, "key2 remains in S3");

        // Firestore document: key1 removed, key2 retained in pendingImageCleanup!
        const docAfterFailure = documentsStore.get(docId);
        assert.deepStrictEqual(
            docAfterFailure?.pendingImageCleanup,
            [key2],
            "Newer cleanup work (key2) must NEVER be lost"
        );

        // Retry successfully deletes key2 and clears pendingImageCleanup
        const retryResult = await cleanupRemovedDocumentImages("valid", "s1", docId);
        assert.strictEqual(retryResult.success, true);
        assert.strictEqual(retryResult.cleanedCount, 1);
        assert.strictEqual(s3Bucket.has(key2), false, "key2 deleted on retry");

        const docAfterRetry = documentsStore.get(docId);
        assert.strictEqual(docAfterRetry?.pendingImageCleanup, undefined, "pendingImageCleanup cleared after retry");
    });

    test("cleanupRemovedDocumentImages: backs off when another cleanup claim is active (<30s)", async () => {
        const docId = "doc-active-claim";
        const key = `uploads/s1/${docId}/img.png`;
        s3Bucket.set(key, "bytes");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc Active Claim",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
            pendingImageCleanup: [key],
            imageCleanupClaim: {
                claimId: "other-active-claim",
                keys: [key],
                claimedAt: new Date(), // Active claim (< 30s)
            },
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        const result = await cleanupRemovedDocumentImages("valid", "s1", docId);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.cleanedCount, 0, "Must not perform deletions while another claim is active");
        assert.strictEqual(result.remainingPendingCount, 1, "Reports pending count while claim is active");

        // S3 object preserved
        assert.strictEqual(s3Bucket.has(key), true, "Object preserved in S3");

        // Existing claim untouched
        const docSnap = documentsStore.get(docId);
        assert.strictEqual(
            (docSnap?.imageCleanupClaim as { claimId?: string })?.claimId,
            "other-active-claim"
        );
    });

    test("cleanupRemovedDocumentImages: overrides and recovers when prior cleanup claim is expired (>30s)", async () => {
        const docId = "doc-expired-claim";
        const key = `uploads/s1/${docId}/img.png`;
        s3Bucket.set(key, "bytes");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Doc Expired Claim",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
            pendingImageCleanup: [key],
            imageCleanupClaim: {
                claimId: "expired-claim-id",
                keys: [key],
                claimedAt: new Date(Date.now() - 40_000), // Expired claim (40s ago > 30s TTL)
            },
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        const result = await cleanupRemovedDocumentImages("valid", "s1", docId);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.cleanedCount, 1, "Deletes key after claim expiration");
        assert.strictEqual(result.remainingPendingCount, 0);

        // Key deleted from S3
        assert.strictEqual(s3Bucket.has(key), false, "Object deleted from S3");

        // Expired claim and pendingImageCleanup cleared
        const updatedDoc = documentsStore.get(docId);
        assert.strictEqual(updatedDoc?.pendingImageCleanup, undefined);
        assert.strictEqual(updatedDoc?.imageCleanupClaim, undefined);
    });

    test("cleanupRemovedDocumentImages: recovery fencing - stale worker cannot clear or overwrite newer worker's claim or pending keys", async () => {
        const docId = "doc-recovery-fencing";
        const key1 = `uploads/s1/${docId}/key1.png`;
        const key2 = `uploads/s1/${docId}/key2.png`;
        s3Bucket.set(key1, "bytes1");
        s3Bucket.set(key2, "bytes2");

        // Worker 1 starts with key1
        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Fencing Doc",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
            pendingImageCleanup: [key1],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        // When Worker 1 is in Phase 2 deleting key1, Worker 2 intervenes via cleanup recovery
        // and establishes a newer claim with newer pending keys
        s3OnDeleteHook = async (deletedKey) => {
            if (deletedKey === key1) {
                const current = documentsStore.get(docId)!;
                documentsStore.set(docId, {
                    ...current,
                    pendingImageCleanup: [key1, key2],
                    imageCleanupClaim: {
                        claimId: "claim-worker-2",
                        keys: [key1, key2],
                        claimedAt: new Date(),
                    },
                });
            }
        };

        // Worker 1 executes
        const result1 = await cleanupRemovedDocumentImages("valid", "s1", docId);
        assert.strictEqual(result1.success, true);

        // key1 was deleted from S3 by Worker 1
        assert.strictEqual(s3Bucket.has(key1), false, "key1 deleted from S3");

        // CRITICAL INVARIANT: Worker 1 was fenced out in Phase 3!
        // Worker 2's claim must NOT have been cleared or overwritten!
        const docSnap = documentsStore.get(docId);
        assert.strictEqual(
            (docSnap?.imageCleanupClaim as { claimId?: string })?.claimId,
            "claim-worker-2",
            "Stale Worker 1 must NOT delete Worker 2's claim"
        );
        assert.deepStrictEqual(
            docSnap?.pendingImageCleanup,
            [key1, key2],
            "Stale Worker 1 must NOT overwrite Worker 2's pending keys"
        );

        // Now Worker 2's claim expires and recovery cleanly completes the remaining work (key2)
        documentsStore.set(docId, {
            ...docSnap!,
            imageCleanupClaim: {
                claimId: "claim-worker-2",
                keys: [key1, key2],
                claimedAt: new Date(Date.now() - 40_000), // > 30s TTL
            },
        });
        s3OnDeleteHook = null;

        const result2 = await cleanupRemovedDocumentImages("valid", "s1", docId);
        assert.strictEqual(result2.success, true);
        assert.strictEqual(result2.cleanedCount, 2); // key1 (no-op in S3) + key2
        assert.strictEqual(result2.remainingPendingCount, 0);

        // Both keys deleted from S3, claim and pendingImageCleanup cleanly cleared
        assert.strictEqual(s3Bucket.has(key2), false, "key2 deleted from S3");
        const docFinal = documentsStore.get(docId);
        assert.strictEqual(docFinal?.pendingImageCleanup, undefined, "pendingImageCleanup fully cleared");
        assert.strictEqual(docFinal?.imageCleanupClaim, undefined, "imageCleanupClaim fully cleared");
    });

    test("cleanupRemovedDocumentImages: records succeeded keys in bounded retiredImageKeys upon Phase 3 completion", async () => {
        const docId = "doc-retired-test";
        const keyA = `uploads/s1/${docId}/img-a.png`;
        s3Bucket.set(keyA, "bytes");

        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Retired Doc",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
            pendingImageCleanup: [keyA],
        });
        contentStore.set(`${docId}/content/main`, createTipTapContentWithImages([]));

        const result = await cleanupRemovedDocumentImages("valid", "s1", docId);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.cleanedCount, 1);

        // Object deleted from S3
        assert.strictEqual(s3Bucket.has(keyA), false);

        // Firestore document: pendingImageCleanup cleared, retiredImageKeys contains canonical key
        const docAfter = documentsStore.get(docId);
        assert.strictEqual(docAfter?.pendingImageCleanup, undefined);
        assert.deepStrictEqual(docAfter?.retiredImageKeys, [`s1/${docId}/img-a.png`]);
    });

    test("cleanupRemovedDocumentImages: recovery worker cannot delete an object after the protocol permits its reference again", async () => {
        const docId = "doc-permitted-test";
        const permittedKey = `uploads/s1/${docId}/permitted-image.png`;
        s3Bucket.set(permittedKey, "permitted-bytes");

        // Document has permittedKey in authoritative content, but pendingImageCleanup contains it
        documentsStore.set(docId, {
            id: docId,
            spaceId: "s1",
            title: "Permitted Doc",
            deleted: false,
            deletedAt: null,
            parentId: null,
            path: [],
            pendingImageCleanup: [permittedKey],
        });
        // Authoritative content contains the image (protocol permitted reference)
        contentStore.set(
            `${docId}/content/main`,
            createTipTapContentWithImages([`https://test-bucket.s3.amazonaws.com/${permittedKey}`])
        );

        // Recovery worker runs cleanup
        const result = await cleanupRemovedDocumentImages("valid", "s1", docId);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.cleanedCount, 0, "Recovery worker must NOT clean active image");

        // Object MUST remain in S3
        assert.strictEqual(s3Bucket.has(permittedKey), true, "Permitted object must never be deleted by recovery worker");

        // pendingImageCleanup is cleared
        const docAfter = documentsStore.get(docId);
        assert.strictEqual(docAfter?.pendingImageCleanup, undefined);
    });
});
