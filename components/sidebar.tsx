"use client";


import { Plus, Loader2, X, Trash2, Globe, Lock, MoreHorizontal, Pencil, Upload } from "lucide-react";
import { SidebarTree } from "./sidebar-tree";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { createSpace, getSpacesForUser, getPublicSpaces, joinSpace, deleteSpace } from "@/lib/actions/spaces";
import { RenameSpaceDialog } from "@/components/rename-space-dialog";
import { ImportMarkdownDialog } from "@/components/import-markdown-dialog";
import { Space } from "@/lib/types";
import { createDocument } from "@/lib/actions/document";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/providers/auth-provider";
import { cn } from "@/lib/utils";
import { useState, useRef } from "react";
import { AlertDialog } from "@/components/ui/alert-dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/use-toast";

function PublicSpaceList({ onClose }: { onClose: () => void }) {
    const { user } = useAuth();
    const router = useRouter();
    const queryClient = useQueryClient();

    const { data: spaces, isLoading } = useQuery({
        queryKey: ["public-spaces"],
        queryFn: getPublicSpaces,
    });

    const { mutate: join, isPending } = useMutation({
        mutationFn: (spaceId: string) => {
            if (!user) throw new Error("Not authenticated");
            return joinSpace(spaceId, user.uid);
        },
        onSuccess: (_, spaceId) => {
            queryClient.invalidateQueries({ queryKey: ["user-spaces"] });
            // Also invalidate the specific space queries to ensure UI updates immediately if we stay on same page (though we redirect)
            queryClient.invalidateQueries({ queryKey: ["space", spaceId] });
            onClose();
            router.push(`/space/${spaceId}`);
        },
        onError: (error) => {
            console.error("Failed to join space:", error);
            // Optionally add a toast notification here
        }
    });

    if (isLoading) {
        return <div className="flex justify-center p-4"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
    }

    if (!spaces || spaces.length === 0) {
        return <div className="p-4 text-center text-sm text-muted-foreground">No public spaces found.</div>;
    }

    return (
        <div className="space-y-2 max-h-[300px] overflow-y-auto pr-2">
            {spaces.map(space => (
                <div key={space.id} className="flex items-center justify-between p-2 hover:bg-muted rounded text-sm group">
                    <div className="flex flex-col overflow-hidden">
                        <span className="font-medium truncate">{space.name}</span>
                        {space.description && <span className="text-xs text-muted-foreground truncate">{space.description}</span>}
                    </div>
                    <Button 
                        size="sm" 
                        variant="ghost" 
                        disabled={isPending}
                        onClick={() => join(space.id)}
                    >
                        {isPending ? <Loader2 className="h-4 w-4 animate-spin"/> : "Join"}
                    </Button>
                </div>
            ))}
        </div>
    );
}


interface SidebarProps {
  onClose?: () => void;
}

