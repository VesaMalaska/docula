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

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as firestoreActual from "firebase/firestore";

mock.module("server-only", { exports: {} });

// In-memory mock database store
const mockDatabase = new Map<string, Record<string, unknown>>();

interface MockDocRef {
  id: string;
  path: string;
  type: "docRef" | "spaceRef" | "contentRef";
}

let idCounter = 0;
let commitCount = 0;
let commitShouldFail = false;
let customGeneratedId: string | null = null;

const currentAuth: { currentUser: { uid: string } | null } = {
  currentUser: { uid: "user-alice" },
};

const docMock = mock.fn((...args: unknown[]): MockDocRef => {
  if (args.length === 1 && typeof args[0] === "object" && args[0] !== null && "type" in args[0]) {
    // doc(collectionRef) -> pre-generated document reference
    idCounter++;
    const id = customGeneratedId || `gen-doc-${idCounter}`;
    return { id, path: `documents/${id}`, type: "docRef" };
  }
  if (args.length === 3 && args[1] === "spaces") {
    const id = args[2] as string;
    return { id, path: `spaces/${id}`, type: "spaceRef" };
  }
  if (args.length === 3 && args[1] === "documents") {
    const id = args[2] as string;
    return { id, path: `documents/${id}`, type: "docRef" };
  }
  if (args.length === 5 && args[1] === "documents" && args[3] === "content") {
    const docId = args[2] as string;
    const contentId = args[4] as string;
    return { id: contentId, path: `documents/${docId}/content/${contentId}`, type: "contentRef" };
  }
  const fallbackId = `doc-${++idCounter}`;
  return { id: fallbackId, path: `documents/${fallbackId}`, type: "docRef" };
});

const collectionMock = mock.fn((_db: unknown, collectionName: string) => {
  return { collectionName, type: "collectionRef" };
});

const getDocMock = mock.fn(async (ref: MockDocRef) => {
  const data = mockDatabase.get(ref.path);
  return {
    id: ref.id,
    exists: () => data !== undefined,
    data: () => data,
  };
});

const writeBatchMock = mock.fn(() => {
  const staged = new Map<string, Record<string, unknown>>();

  return {
    set: (ref: MockDocRef, data: Record<string, unknown>) => {
      staged.set(ref.path, data);
    },
    update: (ref: MockDocRef, data: Record<string, unknown>) => {
      const existing = mockDatabase.get(ref.path) || {};
      staged.set(ref.path, { ...existing, ...data });
    },
    delete: (ref: MockDocRef) => {
      staged.delete(ref.path);
    },
    commit: async () => {
      commitCount++;
      if (commitShouldFail) {
        throw new Error("Firestore batch commit simulated failure");
      }
      for (const [path, data] of staged.entries()) {
        mockDatabase.set(path, data);
      }
    },
  };
});

mock.module("firebase/firestore", {
  exports: {
    ...firestoreActual,
    doc: docMock,
    collection: collectionMock,
    getDoc: getDocMock,
    writeBatch: writeBatchMock,
    serverTimestamp: () => ({ _method: "serverTimestamp" }),
  },
});

mock.module("@/lib/firebase", {
  exports: {
    db: {},
    get auth() {
      return currentAuth;
    },
  },
});

const { createDocument } = await import("../actions/document.ts");

