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

// ── Authorization mock ────────────────────────────────────────────────────────
const verifyIdTokenMock = mock.fn();

mock.module("../server/document-authorization", {
    exports: {
        verifyIdToken: verifyIdTokenMock,
        authorizeSpaceReader: mock.fn(),
        authorizeSpaceContributor: mock.fn(),
        authorizeDocumentCleanup: mock.fn(),
        getAndVerifyDocument: mock.fn(),
        getDocumentContentUrls: mock.fn(),
        extractCanonicalKey: mock.fn(),
        verifyLegacyKeyOwnership: mock.fn(),
    },
});

// ── In-memory stores & firebase-admin mocks ────────────────────────────────────
const spacesStore = new Map<string, Record<string, unknown>>();
const documentsStore = new Map<string, Record<string, unknown>>();

function createMockDocRef(colName: string, docId: string) {
    return {
        id: docId,
        path: `${colName}/${docId}`,
        get: mock.fn(async () => {
            const store = colName === "spaces" ? spacesStore : documentsStore;
            const data = store.get(docId);
            if (!data) return { exists: false, data: () => undefined, id: docId, ref: createMockDocRef(colName, docId) };
            return { exists: true, data: () => ({ ...data }), id: docId, ref: createMockDocRef(colName, docId) };
        }),
        update: mock.fn(async (data: Record<string, unknown>) => {
            const store = colName === "spaces" ? spacesStore : documentsStore;
            const existing = store.get(docId);
            if (existing) {
                store.set(docId, { ...existing, ...data });
            }
        }),
    };
}

interface MockQueryFilter {
    field: string;
    op: string;
    val: unknown;
}

function createMockQuery(colName: string, filters: MockQueryFilter[] = []) {
    const queryObj = {
        where: (field: string, op: string, val: unknown) => {
            return createMockQuery(colName, [...filters, { field, op, val }]);
        },
        get: async () => {
            const store = colName === "spaces" ? spacesStore : documentsStore;
            const matchedDocs: {
                id: string;
                ref: ReturnType<typeof createMockDocRef>;
                data: () => Record<string, unknown>;
            }[] = [];
            for (const [id, data] of store.entries()) {
                let matches = true;
                for (const filter of filters) {
                    if (filter.op === "==") {
                        if (data[filter.field] !== filter.val) {
                            matches = false;
                            break;
                        }
                    } else if (filter.op === "array-contains") {
                        const arr = data[filter.field];
                        if (!Array.isArray(arr) || !arr.includes(filter.val)) {
                            matches = false;
                            break;
                        }
                    }
                }
                if (matches) {
                    matchedDocs.push({
                        id,
                        ref: createMockDocRef(colName, id),
                        data: () => ({ ...data }),
                    });
                }
            }
            return { docs: matchedDocs, empty: matchedDocs.length === 0 };
        },
    };
    return queryObj;
}

interface MockGetTarget {
    get: () => Promise<unknown>;
}

interface MockTransactionContext {
    get: (target: MockGetTarget) => Promise<unknown>;
    update: (ref: { id: string; path: string }, data: Record<string, unknown>) => void;
    set: (ref: { id: string; path: string }, data: Record<string, unknown>) => void;
    delete: (ref: { id: string; path: string }) => void;
}

const fakeFirestore = {
    collection: mock.fn((colName: string) => ({
        doc: mock.fn((docId: string) => createMockDocRef(colName, docId)),
        where: mock.fn((field: string, op: string, val: unknown) => {
            return createMockQuery(colName, [{ field, op, val }]);
        }),
    })),
    runTransaction: mock.fn(async <T>(updateFunction: (tx: MockTransactionContext) => Promise<T>): Promise<T> => {
        const stagedUpdates: { ref: { id: string; path: string }; data: Record<string, unknown> }[] = [];
        const tx: MockTransactionContext = {
            get: mock.fn(async (target: MockGetTarget) => {
                return await target.get();
            }),
            update: mock.fn((ref: { id: string; path: string }, data: Record<string, unknown>) => {
                stagedUpdates.push({ ref, data });
            }),
            set: mock.fn((ref: { id: string; path: string }, data: Record<string, unknown>) => {
                stagedUpdates.push({ ref, data });
            }),
            delete: mock.fn((ref: { id: string; path: string }) => {
                stagedUpdates.push({ ref, data: { __deleted: true } });
            }),
        };
        const result = await updateFunction(tx);
        for (const update of stagedUpdates) {
            const existing = documentsStore.get(update.ref.id);
            if (existing) {
                documentsStore.set(update.ref.id, { ...existing, ...update.data });
            }
        }
        return result;
    }),
};