export function Sidebar({ onClose }: SidebarProps) {
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const spaceId = params?.spaceId as string;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Space Creation State
  const [isCreateSpaceOpen, setIsCreateSpaceOpen] = useState(false);
  const [newSpaceName, setNewSpaceName] = useState("");
  const [newSpaceIsPublic, setNewSpaceIsPublic] = useState(false);
  const [spaceToDelete, setSpaceToDelete] = useState<string | null>(null);
  const [spaceToRename, setSpaceToRename] = useState<Space | null>(null);
  const [spaceToImport, setSpaceToImport] = useState<Space | null>(null);
  const pendingDialogAction = useRef<{ action: "rename" | "import" | "delete"; space: Space } | null>(null);
  const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const renameReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const importReturnFocusRef = useRef<HTMLButtonElement | null>(null);

  // Fetch User Spaces
  const { data: spaces, isLoading: isLoadingSpaces } = useQuery({
      queryKey: ["user-spaces", user?.uid],
      queryFn: () => user ? getSpacesForUser(user.uid) : Promise.resolve([]),
      enabled: !!user,
  });

  const { mutate: createSpc, isPending: isCreatingSpace } = useMutation({
      mutationFn: async () => {
          if (!user) return;
          return await createSpace(newSpaceName, newSpaceIsPublic, "", user.uid);
      },
      onSuccess: (newId) => {
          queryClient.invalidateQueries({ queryKey: ["user-spaces"] });
          setIsCreateSpaceOpen(false);
          setNewSpaceName("");
          setNewSpaceIsPublic(false);
          if (newId) router.push(`/space/${newId}`);
      }
  });

  const { mutate: deleteSpc, isPending: isDeletingSpace } = useMutation({
      mutationFn: async (id: string) => {
          if (!user) return;
          await deleteSpace(id, user.uid);
      },
      onSuccess: (_, deletedSpaceId) => {
          queryClient.invalidateQueries({ queryKey: ["user-spaces"] });
          setSpaceToDelete(null);
          toast({
              title: "Space deleted",
              description: "The space has been moved to the trashbin.",
          });
          // Check if the deleted space is the one we are currently viewing
          if (spaceId && deletedSpaceId === spaceId) {
             router.push("/");
          }
      }
  });


  const { mutate: createDoc, isPending } = useMutation({
    mutationFn: () => createDocument(spaceId, null),
    onSuccess: (newDocId) => {
      queryClient.invalidateQueries({ queryKey: ["sidebar-tree", spaceId] });
      router.push(`/space/${spaceId}/doc/${newDocId}?edit=true`);
      onClose?.();
    },
  });

  return (
    <aside className="flex h-full w-full flex-col border-r border-border bg-muted transition-colors duration-300">
      <div className="flex items-center justify-between p-4 border-b border-border">
        <h1 className="text-xl font-bold text-foreground">Docula</h1>
        <div className="flex items-center gap-1">
             <Dialog open={isCreateSpaceOpen} onOpenChange={setIsCreateSpaceOpen}>
                <DialogTrigger asChild>
                    <button
                        className="rounded p-1 hover:bg-accent hover:text-accent-foreground text-muted-foreground cursor-pointer"
                        title="Add Space"
                    >
                        <Plus className="h-5 w-5" />
                    </button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                        <DialogTitle>Manage Spaces</DialogTitle>
                        <DialogDescription>
                            Create a new space or join an existing public one.
                        </DialogDescription>
                    </DialogHeader>
                    
                    <Tabs defaultValue="create" className="w-full">
                        <TabsList className="grid w-full grid-cols-2">
                            <TabsTrigger value="create">Create New</TabsTrigger>
                            <TabsTrigger value="join">Join Existing</TabsTrigger>
                        </TabsList>
                        
                        <TabsContent value="create" className="space-y-4 py-4">
                            <div className="grid grid-cols-4 items-center gap-4">
                                <Label htmlFor="name" className="text-right">Name</Label>
                                <Input id="name" value={newSpaceName} onChange={e => setNewSpaceName(e.target.value)} className="col-span-3" />
                            </div>
                            <div className="grid grid-cols-4 items-center gap-4">
                                 <Label htmlFor="public" className="text-right">Public</Label>
                                 <div className="flex items-center space-x-2 col-span-3">
                                    <Checkbox id="public" checked={newSpaceIsPublic} onCheckedChange={(c) => setNewSpaceIsPublic(c as boolean)} />
                                    <label
                                        htmlFor="public"
                                        className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                                    >
                                        Allow anyone to join
                                    </label>
                                 </div>
                            </div>
                            <DialogFooter>
                                <Button onClick={() => createSpc()} disabled={isCreatingSpace || !newSpaceName}>
                                    {isCreatingSpace && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                    Create Space
                                </Button>
                            </DialogFooter>
                        </TabsContent>
                        
                        <TabsContent value="join" className="py-4">
                            <PublicSpaceList onClose={() => setIsCreateSpaceOpen(false)} />
                        </TabsContent>
                    </Tabs>
                </DialogContent>
            </Dialog>

            <button
                onClick={onClose}
                className="p-1 lg:hidden text-muted-foreground hover:text-foreground cursor-pointer"
            >
                <X className="h-5 w-5" />
            </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-4" onClick={(e) => {
          if ((e.target as HTMLElement).closest('a')) {
              onClose?.();
          }
      }}>
        {isLoadingSpaces ? (
            <div className="flex items-center justify-center p-4">
                 <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
        ) : (
            <div className="space-y-4 px-2">
                {spaces?.map(space => {
                    const isSpaceActive = space.id === spaceId;
                    return (
                        <div key={space.id} className="space-y-1">
                             <div className={cn(
                                 "group flex items-center justify-between rounded-md px-2 py-1.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
                                 isSpaceActive ? "bg-accent text-accent-foreground" : "text-muted-foreground"
                             )}>
                                <Link href={`/space/${space.id}`} className="flex-1 flex items-center gap-2 truncate">
                                    {space.isPublic ? <Globe className="h-4 w-4"/> : <Lock className="h-4 w-4"/>}
                                    <span className="truncate">{space.name}</span>
                                </Link>
                                
                                {isSpaceActive && (
                                    <div className="flex items-center gap-1">
                                        <button
                                            onClick={() => createDoc()}
                                            disabled={isPending}
                                            className="text-muted-foreground hover:text-foreground p-0.5 rounded hover:bg-background cursor-pointer"
                                            title="New Document"
                                        >
                                            {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin"/> : <Plus className="h-3.5 w-3.5"/>}
                                        </button>
                                         <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <button 
                                                    type="button"
                                                    ref={(el) => {
                                                        if (el) triggerRefs.current.set(space.id, el);
                                                        else triggerRefs.current.delete(space.id);
                                                    }}
                                                    className="text-muted-foreground hover:text-foreground p-0.5 rounded hover:bg-background cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                    title="Space Settings"
                                                    aria-label="Space actions"
                                                >
                                                    <MoreHorizontal className="h-3.5 w-3.5" />
                                                </button>
                                            </DropdownMenuTrigger>
                                             <DropdownMenuContent
                                                 align="end"
                                                 className="w-56"
                                                 onCloseAutoFocus={(e) => {
                                                     const pendingAction = pendingDialogAction.current;
                                                     if (pendingAction) {
                                                         pendingDialogAction.current = null;
                                                         const { action, space: targetSpace } = pendingAction;

                                                         const trigger = triggerRefs.current.get(targetSpace.id);
                                                         if (trigger && trigger.isConnected) {
                                                             e.preventDefault();
                                                             trigger.focus();
                                                             if (action === "rename") {
                                                                 renameReturnFocusRef.current = trigger;
                                                             } else if (action === "import") {
                                                                 importReturnFocusRef.current = trigger;
                                                             }
                                                         }

                                                         if (action === "rename") setSpaceToRename(targetSpace);
                                                         else if (action === "import") setSpaceToImport(targetSpace);
                                                         else if (action === "delete") setSpaceToDelete(targetSpace.id);
                                                     }
                                                 }}
                                             >
                                                 <DropdownMenuItem 
                                                     onSelect={(e) => {
                                                         e.stopPropagation();
                                                         pendingDialogAction.current = { action: "rename", space };
                                                     }}
                                                     className="cursor-pointer"
                                                 >
                                                     <Pencil className="mr-2 h-4 w-4" />
                                                     <span>Rename Space</span>
                                                 </DropdownMenuItem>
                                                 <DropdownMenuItem 
                                                     onSelect={(e) => {
                                                         e.stopPropagation();
                                                         pendingDialogAction.current = { action: "import", space };
                                                     }}
                                                     className="cursor-pointer"
                                                 >
                                                     <Upload className="mr-2 h-4 w-4" />
                                                     <span>Import Markdown document…</span>
                                                 </DropdownMenuItem>
                                                 <DropdownMenuSeparator />
                                                 <DropdownMenuItem 
                                                     onSelect={(e) => {
                                                         e.stopPropagation();
                                                         pendingDialogAction.current = { action: "delete", space };
                                                     }}
                                                     className="text-destructive focus:text-destructive cursor-pointer"
                                                 >
                                                     <Trash2 className="mr-2 h-4 w-4" />
                                                     <span>Delete Space</span>
                                                 </DropdownMenuItem>
                                             </DropdownMenuContent>
                                        </DropdownMenu>
                                    </div>
                                )}
                             </div>
                             
                             {/* Only show tree if space is active */}
                             {isSpaceActive && (
                                 <div className="pl-2 border-l border-border/50 ml-2">
                                     <SidebarTree spaceId={space.id} />
                                 </div>
                             )}
                        </div>
                    )
                })}

                {spaces?.length === 0 && (
                     <div className="px-2 text-sm text-muted-foreground text-center py-4">
                        No spaces found. Create one to get started!
                     </div>
                )}
            </div>
        )}
      </div>

      <div className="p-4 border-t border-border bg-background/50">
        <div className="mt-0">
             <Link 
                href="/trash"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer translation-colors"
                onClick={onClose}
             >
                <Trash2 className="h-4 w-4" />
                Trashbin
            </Link>
        </div>
      </div>
      
       <AlertDialog
            isOpen={!!spaceToDelete}
            onClose={() => setSpaceToDelete(null)}
            title="Delete Space"
            description="Are you sure you want to delete this space? You can restore it from the trashbin later."
            onAction={() => spaceToDelete && deleteSpc(spaceToDelete)}
            variant="destructive"
            actionLabel={isDeletingSpace ? "Deleting..." : "Delete Space"}
        />

       {spaceToRename && (
            <RenameSpaceDialog
                space={spaceToRename}
                open={!!spaceToRename}
                onOpenChange={(open) => {
                    if (!open) {
                        setSpaceToRename(null);
                    }
                }}
                returnFocusRef={renameReturnFocusRef}
            />
        )}

       {spaceToImport && (
            <ImportMarkdownDialog
                isOpen={!!spaceToImport}
                onClose={() => setSpaceToImport(null)}
                spaceId={spaceToImport.id}
                parentId={null}
                destinationName={spaceToImport.name}
                isSpaceRoot={true}
                onSuccess={() => onClose?.()}
                returnFocusRef={importReturnFocusRef}
            />
        )}
    </aside>
  );
}
