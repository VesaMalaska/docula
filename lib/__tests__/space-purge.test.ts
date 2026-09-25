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

import test, { mock, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Mock server-only so importing server modules works in test environment
mock.module("server-only", {
    exports: {},
});

// ── document-authorization mocks ───────────────────────────────────────────────
const verifyIdTokenMock = mock.fn();
const getDocumentContentUrlsMock = mock.fn();

mock.module("../server/document-authorization", {
    exports: {
        verifyIdToken: verifyIdTokenMock,
        getDocumentContentUrls: getDocumentContentUrlsMock,
        authorizeSpaceReader: mock.fn(),
        authorizeSpaceContributor: mock.fn(),
        authorizeDocumentCleanup: mock.fn(),
        getAndVerifyDocument: mock.fn(),
    },
});

// ── S3 actions mock ────────────────────────────────────────────────────────────
const permanentDeleteImagesMock = mock.fn();

mock.module("../actions/s3", {
    exports: {
        permanentDeleteImages: permanentDeleteImagesMock,
        permanentizeImages: mock.fn(),
        deleteImages: mock.fn(),
        softDeleteImages: mock.fn(),
        restoreImages: mock.fn(),
        getPresignedGetUrl: mock.fn(),
        getPresignedUrl: mock.fn(),
    },
});

// ── In-memory stores for Admin & Client Firestore ─────────────────────────────
interface SpaceStoreItem {
    id: string;
    ownerId: string;
    userIds: string[];
    name: string;
    isPublic: boolean;
    deletedAt?: unknown;
    deletedBy?: string | null;
    purgeState?: string | null;
    purgeStartedAt?: unknown;
    updatedAt?: unknown;
    [key: string]: unknown;
}

interface DocStoreItem {
    id: string;
    spaceId: string;
    title: string;
    content?: unknown;
    deleted?: boolean;
    deletedAt?: unknown;
    [key: string]: unknown;
}

const spacesStore = new Map<string, SpaceStoreItem>();
const documentsStore = new Map<string, DocStoreItem>();
const contentStore = new Map<string, unknown>();

// ── Client Firestore / Firebase mocks ─────────────────────────────────────────
let currentClientUser: { uid: string; getIdToken: () => Promise<string> } | null = {
    uid: "alice",
    getIdToken: async () => "valid-token-alice",
};

interface MockClientTransaction {
    get: (ref: { id: string; col: string }) => Promise<{
        exists: () => boolean;
        data: () => Record<string, unknown> | undefined;
    }>;
    update: (ref: { id: string; col: string }, data: Record<string, unknown>) => void;
    delete: (ref: { id: string; col: string }) => void;
}

const clientRunTransactionMock = mock.fn(async (_db: unknown, updateFunction: (tx: MockClientTransaction) => Promise<unknown>) => {
    const tx = {
        get: async (ref: { id: string; col: string }) => {
            if (ref.col === "spaces") {
                const space = spacesStore.get(ref.id);
                return {
                    exists: () => !!space,
                    data: () => (space ? { ...space } : undefined),
                };
            }
            if (ref.col === "documents") {
                const docData = documentsStore.get(ref.id);
                return {
                    exists: () => !!docData,
                    data: () => (docData ? { ...docData } : undefined),
                };
            }
            return { exists: () => false, data: () => undefined };
        },
        update: (ref: { id: string; col: string }, data: Record<string, unknown>) => {
            if (ref.col === "spaces") {
                const existing = spacesStore.get(ref.id);
                if (existing) {
                    spacesStore.set(ref.id, { ...existing, ...data });
                }
            }
            if (ref.col === "documents") {
                const existing = documentsStore.get(ref.id);
                if (existing) {
                    documentsStore.set(ref.id, { ...existing, ...data });
                }
            }
        },
        delete: (ref: { id: string; col: string }) => {
            if (ref.col === "spaces") spacesStore.delete(ref.id);
            if (ref.col === "documents") documentsStore.delete(ref.id);
        },
    };
    return await updateFunction(tx);
});

mock.module("@/lib/firebase", {
    exports: {
        db: {},
        auth: {
            get currentUser() {
                return currentClientUser;
            },
        },
    },
});

mock.module("firebase/firestore", {
    exports: {
        doc: (_db: unknown, col: string, id: string) => ({ col, id, path: `${col}/${id}` }),
        getDoc: mock.fn(async (ref: { col: string; id: string }) => {
            const data = spacesStore.get(ref.id);
            return {
                exists: () => !!data,
                data: () => (data ? { ...data } : undefined),
                id: ref.id,
            };
        }),
        updateDoc: mock.fn(async (ref: { col: string; id: string }, data: Record<string, unknown>) => {
            const existing = spacesStore.get(ref.id);
            if (existing) {
                spacesStore.set(ref.id, { ...existing, ...data });
            }
        }),
        deleteDoc: mock.fn(async (ref: { col: string; id: string }) => {
            spacesStore.delete(ref.id);
        }),
        collection: mock.fn((_db: unknown, name: string) => ({ name })),
        getDocs: mock.fn(async () => ({ docs: [], forEach: () => {} })),
        runTransaction: clientRunTransactionMock,
        serverTimestamp: () => "SERVER_TIMESTAMP",
        query: mock.fn(),
        orderBy: mock.fn(),
        where: mock.fn(),
        addDoc: mock.fn(),
        arrayUnion: (...items: unknown[]) => items,
        Timestamp: class Timestamp {},
    },
});

// ── firebase-admin mocks ───────────────────────────────────────────────────────
const fakeBatch = {
    delete: mock.fn((ref: { col: string; id: string; subId?: string }) => {
        if (ref.subId) {
            contentStore.delete(`${ref.id}/${ref.subId}`);
        } else if (ref.col === "documents") {
            documentsStore.delete(ref.id);
        } else if (ref.col === "spaces") {
            spacesStore.delete(ref.id);
        }
    }),
    commit: mock.fn(async () => {}),
};

const fakeAdminTransaction = {
    get: mock.fn(async (ref: { col: string; id: string }) => {
        if (ref.col === "spaces") {
            const space = spacesStore.get(ref.id);
            return {
                exists: !!space,
                data: () => (space ? { ...space } : undefined),
            };
        }
        if (ref.col === "documents") {
            const docData = documentsStore.get(ref.id);
            return {
                exists: !!docData,
                data: () => (docData ? { ...docData } : undefined),
            };
        }
        return { exists: false, data: () => undefined };
    }),
    update: mock.fn((ref: { col: string; id: string }, data: Record<string, unknown>) => {
        if (ref.col === "spaces") {
            const existing = spacesStore.get(ref.id);
            if (existing) {
                spacesStore.set(ref.id, { ...existing, ...data });
            }
        }
    }),
    delete: mock.fn((ref: { col: string; id: string; subId?: string }) => {
        if (ref.subId) {
            contentStore.delete(`${ref.id}/${ref.subId}`);
        } else if (ref.col === "spaces") {
            spacesStore.delete(ref.id);
        } else if (ref.col === "documents") {
            documentsStore.delete(ref.id);
        }
    }),
};

let transactionLock = Promise.resolve();

const fakeFirestore = {
    collection: mock.fn((colName: string) => ({
        where: mock.fn((field: string, op: string, val: unknown) => ({
            limit: mock.fn((num: number) => ({
                get: mock.fn(async () => {
                    const matched: DocStoreItem[] = [];
                    if (colName === "documents" && field === "spaceId" && op === "==") {
                        for (const docItem of documentsStore.values()) {
                            if (docItem.spaceId === val) {
                                matched.push(docItem);
                                if (matched.length >= num) break;
                            }
                        }
                    }
                    return {
                        empty: matched.length === 0,
                        docs: matched.map((m) => ({
                            id: m.id,
                            data: () => ({ ...m }),
                            ref: { col: "documents", id: m.id },
                        })),
                    };
                }),
            })),
            get: mock.fn(async () => {
                const matched: DocStoreItem[] = [];
                if (colName === "documents" && field === "spaceId" && op === "==") {
                    for (const docItem of documentsStore.values()) {
                        if (docItem.spaceId === val) {
                            matched.push(docItem);
                        }
                    }
                }
                return {
                    empty: matched.length === 0,
                    docs: matched.map((m) => ({
                        id: m.id,
                        data: () => ({ ...m }),
                        ref: { col: "documents", id: m.id },
                    })),
                };
            }),
        })),
        doc: mock.fn((docId: string) => ({
            col: colName,
            id: docId,
            path: `${colName}/${docId}`,
            get: mock.fn(async () => {
                if (colName === "spaces") {
                    const space = spacesStore.get(docId);
                    return {
                        exists: !!space,
                        data: () => (space ? { ...space } : undefined),
                    };
                }
                if (colName === "documents") {
                    const docData = documentsStore.get(docId);
                    return {
                        exists: !!docData,
                        data: () => (docData ? { ...docData } : undefined),
                    };
                }
                return { exists: false, data: () => undefined };
            }),
            collection: mock.fn((subCol: string) => ({
                doc: mock.fn((subId: string) => ({
                    col: `${colName}/${docId}/${subCol}`,
                    id: docId,
                    subId,
                    get: mock.fn(async () => {
                        const content = contentStore.get(`${docId}/${subId}`);
                        return {
                            exists: !!content,
                            data: () => (content ? { content } : undefined),
                        };
                    }),
                })),
            })),
        })),
    })),
    batch: mock.fn(() => fakeBatch),
    runTransaction: mock.fn(async (cb: (txn: typeof fakeAdminTransaction) => Promise<unknown>) => {
        const prevLock = transactionLock;
        let releaseLock: () => void;
        transactionLock = new Promise<void>((resolve) => {
            releaseLock = resolve;
        });
        await prevLock;
        try {
            return await cb(fakeAdminTransaction);
        } finally {
            releaseLock!();
        }
    }),
};

mock.module("../server/firebase-admin", {
    exports: {
        getAdminFirestore: mock.fn(() => fakeFirestore),
        getAdminAuth: mock.fn(),
    },
});

// Import modules under test
const { deleteSpace, restoreSpace, permanentlyDeleteSpace, getSafePurgeErrorMessage } = await import("../actions/spaces");
const { purgeSpaceStepAction } = await import("../actions/space-purge");

function resetStores() {
    spacesStore.clear();
    documentsStore.clear();
    contentStore.clear();
    verifyIdTokenMock.mock.resetCalls();
    getDocumentContentUrlsMock.mock.resetCalls();
    permanentDeleteImagesMock.mock.resetCalls();
    fakeBatch.delete.mock.resetCalls();
    fakeBatch.commit.mock.resetCalls();
    fakeAdminTransaction.get.mock.resetCalls();
    fakeAdminTransaction.update.mock.resetCalls();
    fakeAdminTransaction.delete.mock.resetCalls();
    transactionLock = Promise.resolve();

    currentClientUser = {
        uid: "alice",
        getIdToken: async () => "valid-token-alice",
    };

    verifyIdTokenMock.mock.mockImplementation(async (token: string | undefined) => {
        if (!token) throw new Error("Missing ID token");
        if (token === "valid-token-alice") return { uid: "alice" };
        if (token === "valid-token-bob") return { uid: "bob" };
        if (token === "valid-token-charlie") return { uid: "charlie" };
        throw new Error("Invalid or expired ID token");
    });

    getDocumentContentUrlsMock.mock.mockImplementation(async (docId: string) => {
        const docItem = documentsStore.get(docId);
        if (docItem?.imageUrls) return docItem.imageUrls as string[];
        return [];
    });

    permanentDeleteImagesMock.mock.mockImplementation(async () => {});
}

describe("Space Soft-Delete & Restore Transactional Integrity", () => {
    beforeEach(() => {
        resetStores();
        spacesStore.set("s1", {
            id: "s1",
            name: "Alice Space",
            ownerId: "alice",
            userIds: ["alice", "bob"],
            isPublic: false,
            deletedAt: null,
            deletedBy: null,
        });
    });

    test("deleteSpace: requires authentication", async () => {
        currentClientUser = null;
        await assert.rejects(
            deleteSpace("s1"),
            /You must be signed in to delete a space/
        );
    });

    test("deleteSpace: rejects delete on behalf of another user", async () => {
        await assert.rejects(
            deleteSpace("s1", "bob"),
            /Cannot delete a space on behalf of another user/
        );
    });

    test("deleteSpace: rejects when space does not exist", async () => {
        await assert.rejects(
            deleteSpace("missing-space"),
            /Space not found/
        );
    });

    test("deleteSpace: non-owner member is rejected inside transaction", async () => {
        currentClientUser = {
            uid: "bob",
            getIdToken: async () => "valid-token-bob",
        };
        await assert.rejects(
            deleteSpace("s1"),
            /Only the space owner can delete this space/
        );
        const space = spacesStore.get("s1");
        assert.strictEqual(space?.deletedAt, null);
    });

    test("deleteSpace: rejects soft-deleting an already deleted space", async () => {
        spacesStore.set("s1", {
            ...spacesStore.get("s1")!,
            deletedAt: "2026-01-01",
            deletedBy: "alice",
        });
        await assert.rejects(
            deleteSpace("s1"),
            /Space is already deleted/
        );
    });

    test("deleteSpace: rejects soft-deleting a space in purge state", async () => {
        spacesStore.set("s1", {
            ...spacesStore.get("s1")!,
            purgeState: "purging",
        });
        await assert.rejects(
            deleteSpace("s1"),
            /Cannot delete a space that is being permanently deleted/
        );
    });

    test("deleteSpace: owner soft-deletes space successfully in transaction", async () => {
        await deleteSpace("s1");
        const space = spacesStore.get("s1");
        assert.strictEqual(space?.deletedAt, "SERVER_TIMESTAMP");
        assert.strictEqual(space?.deletedBy, "alice");
    });

    test("restoreSpace: requires authentication", async () => {
        currentClientUser = null;
        await assert.rejects(
            restoreSpace("s1"),
            /You must be signed in to restore a space/
        );
    });

    test("restoreSpace: rejects when space does not exist", async () => {
        await assert.rejects(
            restoreSpace("missing-space"),
            /Space not found/
        );
    });

    test("restoreSpace: rejects when space is active (not soft-deleted)", async () => {
        await assert.rejects(
            restoreSpace("s1"),
            /Cannot restore an active space/
        );
    });

    test("restoreSpace: non-owner member is rejected inside transaction", async () => {
        spacesStore.set("s1", {
            ...spacesStore.get("s1")!,
            deletedAt: "2026-01-01",
            deletedBy: "alice",
        });
        currentClientUser = {
            uid: "bob",
            getIdToken: async () => "valid-token-bob",
        };
        await assert.rejects(
            restoreSpace("s1"),
            /Only the space owner can restore this space/
        );
        const space = spacesStore.get("s1");
        assert.strictEqual(space?.deletedAt, "2026-01-01");
    });

    test("restoreSpace: rejects restoring a space that is purging", async () => {
        spacesStore.set("s1", {
            ...spacesStore.get("s1")!,
            deletedAt: "2026-01-01",
            deletedBy: "alice",
            purgeState: "purging",
        });
        await assert.rejects(
            restoreSpace("s1"),
            /Cannot restore a space that is being permanently deleted/
        );
        const space = spacesStore.get("s1");
        assert.strictEqual(space?.deletedAt, "2026-01-01");
    });

    test("restoreSpace: owner successfully restores soft-deleted space in transaction", async () => {
        spacesStore.set("s1", {
            ...spacesStore.get("s1")!,
            deletedAt: "2026-01-01",
            deletedBy: "alice",
        });
        await restoreSpace("s1");
        const space = spacesStore.get("s1");
        assert.strictEqual(space?.deletedAt, null);
        assert.strictEqual(space?.deletedBy, null);
    });
});

describe("Restore-versus-Purge Concurrency & Races", () => {
    beforeEach(() => {
        resetStores();
        spacesStore.set("s1", {
            id: "s1",
            name: "Race Space",
            ownerId: "alice",
            userIds: ["alice"],
            isPublic: false,
            deletedAt: "2026-01-01",
            deletedBy: "alice",
        });
    });

    test("purge starts first: marks purgeState, blocking subsequent restore attempt", async () => {
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Doc 1",
        });
        documentsStore.set("d2", {
            id: "d2",
            spaceId: "s1",
            title: "Doc 2",
        });

        // Run one bounded step with batchSize=1
        const stepResult = await purgeSpaceStepAction("valid-token-alice", "s1", 1);
        assert.strictEqual(stepResult.done, false);
        assert.strictEqual(stepResult.processedCount, 1);

        const spaceDuringPurge = spacesStore.get("s1");
        assert.strictEqual(spaceDuringPurge?.purgeState, "purging");

        // Concurrent / subsequent restore attempt must be rejected
        await assert.rejects(
            restoreSpace("s1"),
            /Cannot restore a space that is being permanently deleted/
        );
    });

    test("restore commits first: clears deletedAt, blocking subsequent purge attempt", async () => {
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Doc 1",
        });

        // Restore commits first
        await restoreSpace("s1");
        const space = spacesStore.get("s1");
        assert.strictEqual(space?.deletedAt, null);

        // Subsequent purge attempt must fail because space is active
        await assert.rejects(
            purgeSpaceStepAction("valid-token-alice", "s1"),
            /Cannot permanently delete an active space. Soft-delete it first./
        );
        // Documents remain untouched
        assert.strictEqual(documentsStore.has("d1"), true);
    });
});

