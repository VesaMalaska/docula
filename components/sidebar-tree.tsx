"use client";

import { useState, MouseEvent } from "react";
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

export function SidebarTree({ spaceId }: { spaceId: string }) {
  const { data: tree, isLoading, error } = useQuery({
    queryKey: ["sidebar-tree", spaceId],
    queryFn: () => getSidebarTree(spaceId),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  const { isExpanded, toggleNode } = useExpandedNodes();

  if (isLoading) {
    return <SidebarSkeleton />;
  }

  if (error) return <div className="text-sm text-red-500 px-4">Error: {error.message}</div>;

  return (
    <div className="space-y-0.5">
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
  const { user } = useAuth();

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

  const { mutate: deleteDoc, isPending: isDeleting } = useMutation({
    mutationFn: async () => {
      // Assuming we have access to user here, but sidebar-tree doesn't import useAuth directly
      // Let's fix that
      if (!user) return; 
      return deleteDocument(node.id, user.uid);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sidebar-tree", spaceId] });
      if (isActive) router.push(`/space/${spaceId}`);
    },
    onError: () => {
        // cancelled
    }
  });

  const [showDeleteAlert, setShowDeleteAlert] = useState(false);

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
        
        <Link href={`/space/${spaceId}/doc/${node.id}`} className="flex-1 truncate block mr-2 cursor-pointer">
            <div className="flex items-center gap-2">
                <FileText className={cn("h-3.5 w-3.5 shrink-0", isActive ? "text-foreground" : "text-muted-foreground")} />
                <span className="truncate">{node.title}</span>
            </div>
        </Link>

        {/* Actions - visible on group hover */}
        <div className="invisible group-hover:visible flex items-center gap-1">
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
            <button 
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setShowDeleteAlert(true);
                }}
                disabled={isDeleting}
                className="text-muted-foreground hover:text-destructive p-0.5 rounded hover:bg-muted cursor-pointer"
                title="Delete Page"
            >
                {isDeleting ? <Loader2 className="h-3 w-3 animate-spin"/> : <Trash2 className="h-3 w-3" />}
            </button>
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
      
      <AlertDialog
        isOpen={showDeleteAlert}
        onClose={() => setShowDeleteAlert(false)}
        title="Delete Page"
        description="Are you sure you want to delete this page? This action cannot be undone."
        onAction={() => deleteDoc()}
        variant="destructive"
        actionLabel="Delete"
      />
    </div>
  );
}