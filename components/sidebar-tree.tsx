"use client";

import { useState, useRef, useEffect, useCallback, createContext, useContext, MouseEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getSidebarTree, createDocument, deleteDocument } from "@/lib/actions/document";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { SidebarNode } from "@/lib/types";
import { ChevronRight, ChevronDown, FileText, Plus, Trash2, Loader2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/providers/auth-provider";
import { useExpandedNodes } from "@/hooks/use-expanded-nodes";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { MoveDocumentDialog } from "@/components/move-document-dialog";
import { ImportMarkdownDialog } from "@/components/import-markdown-dialog";
import { MoreHorizontal, FolderOutput, Upload } from "lucide-react";
import { calculateDocumentDeleteFallback, findAncestryPath, isNodeAtDestination, isPathCollapsed } from "@/lib/focus-fallback";

interface TreeContextValue {
  triggerRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  itemRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  pendingDialogActionRef: React.MutableRefObject<{
    action: "move" | "import" | "delete";
    node: SidebarNode;
  } | null>;
  returnFocusRef: React.MutableRefObject<HTMLElement | null>;
  onOpenDialog: (action: "move" | "import" | "delete", node: SidebarNode) => void;
  activeDialogNodeId: string | null;
}

const TreeContext = createContext<TreeContextValue | null>(null);

function useTreeContext() {
  const ctx = useContext(TreeContext);
  if (!ctx) {
    throw new Error("useTreeContext must be used within a TreeContext.Provider");
  }
  return ctx;
}

interface SidebarTreeProps {
  spaceId: string;
  spaceControlRef?: React.RefObject<HTMLElement | null>;
}

export function SidebarTree({ spaceId, spaceControlRef }: SidebarTreeProps) {
  const { data: tree, isLoading, isFetching, error } = useQuery({
    queryKey: ["sidebar-tree", spaceId],
    queryFn: () => getSidebarTree(spaceId),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  const { expandedNodes, isExpanded, toggleNode, expandNodes } = useExpandedNodes();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useAuth();

  const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());
  const containerRef = useRef<HTMLDivElement | null>(null);

  const pendingDialogActionRef = useRef<{
    action: "move" | "import" | "delete";
    node: SidebarNode;
  } | null>(null);

  const returnFocusRef = useRef<HTMLElement | null>(null);
  const actionReturnFocusRef = useRef<HTMLElement | null>(null);
  const pendingMoveRef = useRef<{
    movedDocId: string;
    destinationParentId: string | null;
  } | null>(null);

  const [activeDialog, setActiveDialog] = useState<{
    action: "move" | "import" | "delete";
    node: SidebarNode;
  } | null>(null);

  const { mutate: deleteDoc, isPending: isDeleting } = useMutation({
    mutationFn: async (node: SidebarNode) => {
      if (!user) return;
      return deleteDocument(node.id, user.uid);
    },
    onSuccess: (_, deletedNode) => {
      queryClient.invalidateQueries({ queryKey: ["sidebar-tree", spaceId] });
      setActiveDialog(null);
      if (pathname === `/space/${spaceId}/doc/${deletedNode.id}`) {
        router.push(`/space/${spaceId}`);
      }
    },
    onError: () => {
      // cancelled or error
    },
  });

  const handleOpenDialog = useCallback(
    (action: "move" | "import" | "delete", node: SidebarNode) => {
      if (action === "delete" && tree) {
        const fallback = calculateDocumentDeleteFallback(tree, node.id);
        let el: HTMLElement | null = null;
        if (fallback.type === "item" || fallback.type === "parent") {
          const trigger = triggerRefs.current.get(fallback.id);
          const item = itemRefs.current.get(fallback.id);
          if (trigger && trigger.isConnected) {
            el = trigger;
          } else if (item && item.isConnected) {
            el = item;
          }
        }
        if (!el || !el.isConnected) {
          const spaceControl = spaceControlRef?.current;
          el = (spaceControl && spaceControl.isConnected) ? spaceControl : containerRef.current;
        }
        actionReturnFocusRef.current = el;
      }
      setActiveDialog({ action, node });
    },
    [tree, spaceControlRef]
  );

  useEffect(() => {
    if (!pendingMoveRef.current || !tree || isFetching) {
      return;
    }

    const { movedDocId, destinationParentId } = pendingMoveRef.current;

    // Step 1: Wait until refreshed tree data confirms the moved document is actually located
    // under the requested destination parent.
    if (!isNodeAtDestination(tree, movedDocId, destinationParentId)) {
      return;
    }

    // Step 2: Calculate the complete ancestry path to the destination parent.
    const path = findAncestryPath(tree, destinationParentId);

    // Step 3 & 4: Determine whether any node in that path is still collapsed.
    // If expansion is needed, expand the missing path nodes and return immediately
    // without focusing fallback or clearing pendingMoveRef.
    if (isPathCollapsed(path, expandedNodes)) {
      expandNodes(path);
      return;
    }

    // Step 5 & 6: On the subsequent effect pass (or immediately if already expanded / root),
    // focus the exact moved document's connected ⋯ trigger.
    // Check 1: Relocated document's exact connected ⋯ trigger
    const trigger = triggerRefs.current.get(movedDocId);
    if (trigger && trigger.isConnected) {
      trigger.focus();
      pendingMoveRef.current = null;
      return;
    }

    // Check 1b: Relocated document's link
    const item = itemRefs.current.get(movedDocId);
    if (item && item.isConnected) {
      item.focus();
      pendingMoveRef.current = null;
      return;
    }

    // Fallback 1: Surviving destination parent document (trigger first, then item)
    if (destinationParentId) {
      const parentTrigger = triggerRefs.current.get(destinationParentId);
      const parentItem = itemRefs.current.get(destinationParentId);
      const parentEl = (parentTrigger && parentTrigger.isConnected)
        ? parentTrigger
        : (parentItem && parentItem.isConnected)
        ? parentItem
        : null;
      if (parentEl) {
        parentEl.focus();
        pendingMoveRef.current = null;
        return;
      }
    }

    // Fallback 2: Containing Space control
    const spaceControl = spaceControlRef?.current;
    if (spaceControl && spaceControl.isConnected) {
      spaceControl.focus();
      pendingMoveRef.current = null;
      return;
    }

    // Fallback 3: Labelled document-tree container
    if (containerRef.current && containerRef.current.isConnected) {
      containerRef.current.focus();
      pendingMoveRef.current = null;
      return;
    }
  }, [tree, isFetching, spaceControlRef, expandNodes, expandedNodes]);

  if (isLoading) {
    return <SidebarSkeleton />;
  }

  if (error) return <div className="text-sm text-destructive px-4">Error: {error.message}</div>;

  const contextValue: TreeContextValue = {
    triggerRefs,
    itemRefs,
    pendingDialogActionRef,
    returnFocusRef,
    onOpenDialog: handleOpenDialog,
    activeDialogNodeId: activeDialog?.node.id ?? null,
  };

  return (
    <TreeContext.Provider value={contextValue}>
      <div
        ref={containerRef}
        tabIndex={-1}
        aria-label="Document tree"
        className="space-y-0.5 outline-none"
      >
        {tree?.map((node) => (
          <TreeNode
            key={node.id}
            node={node}
            level={0}
            isExpanded={isExpanded}
            toggleNode={toggleNode}
            spaceId={spaceId}
          />
        ))}
        {tree?.length === 0 && (
            <div className="px-4 py-2 text-sm text-muted-foreground">No documents yet.</div>
        )}
      </div>

      {activeDialog?.action === "delete" && (
        <AlertDialog
          isOpen={activeDialog.action === "delete"}
          onClose={() => setActiveDialog(null)}
          title="Delete Page"
          description="Are you sure you want to delete this page? This action cannot be undone."
          onAction={() => activeDialog && deleteDoc(activeDialog.node)}
          variant="destructive"
          actionLabel={isDeleting ? "Deleting..." : "Delete"}
          returnFocusRef={returnFocusRef}
          actionReturnFocusRef={actionReturnFocusRef}
        />
      )}

      {activeDialog?.action === "move" && (
        <MoveDocumentDialog
          isOpen={activeDialog.action === "move"}
          onClose={() => setActiveDialog(null)}
          spaceId={spaceId}
          documentId={activeDialog.node.id}
          currentParentId={activeDialog.node.parentId}
          documentTitle={activeDialog.node.title}
          returnFocusRef={returnFocusRef}
          containerRef={containerRef}
          onSuccess={(destinationParentId) => {
            const movedDocId = activeDialog.node.id;
            pendingMoveRef.current = { movedDocId, destinationParentId };
          }}
        />
      )}

      {activeDialog?.action === "import" && (
        <ImportMarkdownDialog
          isOpen={activeDialog.action === "import"}
          onClose={() => setActiveDialog(null)}
          spaceId={spaceId}
          parentId={activeDialog.node.id}
          destinationName={activeDialog.node.title}
          isSpaceRoot={false}
          returnFocusRef={returnFocusRef}
          onSuccess={() => {
            if (!isExpanded(activeDialog.node.id)) {
              toggleNode(activeDialog.node.id);
            }
          }}
        />
      )}
    </TreeContext.Provider>
  );
}

function SidebarSkeleton() {
    const widths = ["w-1/2", "w-3/4", "w-2/3", "w-1/3", "w-1/2", "w-2/3", "w-3/4", "w-1/2"];
    return (
        <div className="space-y-2 px-4 animate-pulse">
            {widths.map((width, i) => (
                <div key={i} className="flex items-center gap-2">
                    <div className="h-3 w-3 bg-muted rounded shadow-sm" />
                    <div className={cn("h-4 bg-muted rounded shadow-sm", width)} />
                </div>
            ))}
        </div>
    );
}

function TreeNode({ 
    node, 
    level, 
    isExpanded, 
    toggleNode,
    spaceId
}: { 
    node: SidebarNode; 
    level: number;
    isExpanded: (id: string) => boolean;
    toggleNode: (id: string) => void;
    spaceId: string;
}) {
  const isOpen = isExpanded(node.id);
  const pathname = usePathname();
  const isActive = pathname === `/space/${spaceId}/doc/${node.id}`;
  const hasChildren = node.children.length > 0;

  const queryClient = useQueryClient();
  const router = useRouter();

  const {
    triggerRefs,
    itemRefs,
    pendingDialogActionRef,
    returnFocusRef,
    onOpenDialog,
    activeDialogNodeId,
  } = useTreeContext();

  const { mutate: createChild, isPending: isCreating } = useMutation({
    mutationFn: (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      return createDocument(spaceId, node.id);
    },
    onSuccess: (newId) => {
      if (!isOpen) toggleNode(node.id);
      queryClient.invalidateQueries({ queryKey: ["sidebar-tree", spaceId] });
      router.push(`/space/${spaceId}/doc/${newId}?edit=true`);
    },
  });

  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const isRowDialogActive = activeDialogNodeId === node.id;

  return (
    <div>
      <div
        className={cn(
          "group flex items-center gap-1 rounded-r-md py-1 text-sm hover:bg-accent pr-2 transition-colors",
          isActive 
            ? "bg-accent font-medium text-accent-foreground" 
            : "text-muted-foreground hover:text-foreground"
        )}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
      >
        <button
          onClick={(e) => {
            e.preventDefault();
            toggleNode(node.id);
          }}
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground hover:text-foreground transition-transform cursor-pointer",
            !hasChildren && "invisible"
          )}
        >
          {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        
        <Link
            ref={(el) => {
                if (el) itemRefs.current.set(node.id, el);
                else itemRefs.current.delete(node.id);
            }}
            href={`/space/${spaceId}/doc/${node.id}`}
            className="flex-1 truncate block mr-2 cursor-pointer"
        >
            <div className="flex items-center gap-2">
                <FileText className={cn("h-3.5 w-3.5 shrink-0", isActive ? "text-foreground" : "text-muted-foreground")} />
                <span className="truncate">{node.title}</span>
            </div>
        </Link>

        {/* Actions - visible on group hover, or permanently if active/dropdown open/dialog active */}
        <div className={cn(
            "flex items-center gap-1",
            (isActive || isDropdownOpen || isRowDialogActive)
                ? "opacity-100 pointer-events-auto"
                : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto"
        )}>
            {level < 3 && (
                <button 
                    onClick={(e) => createChild(e)}
                    disabled={isCreating}
                    className="text-muted-foreground hover:text-foreground p-0.5 rounded hover:bg-muted cursor-pointer"
                    title="Add Child Page"
                >
                    {isCreating ? <Loader2 className="h-3 w-3 animate-spin"/> : <Plus className="h-3 w-3" />}
                </button>
            )}
            <DropdownMenu open={isDropdownOpen} onOpenChange={setIsDropdownOpen}>
              <DropdownMenuTrigger asChild>
                <button 
                    type="button"
                    ref={(el) => {
                        if (el) triggerRefs.current.set(node.id, el);
                        else triggerRefs.current.delete(node.id);
                    }}
                    className="text-muted-foreground hover:text-foreground p-0.5 rounded hover:bg-muted cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title="More actions"
                    aria-label="Document actions"
                >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-56"
                onCloseAutoFocus={(e) => {
                  const pendingAction = pendingDialogActionRef.current;
                  if (pendingAction) {
                    pendingDialogActionRef.current = null;
                    const { action, node: targetNode } = pendingAction;
                    const trigger = triggerRefs.current.get(targetNode.id);
                    if (trigger && trigger.isConnected) {
                      e.preventDefault();
                      trigger.focus();
                      returnFocusRef.current = trigger;
                    }
                    onOpenDialog(action, targetNode);
                  }
                }}
              >
                <DropdownMenuItem 
                  onSelect={(e) => {
                    e.stopPropagation();
                    pendingDialogActionRef.current = { action: "move", node };
                  }}
                  className="cursor-pointer"
                >
                  <FolderOutput className="h-4 w-4 mr-2" />
                  Move document...
                </DropdownMenuItem>
                <DropdownMenuItem 
                  onSelect={(e) => {
                    e.stopPropagation();
                    pendingDialogActionRef.current = { action: "import", node };
                  }}
                  className="cursor-pointer"
                >
                  <Upload className="h-4 w-4 mr-2" />
                  Import Markdown document…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem 
                  onSelect={(e) => {
                    e.stopPropagation();
                    pendingDialogActionRef.current = { action: "delete", node };
                  }}
                  className="text-destructive focus:text-destructive cursor-pointer focus:bg-destructive/10"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete document
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
        </div>
      </div>

      {isOpen && (
        <div>
          {node.children.map((child) => (
            <TreeNode 
              key={child.id} 
              node={child} 
              level={level + 1} 
              isExpanded={isExpanded}
              toggleNode={toggleNode}
              spaceId={spaceId}
            />
          ))}
        </div>
      )}
    </div>
  );
}