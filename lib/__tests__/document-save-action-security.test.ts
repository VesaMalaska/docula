import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Custom resolver hook for Next.js path aliases and extensionless TS imports
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

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as firestoreActual from "firebase/firestore";

mock.module("server-only", { exports: {} });

// In-Memory Firestore Mock Store
const firestoreStore = new Map<string, Record<string, unknown>>();

interface MockDocRef {
    path: string;
    id: string;
}

const docMock = mock.fn((_db: unknown, ...segments: string[]): MockDocRef => {
    const path = segments.join("/");
    const id = segments[segments.length - 1];
    return { path, id };
});

const cleanupRemovedDocumentImagesMock = mock.fn(async () => {
    return { success: true, cleanedCount: 0, remainingPendingCount: 0 };
});

mock.module("../actions/s3", {
    exports: {
        getPresignedGetUrl: mock.fn(async () => "https://signed.example.com"),
        cleanupRemovedDocumentImages: cleanupRemovedDocumentImagesMock,
        permanentizeImages: mock.fn(async () => ({})),
        deleteImages: mock.fn(async () => {}),
        permanentDeleteImages: mock.fn(async () => {}),
        softDeleteImages: mock.fn(async () => {}),
        restoreImages: mock.fn(async () => {}),
    },
});

mock.module("@/lib/firebase", {
    exports: {
        db: {},
        auth: {
            currentUser: {
                uid: "user-contributor",
                getIdToken: async () => "valid-id-token",
            },
        },
    },
});

mock.module("../server/document-authorization", {
    exports: {
        verifyIdToken: mock.fn(async (idToken: string | undefined) => {
            if (!idToken) throw new Error("Missing ID token");
            return { uid: "user-contributor" };
        }),
        authorizeSpaceContributor: mock.fn(async () => {}),
        getAndVerifyDocument: mock.fn(),
        getDocumentContentUrls: mock.fn(),
        isModernDocumentScopedKey: mock.fn(),
    },
});

const DELETE_FIELD_SENTINEL = { _type: "deleteField" };
const SERVER_TIMESTAMP_SENTINEL = { _type: "serverTimestamp" };

const executeTransaction = async (updateFunction: (tx: unknown) => Promise<unknown>) => {
    const stagedWrites = new Map<string, Record<string, unknown>>();
    const stagedSets = new Map<string, Record<string, unknown>>();

    const tx = {
        get: mock.fn(async (ref: MockDocRef) => {
            const data = firestoreStore.get(ref.path);
            return {
                id: ref.id,
                exists: data !== undefined,
                data: () => (data ? { ...data } : undefined),
            };
        }),
        update: mock.fn((ref: MockDocRef, updates: Record<string, unknown>) => {
            stagedWrites.set(ref.path, updates);
        }),
        set: mock.fn((ref: MockDocRef, data: Record<string, unknown>) => {
            stagedSets.set(ref.path, data);
        }),
    };

    const result = await updateFunction(tx);

    for (const [path, updates] of stagedWrites.entries()) {
        const current = firestoreStore.get(path) || {};
        const next = { ...current };
        for (const [k, v] of Object.entries(updates)) {
            if (v === DELETE_FIELD_SENTINEL) {
                delete next[k];
            } else if (v === SERVER_TIMESTAMP_SENTINEL) {
                next[k] = new Date();
            } else {
                next[k] = v;
            }
        }
        firestoreStore.set(path, next);
    }

    for (const [path, data] of stagedSets.entries()) {
        firestoreStore.set(path, data);
    }

    return result;
};

interface AdminMockDocRef extends MockDocRef {
    collection: (col: string) => { doc: (id: string) => AdminMockDocRef };
}

function createAdminDocRef(path: string): AdminMockDocRef {
    const segments = path.split("/");
    const id = segments[segments.length - 1];
    return {
        path,
        id,
        collection: (subCol: string) => ({
            doc: (subDocId: string) => createAdminDocRef(`${path}/${subCol}/${subDocId}`),
        }),
    };
}

mock.module("firebase-admin/firestore", {
    exports: {
        FieldValue: {
            delete: () => DELETE_FIELD_SENTINEL,
            serverTimestamp: () => SERVER_TIMESTAMP_SENTINEL,
        },
    },
});

mock.module("../server/firebase-admin", {
    exports: {
        getAdminFirestore: () => ({
            collection: (colName: string) => ({
                doc: (docId: string) => createAdminDocRef(`${colName}/${docId}`),
            }),
            runTransaction: executeTransaction,
        }),
    },
});

mock.module("firebase/firestore", {
    exports: {
        ...firestoreActual,
        doc: docMock,
        deleteField: () => DELETE_FIELD_SENTINEL,
        serverTimestamp: () => SERVER_TIMESTAMP_SENTINEL,
    },
});

