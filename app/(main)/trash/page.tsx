"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getDeletedDocuments, restoreDocument, permanentlyDeleteDocument } from "@/lib/actions/document";
import { getSpacesForUser } from "@/lib/actions/spaces";
import { format } from "date-fns";
import { Loader2, RefreshCw, Trash2, ArrowLeft, Archive } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import Link from "next/link";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { useState } from "react";
import { Space } from "@/lib/types";

export default function TrashbinPage() {
    const { user } = useAuth();

    const { data: spaces, isLoading: isLoadingSpaces } = useQuery({
        queryKey: ["user-spaces", user?.uid],
        queryFn: () => user ? getSpacesForUser(user.uid) : Promise.resolve([]),
        enabled: !!user,
    });

    return (
        <div className="flex flex-col h-full bg-background">
            <header className="flex items-center gap-4 border-b px-6 py-4">
                <Link href="/" className="text-muted-foreground hover:text-foreground cursor-pointer">
                    <ArrowLeft className="h-5 w-5" />
                </Link>
                <h1 className="text-xl font-semibold">Trashbin</h1>
            </header>

            <main className="flex-1 overflow-auto p-6 space-y-8">
                {isLoadingSpaces ? (
                    <div className="flex items-center justify-center p-8">
                        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                ) : (
                    <>
                         {(!spaces || spaces.length === 0) && (
                            <div className="flex flex-col items-center justify-center p-12 text-muted-foreground">
                                <Archive className="h-12 w-12 mb-4 opacity-50" />
                                <p>You are not a member of any spaces.</p>
                            </div>
                        )}

                        {spaces?.map(space => (
                            <TrashSpaceSection key={space.id} space={space} />
                        ))}
                    </>
                )}
            </main>
        </div>
    );
}

function TrashSpaceSection({ space }: { space: Space }) {
    const { user } = useAuth();
    const queryClient = useQueryClient();
    const [documentToDelete, setDocumentToDelete] = useState<string | null>(null);

    const { data: documents, isLoading, error } = useQuery({
        queryKey: ["deleted-documents", space.id],
        queryFn: () => getDeletedDocuments(space.id),
    });

    const { mutate: restore, isPending: isRestoring } = useMutation({
        mutationFn: restoreDocument,
        onSuccess: () => {
             queryClient.invalidateQueries({ queryKey: ["deleted-documents", space.id] });
             queryClient.invalidateQueries({ queryKey: ["sidebar-tree", space.id] });
        },
    });

    const { mutate: removeForever, isPending: isDeleting } = useMutation({
        mutationFn: permanentlyDeleteDocument,
        onSuccess: () => {
             queryClient.invalidateQueries({ queryKey: ["deleted-documents", space.id] });
             setDocumentToDelete(null);
        },
    });

    if (isLoading) {
        return (
            <div className="rounded-md border p-6">
                 <h2 className="text-lg font-semibold mb-4">{space.name}</h2>
                 <div className="flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            </div>
        )
    }

    if (error) return null;

    if (!documents || documents.length === 0) {
        return null; 
    }

    return (
        <div className="rounded-md border bg-card">
            <div className="border-b px-4 py-3 bg-muted/30">
                 <h2 className="font-semibold flex items-center gap-2">
                    {space.name}
                    <span className="text-xs font-normal text-muted-foreground bg-muted px-2 py-0.5 rounded-full border">
                         {documents.length}
                    </span>
                 </h2>
            </div>
            
             <div className="divide-y text-start">
                 <div className="grid grid-cols-12 gap-4 p-4 font-medium text-sm text-muted-foreground bg-muted/10">
                    <div className="col-span-12 md:col-span-5">Name</div>
                    <div className="col-span-3 md:block hidden">Deleted By</div>
                    <div className="col-span-2 md:block hidden">Deleted At</div>
                    <div className="col-span-2 text-right">Actions</div>
                </div>

                {documents.map((doc) => (
                    <div key={doc.id} className="grid grid-cols-12 gap-4 p-4 items-center text-sm hover:bg-muted/30 transition-colors">
                        <div className="col-span-12 md:col-span-5 font-medium flex items-center gap-2 truncate">
                            <span className="truncate">{doc.title}</span>
                        </div>
                        <div className="col-span-3 md:block hidden truncate text-muted-foreground">
                            {doc.deletedBy === user?.uid ? "Me" : (doc.deletedBy || "Unknown")}
                        </div>
                        <div className="col-span-2 md:block hidden text-muted-foreground">
                            {doc.deletedAt ? format(doc.deletedAt.toDate(), "MMM d, yyyy") : "-"}
                        </div>
                        <div className="col-span-2 flex items-center justify-end gap-2 ml-auto">
                            <button 
                                onClick={() => restore(doc.id)}
                                disabled={isRestoring || isDeleting}
                                className="p-2 hover:bg-green-100 dark:hover:bg-green-900/30 rounded text-green-600 hover:text-green-700 transition-colors cursor-pointer"
                                title="Restore"
                            >
                                <RefreshCw className="h-4 w-4" />
                            </button>
                            <button 
                                onClick={() => setDocumentToDelete(doc.id)}
                                disabled={isRestoring || isDeleting}
                                className="p-2 hover:bg-red-100 dark:hover:bg-red-900/30 rounded text-destructive hover:text-red-700 transition-colors cursor-pointer"
                                title="Delete Forever"
                            >
                                <Trash2 className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                ))}
             </div>

             <AlertDialog
                isOpen={!!documentToDelete}
                onClose={() => setDocumentToDelete(null)}
                title="Permanently Delete Document"
                description="Are you sure you want to permanently delete this document? This action cannot be undone and will delete all attached images."
                onAction={() => documentToDelete && removeForever(documentToDelete)}
                variant="destructive"
                actionLabel="Delete Forever"
            />
        </div>
    );
}
