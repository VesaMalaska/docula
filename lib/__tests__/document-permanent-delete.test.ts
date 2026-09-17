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
    },
});

// ── S3 actions mock ────────────────────────────────────────────────────────────
const permanentDeleteImagesMock = mock.fn();
const restoreImagesMock = mock.fn();
const softDeleteImagesMock = mock.fn();
const getPresignedGetUrlMock = mock.fn();

mock.module("../actions/s3", {
    exports: {
        permanentDeleteImages: permanentDeleteImagesMock,
        restoreImages: restoreImagesMock,
        softDeleteImages: softDeleteImagesMock,
        getPresignedGetUrl: getPresignedGetUrlMock,
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
    },
});

// ── firebase-admin mocks ───────────────────────────────────────────────────────
const batchDeleteMock = mock.fn();
const batchCommitMock = mock.fn();
const descendantsGetMock = mock.fn();
const transactionGetMock = mock.fn();
const transactionUpdateMock = mock.fn();
const runTransactionMock = mock.fn();

const deletedRefs: string[] = [];
const spacesStore = new Map<string, Record<string, unknown>>();
const documentsStore = new Map<string, Record<string, unknown>>();

const fakeBatch = {
    delete: mock.fn((ref: { path: string }) => {
        deletedRefs.push(ref.path);
        batchDeleteMock(ref);
    }),
    commit: batchCommitMock,
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

const fakeFirestore = {
    collection: mock.fn((colName: string) => ({
        where: mock.fn(() => ({
            limit: mock.fn(() => ({
                get: descendantsGetMock,
            })),
        })),
        doc: mock.fn((docId: string) => ({
            id: docId,
            path: `${colName}/${docId}`,
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

        assert.strictEqual(permanentDeleteImagesMock.mock.callCount(), 0);
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
            restoreDocument("d1"),
            /Cannot restore a document that is pending permanent deletion/
        );
        assert.strictEqual(clientUpdateDocMock.mock.callCount(), 0);

        // Successful retry completes deletion
        batchCommitMock.mock.mockImplementation(async () => {});
        const retryResult = await permanentlyDeleteDocumentAction("valid", "s1", "d1");
        assert.deepEqual(retryResult, { success: true });
    });

    test("unclaimed soft-deleted document can be restored normally", async () => {
        await restoreDocument("d1");

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
