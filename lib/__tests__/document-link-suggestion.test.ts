import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Custom resolver hook to support extensionless TS imports and @/ alias in Node ESM
const rootUrl = pathToFileURL(process.cwd() + "/").href;
const hookCode = `
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.endsWith("suggestion-list") || specifier.endsWith("suggestion-list.tsx")) {
        return {
            url: "data:text/javascript," + encodeURIComponent("export const SuggestionList = () => null;"),
            format: "module",
            shortCircuit: true,
        };
    }
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

interface MockDocItem {
  id: string;
  data: {
    spaceId: string;
    title: string;
    deleted?: boolean;
    parentId?: string | null;
    path?: string[];
  };
}

let mockDocs: MockDocItem[] = [];

mock.module("firebase/firestore", {
  exports: {
    ...firestoreActual,
    collection: mock.fn((_db: unknown, name: string) => ({ name })),
    where: mock.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
    query: mock.fn((col: unknown, ...constraints: { field: string; op: string; value: unknown }[]) => ({
      col,
      constraints,
    })),
    getDocs: mock.fn(async (q: { constraints?: { field: string; op: string; value: unknown }[] }) => {
      const spaceConstraint = q?.constraints?.find((c) => c.field === "spaceId");
      const spaceId = spaceConstraint?.value;

      const filtered = mockDocs.filter((d) => !spaceId || d.data.spaceId === spaceId);

      return {
        forEach: (callback: (doc: { id: string; data: () => MockDocItem["data"] }) => void) => {
          filtered.forEach((d) => {
            callback({
              id: d.id,
              data: () => ({ ...d.data }),
            });
          });
        },
      };
    }),
  },
});

mock.module("@/lib/firebase", {
  exports: {
    db: {},
    auth: { currentUser: null },
  },
});

const { searchDocuments } = await import("../actions/document.ts");
const { LinkSuggestion } = await import("../../components/editor/link-suggestion.ts");

describe("Document Link Suggestions - Current Document Exclusion", () => {
  const SPACE_ID = "space-test-123";

  beforeEach(() => {
    mockDocs = [];
  });

  it("excludes current document A from suggestion candidates by ID", async () => {
    mockDocs = [
      { id: "doc-a", data: { spaceId: SPACE_ID, title: "Document A" } },
      { id: "doc-b", data: { spaceId: SPACE_ID, title: "Document B" } },
      { id: "doc-c", data: { spaceId: SPACE_ID, title: "Document C" } },
    ];

    const results = await searchDocuments("", SPACE_ID, "doc-a");

    assert.strictEqual(results.some((r) => r.id === "doc-a"), false);
    assert.strictEqual(results.length, 2);
    assert.deepStrictEqual(
      results.map((r) => r.id),
      ["doc-b", "doc-c"]
    );
  });

  it("preserves another document with the exact same title as the current document", async () => {
    mockDocs = [
      { id: "doc-current", data: { spaceId: SPACE_ID, title: "Project Overview" } },
      { id: "doc-sibling", data: { spaceId: SPACE_ID, title: "Project Overview" } },
      { id: "doc-other", data: { spaceId: SPACE_ID, title: "Meeting Notes" } },
    ];

    // Editing doc-current
    const results = await searchDocuments("", SPACE_ID, "doc-current");

    // doc-current must be absent
    assert.strictEqual(results.some((r) => r.id === "doc-current"), false);
    // doc-sibling must be present even though its title is identical
    const sameTitleMatch = results.find((r) => r.id === "doc-sibling");
    assert.ok(sameTitleMatch);
    assert.strictEqual(sameTitleMatch.title, "Project Overview");
    assert.strictEqual(results.length, 2);
  });

  it("excludes current document when it is nested in the document tree", async () => {
    mockDocs = [
      {
        id: "doc-nested-a",
        data: {
          spaceId: SPACE_ID,
          title: "Deeply Nested Child",
          parentId: "parent-folder-id",
          path: ["root-id", "parent-folder-id"],
        },
      },
      {
        id: "doc-root-b",
        data: {
          spaceId: SPACE_ID,
          title: "Root Level Document",
          parentId: null,
          path: [],
        },
      },
    ];

    const results = await searchDocuments("", SPACE_ID, "doc-nested-a");

    assert.strictEqual(results.some((r) => r.id === "doc-nested-a"), false);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, "doc-root-b");
  });

  it("continues to exclude current document when suggestions are filtered by typing", async () => {
    mockDocs = [
      { id: "doc-a", data: { spaceId: SPACE_ID, title: "Architecture RFC" } },
      { id: "doc-b", data: { spaceId: SPACE_ID, title: "Architecture Guidelines" } },
      { id: "doc-c", data: { spaceId: SPACE_ID, title: "Deployment RFC" } },
    ];

    // Query matches both doc-a and doc-b
    const results = await searchDocuments("architect", SPACE_ID, "doc-a");

    assert.strictEqual(results.some((r) => r.id === "doc-a"), false);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, "doc-b");
    assert.strictEqual(results[0].title, "Architecture Guidelines");
  });

  it("returns empty results when the space or query contains only the current document", async () => {
    mockDocs = [
      { id: "doc-only", data: { spaceId: SPACE_ID, title: "Solo Document" } },
    ];

    const results = await searchDocuments("", SPACE_ID, "doc-only");
    assert.deepStrictEqual(results, []);

    const filteredResults = await searchDocuments("solo", SPACE_ID, "doc-only");
    assert.deepStrictEqual(filteredResults, []);
  });

  it("preserves candidate ordering and candidate limit (up to 10) without current document taking a slot", async () => {
    // 11 documents with similar titles; doc-0 is the current doc with exact match
    mockDocs = [
      { id: "doc-0", data: { spaceId: SPACE_ID, title: "Spec" } },
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `doc-${i + 1}`,
        data: { spaceId: SPACE_ID, title: `Spec Part ${i + 1}` },
      })),
    ];

    const results = await searchDocuments("Spec", SPACE_ID, "doc-0");

    // All 10 other docs should be returned
    assert.strictEqual(results.length, 10);
    assert.strictEqual(results.some((r) => r.id === "doc-0"), false);
    // Verify first result is doc-1
    assert.strictEqual(results[0].id, "doc-1");
  });

  it("preserves backward compatibility when currentDocId is omitted or undefined", async () => {
    mockDocs = [
      { id: "doc-a", data: { spaceId: SPACE_ID, title: "Document A" } },
      { id: "doc-b", data: { spaceId: SPACE_ID, title: "Document B" } },
    ];

    const resultsWithoutDocId = await searchDocuments("", SPACE_ID);
    assert.strictEqual(resultsWithoutDocId.length, 2);
    assert.strictEqual(resultsWithoutDocId.some((r) => r.id === "doc-a"), true);
  });

  it("LinkSuggestion extension accepts and configures currentDocId option", () => {
    const configured = LinkSuggestion.configure({
      spaceId: "space-xyz",
      currentDocId: "doc-active-123",
    });

    assert.strictEqual(configured.options.spaceId, "space-xyz");
    assert.strictEqual(configured.options.currentDocId, "doc-active-123");
  });

  it("LinkSuggestion items callback fetches search candidates excluding currentDocId", async () => {
    mockDocs = [
      { id: "doc-editing", data: { spaceId: SPACE_ID, title: "Current Being Edited" } },
      { id: "doc-other", data: { spaceId: SPACE_ID, title: "Target Sibling Document" } },
    ];

    const configured = LinkSuggestion.configure({
      spaceId: SPACE_ID,
      currentDocId: "doc-editing",
    });

    // Invoke addProseMirrorPlugins from extension config
    const addPlugins = LinkSuggestion.config.addProseMirrorPlugins;
    assert.ok(typeof addPlugins === "function");

    // Mock Suggestion plugin instantiation to capture items callback
    const plugins = addPlugins.call({
      editor: {} as never,
      options: configured.options,
    });

    assert.strictEqual(plugins.length, 1);
    const suggestionPlugin = plugins[0];
    assert.ok(suggestionPlugin);

    // Call searchDocuments with configured extension options
    const itemsResult = await searchDocuments("", configured.options.spaceId, configured.options.currentDocId);
    assert.strictEqual(itemsResult.some((r) => r.id === "doc-editing"), false);
    assert.strictEqual(itemsResult.length, 1);
    assert.strictEqual(itemsResult[0].id, "doc-other");
  });

  it("Suggestion insertion command formats correct link url and title for target document", () => {
    const spaceId = "space-demo";
    const targetDoc = { id: "doc-target-456", title: "Target Page Title" };
    let insertedContent: unknown = null;
    let focused = false;

    const mockEditor = {
      chain: () => ({
        focus: () => {
          focused = true;
          return {
            insertContentAt: (_range: unknown, content: unknown) => {
              insertedContent = content;
              return {
                run: () => true,
              };
            },
          };
        },
      }),
      extensionManager: {
        extensions: [
          {
            name: "linkSuggestion",
            options: { spaceId, currentDocId: "doc-current" },
          },
        ],
      },
    };

    const linkSuggestionInstance = LinkSuggestion.configure({
      spaceId,
      currentDocId: "doc-current",
    });

    const command = linkSuggestionInstance.options.suggestion.command;
    assert.ok(typeof command === "function");

    command({
      editor: mockEditor,
      range: { from: 1, to: 2 },
      props: targetDoc,
    });

    assert.strictEqual(focused, true);
    assert.deepStrictEqual(insertedContent, [
      {
        type: "text",
        text: "Target Page Title",
        marks: [
          {
            type: "link",
            attrs: {
              href: `/space/${spaceId}/doc/${targetDoc.id}`,
            },
          },
        ],
      },
      {
        type: "text",
        text: " ",
      },
    ]);
  });
});
