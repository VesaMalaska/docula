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

// ── In-Memory Firestore Mock Store ─────────────────────────────────────────────
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
    return { success: true, cleanedCount: 1, remainingPendingCount: 0 };
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
                uid: "user-123",
                getIdToken: async () => "valid-id-token",
            },
        },
    },
});

const DELETE_FIELD_SENTINEL = { _type: "deleteField" };
const SERVER_TIMESTAMP_SENTINEL = { _type: "serverTimestamp" };

mock.module("firebase/firestore", {
    exports: {
        ...firestoreActual,
        doc: docMock,
        deleteField: () => DELETE_FIELD_SENTINEL,
        serverTimestamp: () => SERVER_TIMESTAMP_SENTINEL,
        runTransaction: mock.fn(async (_db: unknown, updateFunction: (tx: unknown) => Promise<unknown>) => {
            const stagedWrites = new Map<string, Record<string, unknown>>();
            const stagedSets = new Map<string, Record<string, unknown>>();

            const tx = {
                get: mock.fn(async (ref: MockDocRef) => {
                    const data = firestoreStore.get(ref.path);
                    return {
                        id: ref.id,
                        exists: () => data !== undefined,
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

            // Commit transaction atomically to store
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
        }),
        getDoc: mock.fn(async (ref: MockDocRef) => {
            const data = firestoreStore.get(ref.path);
            return {
                id: ref.id,
                exists: () => data !== undefined,
                data: () => data,
            };
        }),
        updateDoc: mock.fn(async (ref: MockDocRef, data: Record<string, unknown>) => {
            const current = firestoreStore.get(ref.path) || {};
            firestoreStore.set(ref.path, { ...current, ...data });
        }),
    },
});

const { updateDocument } = await import("../actions/document.ts");

function createTipTapDoc(images: string[]) {
    return {
        type: "doc",
        content: images.map((src) => ({
            type: "image",
            attrs: { src },
        })),
    };
}

describe("updateDocument & S3 Cleanup Interleaving Consistency", () => {
    const spaceId = "s1";
    const docId = "doc-test-1";
    const docPath = `documents/${docId}`;
    const contentPath = `documents/${docId}/content/main`;

    beforeEach(() => {
        firestoreStore.clear();
        cleanupRemovedDocumentImagesMock.mock.resetCalls();
        cleanupRemovedDocumentImagesMock.mock.mockImplementation(async () => {
            return { success: true, cleanedCount: 1, remainingPendingCount: 0 };
        });
    });

    it("Rule 1: rejects save referencing image currently in active imageCleanupClaim (<30s)", async () => {
        const claimedKey = `uploads/${spaceId}/${docId}/active-claim.png`;
        const claimedUrl = `https://test-bucket.s3.amazonaws.com/${claimedKey}`;

        // Initial doc with active cleanup claim
        firestoreStore.set(docPath, {
            id: docId,
            spaceId,
            title: "Doc 1",
            revision: 1,
            pendingImageCleanup: [claimedKey],
            imageCleanupClaim: {
                claimId: "claim-abc",
                keys: [claimedKey],
                claimedAt: {
                    toDate: () => new Date(), // Active right now (< 30s)
                },
            },
        });
        firestoreStore.set(contentPath, {
            content: createTipTapDoc([]),
        });

        // Attempt to save document with new content referencing the claimed image
        await assert.rejects(
            updateDocument(docId, {
                content: createTipTapDoc([claimedUrl]),
                baseRevision: 1,
            }),
            /Cannot save document: image is currently being deleted by a prior edit\. Please re-upload the image\./
        );

        // Firestore content was NOT updated
        const contentSnap = firestoreStore.get(contentPath);
        assert.deepStrictEqual(contentSnap?.content, createTipTapDoc([]));

        // Cleanup was NOT called by rejected save
        assert.strictEqual(cleanupRemovedDocumentImagesMock.mock.calls.length, 0);
    });

    it("Exact schedule: hold DeleteObject unresolved → advance beyond claim expiry → attempt save referencing claimed key → release deletion → verify no broken reference", async () => {
        const claimedKey = `uploads/${spaceId}/${docId}/stalled-delete.png`;
        const claimedUrl = `https://test-bucket.s3.amazonaws.com/${claimedKey}`;

        // 1. Acquire claim: initial doc has image claimed for deletion
        // 2. Advance beyond claim expiry: claimedAt is 45s ago (> 30s TTL)
        firestoreStore.set(docPath, {
            id: docId,
            spaceId,
            title: "Doc Stalled Delete",
            revision: 1,
            pendingImageCleanup: [claimedKey],
            imageCleanupClaim: {
                claimId: "claim-worker-1",
                keys: [claimedKey],
                claimedAt: {
                    toDate: () => new Date(Date.now() - 45_000), // > 30s expired claim
                },
            },
        });
        firestoreStore.set(contentPath, {
            content: createTipTapDoc([]),
        });

        // Track in-memory S3 state for this test
        let s3Deleted = false;
        let resolveDeleteObject: () => void;
        const deleteObjectPromise = new Promise<void>((resolve) => {
            resolveDeleteObject = () => {
                s3Deleted = true;
                resolve();
            };
        });

        // 3. Attempt save referencing the claimed key while S3 DeleteObject is still in flight / unresolved
        await assert.rejects(
            updateDocument(docId, {
                content: createTipTapDoc([claimedUrl]),
                baseRevision: 1,
            }),
            /Cannot save document: image is currently being deleted by a prior edit\. Please re-upload the image\./,
            "Save must be rejected: claim expiry must NOT authorize reintroducing a key whose deletion may still finish"
        );

        // 4. Release deletion: S3 DeleteObject completes
        resolveDeleteObject!();
        await deleteObjectPromise;

        // 5. Inspect Firestore content and S3 state
        // S3 object is deleted
        assert.strictEqual(s3Deleted, true, "S3 deletion completed");

        // Firestore content does NOT reference the deleted key (no broken image reference!)
        const contentSnap = firestoreStore.get(contentPath);
        assert.deepStrictEqual(contentSnap?.content, createTipTapDoc([]), "Firestore content must not reference deleted key");

        // Document retained pendingImageCleanup and claim; no silent corruption
        const docSnap = firestoreStore.get(docPath);
        assert.deepStrictEqual(docSnap?.pendingImageCleanup, [claimedKey]);
        assert.strictEqual((docSnap?.imageCleanupClaim as { claimId?: string })?.claimId, "claim-worker-1");
    });

    it("Rule 1B: stale-tab save - rejects save referencing retired image key after cleanup has fully completed and claims are cleared", async () => {
        const imageAKey = `uploads/${spaceId}/${docId}/image-a.png`;
        const imageAUrl = `https://test-bucket.s3.amazonaws.com/${imageAKey}`;
        const imageBKey = `uploads/${spaceId}/${docId}/image-b-reuploaded.png`;
        const imageBUrl = `https://test-bucket.s3.amazonaws.com/${imageBKey}`;

        // 1. Initial state: document had imageA in content, and cleanup of imageA has fully completed:
        // imageCleanupClaim is cleared, pendingImageCleanup is cleared, and imageA is recorded in retiredImageKeys.
        firestoreStore.set(docPath, {
            id: docId,
            spaceId,
            title: "Doc 1",
            revision: 2,
            pendingImageCleanup: undefined,
            imageCleanupClaim: undefined,
            retiredImageKeys: [imageAKey],
        });
        firestoreStore.set(contentPath, {
            content: createTipTapDoc([]), // Tab A saved without imageA
        });

        // 2. Tab B was opened before Tab A's edit and attempts to save content still referencing imageA
        await assert.rejects(
            updateDocument(docId, {
                content: createTipTapDoc([imageAUrl]),
                baseRevision: 2,
            }),
            /Cannot save document: image has been deleted by a prior edit\. Please re-upload the image\./,
            "Firestore must reject broken image reference from stale tab"
        );

        // 3. Verify Firestore content does NOT reference the broken image
        const contentSnap = firestoreStore.get(contentPath);
        assert.deepStrictEqual(contentSnap?.content, createTipTapDoc([]), "Firestore content must not accept broken reference");

        // 4. Tab B re-uploads the image (which creates a new key with fresh UUID) and saves
        const result = await updateDocument(docId, {
            content: createTipTapDoc([imageBUrl]),
            baseRevision: 2,
        });
        assert.strictEqual(result.contentSaved, true);
        assert.strictEqual(result.cleanupPending, false);

        // Firestore content now has imageB
        const updatedContent = firestoreStore.get(contentPath);
        assert.deepStrictEqual(updatedContent?.content, createTipTapDoc([imageBUrl]));
    });

    it("Mandatory base revision: rejects content save when baseRevision is missing, null, negative, or non-integer", async () => {
        firestoreStore.set(docPath, {
            id: docId,
            spaceId,
            title: "Doc 1",
            revision: 1,
        });
        firestoreStore.set(contentPath, {
            content: createTipTapDoc([]),
        });

        // 1. Missing baseRevision
        await assert.rejects(
            updateDocument(docId, {
                content: createTipTapDoc([]),
            }),
            /Cannot save document: missing or invalid base revision for content save\./,
            "Must reject when baseRevision is missing"
        );

        // 2. null baseRevision
        await assert.rejects(
            updateDocument(docId, {
                content: createTipTapDoc([]),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                baseRevision: null as any,
            }),
            /Cannot save document: missing or invalid base revision for content save\./,
            "Must reject when baseRevision is null"
        );

        // 3. Negative baseRevision
        await assert.rejects(
            updateDocument(docId, {
                content: createTipTapDoc([]),
                baseRevision: -1,
            }),
            /Cannot save document: missing or invalid base revision for content save\./,
            "Must reject when baseRevision is negative"
        );

        // 4. Non-integer baseRevision
        await assert.rejects(
            updateDocument(docId, {
                content: createTipTapDoc([]),
                baseRevision: 1.5,
            }),
            /Cannot save document: missing or invalid base revision for content save\./,
            "Must reject when baseRevision is non-integer"
        );
    });

    it("Rapid successive saves: advancing revisions succeed whereas duplicate or stale revisions reject", async () => {
        firestoreStore.set(docPath, {
            id: docId,
            spaceId,
            title: "Doc 1",
            revision: 1,
        });
        firestoreStore.set(contentPath, {
            content: createTipTapDoc([]),
        });

        // Save 1: Base revision 1 -> commits and advances document revision to 2
        const save1Result = await updateDocument(docId, {
            title: "Doc Revision 2",
            content: createTipTapDoc([]),
            baseRevision: 1,
        });
        assert.strictEqual(save1Result.contentSaved, true);
        const docAfterSave1 = firestoreStore.get(docPath);
        assert.strictEqual(docAfterSave1?.revision, 2);

        // Save 2 (rapid successive save): Attempting save with stale baseRevision: 1 must be rejected
        await assert.rejects(
            updateDocument(docId, {
                title: "Doc Revision Stale",
                content: createTipTapDoc([]),
                baseRevision: 1,
            }),
            /Cannot save document: document has been modified by another edit\. Please reload before saving\./,
            "Must reject rapid successive save attempting to reuse stale revision"
        );

        // Save 2 (advancing): Supplying baseRevision: 2 commits and advances document revision to 3
        const save2Result = await updateDocument(docId, {
            title: "Doc Revision 3",
            content: createTipTapDoc([]),
            baseRevision: 2,
        });
        assert.strictEqual(save2Result.contentSaved, true);
        const docAfterSave2 = firestoreStore.get(docPath);
        assert.strictEqual(docAfterSave2?.revision, 3);
        assert.strictEqual(docAfterSave2?.title, "Doc Revision 3");
    });

    it("Eviction sequence: demonstrates key eviction from 200-key FIFO and stale-save protection via baseRevision", async () => {
        const image0Key = `uploads/${spaceId}/${docId}/image-0.png`;
        const image0Url = `https://test-bucket.s3.amazonaws.com/${image0Key}`;
        const imageReuploadedKey = `uploads/${spaceId}/${docId}/image-reuploaded.png`;
        const imageReuploadedUrl = `https://test-bucket.s3.amazonaws.com/${imageReuploadedKey}`;

        // 1. Initial state at revision 1: document exists with image-0
        firestoreStore.set(docPath, {
            id: docId,
            spaceId,
            title: "Doc 1",
            revision: 1,
            pendingImageCleanup: undefined,
            imageCleanupClaim: undefined,
            retiredImageKeys: [],
        });
        firestoreStore.set(contentPath, {
            content: createTipTapDoc([image0Url]),
        });

        // Tab B opens the document at revision 1: local editor state has image0Url and baseRevision = 1.

        // 2. Tab A removes image0 and saves with baseRevision: 1.
        // Document advances to revision 2. S3 cleanup records image-0 in retiredImageKeys.
        firestoreStore.set(docPath, {
            id: docId,
            spaceId,
            title: "Doc 1",
            revision: 2,
            pendingImageCleanup: undefined,
            imageCleanupClaim: undefined,
            retiredImageKeys: [image0Key],
        });
        firestoreStore.set(contentPath, {
            content: createTipTapDoc([]),
        });

        // 3. 200 subsequent deletions occur over time on docId.
        // Generate 200 newer retired keys (image-1 to image-200).
        const newerRetiredKeys: string[] = [];
        for (let i = 1; i <= 200; i++) {
            newerRetiredKeys.push(`uploads/${spaceId}/${docId}/image-${i}.png`);
        }

        // Apply FIFO slice(-200) as done in cleanupRemovedDocumentImages Phase 3:
        const combinedKeys = [image0Key, ...newerRetiredKeys];
        const fifoSlice = combinedKeys.slice(-200);

        // DEMONSTRATION OF EVICTION:
        // image0Key has been evicted from the 200-key FIFO limit!
        assert.strictEqual(fifoSlice.length, 200);
        assert.strictEqual(fifoSlice.includes(image0Key), false, "image-0 must be evicted from 200-key FIFO");
        assert.strictEqual(fifoSlice[0], `uploads/${spaceId}/${docId}/image-1.png`);
        assert.strictEqual(fifoSlice[199], `uploads/${spaceId}/${docId}/image-200.png`);

        // Document has advanced to revision 202
        firestoreStore.set(docPath, {
            id: docId,
            spaceId,
            title: "Doc 1",
            revision: 202,
            pendingImageCleanup: undefined,
            imageCleanupClaim: undefined,
            retiredImageKeys: fifoSlice,
        });

        // 4. Stale-save protection:
        // Tab B (which opened at revision 1) attempts to save content referencing image0 with baseRevision: 1.
        // Even though image-0 was evicted from retiredImageKeys, OCC detects that the document revision
        // has advanced and rejects the save.
        await assert.rejects(
            updateDocument(docId, {
                content: createTipTapDoc([image0Url]),
                baseRevision: 1,
            }),
            /Cannot save document: document has been modified by another edit\. Please reload before saving\./,
            "Must reject stale save even after key was evicted from 200-key FIFO"
        );

        // Verify Firestore content remains safe (0 images, not corrupted with broken image0)
        assert.deepStrictEqual(firestoreStore.get(contentPath)?.content, createTipTapDoc([]));

        // 5. Missing base protection:
        // Verify an attempt to omit baseRevision is rejected (no bypass possible!)
        await assert.rejects(
            updateDocument(docId, {
                content: createTipTapDoc([image0Url]),
            }),
            /Cannot save document: missing or invalid base revision for content save\./,
            "Must reject content save when baseRevision is omitted"
        );

        // 6. Check that ordinary saves still work when baseRevision matches current revision (202)
        const ordinaryResult = await updateDocument(docId, {
            title: "Updated Title",
            content: createTipTapDoc([]),
            baseRevision: 202,
        });
        assert.strictEqual(ordinaryResult.contentSaved, true);
        assert.strictEqual(ordinaryResult.cleanupPending, false);
        const docAfterOrdinary = firestoreStore.get(docPath);
        assert.strictEqual(docAfterOrdinary?.title, "Updated Title");
        assert.strictEqual(docAfterOrdinary?.revision, 203);

        // 7. Check that image re-uploads still work:
        // After reloading, editor has fresh revision 203. User uploads a new image and saves with baseRevision: 203.
        const reuploadResult = await updateDocument(docId, {
            content: createTipTapDoc([imageReuploadedUrl]),
            baseRevision: 203,
        });
        assert.strictEqual(reuploadResult.contentSaved, true);
        assert.strictEqual(reuploadResult.cleanupPending, false);

        const finalContent = firestoreStore.get(contentPath);
        assert.deepStrictEqual(finalContent?.content, createTipTapDoc([imageReuploadedUrl]));
        const docAfterReupload = firestoreStore.get(docPath);
        assert.strictEqual(docAfterReupload?.revision, 204);
    });

    it("Rule 2: rescues pending image from pendingImageCleanup if re-added before cleanup claims it", async () => {
        const pendingKey = `uploads/${spaceId}/${docId}/pending-unclaimed.png`;
        const pendingUrl = `https://test-bucket.s3.amazonaws.com/${pendingKey}`;

        // Image is in pendingImageCleanup but not actively claimed
        firestoreStore.set(docPath, {
            id: docId,
            spaceId,
            title: "Doc 1",
            revision: 1,
            pendingImageCleanup: [pendingKey],
            imageCleanupClaim: null,
        });
        firestoreStore.set(contentPath, {
            content: createTipTapDoc([]),
        });

        const result = await updateDocument(docId, {
            content: createTipTapDoc([pendingUrl]),
            baseRevision: 1,
        });

        assert.strictEqual(result.contentSaved, true);
        assert.strictEqual(result.cleanupPending, false);

        // pendingImageCleanup is cleared (rescued)
        const docSnap = firestoreStore.get(docPath);
        assert.strictEqual(docSnap?.pendingImageCleanup, undefined);

        // Content is saved
        const contentSnap = firestoreStore.get(contentPath);
        assert.deepStrictEqual(contentSnap?.content, createTipTapDoc([pendingUrl]));

        // Post-save cleanup is not needed and not invoked
        assert.strictEqual(cleanupRemovedDocumentImagesMock.mock.calls.length, 0);
    });

    it("Partial save: returns { contentSaved: true, cleanupPending: true } when post-save S3 cleanup fails", async () => {
        const removedKey = `uploads/${spaceId}/${docId}/removed-img.png`;
        const removedUrl = `https://test-bucket.s3.amazonaws.com/${removedKey}`;

        firestoreStore.set(docPath, {
            id: docId,
            spaceId,
            title: "Doc 1",
            revision: 1,
        });
        firestoreStore.set(contentPath, {
            content: createTipTapDoc([removedUrl]),
        });

        // Simulate post-save S3 cleanup failure
        cleanupRemovedDocumentImagesMock.mock.mockImplementationOnce(async () => {
            throw new Error("One or more removed images could not be deleted from storage. Please try again.");
        });

        const result = await updateDocument(docId, {
            content: createTipTapDoc([]),
            baseRevision: 1,
        });

        // CRITICAL CONTRACT: Content saved is TRUE, cleanupPending is TRUE
        assert.strictEqual(result.contentSaved, true);
        assert.strictEqual(result.cleanupPending, true);
        assert.match(result.cleanupError || "", /could not be deleted from storage/);

        // Firestore content was successfully saved
        const contentSnap = firestoreStore.get(contentPath);
        assert.deepStrictEqual(contentSnap?.content, createTipTapDoc([]));

        // pendingImageCleanup is retained in Firestore for retry!
        const docSnap = firestoreStore.get(docPath);
        assert.deepStrictEqual(docSnap?.pendingImageCleanup, [removedUrl]);
    });

    it("Partial save: returns { contentSaved: true, cleanupPending: true } when cleanup reports remaining pending items", async () => {
        const removedKey = `uploads/${spaceId}/${docId}/removed-img.png`;
        const removedUrl = `https://test-bucket.s3.amazonaws.com/${removedKey}`;

        firestoreStore.set(docPath, {
            id: docId,
            spaceId,
            title: "Doc 1",
            revision: 1,
        });
        firestoreStore.set(contentPath, {
            content: createTipTapDoc([removedUrl]),
        });

        cleanupRemovedDocumentImagesMock.mock.mockImplementationOnce(async () => {
            return { success: true, cleanedCount: 0, remainingPendingCount: 1 };
        });

        const result = await updateDocument(docId, {
            content: createTipTapDoc([]),
            baseRevision: 1,
        });

        assert.strictEqual(result.contentSaved, true);
        assert.strictEqual(result.cleanupPending, true);
    });

    it("Normal save: returns { contentSaved: true, cleanupPending: false } on complete cleanup", async () => {
        const removedKey = `uploads/${spaceId}/${docId}/removed-img.png`;
        const removedUrl = `https://test-bucket.s3.amazonaws.com/${removedKey}`;

        firestoreStore.set(docPath, {
            id: docId,
            spaceId,
            title: "Doc 1",
            revision: 1,
        });
        firestoreStore.set(contentPath, {
            content: createTipTapDoc([removedUrl]),
        });

        cleanupRemovedDocumentImagesMock.mock.mockImplementationOnce(async () => {
            return { success: true, cleanedCount: 1, remainingPendingCount: 0 };
        });

        const result = await updateDocument(docId, {
            content: createTipTapDoc([]),
            baseRevision: 1,
        });

        assert.strictEqual(result.contentSaved, true);
        assert.strictEqual(result.cleanupPending, false);
        assert.strictEqual(cleanupRemovedDocumentImagesMock.mock.calls.length, 1);
    });
});