const { updateDocumentAction } = await import("../actions/document-save.ts");
const { updateDocument } = await import("../actions/document.ts");

function createTipTapDoc(links: string[] = []): Record<string, unknown> {
    return {
        type: "doc",
        content: [
            {
                type: "paragraph",
                content: links.map((targetId) => ({
                    type: "text",
                    text: `Link to ${targetId}`,
                    marks: [
                        {
                            type: "link",
                            attrs: {
                                href: `/doc/${targetId}`,
                            },
                        },
                    ],
                })),
            },
        ],
    };
}

describe("updateDocumentAction Security & Untrusted Input Audit", () => {
    const spaceId = "space-primary";
    const docId = "doc-alpha";
    const docPath = `documents/${docId}`;
    const contentPath = `documents/${docId}/content/main`;
    const spacePath = `spaces/${spaceId}`;

    beforeEach(() => {
        firestoreStore.clear();
        cleanupRemovedDocumentImagesMock.mock.resetCalls();

        // Seed Space
        firestoreStore.set(spacePath, {
            name: "Primary Space",
            ownerId: "user-owner",
            userIds: ["user-owner", "user-contributor"],
            isPublic: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        // Seed Document
        firestoreStore.set(docPath, {
            id: docId,
            spaceId,
            title: "Original Title",
            parentId: null,
            path: [],
            tags: ["initial"],
            createdAt: new Date(),
            updatedAt: new Date(),
            revision: 1,
            lock: null,
            outboundLinks: [],
            backlinks: [],
            deleted: false,
        });

        // Seed Document Content
        firestoreStore.set(contentPath, {
            content: createTipTapDoc([]),
        });
    });

    describe("Negative tests: Rejection of protected fields in untrusted data argument", () => {
        const protectedFieldsToTest: Array<{ field: string; value: unknown }> = [
            { field: "spaceId", value: "malicious-space-transfer" },
            { field: "parentId", value: "unauthorized-parent" },
            { field: "path", value: ["forged", "path"] },
            { field: "createdAt", value: new Date() },
            { field: "updatedAt", value: new Date() },
            { field: "revision", value: 999 },
            { field: "deleted", value: true },
            { field: "deletedAt", value: new Date() },
            { field: "deletedBy", value: "attacker" },
            { field: "deletionGroupId", value: "forged-group" },
            { field: "deletionGroupRootId", value: "forged-root" },
            { field: "deletionGroupCount", value: 5 },
            { field: "restoreParentId", value: "forged-restore-parent" },
            { field: "permanentDeletionClaim", value: { claimedAt: new Date(), claimedBy: "attacker" } },
            { field: "lifecycleClaim", value: { claimedAt: new Date(), claimedBy: "attacker", operation: "soft-delete", opId: "op-1" } },
            { field: "imageCleanupClaim", value: null },
            { field: "pendingImageCleanup", value: [] },
            { field: "retiredImageKeys", value: [] },
            { field: "backlinks", value: ["doc-forged-backlink"] },
            { field: "outboundLinks", value: ["doc-forged-outbound"] },
            { field: "lock", value: null },
        ];

        for (const { field, value } of protectedFieldsToTest) {
            it(`rejects direct Server Action call attempting to supply protected field "${field}" (content save)`, async () => {
                const untrustedPayload = {
                    title: "Attempted Title",
                    content: createTipTapDoc([]),
                    baseRevision: 1,
                    [field]: value,
                };

                await assert.rejects(
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    updateDocumentAction("valid-token", docId, untrustedPayload as any),
                    {
                        name: "Error",
                        message: `Cannot update document: field "${field}" is protected and cannot be modified directly.`,
                    }
                );

                // Verify Firestore document remains completely untouched
                const docSnap = firestoreStore.get(docPath);
                assert.strictEqual(docSnap?.title, "Original Title");
                assert.strictEqual(docSnap?.revision, 1);
                assert.strictEqual(docSnap?.deleted, false);
                assert.strictEqual(docSnap?.spaceId, spaceId);
            });

            it(`rejects direct Server Action call attempting to supply protected field "${field}" (metadata save)`, async () => {
                const untrustedPayload = {
                    title: "Attempted Metadata Title",
                    baseRevision: 1,
                    [field]: value,
                };

                await assert.rejects(
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    updateDocumentAction("valid-token", docId, untrustedPayload as any),
                    {
                        name: "Error",
                        message: `Cannot update document: field "${field}" is protected and cannot be modified directly.`,
                    }
                );

                // Verify Firestore document remains completely untouched
                const docSnap = firestoreStore.get(docPath);
                assert.strictEqual(docSnap?.title, "Original Title");
                assert.strictEqual(docSnap?.revision, 1);
            });
        }

        it("rejects untrusted payload containing arbitrary unallowed fields", async () => {
            await assert.rejects(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                updateDocumentAction("valid-token", docId, { title: "Test", arbitrarySecret: "foo" } as any),
                {
                    name: "Error",
                    message: 'Cannot update document: field "arbitrarySecret" is not allowed.',
                }
            );
        });

        it("rejects mismatched document ID in data payload", async () => {
            await assert.rejects(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                updateDocumentAction("valid-token", docId, { id: "doc-different", title: "Test" } as any),
                {
                    name: "Error",
                    message: "Cannot update document: document ID mismatch.",
                }
            );
        });

        it("rejects non-string title", async () => {
            await assert.rejects(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                updateDocumentAction("valid-token", docId, { title: 12345 } as any),
                {
                    name: "Error",
                    message: "Cannot update document: title must be a string.",
                }
            );
        });

        it("rejects non-string-array tags", async () => {
            await assert.rejects(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                updateDocumentAction("valid-token", docId, { tags: ["valid", 123] } as any),
                {
                    name: "Error",
                    message: "Cannot update document: tags must be an array of strings.",
                }
            );
            await assert.rejects(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                updateDocumentAction("valid-token", docId, { tags: "not-an-array" } as any),
                {
                    name: "Error",
                    message: "Cannot update document: tags must be an array of strings.",
                }
            );
        });

        it("rejects null or non-object data", async () => {
            await assert.rejects(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                updateDocumentAction("valid-token", docId, null as any),
                {
                    name: "Error",
                    message: "Invalid document data",
                }
            );
        });
    });

    describe("Backlink Security: Cross-Space Isolation and Lifecycle Target Protection", () => {
        const otherSpaceId = "space-foreign";
        const otherDocId = "doc-foreign";
        const otherDocPath = `documents/${otherDocId}`;

        beforeEach(() => {
            // Seed a foreign space belonging to another owner
            firestoreStore.set(`spaces/${otherSpaceId}`, {
                name: "Foreign Space",
                ownerId: "user-stranger",
                userIds: ["user-stranger"],
                isPublic: false,
            });

            // Seed target document in foreign space
            firestoreStore.set(otherDocPath, {
                id: otherDocId,
                spaceId: otherSpaceId,
                title: "Foreign Document",
                parentId: null,
                path: [],
                tags: [],
                revision: 1,
                outboundLinks: [],
                backlinks: [],
                deleted: false,
            });
        });

        it("does NOT alter target document backlinks when crafted link points to document in another space", async () => {
            // Contributor in space-primary creates a link pointing to doc-foreign in space-foreign
            const result = await updateDocumentAction("valid-token", docId, {
                content: createTipTapDoc([otherDocId]),
                baseRevision: 1,
            });

            assert.strictEqual(result.contentSaved, true);

            // Target document in other space must have UNTOUCHED backlinks
            const foreignDocSnap = firestoreStore.get(otherDocPath);
            assert.deepStrictEqual(foreignDocSnap?.backlinks, []);

            // Primary document records outbound link legitimately
            const primaryDocSnap = firestoreStore.get(docPath);
            assert.deepStrictEqual(primaryDocSnap?.outboundLinks, [otherDocId]);
        });

        it("does NOT alter target document backlinks when link points to soft-deleted document in same space", async () => {
            const deletedTargetId = "doc-deleted-target";
            const deletedTargetPath = `documents/${deletedTargetId}`;

            firestoreStore.set(deletedTargetPath, {
                id: deletedTargetId,
                spaceId,
                title: "Deleted Target",
                deleted: true,
                deletedAt: new Date(),
                backlinks: ["pre-existing-link"],
            });

            const result = await updateDocumentAction("valid-token", docId, {
                content: createTipTapDoc([deletedTargetId]),
                baseRevision: 1,
            });

            assert.strictEqual(result.contentSaved, true);

            // Deleted target's backlinks remain unchanged
            const deletedSnap = firestoreStore.get(deletedTargetPath);
            assert.deepStrictEqual(deletedSnap?.backlinks, ["pre-existing-link"]);
        });

        it("does NOT alter target document backlinks when target is locked by lifecycleClaim or permanentDeletionClaim", async () => {
            const claimedTargetId = "doc-claimed-target";
            const claimedTargetPath = `documents/${claimedTargetId}`;

            firestoreStore.set(claimedTargetPath, {
                id: claimedTargetId,
                spaceId,
                title: "Claimed Target",
                lifecycleClaim: {
                    claimedAt: new Date(),
                    claimedBy: "admin",
                    operation: "soft-delete",
                    opId: "op-1",
                },
                backlinks: [],
            });

            const result = await updateDocumentAction("valid-token", docId, {
                content: createTipTapDoc([claimedTargetId]),
                baseRevision: 1,
            });

            assert.strictEqual(result.contentSaved, true);

            const claimedSnap = firestoreStore.get(claimedTargetPath);
            assert.deepStrictEqual(claimedSnap?.backlinks, []);
        });

        it("gracefully ignores non-existent target document IDs without failing the save", async () => {
            const nonExistentTargetId = "doc-does-not-exist";

            const result = await updateDocumentAction("valid-token", docId, {
                content: createTipTapDoc([nonExistentTargetId]),
                baseRevision: 1,
            });

            assert.strictEqual(result.contentSaved, true);

            const primaryDocSnap = firestoreStore.get(docPath);
            assert.deepStrictEqual(primaryDocSnap?.outboundLinks, [nonExistentTargetId]);
        });

        it("does NOT add document ID to its own backlinks when self-linking", async () => {
            const result = await updateDocumentAction("valid-token", docId, {
                content: createTipTapDoc([docId]),
                baseRevision: 1,
            });

            assert.strictEqual(result.contentSaved, true);

            const primaryDocSnap = firestoreStore.get(docPath);
            assert.deepStrictEqual(primaryDocSnap?.backlinks, []);
            assert.deepStrictEqual(primaryDocSnap?.outboundLinks, [docId]);
        });
    });

    describe("Positive tests: Ordinary saves, metadata updates, and legitimate backlinks", () => {
        const peerDocId = "doc-peer";
        const peerDocPath = `documents/${peerDocId}`;

        beforeEach(() => {
            // Seed a peer document in the same space
            firestoreStore.set(peerDocPath, {
                id: peerDocId,
                spaceId,
                title: "Peer Document",
                parentId: null,
                path: [],
                tags: [],
                revision: 1,
                outboundLinks: [],
                backlinks: [],
                deleted: false,
            });
        });

        it("ordinary save: updates title, tags, content, increments revision, and sets updatedAt", async () => {
            const newContent = createTipTapDoc([]);
            const result = await updateDocumentAction("valid-token", docId, {
                title: "New Legitimate Title",
                tags: ["tag1", "tag2"],
                content: newContent,
                baseRevision: 1,
            });

            assert.strictEqual(result.contentSaved, true);
            assert.strictEqual(result.cleanupPending, false);

            const docSnap = firestoreStore.get(docPath);
            assert.strictEqual(docSnap?.title, "New Legitimate Title");
            assert.deepStrictEqual(docSnap?.tags, ["tag1", "tag2"]);
            assert.strictEqual(docSnap?.revision, 2);
            assert.ok(docSnap?.updatedAt);

            const contentSnap = firestoreStore.get(contentPath);
            assert.deepStrictEqual(contentSnap?.content, newContent);
        });

        it("ordinary metadata save: updates title and tags without touching content", async () => {
            const result = await updateDocumentAction("valid-token", docId, {
                title: "Metadata Updated Title",
                tags: ["metadata-tag"],
                baseRevision: 1,
            });

            assert.strictEqual(result.contentSaved, true);
            assert.strictEqual(result.cleanupPending, false);

            const docSnap = firestoreStore.get(docPath);
            assert.strictEqual(docSnap?.title, "Metadata Updated Title");
            assert.deepStrictEqual(docSnap?.tags, ["metadata-tag"]);
            assert.strictEqual(docSnap?.revision, 2);

            // Subcollection content remains unchanged
            const contentSnap = firestoreStore.get(contentPath);
            assert.deepStrictEqual(contentSnap?.content, createTipTapDoc([]));
        });

        it("legitimate backlink management: adds backlink on link addition and removes on link deletion", async () => {
            // Step 1: Add link to peer document
            const result1 = await updateDocumentAction("valid-token", docId, {
                content: createTipTapDoc([peerDocId]),
                baseRevision: 1,
            });
            assert.strictEqual(result1.contentSaved, true);

            const peerSnapAfterAdd = firestoreStore.get(peerDocPath);
            assert.deepStrictEqual(peerSnapAfterAdd?.backlinks, [docId]);

            // Step 2: Remove link from content
            const result2 = await updateDocumentAction("valid-token", docId, {
                content: createTipTapDoc([]),
                baseRevision: 2,
            });
            assert.strictEqual(result2.contentSaved, true);

            const peerSnapAfterRemove = firestoreStore.get(peerDocPath);
            assert.deepStrictEqual(peerSnapAfterRemove?.backlinks, []);
        });

        it("client wrapper updateDocument delegates seamlessly with matching baseRevision", async () => {
            const result = await updateDocument(docId, {
                title: "Updated via Client Wrapper",
                content: createTipTapDoc([]),
                baseRevision: 1,
            });

            assert.strictEqual(result.contentSaved, true);
            const docSnap = firestoreStore.get(docPath);
            assert.strictEqual(docSnap?.title, "Updated via Client Wrapper");
            assert.strictEqual(docSnap?.revision, 2);
        });
    });
});
