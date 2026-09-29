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

// Mock server-only so importing server modules works in test environment
mock.module("server-only", {
    exports: {},
});

// ── document-authorization mocks ───────────────────────────────────────────────
const verifyIdTokenMock = mock.fn();
const authorizeSpaceContributorMock = mock.fn();
const getAndVerifyDocumentMock = mock.fn();
const getDocumentContentUrlsMock = mock.fn();

mock.module("../server/document-authorization", {
    exports: {
        verifyIdToken: verifyIdTokenMock,
        authorizeSpaceContributor: authorizeSpaceContributorMock,
        getAndVerifyDocument: getAndVerifyDocumentMock,
        getDocumentContentUrls: getDocumentContentUrlsMock,
        isModernDocumentScopedKey: mock.fn(),
    },
});

// ── S3 actions mock ────────────────────────────────────────────────────────────
const permanentDeleteImagesMock = mock.fn();
const restoreImagesMock = mock.fn();
const softDeleteImagesMock = mock.fn();
const getPresignedGetUrlMock = mock.fn();
const cleanupRemovedDocumentImagesMock = mock.fn();

mock.module("../actions/s3", {
    exports: {
        permanentDeleteImages: permanentDeleteImagesMock,
        restoreImages: restoreImagesMock,
        softDeleteImages: softDeleteImagesMock,
        getPresignedGetUrl: getPresignedGetUrlMock,
        cleanupRemovedDocumentImages: cleanupRemovedDocumentImagesMock,
    },
});

// ── Client Firestore / Firebase mocks (for restoreDocument) ───────────────────
const clientGetDocMock = mock.fn();
const clientUpdateDocMock = mock.fn();
const clientDocMock = mock.fn((_db: unknown, col: string, id: string) => ({
    collection: col,
    id,
    path: `${col}/${id}`,
}));

mock.module("@/lib/firebase", {
    exports: {
        db: {},
        auth: {
            currentUser: {
                getIdToken: mock.fn(async () => "valid-token"),
            },
        },
    },
});

mock.module("firebase/firestore", {
    exports: {
        doc: clientDocMock,
        getDoc: clientGetDocMock,
        updateDoc: clientUpdateDocMock,
        collection: mock.fn(),
        getDocs: mock.fn(),
        runTransaction: mock.fn(),
        serverTimestamp: mock.fn(),
        query: mock.fn(),
        orderBy: mock.fn(),
        where: mock.fn(),
        writeBatch: mock.fn(),
        DocumentSnapshot: class {},
        FirestoreError: class {},
        deleteField: mock.fn(() => ({ _type: "delete" })),
    },
});

// ── firebase-admin mocks ───────────────────────────────────────────────────────
const batchDeleteMock = mock.fn();
const batchUpdateMock = mock.fn();
const batchCommitMock = mock.fn();
const descendantsGetMock = mock.fn();
const transactionGetMock = mock.fn();
const transactionUpdateMock = mock.fn();
const runTransactionMock = mock.fn();

const deletedRefs: string[] = [];
let pendingBatchUpdates: Array<{ ref: { id: string; path: string }; data: Record<string, unknown> }> = [];
let pendingBatchDeletes: string[] = [];
const spacesStore = new Map<string, Record<string, unknown>>();
const documentsStore = new Map<string, Record<string, unknown>>();

const fakeBatch = {
    delete: mock.fn((ref: { path: string }) => {
        deletedRefs.push(ref.path);
        pendingBatchDeletes.push(ref.path);
        batchDeleteMock(ref);
    }),
    update: mock.fn((ref: { id: string; path: string }, data: Record<string, unknown>) => {
        batchUpdateMock(ref, data);
        pendingBatchUpdates.push({ ref, data });
    }),
    commit: mock.fn(async () => {
        try {
            await batchCommitMock();
            for (const refPath of pendingBatchDeletes) {
                if (refPath.startsWith("documents/")) {
                    const parts = refPath.split("/");
                    if (parts.length === 2) {
                        documentsStore.delete(parts[1]);
                    }
                }
            }
            for (const { ref, data } of pendingBatchUpdates) {
                if (ref.path.startsWith("documents/")) {
                    const existing = documentsStore.get(ref.id);
                    if (existing) {
                        const updated = { ...existing };
                        for (const [k, v] of Object.entries(data)) {
                            if (v && typeof v === "object" && "elements" in v && Array.isArray((v as { elements: unknown[] }).elements)) {
                                const toRemove = new Set((v as { elements: unknown[] }).elements);
                                const cur = Array.isArray(updated[k]) ? (updated[k] as unknown[]) : [];
                                updated[k] = cur.filter((item) => !toRemove.has(item));
                            } else {
                                updated[k] = v;
                            }
                        }
                        documentsStore.set(ref.id, updated);
                    }
                }
            }
        } finally {
            pendingBatchUpdates = [];
            pendingBatchDeletes = [];
        }
    }),
};

const fakeTransaction = {
    get: mock.fn(async (ref: { id: string; path: string }) => {
        transactionGetMock(ref);
        if (ref.path.startsWith("spaces/")) {
            const data = spacesStore.get(ref.id);
            if (data === undefined) {
                return { exists: false, data: () => undefined };
            }
            return { exists: true, data: () => ({ ...data }) };
        }
        if (ref.path.startsWith("documents/")) {
            const data = documentsStore.get(ref.id);
            if (data === undefined) {
                return { exists: false, data: () => undefined };
            }
            return { exists: true, data: () => ({ ...data }) };
        }
        return { exists: false, data: () => undefined };
    }),
    update: mock.fn((ref: { id: string; path: string }, data: Record<string, unknown>) => {
        transactionUpdateMock(ref, data);
        if (ref.path.startsWith("documents/")) {
            const existing = documentsStore.get(ref.id);
            if (existing) {
                documentsStore.set(ref.id, { ...existing, ...data });
            }
        }
    }),
};

let queryGetFailOnCallNumber: number | null = null;
let queryGetCallCount = 0;
let onQueryGetHook: ((callCount: number) => void) | null = null;
let disablePaginationMock = false;

function createDocumentsQuery(options: {
    field?: string;
    op?: string;
    value?: unknown;
    limitCount?: number;
    startAfterId?: string;
} = {}) {
    if (disablePaginationMock) {
        return {
            get: mock.fn(async () => ({ empty: true, docs: [] })),
        };
    }
    const queryObj = {
        orderBy: mock.fn(() => queryObj),
        limit: mock.fn((n: number) => createDocumentsQuery({ ...options, limitCount: n })),
        startAfter: mock.fn((snap: { id: string } | string) => {
            const startId = typeof snap === "string" ? snap : snap?.id;
            return createDocumentsQuery({ ...options, startAfterId: startId });
        }),
        get: mock.fn(async () => {
            queryGetCallCount++;
            if (onQueryGetHook) {
                onQueryGetHook(queryGetCallCount);
            }
            if (queryGetFailOnCallNumber !== null && queryGetCallCount === queryGetFailOnCallNumber) {
                queryGetFailOnCallNumber = null;
                throw new Error("Firestore backlink query page failed");
            }

            let docs = Array.from(documentsStore.values());
            if (options.field && options.op === "array-contains") {
                docs = docs.filter((d) => {
                    const arr = d[options.field!];
                    return Array.isArray(arr) && arr.includes(options.value);
                });
            }
            docs.sort((a, b) => String(a.id).localeCompare(String(b.id)));

            if (options.startAfterId) {
                const idx = docs.findIndex((d) => d.id === options.startAfterId);
                if (idx !== -1) {
                    docs = docs.slice(idx + 1);
                }
            }

            if (typeof options.limitCount === "number") {
                docs = docs.slice(0, options.limitCount);
            }

            return {
                empty: docs.length === 0,
                docs: docs.map((docData) => ({
                    id: String(docData.id),
                    exists: true,
                    data: () => ({ ...docData }),
                })),
            };
        }),
    };
    return queryObj;
}

