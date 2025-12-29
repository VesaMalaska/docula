"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getDocument, updateDocument, getSidebarTree } from "@/lib/actions/document";
import { acquireLock, releaseLock } from "@/lib/actions/locking";
import { useHeartbeat } from "@/hooks/use-heartbeat";
import { useParams } from "next/navigation";
import { Editor } from "@/components/editor";
import { useState, useEffect, useRef } from "react";
import { Loader2, Save, Edit2, AlertCircle } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import Link from "next/link";
import { SidebarNode } from "@/lib/types";

function BacklinksList({ docIds }: { docIds: string[] }) {
    const { data: tree } = useQuery({ queryKey: ["sidebar-tree"], queryFn: getSidebarTree });
    
    const findTitle = (id: string, nodes: SidebarNode[]): string | null => {
        for (const node of nodes) {
            if (node.id === id) return node.title;
            if (node.children) {
                const found = findTitle(id, node.children);
                if (found) return found;
            }
        }
        return null;
    };

    if (!tree) return <div className="text-gray-400 dark:text-zinc-500 text-xs">Loading links...</div>;

    return (
        <div className="mt-1 flex flex-wrap gap-2">
            {docIds.map(id => {
                const title = findTitle(id, tree) || "Unknown Doc";
                return (
                    <Link key={id} href={`/doc/${id}`} className="bg-gray-100 dark:bg-zinc-800 px-2 py-1 rounded text-xs hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-700 dark:text-zinc-300 transition-colors">
                        {title}
                    </Link>
                );
            })}
        </div>
    );
}

export default function DocPage() {
  const params = useParams();
  const id = params.id as string;
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [isEditing, setIsEditing] = useState(false);
  const [content, setContent] = useState<any>(null);
  const [title, setTitle] = useState("");
  
  const isEditingRef = useRef(false);

  const { data: doc, isLoading } = useQuery({
    queryKey: ["doc", id],
    queryFn: () => getDocument(id),
    refetchInterval: 30000, 
  });

  useEffect(() => {
    if (doc) {
      if (!isEditing) {
          setContent(doc.content);
          setTitle(doc.title);
      }
    }
  }, [doc, isEditing]);

  useEffect(() => {
      isEditingRef.current = isEditing;
  }, [isEditing]);

  useHeartbeat(id, isEditing, user?.uid);

  useEffect(() => {
    return () => {
        if (isEditingRef.current && user?.uid) {
            releaseLock(id, user.uid);
        }
    };
  }, [id, user?.uid]);

  const handleEdit = async () => {
    if (!user) return;
    const success = await acquireLock(id, user.uid, user.displayName || user.email || "Unknown");
    if (success) {
        setIsEditing(true);
        queryClient.invalidateQueries({ queryKey: ["doc", id] });
    } else {
        alert("Could not acquire lock. Document is being edited by someone else.");
    }
  };

  const handleCancel = async () => {
      setIsEditing(false);
      if (doc) {
        setContent(doc.content);
        setTitle(doc.title);
      }
      if (user) await releaseLock(id, user.uid);
      queryClient.invalidateQueries({ queryKey: ["doc", id] });
  };

  const { mutate: save, isPending: isSaving } = useMutation({
    mutationFn: async () => {
      await updateDocument(id, { 
        title, 
        content,
      });
      if (user) await releaseLock(id, user.uid);
    },
    onSuccess: () => {
      setIsEditing(false);
      queryClient.invalidateQueries({ queryKey: ["doc", id] });
      queryClient.invalidateQueries({ queryKey: ["sidebar-tree"] }); 
    },
  });

  if (isLoading) return <div className="p-8 text-gray-500 dark:text-zinc-400">Loading document...</div>;
  if (!doc) return <div className="p-8 text-gray-500 dark:text-zinc-400">Document not found</div>;

  const isLockedByOther = doc.lock?.active && 
                          doc.lock.expiresAt.toDate() > new Date() && 
                          doc.lock.userId !== user?.uid;

  return (
    <div className="mx-auto max-w-4xl relative">
      {isLockedByOther && (
          <div className="mb-4 rounded-md bg-amber-50 dark:bg-amber-900/20 p-4 border border-amber-200 dark:border-amber-900/30">
            <div className="flex">
              <div className="flex-shrink-0">
                <AlertCircle className="h-5 w-5 text-amber-400 dark:text-amber-500" aria-hidden="true" />
              </div>
              <div className="ml-3">
                <h3 className="text-sm font-medium text-amber-800 dark:text-amber-200">Document is locked</h3>
                <div className="mt-2 text-sm text-amber-700 dark:text-amber-300">
                  <p>
                    This document is currently being edited by {doc.lock?.userName}. 
                    You can only view it until they release the lock (expires {doc.lock?.expiresAt.toDate().toLocaleTimeString()}).
                  </p>
                </div>
              </div>
            </div>
          </div>
      )}

      <div className="mb-6 flex items-center justify-between border-b dark:border-zinc-800 pb-4">
        {isEditing ? (
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="text-3xl font-bold text-gray-900 dark:text-zinc-100 bg-transparent focus:outline-none w-full mr-4 placeholder-gray-400 dark:placeholder-zinc-600"
            placeholder="Untitled"
          />
        ) : (
          <h1 className="text-3xl font-bold text-gray-900 dark:text-zinc-100">{doc.title}</h1>
        )}

        <div className="flex gap-2">
          {isEditing ? (
             <>
                <button
                  onClick={handleCancel}
                  className="px-3 py-1 text-sm text-gray-600 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => save()}
                  disabled={isSaving}
                  className="flex items-center gap-1 rounded bg-indigo-600 dark:bg-indigo-500 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-700 dark:hover:bg-indigo-600 disabled:opacity-50 transition-colors"
                >
                  {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save
                </button>
             </>
          ) : (
             <button
                onClick={handleEdit}
                disabled={!!isLockedByOther}
                className="flex items-center gap-1 rounded border dark:border-zinc-700 dark:text-zinc-300 px-3 py-1 text-sm font-medium hover:bg-gray-50 dark:hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
             >
                <Edit2 className="h-4 w-4" />
                {isLockedByOther ? "Locked" : "Edit"}
             </button>
          )}
        </div>
      </div>

      <div className="min-h-[500px]">
        <Editor 
            key={doc.id + (isEditing ? '-edit' : '-view')} 
            content={content} 
            editable={isEditing} 
            onChange={setContent} 
        />
      </div>
      
      <div className="mt-10 border-t dark:border-zinc-800 pt-4 text-sm text-gray-400 dark:text-zinc-500">
        <p>Last updated: {doc.updatedAt?.toDate ? doc.updatedAt.toDate().toLocaleString() : 'Just now'}</p>
        <div className="mt-2">
            <span className="font-semibold text-gray-900 dark:text-zinc-200">Linked to by:</span>
            {doc.backlinks?.length > 0 ? (
                <BacklinksList docIds={doc.backlinks} />
            ) : " None"}
        </div>
      </div>
    </div>
  );
}
