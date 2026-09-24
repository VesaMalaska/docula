"use client";

import { useState, useRef, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { getSidebarTree, deleteDocument, getDocumentDescendantSummary } from "@/lib/actions/document";
import { SidebarNode } from "@/lib/types";
import { ChevronRight, ChevronDown, FileText, Loader2, Home, Check, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/use-toast";
import {
  SPACE_ROOT_ID,
  findNodeInTree,
  getVisibleTreeItems,
  findNextVisibleId,
  findPreviousVisibleId,
  findParentVisibleId,
  findFirstChildVisibleId,
  resolveVisibleActiveId,
  isDescendantOf,
  getNodeDepth,
  getSubtreeHeight,
} from "@/lib/utils/hierarchy";

interface DeleteDocumentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  spaceId: string;
  node: SidebarNode;
  returnFocusRef?: React.MutableRefObject<HTMLElement | null>;
  actionReturnFocusRef?: React.MutableRefObject<HTMLElement | null>;
  onSuccess?: () => void;
}

function countDescendants(node: SidebarNode): number {
  if (!node.children || node.children.length === 0) return 0;
  return node.children.reduce((acc, child) => acc + 1 + countDescendants(child), 0);
}

function validateSubdocumentDestination(
  tree: SidebarNode[],
  deletedNode: SidebarNode,
  destinationParentId: string | null
): { valid: boolean; reason?: string } {
  if (destinationParentId === deletedNode.id) {
    return { valid: false, reason: "Current document" };
  }

  if (destinationParentId !== null && isDescendantOf(tree, destinationParentId, deletedNode.id)) {
    return { valid: false, reason: "Descendant" };
  }

  let destinationDepth = 0;
  if (destinationParentId !== null) {
    const destNode = findNodeInTree(tree, destinationParentId);
    if (!destNode) {
      return { valid: false, reason: "Unavailable" };
    }
    destinationDepth = getNodeDepth(tree, destinationParentId);
  }

  // Children subtree height without the deleted parent
  const childrenSubtreeHeight = deletedNode.children.length > 0
    ? Math.max(...deletedNode.children.map(getSubtreeHeight))
    : 1;

  if (destinationDepth + childrenSubtreeHeight > 4) {
    return { valid: false, reason: "Max depth exceeded" };
  }

  return { valid: true };
}

export function DeleteDocumentDialog({
  isOpen,
  onClose,
  spaceId,
  node,
  returnFocusRef,
  actionReturnFocusRef,
  onSuccess,
}: DeleteDocumentDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const hasSubdocuments = node.children.length > 0;

  const defaultDestination = node.parentId;
  const [strategy, setStrategy] = useState<"move-descendants" | "delete-subtree">("move-descendants");
  const [selectedDestinationParentId, setSelectedDestinationParentId] = useState<string | null>(defaultDestination);
  const [activeIdOverride, setActiveIdOverride] = useState<string | null>(null);
  const [manuallyToggled, setManuallyToggled] = useState<Map<string, boolean>>(new Map());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isDeletedRef = useRef(false);
  const isPointerInteractionRef = useRef(false);
  const treeContainerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());

  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  const [prevNodeId, setPrevNodeId] = useState(node.id);

  if (prevIsOpen !== isOpen || prevNodeId !== node.id) {
    setPrevIsOpen(isOpen);
    setPrevNodeId(node.id);
    if (isOpen) {
      setStrategy("move-descendants");
      setSelectedDestinationParentId(node.parentId);
      setActiveIdOverride(null);
      setManuallyToggled(new Map());
      setErrorMessage(null);
    }
  }

  // Load tree for destination picker if has subdocuments
  const { data: tree, isLoading: isLoadingTree } = useQuery({
    queryKey: ["sidebar-tree", spaceId],
    queryFn: () => getSidebarTree(spaceId),
    enabled: isOpen && hasSubdocuments,
  });

  // Server-authoritative descendant count query
  const { data: descendantSummary, isLoading: isLoadingSummary } = useQuery({
    queryKey: ["doc-descendants-summary", spaceId, node.id],
    queryFn: () => getDocumentDescendantSummary(spaceId, node.id),
    enabled: isOpen && hasSubdocuments,
  });

  const totalAffectedCount = descendantSummary
    ? descendantSummary.totalAffectedCount
    : 1 + countDescendants(node);

  // Auto-expand ancestry of selected target node in picker
  const expandedNodes = useMemo(() => {
    const expanded = new Set<string>();
    const targetDocId = selectedDestinationParentId;

    if (isOpen && tree && targetDocId) {
      const findPath = (nodes: SidebarNode[], idToFind: string, currentPath: string[]): boolean => {
        for (const n of nodes) {
          const path = [...currentPath, n.id];
          if (n.id === idToFind) {
            path.forEach((pId) => expanded.add(pId));
            return true;
          }
          if (n.children && findPath(n.children, idToFind, path)) {
            return true;
          }
        }
        return false;
      };
      findPath(tree, targetDocId, []);
    }

    for (const [id, isExp] of manuallyToggled) {
      if (isExp) expanded.add(id);
      else expanded.delete(id);
    }
    return expanded;
  }, [isOpen, tree, selectedDestinationParentId, manuallyToggled]);

  const defaultActiveId = useMemo(() => {
    if (!tree) return SPACE_ROOT_ID;
    if (selectedDestinationParentId === null) return SPACE_ROOT_ID;
    if (selectedDestinationParentId && findNodeInTree(tree, selectedDestinationParentId)) {
      return selectedDestinationParentId;
    }
    return SPACE_ROOT_ID;
  }, [tree, selectedDestinationParentId]);

  const visibleItems = useMemo(
    () => getVisibleTreeItems(tree || [], expandedNodes),
    [tree, expandedNodes]
  );

  const activeId = useMemo(
    () => resolveVisibleActiveId(visibleItems, activeIdOverride, defaultActiveId),
    [visibleItems, activeIdOverride, defaultActiveId]
  );

  const destinationValidity = useMemo(() => {
    if (!tree) return { valid: true };
    return validateSubdocumentDestination(tree, node, selectedDestinationParentId);
  }, [tree, node, selectedDestinationParentId]);

  const toggleNode = (id: string) => {
    setManuallyToggled((prev) => {
      const next = new Map(prev);
      next.set(id, !expandedNodes.has(id));
      return next;
    });
  };

  const focusItem = (id: string) => {
    setActiveIdOverride(id);
    const el = itemRefs.current.get(id);
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
  };

  const handleTreeKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const nextId = findNextVisibleId(visibleItems, activeId);
        if (nextId) focusItem(nextId);
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        const prevId = findPreviousVisibleId(visibleItems, activeId);
        if (prevId) focusItem(prevId);
        break;
      }
      case "Home": {
        e.preventDefault();
        if (visibleItems.length > 0) focusItem(visibleItems[0].id);
        break;
      }
      case "End": {
        e.preventDefault();
        if (visibleItems.length > 0) focusItem(visibleItems[visibleItems.length - 1].id);
        break;
      }
      case "ArrowRight": {
        e.preventDefault();
        const currentItem = visibleItems.find((i) => i.id === activeId);
        if (!currentItem) break;
        if (currentItem.id === SPACE_ROOT_ID) {
          const firstChildId = findFirstChildVisibleId(visibleItems, activeId);
          if (firstChildId) focusItem(firstChildId);
          break;
        }
        if (currentItem.hasChildren) {
          if (!currentItem.isExpanded) toggleNode(currentItem.id);
          else {
            const firstChild = findFirstChildVisibleId(visibleItems, activeId);
            if (firstChild) focusItem(firstChild);
          }
        }
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        const currentItem = visibleItems.find((i) => i.id === activeId);
        if (!currentItem) break;
        if (currentItem.id === SPACE_ROOT_ID) break;
        if (currentItem.hasChildren && currentItem.isExpanded) {
          toggleNode(currentItem.id);
        } else {
          const parentId = findParentVisibleId(visibleItems, activeId);
          if (parentId) focusItem(parentId);
        }
        break;
      }
      case "Enter":
      case " ": {
        e.preventDefault();
        e.stopPropagation();
        const currentItem = visibleItems.find((i) => i.id === activeId);
        if (currentItem && tree) {
          const validity = validateSubdocumentDestination(tree, node, currentItem.destinationParentId);
          if (validity.valid) {
            setSelectedDestinationParentId(currentItem.destinationParentId);
          }
        }
        break;
      }
    }
  };

  const { mutate: executeDelete, isPending: isDeleting } = useMutation({
    mutationFn: async () => {
      setErrorMessage(null);
      if (!hasSubdocuments) {
        return deleteDocument(node.id, {
          strategy: "move-descendants",
          destinationParentId: node.parentId,
        });
      }

      return deleteDocument(node.id, {
        strategy,
        destinationParentId: strategy === "move-descendants" ? selectedDestinationParentId : null,
      });
    },
    onSuccess: (result) => {
      isDeletedRef.current = true;
      queryClient.invalidateQueries({ queryKey: ["sidebar-tree", spaceId] });
      queryClient.invalidateQueries({ queryKey: ["deleted-documents", spaceId] });

      const count = result && typeof result === "object" && "affectedCount" in result
        ? (result as { affectedCount: number }).affectedCount
        : 1;

      toast({
        title: count > 1 ? `${count} documents moved to Trash` : "Document moved to Trash",
      });

      onSuccess?.();
      onClose();
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "";
      if (
        message.includes("safe atomic limit") ||
        message.includes("maximum hierarchy depth") ||
        message.includes("locked by another") ||
        message.includes("Destination document is")
      ) {
        setErrorMessage(message);
      } else {
        setErrorMessage("Failed to delete document. Please try again.");
      }
    },
  });

  const handleCloseAutoFocus = (event: Event) => {
    const wasDeleted = isDeletedRef.current;
    isDeletedRef.current = false;
    const target = wasDeleted
      ? actionReturnFocusRef?.current || returnFocusRef?.current
      : returnFocusRef?.current;

    const isPointer = isPointerInteractionRef.current;
    isPointerInteractionRef.current = false;

    if (target && target.isConnected) {
      event.preventDefault();
      if (isPointer) {
        target.focus({ focusVisible: false } as FocusOptions);
      } else {
        target.focus();
      }
    }
  };

  const spaceRootValidity = tree
    ? validateSubdocumentDestination(tree, node, null)
    : { valid: true };

  const renderTreeNodes = (nodes: SidebarNode[], level: number) => {
    return nodes.map((n) => {
      const validity = tree
        ? validateSubdocumentDestination(tree, node, n.id)
        : { valid: true };
      const isDisabled = !validity.valid;
      const isSelected = selectedDestinationParentId === n.id;
      const isOpenNode = expandedNodes.has(n.id);
      const hasChildren = n.children.length > 0;

      return (
        <div
          key={n.id}
          ref={(el) => {
            if (el) itemRefs.current.set(n.id, el);
            else itemRefs.current.delete(n.id);
          }}
          role="treeitem"
          id={n.id}
          aria-expanded={hasChildren ? isOpenNode : undefined}
          aria-selected={isSelected}
          aria-disabled={isDisabled ? true : undefined}
          tabIndex={activeId === n.id ? 0 : -1}
          className="min-w-0 outline-none focus:outline-none"
        >
          <div
            className={cn(
              "flex items-center gap-1 rounded py-1.5 px-2 text-sm transition-colors min-w-0 w-full",
              isDisabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:bg-accent",
              isSelected ? "bg-accent font-medium" : ""
            )}
            style={{ paddingLeft: `${level * 16 + 8}px` }}
            onClick={(e) => {
              e.stopPropagation();
              setActiveIdOverride(n.id);
              if (!isDisabled) {
                setSelectedDestinationParentId(n.id);
              }
            }}
          >
            <span
              role="presentation"
              aria-hidden="true"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleNode(n.id);
              }}
              className={cn(
                "h-4 w-4 shrink-0 flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer",
                !hasChildren && "invisible"
              )}
            >
              {isOpenNode ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </span>
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate min-w-0" title={n.title}>
              {n.title}
            </span>
            {n.id === node.parentId && (
              <span className="text-xs text-muted-foreground ml-1.5 shrink min-w-0" title="(Current Parent)">
                (Parent)
              </span>
            )}
            {isDisabled && validity.reason && (
              <span className="text-xs text-muted-foreground ml-1.5 shrink min-w-0 truncate">
                ({validity.reason})
              </span>
            )}
            {isSelected && <Check className="h-3.5 w-3.5 text-primary ml-auto shrink-0" />}
          </div>
          {isOpenNode && hasChildren && (
            <div role="group" className="min-w-0 w-full">
              {renderTreeNodes(n.children, level + 1)}
            </div>
          )}
        </div>
      );
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && !isDeleting && onClose()}>
      <DialogContent
        className="p-4 sm:p-6 sm:max-w-[520px] min-w-0"
        onCloseAutoFocus={handleCloseAutoFocus}
        onPointerDown={() => {
          isPointerInteractionRef.current = true;
        }}
        onKeyDown={() => {
          isPointerInteractionRef.current = false;
        }}
      >
        <DialogHeader className="min-w-0">
          <DialogTitle className="truncate">
            Delete “{node.title}”?
          </DialogTitle>
          <DialogDescription className="min-w-0 [overflow-wrap:anywhere] break-words">
            {!hasSubdocuments
              ? "Are you sure you want to delete this document? It will be moved to Trash and can be restored later."
              : "This document contains subdocuments. Choose how you want to handle them before deleting."}
          </DialogDescription>
        </DialogHeader>

        {errorMessage && (
          <div className="flex items-center gap-2 p-3 text-sm rounded-md bg-destructive/10 text-destructive border border-destructive/20">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1">{errorMessage}</span>
          </div>
        )}

        {hasSubdocuments && (
          <div className="space-y-4 py-2 min-w-0" role="radiogroup" aria-label="Descendant deletion choices">
            {/* Choice A: Keep and move */}
            <div
              className={cn(
                "rounded-lg border p-3 cursor-pointer transition-colors space-y-2",
                strategy === "move-descendants"
                  ? "border-primary bg-accent/40"
                  : "border-border hover:bg-muted/40"
              )}
              onClick={() => setStrategy("move-descendants")}
            >
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="radio"
                  name="deletion-strategy"
                  value="move-descendants"
                  checked={strategy === "move-descendants"}
                  onChange={() => setStrategy("move-descendants")}
                  className="mt-1 h-4 w-4 text-primary cursor-pointer"
                  disabled={isDeleting}
                />
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="font-medium text-sm">Keep and move them</div>
                  <div className="text-xs text-muted-foreground leading-normal">
                    Direct subdocuments will move together to the selected destination, and their own descendants will follow.
                  </div>
                </div>
              </label>

              {strategy === "move-descendants" && (
                <div className="pt-2 pl-7 space-y-2 min-w-0">
                  <div className="text-xs font-medium text-muted-foreground">Select destination:</div>
                  {isLoadingTree ? (
                    <div className="flex justify-center p-3">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <div
                      ref={treeContainerRef}
                      role="tree"
                      aria-label="Subdocument destinations"
                      tabIndex={0}
                      className="border rounded-md max-h-[180px] overflow-y-auto overflow-x-hidden p-1 focus:outline-none min-w-0 w-full text-xs"
                      onKeyDown={handleTreeKeyDown}
                    >
                      {/* Space root item */}
                      <div
                        ref={(el) => {
                          if (el) itemRefs.current.set(SPACE_ROOT_ID, el);
                          else itemRefs.current.delete(SPACE_ROOT_ID);
                        }}
                        role="treeitem"
                        id={SPACE_ROOT_ID}
                        aria-selected={selectedDestinationParentId === null}
                        aria-disabled={!spaceRootValidity.valid ? true : undefined}
                        tabIndex={activeId === SPACE_ROOT_ID ? 0 : -1}
                        className={cn(
                          "flex items-center gap-2 rounded py-1 px-2 text-sm transition-colors min-w-0 w-full",
                          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                          !spaceRootValidity.valid ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:bg-accent",
                          selectedDestinationParentId === null ? "bg-accent font-medium" : ""
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveIdOverride(SPACE_ROOT_ID);
                          if (spaceRootValidity.valid) {
                            setSelectedDestinationParentId(null);
                          }
                        }}
                      >
                        <Home className="h-4 w-4 text-muted-foreground ml-1 shrink-0" />
                        <span className="truncate min-w-0">Space root</span>
                        {node.parentId === null && (
                          <span className="text-xs text-muted-foreground ml-1 shrink min-w-0 truncate" title="(Parent)">
                            (Parent)
                          </span>
                        )}
                        {selectedDestinationParentId === null && (
                          <Check className="h-3.5 w-3.5 text-primary ml-auto shrink-0" />
                        )}
                      </div>
                      <div role="separator" className="my-1 border-t" />
                      {renderTreeNodes(tree || [], 0)}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Choice B: Delete subtree */}
            <div
              className={cn(
                "rounded-lg border p-3 cursor-pointer transition-colors",
                strategy === "delete-subtree"
                  ? "border-primary bg-accent/40"
                  : "border-border hover:bg-muted/40"
              )}
              onClick={() => setStrategy("delete-subtree")}
            >
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="radio"
                  name="deletion-strategy"
                  value="delete-subtree"
                  checked={strategy === "delete-subtree"}
                  onChange={() => setStrategy("delete-subtree")}
                  className="mt-1 h-4 w-4 text-primary cursor-pointer"
                  disabled={isDeleting}
                />
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="font-medium text-sm flex items-center gap-2">
                    <span>Delete the entire subtree</span>
                    {isLoadingSummary ? (
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                    ) : (
                      <span className="text-xs font-normal text-muted-foreground bg-muted px-1.5 py-0.5 rounded border">
                        {totalAffectedCount} documents
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground leading-normal">
                    All {totalAffectedCount} affected documents will be moved to Trash and remain recoverable as a group.
                  </div>
                </div>
              </label>
            </div>
          </div>
        )}

        <DialogFooter className="min-w-0 gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={isDeleting}>
            Cancel
          </Button>
          {!hasSubdocuments ? (
            <Button
              variant="destructive"
              onClick={() => executeDelete()}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </Button>
          ) : strategy === "move-descendants" ? (
            <Button
              variant="destructive"
              onClick={() => executeDelete()}
              disabled={isDeleting || !destinationValidity.valid}
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Moving and deleting...
                </>
              ) : (
                "Move subdocuments and delete"
              )}
            </Button>
          ) : (
            <Button
              variant="destructive"
              onClick={() => executeDelete()}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Moving to Trash...
                </>
              ) : (
                `Move ${totalAffectedCount} documents to Trash`
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
