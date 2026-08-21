export function calculateNewPath(parentPath: string[] | undefined, parentId: string | null): string[] {
  if (!parentId) return [];
  return [...(parentPath || []), parentId];
}

export function calculateDescendantPath(oldPath: string[], targetId: string, targetNewPath: string[]): string[] {
  const index = oldPath.indexOf(targetId);
  if (index === -1) return oldPath;
  return [...targetNewPath, targetId, ...oldPath.slice(index + 1)];
}
