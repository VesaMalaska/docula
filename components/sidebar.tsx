"use client";


import { Plus, Loader2, X, Trash2, LayoutGrid, Globe, Lock, ChevronRight, ChevronDown } from "lucide-react";
import { SidebarTree } from "./sidebar-tree";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { createSpace, getSpacesForUser, getPublicSpaces, joinSpace } from "@/lib/actions/spaces";
import { createDocument } from "@/lib/actions/document";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/providers/auth-provider";
import { cn } from "@/lib/utils";
import { useState } from "react";
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
            onClose();
            router.push(`/space/${spaceId}`);
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

  // Space Creation State
  const [isCreateSpaceOpen, setIsCreateSpaceOpen] = useState(false);
  const [newSpaceName, setNewSpaceName] = useState("");
  const [newSpaceIsPublic, setNewSpaceIsPublic] = useState(false);

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


  const { mutate: createDoc, isPending } = useMutation({
    mutationFn: () => createDocument(spaceId, null),
    onSuccess: (newDocId) => {
      queryClient.invalidateQueries({ queryKey: ["sidebar-tree", spaceId] });
      router.push(`/space/${spaceId}/doc/${newDocId}`);
      onClose?.();
    },
  });

  return (
    <aside className="flex h-full w-64 flex-col border-r border-border bg-muted transition-colors duration-300">
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
                                     <button
                                        onClick={() => createDoc()}
                                        disabled={isPending}
                                        className="text-muted-foreground hover:text-foreground p-0.5 rounded hover:bg-background cursor-pointer"
                                        title="New Document"
                                    >
                                        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin"/> : <Plus className="h-3.5 w-3.5"/>}
                                    </button>
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
                href={spaceId ? `/space/${spaceId}/trash` : "#"}
                className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer translation-colors",
                    !spaceId && "opacity-50 pointer-events-none"
                )}
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
