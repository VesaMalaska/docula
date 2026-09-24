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

// ── In-memory stores & firebase-admin mocks ────────────────────────────────────
const spacesStore = new Map<string, Record<string, unknown>>();
const documentsStore = new Map<string, Record<string, unknown>>();

const batchUpdates: { path: string; data: Record<string, unknown> }[] = [];
const batchCommits: { count: number }[] = [];

function applyDataWithFieldValueDelete(
    existing: Record<string, unknown> | undefined,
    data: Record<string, unknown>
): Record<string, unknown> {
    const updated = { ...(existing || {}) };
    for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === "object" && (v as { _methodName?: string })._methodName === "delete") {
            delete updated[k];
        } else {
            updated[k] = v;
        }
    }
    return updated;
}

const fakeBatch = {
    update: mock.fn((ref: { path: string; id: string }, data: Record<string, unknown>) => {
        batchUpdates.push({ path: ref.path, data });
        const existing = documentsStore.get(ref.id);
        if (existing) {
            documentsStore.set(ref.id, applyDataWithFieldValueDelete(existing, data));
        }
    }),
    delete: mock.fn((ref: { path: string }) => {
        batchUpdates.push({ path: ref.path, data: { __deleted: true } });
    }),
    commit: mock.fn(async () => {
        batchCommits.push({ count: batchUpdates.length });
    }),
};

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
                store.set(docId, applyDataWithFieldValueDelete(existing, data));
            }
        }),
    };
}

interface MockDocSnapshot {
    exists: boolean;
    data: () => Record<string, unknown> | undefined;
    id: string;
    ref: unknown;
}

interface MockTransactionDocRef {
    id: string;
    path: string;
    get: () => Promise<MockDocSnapshot>;
}

interface MockTransactionContext {
    get: (ref: MockTransactionDocRef) => Promise<MockDocSnapshot>;
    update: (ref: { id: string; path: string }, data: Record<string, unknown>) => void;
    set: (ref: { id: string; path: string }, data: Record<string, unknown>) => void;
    delete: (ref: { id: string; path: string }) => void;
}

