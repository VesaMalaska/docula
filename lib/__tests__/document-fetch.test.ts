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

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import * as firestoreActual from "firebase/firestore";
import { QueryClient } from "@tanstack/react-query";

mock.module("server-only", { exports: {} });

const getDocMock = mock.fn();
const docMock = mock.fn((_db: unknown, collectionName: string, id: string, ...rest: string[]) => {
  return { collectionName, id, rest };
});

mock.module("firebase/firestore", {
  exports: {
    ...firestoreActual,
    getDoc: getDocMock,
    doc: docMock,
  },
});

mock.module("@/lib/firebase", {
  exports: {
    db: {},
    auth: { currentUser: null },
  },
});

mock.module("@/lib/types", {
  exports: {
    Document: {},
    SidebarNode: {},
  },
});

const { getDocument, isFirestorePermissionDeniedError } = await import("../actions/document.ts");

describe("isFirestorePermissionDeniedError helper", () => {
  it("matches FirestoreError instance with permission-denied code", () => {
    const err = new firestoreActual.FirestoreError("permission-denied", "Missing or insufficient permissions.");
    assert.strictEqual(isFirestorePermissionDeniedError(err), true);
  });

  it("matches structured error object with permission-denied code", () => {
    assert.strictEqual(isFirestorePermissionDeniedError({ code: "permission-denied" }), true);
  });

  it("matches firestore/permission-denied prefixed code", () => {
    assert.strictEqual(isFirestorePermissionDeniedError({ code: "firestore/permission-denied" }), true);
  });

  it("does not match transient error code 'unavailable'", () => {
    assert.strictEqual(isFirestorePermissionDeniedError({ code: "unavailable" }), false);
  });

  it("does not match internal error code 'internal'", () => {
    assert.strictEqual(isFirestorePermissionDeniedError({ code: "internal" }), false);
  });

  it("does not match human error messages lacking structured code", () => {
    assert.strictEqual(isFirestorePermissionDeniedError(new Error("permission-denied")), false);
    assert.strictEqual(isFirestorePermissionDeniedError(new Error("Permission denied")), false);
  });

  it("returns false for null, undefined, primitives, and non-error objects", () => {
    assert.strictEqual(isFirestorePermissionDeniedError(null), false);
    assert.strictEqual(isFirestorePermissionDeniedError(undefined), false);
    assert.strictEqual(isFirestorePermissionDeniedError("permission-denied"), false);
    assert.strictEqual(isFirestorePermissionDeniedError(403), false);
    assert.strictEqual(isFirestorePermissionDeniedError({}), false);
  });
});