describe("Document Creation Integrity (Workstream 4.4)", () => {
  const spaceId = "space-test-123";

  beforeEach(() => {
    mockDatabase.clear();
    idCounter = 0;
    commitCount = 0;
    commitShouldFail = false;
    customGeneratedId = null;
    currentAuth.currentUser = { uid: "user-alice" };

    // Set up active test space with alice as owner
    mockDatabase.set(`spaces/${spaceId}`, {
      id: spaceId,
      name: "Engineering Space",
      ownerId: "user-alice",
      userIds: ["user-alice", "user-bob"],
      isPublic: false,
      deletedAt: null,
      deletedBy: null,
    });
  });

  describe("Atomic Creation", () => {
    it("successful creation produces metadata and content, commits exactly one batch, and returns document ID", async () => {
      const docId = await createDocument(spaceId, null, {
        title: "System Architecture",
        content: { type: "doc", content: [{ type: "paragraph", text: "Architecture details" }] },
      });

      // 1. Returns pre-generated document ID
      assert.ok(typeof docId === "string");
      assert.strictEqual(docId, "gen-doc-1");

      // 2. Exactly one batch committed
      assert.strictEqual(commitCount, 1);

      // 3. Metadata exists with expected fields
      const meta = mockDatabase.get(`documents/${docId}`);
      assert.ok(meta);
      assert.strictEqual(meta.spaceId, spaceId);
      assert.strictEqual(meta.title, "System Architecture");
      assert.strictEqual(meta.parentId, null);
      assert.deepEqual(meta.path, []);
      assert.strictEqual(meta.deleted, false);

      // 4. Content subcollection document exists with expected content
      const contentDoc = mockDatabase.get(`documents/${docId}/content/main`);
      assert.ok(contentDoc);
      assert.deepEqual(contentDoc.content, {
        type: "doc",
        content: [{ type: "paragraph", text: "Architecture details" }],
      });
    });

    it("a failed batch produces neither metadata nor content and returns no document ID", async () => {
      commitShouldFail = true;

      await assert.rejects(
        async () => {
          await createDocument(spaceId, null, {
            title: "Failed Doc",
            content: { type: "doc" },
          });
        },
        /Firestore batch commit simulated failure/
      );

      // Batch commit was attempted once
      assert.strictEqual(commitCount, 1);

      // Neither metadata nor content document was persisted
      assert.strictEqual(mockDatabase.get("documents/gen-doc-1"), undefined);
      assert.strictEqual(mockDatabase.get("documents/gen-doc-1/content/main"), undefined);
    });

    it("creates document with default title and empty content when options are omitted", async () => {
      const docId = await createDocument(spaceId, null);

      assert.strictEqual(commitCount, 1);
      const meta = mockDatabase.get(`documents/${docId}`);
      assert.ok(meta);
      assert.strictEqual(meta.title, "Untitled");
      assert.strictEqual(meta.parentId, null);
      assert.deepEqual(meta.path, []);

      const contentDoc = mockDatabase.get(`documents/${docId}/content/main`);
      assert.ok(contentDoc);
      assert.strictEqual(contentDoc.content, null);
    });
  });

  describe("Valid Hierarchy & Canonical Depth Model", () => {
    it("root document succeeds with path = [] (depth 1)", async () => {
      const docId = await createDocument(spaceId, null, { title: "Root Page" });
      const meta = mockDatabase.get(`documents/${docId}`);
      assert.ok(meta);
      assert.strictEqual(meta.parentId, null);
      assert.deepEqual(meta.path, []);
    });

    it("valid child document under root succeeds with path = [parentId] (depth 2)", async () => {
      // Create root doc
      const rootId = await createDocument(spaceId, null, { title: "Level 1 Root" });

      // Create child under root
      const childId = await createDocument(spaceId, rootId, { title: "Level 2 Child" });
      const childMeta = mockDatabase.get(`documents/${childId}`);
      assert.ok(childMeta);
      assert.strictEqual(childMeta.parentId, rootId);
      assert.deepEqual(childMeta.path, [rootId]);
    });

    it("depths 1 through 4 succeed in sequence", async () => {
      // Level 1: Root (path.length = 0)
      const docLvl1 = await createDocument(spaceId, null, { title: "Level 1" });
      const meta1 = mockDatabase.get(`documents/${docLvl1}`);
      assert.deepEqual(meta1?.path, []);

      // Level 2: Child (path.length = 1)
      const docLvl2 = await createDocument(spaceId, docLvl1, { title: "Level 2" });
      const meta2 = mockDatabase.get(`documents/${docLvl2}`);
      assert.deepEqual(meta2?.path, [docLvl1]);

      // Level 3: Grandchild (path.length = 2)
      const docLvl3 = await createDocument(spaceId, docLvl2, { title: "Level 3" });
      const meta3 = mockDatabase.get(`documents/${docLvl3}`);
      assert.deepEqual(meta3?.path, [docLvl1, docLvl2]);

      // Level 4: Great-grandchild (path.length = 3)
      const docLvl4 = await createDocument(spaceId, docLvl3, { title: "Level 4" });
      const meta4 = mockDatabase.get(`documents/${docLvl4}`);
      assert.deepEqual(meta4?.path, [docLvl1, docLvl2, docLvl3]);

      // All 4 documents committed
      assert.strictEqual(commitCount, 4);
    });

    it("a fifth-level document is rejected (path.length > 3)", async () => {
      // Seed a depth 4 document directly in mockDatabase
      const depth4DocId = "doc-depth-4";
      mockDatabase.set(`documents/${depth4DocId}`, {
        id: depth4DocId,
        spaceId,
        title: "Depth 4 Document",
        parentId: "doc-depth-3",
        path: ["doc-1", "doc-2", "doc-3"], // length 3 -> depth 4
        deleted: false,
      });

      await assert.rejects(
        async () => {
          await createDocument(spaceId, depth4DocId, { title: "Fifth Level Attempt" });
        },
        /Document creation exceeds maximum hierarchy depth of 4 levels/
      );

      // No batch was committed for the rejected operation
      assert.strictEqual(commitCount, 0);
    });
  });

  describe("Invalid Hierarchy Rejections", () => {
    it("missing parent is rejected", async () => {
      await assert.rejects(
        async () => {
          await createDocument(spaceId, "nonexistent-parent-id");
        },
        /Parent document not found/
      );
      assert.strictEqual(commitCount, 0);
    });

    it("soft-deleted parent is rejected (deleted: true)", async () => {
      const deletedParentId = "deleted-parent-1";
      mockDatabase.set(`documents/${deletedParentId}`, {
        id: deletedParentId,
        spaceId,
        title: "Deleted Parent",
        parentId: null,
        path: [],
        deleted: true,
      });

      await assert.rejects(
        async () => {
          await createDocument(spaceId, deletedParentId);
        },
        /Parent document is deleted/
      );
      assert.strictEqual(commitCount, 0);
    });

    it("soft-deleted parent is rejected (deletedAt timestamp)", async () => {
      const deletedParentId = "deleted-parent-2";
      mockDatabase.set(`documents/${deletedParentId}`, {
        id: deletedParentId,
        spaceId,
        title: "Deleted Parent with timestamp",
        parentId: null,
        path: [],
        deleted: false,
        deletedAt: new Date(),
      });

      await assert.rejects(
        async () => {
          await createDocument(spaceId, deletedParentId);
        },
        /Parent document is deleted/
      );
      assert.strictEqual(commitCount, 0);
    });

    it("parent from another Space is rejected", async () => {
      const foreignSpaceId = "space-other-999";
      const foreignParentId = "doc-foreign-parent";
      mockDatabase.set(`documents/${foreignParentId}`, {
        id: foreignParentId,
        spaceId: foreignSpaceId,
        title: "Foreign Parent",
        parentId: null,
        path: [],
        deleted: false,
      });

      await assert.rejects(
        async () => {
          await createDocument(spaceId, foreignParentId);
        },
        /Parent document belongs to a different space/
      );
      assert.strictEqual(commitCount, 0);
    });

    it("self-parenting is rejected", async () => {
      customGeneratedId = "same-doc-id";

      await assert.rejects(
        async () => {
          await createDocument(spaceId, "same-doc-id");
        },
        /Cannot set document as its own parent/
      );
      assert.strictEqual(commitCount, 0);
    });

    it("missing Space is rejected", async () => {
      await assert.rejects(
        async () => {
          await createDocument("space-does-not-exist", null);
        },
        /Space not found/
      );
      assert.strictEqual(commitCount, 0);
    });

    it("soft-deleted Space is rejected", async () => {
      const deletedSpaceId = "space-soft-deleted";
      mockDatabase.set(`spaces/${deletedSpaceId}`, {
        id: deletedSpaceId,
        name: "Deleted Space",
        ownerId: "user-alice",
        userIds: ["user-alice"],
        deletedAt: new Date(),
        deletedBy: "user-alice",
      });

      await assert.rejects(
        async () => {
          await createDocument(deletedSpaceId, null);
        },
        /Cannot create document in a deleted space/
      );
      assert.strictEqual(commitCount, 0);
    });

    it("unauthenticated caller is rejected", async () => {
      currentAuth.currentUser = null;

      await assert.rejects(
        async () => {
          await createDocument(spaceId, null);
        },
        /Unauthorized: authentication required/
      );
      assert.strictEqual(commitCount, 0);
    });

    it("unauthorized non-contributor caller is rejected", async () => {
      currentAuth.currentUser = { uid: "user-intruder" };

      await assert.rejects(
        async () => {
          await createDocument(spaceId, null);
        },
        /Unauthorized: caller is not a contributor to this space/
      );
      assert.strictEqual(commitCount, 0);
    });
  });
});