const fakeFirestore = {
    collection: mock.fn((colName: string) => ({
        doc: mock.fn((docId: string) => createMockDocRef(colName, docId)),
        where: mock.fn((field: string, op: string, val: unknown) => {
            // Support chained .where()
            const filters: { field: string; op: string; val: unknown }[] = [{ field, op, val }];
            const queryObj = {
                where: mock.fn((f: string, o: string, v: unknown) => {
                    filters.push({ field: f, op: o, val: v });
                    return queryObj;
                }),
                get: mock.fn(async () => {
                    const matchedDocs: { id: string; ref: ReturnType<typeof createMockDocRef>; data: () => Record<string, unknown> }[] = [];
                    for (const [id, data] of documentsStore.entries()) {
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
                }),
            };
            return queryObj;
        }),
    })),
    batch: mock.fn(() => fakeBatch),
    runTransaction: mock.fn(async <T>(updateFunction: (tx: MockTransactionContext) => Promise<T>): Promise<T> => {
        const stagedUpdates: { ref: { id: string; path: string }; data: Record<string, unknown> }[] = [];
        const tx: MockTransactionContext = {
            get: mock.fn(async (ref: MockTransactionDocRef) => {
                return await ref.get();
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
            batchUpdates.push({ path: update.ref.path, data: update.data });
            const existing = documentsStore.get(update.ref.id);
            if (existing) {
                documentsStore.set(update.ref.id, applyDataWithFieldValueDelete(existing, update.data));
            }
        }
        return result;
    }),
};

mock.module("../server/firebase-admin", {
    exports: {
        getAdminFirestore: () => fakeFirestore,
        getAdminAuth: () => ({}),
    },
});

mock.module("firebase-admin/firestore", {
    exports: {
        FieldValue: {
            serverTimestamp: () => ({ _methodName: "serverTimestamp" }),
            delete: () => ({ _methodName: "delete" }),
        },
    },
});

const { MAX_LIFECYCLE_DOCUMENT_LIMIT, MAX_LIFECYCLE_IMAGE_LIMIT } = await import("../utils/hierarchy.ts");

// Import the actions under test dynamically after mocks and loader registration
const {
    softDeleteDocumentAction,
    restoreDocumentAction,
    getDocumentDescendantSummaryAction,
} = await import("../actions/document-soft-delete");

const {
    evaluateRestoreResult,
    createInitialRestorePayload,
    formatRestorePayload,
    resolvePickerDestination,
    handlePickerCancel,
    canSelectDestination,
    isDestinationConfirmationEnabled,
} = await import("../utils/trash-restore.ts");
const {
    calculateDeletedDocumentSubtreeHeight,
} = await import("../utils/hierarchy.ts");

describe("Document Soft Delete & Grouped Restoration Lifecycle", () => {
    const spaceId = "space-test-1";
    const callerUid = "user-alice";

    beforeEach(() => {
        spacesStore.clear();
        documentsStore.clear();
        batchUpdates.length = 0;
        batchCommits.length = 0;

        verifyIdTokenMock.mock.resetCalls();
        authorizeSpaceContributorMock.mock.resetCalls();
        getDocumentContentUrlsMock.mock.resetCalls();
        softDeleteImagesMock.mock.resetCalls();
        restoreImagesMock.mock.resetCalls();

        // Defaults
        verifyIdTokenMock.mock.mockImplementation(async (token: string | undefined) => {
            if (!token || token === "invalid") throw new Error("Invalid or expired ID token");
            return { uid: callerUid };
        });

        authorizeSpaceContributorMock.mock.mockImplementation(async (uid: string, sId: string) => {
            const space = spacesStore.get(sId);
            if (!space) throw new Error("Space not found");
            if (space.deletedAt) throw new Error("Space is deleted");
            return space;
        });

        getDocumentContentUrlsMock.mock.mockImplementation(async () => []);
        softDeleteImagesMock.mock.mockImplementation(async () => {});
        restoreImagesMock.mock.mockImplementation(async () => {});

        // Setup active space
        spacesStore.set(spaceId, {
            id: spaceId,
            name: "Engineering Docs",
            ownerId: "space-owner-uid",
            userIds: [callerUid, "space-owner-uid"],
            deletedAt: null,
        });
    });

    describe("Descendant Summary Action", () => {
        test("returns exact descendant count and total affected count", async () => {
            documentsStore.set("doc-root", { spaceId, title: "Root", parentId: null, path: [] });
            documentsStore.set("doc-child1", { spaceId, title: "Child 1", parentId: "doc-root", path: ["doc-root"] });
            documentsStore.set("doc-child2", { spaceId, title: "Child 2", parentId: "doc-root", path: ["doc-root"] });
            documentsStore.set("doc-grandchild", { spaceId, title: "Grandchild", parentId: "doc-child1", path: ["doc-root", "doc-child1"] });

            const summary = await getDocumentDescendantSummaryAction("token", spaceId, "doc-root");
            assert.equal(summary.descendantCount, 3);
            assert.equal(summary.totalAffectedCount, 4);
        });

        test("returns zero descendants for a leaf document", async () => {
            documentsStore.set("doc-leaf", { spaceId, title: "Leaf", parentId: null, path: [] });

            const summary = await getDocumentDescendantSummaryAction("token", spaceId, "doc-leaf");
            assert.equal(summary.descendantCount, 0);
            assert.equal(summary.totalAffectedCount, 1);
        });

        test("rejects invalid request identifiers", async () => {
            await assert.rejects(
                () => getDocumentDescendantSummaryAction("token", "", "doc-leaf"),
                /Invalid request identifiers/
            );
        });
    });

    describe("Strategy A: Keep and Move Descendants", () => {
        test("root parent with direct children moves direct children to Space root", async () => {
            documentsStore.set("doc-root", { spaceId, title: "Root", parentId: null, path: [] });
            documentsStore.set("child-1", { spaceId, title: "Child 1", parentId: "doc-root", path: ["doc-root"] });
            documentsStore.set("child-2", { spaceId, title: "Child 2", parentId: "doc-root", path: ["doc-root"] });

            const result = await softDeleteDocumentAction("token", spaceId, "doc-root", "move-descendants", null);
            assert.equal(result.success, true);
            assert.equal(result.affectedCount, 3);

            const deletedParent = documentsStore.get("doc-root")!;
            assert.equal(deletedParent.deleted, true);
            assert.equal(deletedParent.lifecycleClaim, null);

            const c1 = documentsStore.get("child-1")!;
            assert.equal(c1.parentId, null);
            assert.deepEqual(c1.path, []);

            const c2 = documentsStore.get("child-2")!;
            assert.equal(c2.parentId, null);
            assert.deepEqual(c2.path, []);
        });

        test("nested parent moves direct children to former parent and updates paths", async () => {
            documentsStore.set("doc-grandparent", { spaceId, title: "Grandparent", parentId: null, path: [] });
            documentsStore.set("doc-parent", { spaceId, title: "Parent", parentId: "doc-grandparent", path: ["doc-grandparent"] });
            documentsStore.set("doc-child", { spaceId, title: "Child", parentId: "doc-parent", path: ["doc-grandparent", "doc-parent"] });
            documentsStore.set("doc-grandchild", { spaceId, title: "Grandchild", parentId: "doc-child", path: ["doc-grandparent", "doc-parent", "doc-child"] });

            const result = await softDeleteDocumentAction(
                "token",
                spaceId,
                "doc-parent",
                "move-descendants",
                "doc-grandparent"
            );
            assert.equal(result.success, true);
            assert.equal(result.affectedCount, 3);

            const child = documentsStore.get("doc-child")!;
            assert.equal(child.parentId, "doc-grandparent");
            assert.deepEqual(child.path, ["doc-grandparent"]);

            const grandchild = documentsStore.get("doc-grandchild")!;
            assert.equal(grandchild.parentId, "doc-child");
            assert.deepEqual(grandchild.path, ["doc-grandparent", "doc-child"]);
            assert.equal(grandchild.path.includes("doc-parent"), false);
        });

        test("moves direct children and deeper descendants to a custom valid destination", async () => {
            documentsStore.set("dest-folder", { spaceId, title: "Dest Folder", parentId: null, path: [] });
            documentsStore.set("doc-delete", { spaceId, title: "To Delete", parentId: null, path: [] });
            documentsStore.set("c1", { spaceId, title: "C1", parentId: "doc-delete", path: ["doc-delete"] });
            documentsStore.set("c2", { spaceId, title: "C2", parentId: "c1", path: ["doc-delete", "c1"] });

            const result = await softDeleteDocumentAction(
                "token",
                spaceId,
                "doc-delete",
                "move-descendants",
                "dest-folder"
            );
            assert.equal(result.success, true);

            const c1 = documentsStore.get("c1")!;
            assert.equal(c1.parentId, "dest-folder");
            assert.deepEqual(c1.path, ["dest-folder"]);

            const c2 = documentsStore.get("c2")!;
            assert.equal(c2.parentId, "c1");
            assert.deepEqual(c2.path, ["dest-folder", "c1"]);
        });

        test("rejects moving under self (document being deleted)", async () => {
            documentsStore.set("doc-parent", { spaceId, title: "Parent", parentId: null, path: [] });
            documentsStore.set("doc-child", { spaceId, title: "Child", parentId: "doc-parent", path: ["doc-parent"] });

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-parent", "move-descendants", "doc-parent"),
                /Cannot move subdocuments under the document being deleted/
            );
        });

        test("rejects moving under a descendant in the deleted subtree", async () => {
            documentsStore.set("doc-parent", { spaceId, title: "Parent", parentId: null, path: [] });
            documentsStore.set("doc-child", { spaceId, title: "Child", parentId: "doc-parent", path: ["doc-parent"] });

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-parent", "move-descendants", "doc-child"),
                /Cannot move subdocuments under a document in the deleted subtree/
            );
        });

        test("rejects missing destination parent", async () => {
            documentsStore.set("doc-parent", { spaceId, title: "Parent", parentId: null, path: [] });
            documentsStore.set("doc-child", { spaceId, title: "Child", parentId: "doc-parent", path: ["doc-parent"] });

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-parent", "move-descendants", "non-existent"),
                /Destination document not found/
            );
        });

        test("rejects cross-space destination parent", async () => {
            documentsStore.set("doc-parent", { spaceId, title: "Parent", parentId: null, path: [] });
            documentsStore.set("doc-child", { spaceId, title: "Child", parentId: "doc-parent", path: ["doc-parent"] });
            documentsStore.set("foreign-dest", { spaceId: "foreign-space", title: "Foreign", parentId: null, path: [] });

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-parent", "move-descendants", "foreign-dest"),
                /Cannot move subdocuments to a different space/
            );
        });

        test("rejects soft-deleted destination parent", async () => {
            documentsStore.set("doc-parent", { spaceId, title: "Parent", parentId: null, path: [] });
            documentsStore.set("doc-child", { spaceId, title: "Child", parentId: "doc-parent", path: ["doc-parent"] });
            documentsStore.set("deleted-dest", { spaceId, title: "Deleted Dest", parentId: null, path: [], deleted: true, deletedAt: {} });

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-parent", "move-descendants", "deleted-dest"),
                /Cannot move subdocuments under a deleted document/
            );
        });

        test("rejects claimed destination parent", async () => {
            documentsStore.set("doc-parent", { spaceId, title: "Parent", parentId: null, path: [] });
            documentsStore.set("doc-child", { spaceId, title: "Child", parentId: "doc-parent", path: ["doc-parent"] });
            documentsStore.set("claimed-dest", {
                spaceId,
                title: "Claimed Dest",
                parentId: null,
                path: [],
                permanentDeletionClaim: { claimedAt: {}, claimedBy: "other" },
            });

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-parent", "move-descendants", "claimed-dest"),
                /Destination document is locked/
            );
        });

        test("rejects destination that would exceed 4-level hierarchy depth", async () => {
            // Destination is level 3 (path size 2)
            documentsStore.set("l1", { spaceId, title: "L1", parentId: null, path: [] });
            documentsStore.set("l2", { spaceId, title: "L2", parentId: "l1", path: ["l1"] });
            documentsStore.set("l3-dest", { spaceId, title: "L3", parentId: "l2", path: ["l1", "l2"] });

            // Deleted doc has child and grandchild (relative depth 2)
            documentsStore.set("doc-parent", { spaceId, title: "Parent", parentId: null, path: [] });
            documentsStore.set("child", { spaceId, title: "Child", parentId: "doc-parent", path: ["doc-parent"] });
            documentsStore.set("grandchild", { spaceId, title: "Grandchild", parentId: "child", path: ["doc-parent", "child"] });

            // Dest depth is 3 + 1 = 4. Grandchild relative depth is 2 -> 4 + 2 = 6 > 4!
            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-parent", "move-descendants", "l3-dest"),
                /exceeds the maximum hierarchy depth of 4 levels/
            );
        });

        test("soft-deletes only parent images; descendant images are not touched", async () => {
            documentsStore.set("doc-parent", { spaceId, title: "Parent", parentId: null, path: [] });
            documentsStore.set("doc-child", { spaceId, title: "Child", parentId: "doc-parent", path: ["doc-parent"] });

            getDocumentContentUrlsMock.mock.mockImplementation(async (id: string) => {
                if (id === "doc-parent") return ["https://bucket.s3.amazonaws.com/uploads/s/doc-parent/img1.png"];
                return ["https://bucket.s3.amazonaws.com/uploads/s/doc-child/img2.png"];
            });

            await softDeleteDocumentAction("token", spaceId, "doc-parent", "move-descendants", null);

            assert.equal(softDeleteImagesMock.mock.callCount(), 1);
            const args = softDeleteImagesMock.mock.calls[0].arguments;
            assert.equal(args[2], "doc-parent");
        });

        test("S3 failure blocks Firestore update and retains claim", async () => {
            documentsStore.set("doc-parent", { spaceId, title: "Parent", parentId: null, path: [] });
            documentsStore.set("doc-child", { spaceId, title: "Child", parentId: "doc-parent", path: ["doc-parent"] });

            getDocumentContentUrlsMock.mock.mockImplementation(async () => ["https://bucket.s3.amazonaws.com/uploads/s/doc/img.png"]);
            softDeleteImagesMock.mock.mockImplementation(async () => {
                throw new Error("AWS network timeout");
            });

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-parent", "move-descendants", null),
                /AWS network timeout/
            );

            // Parent was NOT marked deleted in Firestore
            const parent = documentsStore.get("doc-parent")!;
            assert.notEqual(parent.deleted, true);
            // Persistent claim remains in place to fail closed
            assert.ok(parent.lifecycleClaim);
        });
    });

    describe("Strategy B: Delete Entire Subtree", () => {
        test("soft-deletes parent and all descendants with one deletion group", async () => {
            documentsStore.set("doc-root", { spaceId, title: "Root", parentId: null, path: [] });
            documentsStore.set("child-1", { spaceId, title: "Child 1", parentId: "doc-root", path: ["doc-root"] });
            documentsStore.set("grandchild-1", { spaceId, title: "Grandchild 1", parentId: "child-1", path: ["doc-root", "child-1"] });

            const result = await softDeleteDocumentAction("token", spaceId, "doc-root", "delete-subtree");
            assert.equal(result.success, true);
            assert.equal(result.affectedCount, 3);

            const root = documentsStore.get("doc-root")!;
            assert.equal(root.deleted, true);
            assert.equal(root.deletionGroupRootId, "doc-root");
            assert.equal(root.deletionGroupCount, 3);
            assert.ok(root.deletionGroupId);
            const groupId = root.deletionGroupId;

            const c1 = documentsStore.get("child-1")!;
            assert.equal(c1.deleted, true);
            assert.equal(c1.deletionGroupId, groupId);
            assert.equal(c1.deletionGroupRootId, "doc-root");
            assert.equal(c1.parentId, "doc-root"); // preserved
            assert.deepEqual(c1.path, ["doc-root"]); // preserved

            const gc1 = documentsStore.get("grandchild-1")!;
            assert.equal(gc1.deleted, true);
            assert.equal(gc1.deletionGroupId, groupId);
            assert.equal(gc1.deletionGroupRootId, "doc-root");
            assert.equal(gc1.parentId, "child-1"); // preserved
            assert.deepEqual(gc1.path, ["doc-root", "child-1"]); // preserved
        });

        test("soft-deletes images for all affected documents in the subtree", async () => {
            documentsStore.set("doc-root", { spaceId, title: "Root", parentId: null, path: [] });
            documentsStore.set("child-1", { spaceId, title: "Child 1", parentId: "doc-root", path: ["doc-root"] });

            getDocumentContentUrlsMock.mock.mockImplementation(async (id: string) => {
                return [`https://bucket.s3.amazonaws.com/uploads/s/${id}/file.png`];
            });

            await softDeleteDocumentAction("token", spaceId, "doc-root", "delete-subtree");

            assert.equal(softDeleteImagesMock.mock.callCount(), 2);
        });

        test("safe write limit: exactly 250 documents succeeds", async () => {
            // 1 root + 249 descendants = 250 total documents
            documentsStore.set("doc-root", { spaceId, title: "Root", parentId: null, path: [] });
            for (let i = 1; i <= 249; i++) {
                documentsStore.set(`child-${i}`, {
                    spaceId,
                    title: `Child ${i}`,
                    parentId: "doc-root",
                    path: ["doc-root"],
                });
            }

            const result = await softDeleteDocumentAction("token", spaceId, "doc-root", "delete-subtree");
            assert.equal(MAX_LIFECYCLE_DOCUMENT_LIMIT, 250);
            assert.equal(result.success, true);
            assert.equal(result.affectedCount, 250);
        });

        test("safe write limit: 251 documents is rejected before AWS or Firestore mutation", async () => {
            // 1 root + 250 descendants = 251 total documents
            documentsStore.set("doc-root", { spaceId, title: "Root", parentId: null, path: [] });
            for (let i = 1; i <= 250; i++) {
                documentsStore.set(`child-${i}`, {
                    spaceId,
                    title: `Child ${i}`,
                    parentId: "doc-root",
                    path: ["doc-root"],
                });
            }

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-root", "delete-subtree"),
                /Operation exceeds safe atomic limit of 250 documents/
            );

            assert.equal(softDeleteImagesMock.mock.callCount(), 0);
            assert.equal(batchCommits.length, 0);
        });
    });

    describe("Group Restoration", () => {
        test("restores complete group from group root and clears deletion metadata", async () => {
            const groupId = "grp-123";
            documentsStore.set("doc-root", {
                spaceId,
                title: "Root",
                parentId: null,
                path: [],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "doc-root",
                deletionGroupCount: 2,
            });
            documentsStore.set("doc-child", {
                spaceId,
                title: "Child",
                parentId: "doc-root",
                path: ["doc-root"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "doc-root",
            });

            getDocumentContentUrlsMock.mock.mockImplementation(async (id: string) => [
                `https://bucket.s3.amazonaws.com/deleted/uploads/s/${id}/img.png`,
            ]);

            const result = await restoreDocumentAction("token", spaceId, "doc-root", { kind: "original" });
            assert.equal(result.success, true);
            assert.equal(result.restoredCount, 2);

            const root = documentsStore.get("doc-root")!;
            assert.equal(root.deleted, false);
            assert.equal(root.deletedAt, null);
            assert.equal(root.deletionGroupId, null);
            assert.equal(root.deletionGroupRootId, null);

            const child = documentsStore.get("doc-child")!;
            assert.equal(child.deleted, false);
            assert.equal(child.deletionGroupId, null);

            // Images restored for both
            assert.equal(restoreImagesMock.mock.callCount(), 2);
        });

        test("rejects partial group restoration from a non-root member", async () => {
            const groupId = "grp-123";
            documentsStore.set("doc-root", {
                spaceId,
                title: "Root",
                parentId: null,
                path: [],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "doc-root",
            });
            documentsStore.set("doc-child", {
                spaceId,
                title: "Child",
                parentId: "doc-root",
                path: ["doc-root"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "doc-root",
            });

            await assert.rejects(
                () => restoreDocumentAction("token", spaceId, "doc-child", { kind: "original" }),
                /Restore the entire group from the root document/
            );
        });

        test("missing external parent returns requiresDestination flag", async () => {
            const groupId = "grp-123";
            documentsStore.set("doc-root", {
                spaceId,
                title: "Root",
                parentId: "missing-parent",
                path: ["missing-parent"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "doc-root",
            });

            const result = await restoreDocumentAction("token", spaceId, "doc-root", { kind: "original" });
            assert.equal(result.success, false);
            assert.equal(result.requiresDestination, true);
        });

        test("restoring group with new destination parent updates paths canonically", async () => {
            documentsStore.set("new-parent", { spaceId, title: "New Parent", parentId: null, path: [] });

            const groupId = "grp-123";
            documentsStore.set("doc-root", {
                spaceId,
                title: "Root",
                parentId: "deleted-parent",
                path: ["deleted-parent"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "doc-root",
            });
            documentsStore.set("doc-child", {
                spaceId,
                title: "Child",
                parentId: "doc-root",
                path: ["deleted-parent", "doc-root"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "doc-root",
            });

            const result = await restoreDocumentAction("token", spaceId, "doc-root", { kind: "document", parentId: "new-parent" });
            assert.equal(result.success, true);

            const root = documentsStore.get("doc-root")!;
            assert.equal(root.parentId, "new-parent");
            assert.deepEqual(root.path, ["new-parent"]);

            const child = documentsStore.get("doc-child")!;
            assert.equal(child.parentId, "doc-root");
            assert.deepEqual(child.path, ["new-parent", "doc-root"]);
        });

        test("restoring individually deleted parent does not reclaim explicitly relocated children", async () => {
            // Scenario: Parent was deleted via Strategy A; child was relocated to Space root
            documentsStore.set("doc-parent", {
                spaceId,
                title: "Parent",
                parentId: null,
                path: [],
                deleted: true,
                deletedAt: {},
            });
            documentsStore.set("relocated-child", {
                spaceId,
                title: "Relocated Child",
                parentId: null,
                path: [],
                deleted: false,
            });

            const result = await restoreDocumentAction("token", spaceId, "doc-parent", { kind: "original" });
            assert.equal(result.success, true);

            const child = documentsStore.get("relocated-child")!;
            assert.equal(child.parentId, null);
            assert.deepEqual(child.path, []);
        });
    });

    describe("Concurrency and Claims", () => {
        test("rejects operation if target document is locked by another user", async () => {
            documentsStore.set("doc-locked", {
                spaceId,
                title: "Locked",
                parentId: null,
                path: [],
                lifecycleClaim: { claimedAt: {}, claimedBy: "other-user", operation: "soft-delete", strategy: "delete-subtree" },
            });

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-locked", "delete-subtree"),
                /locked by another lifecycle operation/
            );
        });

        test("allows authorized retry by the same user with existing claim", async () => {
            documentsStore.set("doc-retry", {
                spaceId,
                title: "Retry",
                parentId: null,
                path: [],
                lifecycleClaim: { claimedAt: {}, claimedBy: callerUid, operation: "soft-delete", strategy: "delete-subtree" },
            });

            const result = await softDeleteDocumentAction("token", spaceId, "doc-retry", "delete-subtree");
            assert.equal(result.success, true);
        });

        test("claim-before-query: root document lifecycleClaim is committed before subtree query executes", async () => {
            documentsStore.set("doc-parent", { spaceId, title: "Parent", parentId: null, path: [] });
            documentsStore.set("doc-preexisting-child", {
                spaceId,
                title: "Preexisting Child",
                parentId: "doc-parent",
                path: ["doc-parent"],
            });

            let rootClaimPresentDuringQuery = false;
            // Intercept get() on collection query to verify root claim exists in store
            const origWhere = fakeFirestore.collection("documents").where;
            fakeFirestore.collection = mock.fn((colName: string) => ({
                doc: mock.fn((docId: string) => createMockDocRef(colName, docId)),
                where: mock.fn((field: string, op: string, val: unknown) => {
                    const queryObj = origWhere(field, op, val);
                    const origGet = queryObj.get;
                    queryObj.get = mock.fn(async () => {
                        const rootDoc = documentsStore.get("doc-parent");
                        if (rootDoc?.lifecycleClaim) {
                            rootClaimPresentDuringQuery = true;
                        }
                        return await origGet();
                    });
                    return queryObj;
                }),
            }));

            const result = await softDeleteDocumentAction("token", spaceId, "doc-parent", "delete-subtree");
            assert.equal(result.success, true);
            assert.equal(rootClaimPresentDuringQuery, true);

            // Verify both root and pre-existing child were deleted
            const root = documentsStore.get("doc-parent")!;
            assert.equal(root.deleted, true);
            const child = documentsStore.get("doc-preexisting-child")!;
            assert.equal(child.deleted, true);
        });

        test("retry identity: adopts existing opId on retry rather than generating a new random opId", async () => {
            const originalOpId = "op-identity-12345";
            documentsStore.set("doc-retry-id", {
                spaceId,
                title: "Retry Identity",
                parentId: null,
                path: [],
                lifecycleClaim: {
                    claimedAt: {},
                    claimedBy: callerUid,
                    operation: "soft-delete",
                    strategy: "delete-subtree",
                    opId: originalOpId,
                },
            });
            documentsStore.set("child-retry", {
                spaceId,
                title: "Child",
                parentId: "doc-retry-id",
                path: ["doc-retry-id"],
            });

            let adoptedOpIdDuringRun: string | undefined;
            // Catch opId while claim is updated on child
            const origUpdate = fakeBatch.update;
            fakeBatch.update = mock.fn((ref: { path: string; id: string }, data: Record<string, unknown>) => {
                if (data.lifecycleClaim && typeof data.lifecycleClaim === "object") {
                    const claim = data.lifecycleClaim as { opId?: string };
                    adoptedOpIdDuringRun = claim.opId;
                }
                return origUpdate(ref, data);
            });

            const result = await softDeleteDocumentAction("token", spaceId, "doc-retry-id", "delete-subtree");
            assert.equal(result.success, true);
            assert.equal(adoptedOpIdDuringRun, originalOpId);
        });

        test("retry identity: space owner can recover and adopt existing opId from another user's claim", async () => {
            const stalledOpId = "stalled-op-98765";
            // Set caller as space owner
            spacesStore.set(spaceId, {
                id: spaceId,
                name: "Engineering Docs",
                ownerId: callerUid,
                userIds: [callerUid],
                deletedAt: null,
            });

            documentsStore.set("doc-stalled", {
                spaceId,
                title: "Stalled Doc",
                parentId: null,
                path: [],
                lifecycleClaim: {
                    claimedAt: {},
                    claimedBy: "stalled-user-uid",
                    operation: "soft-delete",
                    strategy: "delete-subtree",
                    opId: stalledOpId,
                },
            });

            const result = await softDeleteDocumentAction("token", spaceId, "doc-stalled", "delete-subtree");
            assert.equal(result.success, true);
            const doc = documentsStore.get("doc-stalled")!;
            assert.equal(doc.deleted, true);
            assert.equal(doc.lifecycleClaim, null);
        });

        test("retry identity: non-owner contributor cannot take over another user's active claim", async () => {
            // Set separate owner, caller is ordinary contributor
            spacesStore.set(spaceId, {
                id: spaceId,
                name: "Engineering Docs",
                ownerId: "separate-owner-uid",
                userIds: [callerUid, "separate-owner-uid"],
                deletedAt: null,
            });

            documentsStore.set("doc-foreign-claim", {
                spaceId,
                title: "Foreign Claim",
                parentId: null,
                path: [],
                lifecycleClaim: {
                    claimedAt: {},
                    claimedBy: "other-user-uid",
                    operation: "soft-delete",
                    strategy: "delete-subtree",
                    opId: "other-op-id",
                },
            });

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-foreign-claim", "delete-subtree"),
                /locked by another lifecycle operation/
            );
        });

        test("retry identity: rejects retry when active claim operation mismatches requested operation", async () => {
            documentsStore.set("doc-mismatch", {
                spaceId,
                title: "Mismatch",
                parentId: null,
                path: [],
                deleted: true,
                deletedAt: {},
                lifecycleClaim: {
                    claimedAt: {},
                    claimedBy: callerUid,
                    operation: "soft-delete", // Locked with soft-delete, caller attempts restore
                    opId: "mismatch-op-1",
                },
            });

            await assert.rejects(
                () => restoreDocumentAction("token", spaceId, "doc-mismatch", { kind: "original" }),
                /locked by another lifecycle operation/
            );
        });
    });

    describe("Lifecycle Claim Strategy Enforcement", () => {
        test("failed 'delete-subtree' cannot retry as 'move-descendants' (rejected before AWS calls)", async () => {
            documentsStore.set("doc-del-claimed", {
                spaceId,
                title: "Delete Claimed",
                parentId: null,
                path: [],
                lifecycleClaim: {
                    claimedAt: {},
                    claimedBy: callerUid,
                    operation: "soft-delete",
                    strategy: "delete-subtree",
                    opId: "del-subtree-op",
                },
            });

            getDocumentContentUrlsMock.mock.mockImplementation(async () => [
                "https://bucket.s3.amazonaws.com/uploads/s/doc/img-1.png",
            ]);

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-del-claimed", "move-descendants", null),
                /Cannot change strategy on an active lifecycle claim/
            );

            // Verified rejected before ANY AWS S3 calls
            assert.equal(softDeleteImagesMock.mock.calls.length, 0);

            // Fail-closed: original claim and strategy preserved, not deleted
            const doc = documentsStore.get("doc-del-claimed")!;
            assert.notEqual(doc.deleted, true);
            assert.equal(doc.lifecycleClaim?.strategy, "delete-subtree");
            assert.equal(doc.lifecycleClaim?.opId, "del-subtree-op");
        });

        test("failed 'move-descendants' cannot retry as 'delete-subtree' (rejected before AWS calls)", async () => {
            documentsStore.set("doc-move-claimed", {
                spaceId,
                title: "Move Claimed",
                parentId: null,
                path: [],
                lifecycleClaim: {
                    claimedAt: {},
                    claimedBy: callerUid,
                    operation: "soft-delete",
                    strategy: "move-descendants",
                    opId: "move-desc-op",
                },
            });

            getDocumentContentUrlsMock.mock.mockImplementation(async () => [
                "https://bucket.s3.amazonaws.com/uploads/s/doc/img-1.png",
            ]);

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-move-claimed", "delete-subtree"),
                /Cannot change strategy on an active lifecycle claim/
            );

            // Verified rejected before ANY AWS S3 calls
            assert.equal(softDeleteImagesMock.mock.calls.length, 0);

            // Fail-closed: original claim and strategy preserved, not deleted
            const doc = documentsStore.get("doc-move-claimed")!;
            assert.notEqual(doc.deleted, true);
            assert.equal(doc.lifecycleClaim?.strategy, "move-descendants");
            assert.equal(doc.lifecycleClaim?.opId, "move-desc-op");
        });

        test("space-owner recovery preserves original strategy and rejects strategy changes", async () => {
            spacesStore.set(spaceId, {
                id: spaceId,
                name: "Engineering Docs",
                ownerId: callerUid,
                userIds: [callerUid],
                deletedAt: null,
            });

            documentsStore.set("doc-stalled-strat", {
                spaceId,
                title: "Stalled Doc",
                parentId: null,
                path: [],
                lifecycleClaim: {
                    claimedAt: {},
                    claimedBy: "stalled-contributor-uid",
                    operation: "soft-delete",
                    strategy: "delete-subtree",
                    opId: "stalled-op-111",
                },
            });

            // 1. Space owner attempts to change strategy to 'move-descendants' -> rejected before AWS calls
            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-stalled-strat", "move-descendants", null),
                /Cannot change strategy on an active lifecycle claim/
            );
            assert.equal(softDeleteImagesMock.mock.calls.length, 0);

            // 2. Space owner retries with matching strategy 'delete-subtree' -> succeeds and adopts existing opId
            const result = await softDeleteDocumentAction("token", spaceId, "doc-stalled-strat", "delete-subtree");
            assert.equal(result.success, true);
            const doc = documentsStore.get("doc-stalled-strat")!;
            assert.equal(doc.deleted, true);
            assert.equal(doc.lifecycleClaim, null);
        });

        test("same-strategy 'move-descendants' retry allows choosing another valid destination", async () => {
            documentsStore.set("doc-move-retry", {
                spaceId,
                title: "Move Root",
                parentId: null,
                path: [],
                lifecycleClaim: {
                    claimedAt: {},
                    claimedBy: callerUid,
                    operation: "soft-delete",
                    strategy: "move-descendants",
                    opId: "move-retry-op",
                },
            });
            documentsStore.set("child-move-retry", {
                spaceId,
                title: "Child Move",
                parentId: "doc-move-retry",
                path: ["doc-move-retry"],
            });
            // Previous destination became invalid/deleted
            documentsStore.set("old-dest", {
                spaceId,
                title: "Old Dest",
                parentId: null,
                path: [],
                deleted: true,
                deletedAt: {},
            });
            // New valid destination
            documentsStore.set("new-dest", {
                spaceId,
                title: "New Dest",
                parentId: null,
                path: [],
            });

            // Retry with same strategy ("move-descendants") but new valid destination
            const result = await softDeleteDocumentAction(
                "token",
                spaceId,
                "doc-move-retry",
                "move-descendants",
                "new-dest"
            );
            assert.equal(result.success, true);

            // Verify root deleted and child moved under new-dest
            const root = documentsStore.get("doc-move-retry")!;
            assert.equal(root.deleted, true);
            assert.equal(root.lifecycleClaim, null);
            const child = documentsStore.get("child-move-retry")!;
            assert.equal(child.parentId, "new-dest");
            assert.deepEqual(child.path, ["new-dest"]);
            assert.equal(child.lifecycleClaim, null);
        });

        test("initial root and descendant claims store identical strategy", async () => {
            documentsStore.set("doc-strat-root", { spaceId, title: "Strat Root", parentId: null, path: [] });
            documentsStore.set("child-strat", {
                spaceId,
                title: "Child Strat",
                parentId: "doc-strat-root",
                path: ["doc-strat-root"],
            });

            let capturedDescendantClaim: { strategy?: string; operation?: string; opId?: string } | undefined;
            const origBatchUpdate = fakeBatch.update;
            fakeBatch.update = mock.fn((ref: { path: string; id: string }, data: Record<string, unknown>) => {
                if (data.lifecycleClaim && typeof data.lifecycleClaim === "object") {
                    capturedDescendantClaim = data.lifecycleClaim as { strategy?: string; operation?: string; opId?: string };
                }
                return origBatchUpdate(ref, data);
            });

            const result = await softDeleteDocumentAction("token", spaceId, "doc-strat-root", "delete-subtree");
            assert.equal(result.success, true);

            assert.ok(capturedDescendantClaim);
            assert.equal(capturedDescendantClaim.strategy, "delete-subtree");
            assert.equal(capturedDescendantClaim.operation, "soft-delete");
            assert.ok(capturedDescendantClaim.opId);
        });

        test("final transaction rejects root document whose strategy was altered", async () => {
            documentsStore.set("doc-tamper-root", { spaceId, title: "Tamper Root", parentId: null, path: [] });

            getDocumentContentUrlsMock.mock.mockImplementation(async () => [
                "https://bucket.s3.amazonaws.com/uploads/s/doc/img-1.png",
            ]);

            // During S3 phase, simulate external/concurrent alteration of root claim strategy
            softDeleteImagesMock.mock.mockImplementation(async () => {
                const rootDoc = documentsStore.get("doc-tamper-root")!;
                documentsStore.set("doc-tamper-root", {
                    ...rootDoc,
                    lifecycleClaim: {
                        ...rootDoc.lifecycleClaim,
                        strategy: "move-descendants", // Tampered from delete-subtree
                    },
                });
            });

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-tamper-root", "delete-subtree"),
                /Root document lifecycle claim has been modified or invalidated/
            );

            // Fail-closed: not deleted
            const root = documentsStore.get("doc-tamper-root")!;
            assert.notEqual(root.deleted, true);
            assert.ok(root.lifecycleClaim);
        });

        test("final transaction rejects descendant whose strategy was altered", async () => {
            documentsStore.set("doc-root-clean", { spaceId, title: "Root Clean", parentId: null, path: [] });
            documentsStore.set("doc-child-tamper", {
                spaceId,
                title: "Child Tamper",
                parentId: "doc-root-clean",
                path: ["doc-root-clean"],
            });

            getDocumentContentUrlsMock.mock.mockImplementation(async () => [
                "https://bucket.s3.amazonaws.com/uploads/s/doc/img-1.png",
            ]);

            // During S3 phase, simulate alteration of descendant strategy
            softDeleteImagesMock.mock.mockImplementation(async () => {
                const childDoc = documentsStore.get("doc-child-tamper")!;
                documentsStore.set("doc-child-tamper", {
                    ...childDoc,
                    lifecycleClaim: {
                        ...childDoc.lifecycleClaim,
                        strategy: "move-descendants", // Tampered
                    },
                });
            });

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-root-clean", "delete-subtree"),
                /Descendant document doc-child-tamper lifecycle claim was altered/
            );

            // Fail-closed: not deleted
            const root = documentsStore.get("doc-root-clean")!;
            assert.notEqual(root.deleted, true);
            assert.ok(root.lifecycleClaim);
        });
    });

    describe("Destination and Descendant TOCTOU Revalidation (Final Transaction)", () => {
        test("destination deleted during S3 phase aborts transaction and retains claim", async () => {
            documentsStore.set("dest-folder", { spaceId, title: "Dest Folder", parentId: null, path: [] });
            documentsStore.set("doc-parent", { spaceId, title: "Parent", parentId: null, path: [] });
            documentsStore.set("child-1", { spaceId, title: "Child 1", parentId: "doc-parent", path: ["doc-parent"] });

            getDocumentContentUrlsMock.mock.mockImplementation(async (id: string) => {
                if (id === "doc-parent") return ["https://bucket.s3.amazonaws.com/uploads/s/doc/img.png"];
                return [];
            });

            // Simulate concurrent deletion of destination during S3 phase
            softDeleteImagesMock.mock.mockImplementation(async () => {
                documentsStore.set("dest-folder", {
                    spaceId,
                    title: "Dest Folder",
                    parentId: null,
                    path: [],
                    deleted: true,
                    deletedAt: {},
                });
            });

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-parent", "move-descendants", "dest-folder"),
                /Destination document has been deleted/
            );

            // Fail-closed: parent and child retain their lifecycle claims; parent was NOT marked deleted
            const parent = documentsStore.get("doc-parent")!;
            assert.notEqual(parent.deleted, true);
            assert.ok(parent.lifecycleClaim);
            const child = documentsStore.get("child-1")!;
            assert.ok(child.lifecycleClaim);
        });

        test("destination claimed during S3 phase aborts transaction and retains claim", async () => {
            documentsStore.set("dest-folder", { spaceId, title: "Dest Folder", parentId: null, path: [] });
            documentsStore.set("doc-parent", { spaceId, title: "Parent", parentId: null, path: [] });
            documentsStore.set("child-1", { spaceId, title: "Child 1", parentId: "doc-parent", path: ["doc-parent"] });

            getDocumentContentUrlsMock.mock.mockImplementation(async (id: string) => {
                if (id === "doc-parent") return ["https://bucket.s3.amazonaws.com/uploads/s/doc/img.png"];
                return [];
            });

            // Simulate concurrent claim on destination during S3 phase
            softDeleteImagesMock.mock.mockImplementation(async () => {
                documentsStore.set("dest-folder", {
                    spaceId,
                    title: "Dest Folder",
                    parentId: null,
                    path: [],
                    lifecycleClaim: { claimedAt: {}, claimedBy: "other-user", operation: "soft-delete", opId: "dest-op" },
                });
            });

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-parent", "move-descendants", "dest-folder"),
                /Destination document has been locked/
            );

            const parent = documentsStore.get("doc-parent")!;
            assert.notEqual(parent.deleted, true);
            assert.ok(parent.lifecycleClaim);
        });

        test("descendant moved outside deleted subtree during S3 phase aborts transaction and retains claim", async () => {
            documentsStore.set("doc-parent", { spaceId, title: "Parent", parentId: null, path: [] });
            documentsStore.set("child-1", { spaceId, title: "Child 1", parentId: "doc-parent", path: ["doc-parent"] });

            getDocumentContentUrlsMock.mock.mockImplementation(async (id: string) => {
                if (id === "doc-parent") return ["https://bucket.s3.amazonaws.com/uploads/s/doc/img.png"];
                return [];
            });

            // Simulate child-1 being moved to root outside doc-parent subtree during S3 phase
            softDeleteImagesMock.mock.mockImplementation(async () => {
                const child = documentsStore.get("child-1")!;
                documentsStore.set("child-1", {
                    ...child,
                    parentId: null,
                    path: [], // No longer contains doc-parent
                });
            });

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-parent", "move-descendants", null),
                /is no longer in the deleted subtree/
            );

            const parent = documentsStore.get("doc-parent")!;
            assert.notEqual(parent.deleted, true);
            assert.ok(parent.lifecycleClaim);
        });

        test("destination moved deeper during S3 phase causing depth > 4 aborts transaction and retains claim", async () => {
            // Destination initially at depth 1 (path [])
            documentsStore.set("dest-parent", { spaceId, title: "Dest Parent", parentId: null, path: [] });
            documentsStore.set("doc-parent", { spaceId, title: "Parent", parentId: null, path: [] });
            documentsStore.set("child-1", { spaceId, title: "Child 1", parentId: "doc-parent", path: ["doc-parent"] });
            documentsStore.set("grandchild-1", { spaceId, title: "Grandchild 1", parentId: "child-1", path: ["doc-parent", "child-1"] });

            getDocumentContentUrlsMock.mock.mockImplementation(async (id: string) => {
                if (id === "doc-parent") return ["https://bucket.s3.amazonaws.com/uploads/s/doc/img.png"];
                return [];
            });

            // Simulate destination moving to depth 3 during S3 phase (path: ["a", "b", "dest-parent"])
            softDeleteImagesMock.mock.mockImplementation(async () => {
                documentsStore.set("dest-parent", {
                    spaceId,
                    title: "Dest Parent",
                    parentId: "anc-b",
                    path: ["anc-a", "anc-b"],
                });
                documentsStore.set("anc-a", { spaceId, title: "Anc A", parentId: null, path: [] });
                documentsStore.set("anc-b", { spaceId, title: "Anc B", parentId: "anc-a", path: ["anc-a"] });
            });

            // Moving grandchild (relative depth 2) to dest at depth 3 -> 3 + 2 = 5 > 4
            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-parent", "move-descendants", "dest-parent"),
                /exceeds the maximum hierarchy depth of 4 levels/
            );

            const parent = documentsStore.get("doc-parent")!;
            assert.notEqual(parent.deleted, true);
            assert.ok(parent.lifecycleClaim);
        });

        test("restore: destination parent deleted during S3 phase aborts transaction and retains claim", async () => {
            documentsStore.set("new-parent", { spaceId, title: "New Parent", parentId: null, path: [] });
            documentsStore.set("doc-restore", {
                spaceId,
                title: "To Restore",
                parentId: "old-missing",
                path: ["old-missing"],
                deleted: true,
                deletedAt: {},
            });

            getDocumentContentUrlsMock.mock.mockImplementation(async () => [
                "https://bucket.s3.amazonaws.com/deleted/uploads/s/doc/img.png",
            ]);

            // Simulate new-parent deleted during S3 restore
            restoreImagesMock.mock.mockImplementation(async () => {
                documentsStore.set("new-parent", {
                    spaceId,
                    title: "New Parent",
                    parentId: null,
                    path: [],
                    deleted: true,
                    deletedAt: {},
                });
            });

            await assert.rejects(
                () => restoreDocumentAction("token", spaceId, "doc-restore", { kind: "document", parentId: "new-parent" }),
                /Selected destination parent has been deleted/
            );

            const doc = documentsStore.get("doc-restore")!;
            assert.equal(doc.deleted, true); // Still deleted
            assert.ok(doc.lifecycleClaim); // Claim retained (fail-closed)
        });
    });

    describe("Bounded S3 Work and Concurrency Chunking", () => {
        test("safe image limit: exactly 500 images succeeds", async () => {
            documentsStore.set("doc-root", { spaceId, title: "Root", parentId: null, path: [] });

            // 500 image URLs
            const fiveHundredUrls = Array.from({ length: MAX_LIFECYCLE_IMAGE_LIMIT }, (_, i) =>
                `https://bucket.s3.amazonaws.com/uploads/s/doc-root/img-${i}.png`
            );
            getDocumentContentUrlsMock.mock.mockImplementation(async () => fiveHundredUrls);

            const result = await softDeleteDocumentAction("token", spaceId, "doc-root", "delete-subtree");
            assert.equal(MAX_LIFECYCLE_IMAGE_LIMIT, 500);
            assert.equal(result.success, true);
            // 500 images divided into chunks of 10 = 50 S3 calls
            assert.equal(softDeleteImagesMock.mock.callCount(), 50);
        });

        test("safe image limit: 501 images rejects upfront before any AWS call", async () => {
            documentsStore.set("doc-root", { spaceId, title: "Root", parentId: null, path: [] });

            // 501 image URLs
            const overLimitUrls = Array.from({ length: MAX_LIFECYCLE_IMAGE_LIMIT + 1 }, (_, i) =>
                `https://bucket.s3.amazonaws.com/uploads/s/doc-root/img-${i}.png`
            );
            getDocumentContentUrlsMock.mock.mockImplementation(async () => overLimitUrls);

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-root", "delete-subtree"),
                /Operation exceeds safe atomic limit of 500 images/
            );

            // Zero AWS calls made
            assert.equal(softDeleteImagesMock.mock.callCount(), 0);
        });

        test("processes S3 image operations in bounded chunks of 10", async () => {
            documentsStore.set("doc-root", { spaceId, title: "Root", parentId: null, path: [] });

            // 25 image URLs
            const urls = Array.from({ length: 25 }, (_, i) =>
                `https://bucket.s3.amazonaws.com/uploads/s/doc-root/img-${i}.png`
            );
            getDocumentContentUrlsMock.mock.mockImplementation(async () => urls);

            const chunkSizes: number[] = [];
            softDeleteImagesMock.mock.mockImplementation(async (_token, _sId, _docId, chunkUrls: string[]) => {
                chunkSizes.push(chunkUrls.length);
            });

            const result = await softDeleteDocumentAction("token", spaceId, "doc-root", "delete-subtree");
            assert.equal(result.success, true);
            // 25 items chunked by 10 -> [10, 10, 5]
            assert.deepEqual(chunkSizes, [10, 10, 5]);
            assert.equal(softDeleteImagesMock.mock.callCount(), 3);
        });

        test("S3 chunk failure halts subsequent chunks and fails closed with claim retained", async () => {
            documentsStore.set("doc-root", { spaceId, title: "Root", parentId: null, path: [] });
            documentsStore.set("doc-child", { spaceId, title: "Child", parentId: "doc-root", path: ["doc-root"] });

            const urls = Array.from({ length: 25 }, (_, i) =>
                `https://bucket.s3.amazonaws.com/uploads/s/doc/img-${i}.png`
            );
            getDocumentContentUrlsMock.mock.mockImplementation(async (id: string) => {
                if (id === "doc-root") return urls;
                return [];
            });

            let callCount = 0;
            softDeleteImagesMock.mock.mockImplementation(async () => {
                callCount++;
                if (callCount === 2) {
                    throw new Error("AWS connection dropped on chunk 2");
                }
            });

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-root", "delete-subtree"),
                /AWS connection dropped on chunk 2/
            );

            // Chunk 3 (the last 5 items) was NEVER executed
            assert.equal(callCount, 2);

            // Fail-closed: claims retained on both root and child
            const root = documentsStore.get("doc-root")!;
            assert.notEqual(root.deleted, true);
            assert.ok(root.lifecycleClaim);
            const child = documentsStore.get("doc-child")!;
            assert.ok(child.lifecycleClaim);
        });

        test("subsequent retry after S3 failure succeeds and cleans up claims", async () => {
            documentsStore.set("doc-root", { spaceId, title: "Root", parentId: null, path: [] });

            const urls = Array.from({ length: 25 }, (_, i) =>
                `https://bucket.s3.amazonaws.com/uploads/s/doc/img-${i}.png`
            );
            getDocumentContentUrlsMock.mock.mockImplementation(async () => urls);

            // First attempt: fails on chunk 1
            softDeleteImagesMock.mock.mockImplementationOnce(async () => {
                throw new Error("Temporary S3 503");
            });

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "doc-root", "delete-subtree"),
                /Temporary S3 503/
            );

            // Verify claim retained
            assert.ok(documentsStore.get("doc-root")?.lifecycleClaim);

            // Second attempt (retry by same user): S3 succeeds
            softDeleteImagesMock.mock.mockImplementation(async () => {});
            const result = await softDeleteDocumentAction("token", spaceId, "doc-root", "delete-subtree");
            assert.equal(result.success, true);

            // State cleanly finalized
            const root = documentsStore.get("doc-root")!;
            assert.equal(root.deleted, true);
            assert.equal(root.lifecycleClaim, null);
        });
    });

    describe("Tagged Contract Restoration Semantics & QA Regression", () => {
        test("kind: 'original': when external parent is soft-deleted, returns requiresDestination: true without restoring to root", async () => {
            const groupId = "grp-qa-1";
            // Soft-deleted external parent
            documentsStore.set("ext-parent", {
                spaceId,
                title: "External Parent",
                parentId: null,
                path: [],
                deleted: true,
                deletedAt: {},
            });

            // Soft-deleted subtree group
            documentsStore.set("doc-root", {
                spaceId,
                title: "Subtree Root",
                parentId: "ext-parent",
                path: ["ext-parent"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "doc-root",
                deletionGroupCount: 2,
            });
            documentsStore.set("doc-child", {
                spaceId,
                title: "Subtree Child",
                parentId: "doc-root",
                path: ["ext-parent", "doc-root"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "doc-root",
            });

            getDocumentContentUrlsMock.mock.mockImplementation(async () => [
                "https://bucket.s3.amazonaws.com/deleted/uploads/s/doc/img.png",
            ]);

            // Attempt initial restore with tagged contract: { kind: "original" }
            const result = await restoreDocumentAction("token", spaceId, "doc-root", { kind: "original" });

            // Must NOT restore to Space root! Must return requiresDestination: true
            assert.equal(result.success, false);
            assert.equal(result.restoredCount, 0);
            assert.equal(result.requiresDestination, true);

            // Zero S3 operations performed
            assert.equal(restoreImagesMock.mock.callCount(), 0);

            // Both documents must remain soft-deleted and root must preserve original parentId
            const root = documentsStore.get("doc-root")!;
            assert.equal(root.deleted, true);
            assert.equal(root.parentId, "ext-parent"); // Never rewritten to root!
            assert.deepEqual(root.path, ["ext-parent"]);
            assert.equal(root.deletionGroupId, groupId);

            const child = documentsStore.get("doc-child")!;
            assert.equal(child.deleted, true);
            assert.equal(child.parentId, "doc-root");
            assert.deepEqual(child.path, ["ext-parent", "doc-root"]);

            // Claim must be cleanly released (no leftover lock)
            assert.equal(root.lifecycleClaim, null);
            assert.ok(!child.lifecycleClaim);

            // Pipe through evaluateRestoreResult helper: must trigger OPEN_DESTINATION_PICKER
            const evalResult = evaluateRestoreResult(result, { id: "doc-root", title: "Subtree Root" });
            assert.equal(evalResult.type, "OPEN_DESTINATION_PICKER");
            if (evalResult.type === "OPEN_DESTINATION_PICKER") {
                assert.equal(evalResult.rehomeDoc.id, "doc-root");
                assert.equal(evalResult.rehomeDoc.title, "Subtree Root");
                assert.ok(evalResult.explanation.includes("original parent document is no longer available"));
            }
        });

        test("kind: 'original': when external parent is missing, returns requiresDestination: true", async () => {
            const groupId = "grp-qa-missing";
            documentsStore.set("doc-root", {
                spaceId,
                title: "Subtree Root",
                parentId: "non-existent-parent",
                path: ["non-existent-parent"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "doc-root",
                deletionGroupCount: 1,
            });

            const result = await restoreDocumentAction("token", spaceId, "doc-root", { kind: "original" });
            assert.equal(result.success, false);
            assert.equal(result.requiresDestination, true);
            assert.equal(restoreImagesMock.mock.callCount(), 0);

            const root = documentsStore.get("doc-root")!;
            assert.equal(root.deleted, true);
            assert.equal(root.parentId, "non-existent-parent");
            assert.equal(root.lifecycleClaim, null);
        });

        test("kind: 'original': when external parent is claimed by another operation, returns requiresDestination: true", async () => {
            const groupId = "grp-qa-claimed";
            documentsStore.set("claimed-parent", {
                spaceId,
                title: "Claimed Parent",
                parentId: null,
                path: [],
                deleted: false,
                lifecycleClaim: {
                    claimedAt: {},
                    claimedBy: "other-user",
                    operation: "soft-delete",
                    opId: "op-other",
                },
            });

            documentsStore.set("doc-root", {
                spaceId,
                title: "Subtree Root",
                parentId: "claimed-parent",
                path: ["claimed-parent"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "doc-root",
                deletionGroupCount: 1,
            });

            const result = await restoreDocumentAction("token", spaceId, "doc-root", { kind: "original" });
            assert.equal(result.success, false);
            assert.equal(result.requiresDestination, true);
            assert.equal(restoreImagesMock.mock.callCount(), 0);

            const root = documentsStore.get("doc-root")!;
            assert.equal(root.deleted, true);
            assert.equal(root.lifecycleClaim, null);
        });

        test("kind: 'original': when external parent ancestor is soft-deleted, returns requiresDestination: true", async () => {
            const groupId = "grp-qa-anc-deleted";
            documentsStore.set("grandparent", {
                spaceId,
                title: "Grandparent",
                parentId: null,
                path: [],
                deleted: true,
                deletedAt: {},
            });
            documentsStore.set("active-parent", {
                spaceId,
                title: "Active Parent",
                parentId: "grandparent",
                path: ["grandparent"],
                deleted: false,
            });

            documentsStore.set("doc-root", {
                spaceId,
                title: "Subtree Root",
                parentId: "active-parent",
                path: ["grandparent", "active-parent"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "doc-root",
                deletionGroupCount: 1,
            });

            const result = await restoreDocumentAction("token", spaceId, "doc-root", { kind: "original" });
            assert.equal(result.success, false);
            assert.equal(result.requiresDestination, true);
            assert.equal(restoreImagesMock.mock.callCount(), 0);

            const root = documentsStore.get("doc-root")!;
            assert.equal(root.deleted, true);
            assert.equal(root.lifecycleClaim, null);
        });

        test("kind: 'original': depth overflow beyond 4 levels returns requiresDestination: true", async () => {
            const groupId = "grp-qa-depth";
            // Ancestors depth = 3 (lvl1 -> lvl2 -> lvl3)
            documentsStore.set("lvl1", { spaceId, title: "L1", parentId: null, path: [], deleted: false });
            documentsStore.set("lvl2", { spaceId, title: "L2", parentId: "lvl1", path: ["lvl1"], deleted: false });
            documentsStore.set("lvl3", { spaceId, title: "L3", parentId: "lvl2", path: ["lvl1", "lvl2"], deleted: false });

            // Subtree has height 2 (root -> child), total depth = 3 + 2 = 5 > 4
            documentsStore.set("doc-root", {
                spaceId,
                title: "Subtree Root",
                parentId: "lvl3",
                path: ["lvl1", "lvl2", "lvl3"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "doc-root",
                deletionGroupCount: 2,
            });
            documentsStore.set("doc-child", {
                spaceId,
                title: "Subtree Child",
                parentId: "doc-root",
                path: ["lvl1", "lvl2", "lvl3", "doc-root"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "doc-root",
            });

            const result = await restoreDocumentAction("token", spaceId, "doc-root", { kind: "original" });
            assert.equal(result.success, false);
            assert.equal(result.requiresDestination, true);
            assert.equal(restoreImagesMock.mock.callCount(), 0);

            const root = documentsStore.get("doc-root")!;
            assert.equal(root.deleted, true);
            assert.equal(root.lifecycleClaim, null);
        });

        test("kind: 'root': restores grouped subtree to Space root when user explicitly chooses Space root", async () => {
            const groupId = "grp-qa-root";
            documentsStore.set("ext-parent", {
                spaceId,
                title: "External Parent",
                parentId: null,
                path: [],
                deleted: true,
                deletedAt: {},
            });

            documentsStore.set("doc-root", {
                spaceId,
                title: "Subtree Root",
                parentId: "ext-parent",
                path: ["ext-parent"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "doc-root",
                deletionGroupCount: 2,
            });
            documentsStore.set("doc-child", {
                spaceId,
                title: "Subtree Child",
                parentId: "doc-root",
                path: ["ext-parent", "doc-root"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "doc-root",
            });

            getDocumentContentUrlsMock.mock.mockImplementation(async () => [
                "https://bucket.s3.amazonaws.com/deleted/uploads/s/doc/img.png",
            ]);

            // Explicit tagged contract: { kind: "root" }
            const result = await restoreDocumentAction("token", spaceId, "doc-root", { kind: "root" });
            assert.equal(result.success, true);
            assert.equal(result.restoredCount, 2);

            const root = documentsStore.get("doc-root")!;
            assert.equal(root.deleted, false);
            assert.equal(root.deletedAt, null);
            assert.equal(root.parentId, null);
            assert.deepEqual(root.path, []);
            assert.equal(root.deletionGroupId, null);
            assert.equal(root.lifecycleClaim, null);

            const child = documentsStore.get("doc-child")!;
            assert.equal(child.deleted, false);
            assert.equal(child.deletedAt, null);
            assert.equal(child.parentId, "doc-root");
            assert.deepEqual(child.path, ["doc-root"]);
            assert.equal(child.deletionGroupId, null);
            assert.equal(child.lifecycleClaim, null);

            assert.equal(restoreImagesMock.mock.callCount(), 2);
        });

        test("kind: 'document': restores grouped subtree beneath chosen active document", async () => {
            const groupId = "grp-qa-target";
            documentsStore.set("target-parent", {
                spaceId,
                title: "Target Parent",
                parentId: null,
                path: [],
                deleted: false,
            });

            documentsStore.set("doc-root", {
                spaceId,
                title: "Subtree Root",
                parentId: "old-deleted-parent",
                path: ["old-deleted-parent"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "doc-root",
                deletionGroupCount: 2,
            });
            documentsStore.set("doc-child", {
                spaceId,
                title: "Subtree Child",
                parentId: "doc-root",
                path: ["old-deleted-parent", "doc-root"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "doc-root",
            });

            // Explicit tagged contract: { kind: "document", parentId: "target-parent" }
            const result = await restoreDocumentAction("token", spaceId, "doc-root", { kind: "document", parentId: "target-parent" });
            assert.equal(result.success, true);
            assert.equal(result.restoredCount, 2);

            const root = documentsStore.get("doc-root")!;
            assert.equal(root.deleted, false);
            assert.equal(root.parentId, "target-parent");
            assert.deepEqual(root.path, ["target-parent"]);

            const child = documentsStore.get("doc-child")!;
            assert.equal(child.deleted, false);
            assert.equal(child.parentId, "doc-root");
            assert.deepEqual(child.path, ["target-parent", "doc-root"]);
        });

        test("rejects malformed, missing, or unknown destination kinds and never defaults to root", async () => {
            const groupId = "grp-qa-invalid";
            documentsStore.set("doc-root", {
                spaceId,
                title: "Subtree Root",
                parentId: "original-p",
                path: ["original-p"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "doc-root",
                deletionGroupCount: 1,
            });

            // 1. Missing destination / undefined
            await assert.rejects(
                () => (restoreDocumentAction as unknown as (t: string, s: string, id: string) => Promise<unknown>)("token", spaceId, "doc-root"),
                /Invalid restoration destination: explicit tagged destination object required/
            );

            // 2. null destination
            await assert.rejects(
                () => (restoreDocumentAction as unknown as (t: string, s: string, id: string, d: unknown) => Promise<unknown>)("token", spaceId, "doc-root", null),
                /Invalid restoration destination: explicit tagged destination object required/
            );

            // 3. Empty object
            await assert.rejects(
                () => (restoreDocumentAction as unknown as (t: string, s: string, id: string, d: unknown) => Promise<unknown>)("token", spaceId, "doc-root", {}),
                /Invalid restoration destination: explicit tagged destination object required/
            );

            // 4. Unknown kind
            await assert.rejects(
                () => (restoreDocumentAction as unknown as (t: string, s: string, id: string, d: unknown) => Promise<unknown>)("token", spaceId, "doc-root", { kind: "unexpected" }),
                /Invalid restoration destination kind/
            );

            // 5. { kind: "document" } missing parentId
            await assert.rejects(
                () => (restoreDocumentAction as unknown as (t: string, s: string, id: string, d: unknown) => Promise<unknown>)("token", spaceId, "doc-root", { kind: "document" }),
                /Invalid restoration destination: parentId string required for document destination/
            );

            // 6. { kind: "document" } with null parentId
            await assert.rejects(
                () => (restoreDocumentAction as unknown as (t: string, s: string, id: string, d: unknown) => Promise<unknown>)("token", spaceId, "doc-root", { kind: "document", parentId: null }),
                /Invalid restoration destination: parentId string required for document destination/
            );

            // 7. { kind: "document" } with empty string parentId
            await assert.rejects(
                () => (restoreDocumentAction as unknown as (t: string, s: string, id: string, d: unknown) => Promise<unknown>)("token", spaceId, "doc-root", { kind: "document", parentId: "" }),
                /Invalid restoration destination: parentId string required for document destination/
            );

            // Verify document was never modified or reparented to root
            const root = documentsStore.get("doc-root")!;
            assert.equal(root.deleted, true);
            assert.equal(root.parentId, "original-p");
            assert.deepEqual(root.path, ["original-p"]);
        });

        test("single document restore tagged semantics", async () => {
            // Single doc whose parent is soft-deleted
            documentsStore.set("parent-del", {
                spaceId,
                title: "Parent Del",
                parentId: null,
                path: [],
                deleted: true,
                deletedAt: {},
            });
            documentsStore.set("single-doc", {
                spaceId,
                title: "Single Doc",
                parentId: "parent-del",
                path: ["parent-del"],
                deleted: true,
                deletedAt: {},
            });

            // 1. Tagged { kind: "original" } returns requiresDestination: true
            const res1 = await restoreDocumentAction("token", spaceId, "single-doc", { kind: "original" });
            assert.equal(res1.success, false);
            assert.equal(res1.requiresDestination, true);
            assert.equal(documentsStore.get("single-doc")?.deleted, true);
            assert.equal(documentsStore.get("single-doc")?.parentId, "parent-del");
            assert.equal(documentsStore.get("single-doc")?.lifecycleClaim, null);

            // 2. Explicit { kind: "root" } restores to root
            const res2 = await restoreDocumentAction("token", spaceId, "single-doc", { kind: "root" });
            assert.equal(res2.success, true);
            assert.equal(documentsStore.get("single-doc")?.deleted, false);
            assert.equal(documentsStore.get("single-doc")?.parentId, null);
            assert.deepEqual(documentsStore.get("single-doc")?.path, []);

            // 3. Explicit { kind: "document", parentId: "target-p" } restores beneath target
            documentsStore.set("target-p", { spaceId, title: "Target P", parentId: null, path: [], deleted: false });
            documentsStore.set("single-doc-2", { spaceId, title: "Doc 2", parentId: "parent-del", path: ["parent-del"], deleted: true, deletedAt: {} });
            const res3 = await restoreDocumentAction("token", spaceId, "single-doc-2", { kind: "document", parentId: "target-p" });
            assert.equal(res3.success, true);
            assert.equal(documentsStore.get("single-doc-2")?.deleted, false);
            assert.equal(documentsStore.get("single-doc-2")?.parentId, "target-p");
            assert.deepEqual(documentsStore.get("single-doc-2")?.path, ["target-p"]);
        });

        test("subtree soft deletion detaches group root with restoreParentId and normalizes descendants to Trash-local paths", async () => {
            documentsStore.set("ext-active-parent", {
                spaceId,
                title: "External Active Parent",
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("del-root", {
                spaceId,
                title: "Subtree Root to Delete",
                parentId: "ext-active-parent",
                path: ["ext-active-parent"],
                deleted: false,
            });
            documentsStore.set("del-child", {
                spaceId,
                title: "Subtree Child to Delete",
                parentId: "del-root",
                path: ["ext-active-parent", "del-root"],
                deleted: false,
            });

            const delResult = await softDeleteDocumentAction("token", spaceId, "del-root", "delete-subtree");
            assert.equal(delResult.success, true);

            const root = documentsStore.get("del-root")!;
            assert.equal(root.deleted, true);
            // Group root is detached from external parent; records restoreParentId
            assert.equal(root.parentId, null);
            assert.deepEqual(root.path, []);
            assert.equal(root.restoreParentId, "ext-active-parent");
            assert.ok(root.deletionGroupId);
            assert.equal(root.deletionGroupRootId, "del-root");
            assert.equal(root.deletionGroupCount, 2);

            const child = documentsStore.get("del-child")!;
            assert.equal(child.deleted, true);
            assert.equal(child.parentId, "del-root");
            // Child normalized to Trash-local path
            assert.deepEqual(child.path, ["del-root"]);
            assert.equal(child.restoreParentId, undefined);
        });

        describe("trash-restore pure helpers", () => {
            test("evaluateRestoreResult correctly distinguishes requiresDestination from success", () => {
                const doc = { id: "doc-1", title: "My Subtree" };

                // requiresDestination -> OPEN_DESTINATION_PICKER
                const pickerAction = evaluateRestoreResult({ requiresDestination: true }, doc);
                assert.equal(pickerAction.type, "OPEN_DESTINATION_PICKER");
                if (pickerAction.type === "OPEN_DESTINATION_PICKER") {
                    assert.equal(pickerAction.rehomeDoc.id, "doc-1");
                    assert.equal(pickerAction.rehomeDoc.title, "My Subtree");
                    assert.ok(pickerAction.explanation.includes("original parent document is no longer available"));
                }

                // success -> RESTORE_SUCCESS
                const successAction = evaluateRestoreResult({ success: true, restoredCount: 4 }, doc);
                assert.equal(successAction.type, "RESTORE_SUCCESS");
                if (successAction.type === "RESTORE_SUCCESS") {
                    assert.equal(successAction.restoredCount, 4);
                }

                // noop for empty or undefined result
                const noopAction = evaluateRestoreResult(null, doc);
                assert.equal(noopAction.type, "NOOP");
            });

            test("createInitialRestorePayload returns tagged original destination", () => {
                assert.deepEqual(createInitialRestorePayload("doc-1"), {
                    docId: "doc-1",
                    destination: { kind: "original" },
                });
            });

            test("formatRestorePayload formats payload with tagged destination", () => {
                assert.deepEqual(formatRestorePayload("doc-1", { kind: "root" }), {
                    docId: "doc-1",
                    destination: { kind: "root" },
                });
                assert.deepEqual(formatRestorePayload("doc-1", { kind: "document", parentId: "p-2" }), {
                    docId: "doc-1",
                    destination: { kind: "document", parentId: "p-2" },
                });
            });

            test("resolvePickerDestination converts selected parent into RestoreDestination and rejects undefined", () => {
                assert.deepEqual(resolvePickerDestination(null), { kind: "root" });
                assert.deepEqual(resolvePickerDestination("parent-3"), { kind: "document", parentId: "parent-3" });
                assert.throws(() => resolvePickerDestination(undefined), /No destination selected/);
            });

            test("handlePickerCancel returns null to close dialog without restore", () => {
                assert.equal(handlePickerCancel(), null);
            });

            test("evaluateRestoreResult populates rehomeDoc.subtreeHeight with fallback to 1", () => {
                const doc = { id: "doc-1", title: "My Subtree", subtreeHeight: 3 };
                const pickerAction = evaluateRestoreResult({ requiresDestination: true }, doc);
                assert.equal(pickerAction.type, "OPEN_DESTINATION_PICKER");
                if (pickerAction.type === "OPEN_DESTINATION_PICKER") {
                    assert.equal(pickerAction.rehomeDoc.subtreeHeight, 3);
                }

                // Fallback to 1 when subtreeHeight not provided
                const docNoHeight = { id: "doc-2", title: "Single" };
                const pickerAction2 = evaluateRestoreResult({ requiresDestination: true }, docNoHeight);
                if (pickerAction2.type === "OPEN_DESTINATION_PICKER") {
                    assert.equal(pickerAction2.rehomeDoc.subtreeHeight, 1);
                }

                // Response subtreeHeight takes precedence if provided by server
                const pickerAction3 = evaluateRestoreResult({ requiresDestination: true, subtreeHeight: 2 }, docNoHeight);
                if (pickerAction3.type === "OPEN_DESTINATION_PICKER") {
                    assert.equal(pickerAction3.rehomeDoc.subtreeHeight, 2);
                }
            });

            test("interaction contract: canSelectDestination and isDestinationConfirmationEnabled", () => {
                // Invalid destination cannot be selected by mouse or keyboard
                assert.equal(canSelectDestination({ valid: false }), false);
                assert.equal(canSelectDestination({ valid: true }), true);

                // Confirmation remains disabled when no destination selected or invalid destination
                assert.equal(isDestinationConfirmationEnabled(undefined, { valid: false }), false);
                assert.equal(isDestinationConfirmationEnabled(undefined, { valid: true }), false);
                assert.equal(isDestinationConfirmationEnabled("dest-invalid", { valid: false }), false);

                // Confirmation remains disabled while mutation is pending
                assert.equal(isDestinationConfirmationEnabled("dest-valid", { valid: true }, true), false);

                // Valid destination enables confirmation
                assert.equal(isDestinationConfirmationEnabled("dest-valid", { valid: true }, false), true);
                assert.equal(isDestinationConfirmationEnabled(null, { valid: true }, false), true); // Space root
            });

            test("calculateDeletedDocumentSubtreeHeight computes Trash subtree height", () => {
                const trashDocs = [
                    { id: "doc-A", deletionGroupId: "grp-1", path: [] },
                    { id: "doc-B", deletionGroupId: "grp-1", path: ["doc-A"] },
                    { id: "doc-C", deletionGroupId: "grp-1", path: ["doc-A", "doc-B"] },
                    { id: "doc-other", path: [] },
                ];

                // 3-level subtree
                assert.equal(calculateDeletedDocumentSubtreeHeight("doc-A", trashDocs), 3);
                // 1-level doc
                assert.equal(calculateDeletedDocumentSubtreeHeight("doc-other", trashDocs), 1);
                // Nonexistent doc
                assert.equal(calculateDeletedDocumentSubtreeHeight("nonexistent", trashDocs), 1);
            });

            test("server rejection remains intact: restoring subtree to over-depth destination throws error", async () => {
                // Active destination hierarchy:
                // jukukekkuli (depth 1)
                // └── raikuli (depth 2)
                //     └── kuikkeli (depth 3)
                documentsStore.set("jukukekkuli", { spaceId, title: "jukukekkuli", parentId: null, path: [], deleted: false });
                documentsStore.set("raikuli", { spaceId, title: "raikuli", parentId: "jukukekkuli", path: ["jukukekkuli"], deleted: false });
                documentsStore.set("kuikkeli", { spaceId, title: "kuikkeli", parentId: "raikuli", path: ["jukukekkuli", "raikuli"], deleted: false });

                // Deleted 3-level subtree: A -> B -> C
                const grpId = "grp-qa-overdepth";
                documentsStore.set("doc-A", {
                    spaceId,
                    title: "Doc A",
                    parentId: null,
                    path: [],
                    deleted: true,
                    deletedAt: {},
                    deletionGroupId: grpId,
                    deletionGroupRootId: "doc-A",
                    deletionGroupCount: 3,
                });
                documentsStore.set("doc-B", {
                    spaceId,
                    title: "Doc B",
                    parentId: "doc-A",
                    path: ["doc-A"],
                    deleted: true,
                    deletedAt: {},
                    deletionGroupId: grpId,
                    deletionGroupRootId: "doc-A",
                    deletionGroupCount: 3,
                });
                documentsStore.set("doc-C", {
                    spaceId,
                    title: "Doc C",
                    parentId: "doc-B",
                    path: ["doc-A", "doc-B"],
                    deleted: true,
                    deletedAt: {},
                    deletionGroupId: grpId,
                    deletionGroupRootId: "doc-A",
                    deletionGroupCount: 3,
                });

                // Attempting restore beneath kuikkeli (depth 3 + height 3 = 6 > 4)
                await assert.rejects(
                    () => restoreDocumentAction("token", spaceId, "doc-A", { kind: "document", parentId: "kuikkeli" }),
                    /Restoring to this destination exceeds the maximum hierarchy depth of 4 levels/
                );

                // Attempting restore beneath raikuli (depth 2 + height 3 = 5 > 4)
                await assert.rejects(
                    () => restoreDocumentAction("token", spaceId, "doc-A", { kind: "document", parentId: "raikuli" }),
                    /Restoring to this destination exceeds the maximum hierarchy depth of 4 levels/
                );

                // Restoring beneath jukukekkuli (depth 1 + height 3 = 4 <= 4) succeeds!
                const resJuku = await restoreDocumentAction("token", spaceId, "doc-A", { kind: "document", parentId: "jukukekkuli" });
                assert.equal(resJuku.success, true);
                assert.equal(resJuku.restoredCount, 3);
            });
        });
    });

    describe("Active vs Historical Soft-Deleted Descendant Lifecycle & Reproduction Regression", () => {
        test("disproved QA bug reproduction: deleting parent P preserves previously soft-deleted subtree A -> B and its original parent relationship", async () => {
            // P
            // └── A
            //     └── B
            documentsStore.set("P", {
                spaceId,
                title: "Parent P",
                parentId: null,
                path: [],
                deleted: false,
            });
            documentsStore.set("A", {
                spaceId,
                title: "Document A",
                parentId: "P",
                path: ["P"],
                deleted: false,
            });
            documentsStore.set("B", {
                spaceId,
                title: "Document B",
                parentId: "A",
                path: ["P", "A"],
                deleted: false,
            });

            getDocumentContentUrlsMock.mock.mockImplementation(async (id: string) => [
                `https://bucket.s3.amazonaws.com/uploads/s/${id}/img.png`,
            ]);

            // 1. Soft-delete A and B as one subtree group
            softDeleteImagesMock.mock.resetCalls();
            const delAResult = await softDeleteDocumentAction("token", spaceId, "A", "delete-subtree");
            assert.equal(delAResult.success, true);
            assert.equal(delAResult.affectedCount, 2);

            // 2. Record the complete stored state of A and B
            const aBefore = { ...documentsStore.get("A")! };
            const bBefore = { ...documentsStore.get("B")! };
            assert.equal(aBefore.deleted, true);
            assert.equal(aBefore.parentId, null);
            assert.deepEqual(aBefore.path, []);
            assert.equal(aBefore.restoreParentId, "P");
            assert.ok(aBefore.deletionGroupId);
            assert.equal(aBefore.deletionGroupRootId, "A");
            assert.equal(aBefore.deletionGroupCount, 2);
            assert.equal(bBefore.deleted, true);
            assert.equal(bBefore.parentId, "A");
            assert.deepEqual(bBefore.path, ["A"]);
            assert.equal(bBefore.deletionGroupId, aBefore.deletionGroupId);
            assert.equal(bBefore.restoreParentId, undefined);

            // 3. Soft-delete P using "move-descendants" (e.g. to Space root)
            softDeleteImagesMock.mock.resetCalls();
            const delPResult = await softDeleteDocumentAction("token", spaceId, "P", "move-descendants", null);
            assert.equal(delPResult.success, true);
            // P has no active direct children; behaves as leaf deletion; does not include A or B
            assert.equal(delPResult.affectedCount, 1);

            // 4. Assert:
            // - A is Trash-local group root: parentId is null, restoreParentId is P
            const aAfter = documentsStore.get("A")!;
            assert.equal(aAfter.parentId, null);
            assert.deepEqual(aAfter.path, []);
            assert.equal(aAfter.restoreParentId, "P");

            // - B is Trash-local child: parentId is A, path is ["A"]
            const bAfter = documentsStore.get("B")!;
            assert.equal(bAfter.parentId, "A");
            assert.deepEqual(bAfter.path, ["A"]);
            assert.equal(bAfter.restoreParentId, undefined);

            // - A and B remain in their original deletion group
            assert.equal(aAfter.deletionGroupId, aBefore.deletionGroupId);
            assert.equal(aAfter.deletionGroupRootId, "A");
            assert.equal(aAfter.deletionGroupCount, 2);
            assert.equal(bAfter.deletionGroupId, bBefore.deletionGroupId);
            assert.equal(bAfter.deletionGroupRootId, "A");

            // - Their deleted timestamps and deletion metadata are not overwritten
            assert.equal(aAfter.deletedAt, aBefore.deletedAt);
            assert.equal(aAfter.deletedBy, aBefore.deletedBy);
            assert.equal(bAfter.deletedAt, bBefore.deletedAt);
            assert.equal(bAfter.deletedBy, bBefore.deletedBy);

            // - Their lifecycle claims remain clear after P's operation
            assert.equal(aAfter.lifecycleClaim, null);
            assert.equal(bAfter.lifecycleClaim, null);

            // - No S3 operation is performed for A or B
            assert.equal(softDeleteImagesMock.mock.callCount(), 1); // Only for P
            assert.equal(softDeleteImagesMock.mock.calls[0].arguments[2], "P");

            // 5. Attempt to restore A using { kind: "original" }
            restoreImagesMock.mock.resetCalls();
            const restoreAResult = await restoreDocumentAction("token", spaceId, "A", { kind: "original" });

            // 6. Because P is soft-deleted, assert:
            // - requiresDestination === true
            // - A and B remain deleted
            // - zero restore S3 calls occur
            // - no claim remains while waiting for destination selection
            assert.equal(restoreAResult.success, false);
            assert.equal(restoreAResult.requiresDestination, true);
            assert.equal(restoreAResult.restoredCount, 0);
            assert.equal(documentsStore.get("A")!.deleted, true);
            assert.equal(documentsStore.get("B")!.deleted, true);
            assert.equal(restoreImagesMock.mock.callCount(), 0);
            assert.equal(documentsStore.get("A")!.lifecycleClaim, null);
            assert.equal(documentsStore.get("B")!.lifecycleClaim, null);

            // 7. Feed the result through the Trash restore controller and prove explanation and destination picker state are produced
            const evalResult = evaluateRestoreResult(restoreAResult, { id: "A", title: "Document A" });
            assert.equal(evalResult.type, "OPEN_DESTINATION_PICKER");
            if (evalResult.type === "OPEN_DESTINATION_PICKER") {
                assert.equal(evalResult.rehomeDoc.id, "A");
                assert.equal(evalResult.rehomeDoc.title, "Document A");
                assert.ok(evalResult.explanation.includes("original parent document is no longer available"));
            }
        });

        test("active direct child is still reparented correctly while preserving internal hierarchy", async () => {
            // P -> C -> D
            documentsStore.set("P", { spaceId, title: "P", parentId: null, path: [], deleted: false });
            documentsStore.set("C", { spaceId, title: "C", parentId: "P", path: ["P"], deleted: false });
            documentsStore.set("D", { spaceId, title: "D", parentId: "C", path: ["P", "C"], deleted: false });

            const result = await softDeleteDocumentAction("token", spaceId, "P", "move-descendants", null);
            assert.equal(result.success, true);
            assert.equal(result.affectedCount, 3); // P + C + D

            const pDoc = documentsStore.get("P")!;
            assert.equal(pDoc.deleted, true);

            const cDoc = documentsStore.get("C")!;
            assert.equal(cDoc.deleted, false);
            assert.equal(cDoc.parentId, null);
            assert.deepEqual(cDoc.path, []);

            const dDoc = documentsStore.get("D")!;
            assert.equal(dDoc.deleted, false);
            assert.equal(dDoc.parentId, "C");
            assert.deepEqual(dDoc.path, ["C"]);
        });

        test("mixture of active and already-deleted direct children moves only the active children", async () => {
            // P -> A (already soft-deleted in grp-A)
            // P -> C (active, with active child D)
            documentsStore.set("P", { spaceId, title: "P", parentId: null, path: [], deleted: false });
            documentsStore.set("A", {
                spaceId,
                title: "A",
                parentId: "P",
                path: ["P"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: "grp-A",
                deletionGroupRootId: "A",
                deletionGroupCount: 1,
            });
            documentsStore.set("C", { spaceId, title: "C", parentId: "P", path: ["P"], deleted: false });
            documentsStore.set("D", { spaceId, title: "D", parentId: "C", path: ["P", "C"], deleted: false });

            const result = await softDeleteDocumentAction("token", spaceId, "P", "move-descendants", null);
            assert.equal(result.success, true);
            assert.equal(result.affectedCount, 3); // P + C + D (A is not included!)

            // Active child C moved to root
            const cDoc = documentsStore.get("C")!;
            assert.equal(cDoc.parentId, null);
            assert.deepEqual(cDoc.path, []);

            // Active child D updated
            const dDoc = documentsStore.get("D")!;
            assert.equal(dDoc.parentId, "C");
            assert.deepEqual(dDoc.path, ["C"]);

            // Historical deleted child A: strictly preserved and NOT reparented
            const aDoc = documentsStore.get("A")!;
            assert.equal(aDoc.deleted, true);
            assert.equal(aDoc.parentId, "P");
            assert.deepEqual(aDoc.path, ["P"]);
            assert.equal(aDoc.deletionGroupId, "grp-A");
            assert.equal(aDoc.deletionGroupRootId, "A");
            assert.equal(aDoc.deletionGroupCount, 1);
            assert.ok(!aDoc.lifecycleClaim);
        });

        test("'delete-subtree' does not merge an older deletion group into the new group", async () => {
            // P -> A (already soft-deleted in grp-old with B)
            // P -> C (active)
            documentsStore.set("P", { spaceId, title: "P", parentId: null, path: [], deleted: false });
            documentsStore.set("A", {
                spaceId,
                title: "A",
                parentId: "P",
                path: ["P"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: "grp-old",
                deletionGroupRootId: "A",
                deletionGroupCount: 2,
            });
            documentsStore.set("B", {
                spaceId,
                title: "B",
                parentId: "A",
                path: ["P", "A"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: "grp-old",
                deletionGroupRootId: "A",
                deletionGroupCount: 2,
            });
            documentsStore.set("C", { spaceId, title: "C", parentId: "P", path: ["P"], deleted: false });

            const result = await softDeleteDocumentAction("token", spaceId, "P", "delete-subtree");
            assert.equal(result.success, true);
            assert.equal(result.affectedCount, 2); // P + C only!

            const pDoc = documentsStore.get("P")!;
            assert.equal(pDoc.deleted, true);
            assert.ok(pDoc.deletionGroupId);
            assert.notEqual(pDoc.deletionGroupId, "grp-old");
            assert.equal(pDoc.deletionGroupCount, 2);

            const cDoc = documentsStore.get("C")!;
            assert.equal(cDoc.deleted, true);
            assert.equal(cDoc.deletionGroupId, pDoc.deletionGroupId);

            // A and B remain strictly in grp-old with count 2 and parent preserved
            const aDoc = documentsStore.get("A")!;
            assert.equal(aDoc.deletionGroupId, "grp-old");
            assert.equal(aDoc.deletionGroupRootId, "A");
            assert.equal(aDoc.deletionGroupCount, 2);
            assert.equal(aDoc.parentId, "P");
            assert.deepEqual(aDoc.path, ["P"]);

            const bDoc = documentsStore.get("B")!;
            assert.equal(bDoc.deletionGroupId, "grp-old");
            assert.equal(bDoc.deletionGroupRootId, "A");
            assert.equal(bDoc.deletionGroupCount, 2);
            assert.equal(bDoc.parentId, "A");
            assert.deepEqual(bDoc.path, ["P", "A"]);
        });

        test("an already-deleted group beneath an active child retains its parent and group metadata if canonical paths need adjustment", async () => {
            // P -> C (active) -> D (active) -> E (deleted in grp-E)
            documentsStore.set("P", { spaceId, title: "P", parentId: null, path: [], deleted: false });
            documentsStore.set("C", { spaceId, title: "C", parentId: "P", path: ["P"], deleted: false });
            documentsStore.set("D", { spaceId, title: "D", parentId: "C", path: ["P", "C"], deleted: false });
            documentsStore.set("E", {
                spaceId,
                title: "E",
                parentId: "D",
                path: ["P", "C", "D"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: "grp-E",
                deletionGroupRootId: "E",
                deletionGroupCount: 1,
            });

            const result = await softDeleteDocumentAction("token", spaceId, "P", "move-descendants", null);
            assert.equal(result.success, true);
            assert.equal(result.affectedCount, 3); // P + C + D (E is already deleted, so not in affected count!)

            const cDoc = documentsStore.get("C")!;
            assert.equal(cDoc.parentId, null);
            assert.deepEqual(cDoc.path, []);

            const dDoc = documentsStore.get("D")!;
            assert.equal(dDoc.parentId, "C");
            assert.deepEqual(dDoc.path, ["C"]);

            // E's path was updated to remain canonical relative to D: ["C", "D"]
            const eDoc = documentsStore.get("E")!;
            assert.equal(eDoc.deleted, true);
            assert.equal(eDoc.parentId, "D"); // Parent unchanged!
            assert.deepEqual(eDoc.path, ["C", "D"]); // Canonical path relative to D
            assert.equal(eDoc.deletionGroupId, "grp-E"); // Group metadata unchanged!
            assert.equal(eDoc.deletionGroupRootId, "E");
            assert.equal(eDoc.deletionGroupCount, 1);
            assert.equal(eDoc.lifecycleClaim, null); // Claim cleared
        });

        test("safe write limit: moved active child with historical path-only descendants at exact transaction boundary (250 docs)", async () => {
            // 1 root doc + 1 active child + 248 historical path-only descendants = 250 total documents to mutate
            documentsStore.set("P", { spaceId, title: "P", parentId: null, path: [], deleted: false });
            documentsStore.set("C", { spaceId, title: "C", parentId: "P", path: ["P"], deleted: false });
            for (let i = 1; i <= 248; i++) {
                documentsStore.set(`hist-${i}`, {
                    spaceId,
                    title: `Hist ${i}`,
                    parentId: "C",
                    path: ["P", "C"],
                    deleted: true,
                    deletedAt: {},
                    deletionGroupId: "grp-hist",
                    deletionGroupRootId: "hist-1",
                    deletionGroupCount: 248,
                });
            }

            const result = await softDeleteDocumentAction("token", spaceId, "P", "move-descendants", null);
            assert.equal(result.success, true);
            // User-facing affectedCount includes only P and C (active moving descendants), excluding historical docs:
            assert.equal(result.affectedCount, 2);

            const pDoc = documentsStore.get("P")!;
            assert.equal(pDoc.deleted, true);
            assert.equal(pDoc.lifecycleClaim, null);

            const cDoc = documentsStore.get("C")!;
            assert.equal(cDoc.parentId, null);
            assert.deepEqual(cDoc.path, []);
            assert.equal(cDoc.lifecycleClaim, null);

            // Historical descendants had paths rewritten canonically from ["P", "C"] to ["C"]
            const hist1 = documentsStore.get("hist-1")!;
            assert.equal(hist1.deleted, true);
            assert.equal(hist1.parentId, "C");
            assert.deepEqual(hist1.path, ["C"]);
            assert.equal(hist1.deletionGroupId, "grp-hist");
            assert.equal(hist1.lifecycleClaim, null);

            const hist248 = documentsStore.get("hist-248")!;
            assert.equal(hist248.deleted, true);
            assert.equal(hist248.parentId, "C");
            assert.deepEqual(hist248.path, ["C"]);
            assert.equal(hist248.deletionGroupId, "grp-hist");
            assert.equal(hist248.lifecycleClaim, null);
        });

        test("safe write limit: 1 document beyond boundary (251 docs with historical path-only descendants) is rejected before S3 or final Firestore mutation", async () => {
            // 1 root doc + 1 active child + 249 historical path-only descendants = 251 total documents to mutate
            documentsStore.set("P", { spaceId, title: "P", parentId: null, path: [], deleted: false });
            documentsStore.set("C", { spaceId, title: "C", parentId: "P", path: ["P"], deleted: false });
            for (let i = 1; i <= 249; i++) {
                documentsStore.set(`hist-${i}`, {
                    spaceId,
                    title: `Hist ${i}`,
                    parentId: "C",
                    path: ["P", "C"],
                    deleted: true,
                    deletedAt: {},
                    deletionGroupId: "grp-hist",
                    deletionGroupRootId: "hist-1",
                    deletionGroupCount: 249,
                });
            }

            softDeleteImagesMock.mock.resetCalls();

            await assert.rejects(
                () => softDeleteDocumentAction("token", spaceId, "P", "move-descendants", null),
                /Operation exceeds safe atomic limit of 250 documents\. Please delete subdocuments in smaller batches\./
            );

            // Verified rejected before S3 image mutation
            assert.equal(softDeleteImagesMock.mock.callCount(), 0);

            // Verified root claim is released
            const pDoc = documentsStore.get("P")!;
            assert.equal(pDoc.deleted, false);
            assert.equal(pDoc.lifecycleClaim, null);

            // Verified no documents mutated
            const cDoc = documentsStore.get("C")!;
            assert.equal(cDoc.parentId, "P");
            assert.deepEqual(cDoc.path, ["P"]);

            const hist1 = documentsStore.get("hist-1")!;
            assert.deepEqual(hist1.path, ["P", "C"]);
        });
    });

    describe("Trash-Local Hierarchy, Active Move Isolation & Restoration Regressions", () => {
        test("Regression A: soft-deleting A -> B -> C detaches Trash subtree completely so active parent kuikkeli has zero descendants in path query", async () => {
            // kuikkeli
            // └── A
            //     └── B
            //         └── C
            documentsStore.set("kuikkeli", { spaceId, title: "kuikkeli", parentId: null, path: [], deleted: false });
            documentsStore.set("A", { spaceId, title: "A", parentId: "kuikkeli", path: ["kuikkeli"], deleted: false });
            documentsStore.set("B", { spaceId, title: "B", parentId: "A", path: ["kuikkeli", "A"], deleted: false });
            documentsStore.set("C", { spaceId, title: "C", parentId: "B", path: ["kuikkeli", "A", "B"], deleted: false });

            // Soft-delete A -> B -> C
            const result = await softDeleteDocumentAction("token", spaceId, "A", "delete-subtree");
            assert.equal(result.success, true);
            assert.equal(result.affectedCount, 3);

            // A is detached root of Trash group
            const docA = documentsStore.get("A")!;
            assert.equal(docA.deleted, true);
            assert.equal(docA.parentId, null);
            assert.deepEqual(docA.path, []);
            assert.equal(docA.restoreParentId, "kuikkeli");
            assert.ok(docA.deletionGroupId);

            // B and C are normalized to Trash-local paths
            const docB = documentsStore.get("B")!;
            assert.equal(docB.deleted, true);
            assert.equal(docB.parentId, "A");
            assert.deepEqual(docB.path, ["A"]);
            assert.equal(docB.restoreParentId, undefined);

            const docC = documentsStore.get("C")!;
            assert.equal(docC.deleted, true);
            assert.equal(docC.parentId, "B");
            assert.deepEqual(docC.path, ["A", "B"]);
            assert.equal(docC.restoreParentId, undefined);

            // Direct query for documents where path contains "kuikkeli" returns empty!
            const snap = await fakeFirestore.collection("documents")
                .where("spaceId", "==", spaceId)
                .where("path", "array-contains", "kuikkeli")
                .get();
            assert.equal(snap.docs.length, 0);

            // kuikkeli remains active and untouched
            const kuikkeliDoc = documentsStore.get("kuikkeli")!;
            assert.equal(kuikkeliDoc.deleted, false);
            assert.ok(!kuikkeliDoc.lifecycleClaim);
        });

        test("Regression B: restoration after former parent moved too deep returns requiresDestination: true with 0 S3 calls, then explicit root restore succeeds", async () => {
            // Setup: kuikkeli originally at Space root, with subtree A -> B -> C
            // Then A -> B -> C was soft-deleted, storing restoreParentId = "kuikkeli"
            const groupId = "grp-abc";
            documentsStore.set("kuikkeli", { spaceId, title: "kuikkeli", parentId: "L2", path: ["L1", "L2"], deleted: false });
            documentsStore.set("A", {
                spaceId,
                title: "A",
                parentId: null,
                path: [],
                restoreParentId: "kuikkeli",
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "A",
                deletionGroupCount: 3,
            });
            documentsStore.set("B", {
                spaceId,
                title: "B",
                parentId: "A",
                path: ["A"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "A",
            });
            documentsStore.set("C", {
                spaceId,
                title: "C",
                parentId: "B",
                path: ["A", "B"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "A",
            });

            restoreImagesMock.mock.resetCalls();

            // Attempt to restore A with { kind: "original" }
            // kuikkeli is at depth 3 (path: ["L1", "L2"]). Group height is 3 (A->B->C).
            // destDepth + groupSubtreeHeight = 3 + 3 = 6 > 4 -> Depth overflow!
            const restoreResult = await restoreDocumentAction("token", spaceId, "A", { kind: "original" });
            assert.equal(restoreResult.success, false);
            assert.equal(restoreResult.requiresDestination, true);
            assert.equal(restoreResult.restoredCount, 0);
            assert.equal(restoreImagesMock.mock.callCount(), 0);

            // Claims released on A, B and C never claimed
            assert.equal(documentsStore.get("A")!.lifecycleClaim, null);
            assert.ok(!documentsStore.get("B")!.lifecycleClaim);
            assert.ok(!documentsStore.get("C")!.lifecycleClaim);

            // User now explicitly chooses Space root: { kind: "root" }
            const rootRestoreResult = await restoreDocumentAction("token", spaceId, "A", { kind: "root" });
            assert.equal(rootRestoreResult.success, true);
            assert.equal(rootRestoreResult.restoredCount, 3);

            // Verified restored to Space root, restoreParentId deleted, paths correct
            const resA = documentsStore.get("A")!;
            assert.equal(resA.deleted, false);
            assert.equal(resA.parentId, null);
            assert.deepEqual(resA.path, []);
            assert.equal(resA.restoreParentId, undefined);

            const resB = documentsStore.get("B")!;
            assert.equal(resB.deleted, false);
            assert.equal(resB.parentId, "A");
            assert.deepEqual(resB.path, ["A"]);
            assert.equal(resB.restoreParentId, undefined);

            const resC = documentsStore.get("C")!;
            assert.equal(resC.deleted, false);
            assert.equal(resC.parentId, "B");
            assert.deepEqual(resC.path, ["A", "B"]);
            assert.equal(resC.restoreParentId, undefined);
        });

        test("Regression C: former parent moves and restoration still fits -> automatic restore succeeds beneath moved parent at current path", async () => {
            // Setup: kuikkeli moved beneath parent1 (path: ["parent1"]) -> depth 2
            // Subtree A -> B has height 2.
            // destDepth + groupSubtreeHeight = 2 + 2 = 4 <= 4 (fits canonical limit!)
            documentsStore.set("parent1", { spaceId, title: "Parent 1", parentId: null, path: [], deleted: false });
            documentsStore.set("kuikkeli", { spaceId, title: "kuikkeli", parentId: "parent1", path: ["parent1"], deleted: false });

            const groupId = "grp-ab";
            documentsStore.set("A", {
                spaceId,
                title: "A",
                parentId: null,
                path: [],
                restoreParentId: "kuikkeli",
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "A",
                deletionGroupCount: 2,
            });
            documentsStore.set("B", {
                spaceId,
                title: "B",
                parentId: "A",
                path: ["A"],
                deleted: true,
                deletedAt: {},
                deletionGroupId: groupId,
                deletionGroupRootId: "A",
            });

            const result = await restoreDocumentAction("token", spaceId, "A", { kind: "original" });
            assert.equal(result.success, true);
            assert.equal(result.restoredCount, 2);

            // A restored beneath kuikkeli at kuikkeli's current new path: ["parent1", "kuikkeli"]
            const resA = documentsStore.get("A")!;
            assert.equal(resA.deleted, false);
            assert.equal(resA.parentId, "kuikkeli");
            assert.deepEqual(resA.path, ["parent1", "kuikkeli"]);
            assert.equal(resA.restoreParentId, undefined); // Cleared via FieldValue.delete()

            // B restored beneath A: ["parent1", "kuikkeli", "A"]
            const resB = documentsStore.get("B")!;
            assert.equal(resB.deleted, false);
            assert.equal(resB.parentId, "A");
            assert.deepEqual(resB.path, ["parent1", "kuikkeli", "A"]);
            assert.equal(resB.restoreParentId, undefined);
        });

        test("Regression D: parent unavailable (missing, soft-deleted, claimed, foreign space, depth overflow) -> all return requiresDestination: true", async () => {
            // 1. Missing parent
            documentsStore.set("target-missing", {
                spaceId,
                title: "Target Missing Parent",
                parentId: null,
                path: [],
                restoreParentId: "nonexistent-parent",
                deleted: true,
                deletedAt: {},
            });
            const resMissing = await restoreDocumentAction("token", spaceId, "target-missing", { kind: "original" });
            assert.equal(resMissing.success, false);
            assert.equal(resMissing.requiresDestination, true);

            // 2. Soft-deleted parent
            documentsStore.set("deleted-p", { spaceId, title: "Deleted P", parentId: null, path: [], deleted: true, deletedAt: {} });
            documentsStore.set("target-deleted-p", {
                spaceId,
                title: "Target Deleted Parent",
                parentId: null,
                path: [],
                restoreParentId: "deleted-p",
                deleted: true,
                deletedAt: {},
            });
            const resDelP = await restoreDocumentAction("token", spaceId, "target-deleted-p", { kind: "original" });
            assert.equal(resDelP.success, false);
            assert.equal(resDelP.requiresDestination, true);

            // 3a. Claimed parent (lifecycleClaim)
            documentsStore.set("claimed-p", {
                spaceId,
                title: "Claimed P",
                parentId: null,
                path: [],
                deleted: false,
                lifecycleClaim: { claimedAt: {}, claimedBy: "other-user", operation: "soft-delete" },
            });
            documentsStore.set("target-claimed-p", {
                spaceId,
                title: "Target Claimed Parent",
                parentId: null,
                path: [],
                restoreParentId: "claimed-p",
                deleted: true,
                deletedAt: {},
            });
            const resClaimedP = await restoreDocumentAction("token", spaceId, "target-claimed-p", { kind: "original" });
            assert.equal(resClaimedP.success, false);
            assert.equal(resClaimedP.requiresDestination, true);

            // 3b. Claimed parent (permanentDeletionClaim)
            documentsStore.set("perm-claimed-p", {
                spaceId,
                title: "Perm Claimed P",
                parentId: null,
                path: [],
                deleted: false,
                permanentDeletionClaim: { claimedAt: {}, claimedBy: "other-user", opId: "perm-op" },
            });
            documentsStore.set("target-perm-claimed-p", {
                spaceId,
                title: "Target Perm Claimed Parent",
                parentId: null,
                path: [],
                restoreParentId: "perm-claimed-p",
                deleted: true,
                deletedAt: {},
            });
            const resPermClaimedP = await restoreDocumentAction("token", spaceId, "target-perm-claimed-p", { kind: "original" });
            assert.equal(resPermClaimedP.success, false);
            assert.equal(resPermClaimedP.requiresDestination, true);

            // 4. Foreign space parent
            documentsStore.set("foreign-p", { spaceId: "foreign-space-id", title: "Foreign P", parentId: null, path: [], deleted: false });
            documentsStore.set("target-foreign-p", {
                spaceId,
                title: "Target Foreign Parent",
                parentId: null,
                path: [],
                restoreParentId: "foreign-p",
                deleted: true,
                deletedAt: {},
            });
            const resForeignP = await restoreDocumentAction("token", spaceId, "target-foreign-p", { kind: "original" });
            assert.equal(resForeignP.success, false);
            assert.equal(resForeignP.requiresDestination, true);

            // 5. Depth overflow (single document at parent depth 4 -> 4 + 1 = 5 > 4)
            documentsStore.set("too-deep-p", { spaceId, title: "Too Deep P", parentId: "L3", path: ["L1", "L2", "L3"], deleted: false });
            documentsStore.set("target-overflow", {
                spaceId,
                title: "Target Overflow",
                parentId: null,
                path: [],
                restoreParentId: "too-deep-p",
                deleted: true,
                deletedAt: {},
            });
            const resOverflow = await restoreDocumentAction("token", spaceId, "target-overflow", { kind: "original" });
            assert.equal(resOverflow.success, false);
            assert.equal(resOverflow.requiresDestination, true);
        });

        test("restoreParentId semantics: absent vs null vs string", async () => {
            // Case 1: restoreParentId === null (deleted from Space root)
            // { kind: "original" } restores directly to Space root without requiresDestination
            documentsStore.set("root-deleted-doc", {
                spaceId,
                title: "Deleted from Space Root",
                parentId: null,
                path: [],
                restoreParentId: null,
                deleted: true,
                deletedAt: {},
            });
            const resNull = await restoreDocumentAction("token", spaceId, "root-deleted-doc", { kind: "original" });
            assert.equal(resNull.success, true);
            assert.equal(resNull.requiresDestination, undefined);
            const docNull = documentsStore.get("root-deleted-doc")!;
            assert.equal(docNull.deleted, false);
            assert.equal(docNull.parentId, null);
            assert.deepEqual(docNull.path, []);
            assert.equal(docNull.restoreParentId, undefined); // Cleared via FieldValue.delete()

            // Case 2: restoreParentId is absent (legacy soft-deleted document)
            // Legacy doc with parentId: null -> restores to Space root
            documentsStore.set("legacy-root-doc", {
                spaceId,
                title: "Legacy Root Doc",
                parentId: null,
                path: [],
                deleted: true,
                deletedAt: {},
            });
            const resLegacyRoot = await restoreDocumentAction("token", spaceId, "legacy-root-doc", { kind: "original" });
            assert.equal(resLegacyRoot.success, true);
            assert.equal(documentsStore.get("legacy-root-doc")!.parentId, null);

            // Legacy doc with parentId: "ext-parent" (which exists and active) -> restores under ext-parent
            documentsStore.set("ext-parent", { spaceId, title: "Ext Parent", parentId: null, path: [], deleted: false });
            documentsStore.set("legacy-child-doc", {
                spaceId,
                title: "Legacy Child Doc",
                parentId: "ext-parent",
                path: ["ext-parent"],
                deleted: true,
                deletedAt: {},
            });
            const resLegacyChild = await restoreDocumentAction("token", spaceId, "legacy-child-doc", { kind: "original" });
            assert.equal(resLegacyChild.success, true);
            assert.equal(documentsStore.get("legacy-child-doc")!.parentId, "ext-parent");
            assert.deepEqual(documentsStore.get("legacy-child-doc")!.path, ["ext-parent"]);

            // Case 3: restoreParentId is string -> validates parent and restores beneath it
            documentsStore.set("string-target", {
                spaceId,
                title: "String Target",
                parentId: null,
                path: [],
                restoreParentId: "ext-parent",
                deleted: true,
                deletedAt: {},
            });
            const resString = await restoreDocumentAction("token", spaceId, "string-target", { kind: "original" });
            assert.equal(resString.success, true);
            assert.equal(documentsStore.get("string-target")!.parentId, "ext-parent");
            assert.deepEqual(documentsStore.get("string-target")!.path, ["ext-parent"]);
            assert.equal(documentsStore.get("string-target")!.restoreParentId, undefined);
        });

        test("restoration destination validation independently rejects destination parents with lifecycleClaim or permanentDeletionClaim", async () => {
            // Parent with lifecycleClaim
            documentsStore.set("parent-with-lc", {
                spaceId,
                title: "Parent with Lifecycle Claim",
                parentId: null,
                path: [],
                deleted: false,
                lifecycleClaim: { claimedAt: {}, claimedBy: "other-user", operation: "soft-delete", opId: "op-lc" },
            });

            // Parent with permanentDeletionClaim
            documentsStore.set("parent-with-pdc", {
                spaceId,
                title: "Parent with Permanent Deletion Claim",
                parentId: null,
                path: [],
                deleted: false,
                permanentDeletionClaim: { claimedAt: {}, claimedBy: "other-user", opId: "op-pdc" },
            });

            // Target doc for original restoration (grouped)
            const grpId = "grp-claim-dest-test";
            documentsStore.set("target-lc-orig", {
                spaceId,
                title: "Target LC Orig",
                parentId: null,
                path: [],
                restoreParentId: "parent-with-lc",
                deleted: true,
                deletedAt: {},
                deletionGroupId: grpId,
                deletionGroupRootId: "target-lc-orig",
                deletionGroupCount: 1,
            });
            documentsStore.set("target-pdc-orig", {
                spaceId,
                title: "Target PDC Orig",
                parentId: null,
                path: [],
                restoreParentId: "parent-with-pdc",
                deleted: true,
                deletedAt: {},
                deletionGroupId: grpId,
                deletionGroupRootId: "target-pdc-orig",
                deletionGroupCount: 1,
            });

            // Target doc for document-kind restoration (grouped)
            documentsStore.set("target-explicit-grp", {
                spaceId,
                title: "Target Explicit Grp",
                parentId: null,
                path: [],
                deleted: true,
                deletedAt: {},
                deletionGroupId: grpId,
                deletionGroupRootId: "target-explicit-grp",
                deletionGroupCount: 1,
            });

            // Target doc for single-document restoration
            documentsStore.set("target-single-doc", {
                spaceId,
                title: "Target Single Doc",
                parentId: null,
                path: [],
                deleted: true,
                deletedAt: {},
            });

            // 1. { kind: "original" } with lifecycleClaim parent -> requiresDestination: true
            const resLcOrig = await restoreDocumentAction("token", spaceId, "target-lc-orig", { kind: "original" });
            assert.equal(resLcOrig.success, false);
            assert.equal(resLcOrig.requiresDestination, true);

            // 2. { kind: "original" } with permanentDeletionClaim parent -> requiresDestination: true
            const resPdcOrig = await restoreDocumentAction("token", spaceId, "target-pdc-orig", { kind: "original" });
            assert.equal(resPdcOrig.success, false);
            assert.equal(resPdcOrig.requiresDestination, true);

            // 3. Group restore with explicit destination: { kind: "document", parentId: "parent-with-lc" }
            await assert.rejects(
                () => restoreDocumentAction("token", spaceId, "target-explicit-grp", { kind: "document", parentId: "parent-with-lc" }),
                /Selected destination parent is deleted, claimed, or unavailable/
            );

            // 4. Group restore with explicit destination: { kind: "document", parentId: "parent-with-pdc" }
            await assert.rejects(
                () => restoreDocumentAction("token", spaceId, "target-explicit-grp", { kind: "document", parentId: "parent-with-pdc" }),
                /Selected destination parent is deleted, claimed, or unavailable/
            );

            // 5. Single doc restore with explicit destination: { kind: "document", parentId: "parent-with-lc" }
            await assert.rejects(
                () => restoreDocumentAction("token", spaceId, "target-single-doc", { kind: "document", parentId: "parent-with-lc" }),
                /Selected destination parent is deleted, claimed, or unavailable/
            );

            // 6. Single doc restore with explicit destination: { kind: "document", parentId: "parent-with-pdc" }
            await assert.rejects(
                () => restoreDocumentAction("token", spaceId, "target-single-doc", { kind: "document", parentId: "parent-with-pdc" }),
                /Selected destination parent is deleted, claimed, or unavailable/
            );
        });
    });
});

