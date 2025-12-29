"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getSidebarTree, createDocument, deleteDocument } from "@/lib/actions/document";
import { SidebarNode } from "@/lib/types";
import { ChevronRight, ChevronDown, FileText, Plus, Trash2, Loader2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/providers/auth-provider";

export function SidebarTree() {
  const { data: tree, isLoading, error } = useQuery({
    queryKey: ["sidebar-tree"],
    queryFn: getSidebarTree,
  });

  if (isLoading) return <div className="text-sm text-gray-500 dark:text-zinc-500 px-4">Loading...</div>;
  if (error) return <div className="text-sm text-red-500 px-4">Error loading docs</div>;

  return (
    <div className="space-y-0.5">
      {tree?.map((node) => (
        <TreeNode key={node.id} node={node} level={0} />
      ))}
      {tree?.length === 0 && (
          <div className="px-4 py-2 text-sm text-gray-400 dark:text-zinc-500">No documents yet.</div>
      )}
    </div>
  );
}

function TreeNode({ node, level }: { node: SidebarNode; level: number }) {
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname();
  const isActive = pathname === `/doc/${node.id}`;
  const hasChildren = node.children.length > 0;

  const queryClient = useQueryClient();
  const router = useRouter();
  const { user } = useAuth();

  const { mutate: createChild, isPending: isCreating } = useMutation({
    mutationFn: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      return createDocument(node.id, user?.uid || "");
    },
    onSuccess: (newId) => {
      setIsOpen(true);
      queryClient.invalidateQueries({ queryKey: ["sidebar-tree"] });
      router.push(`/doc/${newId}`);
    },
  });

  const { mutate: deleteDoc, isPending: isDeleting } = useMutation({
    mutationFn: async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm("Are you sure you want to delete this page?")) {
        throw new Error("Cancelled");
      }
      return deleteDocument(node.id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sidebar-tree"] });
      if (isActive) router.push("/");
    },
    onError: () => {
        // cancelled
    }
  });

  return (
    <div>
      <div
        className={cn(
          "group flex items-center gap-1 rounded-r-md py-1 text-sm hover:bg-gray-100 dark:hover:bg-zinc-800 pr-2 transition-colors",
          isActive 
            ? "bg-gray-200 dark:bg-zinc-800 font-medium text-gray-900 dark:text-zinc-100" 
            : "text-gray-700 dark:text-zinc-400"
        )}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
      >
        <button
          onClick={(e) => {
            e.preventDefault();
            setIsOpen(!isOpen);
          }}
          className={cn(
            "h-4 w-4 shrink-0 text-gray-500 hover:text-gray-700 dark:text-zinc-500 dark:hover:text-zinc-300 transition-transform",
            !hasChildren && "invisible"
          )}
        >
          {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        
        <Link href={`/doc/${node.id}`} className="flex-1 truncate block mr-2">
            <div className="flex items-center gap-2">
                <FileText className={cn("h-3.5 w-3.5", isActive ? "text-gray-600 dark:text-zinc-300" : "text-gray-400 dark:text-zinc-500")} />
                <span className="truncate">{node.title}</span>
            </div>
        </Link>

        {/* Actions - visible on group hover */}
        <div className="invisible group-hover:visible flex items-center gap-1">
            <button 
                onClick={(e) => createChild(e)}
                disabled={isCreating}
                className="text-gray-400 hover:text-gray-600 dark:text-zinc-500 dark:hover:text-zinc-300 p-0.5 rounded hover:bg-gray-200 dark:hover:bg-zinc-700"
                title="Add Child Page"
            >
                {isCreating ? <Loader2 className="h-3 w-3 animate-spin"/> : <Plus className="h-3 w-3" />}
            </button>
            <button 
                onClick={(e) => deleteDoc(e)}
                disabled={isDeleting}
                className="text-gray-400 hover:text-red-600 dark:text-zinc-500 dark:hover:text-red-400 p-0.5 rounded hover:bg-gray-200 dark:hover:bg-zinc-700"
                title="Delete Page"
            >
                {isDeleting ? <Loader2 className="h-3 w-3 animate-spin"/> : <Trash2 className="h-3 w-3" />}
            </button>
        </div>
      </div>

      {isOpen && (
        <div>
          {node.children.map((child) => (
            <TreeNode key={child.id} node={child} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
}