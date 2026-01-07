"use client";


import { Plus, Loader2, X, Trash2 } from "lucide-react";
import { SidebarTree } from "./sidebar-tree";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createDocument } from "@/lib/actions/document";
import { useRouter } from "next/navigation";
import Link from "next/link";


interface SidebarProps {
  onClose?: () => void;
}

export function Sidebar({ onClose }: SidebarProps) {
  // const { user, logout } = useAuth(); // Removed as moved to Header
  const router = useRouter();
  const queryClient = useQueryClient();

  const { mutate: createDoc, isPending } = useMutation({
    mutationFn: () => createDocument(null),
    onSuccess: (newDocId) => {
      queryClient.invalidateQueries({ queryKey: ["sidebar-tree"] });
      router.push(`/doc/${newDocId}`);
      onClose?.();
    },
  });

  return (
    <aside className="flex h-full w-64 flex-col border-r border-border bg-muted transition-colors duration-300">
      <div className="flex items-center justify-between p-4 border-b border-border">
        <h1 className="text-xl font-bold text-foreground">Docula</h1>
        <div className="flex items-center gap-1">
            <button
            onClick={() => createDoc()}
            disabled={isPending}
            className="rounded p-1 hover:bg-accent hover:text-accent-foreground text-muted-foreground disabled:opacity-50 cursor-pointer"
            title="New Document"
            >
            {isPending ? (
                <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
                <Plus className="h-5 w-5" />
            )}
            </button>
            <button
                onClick={onClose}
                className="p-1 lg:hidden text-muted-foreground hover:text-foreground cursor-pointer"
            >
                <X className="h-5 w-5" />
            </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-4" onClick={(e) => {
          // If clicked on a link, close the sidebar on mobile
          if ((e.target as HTMLElement).closest('a')) {
              onClose?.();
          }
      }}>
        <SidebarTree />
      </div>

      <div className="p-4 border-t border-border bg-background/50">
        <div className="mt-0">
             <Link 
                href="/trash"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
                onClick={onClose}
             >
                <Trash2 className="h-4 w-4" />
                Trashbin
            </Link>
        </div>
      </div>
    </aside>
  );
}
