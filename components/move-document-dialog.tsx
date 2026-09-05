"use client";

import { useState, useRef, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { getSidebarTree, moveDocument } from "@/lib/actions/document";
import { SidebarNode } from "@/lib/types";
import { ChevronRight, ChevronDown, FileText, Loader2, Home, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/use-toast";
import {
  SPACE_ROOT_ID,
  validateMoveDestination,
  findNodeInTree,
  getVisibleTreeItems,
  findNextVisibleId,
  findPreviousVisibleId,
  findParentVisibleId,
  findFirstChildVisibleId,
  resolveVisibleActiveId,
  isDescendantOf,
} from "@/lib/utils/hierarchy";

function getDisabledBadgeText(reason?: string): string | null {
  switch (reason) {
    case "self":
      return "Current document";
    case "descendant":
      return "Descendant";
    case "max_depth":
      return "Max depth exceeded";
    case "not_found":
      return "Unavailable";
    default:
      return null;
  }
}

interface MoveDocumentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  spaceId: string;
  documentId: string;
  currentParentId: string | null;
  documentTitle?: string;
  /** Ref to the element that should receive focus when the dialog closes. */
  returnFocusRef?: React.MutableRefObject<HTMLElement | null>;
  containerRef?: React.RefObject<HTMLElement | null>;
  onSuccess?: (destinationParentId: string | null) => void;
}

export function MoveDocumentDialog({
  isOpen,
  onClose,
  spaceId,
  documentId,
  currentParentId,
  documentTitle,
  returnFocusRef,
  containerRef,
  onSuccess,
}: MoveDocumentDialogProps) {
  const { data: tree, isLoading } = useQuery({
    queryKey: ["sidebar-tree", spaceId],
    queryFn: () => getSidebarTree(spaceId),
    enabled: isOpen,
  });

  const [selectedParentId, setSelectedParentId] = useState<string | null | undefined>(undefined);
  const [activeIdOverride, setActiveIdOverride] = useState<string | null>(null);
  const [manuallyToggled, setManuallyToggled] = useState<Map<string, boolean>>(new Map());
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);

  if (prevIsOpen !== isOpen) {
    setPrevIsOpen(isOpen);
    if (!isOpen) {
      setSelectedParentId(undefined);
      setActiveIdOverride(null);
      setManuallyToggled(new Map());
    }
  }

  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());
  const isPointerInteractionRef = useRef(false);
  const isMoveSuccessfulRef = useRef(false);

  // Auto-expand ancestry of initial target node
  const expandedNodes = useMemo(() => {
    const expanded = new Set<string>();
    const targetDocId =
      selectedParentId !== undefined && selectedParentId !== null
        ? selectedParentId
        : currentParentId;

    if (isOpen && tree && targetDocId) {
      const findPath = (nodes: SidebarNode[], idToFind: string, currentPath: string[]): boolean => {
        for (const node of nodes) {
          const path = [...currentPath, node.id];
          if (node.id === idToFind) {
            path.forEach((pId) => expanded.add(pId));
            return true;
          }
          if (node.children && findPath(node.children, idToFind, path)) {
            return true;
          }
        }
        return false;
      };
      findPath(tree, targetDocId, []);
    }

    for (const [id, isExp] of manuallyToggled) {
      if (isExp) {
        expanded.add(id);
      } else {
        expanded.delete(id);
      }
    }
    return expanded;
  }, [isOpen, tree, currentParentId, selectedParentId, manuallyToggled]);

  const defaultActiveId = useMemo(() => {
    if (!tree) return SPACE_ROOT_ID;
    if (selectedParentId !== undefined) {
      if (selectedParentId === null) return SPACE_ROOT_ID;
      if (findNodeInTree(tree, selectedParentId)) return selectedParentId;
    }
    if (currentParentId !== null && findNodeInTree(tree, currentParentId)) {
      return currentParentId;
    }
    return SPACE_ROOT_ID;
  }, [tree, selectedParentId, currentParentId]);

  const treeContainerRef = useRef<HTMLDivElement | null>(null);

  const visibleItems = useMemo(
    () => getVisibleTreeItems(tree || [], expandedNodes),
    [tree, expandedNodes]
  );

  const activeId = useMemo(
    () => resolveVisibleActiveId(visibleItems, activeIdOverride, defaultActiveId),
    [visibleItems, activeIdOverride, defaultActiveId]
  );

  const handleCloseAutoFocus = (event: Event) => {
    if (isMoveSuccessfulRef.current) {
      isMoveSuccessfulRef.current = false;
      if (returnFocusRef) {
        returnFocusRef.current = null;
      }
      event.preventDefault();
      const interimTarget = containerRef?.current;
      if (interimTarget && interimTarget.isConnected) {
        interimTarget.focus({ preventScroll: true });
      }
      return;
    }

    const target = returnFocusRef?.current;
    const isPointer = isPointerInteractionRef.current;
    isPointerInteractionRef.current = false;

    if (returnFocusRef) {
      returnFocusRef.current = null;
    }

    if (target?.isConnected) {
      event.preventDefault();
      if (isPointer) {
        target.focus({ focusVisible: false } as FocusOptions);
      } else {
        target.focus();
      }
    }
  };

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const toggleNode = (id: string) => {
    setManuallyToggled((prev) => {
      const next = new Map(prev);
      const currentlyExpanded = expandedNodes.has(id);
      next.set(id, !currentlyExpanded);
      return next;
    });
  };

  const handleToggleNode = (nodeId: string, isPointer = false) => {
    const isCurrentlyExpanded = expandedNodes.has(nodeId);

    // When collapsing a node that contains the active item:
    // 1. move the active ID to the node being collapsed
    // 2. focus that tree item when appropriate
    // 3. then collapse its descendants
    if (isCurrentlyExpanded) {
      const activeIsDescendant =
        activeId !== nodeId &&
        Boolean(tree && isDescendantOf(tree, activeId, nodeId));

      if (activeIsDescendant) {
        setActiveIdOverride(nodeId);

        const treeEl = treeContainerRef.current;
        const isFocusInsideTree = Boolean(
          treeEl && treeEl.contains(document.activeElement)
        );

        if (isFocusInsideTree) {
          const el = itemRefs.current.get(nodeId);
          if (el) {
            if (isPointer) {
              el.focus({ focusVisible: false } as FocusOptions);
            } else {
              el.focus();
            }
            el.scrollIntoView({ block: "nearest" });
          }
        }
      }
    }

    toggleNode(nodeId);
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
        if (visibleItems.length > 0) {
          focusItem(visibleItems[0].id);
        }
        break;
      }
      case "End": {
        e.preventDefault();
        if (visibleItems.length > 0) {
          focusItem(visibleItems[visibleItems.length - 1].id);
        }
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
          if (!currentItem.isExpanded) {
            handleToggleNode(currentItem.id, false);
          } else {
            const firstChildId = findFirstChildVisibleId(visibleItems, activeId);
            if (firstChildId) focusItem(firstChildId);
          }
        }
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        const currentItem = visibleItems.find((i) => i.id === activeId);
        if (!currentItem) break;

        if (currentItem.id === SPACE_ROOT_ID) {
          break;
        }

        if (currentItem.hasChildren && currentItem.isExpanded) {
          handleToggleNode(currentItem.id, false);
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
        if (currentItem) {
          const validity = validateMoveDestination(
            tree || [],
            documentId,
            currentItem.destinationParentId,
            currentParentId
          );
          if (validity.valid) {
            setSelectedParentId(currentItem.destinationParentId);
          }
        }
        break;
      }
    }
  };

  const { mutate: handleMove, isPending } = useMutation({
    mutationFn: async () => {
      if (selectedParentId === undefined) return;
      await moveDocument(documentId, selectedParentId);
    },
    onSuccess: () => {
      isMoveSuccessfulRef.current = true;
      if (returnFocusRef) {
        returnFocusRef.current = null;
      }
      toast({ title: "Document moved successfully" });
      queryClient.invalidateQueries({ queryKey: ["sidebar-tree", spaceId] });
      queryClient.invalidateQueries({ queryKey: ["doc", documentId] });
      onSuccess?.(selectedParentId ?? null);
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to move document", description: err.message, variant: "destructive" });
    }
  });

  const spaceRootValidity = validateMoveDestination(
    tree || [],
    documentId,
    null,
    currentParentId
  );
  const isSpaceRootDisabled = !spaceRootValidity.valid;
  const isSpaceRootSelected = selectedParentId === null;

  const selectedValidity =
    selectedParentId !== undefined
      ? validateMoveDestination(tree || [], documentId, selectedParentId, currentParentId)
      : { valid: false };

  const renderTree = (nodes: SidebarNode[], level: number) => {
    return nodes.map((node) => {
      const validity = validateMoveDestination(
        tree || [],
        documentId,
        node.id,
        currentParentId
      );
      const isDisabled = !validity.valid;
      const isSelected = selectedParentId === node.id;
      const isOpen = expandedNodes.has(node.id);
      const hasChildren = node.children.length > 0;
      const badgeText = getDisabledBadgeText(validity.reason);

      return (
        <div
          key={node.id}
          ref={(el) => {
            if (el) itemRefs.current.set(node.id, el);
            else itemRefs.current.delete(node.id);
          }}
          role="treeitem"
          id={node.id}
          aria-expanded={hasChildren ? isOpen : undefined}
          aria-selected={isSelected}
          aria-disabled={isDisabled ? true : undefined}
          tabIndex={activeId === node.id ? 0 : -1}
          className="outline-none focus:outline-none focus-visible:outline-none [&:focus-visible>div:first-child]:ring-2 [&:focus-visible>div:first-child]:ring-ring [&:focus-visible>div:first-child]:outline-none"
        >
          <div
            className={cn(
              "flex items-center gap-1 rounded py-1.5 px-2 text-sm transition-colors",
              isDisabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:bg-accent",
              isSelected ? "bg-accent font-medium" : ""
            )}
            style={{ paddingLeft: `${level * 16 + 8}px` }}
            onClick={(e) => {
              e.stopPropagation();
              setActiveIdOverride(node.id);
              if (!isDisabled) {
                setSelectedParentId(node.id);
              }
            }}
          >
            <span
              role="presentation"
              aria-hidden="true"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleToggleNode(node.id, true);
              }}
              className={cn(
                "h-4 w-4 shrink-0 flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer rounded-xs",
                !hasChildren && "invisible"
              )}
            >
              {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </span>
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{node.title}</span>
            {node.id === currentParentId && (
              <span className="text-xs text-muted-foreground ml-2 shrink-0">(Current)</span>
            )}
            {isDisabled && node.id !== currentParentId && badgeText && (
              <span className="text-xs text-muted-foreground ml-2 shrink-0">({badgeText})</span>
            )}
            {isSelected && <Check className="h-3.5 w-3.5 text-primary ml-auto shrink-0" />}
          </div>
          {isOpen && hasChildren && (
            <div role="group">
              {renderTree(node.children, level + 1)}
            </div>
          )}
        </div>
      );
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="sm:max-w-[500px]"
        onCloseAutoFocus={handleCloseAutoFocus}
        onPointerDown={() => {
          isPointerInteractionRef.current = true;
        }}
        onPointerDownOutside={() => {
          isPointerInteractionRef.current = true;
        }}
        onKeyDown={() => {
          isPointerInteractionRef.current = false;
        }}
      >
        <DialogHeader>
          <DialogTitle>Move document</DialogTitle>
          <DialogDescription>
            Select a new location{documentTitle ? ` for "${documentTitle}"` : " for this document"}.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {isLoading ? (
            <div className="flex justify-center p-4"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : (
            <div
              ref={treeContainerRef}
              role="tree"
              aria-label="Move destinations"
              className="border rounded-md max-h-[300px] overflow-y-auto p-1 focus:outline-none"
              onKeyDown={handleTreeKeyDown}
            >
              <div
                ref={(el) => {
                  if (el) itemRefs.current.set(SPACE_ROOT_ID, el);
                  else itemRefs.current.delete(SPACE_ROOT_ID);
                }}
                role="treeitem"
                id={SPACE_ROOT_ID}
                aria-selected={isSpaceRootSelected}
                aria-disabled={isSpaceRootDisabled ? true : undefined}
                tabIndex={activeId === SPACE_ROOT_ID ? 0 : -1}
                className={cn(
                  "flex items-center gap-2 rounded py-1.5 px-2 text-sm transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isSpaceRootDisabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:bg-accent",
                  isSpaceRootSelected ? "bg-accent font-medium" : ""
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveIdOverride(SPACE_ROOT_ID);
                  if (!isSpaceRootDisabled) {
                    setSelectedParentId(null);
                  }
                }}
              >
                <Home className="h-4 w-4 text-muted-foreground ml-1 shrink-0" />
                <span>Space root</span>
                {currentParentId === null && (
                  <span className="text-xs text-muted-foreground ml-2 shrink-0">(Current)</span>
                )}
                {isSpaceRootDisabled && currentParentId !== null && (
                  <span className="text-xs text-muted-foreground ml-2 shrink-0">
                    ({getDisabledBadgeText(spaceRootValidity.reason)})
                  </span>
                )}
                {isSpaceRootSelected && (
                  <Check className="h-3.5 w-3.5 text-primary ml-auto shrink-0" />
                )}
              </div>
              <div role="separator" aria-orientation="horizontal" className="my-1 border-t" />
              {renderTree(tree || [], 0)}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button 
            onClick={() => handleMove()} 
            disabled={isPending || selectedParentId === undefined || !selectedValidity.valid}
          >
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