const fakeFirestore = {
    collection: mock.fn((colName: string) => ({
        where: mock.fn((field?: string, op?: string, value?: unknown) => {
            if (field === "path") {
                return {
                    limit: mock.fn(() => ({
                        get: descendantsGetMock,
                    })),
                    get: descendantsGetMock,
                };
            }
            if (colName === "documents") {
                return createDocumentsQuery({ field, op, value });
            }
            return {
                limit: mock.fn(() => ({
                    get: descendantsGetMock,
                })),
            };
        }),
        doc: mock.fn((docId: string) => ({
            id: docId,
            path: `${colName}/${docId}`,
            get: mock.fn(async () => {
                if (colName === "spaces") {
                    const data = spacesStore.get(docId);
                    if (data === undefined) {
                        return { id: docId, exists: false, data: () => undefined };
                    }
                    return { id: docId, exists: true, data: () => ({ ...data }) };
                }
                if (colName === "documents") {
                    const data = documentsStore.get(docId);
                    if (data === undefined) {
                        return { id: docId, exists: false, data: () => undefined };
                    }
                    return { id: docId, exists: true, data: () => ({ ...data }) };
                }
                return { id: docId, exists: false, data: () => undefined };
            }),
            collection: mock.fn((subName: string) => ({
                doc: mock.fn((subId: string) => ({
                    id: subId,
                    path: `${colName}/${docId}/${subName}/${subId}`,
                })),
            })),
        })),
    })),
    batch: mock.fn(() => fakeBatch),
    runTransaction: mock.fn(async (cb: (txn: typeof fakeTransaction) => Promise<unknown>) => {
        runTransactionMock(cb);
        return await cb(fakeTransaction);
    }),
};

mock.module("../server/firebase-admin", {
    exports: {
        getAdminFirestore: mock.fn(() => fakeFirestore),
        getAdminAuth: mock.fn(),
    },
});

// Import actions under test after mocks are registered
const { permanentlyDeleteDocumentAction } = await import("../actions/document-permanent-delete");
const { restoreDocument } = await import("../actions/document");

// ── Helpers ────────────────────────────────────────────────────────────────────
function resetAllMocks() {
    verifyIdTokenMock.mock.resetCalls();
    authorizeSpaceContributorMock.mock.resetCalls();
    getAndVerifyDocumentMock.mock.resetCalls();
    getDocumentContentUrlsMock.mock.resetCalls();
    permanentDeleteImagesMock.mock.resetCalls();
    restoreImagesMock.mock.resetCalls();
    softDeleteImagesMock.mock.resetCalls();
    getPresignedGetUrlMock.mock.resetCalls();
    batchDeleteMock.mock.resetCalls();
    batchUpdateMock.mock.resetCalls();
    batchCommitMock.mock.resetCalls();
    descendantsGetMock.mock.resetCalls();
    transactionGetMock.mock.resetCalls();
    transactionUpdateMock.mock.resetCalls();
    runTransactionMock.mock.resetCalls();
    fakeFirestore.batch.mock.resetCalls();
    fakeFirestore.runTransaction.mock.resetCalls();
    fakeTransaction.get.mock.resetCalls();
    fakeTransaction.update.mock.resetCalls();
    clientGetDocMock.mock.resetCalls();
    clientUpdateDocMock.mock.resetCalls();
    deletedRefs.length = 0;
    pendingBatchUpdates.length = 0;
    pendingBatchDeletes.length = 0;
    queryGetFailOnCallNumber = null;
    queryGetCallCount = 0;
    onQueryGetHook = null;
    disablePaginationMock = false;
}

