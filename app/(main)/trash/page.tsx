"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getDeletedDocuments, restoreDocument, permanentlyDeleteDocument } from "@/lib/actions/document";
import { getSpacesForUser, getDeletedSpacesForUser, restoreSpace, permanentlyDeleteSpace } from "@/lib/actions/spaces";
import { format } from "date-fns";
import { Loader2, RefreshCw, Trash2, ArrowLeft, Archive } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import Link from "next/link";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { useState, useRef, useEffect } from "react";
import { Space } from "@/lib/types";
import { calculateListFallback } from "@/lib/focus-fallback";
import { useToast } from "@/components/ui/use-toast";

export default function TrashbinPage() {
    const { user } = useAuth();
    const headerBackRef = useRef<HTMLAnchorElement | null>(null);
    const mainRef = useRef<HTMLDivElement | null>(null);

    const { data: spaces, isLoading: isLoadingSpaces } = useQuery({
        queryKey: ["user-spaces", user?.uid],
        queryFn: () => user ? getSpacesForUser(user.uid) : Promise.resolve([]),
        enabled: !!user,
    });

    const { data: deletedSpaces, isLoading: isLoadingDeletedSpaces } = useQuery({
        queryKey: ["deleted-spaces", user?.uid],
        queryFn: () => user ? getDeletedSpacesForUser(user.uid) : Promise.resolve([]),
        enabled: !!user,
    });

    return (
        <div className="flex flex-col h-full bg-background">
            <header className="flex items-center gap-4 border-b px-6 py-4">
                <Link
                    ref={headerBackRef}
                    href="/"
                    className="text-muted-foreground hover:text-foreground cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <ArrowLeft className="h-5 w-5" />
                </Link>
                <h1 className="text-xl font-semibold">Trashbin</h1>
            </header>

            <div
                ref={mainRef}
                tabIndex={-1}
                className="flex-1 overflow-auto p-6 space-y-8 outline-none"
            >
                {(isLoadingSpaces || isLoadingDeletedSpaces) ? (
                    <div className="flex items-center justify-center p-8">
                        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                ) : (
                    <>
                        <DeletedSpacesSection
                            deletedSpaces={deletedSpaces ?? []}
                            currentUserId={user?.uid}
                            headerBackRef={headerBackRef}
                            mainRef={mainRef}
                        />

                        {(!spaces || spaces.length === 0) && (!deletedSpaces || deletedSpaces.length === 0) && (
                            <div className="flex flex-col items-center justify-center p-12 text-muted-foreground">
                                <Archive className="h-12 w-12 mb-4" />
                                <p>Trash is empty.</p>
                            </div>
                        )}

                        {spaces && spaces.length > 0 && (
                            <div className="space-y-4">
                                <h2 className="text-xl font-semibold px-1">Deleted Documents</h2>
                                {spaces.map(space => (
                                    <TrashSpaceSection
                                        key={space.id}
                                        space={space}
                                        headerBackRef={headerBackRef}
                                        mainRef={mainRef}
                                    />
                                ))}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

function TrashSpaceSection({
    space,
    headerBackRef,
    mainRef,
}: {
    space: Space;
    headerBackRef: React.RefObject<HTMLAnchorElement | null>;
    mainRef: React.RefObject<HTMLDivElement | null>;
}) {
    const { user } = useAuth();
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const [documentToDelete, setDocumentToDelete] = useState<string | null>(null);
    const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
    const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
    const returnFocusRef = useRef<HTMLElement | null>(null);
    const actionReturnFocusRef = useRef<HTMLElement | null>(null);
    const isPointerRestoreRef = useRef(false);
    const pendingRestoreRef = useRef<{ targetId: string | null; isPointer: boolean } | null>(null);

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
        onError: (err: unknown) => {
             pendingRestoreRef.current = null;
             const message = err instanceof Error ? err.message : "";
             if (message.includes("pending permanent deletion")) {
                 toast({
                     title: "Cannot restore document",
                     description: "This document is pending permanent deletion and cannot be restored.",
                     variant: "destructive",
                 });
             } else {
                 toast({
                     title: "Error",
                     description: "Failed to restore document. Please try again.",
                     variant: "destructive",
                 });
             }
        },
    });

    const { mutate: removeForever, isPending: isDeleting } = useMutation({
        mutationFn: (docId: string) => permanentlyDeleteDocument(space.id, docId),
        onSuccess: () => {
             queryClient.invalidateQueries({ queryKey: ["deleted-documents", space.id] });
             setDocumentToDelete(null);
        },
        onError: (err: unknown) => {
             const message = err instanceof Error ? err.message : "";
             if (message.includes("subdocuments")) {
                 toast({
                     title: "Cannot delete document",
                     description: "This document still contains subdocuments. Permanently delete the subdocuments first.",
                     variant: "destructive",
                 });
             } else {
                 toast({
                     title: "Error",
                     description: "Failed to permanently delete document. Please try again.",
                     variant: "destructive",
                 });
             }
             setDocumentToDelete(null);
        },
    });

    const handleDeleteClick = (docId: string) => {
        if (isDeleting) return;
        const trigger = triggerRefs.current.get(docId);
        returnFocusRef.current = trigger || null;

        const fallback = calculateListFallback(documents || [], docId);
        let fallbackEl: HTMLElement | null = null;
        if (fallback.type === "item") {
            fallbackEl = rowRefs.current.get(fallback.id) || null;
        }
        if (!fallbackEl || !fallbackEl.isConnected) {
            fallbackEl = headerBackRef.current || mainRef.current;
        }
        actionReturnFocusRef.current = fallbackEl;
        setDocumentToDelete(docId);
    };

    const handleRestoreClick = (docId: string) => {
        const fallback = calculateListFallback(documents || [], docId);
        pendingRestoreRef.current = {
            targetId: fallback.type === "item" ? fallback.id : null,
            isPointer: isPointerRestoreRef.current,
        };
        restore(docId);
    };

    useEffect(() => {
        if (pendingRestoreRef.current) {
            const { targetId, isPointer } = pendingRestoreRef.current;
            pendingRestoreRef.current = null;

            let targetEl: HTMLElement | null = null;
            if (targetId) {
                targetEl = rowRefs.current.get(targetId) || null;
            }
            if (!targetEl || !targetEl.isConnected) {
                targetEl = headerBackRef.current || mainRef.current;
            }

            if (targetEl && targetEl.isConnected) {
                if (isPointer) {
                    targetEl.focus({ focusVisible: false } as FocusOptions);
                } else {
                    targetEl.focus();
                }
            }
        }
    }, [documents, headerBackRef, mainRef]);

    if (isLoading) {
        return (
            <div className="rounded-md border p-6">
                 <h2 className="text-lg font-semibold mb-4">{space.name}</h2>
                 <div className="flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            </div>
        );
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
                    <div
                        key={doc.id}
                        ref={(el) => {
                            if (el) rowRefs.current.set(doc.id, el);
                            else rowRefs.current.delete(doc.id);
                        }}
                        tabIndex={-1}
                        aria-label={`Deleted document: ${doc.title}`}
                        className="grid grid-cols-12 gap-4 p-4 items-center text-sm hover:bg-muted/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
                    >
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
                                type="button"
                                onPointerDown={() => { isPointerRestoreRef.current = true; }}
                                onKeyDown={() => { isPointerRestoreRef.current = false; }}
                                onClick={() => handleRestoreClick(doc.id)}
                                disabled={isRestoring || isDeleting}
                                className="p-2 hover:bg-green-100 dark:hover:bg-green-900/30 rounded text-green-700 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                title="Restore document"
                                aria-label={`Restore document ${doc.title}`}
                            >
                                <RefreshCw className="h-4 w-4" />
                            </button>
                            <button 
                                type="button"
                                ref={(el) => {
                                    if (el) triggerRefs.current.set(doc.id, el);
                                    else triggerRefs.current.delete(doc.id);
                                }}
                                onClick={() => handleDeleteClick(doc.id)}
                                disabled={isRestoring || isDeleting}
                                className="p-2 hover:bg-red-100 dark:hover:bg-red-900/30 rounded text-destructive hover:text-red-800 dark:hover:text-red-400 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                title="Delete permanently"
                                aria-label={`Delete document ${doc.title} permanently`}
                            >
                                <Trash2 className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                ))}
             </div>

             <AlertDialog
                isOpen={!!documentToDelete}
                onClose={() => !isDeleting && setDocumentToDelete(null)}
                title="Permanently Delete Document"
                description="Are you sure you want to permanently delete this document? This action cannot be undone and will delete all attached images."
                onAction={() => !isDeleting && documentToDelete && removeForever(documentToDelete)}
                variant="destructive"
                isLoading={isDeleting}
                actionLabel={isDeleting ? "Deleting..." : "Delete Forever"}
                returnFocusRef={returnFocusRef}
                actionReturnFocusRef={actionReturnFocusRef}
            />
        </div>
    );
}

function DeletedSpacesSection({
    deletedSpaces,
    currentUserId,
    headerBackRef,
    mainRef,
}: {
    deletedSpaces: Space[];
    currentUserId?: string;
    headerBackRef: React.RefObject<HTMLAnchorElement | null>;
    mainRef: React.RefObject<HTMLDivElement | null>;
}) {
    const queryClient = useQueryClient();
    const [spaceToDelete, setSpaceToDelete] = useState<string | null>(null);
    const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
    const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
    const returnFocusRef = useRef<HTMLElement | null>(null);
    const actionReturnFocusRef = useRef<HTMLElement | null>(null);
    const isPointerRestoreRef = useRef(false);
    const pendingRestoreRef = useRef<{ targetId: string | null; isPointer: boolean } | null>(null);

    const { mutate: restore, isPending: isRestoring } = useMutation({
        mutationFn: restoreSpace,
        onSuccess: () => {
             queryClient.invalidateQueries({ queryKey: ["deleted-spaces"] });
             queryClient.invalidateQueries({ queryKey: ["user-spaces"] });
        },
        onError: () => {
             pendingRestoreRef.current = null;
        },
    });

    const { mutate: removeForever, isPending: isDeleting } = useMutation({
        mutationFn: permanentlyDeleteSpace,
        onSuccess: () => {
             queryClient.invalidateQueries({ queryKey: ["deleted-spaces"] });
             setSpaceToDelete(null);
        },
    });

    const handleDeleteClick = (targetSpace: Space) => {
        const trigger = triggerRefs.current.get(targetSpace.id);
        returnFocusRef.current = trigger || null;

        const fallback = calculateListFallback(deletedSpaces, targetSpace.id);
        let fallbackEl: HTMLElement | null = null;
        if (fallback.type === "item") {
            fallbackEl = rowRefs.current.get(fallback.id) || null;
        }
        if (!fallbackEl || !fallbackEl.isConnected) {
            fallbackEl = headerBackRef.current || mainRef.current;
        }
        actionReturnFocusRef.current = fallbackEl;
        setSpaceToDelete(targetSpace.id);
    };

    const handleRestoreClick = (spaceId: string) => {
        const fallback = calculateListFallback(deletedSpaces, spaceId);
        pendingRestoreRef.current = {
            targetId: fallback.type === "item" ? fallback.id : null,
            isPointer: isPointerRestoreRef.current,
        };
        restore(spaceId);
    };

    useEffect(() => {
        if (pendingRestoreRef.current) {
            const { targetId, isPointer } = pendingRestoreRef.current;
            pendingRestoreRef.current = null;

            let targetEl: HTMLElement | null = null;
            if (targetId) {
                targetEl = rowRefs.current.get(targetId) || null;
            }
            if (!targetEl || !targetEl.isConnected) {
                targetEl = headerBackRef.current || mainRef.current;
            }

            if (targetEl && targetEl.isConnected) {
                if (isPointer) {
                    targetEl.focus({ focusVisible: false } as FocusOptions);
                } else {
                    targetEl.focus();
                }
            }
        }
    }, [deletedSpaces, headerBackRef, mainRef]);

    if (deletedSpaces.length === 0) {
        return (
            <AlertDialog
                isOpen={!!spaceToDelete}
                onClose={() => !isDeleting && setSpaceToDelete(null)}
                title="Permanently Delete Space"
                description="Are you sure you want to permanently delete this space? This action cannot be undone and will delete all documents inside it."
                onAction={() => spaceToDelete && removeForever(spaceToDelete)}
                variant="destructive"
                isLoading={isDeleting}
                actionLabel={isDeleting ? "Deleting..." : "Delete Forever"}
                returnFocusRef={returnFocusRef}
                actionReturnFocusRef={actionReturnFocusRef}
            />
        );
    }

    return (
        <div className="space-y-4">
            <h2 className="text-xl font-semibold px-1">Deleted Spaces</h2>
            {deletedSpaces.map((space) => {
                const isOwner = !!currentUserId && space.ownerId === currentUserId;

                return (
                    <div
                        key={space.id}
                        ref={(el) => {
                            if (el) rowRefs.current.set(space.id, el);
                            else rowRefs.current.delete(space.id);
                        }}
                        tabIndex={-1}
                        aria-label={`Deleted space: ${space.name}`}
                        className="rounded-md border bg-card p-4 flex items-center justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <div className="flex flex-col flex-1 min-w-0">
                            <span className="font-medium text-lg truncate">{space.name}</span>
                            <div className="text-sm text-muted-foreground flex gap-2">
                                <span>Deleted {space.deletedAt ? format(space.deletedAt.toDate(), "MMM d, yyyy") : "-"}</span>
                            </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                            {isOwner ? (
                                <>
                                    <button
                                        type="button"
                                        onPointerDown={() => { isPointerRestoreRef.current = true; }}
                                        onKeyDown={() => { isPointerRestoreRef.current = false; }}
                                        onClick={() => handleRestoreClick(space.id)}
                                        disabled={isRestoring || isDeleting}
                                        className="p-2 hover:bg-green-100 dark:hover:bg-green-900/30 rounded text-green-700 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        title="Restore Space"
                                        aria-label={`Restore Space ${space.name}`}
                                    >
                                        <RefreshCw className="h-4 w-4" />
                                    </button>
                                    <button
                                        type="button"
                                        ref={(el) => {
                                            if (el) triggerRefs.current.set(space.id, el);
                                            else triggerRefs.current.delete(space.id);
                                        }}
                                        onClick={() => handleDeleteClick(space)}
                                        disabled={isRestoring || isDeleting}
                                        className="p-2 hover:bg-red-100 dark:hover:bg-red-900/30 rounded text-destructive hover:text-red-800 dark:hover:text-red-400 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        title="Delete permanently"
                                        aria-label={`Delete Space ${space.name} permanently`}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </button>
                                </>
                            ) : (
                                <span className="text-xs text-muted-foreground italic px-2">
                                    Owner only
                                </span>
                            )}
                        </div>
                    </div>
                );
            })}
            <div className="h-px bg-border my-6" />

            <AlertDialog
                isOpen={!!spaceToDelete}
                onClose={() => !isDeleting && setSpaceToDelete(null)}
                title="Permanently Delete Space"
                description="Are you sure you want to permanently delete this space? This action cannot be undone and will delete all documents inside it."
                onAction={() => spaceToDelete && removeForever(spaceToDelete)}
                variant="destructive"
                isLoading={isDeleting}
                actionLabel={isDeleting ? "Deleting..." : "Delete Forever"}
                returnFocusRef={returnFocusRef}
                actionReturnFocusRef={actionReturnFocusRef}
            />
        </div>
    );
}