describe("getDocument error handling & existence resolution", () => {
  it("1. Exact permission-denied from getDoc() makes getDocument() resolve to null", async () => {
    getDocMock.mock.mockImplementation(async () => {
      const err = new firestoreActual.FirestoreError("permission-denied", "Missing or insufficient permissions.");
      throw err;
    });

    const result = await getDocument("doc-missing-or-forbidden");
    assert.strictEqual(result, null);
  });

  it("2. A valid document still resolves normally with populated data and content", async () => {
    getDocMock.mock.mockImplementation(async (ref: { collectionName?: string; id?: string; rest?: string[] }) => {
      if (ref.rest && ref.rest.length > 0) {
        // Content subcollection document: /documents/{id}/content/main
        return {
          exists: () => true,
          data: () => ({ content: { type: "doc", content: [{ type: "paragraph", text: "Hello Docula" }] } }),
        };
      }
      // Main document
      return {
        id: "doc-valid-123",
        exists: () => true,
        data: () => ({
          spaceId: "space-abc",
          title: "Architecture Guide",
          parentId: null,
          path: [],
          tags: ["docs"],
          createdAt: { toDate: () => new Date() },
          updatedAt: { toDate: () => new Date() },
          lock: null,
          outboundLinks: [],
          backlinks: [],
          deleted: false,
        }),
      };
    });

    const result = await getDocument("doc-valid-123");
    assert.ok(result);
    assert.strictEqual(result.id, "doc-valid-123");
    assert.strictEqual(result.title, "Architecture Guide");
    assert.strictEqual(result.spaceId, "space-abc");
    assert.deepEqual(result.content, {
      type: "doc",
      content: [{ type: "paragraph", text: "Hello Docula" }],
    });
  });

  it("3. A normal nonexistent snapshot with exists() === false resolves to null", async () => {
    getDocMock.mock.mockImplementation(async () => {
      return {
        id: "doc-nonexistent",
        exists: () => false,
        data: () => undefined,
      };
    });

    const result = await getDocument("doc-nonexistent");
    assert.strictEqual(result, null);
  });

  it("4. A transient Firestore error such as 'unavailable' still rejects", async () => {
    getDocMock.mock.mockImplementation(async () => {
      const err = new firestoreActual.FirestoreError("unavailable", "The service is temporarily unavailable.");
      throw err;
    });

    await assert.rejects(
      async () => {
        await getDocument("doc-transient");
      },
      (err: unknown) => {
        assert.ok(err && typeof err === "object" && "code" in err);
        assert.strictEqual((err as { code: string }).code, "unavailable");
        return true;
      }
    );
  });

  it("5. An unrelated error still rejects", async () => {
    getDocMock.mock.mockImplementation(async () => {
      throw new TypeError("Failed to serialize document snapshot");
    });

    await assert.rejects(
      async () => {
        await getDocument("doc-crash");
      },
      (err: unknown) => {
        assert.ok(err instanceof TypeError);
        assert.strictEqual(err.message, "Failed to serialize document snapshot");
        return true;
      }
    );
  });

  it("6. Permission denial does not expose whether the document exists", async () => {
    // Case A: Nonexistent document in a space (denied because document does not exist)
    getDocMock.mock.mockImplementation(async () => {
      throw new firestoreActual.FirestoreError("permission-denied", "Missing or insufficient permissions.");
    });
    const nonexistentResult = await getDocument("nonexistent-document-id");

    // Case B: Existing document in a private space (denied because caller lacks space access)
    getDocMock.mock.mockImplementation(async () => {
      throw new firestoreActual.FirestoreError("permission-denied", "Missing or insufficient permissions.");
    });
    const forbiddenResult = await getDocument("private-forbidden-document-id");

    // Both must yield identical null result without leaking existence or metadata
    assert.strictEqual(nonexistentResult, null);
    assert.strictEqual(forbiddenResult, null);
    assert.strictEqual(typeof nonexistentResult, typeof forbiddenResult);
  });

  it("7. The missing-document query completes after one fetch attempt without retry backoff", async () => {
    let fetchAttemptCount = 0;
    getDocMock.mock.mockImplementation(async () => {
      fetchAttemptCount++;
      throw new firestoreActual.FirestoreError("permission-denied", "Missing or insufficient permissions.");
    });

    // Use a fresh QueryClient with default retry configuration
    const queryClient = new QueryClient();

    const queryResult = await queryClient.fetchQuery({
      queryKey: ["doc", "missing-document-id"],
      queryFn: () => getDocument("missing-document-id"),
    });

    // Verification:
    // 1. Missing document query successfully resolves to null
    assert.strictEqual(queryResult, null);
    // 2. Exactly ONE fetch attempt was executed; no retry loop was triggered
    assert.strictEqual(fetchAttemptCount, 1);
  });

  it("7b. Contrast: Transient errors trigger query retry attempts", async () => {
    let transientAttemptCount = 0;
    getDocMock.mock.mockImplementation(async () => {
      transientAttemptCount++;
      throw new firestoreActual.FirestoreError("unavailable", "Backend service is unavailable.");
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: 2,
          retryDelay: () => 1, // deterministic 1ms delay for test speed
        },
      },
    });

    await assert.rejects(
      async () => {
        await queryClient.fetchQuery({
          queryKey: ["doc", "transient-network-failure"],
          queryFn: () => getDocument("transient-network-failure"),
        });
      },
      (err: unknown) => {
        assert.ok(err && typeof err === "object" && "code" in err);
        assert.strictEqual((err as { code: string }).code, "unavailable");
        return true;
      }
    );

    // Initial attempt + 2 retries = 3 total attempts
    assert.strictEqual(transientAttemptCount, 3);
  });

  it("8. Soft-deleted document with deleted === true resolves to null and avoids content subcollection read", async () => {
    let contentReadAttempted = false;
    getDocMock.mock.mockImplementation(async (ref: { collectionName?: string; id?: string; rest?: string[] }) => {
      if (ref.rest && ref.rest.length > 0) {
        contentReadAttempted = true;
        return {
          exists: () => true,
          data: () => ({ content: { type: "doc", content: [{ type: "paragraph", text: "Secret deleted content" }] } }),
        };
      }
      return {
        id: "doc-soft-deleted-1",
        exists: () => true,
        data: () => ({
          spaceId: "space-abc",
          title: "Deleted Architecture Guide",
          deleted: true,
          deletedAt: { toDate: () => new Date() },
          deletedBy: "user-1",
        }),
      };
    });

    const result = await getDocument("doc-soft-deleted-1");
    assert.strictEqual(result, null);
    assert.strictEqual(contentReadAttempted, false, "Must not fetch content subcollection for soft-deleted document");
  });

  it("9. Soft-deleted document with deletedAt timestamp resolves to null and avoids content subcollection read", async () => {
    let contentReadAttempted = false;
    getDocMock.mock.mockImplementation(async (ref: { collectionName?: string; id?: string; rest?: string[] }) => {
      if (ref.rest && ref.rest.length > 0) {
        contentReadAttempted = true;
        return {
          exists: () => true,
          data: () => ({ content: { type: "doc" } }),
        };
      }
      return {
        id: "doc-soft-deleted-2",
        exists: () => true,
        data: () => ({
          spaceId: "space-abc",
          title: "Deleted Doc with Timestamp",
          deleted: false,
          deletedAt: { toDate: () => new Date() },
        }),
      };
    });

    const result = await getDocument("doc-soft-deleted-2");
    assert.strictEqual(result, null);
    assert.strictEqual(contentReadAttempted, false, "Must not fetch content subcollection when deletedAt is set");
  });

  it("10. Soft-deleted document query completes in one fetch without retry loop", async () => {
    let fetchAttemptCount = 0;
    getDocMock.mock.mockImplementation(async () => {
      fetchAttemptCount++;
      return {
        id: "doc-soft-deleted-3",
        exists: () => true,
        data: () => ({
          spaceId: "space-abc",
          title: "Soft Deleted Doc",
          deleted: true,
          deletedAt: { toDate: () => new Date() },
        }),
      };
    });

    const queryClient = new QueryClient();
    const queryResult = await queryClient.fetchQuery({
      queryKey: ["doc", "doc-soft-deleted-3"],
      queryFn: () => getDocument("doc-soft-deleted-3"),
    });

    assert.strictEqual(queryResult, null);
    assert.strictEqual(fetchAttemptCount, 1);
  });

  it("11. Soft-deleted document with deleted === true and deletedAt null resolves to null and avoids content subcollection read", async () => {
    let contentReadAttempted = false;
    getDocMock.mock.mockImplementation(async (ref: { collectionName?: string; id?: string; rest?: string[] }) => {
      if (ref.rest && ref.rest.length > 0) {
        contentReadAttempted = true;
        return {
          exists: () => true,
          data: () => ({ content: { type: "doc" } }),
        };
      }
      return {
        id: "doc-soft-deleted-4",
        exists: () => true,
        data: () => ({
          spaceId: "space-abc",
          title: "Legacy Deleted Doc without Timestamp",
          deleted: true,
          deletedAt: null,
        }),
      };
    });

    const result = await getDocument("doc-soft-deleted-4");
    assert.strictEqual(result, null);
    assert.strictEqual(contentReadAttempted, false, "Must not fetch content subcollection for legacy soft-deleted document");
  });
});