describe("Concurrent Purge Execution & Multi-Worker Coordination", () => {
    beforeEach(() => {
        resetStores();
        spacesStore.set("s1", {
            id: "s1",
            name: "Concurrent Purge Space",
            ownerId: "alice",
            userIds: ["alice"],
            isPublic: false,
            deletedAt: "2026-01-01",
            deletedBy: "alice",
        });
    });

    test("two concurrent tabs processing same documents do not double-count or throw false S3 errors", async () => {
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Doc 1 with image",
            imageUrls: ["https://test-bucket.s3.amazonaws.com/uploads/s1/d1/img1.png"],
        });
        documentsStore.set("d2", {
            id: "d2",
            spaceId: "s1",
            title: "Doc 2 with image",
            imageUrls: ["https://test-bucket.s3.amazonaws.com/uploads/s1/d2/img2.png"],
        });
        contentStore.set("d1/main", {
            type: "doc",
            content: [{ type: "image", attrs: { src: "https://test-bucket.s3.amazonaws.com/uploads/s1/d1/img1.png" } }],
        });
        contentStore.set("d2/main", {
            type: "doc",
            content: [{ type: "image", attrs: { src: "https://test-bucket.s3.amazonaws.com/uploads/s1/d2/img2.png" } }],
        });

        permanentDeleteImagesMock.mock.mockImplementation(async () => {});

        // Simulate two tabs running a purge step simultaneously
        const [tabAResult, tabBResult] = await Promise.all([
            purgeSpaceStepAction("valid-token-alice", "s1", 10),
            purgeSpaceStepAction("valid-token-alice", "s1", 10),
        ]);

        assert.strictEqual(tabAResult.success, true);
        assert.strictEqual(tabBResult.success, true);
        assert.strictEqual(tabAResult.done, true);
        assert.strictEqual(tabBResult.done, true);

        // Crucial invariant: documents are processed exactly once across both tabs
        assert.strictEqual(tabAResult.processedCount + tabBResult.processedCount, 2);

        // Firestore and S3 stores are clean
        assert.strictEqual(documentsStore.has("d1"), false);
        assert.strictEqual(documentsStore.has("d2"), false);
        assert.strictEqual(contentStore.has("d1/main"), false);
        assert.strictEqual(contentStore.has("d2/main"), false);
        assert.strictEqual(spacesStore.has("s1"), false);
    });

    test("tab encountering concurrently deleted document during S3 cleanup does not throw S3 error", async () => {
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Doc 1",
            imageUrls: ["https://test-bucket.s3.amazonaws.com/uploads/s1/d1/img1.png"],
        });
        contentStore.set("d1/main", {
            type: "doc",
            content: [{ type: "image", attrs: { src: "https://test-bucket.s3.amazonaws.com/uploads/s1/d1/img1.png" } }],
        });

        // Simulate S3 helper throwing "Document not found" because another worker deleted d1
        permanentDeleteImagesMock.mock.mockImplementation(async () => {
            documentsStore.delete("d1");
            contentStore.delete("d1/main");
            throw new Error("Document not found");
        });

        const result = await purgeSpaceStepAction("valid-token-alice", "s1", 10);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.done, true);
        assert.strictEqual(result.processedCount, 0);
        assert.strictEqual(spacesStore.has("s1"), false);
    });

    test("concurrent permanentlyDeleteSpace calls across tabs both complete cleanly without false stall or not-found errors", async () => {
        documentsStore.set("d1", { id: "d1", spaceId: "s1", title: "Doc 1" });
        documentsStore.set("d2", { id: "d2", spaceId: "s1", title: "Doc 2" });
        documentsStore.set("d3", { id: "d3", spaceId: "s1", title: "Doc 3" });

        permanentDeleteImagesMock.mock.mockImplementation(async () => {});

        // Both tabs initiate permanentlyDeleteSpace concurrently
        await assert.doesNotReject(
            Promise.all([
                permanentlyDeleteSpace("s1"),
                permanentlyDeleteSpace("s1"),
            ])
        );

        assert.strictEqual(spacesStore.has("s1"), false);
        assert.strictEqual(documentsStore.has("d1"), false);
        assert.strictEqual(documentsStore.has("d2"), false);
        assert.strictEqual(documentsStore.has("d3"), false);
    });
});

