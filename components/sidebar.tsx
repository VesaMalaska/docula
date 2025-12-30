"use client";

import { useAuth } from "@/components/providers/auth-provider";
import { LogOut, Plus, Loader2, X } from "lucide-react";
import { SidebarTree } from "./sidebar-tree";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createDocument } from "@/lib/actions/document";
import { useRouter } from "next/navigation";
import { ModeToggle } from "./mode-toggle";

interface SidebarProps {
  onClose?: () => void;
}

export function Sidebar({ onClose }: SidebarProps) {
  const { user, logout } = useAuth();
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
    <aside className="flex h-full w-64 flex-col border-r bg-gray-50 dark:bg-zinc-900 dark:border-zinc-800 transition-colors duration-300">
      <div className="flex items-center justify-between p-4 border-b dark:border-zinc-800">
        <h1 className="text-xl font-bold dark:text-zinc-100">Docula</h1>
        <div className="flex items-center gap-1">
            <button
            onClick={() => createDoc()}
            disabled={isPending}
            className="rounded p-1 hover:bg-gray-200 dark:hover:bg-zinc-800 dark:text-zinc-400 disabled:opacity-50"
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
                className="p-1 lg:hidden text-gray-500 hover:text-gray-900 dark:text-zinc-400 dark:hover:text-zinc-100"
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

      <div className="p-4 border-t bg-gray-100 dark:bg-zinc-900/50 dark:border-zinc-800">
        <div className="flex items-center justify-between gap-2 mb-4">
           <div className="flex items-center gap-2 overflow-hidden">
            {user?.photoURL && (
                <img
                src={user.photoURL}
                alt="Avatar"
                className="w-8 h-8 rounded-full"
                />
            )}
            <span className="text-sm font-medium truncate flex-1 dark:text-zinc-200">
                {user?.displayName || user?.email}
            </span>
           </div>
           <ModeToggle />
        </div>
        <button
          onClick={logout}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
        >
          <LogOut className="h-4 w-4" />
          Logout
        </button>
      </div>
    </aside>
  );
}
