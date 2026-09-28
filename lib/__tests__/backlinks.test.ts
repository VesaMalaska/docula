import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { getVisibleBacklinks } from "../backlinks.ts";
import type { SidebarNode } from "../types.ts";

describe("Backlinks resolution & display filter", () => {
  const createNode = (id: string, title: string, children: SidebarNode[] = []): SidebarNode => ({
    id,
    title,
    parentId: null,
    children,
  });

  describe("getVisibleBacklinks", () => {
    it("returns empty array when docIds is null, undefined, or empty", () => {
      const tree = [createNode("doc-1", "Doc 1")];
      assert.deepEqual(getVisibleBacklinks(null, tree), []);
      assert.deepEqual(getVisibleBacklinks(undefined, tree), []);
      assert.deepEqual(getVisibleBacklinks([], tree), []);
    });

    it("returns empty array when tree is null, undefined, or empty", () => {
      const docIds = ["doc-1"];
      assert.deepEqual(getVisibleBacklinks(docIds, null), []);
      assert.deepEqual(getVisibleBacklinks(docIds, undefined), []);
      assert.deepEqual(getVisibleBacklinks(docIds, []), []);
    });

    it("resolves active backlinks present in tree with correct titles and working IDs", () => {
      const tree: SidebarNode[] = [
        createNode("doc-a", "Document A"),
        createNode("doc-b", "Document B"),
      ];
      const docIds = ["doc-a"];
      const result = getVisibleBacklinks(docIds, tree);

      assert.deepEqual(result, [
        { id: "doc-a", title: "Document A" },
      ]);
    });

    it("resolves active backlinks nested inside tree children and grandchildren", () => {
      const tree: SidebarNode[] = [
        createNode("folder-1", "Folder", [
          createNode("doc-child", "Child Document", [
            createNode("doc-grandchild", "Grandchild Document"),
          ]),
        ]),
      ];
      const docIds = ["doc-grandchild", "doc-child"];
      const result = getVisibleBacklinks(docIds, tree);

      assert.deepEqual(result, [
        { id: "doc-grandchild", title: "Grandchild Document" },
        { id: "doc-child", title: "Child Document" },
      ]);
    });

    it("soft-deleted source (missing from active tree) produces no backlink and never 'Unknown Doc'", () => {
      // Tree only contains active docs (Document B). Document A is soft-deleted.
      const tree: SidebarNode[] = [
        createNode("doc-b", "Document B"),
      ];
      // Document B has backlink from Document A
      const docIds = ["doc-a"];
      const result = getVisibleBacklinks(docIds, tree);

      // Must be empty, never [{ id: "doc-a", title: "Unknown Doc" }]
      assert.deepEqual(result, []);
    });

    it("returns empty array (triggering 'None' state) when all source documents are inactive/deleted", () => {
      const tree: SidebarNode[] = [
        createNode("doc-target", "Target Document"),
      ];
      // Multiple soft-deleted or missing sources
      const docIds = ["deleted-1", "deleted-2", "deleted-3"];
      const result = getVisibleBacklinks(docIds, tree);

      assert.deepEqual(result, []);
      assert.equal(result.length === 0, true);
    });

    it("restoring a source makes its backlink visible again with its title without modifying stored backlinks", () => {
      const storedBacklinks = ["doc-source"];

      // State 1: Source is soft-deleted (not in tree)
      const treeDeleted: SidebarNode[] = [
        createNode("doc-target", "Target Document"),
      ];
      const resultDeleted = getVisibleBacklinks(storedBacklinks, treeDeleted);
      assert.deepEqual(resultDeleted, []);

      // State 2: Source is restored (re-added to tree)
      const treeRestored: SidebarNode[] = [
        createNode("doc-target", "Target Document"),
        createNode("doc-source", "Restored Source Document"),
      ];
      const resultRestored = getVisibleBacklinks(storedBacklinks, treeRestored);
      assert.deepEqual(resultRestored, [
        { id: "doc-source", title: "Restored Source Document" },
      ]);

      // Original stored backlinks array was never modified or cleared
      assert.deepEqual(storedBacklinks, ["doc-source"]);
    });

    it("permanently deleted or non-existent source IDs never appear as 'Unknown Doc'", () => {
      const tree: SidebarNode[] = [
        createNode("doc-active", "Active Doc"),
      ];
      const docIds = ["permanently-deleted-id", "non-existent-guid"];
      const result = getVisibleBacklinks(docIds, tree);

      assert.deepEqual(result, []);
      assert.ok(!result.some((b) => b.title.includes("Unknown")));
    });

    it("multiple backlinks behave independently: deleting one source does not hide the others", () => {
      const storedBacklinks = ["source-1", "source-2", "source-3"];

      // Initial state: all three active
      const treeAll: SidebarNode[] = [
        createNode("source-1", "Source One"),
        createNode("source-2", "Source Two"),
        createNode("source-3", "Source Three"),
      ];
      assert.deepEqual(getVisibleBacklinks(storedBacklinks, treeAll), [
        { id: "source-1", title: "Source One" },
        { id: "source-2", title: "Source Two" },
        { id: "source-3", title: "Source Three" },
      ]);

      // Delete source-2: source-1 and source-3 remain visible
      const treeAfterDelete2: SidebarNode[] = [
        createNode("source-1", "Source One"),
        createNode("source-3", "Source Three"),
      ];
      assert.deepEqual(getVisibleBacklinks(storedBacklinks, treeAfterDelete2), [
        { id: "source-1", title: "Source One" },
        { id: "source-3", title: "Source Three" },
      ]);

      // Delete source-1: only source-3 remains visible
      const treeAfterDelete1: SidebarNode[] = [
        createNode("source-3", "Source Three"),
      ];
      assert.deepEqual(getVisibleBacklinks(storedBacklinks, treeAfterDelete1), [
        { id: "source-3", title: "Source Three" },
      ]);

      // Restore source-2: source-2 and source-3 visible
      const treeAfterRestore2: SidebarNode[] = [
        createNode("source-2", "Source Two"),
        createNode("source-3", "Source Three"),
      ];
      assert.deepEqual(getVisibleBacklinks(storedBacklinks, treeAfterRestore2), [
        { id: "source-2", title: "Source Two" },
        { id: "source-3", title: "Source Three" },
      ]);
    });

    it("does not expose a source title or link from another space or inaccessible source", () => {
      // Sidebar tree for Space A contains only Space A's visible docs
      const spaceATree: SidebarNode[] = [
        createNode("doc-space-a", "Document in Space A"),
      ];
      // docIds has a cross-space backlink to doc-space-b
      const docIds = ["doc-space-b", "doc-space-a"];
      const result = getVisibleBacklinks(docIds, spaceATree);

      // doc-space-b is completely excluded
      assert.deepEqual(result, [
        { id: "doc-space-a", title: "Document in Space A" },
      ]);
    });

    it("deduplicates repeated docIds preserving first-seen order", () => {
      const tree: SidebarNode[] = [
        createNode("doc-1", "Document One"),
        createNode("doc-2", "Document Two"),
      ];
      const docIds = ["doc-1", "doc-2", "doc-1", "doc-2"];
      const result = getVisibleBacklinks(docIds, tree);

      assert.deepEqual(result, [
        { id: "doc-1", title: "Document One" },
        { id: "doc-2", title: "Document Two" },
      ]);
    });

    it("falls back to 'Untitled' for documents with empty or whitespace-only titles", () => {
      const tree: SidebarNode[] = [
        createNode("doc-blank", ""),
        createNode("doc-whitespace", "   "),
      ];
      const docIds = ["doc-blank", "doc-whitespace"];
      const result = getVisibleBacklinks(docIds, tree);

      assert.deepEqual(result, [
        { id: "doc-blank", title: "Untitled" },
        { id: "doc-whitespace", title: "Untitled" },
      ]);
    });
  });

  describe("Query invalidation and normal navigation lifecycle", () => {
    it("updates visible backlinks upon soft deletion and restoration via query invalidation without page reload", async () => {
      const spaceId = "space-test-123";
      const targetDocId = "doc-target";
      const sourceDocId = "doc-source";

      // Mock database state
      let activeDocumentsInSpace: { id: string; title: string }[] = [
        { id: sourceDocId, title: "Source Page" },
        { id: targetDocId, title: "Target Page" },
      ];

      // Simulate backend getSidebarTree(spaceId)
      const fetchSidebarTree = async (sId: string): Promise<SidebarNode[]> => {
        if (sId !== spaceId) return [];
        return activeDocumentsInSpace.map((d) => ({
          id: d.id,
          title: d.title,
          parentId: null,
          children: [],
        }));
      };

      const queryClient = new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 0,
            retry: false,
          },
        },
      });

      // Initial load: Doc Target viewed, backlinks list queries sidebar-tree
      const initialTree = await queryClient.fetchQuery({
        queryKey: ["sidebar-tree", spaceId],
        queryFn: () => fetchSidebarTree(spaceId),
      });

      const storedBacklinks = [sourceDocId];
      let visible = getVisibleBacklinks(storedBacklinks, initialTree);
      assert.deepEqual(visible, [{ id: sourceDocId, title: "Source Page" }]);

      // --- Action 1: Soft-delete source document ---
      // In Firestore, source document's deleted = true, so fetchSidebarTree omits it
      activeDocumentsInSpace = activeDocumentsInSpace.filter((d) => d.id !== sourceDocId);

      // In UI (delete-document-dialog.tsx onSuccess):
      await queryClient.invalidateQueries({ queryKey: ["sidebar-tree", spaceId] });

      // Normal navigation / re-query: component fetches updated query without full page reload
      const updatedTreeAfterDelete = await queryClient.fetchQuery({
        queryKey: ["sidebar-tree", spaceId],
        queryFn: () => fetchSidebarTree(spaceId),
      });

      // Render backlink list: soft-deleted doc is gone, displays "None" state (empty array)
      visible = getVisibleBacklinks(storedBacklinks, updatedTreeAfterDelete);
      assert.deepEqual(visible, []);
      assert.equal(visible.length === 0, true); // Displays " None"

      // Stored backlinks on target document was NOT touched (remains recoverable)
      assert.deepEqual(storedBacklinks, [sourceDocId]);

      // --- Action 2: Restore source document from Trash ---
      // In Firestore, source document's deleted = false
      activeDocumentsInSpace.push({ id: sourceDocId, title: "Source Page" });

      // In UI (trash/page.tsx onSuccess):
      await queryClient.invalidateQueries({ queryKey: ["sidebar-tree", spaceId] });

      // User navigates back to target document without page reload:
      const updatedTreeAfterRestore = await queryClient.fetchQuery({
        queryKey: ["sidebar-tree", spaceId],
        queryFn: () => fetchSidebarTree(spaceId),
      });

      // Render backlink list: restored doc is immediately visible again with title and URL
      visible = getVisibleBacklinks(storedBacklinks, updatedTreeAfterRestore);
      assert.deepEqual(visible, [{ id: sourceDocId, title: "Source Page" }]);

      // --- Action 3: Stale ID from permanent deletion ---
      // Suppose another document "permanently-deleted" was permanently deleted,
      // leaving its ID in storedBacklinks:
      const backlinksWithStaleId = [sourceDocId, "perm-deleted-doc"];
      visible = getVisibleBacklinks(backlinksWithStaleId, updatedTreeAfterRestore);

      // Only active source is returned; permanently deleted ID produces no "Unknown Doc"
      assert.deepEqual(visible, [{ id: sourceDocId, title: "Source Page" }]);
    });
  });
});