describe("Permanent Purge Authorization & Validation", () => {
    beforeEach(() => {
        resetStores();
        spacesStore.set("s1", {
            id: "s1",
            name: "Test Space",
            ownerId: "alice",
            userIds: ["alice", "bob"],
            isPublic: false,
            deletedAt: "2026-01-01",
            deletedBy: "alice",
        });
    });

    test("rejects invalid space identifiers", async () => {
        await assert.rejects(
            purgeSpaceStepAction("valid-token-alice", ""),
            /Invalid space identifier/
        );
    });

    test("rejects unauthenticated requests (missing token)", async () => {
        await assert.rejects(
            purgeSpaceStepAction(undefined, "s1"),
            /Missing ID token/
        );
    });

    test("rejects invalid token", async () => {
        await assert.rejects(
            purgeSpaceStepAction("invalid-token", "s1"),
            /Invalid or expired ID token/
        );
    });

    test("rejects non-existent space", async () => {
        await assert.rejects(
            purgeSpaceStepAction("valid-token-alice", "missing-space"),
            /Space not found/
        );
    });

    test("rejects non-owner member (preserves owner-only authorization)", async () => {
        await assert.rejects(
            purgeSpaceStepAction("valid-token-bob", "s1"),
            /Permission denied: only space owner can permanently delete this space/
        );
        const space = spacesStore.get("s1");
        assert.strictEqual(space?.purgeState, undefined);
    });

    test("rejects non-member outsider", async () => {
        await assert.rejects(
            purgeSpaceStepAction("valid-token-charlie", "s1"),
            /Permission denied: only space owner can permanently delete this space/
        );
    });

    test("rejects active space that was not soft-deleted first", async () => {
        spacesStore.set("s1", {
            ...spacesStore.get("s1")!,
            deletedAt: null,
            deletedBy: null,
        });
        await assert.rejects(
            purgeSpaceStepAction("valid-token-alice", "s1"),
            /Cannot permanently delete an active space. Soft-delete it first./
        );
    });
});