mock.module("../server/firebase-admin", {
    exports: {
        getAdminFirestore: () => fakeFirestore,
    },
});

mock.module("firebase-admin/firestore", {
    exports: {
        FieldValue: {
            serverTimestamp: () => ({ _methodName: "serverTimestamp" }),
        },
    },
});

// ── Client Firebase mocks for moveDocument wrapper tests ─────────────────────
const mockCurrentUser = {
    uid: "user-member",
    getIdToken: mock.fn(async () => "member-token"),
};

const mockAuthObj = {
    currentUser: mockCurrentUser as typeof mockCurrentUser | null,
};

mock.module("@/lib/firebase", {
    exports: {
        auth: mockAuthObj,
        db: {},
    },
});

mock.module("firebase/firestore", {
    exports: {
        collection: mock.fn(),
        doc: mock.fn(),
        getDoc: mock.fn(),
        getDocs: mock.fn(),
        updateDoc: mock.fn(),
        runTransaction: mock.fn(),
        writeBatch: mock.fn(),
        query: mock.fn(),
        orderBy: mock.fn(),
        where: mock.fn(),
        serverTimestamp: mock.fn(),
        DocumentSnapshot: class {},
        FirestoreError: class {},
    },
});

// Import actions dynamically after mock registration
const { moveDocumentAction } = await import("../actions/document-move");
const { moveDocument } = await import("../actions/document");

