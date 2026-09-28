import type { SidebarNode } from "./types.ts";

export interface ActiveBacklink {
  id: string;
  title: string;
}

/**
 * Resolves active, visible backlink source documents within the same Space.
 * Only returns documents that exist in the active sidebar tree (excluding soft-deleted,
 * permanently deleted, cross-space, or inaccessible documents).
 */
export function getVisibleBacklinks(
  docIds: string[] | undefined | null,
  tree: SidebarNode[] | undefined | null
): ActiveBacklink[] {
  if (!docIds || !Array.isArray(docIds) || docIds.length === 0 || !tree || !Array.isArray(tree) || tree.length === 0) {
    return [];
  }

  const titleMap = new Map<string, string>();
  const traverse = (nodes: SidebarNode[]) => {
    for (const node of nodes) {
      if (node && typeof node.id === "string") {
        titleMap.set(node.id, (node.title && node.title.trim()) || "Untitled");
        if (node.children && Array.isArray(node.children) && node.children.length > 0) {
          traverse(node.children);
        }
      }
    }
  };
  traverse(tree);

  const seen = new Set<string>();
  const visible: ActiveBacklink[] = [];

  for (const id of docIds) {
    if (typeof id === "string" && !seen.has(id)) {
      seen.add(id);
      const title = titleMap.get(id);
      if (title !== undefined) {
        visible.push({ id, title });
      }
    }
  }

  return visible;
}
