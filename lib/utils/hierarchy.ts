import type { SidebarNode } from "../types.ts";

export const SPACE_ROOT_ID = "__docula_space_root__";
export const MAX_DOCUMENT_DEPTH = 4;
export const MAX_LIFECYCLE_DOCUMENT_LIMIT = 250;
export const MAX_LIFECYCLE_IMAGE_LIMIT = 500;

export function calculateNewPath(parentPath: string[] | undefined, parentId: string | null): string[] {
  if (!parentId) return [];
  return [...(parentPath || []), parentId];
}

export function calculateDescendantPath(oldPath: string[], targetId: string, targetNewPath: string[]): string[] {
  const index = oldPath.indexOf(targetId);
  if (index === -1) return oldPath;
  return [...targetNewPath, targetId, ...oldPath.slice(index + 1)];
}

/**
 * Finds a node by ID anywhere within a SidebarNode tree.
 */
export function findNodeInTree(nodes: SidebarNode[], targetId: string): SidebarNode | null {
  for (const node of nodes) {
    if (node.id === targetId) return node;
    if (node.children && node.children.length > 0) {
      const found = findNodeInTree(node.children, targetId);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Calculates document depth in the tree.
 * Space root depth: 0
 * Root document depth: 1
 * Child document depth: 2
 * Grandchild document depth: 3
 * Great-grandchild document depth: 4
 * Returns -1 if targetId is not found.
 */
export function getNodeDepth(tree: SidebarNode[], targetId: string | null): number {
  if (targetId === null) return 0;

  function findDepth(nodes: SidebarNode[], currentDepth: number): number {
    for (const node of nodes) {
      if (node.id === targetId) {
        return currentDepth;
      }
      if (node.children && node.children.length > 0) {
        const found = findDepth(node.children, currentDepth + 1);
        if (found !== -1) return found;
      }
    }
    return -1;
  }

  return findDepth(tree, 1);
}

/**
 * Calculates the subtree height for a node including itself.
 * Leaf document height: 1
 * Node with 1 descendant level: 2
 * Node with 2 descendant levels: 3
 */
export function getSubtreeHeight(node: SidebarNode): number {
  if (!node.children || node.children.length === 0) {
    return 1;
  }
  return 1 + Math.max(...node.children.map(getSubtreeHeight));
}

/**
 * Checks if a potential descendant is in the subtree of an ancestor node.
 */
export function isDescendantOf(tree: SidebarNode[], potentialDescendantId: string, ancestorId: string): boolean {
  const ancestorNode = findNodeInTree(tree, ancestorId);
  if (!ancestorNode) return false;
  return findNodeInTree(ancestorNode.children, potentialDescendantId) !== null;
}

/**
 * Calculates moved subtree height from a list of descendant path arrays.
 * Used in Firestore action-layer validation.
 */
export function calculateSubtreeHeightFromPaths(targetId: string, descendantPaths: string[][]): number {
  let maxHeight = 1;
  for (const path of descendantPaths) {
    const idx = path.indexOf(targetId);
    if (idx !== -1) {
      const relativeLevel = path.length - idx + 1;
      if (relativeLevel > maxHeight) {
        maxHeight = relativeLevel;
      }
    }
  }
  return maxHeight;
}

export type MoveInvalidReason =
  | "self"
  | "descendant"
  | "current_parent"
  | "max_depth"
  | "not_found";

export interface MoveDestinationValidationResult {
  valid: boolean;
  reason?: MoveInvalidReason;
  description?: string;
}

/**
 * Checks whether the resulting deepest depth (destination depth + subtree height)
 * complies with the canonical maximum hierarchy depth limit.
 */
export function isDepthAllowed(destinationDepth: number, subtreeHeight: number): boolean {
  return destinationDepth + subtreeHeight <= MAX_DOCUMENT_DEPTH;
}

/**
 * Calculates the subtree height of a deleted document or deletion group in Trash.
 * For a single document, returns 1.
 * For a deletion group root, computes max relative path length + 1 across all group members.
 */
export function calculateDeletedDocumentSubtreeHeight(
  docId: string,
  deletedDocuments: Array<{ id: string; deletionGroupId?: string | null; path?: string[] }>
): number {
  const rootDoc = deletedDocuments.find((d) => d.id === docId);
  if (!rootDoc) return 1;

  if (rootDoc.deletionGroupId) {
    const groupMembers = deletedDocuments.filter(
      (d) => d.deletionGroupId === rootDoc.deletionGroupId
    );
    const groupPaths = groupMembers.map((d) => (Array.isArray(d.path) ? d.path : []));
    return calculateSubtreeHeightFromPaths(docId, groupPaths);
  }

  return 1;
}

/**
 * Validates whether a restored document or subtree with known subtreeHeight
 * can be restored beneath the specified destination parent.
 * Space root has destinationDepth = 0.
 */
export function validateRestorationDestination(
  tree: SidebarNode[],
  destinationParentId: string | null,
  subtreeHeight: number
): MoveDestinationValidationResult {
  let destinationDepth = 0;
  if (destinationParentId !== null) {
    const destinationNode = findNodeInTree(tree, destinationParentId);
    if (!destinationNode) {
      return {
        valid: false,
        reason: "not_found",
        description: "Destination document was not found",
      };
    }

    destinationDepth = getNodeDepth(tree, destinationParentId);
  }

  if (!isDepthAllowed(destinationDepth, subtreeHeight)) {
    return {
      valid: false,
      reason: "max_depth",
      description: "Restoring here would exceed the maximum depth of 4 levels",
    };
  }

  return { valid: true };
}

export interface MoveDestinationOptions {
  subtreeHeight?: number;
  isRestoration?: boolean;
}

/**
 * Validates whether a document can be moved to the specified destination parent.
 * Enforces:
 * - Not moving under itself
 * - Not moving under current parent (no-op)
 * - Destination exists in tree (unless Space root)
 * - Not moving under a descendant
 * - 4-level maximum hierarchy depth: destination parent depth + moved subtree height <= 4
 */
export function validateMoveDestination(
  tree: SidebarNode[],
  movedDocId: string,
  destinationParentId: string | null,
  currentParentId: string | null,
  options?: MoveDestinationOptions
): MoveDestinationValidationResult {
  if (options?.isRestoration) {
    if (destinationParentId === movedDocId) {
      return {
        valid: false,
        reason: "self",
        description: "Cannot move a document under itself",
      };
    }
    const height = options.subtreeHeight ?? 1;
    return validateRestorationDestination(tree, destinationParentId, height);
  }

  if (destinationParentId === movedDocId) {
    return {
      valid: false,
      reason: "self",
      description: "Cannot move a document under itself",
    };
  }

  if (destinationParentId === currentParentId) {
    return {
      valid: false,
      reason: "current_parent",
      description: "Document is already at this location",
    };
  }

  const movedNode = findNodeInTree(tree, movedDocId);
  if (!movedNode) {
    return {
      valid: false,
      reason: "not_found",
      description: "Document being moved was not found in the tree",
    };
  }

  let destinationDepth = 0;
  if (destinationParentId !== null) {
    const destinationNode = findNodeInTree(tree, destinationParentId);
    if (!destinationNode) {
      return {
        valid: false,
        reason: "not_found",
        description: "Destination document was not found",
      };
    }

    if (isDescendantOf(tree, destinationParentId, movedDocId)) {
      return {
        valid: false,
        reason: "descendant",
        description: "Cannot move a document under its own descendant",
      };
    }

    destinationDepth = getNodeDepth(tree, destinationParentId);
  }

  const subtreeHeight = options?.subtreeHeight ?? getSubtreeHeight(movedNode);

  if (!isDepthAllowed(destinationDepth, subtreeHeight)) {
    return {
      valid: false,
      reason: "max_depth",
      description: "Moving this document would exceed the maximum depth of 4 levels",
    };
  }

  return { valid: true };
}

export interface VisibleTreeItem {
  id: string; // SPACE_ROOT_ID or document ID
  destinationParentId: string | null; // null for Space root, or document ID
  parentId: string | null; // SPACE_ROOT_ID for root docs, null for Space root, parent doc ID for children
  title: string;
  level: number; // 0 for Space root, 1 for root docs, 2 for children, etc.
  hasChildren: boolean;
  isExpanded: boolean;
  node: SidebarNode | null; // null for Space root
}

/**
 * Flattens the visible tree including Space root into an ordered sequence based on expanded nodes.
 */
export function getVisibleTreeItems(
  tree: SidebarNode[],
  expandedNodes: Set<string>,
  spaceRootId: string = SPACE_ROOT_ID
): VisibleTreeItem[] {
  const items: VisibleTreeItem[] = [];

  items.push({
    id: spaceRootId,
    destinationParentId: null,
    parentId: null,
    title: "Space root",
    level: 0,
    hasChildren: tree.length > 0,
    isExpanded: true,
    node: null,
  });

  function traverse(nodes: SidebarNode[], level: number, parentTreeItemId: string) {
    for (const node of nodes) {
      const hasChildren = node.children.length > 0;
      const isExpanded = expandedNodes.has(node.id);

      items.push({
        id: node.id,
        destinationParentId: node.id,
        parentId: parentTreeItemId,
        title: node.title,
        level,
        hasChildren,
        isExpanded,
        node,
      });

      if (hasChildren && isExpanded) {
        traverse(node.children, level + 1, node.id);
      }
    }
  }

  traverse(tree, 1, spaceRootId);
  return items;
}

export function findNextVisibleId(visibleItems: VisibleTreeItem[], currentId: string): string | null {
  const index = visibleItems.findIndex((item) => item.id === currentId);
  if (index === -1) return visibleItems[0]?.id ?? null;
  if (index + 1 < visibleItems.length) {
    return visibleItems[index + 1].id;
  }
  return null;
}

export function findPreviousVisibleId(visibleItems: VisibleTreeItem[], currentId: string): string | null {
  const index = visibleItems.findIndex((item) => item.id === currentId);
  if (index === -1) return visibleItems[0]?.id ?? null;
  if (index - 1 >= 0) {
    return visibleItems[index - 1].id;
  }
  return null;
}

export function findParentVisibleId(visibleItems: VisibleTreeItem[], currentId: string): string | null {
  const item = visibleItems.find((i) => i.id === currentId);
  if (!item || !item.parentId) return null;
  return item.parentId;
}

export function findFirstChildVisibleId(visibleItems: VisibleTreeItem[], currentId: string): string | null {
  const item = visibleItems.find((i) => i.id === currentId);
  if (!item || !item.hasChildren || !item.isExpanded) return null;
  const index = visibleItems.findIndex((i) => i.id === currentId);
  if (index !== -1 && index + 1 < visibleItems.length) {
    const nextItem = visibleItems[index + 1];
    if (nextItem.parentId === currentId) {
      return nextItem.id;
    }
  }
  return null;
}

/**
 * Resolves the effective active tree item ID ensuring it always refers to an item in visibleItems.
 * Fallback priority:
 * 1. preferredId if present in visibleItems
 * 2. collapsingAncestorId if known and present in visibleItems
 * 3. defaultId if present in visibleItems
 * 4. Space root if present in visibleItems
 * 5. First visible tree item
 */
export function resolveVisibleActiveId(
  visibleItems: VisibleTreeItem[],
  preferredId?: string | null,
  defaultId?: string | null,
  collapsingAncestorId?: string | null
): string {
  if (visibleItems.length === 0) {
    return "";
  }

  // 1. Preferred ID if visible
  if (preferredId && visibleItems.some((item) => item.id === preferredId)) {
    return preferredId;
  }

  // 2. Collapsing ancestor if known and visible
  if (collapsingAncestorId && visibleItems.some((item) => item.id === collapsingAncestorId)) {
    return collapsingAncestorId;
  }

  // 3. Visible valid default target
  if (defaultId && visibleItems.some((item) => item.id === defaultId)) {
    return defaultId;
  }

  // 4. Space root fallback
  const spaceRoot = visibleItems.find((item) => item.id === SPACE_ROOT_ID);
  if (spaceRoot) {
    return spaceRoot.id;
  }

  // 5. First visible tree item
  return visibleItems[0].id;
}
