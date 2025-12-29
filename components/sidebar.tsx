"use client";

import { useAuth } from "@/components/providers/auth-provider";
import { LogOut, Plus, Loader2 } from "lucide-react";
import { SidebarTree } from "./sidebar-tree";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createDocument } from "@/lib/actions/document";
import { useRouter } from "next/navigation";

export function Sidebar() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();

  const { mutate: createDoc, isPending } = useMutation({
    mutationFn: () => createDocument(null, user?.uid || ""),
    onSuccess: (newDocId) => {
      queryClient.invalidateQueries({ queryKey: ["sidebar-tree"] });
      router.push(`/doc/${newDocId}`);
    },
  });

  return (
    <aside className="flex h-full w-64 flex-col border-r bg-gray-50">
      <div className="flex items-center justify-between p-4 border-b">
        <h1 className="text-xl font-bold">Docula</h1>
        <button
          onClick={() => createDoc()}
          disabled={isPending}
          className="rounded p-1 hover:bg-gray-200 disabled:opacity-50"
          title="New Document"
        >
          {isPending ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Plus className="h-5 w-5" />
          )}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-4">
        <SidebarTree />
      </div>

      <div className="p-4 border-t bg-gray-100">
        <div className="flex items-center gap-2 mb-2">
          {user?.photoURL && (
            <img
              src={user.photoURL}
              alt="Avatar"
              className="w-8 h-8 rounded-full"
            />
          )}
          <span className="text-sm font-medium truncate flex-1">
            {user?.displayName || user?.email}
          </span>
        </div>
        <button
          onClick={logout}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-red-600 hover:bg-red-50"
        >
          <LogOut className="h-4 w-4" />
          Logout
        </button>
      </div>
    </aside>
  );
}