describe("moveDocumentAction Server-Authoritative Unit Tests", () => {
    const spaceId = "space-move-1";
    const ownerUid = "user-owner";
    const memberUid = "user-member";
    const strangerUid = "user-stranger";

    beforeEach(() => {
        spacesStore.clear();
        documentsStore.clear();
        verifyIdTokenMock.mock.resetCalls();

        // Default valid space
        spacesStore.set(spaceId, {
            name: "Test Space",
            ownerId: ownerUid,
            userIds: [memberUid],
            deletedAt: null,
        });

        // Default mock token verifier
        verifyIdTokenMock.mock.mockImplementation(async (token: string | undefined) => {
            if (!token || token === "invalid-token") {
                throw new Error("Invalid or expired ID token");
            }
            if (token === "stranger-token") {
                return { uid: strangerUid };
            }
            if (token === "owner-token") {
                return { uid: ownerUid };
            }
            return { uid: memberUid };
        });
    });

    describe("Argument validation & authentication", () => {
        test("rejects invalid or empty document ID", async () => {
            await assert.rejects(
                () => moveDocumentAction("member-token", "", null, spaceId),
                /Invalid source document ID/
            );
        });

        test("rejects non-string non-null destination parent ID", async () => {
            await assert.rejects(
                () => moveDocumentAction("member-token", "doc-1", 123 as unknown as string, spaceId),
                /Invalid destination parent ID/
            );
        });

        test("rejects invalid spaceId when provided as empty string", async () => {
            await assert.rejects(
                () => moveDocumentAction("member-token", "doc-1", null, ""),
                /Invalid space ID/
            );
        });

        test("rejects moving document under itself (docId === newParentId)", async () => {
            await assert.rejects(
                () => moveDocumentAction("member-token", "doc-1", "doc-1", spaceId),
                /Cannot move a document under itself/
            );
        });

        test("rejects unauthenticated caller", async () => {
            await assert.rejects(
                () => moveDocumentAction(undefined, "doc-1", null, spaceId),
                /Invalid or expired ID token/
            );
            await assert.rejects(
                () => moveDocumentAction("invalid-token", "doc-1", null, spaceId),
                /Invalid or expired ID token/
            );
        });
    });

    describe("Space & Document Preconditions", () => {
        test("rejects when source document does not exist", async () => {
            await assert.rejects(
                () => moveDocumentAction("member-token", "missing-doc", null, spaceId),
                /Document not found/
            );
        });

        test("rejects when document does not belong to specified spaceId", async () => {
            documentsStore.set("doc-1", {
                spaceId: "foreign-space",
                parentId: null,
                path: [],
                deleted: false,
            });
            await assert.rejects(
                () => moveDocumentAction("member-token", "doc-1", null, spaceId),
                /Document does not belong to the specified space/
            );
        });

        test("rejects when Space does not exist", async () => {
            documentsStore.set("doc-1", {
                spaceId: "nonexistent-space",
                parentId: null,
                path: [],
                deleted: false,
            });
            await assert.rejects(
                () => moveDocumentAction("member-token", "doc-1", null),
                /Space not found/
            );
        });

        test("rejects when Space is deleted", async () => {
            spacesStore.set("del-space", {
                name: "Deleted Space",
                ownerId: ownerUid,
                userIds: [memberUid],
                deletedAt: 123456789,
            });
            documentsStore.set("doc-1", {
                spaceId: "del-space",
                parentId: null,
                path: [],
                deleted: false,
            });
            await assert.rejects(
                () => moveDocumentAction("member-token", "doc-1", null),
                /Space is deleted/
            );
        });

        test("rejects unrelated user (not owner and not in userIds)", async () => {
            documentsStore.set("doc-1", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            await assert.rejects(
                () => moveDocumentAction("stranger-token", "doc-1", null, spaceId),
                /Permission denied: not a space contributor/
            );
        });

        test("rejects removed member (formerly contributor, but removed from userIds)", async () => {
            spacesStore.set("space-removed-member", {
                name: "Space with removed member",
                ownerId: ownerUid,
                userIds: ["other-member"], // caller "user-member" has been removed
                deletedAt: null,
            });
            documentsStore.set("doc-1", {
                spaceId: "space-removed-member",
                parentId: null,
                path: [],
                deleted: false,
            });
            await assert.rejects(
                () => moveDocumentAction("member-token", "doc-1", null, "space-removed-member"),
                /Permission denied: not a space contributor/
            );
        });

        test("rejects caller with only public read access (isPublic: true does not allow move)", async () => {
            spacesStore.set("public-space", {
                name: "Public Space",
                ownerId: ownerUid,
                userIds: [memberUid],
                isPublic: true,
                deletedAt: null,
            });
            documentsStore.set("doc-1", {
                spaceId: "public-space",
                parentId: null,
                path: [],
                deleted: false,
            });
            // strangerUid has public read access, but must be denied move permission
            await assert.rejects(
                () => moveDocumentAction("stranger-token", "doc-1", null, "public-space"),
                /Permission denied: not a space contributor/
            );
        });

        test("allows space owner even if ownerId is not in userIds list", async () => {
            documentsStore.set("doc-1", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            const result = await moveDocumentAction("owner-token", "doc-1", null, spaceId);
            assert.equal(result.success, true);
        });

        test("rejects when source document is soft-deleted", async () => {
            documentsStore.set("doc-1", {
                spaceId,
                parentId: null,
                path: [],
                deleted: true,
                deletedAt: 1000,
            });
            await assert.rejects(
                () => moveDocumentAction("member-token", "doc-1", null, spaceId),
                /Cannot move a deleted document/
            );
        });

        test("rejects when source document is pending permanent deletion", async () => {
            documentsStore.set("doc-1", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
                permanentDeletionClaim: { opId: "op-1", claimedBy: "user-1" },
            });
            await assert.rejects(
                () => moveDocumentAction("member-token", "doc-1", null, spaceId),
                /Cannot move a document that is pending permanent deletion/
            );
        });

        test("rejects when source document has an active lifecycle claim", async () => {
            documentsStore.set("doc-1", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
                lifecycleClaim: { opId: "op-1", claimedBy: "user-1" },
            });
            await assert.rejects(
                () => moveDocumentAction("member-token", "doc-1", null, spaceId),
                /Document is currently locked by another lifecycle operation/
            );
        });

        test("rejects when source document path contains cycle or is malformed", async () => {
            documentsStore.set("doc-1", {
                spaceId,
                parentId: "doc-1",
                path: ["doc-1"],
                deleted: false,
            });
            await assert.rejects(
                () => moveDocumentAction("member-token", "doc-1", null, spaceId),
                /Malformed active hierarchy: source document path is invalid/
            );
        });
    });

    describe("Same-Parent / No-Op handling", () => {
        test("succeeds with movedCount: 0 when document is already at root and newParentId is null", async () => {
            documentsStore.set("doc-1", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            const result = await moveDocumentAction("member-token", "doc-1", null, spaceId);
            assert.deepEqual(result, {
                success: true,
                movedCount: 0,
                destinationDepth: 0,
            });
        });

        test("succeeds with movedCount: 0 when document is already under target parent", async () => {
            documentsStore.set("parent-doc", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("child-doc", {
                spaceId,
                parentId: "parent-doc",
                path: ["parent-doc"],
                deleted: false,
            });
            const result = await moveDocumentAction("member-token", "child-doc", "parent-doc", spaceId);
            assert.deepEqual(result, {
                success: true,
                movedCount: 0,
                destinationDepth: 1,
            });
        });
    });

    describe("Destination Validation", () => {
        test("rejects when destination document does not exist", async () => {
            documentsStore.set("doc-1", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            await assert.rejects(
                () => moveDocumentAction("member-token", "doc-1", "missing-dest", spaceId),
                /Destination document not found/
            );
        });

        test("rejects cross-Space destination", async () => {
            documentsStore.set("doc-1", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("foreign-dest", {
                spaceId: "other-space",
                parentId: null,
                path: [],
                deleted: false,
            });
            await assert.rejects(
                () => moveDocumentAction("member-token", "doc-1", "foreign-dest", spaceId),
                /Cannot move document to a different space/
            );
        });

        test("rejects soft-deleted destination document", async () => {
            documentsStore.set("doc-1", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("dest-del", {
                spaceId,
                parentId: null,
                path: [],
                deleted: true,
                deletedAt: 5000,
            });
            await assert.rejects(
                () => moveDocumentAction("member-token", "doc-1", "dest-del", spaceId),
                /Destination document is deleted, claimed, or unavailable/
            );
        });

        test("rejects lifecycle-claimed destination document", async () => {
            documentsStore.set("doc-1", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("dest-claimed", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
                lifecycleClaim: { opId: "op-1", claimedBy: "user-1" },
            });
            await assert.rejects(
                () => moveDocumentAction("member-token", "doc-1", "dest-claimed", spaceId),
                /Destination document is locked by another lifecycle operation/
            );
        });

        test("rejects permanent-deletion-claimed destination document", async () => {
            documentsStore.set("doc-1", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("dest-perm", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
                permanentDeletionClaim: { opId: "op-1", claimedBy: "user-1" },
            });
            await assert.rejects(
                () => moveDocumentAction("member-token", "doc-1", "dest-perm", spaceId),
                /Destination document is locked by another lifecycle operation/
            );
        });

        test("rejects destination whose path already contains source doc (cycle detection)", async () => {
            documentsStore.set("doc-root", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("doc-child", {
                spaceId,
                parentId: "doc-root",
                path: ["doc-root"],
                deleted: false,
            });
            // Trying to move doc-root under its own child doc-child
            await assert.rejects(
                () => moveDocumentAction("member-token", "doc-root", "doc-child", spaceId),
                /Cannot move a document under its own descendant/
            );
        });

        test("rejects when destination ancestor is deleted or claimed", async () => {
            documentsStore.set("grandparent", {
                spaceId,
                parentId: null,
                path: [],
                deleted: true, // soft-deleted ancestor!
            });
            documentsStore.set("parent", {
                spaceId,
                parentId: "grandparent",
                path: ["grandparent"],
                deleted: false,
            });
            documentsStore.set("doc-to-move", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            await assert.rejects(
                () => moveDocumentAction("member-token", "doc-to-move", "parent", spaceId),
                /Destination ancestor document is deleted, claimed, or unavailable/
            );
        });
    });

    describe("Subtree, Descendant Validation & Claims", () => {
        test("rejects move if active descendant has lifecycleClaim", async () => {
            documentsStore.set("root", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("child", {
                spaceId,
                parentId: "root",
                path: ["root"],
                deleted: false,
                lifecycleClaim: { opId: "op-x", claimedBy: "user-x" },
            });
            documentsStore.set("dest", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });

            await assert.rejects(
                () => moveDocumentAction("member-token", "root", "dest", spaceId),
                /A subdocument is currently locked by another lifecycle operation/
            );
        });

        test("rejects move if active descendant has permanentDeletionClaim", async () => {
            documentsStore.set("root", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("child", {
                spaceId,
                parentId: "root",
                path: ["root"],
                deleted: false,
                permanentDeletionClaim: { opId: "op-x", claimedBy: "user-x" },
            });
            documentsStore.set("dest", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });

            await assert.rejects(
                () => moveDocumentAction("member-token", "root", "dest", spaceId),
                /A subdocument is pending permanent deletion/
            );
        });

        test("rejects move if active descendant parentId references external or missing document", async () => {
            documentsStore.set("root", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("child", {
                spaceId,
                parentId: "external-parent",
                path: ["root"],
                deleted: false,
            });
            documentsStore.set("dest", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });

            await assert.rejects(
                () => moveDocumentAction("member-token", "root", "dest", spaceId),
                /Malformed active hierarchy: descendant parentId references external or missing document/
            );
        });

        test("rejects move if active descendant has malformed path not matching parentId", async () => {
            documentsStore.set("root", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("child-1", {
                spaceId,
                parentId: "root",
                path: ["root"],
                deleted: false,
            });
            documentsStore.set("child-2", {
                spaceId,
                parentId: "child-1",
                // Path terminal is "root", but parentId is "child-1" -> mismatch!
                path: ["root"],
                deleted: false,
            });
            documentsStore.set("dest", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });

            await assert.rejects(
                () => moveDocumentAction("member-token", "root", "dest", spaceId),
                /Malformed active hierarchy: descendant path does not match parentId/
            );
        });

        test("rejects move when destination is inside the active descendants (cycle via query)", async () => {
            documentsStore.set("root", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("child", {
                spaceId,
                parentId: "root",
                path: ["root"],
                deleted: false,
            });
            // Try to move root under child (child is an active descendant)
            await assert.rejects(
                () => moveDocumentAction("member-token", "root", "child", spaceId),
                /Cannot move a document under its own descendant/
            );
        });

        test("rejects move if active source has malformed non-empty path with null parentId", async () => {
            documentsStore.set("root", {
                spaceId,
                parentId: null,
                path: ["invalid-parent"],
                deleted: false,
            });
            await assert.rejects(
                () => moveDocumentAction("member-token", "root", null, spaceId),
                /Malformed active hierarchy: root document path must be empty/
            );
        });

        test("rejects move if active source has parentId not matching terminal path", async () => {
            documentsStore.set("doc-mismatch", {
                spaceId,
                parentId: "parent-a",
                path: ["parent-b"],
                deleted: false,
            });
            await assert.rejects(
                () => moveDocumentAction("member-token", "doc-mismatch", null, spaceId),
                /Malformed active hierarchy: source path does not match parentId/
            );
        });

        test("rejects move if destination has malformed non-empty path with null parentId", async () => {
            documentsStore.set("root", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("dest-bad", {
                spaceId,
                parentId: null,
                path: ["bogus-ancestor"],
                deleted: false,
            });
            await assert.rejects(
                () => moveDocumentAction("member-token", "root", "dest-bad", spaceId),
                /Destination document has malformed hierarchy/
            );
        });

        test("rejects move if destination ancestor has malformed path or cycle", async () => {
            documentsStore.set("root", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("anc-bad", {
                spaceId,
                parentId: null,
                path: ["anc-bad"], // cycle in ancestor
                deleted: false,
            });
            documentsStore.set("dest-child", {
                spaceId,
                parentId: "anc-bad",
                path: ["anc-bad"],
                deleted: false,
            });
            await assert.rejects(
                () => moveDocumentAction("member-token", "root", "dest-child", spaceId),
                /Destination ancestor document has malformed hierarchy/
            );
        });

        test("rejects move if active descendant has duplicate IDs in its path", async () => {
            documentsStore.set("root", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("child-dup", {
                spaceId,
                parentId: "root",
                path: ["root", "root"],
                deleted: false,
            });
            documentsStore.set("dest", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            await assert.rejects(
                () => moveDocumentAction("member-token", "root", "dest", spaceId),
                /Malformed active hierarchy: cycle detected in descendant path/
            );
        });
    });

    describe("Depth Limit Validation (4 levels maximum)", () => {
        test("rejects move when destination depth + subtree height exceeds 4", async () => {
            // Destination at level 3 (path: [d1, d2]) -> destinationDepth = 3
            // Moving a subtree with height 2 (root + child) -> 3 + 2 = 5 > 4 (disallowed)
            documentsStore.set("d1", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("d2", {
                spaceId,
                parentId: "d1",
                path: ["d1"],
                deleted: false,
            });
            documentsStore.set("d3", {
                spaceId,
                parentId: "d2",
                path: ["d1", "d2"],
                deleted: false,
            });

            documentsStore.set("s-root", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("s-child", {
                spaceId,
                parentId: "s-root",
                path: ["s-root"],
                deleted: false,
            });

            await assert.rejects(
                () => moveDocumentAction("member-token", "s-root", "d3", spaceId),
                /exceeds the maximum hierarchy depth of 4 levels/
            );
        });
    });

    describe("Valid Document & Subtree Moves", () => {
        test("valid root-level document move (leaf) to another parent", async () => {
            documentsStore.set("target-parent", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("source-leaf", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });

            const result = await moveDocumentAction("member-token", "source-leaf", "target-parent", spaceId);
            assert.deepEqual(result, {
                success: true,
                movedCount: 1,
                destinationDepth: 1,
            });

            const updated = documentsStore.get("source-leaf")!;
            assert.equal(updated.parentId, "target-parent");
            assert.deepEqual(updated.path, ["target-parent"]);
            assert.ok(updated.updatedAt);
        });

        test("valid move to Space root (newParentId is null)", async () => {
            documentsStore.set("parent-doc", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("child-doc", {
                spaceId,
                parentId: "parent-doc",
                path: ["parent-doc"],
                deleted: false,
            });
            documentsStore.set("grandchild-doc", {
                spaceId,
                parentId: "child-doc",
                path: ["parent-doc", "child-doc"],
                deleted: false,
            });

            // Move child-doc to root
            const result = await moveDocumentAction("member-token", "child-doc", null, spaceId);
            assert.deepEqual(result, {
                success: true,
                movedCount: 2,
                destinationDepth: 0,
            });

            const updatedChild = documentsStore.get("child-doc")!;
            assert.equal(updatedChild.parentId, null);
            assert.deepEqual(updatedChild.path, []);

            const updatedGrandchild = documentsStore.get("grandchild-doc")!;
            assert.equal(updatedGrandchild.parentId, "child-doc");
            assert.deepEqual(updatedGrandchild.path, ["child-doc"]);
        });

        test("valid nested subtree move beneath another document", async () => {
            // Hierarchy:
            // DestDoc (root) -> path: []
            //
            // SourceDoc (root) -> path: []
            //   ChildDoc1 -> parentId: SourceDoc, path: [SourceDoc]
            //     GrandchildDoc1 -> parentId: ChildDoc1, path: [SourceDoc, ChildDoc1]
            //   ChildDoc2 -> parentId: SourceDoc, path: [SourceDoc]
            documentsStore.set("dest-doc", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("source-doc", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("child-1", {
                spaceId,
                parentId: "source-doc",
                path: ["source-doc"],
                deleted: false,
            });
            documentsStore.set("grandchild-1", {
                spaceId,
                parentId: "child-1",
                path: ["source-doc", "child-1"],
                deleted: false,
            });
            documentsStore.set("child-2", {
                spaceId,
                parentId: "source-doc",
                path: ["source-doc"],
                deleted: false,
            });

            const result = await moveDocumentAction("member-token", "source-doc", "dest-doc", spaceId);
            assert.deepEqual(result, {
                success: true,
                movedCount: 4,
                destinationDepth: 1,
            });

            // Verify source
            const sDoc = documentsStore.get("source-doc")!;
            assert.equal(sDoc.parentId, "dest-doc");
            assert.deepEqual(sDoc.path, ["dest-doc"]);

            // Verify child-1
            const c1Doc = documentsStore.get("child-1")!;
            assert.equal(c1Doc.parentId, "source-doc"); // Descendant parentId remains intact
            assert.deepEqual(c1Doc.path, ["dest-doc", "source-doc"]);

            // Verify grandchild-1
            const gc1Doc = documentsStore.get("grandchild-1")!;
            assert.equal(gc1Doc.parentId, "child-1"); // Descendant parentId remains intact
            assert.deepEqual(gc1Doc.path, ["dest-doc", "source-doc", "child-1"]);

            // Verify child-2
            const c2Doc = documentsStore.get("child-2")!;
            assert.equal(c2Doc.parentId, "source-doc");
            assert.deepEqual(c2Doc.path, ["dest-doc", "source-doc"]);
        });

        test("soft-deleted historical descendants remain untouched", async () => {
            documentsStore.set("dest-doc", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("source-doc", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("active-child", {
                spaceId,
                parentId: "source-doc",
                path: ["source-doc"],
                deleted: false,
            });
            // Historical soft-deleted document in Trash that previously belonged to source-doc
            documentsStore.set("deleted-historical-child", {
                spaceId,
                parentId: "source-doc",
                path: ["source-doc"],
                deleted: true,
                deletedAt: 9999,
            });

            const result = await moveDocumentAction("member-token", "source-doc", "dest-doc", spaceId);
            assert.equal(result.movedCount, 2); // Only source-doc and active-child

            // Active documents updated
            assert.deepEqual(documentsStore.get("source-doc")!.path, ["dest-doc"]);
            assert.deepEqual(documentsStore.get("active-child")!.path, ["dest-doc", "source-doc"]);

            // Deleted historical document is completely untouched
            const histChild = documentsStore.get("deleted-historical-child")!;
            assert.equal(histChild.deleted, true);
            assert.deepEqual(histChild.path, ["source-doc"]);
            assert.equal(histChild.parentId, "source-doc");
        });
    });

    describe("Transactional Rollback on Failure", () => {
        test("persists no partial writes if validation fails midway", async () => {
            documentsStore.set("dest-doc", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("source-doc", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("child-ok", {
                spaceId,
                parentId: "source-doc",
                path: ["source-doc"],
                deleted: false,
            });
            // Second child is claimed by a lifecycle operation, which causes validation to fail
            documentsStore.set("child-bad", {
                spaceId,
                parentId: "source-doc",
                path: ["source-doc"],
                deleted: false,
                lifecycleClaim: { opId: "lock" },
            });

            await assert.rejects(
                () => moveDocumentAction("member-token", "source-doc", "dest-doc", spaceId)
            );

            // Verify absolutely nothing changed in the store
            const sDoc = documentsStore.get("source-doc")!;
            assert.equal(sDoc.parentId, null);
            assert.deepEqual(sDoc.path, []);

            const cOk = documentsStore.get("child-ok")!;
            assert.equal(cOk.parentId, "source-doc");
            assert.deepEqual(cOk.path, ["source-doc"]);
        });
    });

    describe("Real Broad Tree Topologies", () => {
        test("17-document branching tree (1 root + 8 branches + 8 leaves) moves seamlessly", async () => {
            const destId = "target-dest";
            documentsStore.set(destId, {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });

            const rootId = "broad-17-root";
            documentsStore.set(rootId, {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });

            const branchCount = 8;
            const branchIds: string[] = [];
            const leafIds: { id: string; branchId: string }[] = [];

            for (let b = 1; b <= branchCount; b++) {
                const bId = `b17-${b}`;
                branchIds.push(bId);
                documentsStore.set(bId, {
                    spaceId,
                    parentId: rootId,
                    path: [rootId],
                    deleted: false,
                });

                const lId = `b17-${b}-l`;
                leafIds.push({ id: lId, branchId: bId });
                documentsStore.set(lId, {
                    spaceId,
                    parentId: bId,
                    path: [rootId, bId],
                    deleted: false,
                });
            }

            const result = await moveDocumentAction("member-token", rootId, destId, spaceId);
            assert.deepEqual(result, {
                success: true,
                movedCount: 17,
                destinationDepth: 1,
            });

            // Verify root
            const rootDoc = documentsStore.get(rootId)!;
            assert.equal(rootDoc.parentId, destId);
            assert.deepEqual(rootDoc.path, [destId]);

            // Verify all branches
            for (const bId of branchIds) {
                const bDoc = documentsStore.get(bId)!;
                assert.equal(bDoc.parentId, rootId);
                assert.deepEqual(bDoc.path, [destId, rootId]);
            }

            // Verify all leaves
            for (const { id: lId, branchId } of leafIds) {
                const lDoc = documentsStore.get(lId)!;
                assert.equal(lDoc.parentId, branchId);
                assert.deepEqual(lDoc.path, [destId, rootId, branchId]);
            }
        });

        test("31-document branching tree (1 root + 6 branches + 24 leaves) moves beneath valid destination", async () => {
            const destId = "target-dest-31";
            documentsStore.set(destId, {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });

            const rootId = "broad-31-root";
            documentsStore.set(rootId, {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });

            const branchCount = 6;
            const leavesPerBranch = 4;
            const branchIds: string[] = [];
            const leafIds: { id: string; branchId: string }[] = [];

            for (let b = 1; b <= branchCount; b++) {
                const bId = `b31-${b}`;
                branchIds.push(bId);
                documentsStore.set(bId, {
                    spaceId,
                    parentId: rootId,
                    path: [rootId],
                    deleted: false,
                });

                for (let l = 1; l <= leavesPerBranch; l++) {
                    const lId = `b31-${b}-l${l}`;
                    leafIds.push({ id: lId, branchId: bId });
                    documentsStore.set(lId, {
                        spaceId,
                        parentId: bId,
                        path: [rootId, bId],
                        deleted: false,
                    });
                }
            }

            const result = await moveDocumentAction("member-token", rootId, destId, spaceId);
            assert.deepEqual(result, {
                success: true,
                movedCount: 31,
                destinationDepth: 1,
            });

            // Verify root
            const rootDoc = documentsStore.get(rootId)!;
            assert.equal(rootDoc.parentId, destId);
            assert.deepEqual(rootDoc.path, [destId]);

            // Verify all branches
            for (const bId of branchIds) {
                const bDoc = documentsStore.get(bId)!;
                assert.equal(bDoc.parentId, rootId);
                assert.deepEqual(bDoc.path, [destId, rootId]);
            }

            // Verify all leaves
            for (const { id: lId, branchId } of leafIds) {
                const lDoc = documentsStore.get(lId)!;
                assert.equal(lDoc.parentId, branchId);
                assert.deepEqual(lDoc.path, [destId, rootId, branchId]);
            }
        });
    });

    describe("moveDocument Browser Client Wrapper Unit Tests", () => {
        beforeEach(() => {
            mockAuthObj.currentUser = mockCurrentUser;
            mockCurrentUser.getIdToken.mock.resetCalls();
        });

        test("rejects when user is not authenticated (auth.currentUser is null)", async () => {
            mockAuthObj.currentUser = null;
            await assert.rejects(
                () => moveDocument("doc-1", null),
                /Authentication required/
            );
        });

        test("rejects when document ID is missing or invalid", async () => {
            await assert.rejects(
                () => moveDocument("", null),
                /Invalid document ID/
            );
            await assert.rejects(
                () => moveDocument(null as unknown as string, null),
                /Invalid document ID/
            );
        });

        test("rejects when destination parent ID is not null and not a string", async () => {
            await assert.rejects(
                () => moveDocument("doc-1", 123 as unknown as string),
                /Invalid parent ID/
            );
        });

        test("obtains fresh ID token with forceRefresh = true and executes move successfully", async () => {
            documentsStore.set("target-parent", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("source-leaf", {
                spaceId,
                parentId: null,
                path: [],
                deleted: false,
            });

            await moveDocument("source-leaf", "target-parent");

            // Verify forceRefresh was true
            assert.equal(mockCurrentUser.getIdToken.mock.callCount(), 1);
            assert.equal(mockCurrentUser.getIdToken.mock.calls[0].arguments[0], true);

            const updated = documentsStore.get("source-leaf")!;
            assert.equal(updated.parentId, "target-parent");
            assert.deepEqual(updated.path, ["target-parent"]);
        });

        test("passes through known safe validation errors transparently", async () => {
            documentsStore.set("d1", { spaceId, parentId: null, path: [], deleted: false });
            documentsStore.set("d2", { spaceId, parentId: "d1", path: ["d1"], deleted: false });
            documentsStore.set("d3", { spaceId, parentId: "d2", path: ["d1", "d2"], deleted: false });
            documentsStore.set("s-root", { spaceId, parentId: null, path: [], deleted: false });
            documentsStore.set("s-child", { spaceId, parentId: "s-root", path: ["s-root"], deleted: false });

            // Depth overflow
            await assert.rejects(
                () => moveDocument("s-root", "d3"),
                /Moving this document exceeds the maximum hierarchy depth of 4 levels/
            );
        });

        test("sanitizes unexpected internal errors to safe generic user message", async () => {
            // Document with internal corrupt data
            documentsStore.set("doc-corrupt", {
                spaceId,
                parentId: null,
                path: ["invalid-internal-path"],
                deleted: false,
            });

            await assert.rejects(
                () => moveDocument("doc-corrupt", null),
                (err: Error) => {
                    assert.equal(err.message, "Failed to move document. Please try again.");
                    return true;
                }
            );
        });
    });
});