describe("Permanent Purge Bounded Steps, Interruption & Retry", () => {
    beforeEach(() => {
        resetStores();
        spacesStore.set("s1", {
            id: "s1",
            name: "Bulk Space",
            ownerId: "alice",
            userIds: ["alice"],
            isPublic: false,
            deletedAt: "2026-01-01",
            deletedBy: "alice",
        });
    });

    test("sets persistent purgeState BEFORE deleting its first document", async () => {
        documentsStore.set("d1", { id: "d1", spaceId: "s1", title: "Doc 1" });

        // Verify initial state
        assert.strictEqual(spacesStore.get("s1")?.purgeState, undefined);

        const result = await purgeSpaceStepAction("valid-token-alice", "s1", 1);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.done, true); // only 1 doc, so now done

        // But during the transaction, purgeState was set
        assert.strictEqual(fakeAdminTransaction.update.mock.calls.length >= 1, true);
        const firstUpdateCall = fakeAdminTransaction.update.mock.calls[0];
        assert.strictEqual(firstUpdateCall.arguments[1].purgeState, "purging");
    });

    test("processes documents in bounded steps and preserves Space until all documents are removed", async () => {
        // Setup 5 documents in space
        for (let i = 1; i <= 5; i++) {
            documentsStore.set(`d${i}`, { id: `d${i}`, spaceId: "s1", title: `Doc ${i}` });
        }

        // Step 1: batchSize = 2
        const step1 = await purgeSpaceStepAction("valid-token-alice", "s1", 2);
        assert.strictEqual(step1.success, true);
        assert.strictEqual(step1.done, false);
        assert.strictEqual(step1.processedCount, 2);
        assert.strictEqual(documentsStore.size, 3);
        // Space record must NOT be deleted while documents remain!
        assert.strictEqual(spacesStore.has("s1"), true);
        assert.strictEqual(spacesStore.get("s1")?.purgeState, "purging");

        // Step 2: batchSize = 2
        const step2 = await purgeSpaceStepAction("valid-token-alice", "s1", 2);
        assert.strictEqual(step2.success, true);
        assert.strictEqual(step2.done, false);
        assert.strictEqual(step2.processedCount, 2);
        assert.strictEqual(documentsStore.size, 1);
        assert.strictEqual(spacesStore.has("s1"), true);

        // Step 3: batchSize = 2 (1 remaining)
        const step3 = await purgeSpaceStepAction("valid-token-alice", "s1", 2);
        assert.strictEqual(step3.success, true);
        assert.strictEqual(step3.done, true);
        assert.strictEqual(step3.processedCount, 1);
        assert.strictEqual(documentsStore.size, 0);

        // Space record is deleted ONLY after fresh check confirms 0 documents remain
        assert.strictEqual(spacesStore.has("s1"), false);
    });

    test("empty space (0 documents) transitions to purging and deletes space in 1 step", async () => {
        const result = await purgeSpaceStepAction("valid-token-alice", "s1");
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.done, true);
        assert.strictEqual(result.processedCount, 0);
        assert.strictEqual(spacesStore.has("s1"), false);
    });

    test("S3 cleanup failure retains Firestore records and leaves space in purgeState for retry", async () => {
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Doc with image",
            imageUrls: ["https://test-bucket.s3.amazonaws.com/uploads/s1/d1/img.png"],
        });

        // Configure S3 cleanup failure
        permanentDeleteImagesMock.mock.mockImplementationOnce(async () => {
            throw new Error("S3 network failure");
        });

        // Execution should fail with a useful generic error
        await assert.rejects(
            purgeSpaceStepAction("valid-token-alice", "s1", 10),
            /Failed to delete space images during permanent purge. Please try again./
        );

        // Crucial requirement: "If cleanup fails, retain the Firestore records needed for retry"
        assert.strictEqual(documentsStore.has("d1"), true);
        // Space record must be retained and in purgeState: "purging"
        assert.strictEqual(spacesStore.has("s1"), true);
        const space = spacesStore.get("s1");
        assert.strictEqual(space?.purgeState, "purging");
        assert.strictEqual(space?.deletedAt, "2026-01-01"); // visible to owner for retry!

        // Retry: S3 succeeds
        permanentDeleteImagesMock.mock.mockImplementationOnce(async () => {});
        const retryResult = await purgeSpaceStepAction("valid-token-alice", "s1", 10);
        assert.strictEqual(retryResult.success, true);
        assert.strictEqual(retryResult.done, true);
        assert.strictEqual(retryResult.processedCount, 1);

        // After successful retry, document and space are deleted
        assert.strictEqual(documentsStore.has("d1"), false);
        assert.strictEqual(spacesStore.has("s1"), false);
    });

    test("interrupted purge resumes safely without duplicating work", async () => {
        // Setup 3 documents
        documentsStore.set("d1", { id: "d1", spaceId: "s1", title: "Doc 1" });
        documentsStore.set("d2", { id: "d2", spaceId: "s1", title: "Doc 2" });
        documentsStore.set("d3", { id: "d3", spaceId: "s1", title: "Doc 3" });

        // Step 1: batchSize = 1 succeeds
        const step1 = await purgeSpaceStepAction("valid-token-alice", "s1", 1);
        assert.strictEqual(step1.processedCount, 1);
        assert.strictEqual(documentsStore.size, 2);

        // Simulation: interruption / network drop happens here. Space is still there with purgeState
        const space = spacesStore.get("s1");
        assert.strictEqual(space?.purgeState, "purging");

        // Step 2 (resume / retry): process remaining 2 documents
        const step2 = await purgeSpaceStepAction("valid-token-alice", "s1", 10);
        assert.strictEqual(step2.processedCount, 2);
        assert.strictEqual(step2.done, true);

        assert.strictEqual(documentsStore.size, 0);
        assert.strictEqual(spacesStore.has("s1"), false);
    });

    test("permanentlyDeleteSpace client wrapper processes steps to completion and reports progress", async () => {
        for (let i = 1; i <= 3; i++) {
            documentsStore.set(`d${i}`, { id: `d${i}`, spaceId: "s1", title: `Doc ${i}` });
        }

        const progressUpdates: { processedCount: number; done: boolean }[] = [];
        await permanentlyDeleteSpace("s1", (prog) => {
            progressUpdates.push({ ...prog });
        });

        assert.strictEqual(progressUpdates.length >= 1, true);
        const lastUpdate = progressUpdates[progressUpdates.length - 1];
        assert.strictEqual(lastUpdate.done, true);
        assert.strictEqual(lastUpdate.processedCount, 3);
        assert.strictEqual(spacesStore.has("s1"), false);
    });

    test("partial S3 failure in multi-document batch: deletes prior doc, retains failed doc and unreached doc", async () => {
        // Setup 3 documents
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Doc 1 with image",
            imageUrls: ["https://test-bucket.s3.amazonaws.com/uploads/s1/d1/img1.png"],
        });
        documentsStore.set("d2", {
            id: "d2",
            spaceId: "s1",
            title: "Doc 2 with failing image",
            imageUrls: ["https://test-bucket.s3.amazonaws.com/uploads/s1/d2/img2.png"],
        });
        documentsStore.set("d3", {
            id: "d3",
            spaceId: "s1",
            title: "Doc 3",
        });

        // d1 succeeds, d2 fails
        permanentDeleteImagesMock.mock.mockImplementation(async (_token: string, _sId: string, docId: string) => {
            if (docId === "d2") {
                throw new Error("S3 failure on d2");
            }
        });

        await assert.rejects(
            purgeSpaceStepAction("valid-token-alice", "s1", 10),
            /Failed to delete space images during permanent purge. Please try again./
        );

        // d1 was fully processed and deleted from Firestore
        assert.strictEqual(documentsStore.has("d1"), false);
        // d2 failed S3 cleanup, so its Firestore record MUST be retained for retry
        assert.strictEqual(documentsStore.has("d2"), true);
        // d3 was not yet reached, so its Firestore record MUST be retained
        assert.strictEqual(documentsStore.has("d3"), true);
        // Space must still exist in purgeState
        assert.strictEqual(spacesStore.has("s1"), true);
        assert.strictEqual(spacesStore.get("s1")?.purgeState, "purging");

        // Retry: d2 succeeds now
        permanentDeleteImagesMock.mock.mockImplementation(async () => {});
        const retryResult = await purgeSpaceStepAction("valid-token-alice", "s1", 10);
        assert.strictEqual(retryResult.success, true);
        assert.strictEqual(retryResult.done, true);
        assert.strictEqual(retryResult.processedCount, 2);

        // Everything is now deleted
        assert.strictEqual(documentsStore.has("d2"), false);
        assert.strictEqual(documentsStore.has("d3"), false);
        assert.strictEqual(spacesStore.has("s1"), false);
    });

    test("batchSize sanitization: clamps negative, zero, float, NaN, and values exceeding MAX_BATCH_SIZE", async () => {
        documentsStore.set("d1", { id: "d1", spaceId: "s1", title: "Doc 1" });
        documentsStore.set("d2", { id: "d2", spaceId: "s1", title: "Doc 2" });

        // NaN defaults safely to DEFAULT_BATCH_SIZE (10)
        // @ts-expect-error testing invalid batch size argument
        const nanResult = await purgeSpaceStepAction("valid-token-alice", "s1", NaN);
        assert.strictEqual(nanResult.success, true);
        assert.strictEqual(nanResult.done, true);
        assert.strictEqual(nanResult.processedCount, 2);

        // Reset and test with negative batch size: clamped to 1
        resetStores();
        spacesStore.set("s1", {
            id: "s1",
            name: "Clamp Space",
            ownerId: "alice",
            userIds: ["alice"],
            isPublic: false,
            deletedAt: "2026-01-01",
        });
        documentsStore.set("d1", { id: "d1", spaceId: "s1", title: "Doc 1" });
        documentsStore.set("d2", { id: "d2", spaceId: "s1", title: "Doc 2" });

        const negResult = await purgeSpaceStepAction("valid-token-alice", "s1", -5);
        assert.strictEqual(negResult.processedCount, 1);
        assert.strictEqual(negResult.done, false);

        // Float batch size: floored to integer
        const floatResult = await purgeSpaceStepAction("valid-token-alice", "s1", 1.9);
        assert.strictEqual(floatResult.processedCount, 1);
        assert.strictEqual(floatResult.done, true);
    });

    test("rejects invalid space identifiers across all space lifecycle actions", async () => {
        // @ts-expect-error testing invalid spaceId
        await assert.rejects(deleteSpace(""), /Invalid space identifier/);
        // @ts-expect-error testing invalid spaceId
        await assert.rejects(deleteSpace(null), /Invalid space identifier/);
        // @ts-expect-error testing invalid spaceId
        await assert.rejects(restoreSpace(""), /Invalid space identifier/);
        // @ts-expect-error testing invalid spaceId
        await assert.rejects(permanentlyDeleteSpace(""), /Invalid space identifier/);
    });

    test("permanentlyDeleteSpace detects stalled purge if step makes no progress while not done", async () => {
        resetStores();
        spacesStore.set("s1", {
            id: "s1",
            name: "Stall Space",
            ownerId: "alice",
            userIds: ["alice"],
            isPublic: false,
            deletedAt: "2026-01-01",
            purgeState: "purging",
        });

        // Mock document query to return a document with mismatched spaceId (skipped in loop)
        // while remaining check returns non-empty (done: false)
        const originalCollection = fakeFirestore.collection;
        fakeFirestore.collection = mock.fn((colName: string) => {
            if (colName === "documents") {
                return {
                    where: () => ({
                        limit: () => ({
                            get: async () => ({
                                empty: false,
                                docs: [{ id: "mismatched", data: () => ({ spaceId: "different-space" }) }],
                            }),
                        }),
                        get: async () => ({
                            empty: false,
                            docs: [{ id: "mismatched", data: () => ({ spaceId: "different-space" }) }],
                        }),
                    }),
                    doc: () => ({
                        get: async () => ({ exists: false, data: () => undefined }),
                        collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }),
                    }),
                } as unknown as ReturnType<typeof originalCollection>;
            }
            return originalCollection(colName);
        });

        try {
            await assert.rejects(
                permanentlyDeleteSpace("s1"),
                /Purge stalled: no documents could be processed/
            );
        } finally {
            fakeFirestore.collection = originalCollection;
        }
    });
});

