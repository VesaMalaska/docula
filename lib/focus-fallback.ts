import type { SidebarNode } from "./types.ts";

export type FocusTargetResult =
  | { type: "item"; id: string }
  | { type: "parent"; id: string }
  | { type: "container" };

export interface NodeContext {
  node: SidebarNode;
  parent: SidebarNode | null;
  siblings: SidebarNode[];
  index: number;
}

/**
 * Finds a node and its structural context (parent, siblings, index) within a tree.
 */
export function findNodeContext(
  nodes: SidebarNode[],
  targetId: string,
  parent: SidebarNode | null = null
): NodeContext | null {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.id === targetId) {
      return { node, parent, siblings: nodes, index: i };
    }
    if (node.children && node.children.length > 0) {
      const found = findNodeContext(node.children, targetId, node);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Finds the parent node of a given target ID in the tree.
 */
export function findParentNode(
  nodes: SidebarNode[],
  targetId: string,
  parent: SidebarNode | null = null
): SidebarNode | null {
  const context = findNodeContext(nodes, targetId, parent);
  return context?.parent ?? null;
}

/**
 * Finds the ancestry path of node IDs from the root down to and including the target node ID.
 * Returns an empty array if targetId is null/undefined or not found in the tree.
 */
export function findAncestryPath(
  nodes: SidebarNode[],
  targetId: string | null | undefined
): string[] {
  if (!targetId) return [];

  function search(currentNodes: SidebarNode[], path: string[]): string[] | null {
    for (const node of currentNodes) {
      const nextPath = [...path, node.id];
      if (node.id === targetId) {
        return nextPath;
      }
      if (node.children && node.children.length > 0) {
        const found = search(node.children, nextPath);
        if (found) return found;
      }
    }
    return null;
  }

  return search(nodes, []) || [];
}

/**
 * Checks whether the node with targetId in the tree is located under expectedParentId.
 * Returns false if the node is not found or its parentId does not match expectedParentId.
 */
export function isNodeAtDestination(
  tree: SidebarNode[],
  targetId: string,
  expectedParentId: string | null
): boolean {
  const context = findNodeContext(tree, targetId);
  if (!context) return false;
  const currentParentId = context.node.parentId ?? null;
  return currentParentId === expectedParentId;
}

/**
 * Checks whether any node in the given path is not present in the expanded set.
 */
export function isPathCollapsed(
  path: string[],
  expandedNodes: Set<string>
): boolean {
  return path.some((id) => !expandedNodes.has(id));
}

/**
 * Calculates the next focus target when a document node is deleted, following
 * the required preference order:
 * 1. Next structural sibling in the tree
 * 2. Previous structural sibling in the tree
 * 3. Surviving parent document
 * 4. Section / container fallback (containing Space control or section container)
 */
export function calculateDocumentDeleteFallback(
  tree: SidebarNode[],
  targetNodeId: string
): FocusTargetResult {
  const context = findNodeContext(tree, targetNodeId);
  if (!context) {
    return { type: "container" };
  }

  const { parent, siblings, index } = context;

  // Preference 1: Next structural sibling
  if (index + 1 < siblings.length) {
    return { type: "item", id: siblings[index + 1].id };
  }

  // Preference 2: Previous structural sibling
  if (index - 1 >= 0) {
    return { type: "item", id: siblings[index - 1].id };
  }

  // Preference 3: Surviving parent document
  if (parent) {
    return { type: "parent", id: parent.id };
  }

  // Preference 4 & 5: Section / container fallback
  return { type: "container" };
}

/**
 * Calculates the next focus target for a flat list (e.g. spaces or trashbin items)
 * following the preference order:
 * 1. Next surviving item
 * 2. Previous surviving item
 * 3. Container fallback
 */
export function calculateListFallback<T extends { id: string }>(
  items: T[],
  deletedId: string
): { type: "item"; id: string } | { type: "container" } {
  const index = items.findIndex((item) => item.id === deletedId);
  if (index === -1) {
    return { type: "container" };
  }

  // Preference 1: Next item
  if (index + 1 < items.length) {
    return { type: "item", id: items[index + 1].id };
  }

  // Preference 2: Previous item
  if (index - 1 >= 0) {
    return { type: "item", id: items[index - 1].id };
  }

  // Preference 3: Container fallback
  return { type: "container" };
}
