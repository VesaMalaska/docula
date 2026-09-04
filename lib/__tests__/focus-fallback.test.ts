import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  calculateDocumentDeleteFallback,
  calculateListFallback,
  findAncestryPath,
  findNodeContext,
  findParentNode,
  isNodeAtDestination,
  isPathCollapsed,
} from "../focus-fallback.ts";
import type { SidebarNode } from "../types.ts";

describe("Focus Fallback Selection Policy", () => {
  const sampleTree: SidebarNode[] = [
    {
      id: "doc-1",
      title: "Overview",
      parentId: null,
      children: [
        {
          id: "doc-1-1",
          title: "Architecture",
          parentId: "doc-1",
          children: [],
        },
        {
          id: "doc-1-2",
          title: "API Reference",
          parentId: "doc-1",
          children: [
            {
              id: "doc-1-2-1",
              title: "Endpoints",
              parentId: "doc-1-2",
              children: [],
            },
          ],
        },
      ],
    },
    {
      id: "doc-2",
      title: "Guides",
      parentId: null,
      children: [
        {
          id: "doc-2-1",
          title: "Getting Started",
          parentId: "doc-2",
          children: [],
        },
      ],
    },
    {
      id: "doc-3",
      title: "Overview", // duplicate name to verify ID-based resolution
      parentId: null,
      children: [],
    },
  ];

  describe("calculateDocumentDeleteFallback", () => {
    test("Preference 1: chooses next structural sibling when available", () => {
      const fallback = calculateDocumentDeleteFallback(sampleTree, "doc-1");
      // doc-1 children are in its subtree, so next surviving item is doc-2
      assert.deepEqual(fallback, { type: "item", id: "doc-2" });
    });

    test("Preference 1: chooses next structural child sibling", () => {
      const fallback = calculateDocumentDeleteFallback(sampleTree, "doc-1-1");
      assert.deepEqual(fallback, { type: "item", id: "doc-1-2" });
    });

    test("Preference 2: chooses previous structural sibling when no next sibling exists", () => {
      const fallback = calculateDocumentDeleteFallback(sampleTree, "doc-3");
      assert.deepEqual(fallback, { type: "item", id: "doc-2" });
    });

    test("Preference 2: chooses previous structural sibling for last child", () => {
      const fallback = calculateDocumentDeleteFallback(
        sampleTree,
        "doc-1-2"
      );
      // previous sibling of doc-1-2 is doc-1-1
      assert.deepEqual(fallback, { type: "item", id: "doc-1-1" });
    });

    test("Preference 3: chooses surviving parent when only child in multi-branch tree is deleted", () => {
      // doc-2 has only one child: doc-2-1. doc-3 is the next root node.
      // Deleting doc-2-1 must return parent doc-2, NOT unrelated root node doc-3.
      const fallback = calculateDocumentDeleteFallback(
        sampleTree,
        "doc-2-1"
      );
      assert.deepEqual(fallback, { type: "parent", id: "doc-2" });
    });

    test("Preference 3: chooses surviving parent when only child is deleted and no siblings exist", () => {
      const onlyChildTree: SidebarNode[] = [
        {
          id: "parent-1",
          title: "Parent",
          parentId: null,
          children: [
            {
              id: "child-1",
              title: "Only Child",
              parentId: "parent-1",
              children: [],
            },
          ],
        },
      ];
      const fallback = calculateDocumentDeleteFallback(
        onlyChildTree,
        "child-1"
      );
      assert.deepEqual(fallback, { type: "parent", id: "parent-1" });
    });

    test("Preference 4/5: returns container fallback when the only document in tree is deleted", () => {
      const singleDocTree: SidebarNode[] = [
        {
          id: "lonely-doc",
          title: "Lonely Document",
          parentId: null,
          children: [],
        },
      ];
      const fallback = calculateDocumentDeleteFallback(
        singleDocTree,
        "lonely-doc"
      );
      assert.deepEqual(fallback, { type: "container" });
    });

    test("excludes all descendants of the deleted node from candidate targets", () => {
      const treeWithDeepNesting: SidebarNode[] = [
        {
          id: "branch-root",
          title: "Branch Root",
          parentId: null,
          children: [
            {
              id: "sub-branch",
              title: "Sub Branch",
              parentId: "branch-root",
              children: [
                {
                  id: "leaf-1",
                  title: "Leaf 1",
                  parentId: "sub-branch",
                  children: [],
                },
                {
                  id: "leaf-2",
                  title: "Leaf 2",
                  parentId: "sub-branch",
                  children: [],
                },
              ],
            },
          ],
        },
        {
          id: "sibling-branch",
          title: "Sibling Branch",
          parentId: null,
          children: [],
        },
      ];
      const fallback = calculateDocumentDeleteFallback(
        treeWithDeepNesting,
        "branch-root"
      );
      assert.deepEqual(fallback, { type: "item", id: "sibling-branch" });
    });

    test("handles duplicate document names without cross-row confusion", () => {
      // Both doc-1 and doc-3 are named "Overview"
      const fallback = calculateDocumentDeleteFallback(
        sampleTree,
        "doc-3"
      );
      // Must return doc-2, not doc-1
      assert.deepEqual(fallback, { type: "item", id: "doc-2" });
    });
  });

  describe("calculateListFallback", () => {
    const list = [
      { id: "item-1" },
      { id: "item-2" },
      { id: "item-3" },
    ];

    test("returns next item when deleting first item", () => {
      assert.deepEqual(calculateListFallback(list, "item-1"), {
        type: "item",
        id: "item-2",
      });
    });

    test("returns next item when deleting middle item", () => {
      assert.deepEqual(calculateListFallback(list, "item-2"), {
        type: "item",
        id: "item-3",
      });
    });

    test("returns previous item when deleting last item", () => {
      assert.deepEqual(calculateListFallback(list, "item-3"), {
        type: "item",
        id: "item-2",
      });
    });

    test("returns container fallback when deleting final remaining item", () => {
      const singleList = [{ id: "solo-item" }];
      assert.deepEqual(calculateListFallback(singleList, "solo-item"), {
        type: "container",
      });
    });

    test("returns container fallback if item not found", () => {
      assert.deepEqual(calculateListFallback(list, "non-existent"), {
        type: "container",
      });
    });
  });

  describe("findParentNode and findNodeContext", () => {
    test("finds parent for nested child", () => {
      const parent = findParentNode(sampleTree, "doc-1-2-1");
      assert.equal(parent?.id, "doc-1-2");
    });

    test("finds parent for first-level child", () => {
      const parent = findParentNode(sampleTree, "doc-2-1");
      assert.equal(parent?.id, "doc-2");
    });

    test("returns null parent for root node", () => {
      const parent = findParentNode(sampleTree, "doc-1");
      assert.equal(parent, null);
    });

    test("returns null for nonexistent node", () => {
      const parent = findParentNode(sampleTree, "non-existent");
      assert.equal(parent, null);
    });

    test("findNodeContext returns node, parent, siblings, and index", () => {
      const ctx = findNodeContext(sampleTree, "doc-1-2");
      assert.ok(ctx);
      assert.equal(ctx.node.id, "doc-1-2");
      assert.equal(ctx.parent?.id, "doc-1");
      assert.equal(ctx.siblings.length, 2);
      assert.equal(ctx.index, 1);
    });
  });

  describe("findAncestryPath", () => {
    test("returns empty array for null destination (Space root)", () => {
      const path = findAncestryPath(sampleTree, null);
      assert.deepEqual(path, []);
    });

    test("returns empty array for undefined destination", () => {
      const path = findAncestryPath(sampleTree, undefined);
      assert.deepEqual(path, []);
    });

    test("returns single-element array for root-level destination", () => {
      const path = findAncestryPath(sampleTree, "doc-1");
      assert.deepEqual(path, ["doc-1"]);
    });

    test("returns full ancestry path down to nested destination parent", () => {
      const path = findAncestryPath(sampleTree, "doc-1-1");
      assert.deepEqual(path, ["doc-1", "doc-1-1"]);
    });

    test("returns full ancestry path down to deeply nested destination parent", () => {
      const path = findAncestryPath(sampleTree, "doc-1-2-1");
      assert.deepEqual(path, ["doc-1", "doc-1-2", "doc-1-2-1"]);
    });

    test("returns empty array for nonexistent destination node", () => {
      const path = findAncestryPath(sampleTree, "non-existent");
      assert.deepEqual(path, []);
    });
  });

  describe("isNodeAtDestination", () => {
    test("returns true when root node has expected null parent", () => {
      assert.equal(isNodeAtDestination(sampleTree, "doc-1", null), true);
    });

    test("returns false when root node is checked against non-null parent", () => {
      assert.equal(isNodeAtDestination(sampleTree, "doc-1", "doc-2"), false);
    });

    test("returns true when nested node has expected parentId", () => {
      assert.equal(isNodeAtDestination(sampleTree, "doc-1-1", "doc-1"), true);
    });

    test("returns false when nested node parentId does not match", () => {
      assert.equal(isNodeAtDestination(sampleTree, "doc-1-1", "doc-2"), false);
      assert.equal(isNodeAtDestination(sampleTree, "doc-1-1", null), false);
    });

    test("returns false when target node is not found in tree", () => {
      assert.equal(isNodeAtDestination(sampleTree, "non-existent", "doc-1"), false);
      assert.equal(isNodeAtDestination(sampleTree, "non-existent", null), false);
    });
  });

  describe("isPathCollapsed", () => {
    test("returns false for empty ancestry path (Space root)", () => {
      assert.equal(isPathCollapsed([], new Set()), false);
      assert.equal(isPathCollapsed([], new Set(["doc-1"])), false);
    });

    test("returns false when all nodes in path are expanded", () => {
      assert.equal(
        isPathCollapsed(["doc-1", "doc-1-2"], new Set(["doc-1", "doc-1-2"])),
        false
      );
    });

    test("returns true when any ancestor in path is collapsed", () => {
      assert.equal(
        isPathCollapsed(["doc-1", "doc-1-2"], new Set(["doc-1"])),
        true
      );
      assert.equal(
        isPathCollapsed(["doc-1", "doc-1-2"], new Set(["doc-1-2"])),
        true
      );
      assert.equal(
        isPathCollapsed(["doc-1", "doc-1-2"], new Set()),
        true
      );
    });
  });
});
