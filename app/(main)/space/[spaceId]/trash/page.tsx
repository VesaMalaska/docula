"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getDeletedDocuments, restoreDocument, permanentlyDeleteDocument } from "@/lib/actions/document";
import { format } from "date-fns";
import { Loader2, RefreshCw, Trash2, ArrowLeft } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import Link from "next/link";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { useState } from "react";
import { useParams } from "next/navigation";


export default function TrashbinPage() {
    const { user } = useAuth();
    const params = useParams();
    const spaceId = params.spaceId as string;
    const queryClient = useQueryClient();
    const [documentToDelete, setDocumentToDelete] = useState<string | null>(null);

    const { data: documents, isLoading, error } = useQuery({
        queryKey: ["deleted-documents", spaceId],
        queryFn: () => getDeletedDocuments(spaceId),
        enabled: !!spaceId
    });

    if (error) {
        console.error("Trashbin query error:", error);
    }

    const { mutate: restore, isPending: isRestoring } = useMutation({
        mutationFn: restoreDocument,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["deleted-documents", spaceId] });
            queryClient.invalidateQueries({ queryKey: ["sidebar-tree", spaceId] });
        },
    });

    const { mutate: removeForever, isPending: isDeleting } = useMutation({
        mutationFn: permanentlyDeleteDocument,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["deleted-documents", spaceId] });
            setDocumentToDelete(null);
        },
    });

    if (isLoading) {
        return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin" /></div>;
    }

    return (
        <div className="flex flex-col h-full bg-background">
            <header className="flex items-center gap-4 border-b px-6 py-4">
                <Link href={`/space/${spaceId}`} className="text-muted-foreground hover:text-foreground cursor-pointer">
                    <ArrowLeft className="h-5 w-5" />
                </Link>
                <h1 className="text-xl font-semibold">Trashbin</h1>
            </header>

            <main className="flex-1 overflow-auto p-6">
                <div className="rounded-md border">
                    <div className="grid grid-cols-12 gap-4 border-b bg-muted/50 p-4 font-medium text-sm">
                        <div className="col-span-12 md:col-span-5">Name</div>
                        <div className="col-span-3 md:block hidden">Deleted By</div>
                        <div className="col-span-2 md:block hidden">Deleted At</div>
                        <div className="col-span-2 text-right">Actions</div>
                    </div>
                    
                    {error && (
                        <div className="p-4 text-sm text-destructive bg-destructive/10 border-b border-destructive/20">
                            Error loading trash: {(error as Error).message}
                        </div>
                    )}
                    
                    {documents?.length === 0 ? (
                        <div className="flex flex-col items-center justify-center p-8 text-muted-foreground">
                            <Trash2 className="h-8 w-8 mb-2 opacity-50" />
                            <p>Trash is empty</p>
                        </div>
                    ) : (
                        documents?.map((doc) => (
                            <div key={doc.id} className="grid grid-cols-12 gap-4 border-b p-4 items-center text-sm last:border-0 hover:bg-muted/50">
                                <div className="col-span-5 font-medium flex items-center gap-2 truncate">
                                    <span className="truncate">{doc.title}</span>
                                </div>
                                <div className="col-span-3 truncate text-muted-foreground">
                                    {doc.deletedBy === user?.uid ? "Me" : (doc.deletedBy || "Unknown")}
                                </div>
                                <div className="col-span-2 text-muted-foreground">
                                    {doc.deletedAt ? format(doc.deletedAt.toDate(), "MMM d, yyyy") : "-"}
                                </div>
                                <div className="col-span-2 flex items-center justify-end gap-2">
                                    <button 
                                        onClick={() => restore(doc.id)}
                                        disabled={isRestoring || isDeleting}
                                        className="p-2 hover:bg-muted rounded text-green-600 hover:text-green-700 transition-colors cursor-pointer"
                                        title="Restore"
                                    >
                                        <RefreshCw className="h-4 w-4" />
                                    </button>
                                    <button 
                                        onClick={() => setDocumentToDelete(doc.id)}
                                        disabled={isRestoring || isDeleting}
                                        className="p-2 hover:bg-muted rounded text-destructive hover:text-red-700 transition-colors cursor-pointer"
                                        title="Delete Forever"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </main>

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