describe("Unexpected Firebase, AWS, and Transaction Errors & Raw SDK Error Prevention", () => {
    let originalConsoleError: typeof console.error;
    let consoleErrorLogs: unknown[][];

    beforeEach(() => {
        resetStores();
        currentClientUser = {
            uid: "alice",
            getIdToken: async () => "valid-token-alice",
        };
        consoleErrorLogs = [];
        originalConsoleError = console.error;
        console.error = (...args: unknown[]) => {
            consoleErrorLogs.push(args);
        };
    });

    afterEach(() => {
        console.error = originalConsoleError;
    });

    test("purgeSpaceStepAction: step 2 unexpected Firestore transaction error logs server-side diagnostic error and throws generic actionable message without raw SDK exposure", async () => {
        spacesStore.set("s1", {
            id: "s1",
            name: "Space 1",
            ownerId: "alice",
            userIds: ["alice"],
            isPublic: false,
            deletedAt: "2026-01-01",
        });

        const originalRunTransaction = fakeFirestore.runTransaction;
        fakeFirestore.runTransaction = mock.fn(async () => {
            throw new Error("14 UNAVAILABLE: The Firestore service is currently unavailable");
        });

        try {
            await assert.rejects(
                purgeSpaceStepAction("valid-token-alice", "s1", 10),
                (err: Error) => {
                    assert.strictEqual(err.message, "Failed to permanently delete space. Please try again.");
                    assert.strictEqual(err.message.includes("14 UNAVAILABLE"), false);
                    return true;
                }
            );

            // Server-side diagnostic logging must have captured the underlying error
            assert.strictEqual(consoleErrorLogs.length, 1);
            const [logMsg, logErr] = consoleErrorLogs[0] as [string, Error];
            assert.match(logMsg, /Unexpected error during space purge step for space s1/);
            assert.match(logErr.message, /14 UNAVAILABLE/);
        } finally {
            fakeFirestore.runTransaction = originalRunTransaction;
        }
    });

    test("purgeSpaceStepAction: step 3 unexpected document query error logs server-side diagnostic error and throws generic actionable message", async () => {
        spacesStore.set("s1", {
            id: "s1",
            name: "Space 1",
            ownerId: "alice",
            userIds: ["alice"],
            isPublic: false,
            deletedAt: "2026-01-01",
            purgeState: "purging",
        });

        const originalCollection = fakeFirestore.collection;
        fakeFirestore.collection = mock.fn((colName: string) => {
            if (colName === "documents") {
                return {
                    where: () => ({
                        limit: () => ({
                            get: async () => {
                                throw new Error("4 DEADLINE_EXCEEDED: query timed out");
                            },
                        }),
                        get: async () => {
                            throw new Error("4 DEADLINE_EXCEEDED: query timed out");
                        },
                    }),
                    doc: () => ({
                        get: async () => ({ exists: false, data: () => undefined }),
                    }),
                } as unknown as ReturnType<typeof originalCollection>;
            }
            return originalCollection(colName);
        });

        try {
            await assert.rejects(
                purgeSpaceStepAction("valid-token-alice", "s1", 10),
                (err: Error) => {
                    assert.strictEqual(err.message, "Failed to permanently delete space. Please try again.");
                    assert.strictEqual(err.message.includes("DEADLINE_EXCEEDED"), false);
                    return true;
                }
            );

            assert.strictEqual(consoleErrorLogs.length, 1);
            const [logMsg, logErr] = consoleErrorLogs[0] as [string, Error];
            assert.match(logMsg, /Unexpected error during space purge step for space s1/);
            assert.match(logErr.message, /DEADLINE_EXCEEDED/);
        } finally {
            fakeFirestore.collection = originalCollection;
        }
    });

    test("purgeSpaceStepAction: step 3c document deletion transaction failure logs server-side and throws generic actionable message", async () => {
        spacesStore.set("s1", {
            id: "s1",
            name: "Space 1",
            ownerId: "alice",
            userIds: ["alice"],
            isPublic: false,
            deletedAt: "2026-01-01",
            purgeState: "purging",
        });
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Doc 1",
        });

        let transactionCallCount = 0;
        const originalRunTransaction = fakeFirestore.runTransaction;
        fakeFirestore.runTransaction = mock.fn(async (cb: (txn: typeof fakeAdminTransaction) => Promise<unknown>) => {
            transactionCallCount++;
            // Call 1 is step 2 (space state check)
            if (transactionCallCount === 1) {
                return await originalRunTransaction(cb);
            }
            // Call 2 is step 3c (document deletion)
            throw new Error("10 ABORTED: Transaction contention aborted at doc d1");
        });

        try {
            await assert.rejects(
                purgeSpaceStepAction("valid-token-alice", "s1", 10),
                (err: Error) => {
                    assert.strictEqual(err.message, "Failed to permanently delete space. Please try again.");
                    assert.strictEqual(err.message.includes("ABORTED"), false);
                    return true;
                }
            );

            assert.strictEqual(consoleErrorLogs.length, 1);
            const [logMsg, logErr] = consoleErrorLogs[0] as [string, Error];
            assert.match(logMsg, /Unexpected error during space purge step for space s1/);
            assert.match(logErr.message, /ABORTED/);
        } finally {
            fakeFirestore.runTransaction = originalRunTransaction;
        }
    });

    test("purgeSpaceStepAction: step 5 final space delete transaction failure logs server-side and throws generic actionable message", async () => {
        spacesStore.set("s1", {
            id: "s1",
            name: "Space 1",
            ownerId: "alice",
            userIds: ["alice"],
            isPublic: false,
            deletedAt: "2026-01-01",
            purgeState: "purging",
        });

        let transactionCallCount = 0;
        const originalRunTransaction = fakeFirestore.runTransaction;
        fakeFirestore.runTransaction = mock.fn(async (cb: (txn: typeof fakeAdminTransaction) => Promise<unknown>) => {
            transactionCallCount++;
            // Call 1 is step 2 (space state check)
            if (transactionCallCount === 1) {
                return await originalRunTransaction(cb);
            }
            // Call 2 is step 5 (final space delete)
            throw new Error("Internal Firestore error on space record delete");
        });

        try {
            await assert.rejects(
                purgeSpaceStepAction("valid-token-alice", "s1", 10),
                (err: Error) => {
                    assert.strictEqual(err.message, "Failed to permanently delete space. Please try again.");
                    assert.strictEqual(err.message.includes("Internal Firestore"), false);
                    return true;
                }
            );

            assert.strictEqual(consoleErrorLogs.length, 1);
            const [logMsg, logErr] = consoleErrorLogs[0] as [string, Error];
            assert.match(logMsg, /Unexpected error during space purge step for space s1/);
            assert.match(logErr.message, /Internal Firestore error/);
        } finally {
            fakeFirestore.runTransaction = originalRunTransaction;
        }
    });

    test("permanentlyDeleteSpace: client auth token failure produces generic actionable user message without raw SDK exposure", async () => {
        spacesStore.set("s1", {
            id: "s1",
            name: "Space 1",
            ownerId: "alice",
            userIds: ["alice"],
            isPublic: false,
            deletedAt: "2026-01-01",
            purgeState: "purging",
        });

        currentClientUser = {
            uid: "alice",
            getIdToken: async () => {
                throw new Error("FirebaseError: Firebase: Error (auth/network-request-failed).");
            },
        };

        await assert.rejects(
            permanentlyDeleteSpace("s1"),
            (err: Error) => {
                assert.strictEqual(err.message, "Failed to permanently delete space. Please try again.");
                assert.strictEqual(err.message.includes("auth/network-request-failed"), false);
                return true;
            }
        );

        assert.strictEqual(consoleErrorLogs.length, 1);
        assert.match(String(consoleErrorLogs[0][0]), /Failed to acquire auth token/);
    });

    test("preserves specific safe messages needed to explain retry and state throughout space purge flow", async () => {
        spacesStore.set("s1", {
            id: "s1",
            name: "Space 1",
            ownerId: "alice",
            userIds: ["alice"],
            isPublic: false,
            deletedAt: "2026-01-01",
            purgeState: "purging",
        });
        documentsStore.set("d1", {
            id: "d1",
            spaceId: "s1",
            title: "Doc with image",
            imageUrls: ["https://test-bucket.s3.amazonaws.com/uploads/s1/d1/img.png"],
        });

        // S3 image cleanup failure must NOT be masked by the generic error
        permanentDeleteImagesMock.mock.mockImplementationOnce(async () => {
            throw new Error("S3 failure");
        });

        await assert.rejects(
            purgeSpaceStepAction("valid-token-alice", "s1", 10),
            (err: Error) => {
                assert.strictEqual(
                    err.message,
                    "Failed to delete space images during permanent purge. Please try again."
                );
                return true;
            }
        );
    });

    test("getSafePurgeErrorMessage: sanitizes raw Firebase, AWS, transaction, and network errors into actionable messages while preserving safe retry messages", () => {
        // Raw Firebase SDK errors
        assert.strictEqual(
            getSafePurgeErrorMessage(new Error("FirebaseError: [code=unavailable] The service is unavailable")),
            "Failed to permanently delete space. You can retry."
        );
        assert.strictEqual(
            getSafePurgeErrorMessage(new Error("14 UNAVAILABLE: gRPC connection closed")),
            "Failed to permanently delete space. You can retry."
        );
        assert.strictEqual(
            getSafePurgeErrorMessage(new Error("Firebase: Error (auth/network-request-failed)")),
            "Failed to permanently delete space. You can retry."
        );

        // Raw AWS S3 SDK errors
        assert.strictEqual(
            getSafePurgeErrorMessage(new Error("S3ServiceException: NoSuchBucket: The specified bucket does not exist")),
            "Failed to permanently delete space. You can retry."
        );
        assert.strictEqual(
            getSafePurgeErrorMessage(new Error("AWS CredentialsProviderError: could not load credentials")),
            "Failed to permanently delete space. You can retry."
        );

        // Raw transaction internals
        assert.strictEqual(
            getSafePurgeErrorMessage(new Error("10 ABORTED: Transaction contention at docRef")),
            "Failed to permanently delete space. You can retry."
        );

        // Raw network errors
        assert.strictEqual(
            getSafePurgeErrorMessage(new Error("TypeError: fetch failed")),
            "Failed to permanently delete space. You can retry."
        );

        // Non-Error and empty inputs
        assert.strictEqual(
            getSafePurgeErrorMessage(null),
            "Failed to permanently delete space. You can retry."
        );
        assert.strictEqual(
            getSafePurgeErrorMessage(undefined),
            "Failed to permanently delete space. You can retry."
        );
        assert.strictEqual(
            getSafePurgeErrorMessage("random string"),
            "Failed to permanently delete space. You can retry."
        );
        assert.strictEqual(
            getSafePurgeErrorMessage(new Error("internal detail 12345")),
            "Failed to permanently delete space. You can retry."
        );

        // Safe retry and state messages PRESERVED
        assert.strictEqual(
            getSafePurgeErrorMessage(new Error("Failed to delete space images during permanent purge. Please try again.")),
            "Failed to delete space images during permanent purge. Please try again."
        );
        assert.strictEqual(
            getSafePurgeErrorMessage(new Error("Purge stalled: no documents could be processed. Please retry.")),
            "Purge stalled: no documents could be processed. Please retry."
        );
        assert.strictEqual(
            getSafePurgeErrorMessage(new Error("Permission denied: only space owner can permanently delete this space")),
            "Permission denied: only space owner can permanently delete this space"
        );
        assert.strictEqual(
            getSafePurgeErrorMessage(new Error("Cannot permanently delete an active space. Soft-delete it first.")),
            "Cannot permanently delete an active space. Soft-delete it first."
        );
        assert.strictEqual(
            getSafePurgeErrorMessage(new Error("You must be signed in to permanently delete a space.")),
            "You must be signed in to permanently delete a space."
        );
        assert.strictEqual(
            getSafePurgeErrorMessage(new Error("Invalid space identifier")),
            "Invalid space identifier"
        );
        assert.strictEqual(
            getSafePurgeErrorMessage(new Error("Space not found")),
            "Space not found"
        );
        assert.strictEqual(
            getSafePurgeErrorMessage(new Error("Space not found.")),
            "Space not found."
        );
    });

    test("purgeSpaceStepAction: step 2 unexpected missing space data logs server-side diagnostic error and throws generic actionable message", async () => {
        // Space exists in document store but data() returns undefined
        const originalCollection = fakeFirestore.collection;
        fakeFirestore.collection = mock.fn((colName: string) => {
            if (colName === "spaces") {
                return {
                    doc: () => ({
                        col: "spaces",
                        id: "s1",
                        path: "spaces/s1",
                        get: async () => ({ exists: true, data: () => undefined }),
                    }),
                } as unknown as ReturnType<typeof originalCollection>;
            }
            return originalCollection(colName);
        });

        const originalRunTransaction = fakeFirestore.runTransaction;
        fakeFirestore.runTransaction = mock.fn(async (cb: (txn: typeof fakeAdminTransaction) => Promise<unknown>) => {
            const mockTxn = {
                ...fakeAdminTransaction,
                get: async () => ({ exists: true, data: () => undefined }),
            };
            return await cb(mockTxn as unknown as typeof fakeAdminTransaction);
        });

        try {
            await assert.rejects(
                purgeSpaceStepAction("valid-token-alice", "s1", 10),
                (err: Error) => {
                    assert.strictEqual(err.message, "Failed to permanently delete space. Please try again.");
                    assert.strictEqual(err.message.includes("Space data is missing"), false);
                    return true;
                }
            );

            assert.strictEqual(consoleErrorLogs.length, 1);
            const [logMsg, logErr] = consoleErrorLogs[0] as [string, Error];
            assert.match(logMsg, /Unexpected error during space purge step for space s1/);
            assert.match(logErr.message, /Space data is missing/);
        } finally {
            fakeFirestore.collection = originalCollection;
            fakeFirestore.runTransaction = originalRunTransaction;
        }
    });

    test("permanentlyDeleteSpace: unexpected network or transport error during step call produces generic actionable user message without raw SDK exposure", async () => {
        spacesStore.set("s1", {
            id: "s1",
            name: "Space 1",
            ownerId: "alice",
            userIds: ["alice"],
            isPublic: false,
            deletedAt: "2026-01-01",
            purgeState: "purging",
        });

        const originalRunTransaction = fakeFirestore.runTransaction;
        fakeFirestore.runTransaction = mock.fn(async () => {
            throw new Error("TypeError: fetch failed: connection refused");
        });

        try {
            await assert.rejects(
                permanentlyDeleteSpace("s1"),
                (err: Error) => {
                    assert.strictEqual(err.message, "Failed to permanently delete space. Please try again.");
                    assert.strictEqual(err.message.includes("fetch failed"), false);
                    return true;
                }
            );
        } finally {
            fakeFirestore.runTransaction = originalRunTransaction;
        }
    });
});