function setDefaultSuccessMocks() {
    verifyIdTokenMock.mock.mockImplementation(async (token: string) => {
        if (!token) throw new Error("Missing ID token");
        if (token === "valid") return { uid: "user-123" };
        throw new Error("Invalid or expired ID token");
    });

    authorizeSpaceContributorMock.mock.mockImplementation(async (uid: string, spaceId: string) => {
        if (spaceId === "missing-space") throw new Error("Space not found");
        if (spaceId === "soft-deleted-space") throw new Error("Space is deleted");
        if (uid === "unauthorized-user") throw new Error("Permission denied: not a space contributor");
        if (uid === "removed-member") throw new Error("Permission denied: not a space contributor");
        return {
            id: spaceId,
            name: "Test Space",
            ownerId: "user-123",
            userIds: ["user-123"],
            deletedAt: null,
        };
    });

    spacesStore.clear();
    documentsStore.clear();

    spacesStore.set("s1", {
        id: "s1",
        name: "Test Space",
        ownerId: "user-123",
        userIds: ["user-123"],
        deletedAt: null,
    });

    spacesStore.set("soft-deleted-space", {
        id: "soft-deleted-space",
        name: "Deleted Space",
        ownerId: "user-123",
        userIds: ["user-123"],
        deletedAt: { seconds: 12345, nanoseconds: 0 },
    });

    documentsStore.set("d1", {
        id: "d1",
        spaceId: "s1",
        title: "Soft Deleted Document",
        deleted: true,
        deletedAt: { seconds: 12345, nanoseconds: 0 },
        permanentDeletionClaim: null,
    });

    documentsStore.set("active-doc", {
        id: "active-doc",
        spaceId: "s1",
        title: "Active Document",
        deleted: false,
        deletedAt: null,
        permanentDeletionClaim: null,
    });

    documentsStore.set("cross-space-doc", {
        id: "cross-space-doc",
        spaceId: "other-space",
        title: "Cross Space Document",
        deleted: true,
        deletedAt: { seconds: 12345, nanoseconds: 0 },
        permanentDeletionClaim: null,
    });

    getAndVerifyDocumentMock.mock.mockImplementation(async (spaceId: string, docId: string) => {
        if (docId === "missing-doc") throw new Error("Document not found");
        if (docId === "cross-space-doc") throw new Error("Document does not belong to the specified space");
        if (docId === "active-doc") {
            return {
                id: docId,
                spaceId,
                title: "Active Document",
                deleted: false,
                deletedAt: null,
            };
        }
        return {
            id: docId,
            spaceId,
            title: "Soft Deleted Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
        };
    });

    // Default: no descendants
    descendantsGetMock.mock.mockImplementation(async () => ({
        empty: true,
        docs: [],
    }));

    // Default: no images
    getDocumentContentUrlsMock.mock.mockImplementation(async () => []);

    // Default S3 success
    permanentDeleteImagesMock.mock.mockImplementation(async () => {});

    // Default batch commit success
    batchCommitMock.mock.mockImplementation(async () => {});

    // Default client restore mocks
    clientGetDocMock.mock.mockImplementation(async (ref: { id: string }) => {
        const docData = documentsStore.get(ref.id) || {
            id: ref.id,
            spaceId: "s1",
            title: "Soft Deleted Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
        };
        return {
            exists: () => true,
            data: () => ({ ...docData }),
        };
    });
    clientUpdateDocMock.mock.mockImplementation(async () => {});
    restoreImagesMock.mock.mockImplementation(async () => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// Server/Action Authorization Tests
// ═══════════════════════════════════════════════════════════════════════════════
describe("Server/action authorization", () => {
    beforeEach(() => {
        resetAllMocks();
        setDefaultSuccessMocks();
    });

    test("missing token rejected — no AWS or Firestore delete", async () => {
        await assert.rejects(
            permanentlyDeleteDocumentAction(undefined, "s1", "d1"),
            /Missing ID token/
        );
        assert.strictEqual(permanentDeleteImagesMock.mock.callCount(), 0);
        assert.strictEqual(batchDeleteMock.mock.callCount(), 0);
        assert.strictEqual(batchCommitMock.mock.callCount(), 0);
    });

    test("invalid token rejected — no AWS or Firestore delete", async () => {
        await assert.rejects(
            permanentlyDeleteDocumentAction("invalid-token", "s1", "d1"),
            /Invalid or expired ID token/
        );
        assert.strictEqual(permanentDeleteImagesMock.mock.callCount(), 0);
        assert.strictEqual(batchDeleteMock.mock.callCount(), 0);
        assert.strictEqual(batchCommitMock.mock.callCount(), 0);
    });

    test("missing Space rejected — no AWS or Firestore delete", async () => {
        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "missing-space", "d1"),
            /Space not found/
        );
        assert.strictEqual(permanentDeleteImagesMock.mock.callCount(), 0);
        assert.strictEqual(batchDeleteMock.mock.callCount(), 0);
        assert.strictEqual(batchCommitMock.mock.callCount(), 0);
    });

    test("missing document rejected — no AWS or Firestore delete", async () => {
        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "missing-doc"),
            /Document not found/
        );
        assert.strictEqual(permanentDeleteImagesMock.mock.callCount(), 0);
        assert.strictEqual(batchDeleteMock.mock.callCount(), 0);
        assert.strictEqual(batchCommitMock.mock.callCount(), 0);
    });

    test("cross-Space document rejected — no AWS or Firestore delete", async () => {
        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "cross-space-doc"),
            /Document does not belong to the specified space/
        );
        assert.strictEqual(permanentDeleteImagesMock.mock.callCount(), 0);
        assert.strictEqual(batchDeleteMock.mock.callCount(), 0);
        assert.strictEqual(batchCommitMock.mock.callCount(), 0);
    });

    test("unauthorized non-member rejected — no AWS or Firestore delete", async () => {
        verifyIdTokenMock.mock.mockImplementation(async () => ({ uid: "unauthorized-user" }));
        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /Permission denied/
        );
        assert.strictEqual(permanentDeleteImagesMock.mock.callCount(), 0);
        assert.strictEqual(batchDeleteMock.mock.callCount(), 0);
        assert.strictEqual(batchCommitMock.mock.callCount(), 0);
    });

    test("removed member rejected — no AWS or Firestore delete", async () => {
        verifyIdTokenMock.mock.mockImplementation(async () => ({ uid: "removed-member" }));
        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /Permission denied/
        );
        assert.strictEqual(permanentDeleteImagesMock.mock.callCount(), 0);
        assert.strictEqual(batchDeleteMock.mock.callCount(), 0);
        assert.strictEqual(batchCommitMock.mock.callCount(), 0);
    });

    test("active document rejected — no AWS or Firestore delete", async () => {
        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "active-doc"),
            /Cannot permanently delete an active document/
        );
        assert.strictEqual(permanentDeleteImagesMock.mock.callCount(), 0);
        assert.strictEqual(batchDeleteMock.mock.callCount(), 0);
        assert.strictEqual(batchCommitMock.mock.callCount(), 0);
    });

    test("soft-deleted Space rejected from single-document flow — no AWS or Firestore delete", async () => {
        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "soft-deleted-space", "d1"),
            /Cannot permanently delete document from a soft-deleted space. Use space purge./
        );
        assert.strictEqual(permanentDeleteImagesMock.mock.callCount(), 0);
        assert.strictEqual(batchDeleteMock.mock.callCount(), 0);
        assert.strictEqual(batchCommitMock.mock.callCount(), 0);
    });

    test("soft-deleted document with active descendant rejected — no AWS or Firestore delete", async () => {
        descendantsGetMock.mock.mockImplementation(async () => ({
            empty: false,
            docs: [{ id: "active-child", data: () => ({ deleted: false }) }],
        }));

        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /This document still contains subdocuments. Permanently delete the subdocuments first./
        );
        assert.strictEqual(permanentDeleteImagesMock.mock.callCount(), 0);
        assert.strictEqual(batchDeleteMock.mock.callCount(), 0);
        assert.strictEqual(batchCommitMock.mock.callCount(), 0);
    });

    test("soft-deleted document with deleted descendant rejected — no AWS or Firestore delete", async () => {
        descendantsGetMock.mock.mockImplementation(async () => ({
            empty: false,
            docs: [{ id: "deleted-child", data: () => ({ deleted: true, deletedAt: {} }) }],
        }));

        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /This document still contains subdocuments. Permanently delete the subdocuments first./
        );
        assert.strictEqual(permanentDeleteImagesMock.mock.callCount(), 0);
        assert.strictEqual(batchDeleteMock.mock.callCount(), 0);
        assert.strictEqual(batchCommitMock.mock.callCount(), 0);
    });

    test("soft-deleted leaf document accepted — commits batch", async () => {
        const result = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(result, { success: true });
        assert.strictEqual(batchCommitMock.mock.callCount(), 1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Destructive Ordering Tests
// ═══════════════════════════════════════════════════════════════════════════════
describe("Destructive ordering", () => {
    beforeEach(() => {
        resetAllMocks();
        setDefaultSuccessMocks();
    });

    test("authentication finishes before AWS access", async () => {
        verifyIdTokenMock.mock.mockImplementation(async () => {
            throw new Error("Invalid or expired ID token");
        });
        getDocumentContentUrlsMock.mock.mockImplementation(async () => ["uploads/s1/d1/img.png"]);

        await assert.rejects(
            permanentlyDeleteDocumentAction("bad-token", "s1", "d1"),
            /Invalid or expired ID token/
        );
        assert.strictEqual(permanentDeleteImagesMock.mock.callCount(), 0);
    });

    test("descendant validation finishes before AWS access", async () => {
        descendantsGetMock.mock.mockImplementation(async () => ({
            empty: false,
            docs: [{ id: "child-doc" }],
        }));
        getDocumentContentUrlsMock.mock.mockImplementation(async () => ["uploads/s1/d1/img.png"]);

        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /This document still contains subdocuments. Permanently delete the subdocuments first./
        );
        assert.strictEqual(permanentDeleteImagesMock.mock.callCount(), 0);
        assert.strictEqual(batchCommitMock.mock.callCount(), 0);
    });

    test("S3 cleanup failure blocks content and metadata deletion", async () => {
        getDocumentContentUrlsMock.mock.mockImplementation(async () => ["uploads/s1/d1/img.png"]);
        permanentDeleteImagesMock.mock.mockImplementation(async () => {
            throw new Error("One or more images could not be permanently deleted. Please try again.");
        });

        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /One or more images could not be permanently deleted/
        );
        assert.strictEqual(permanentDeleteImagesMock.mock.callCount(), 1);
        assert.strictEqual(batchDeleteMock.mock.callCount(), 0);
        assert.strictEqual(batchCommitMock.mock.callCount(), 0);
    });

    test("Firestore content and metadata deletion use one batch", async () => {
        getDocumentContentUrlsMock.mock.mockImplementation(async () => ["uploads/s1/d1/img.png"]);

        await permanentlyDeleteDocumentAction("valid", "s1", "d1");

        assert.strictEqual(fakeFirestore.batch.mock.callCount(), 1);
        assert.strictEqual(batchDeleteMock.mock.callCount(), 2);
        assert.strictEqual(batchCommitMock.mock.callCount(), 1);

        // Both content and document root are targeted in the batch
        assert.ok(deletedRefs.includes("documents/d1/content/main"));
        assert.ok(deletedRefs.includes("documents/d1"));
    });

    test("successful deletion removes both content and metadata", async () => {
        await permanentlyDeleteDocumentAction("valid", "s1", "d1");

        assert.strictEqual(batchCommitMock.mock.callCount(), 1);
        assert.strictEqual(deletedRefs.length, 2);
        assert.deepEqual(deletedRefs, [
            "documents/d1/content/main",
            "documents/d1",
        ]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S3 Ownership Tests
// ═══════════════════════════════════════════════════════════════════════════════
describe("S3 ownership", () => {
    beforeEach(() => {
        resetAllMocks();
        setDefaultSuccessMocks();
    });

    test("only trusted document-owned keys from Firestore content are cleaned up", async () => {
        getDocumentContentUrlsMock.mock.mockImplementation(async () => [
            "uploads/s1/d1/photo1.png",
            "uploads/s1/d1/photo2.png",
        ]);

        await permanentlyDeleteDocumentAction("valid", "s1", "d1");

        assert.strictEqual(permanentDeleteImagesMock.mock.callCount(), 1);
        const [tokenArg, spaceArg, docArg, urlsArg] = permanentDeleteImagesMock.mock.calls[0].arguments;
        assert.strictEqual(tokenArg, "valid");
        assert.strictEqual(spaceArg, "s1");
        assert.strictEqual(docArg, "d1");
        assert.deepEqual(urlsArg, [
            "uploads/s1/d1/photo1.png",
            "uploads/s1/d1/photo2.png",
        ]);
    });

    test("caller-controlled arguments cannot supply keys to expand deletion scope", async () => {
        // The action only accepts (idToken, spaceId, docId) — no urls argument exists on caller interface.
        // Trusted content has 0 images:
        getDocumentContentUrlsMock.mock.mockImplementation(async () => []);

        await permanentlyDeleteDocumentAction("valid", "s1", "d1");

        assert.strictEqual(permanentDeleteImagesMock.mock.callCount(), 1);
        const [tokenArg, spaceArg, docArg, urlsArg] = permanentDeleteImagesMock.mock.calls[0].arguments;
        assert.strictEqual(tokenArg, "valid");
        assert.strictEqual(spaceArg, "s1");
        assert.strictEqual(docArg, "d1");
        assert.deepEqual(urlsArg, []);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Persistent Claim and Concurrency Protection Tests
// ═══════════════════════════════════════════════════════════════════════════════
describe("Persistent claim and concurrency protection", () => {
    beforeEach(() => {
        resetAllMocks();
        setDefaultSuccessMocks();
    });

    test("sets permanent-deletion claim with caller uid during deletion", async () => {
        await permanentlyDeleteDocumentAction("valid", "s1", "d1");

        assert.ok(fakeFirestore.runTransaction.mock.callCount() >= 1);
        assert.ok(transactionUpdateMock.mock.callCount() >= 1);
        const [refArg, dataArg] = transactionUpdateMock.mock.calls[0].arguments;
        assert.strictEqual(refArg.path, "documents/d1");
        assert.strictEqual(dataArg.permanentDeletionClaim?.claimedBy, "user-123");
        assert.ok(dataArg.permanentDeletionClaim?.claimedAt != null);
    });

    test("retry after S3 failure continues from claimed state and completes deletion", async () => {
        getDocumentContentUrlsMock.mock.mockImplementation(async () => ["uploads/s1/d1/img.png"]);
        permanentDeleteImagesMock.mock.mockImplementation(async () => {
            throw new Error("S3 Network Error");
        });

        // 1. Initial attempt fails at S3
        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /S3 Network Error/
        );

        // Claim must remain in place after S3 failure
        const docAfterS3Failure = documentsStore.get("d1");
        assert.ok(docAfterS3Failure?.permanentDeletionClaim != null);
        assert.strictEqual(docAfterS3Failure?.permanentDeletionClaim?.claimedBy, "user-123");
        assert.strictEqual(batchCommitMock.mock.callCount(), 0);

        // 2. Retry with S3 recovered succeeds
        permanentDeleteImagesMock.mock.mockImplementation(async () => {});
        const result = await permanentlyDeleteDocumentAction("valid", "s1", "d1");

        assert.deepEqual(result, { success: true });
        assert.strictEqual(batchCommitMock.mock.callCount(), 1);
        assert.strictEqual(deletedRefs.length, 2);
    });

    test("retry after Firestore batch failure continues from claimed state and completes deletion", async () => {
        batchCommitMock.mock.mockImplementation(async () => {
            throw new Error("Firestore batch commit failed");
        });

        // 1. Initial attempt fails at Firestore batch commit
        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /Firestore batch commit failed/
        );

        // Claim must remain in place after Firestore batch failure
        const docAfterBatchFailure = documentsStore.get("d1");
        assert.ok(docAfterBatchFailure?.permanentDeletionClaim != null);
        assert.strictEqual(docAfterBatchFailure?.permanentDeletionClaim?.claimedBy, "user-123");

        // 2. Retry succeeds when Firestore is recovered
        batchCommitMock.mock.mockImplementation(async () => {});
        const result = await permanentlyDeleteDocumentAction("valid", "s1", "d1");

        assert.deepEqual(result, { success: true });
        assert.strictEqual(batchCommitMock.mock.callCount(), 2);
    });

    test("claimed document cannot be restored after failure, but completes on retry", async () => {
        batchCommitMock.mock.mockImplementation(async () => {
            throw new Error("Firestore transient failure");
        });

        // Attempt permanent deletion which fails at batch commit
        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /Firestore transient failure/
        );

        // Attempting to restore the claimed document must fail
        await assert.rejects(
            restoreDocument("d1", { kind: "original" }),
            /Cannot restore a document that is pending permanent deletion/
        );
        assert.strictEqual(clientUpdateDocMock.mock.callCount(), 0);

        // Successful retry completes deletion
        batchCommitMock.mock.mockImplementation(async () => {});
        const retryResult = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(retryResult, { success: true });
    });

    test("unclaimed soft-deleted document can be restored normally", async () => {
        await restoreDocument("d1", { kind: "original" });

        assert.strictEqual(clientUpdateDocMock.mock.callCount(), 1);
        const [, updateData] = clientUpdateDocMock.mock.calls[0].arguments;
        assert.strictEqual(updateData.deleted, false);
        assert.strictEqual(updateData.deletedAt, null);
        assert.strictEqual(updateData.deletedBy, null);
    });

    test("incompatible claim by another user is rejected for non-owner", async () => {
        // Space owner is alice; caller is user-123 (member, not owner)
        spacesStore.set("s1", {
            id: "s1",
            name: "Test Space",
            ownerId: "alice",
            userIds: ["user-123", "bob"],
            deletedAt: null,
        });

        // Document already claimed by bob
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Soft Deleted Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: {
                claimedAt: { seconds: 12340, nanoseconds: 0 },
                claimedBy: "bob",
            },
        });

        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /Document is already being permanently deleted by another operation/
        );
        assert.strictEqual(permanentDeleteImagesMock.mock.callCount(), 0);
        assert.strictEqual(batchCommitMock.mock.callCount(), 0);
    });

    test("space owner can override or retry claim held by another user", async () => {
        // Space owner is user-123; caller is user-123
        spacesStore.set("s1", {
            id: "s1",
            name: "Test Space",
            ownerId: "user-123",
            userIds: ["user-123", "bob"],
            deletedAt: null,
        });

        // Document claimed by bob
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Soft Deleted Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: {
                claimedAt: { seconds: 12340, nanoseconds: 0 },
                claimedBy: "bob",
            },
        });

        const result = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(result, { success: true });
        assert.strictEqual(batchCommitMock.mock.callCount(), 1);
    });

    test("descendant rejection transactionally clears the claim", async () => {
        descendantsGetMock.mock.mockImplementation(async () => ({
            empty: false,
            docs: [{ id: "child-doc" }],
        }));

        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /This document still contains subdocuments. Permanently delete the subdocuments first./
        );

        // Claim must be cleared so the document is not permanently locked
        const docAfterRejection = documentsStore.get("d1");
        assert.strictEqual(docAfterRejection?.permanentDeletionClaim, null);
    });

    test("unexpected descendant-query failure fails closed and does not clear claim", async () => {
        descendantsGetMock.mock.mockImplementation(async () => {
            throw new Error("Firestore query deadline exceeded");
        });

        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /Failed to check document descendants/
        );

        // Claim must remain in place (fail-closed)
        const docAfterFailure = documentsStore.get("d1");
        assert.ok(docAfterFailure?.permanentDeletionClaim != null);
        assert.strictEqual(docAfterFailure?.permanentDeletionClaim?.claimedBy, "user-123");
        assert.strictEqual(permanentDeleteImagesMock.mock.callCount(), 0);
        assert.strictEqual(batchCommitMock.mock.callCount(), 0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Target Backlink Cleanup on Permanent Deletion Tests
// ═══════════════════════════════════════════════════════════════════════════════
describe("Target backlink cleanup on permanent deletion", () => {
    beforeEach(() => {
        resetAllMocks();
        setDefaultSuccessMocks();
    });

    test("removes source docId from active same-Space target backlinks", async () => {
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
            outboundLinks: ["target-1"],
        });
        documentsStore.set("target-1", {
            id: "target-1",
            spaceId: "s1",
            title: "Target One",
            deleted: false,
            deletedAt: null,
            backlinks: ["d1", "other-doc"],
        });

        const result = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(result, { success: true });

        // Source doc deleted from store
        assert.strictEqual(documentsStore.get("d1"), undefined);
        // Target backlink cleaned
        const targetAfter = documentsStore.get("target-1");
        assert.deepEqual(targetAfter?.backlinks, ["other-doc"]);
        assert.strictEqual(batchUpdateMock.mock.callCount(), 1);
        assert.strictEqual(batchCommitMock.mock.callCount(), 1);
    });

    test("removes source docId from soft-deleted same-Space target backlinks to prevent resurrection upon restore", async () => {
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
            outboundLinks: ["trash-target"],
        });
        documentsStore.set("trash-target", {
            id: "trash-target",
            spaceId: "s1",
            title: "Soft Deleted Target",
            deleted: true,
            deletedAt: { seconds: 12340, nanoseconds: 0 },
            backlinks: ["d1"],
        });

        const result = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(result, { success: true });

        const targetAfter = documentsStore.get("trash-target");
        assert.deepEqual(targetAfter?.backlinks, []);

        // Restoring trash-target maintains clean backlinks
        await restoreDocument("trash-target", { kind: "original" });
        assert.strictEqual(clientUpdateDocMock.mock.callCount(), 1);
        const [targetDocArg] = clientUpdateDocMock.mock.calls[0].arguments;
        assert.strictEqual(targetDocArg.id, "trash-target");
    });

    test("missing target documents are safely skipped without error", async () => {
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
            outboundLinks: ["non-existent-target"],
        });

        const result = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(result, { success: true });
        assert.strictEqual(documentsStore.get("d1"), undefined);
        assert.strictEqual(batchUpdateMock.mock.callCount(), 0);
        assert.strictEqual(batchCommitMock.mock.callCount(), 1);
    });

    test("cross-Space target documents are never modified", async () => {
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
            outboundLinks: ["cross-space-target"],
        });
        documentsStore.set("cross-space-target", {
            id: "cross-space-target",
            spaceId: "other-space",
            title: "Cross Space Target",
            deleted: false,
            deletedAt: null,
            backlinks: ["d1", "cross-link"],
        });

        const result = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(result, { success: true });

        const crossDoc = documentsStore.get("cross-space-target");
        // Cross-space document must remain completely untouched
        assert.deepEqual(crossDoc?.backlinks, ["d1", "cross-link"]);
        assert.strictEqual(batchUpdateMock.mock.callCount(), 0);
    });

    test("deduplicates outboundLinks and ignores self-links and malformed IDs", async () => {
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
            outboundLinks: ["d1", "  d1  ", "target-1", "  target-1  ", "", "   ", null as unknown as string, 123 as unknown as string],
        });
        documentsStore.set("target-1", {
            id: "target-1",
            spaceId: "s1",
            title: "Target One",
            deleted: false,
            deletedAt: null,
            backlinks: ["d1"],
        });

        const result = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(result, { success: true });

        assert.deepEqual(documentsStore.get("target-1")?.backlinks, []);
        assert.strictEqual(batchUpdateMock.mock.callCount(), 1);
    });

    test("cleans multiple same-Space targets in a single atomic batch", async () => {
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
            outboundLinks: ["t1", "t2", "t3"],
        });
        documentsStore.set("t1", { id: "t1", spaceId: "s1", title: "T1", deleted: false, backlinks: ["d1"] });
        documentsStore.set("t2", { id: "t2", spaceId: "s1", title: "T2", deleted: false, backlinks: ["d1", "other"] });
        documentsStore.set("t3", { id: "t3", spaceId: "s1", title: "T3", deleted: false, backlinks: ["d1"] });

        const result = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(result, { success: true });

        assert.deepEqual(documentsStore.get("t1")?.backlinks, []);
        assert.deepEqual(documentsStore.get("t2")?.backlinks, ["other"]);
        assert.deepEqual(documentsStore.get("t3")?.backlinks, []);
        assert.strictEqual(batchUpdateMock.mock.callCount(), 3);
        assert.strictEqual(batchCommitMock.mock.callCount(), 1);
    });

    test("skips updating target if target backlinks already does not contain source docId", async () => {
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
            outboundLinks: ["t1"],
        });
        documentsStore.set("t1", { id: "t1", spaceId: "s1", title: "T1", deleted: false, backlinks: ["unrelated-doc"] });

        const result = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(result, { success: true });

        assert.deepEqual(documentsStore.get("t1")?.backlinks, ["unrelated-doc"]);
        assert.strictEqual(batchUpdateMock.mock.callCount(), 0);
    });

    test("S3 cleanup failure prevents backlink cleanup and document deletion; retry succeeds", async () => {
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
            outboundLinks: ["target-1"],
        });
        documentsStore.set("target-1", {
            id: "target-1",
            spaceId: "s1",
            title: "Target One",
            deleted: false,
            deletedAt: null,
            backlinks: ["d1"],
        });

        // 1. First attempt fails in S3 cleanup
        permanentDeleteImagesMock.mock.mockImplementation(async () => {
            throw new Error("S3 permanent delete failure");
        });

        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /S3 permanent delete failure/
        );

        // Claim remains, target backlinks NOT modified, doc NOT deleted
        const docAfterFailure = documentsStore.get("d1");
        assert.ok(docAfterFailure?.permanentDeletionClaim != null);
        assert.deepEqual(documentsStore.get("target-1")?.backlinks, ["d1"]);
        assert.strictEqual(batchCommitMock.mock.callCount(), 0);

        // 2. Retry succeeds when S3 recovers
        permanentDeleteImagesMock.mock.mockImplementation(async () => {});
        const retryResult = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(retryResult, { success: true });

        assert.deepEqual(documentsStore.get("target-1")?.backlinks, []);
        assert.strictEqual(documentsStore.get("d1"), undefined);
        assert.strictEqual(batchCommitMock.mock.callCount(), 1);
    });

    test("Firestore batch failure leaves claim intact; retry completes backlink cleanup and deletion", async () => {
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
            outboundLinks: ["target-1"],
        });
        documentsStore.set("target-1", {
            id: "target-1",
            spaceId: "s1",
            title: "Target One",
            deleted: false,
            deletedAt: null,
            backlinks: ["d1"],
        });

        // 1. Initial attempt fails during batch commit
        batchCommitMock.mock.mockImplementation(async () => {
            throw new Error("Batch commit failed");
        });

        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /Batch commit failed/
        );

        // Claim remains in place, target backlinks NOT mutated, doc NOT deleted
        const docAfterFailure = documentsStore.get("d1");
        assert.ok(docAfterFailure?.permanentDeletionClaim != null);
        assert.deepEqual(documentsStore.get("target-1")?.backlinks, ["d1"]);

        // 2. Retry succeeds
        batchCommitMock.mock.mockImplementation(async () => {});
        const retryResult = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(retryResult, { success: true });

        assert.deepEqual(documentsStore.get("target-1")?.backlinks, []);
        assert.strictEqual(documentsStore.get("d1"), undefined);
    });

    test("chunks updates across multiple batches when targets exceed Firestore batch limit (> 450)", async () => {
        const targetIds: string[] = [];
        const TARGET_COUNT = 460;
        for (let idx = 0; idx < TARGET_COUNT; idx++) {
            const tid = `batch-target-${String(idx).padStart(4, "0")}`;
            targetIds.push(tid);
            documentsStore.set(tid, {
                id: tid,
                spaceId: "s1",
                title: `Target ${idx}`,
                deleted: false,
                deletedAt: null,
                backlinks: ["d1"],
            });
        }

        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
            outboundLinks: targetIds,
        });

        const result = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(result, { success: true });

        // Exactly 2 batches committed (450 in batch 1, 10 + 2 doc deletes in batch 2)
        assert.strictEqual(batchCommitMock.mock.callCount(), 2);
        assert.strictEqual(fakeFirestore.batch.mock.callCount(), 2);
        assert.strictEqual(batchUpdateMock.mock.callCount(), TARGET_COUNT);

        // All 460 targets have backlink removed
        for (const tid of targetIds) {
            assert.deepEqual(documentsStore.get(tid)?.backlinks, []);
        }
        assert.strictEqual(documentsStore.get("d1"), undefined);
    });

    test("retry after partial batch failure completes remaining targets without duplicate work", async () => {
        const targetIds: string[] = [];
        const TARGET_COUNT = 460;
        for (let idx = 0; idx < TARGET_COUNT; idx++) {
            const tid = `chunk-target-${String(idx).padStart(4, "0")}`;
            targetIds.push(tid);
            documentsStore.set(tid, {
                id: tid,
                spaceId: "s1",
                title: `Target ${idx}`,
                deleted: false,
                deletedAt: null,
                backlinks: ["d1"],
            });
        }

        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
            outboundLinks: targetIds,
        });

        // Fail on the 2nd batch commit
        let commitCallCount = 0;
        batchCommitMock.mock.mockImplementation(async () => {
            commitCallCount++;
            if (commitCallCount === 2) {
                throw new Error("Second batch failed");
            }
        });

        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /Second batch failed/
        );

        // First 450 targets committed and updated
        for (let idx = 0; idx < 450; idx++) {
            assert.deepEqual(documentsStore.get(targetIds[idx])?.backlinks, []);
        }
        // Remaining 10 targets still have backlink
        for (let idx = 450; idx < TARGET_COUNT; idx++) {
            assert.deepEqual(documentsStore.get(targetIds[idx])?.backlinks, ["d1"]);
        }
        // d1 NOT deleted
        assert.ok(documentsStore.get("d1") != null);

        // Retry with recovered batch commit
        batchCommitMock.mock.mockImplementation(async () => {});
        batchUpdateMock.mock.resetCalls();

        const retryResult = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(retryResult, { success: true });

        // On retry, only the remaining 10 targets are updated (first 450 already had d1 removed)
        assert.strictEqual(batchUpdateMock.mock.callCount(), 10);
        // All 460 are now clean
        for (const tid of targetIds) {
            assert.deepEqual(documentsStore.get(tid)?.backlinks, []);
        }
        // d1 is deleted
        assert.strictEqual(documentsStore.get("d1"), undefined);
    });

    test("retry after first batch failure in multi-batch scenario completes all targets", async () => {
        const targetIds: string[] = [];
        const TARGET_COUNT = 460;
        for (let idx = 0; idx < TARGET_COUNT; idx++) {
            const tid = `batch1-fail-target-${String(idx).padStart(4, "0")}`;
            targetIds.push(tid);
            documentsStore.set(tid, {
                id: tid,
                spaceId: "s1",
                title: `Target ${idx}`,
                deleted: false,
                deletedAt: null,
                backlinks: ["d1"],
            });
        }

        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
            outboundLinks: targetIds,
        });

        // Fail on the 1st batch commit
        let commitCallCount = 0;
        batchCommitMock.mock.mockImplementation(async () => {
            commitCallCount++;
            if (commitCallCount === 1) {
                throw new Error("First batch failed");
            }
        });

        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /First batch failed/
        );

        // No targets committed because batch 1 failed
        for (const tid of targetIds) {
            assert.deepEqual(documentsStore.get(tid)?.backlinks, ["d1"]);
        }
        // d1 NOT deleted
        assert.ok(documentsStore.get("d1") != null);

        // Retry with recovered batch commit
        batchCommitMock.mock.mockImplementation(async () => {});
        batchUpdateMock.mock.resetCalls();

        const retryResult = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(retryResult, { success: true });

        // On retry, all 460 targets are updated across 2 batches
        assert.strictEqual(batchUpdateMock.mock.callCount(), 460);
        for (const tid of targetIds) {
            assert.deepEqual(documentsStore.get(tid)?.backlinks, []);
        }
        // d1 is deleted
        assert.strictEqual(documentsStore.get("d1"), undefined);
    });

    test("removes source docId from target document even if target has a lifecycleClaim", async () => {
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
            outboundLinks: ["t-claimed"],
        });
        documentsStore.set("t-claimed", {
            id: "t-claimed",
            spaceId: "s1",
            title: "Claimed Target",
            deleted: false,
            deletedAt: null,
            lifecycleClaim: {
                claimedAt: new Date(),
                claimedBy: "user-other",
                operation: "soft-delete",
                opId: "op-1",
            },
            backlinks: ["d1", "other-doc"],
        });

        const result = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(result, { success: true });

        const targetAfter = documentsStore.get("t-claimed");
        assert.deepEqual(targetAfter?.backlinks, ["other-doc"]);
        assert.ok(targetAfter?.lifecycleClaim != null, "Target lifecycle claim must remain intact");
        assert.strictEqual(batchUpdateMock.mock.callCount(), 1);
    });

    test("removes all duplicate occurrences of source docId from target backlinks", async () => {
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
            outboundLinks: ["t-dups"],
        });
        documentsStore.set("t-dups", {
            id: "t-dups",
            spaceId: "s1",
            title: "Target With Dups",
            deleted: false,
            deletedAt: null,
            backlinks: ["d1", "d1", "other-doc"],
        });

        const result = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(result, { success: true });

        assert.deepEqual(documentsStore.get("t-dups")?.backlinks, ["other-doc"]);
    });

    test("cleans target whose backlinks contains source ID even when absent from source outboundLinks", async () => {
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
            outboundLinks: [], // Absent from outboundLinks
        });
        documentsStore.set("t-unreferenced", {
            id: "t-unreferenced",
            spaceId: "s1",
            title: "Target Unreferenced in Outbound",
            deleted: false,
            deletedAt: null,
            backlinks: ["d1", "other-link"],
        });

        const result = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(result, { success: true });

        // Target backlink is cleaned even though d1.outboundLinks was empty
        assert.deepEqual(documentsStore.get("t-unreferenced")?.backlinks, ["other-link"]);
        assert.strictEqual(documentsStore.get("d1"), undefined);
        assert.strictEqual(batchUpdateMock.mock.callCount(), 1);
    });

    test("pagination progresses and terminates cleanly when a page contains only cross-Space matches", async () => {
        // Create 120 cross-space documents (exceeds PAGE_SIZE=100 so at least 1 full page is purely cross-space)
        const CROSS_COUNT = 120;
        for (let idx = 0; idx < CROSS_COUNT; idx++) {
            const cid = `cross-doc-${String(idx).padStart(4, "0")}`;
            documentsStore.set(cid, {
                id: cid,
                spaceId: "foreign-space",
                title: `Cross ${idx}`,
                deleted: false,
                deletedAt: null,
                backlinks: ["d1"],
            });
        }

        // Add 1 valid same-space document sorted after cross-space docs
        documentsStore.set("same-target", {
            id: "same-target",
            spaceId: "s1",
            title: "Same Space Target",
            deleted: false,
            deletedAt: null,
            backlinks: ["d1", "keep-me"],
        });

        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
        });

        const result = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(result, { success: true });

        // None of the cross-space documents were modified
        for (let idx = 0; idx < CROSS_COUNT; idx++) {
            const cid = `cross-doc-${String(idx).padStart(4, "0")}`;
            assert.deepEqual(documentsStore.get(cid)?.backlinks, ["d1"]);
        }

        // Same-space document was cleaned
        assert.deepEqual(documentsStore.get("same-target")?.backlinks, ["keep-me"]);
        assert.strictEqual(batchUpdateMock.mock.callCount(), 1);
        assert.strictEqual(documentsStore.get("d1"), undefined);
    });

    test("requires and handles more than one discovery page and more than one commit batch", async () => {
        // PAGE_SIZE is 100, MAX_BATCH_SIZE is 450.
        // With 500 documents: requires 5 query pages and 2 commit batches.
        const TARGET_COUNT = 500;
        const targetIds: string[] = [];
        for (let idx = 0; idx < TARGET_COUNT; idx++) {
            const tid = `multipage-target-${String(idx).padStart(4, "0")}`;
            targetIds.push(tid);
            documentsStore.set(tid, {
                id: tid,
                spaceId: "s1",
                title: `Target ${idx}`,
                deleted: false,
                deletedAt: null,
                backlinks: ["d1"],
            });
        }

        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
        });

        const result = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(result, { success: true });

        // Exactly 2 batches committed (450 in batch 1, 50 in batch 2)
        assert.strictEqual(batchCommitMock.mock.callCount(), 2);
        assert.strictEqual(fakeFirestore.batch.mock.callCount(), 2);
        assert.strictEqual(batchUpdateMock.mock.callCount(), TARGET_COUNT);

        // All 500 targets have backlink removed
        for (const tid of targetIds) {
            assert.deepEqual(documentsStore.get(tid)?.backlinks, []);
        }
        assert.strictEqual(documentsStore.get("d1"), undefined);
    });

    test("handles combination of missing, active, and soft-deleted targets correctly", async () => {
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
            outboundLinks: ["missing-target", "active-target", "soft-deleted-target"],
        });

        // 1. Active target
        documentsStore.set("active-target", {
            id: "active-target",
            spaceId: "s1",
            title: "Active Target",
            deleted: false,
            deletedAt: null,
            backlinks: ["d1", "other-link"],
        });

        // 2. Soft-deleted target
        documentsStore.set("soft-deleted-target", {
            id: "soft-deleted-target",
            spaceId: "s1",
            title: "Soft Deleted Target",
            deleted: true,
            deletedAt: { seconds: 12000, nanoseconds: 0 },
            backlinks: ["d1"],
        });

        // 3. missing-target is not added to documentsStore

        const result = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(result, { success: true });

        // Active target cleaned
        assert.deepEqual(documentsStore.get("active-target")?.backlinks, ["other-link"]);
        // Soft-deleted target cleaned
        assert.deepEqual(documentsStore.get("soft-deleted-target")?.backlinks, []);
        // Missing target causes no crash and remains undefined
        assert.strictEqual(documentsStore.get("missing-target"), undefined);
        // Source document permanently deleted
        assert.strictEqual(documentsStore.get("d1"), undefined);
        assert.strictEqual(batchUpdateMock.mock.callCount(), 2);
    });

    test("query page failure during discovery retains source and claim; retry succeeds", async () => {
        // Set up 150 same-Space targets so discovery requires 2 pages (100 in page 1, 50 in page 2)
        const targetIds: string[] = [];
        for (let idx = 0; idx < 150; idx++) {
            const tid = `qfail-target-${String(idx).padStart(4, "0")}`;
            targetIds.push(tid);
            documentsStore.set(tid, {
                id: tid,
                spaceId: "s1",
                title: `Target ${idx}`,
                deleted: false,
                deletedAt: null,
                backlinks: ["d1"],
            });
        }
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
        });

        // Fail on page 2 of discovery query
        queryGetFailOnCallNumber = 2;

        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /Firestore backlink query page failed/
        );

        // Document d1 still exists with permanentDeletionClaim
        const d1AfterFail = documentsStore.get("d1");
        assert.ok(d1AfterFail != null, "Source document must still exist after query failure");
        assert.ok(d1AfterFail.permanentDeletionClaim != null, "Claim must remain intact after query failure");

        // Retry without query failure succeeds
        const retryResult = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(retryResult, { success: true });

        // Source document is permanently deleted
        assert.strictEqual(documentsStore.get("d1"), undefined);
        // All targets cleaned
        for (const tid of targetIds) {
            assert.deepEqual(documentsStore.get(tid)?.backlinks, []);
        }
    });

    test("pagination terminates cleanly when matches are exclusively cross-Space (0 same-Space targets)", async () => {
        // 120 cross-Space documents in foreign space (exceeds PAGE_SIZE=100)
        const CROSS_COUNT = 120;
        for (let idx = 0; idx < CROSS_COUNT; idx++) {
            const cid = `pure-cross-${String(idx).padStart(4, "0")}`;
            documentsStore.set(cid, {
                id: cid,
                spaceId: "foreign-space",
                title: `Cross ${idx}`,
                deleted: false,
                deletedAt: null,
                backlinks: ["d1"],
            });
        }

        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
        });

        const result = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(result, { success: true });

        // None of the 120 cross-Space documents were modified
        for (let idx = 0; idx < CROSS_COUNT; idx++) {
            const cid = `pure-cross-${String(idx).padStart(4, "0")}`;
            assert.deepEqual(documentsStore.get(cid)?.backlinks, ["d1"]);
        }
        // Source document permanently deleted
        assert.strictEqual(documentsStore.get("d1"), undefined);
        // No batch updates were made to targets
        assert.strictEqual(batchUpdateMock.mock.callCount(), 0);
    });

    test("regression: fails closed and never deletes source when uncleared same-Space target follows >= 100 cross-Space matches", async () => {
        // 105 cross-Space documents (exceeds PAGE_SIZE=100)
        for (let idx = 0; idx < 105; idx++) {
            const cid = `cross-match-${String(idx).padStart(4, "0")}`;
            documentsStore.set(cid, {
                id: cid,
                spaceId: "foreign-space",
                title: `Cross ${idx}`,
                deleted: false,
                deletedAt: null,
                backlinks: ["d1"],
            });
        }

        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
        });

        // After discovery finishes (queries 1 and 2 read the 105 cross-Space docs),
        // inject an uncleared same-Space target that sorts after the cross-Space docs.
        // The verification pass must paginate past the 100 cross-Space docs, discover
        // this uncleared target on page 2, and throw without deleting the source document.
        onQueryGetHook = (callCount) => {
            if (callCount === 3) {
                documentsStore.set("z-uncleared-target", {
                    id: "z-uncleared-target",
                    spaceId: "s1",
                    title: "Uncleared Same-Space Target",
                    deleted: false,
                    deletedAt: null,
                    backlinks: ["d1", "keep-link"],
                });
            }
        };

        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /Uncleared same-Space target backlinks remain/
        );

        // Verification requirement: Source document and content must NOT be deleted
        assert.ok(documentsStore.has("d1"), "Source document must NOT be deleted when uncleared target remains");
        assert.strictEqual(documentsStore.get("d1")?.deleted, true);
        assert.ok(documentsStore.get("d1")?.permanentDeletionClaim != null, "Claim must remain intact");

        // The uncleared target must still retain its backlink
        const unclearedDoc = documentsStore.get("z-uncleared-target");
        assert.ok(unclearedDoc != null);
        assert.deepEqual(unclearedDoc.backlinks, ["d1", "keep-link"]);
    });

    test("regression: fails closed and never deletes source when uncleared same-Space target follows >= 100 pending-final-chunk matches", async () => {
        // 105 same-Space targets queued for the final batch (exceeds PAGE_SIZE=100)
        for (let idx = 0; idx < 105; idx++) {
            const tid = `pending-match-${String(idx).padStart(4, "0")}`;
            documentsStore.set(tid, {
                id: tid,
                spaceId: "s1",
                title: `Pending Target ${idx}`,
                deleted: false,
                deletedAt: null,
                backlinks: ["d1"],
            });
        }

        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
        });

        // After discovery finishes (queries 1 and 2 read the 105 targets into pendingTargets),
        // inject an uncleared target that was not in pendingFinalTargetSet.
        // Verification page 1 checks the first 100 pending targets.
        // Verification page 2 finds the uncleared target and aborts before deleting the source.
        onQueryGetHook = (callCount) => {
            if (callCount === 3) {
                documentsStore.set("z-missed-target", {
                    id: "z-missed-target",
                    spaceId: "s1",
                    title: "Missed Same-Space Target",
                    deleted: false,
                    deletedAt: null,
                    backlinks: ["d1"],
                });
            }
        };

        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /Uncleared same-Space target backlinks remain/
        );

        // Verification requirement: Source document must NOT be deleted
        assert.ok(documentsStore.has("d1"), "Source document must NOT be deleted");
        assert.ok(documentsStore.get("d1")?.permanentDeletionClaim != null);

        // The missed target must still retain its backlink
        assert.deepEqual(documentsStore.get("z-missed-target")?.backlinks, ["d1"]);
    });

    test("fails closed when query pagination API is unavailable rather than running unbounded query", async () => {
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Source Document",
            deleted: true,
            deletedAt: { seconds: 12345, nanoseconds: 0 },
            permanentDeletionClaim: null,
        });

        disablePaginationMock = true;

        await assert.rejects(
            permanentlyDeleteDocumentAction("valid", "s1", "d1"),
            /Firestore query pagination is unavailable/
        );

        // Source document must NOT be deleted
        assert.ok(documentsStore.has("d1"));
        assert.ok(documentsStore.get("d1")?.permanentDeletionClaim != null);
    });
});
