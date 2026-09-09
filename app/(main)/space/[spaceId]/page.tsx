"use client";

import { getSidebarTree } from "@/lib/actions/document";
import { getSpace, joinSpace, leaveSpace, removeMemberFromSpace } from "@/lib/actions/spaces";
import { useParams, useRouter, notFound } from "next/navigation";
import { Space, SidebarNode } from "@/lib/types";
import { Loader2, Users, FileText, ShieldCheck, Pencil, LogOut, UserMinus, UserPlus } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { InviteMemberDialog } from "@/components/invite-member-dialog";
import { RenameSpaceDialog } from "@/components/rename-space-dialog";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/use-toast";
import { useRef, useState } from "react";
import {
  evictSpaceQueries,
  invalidateSpaceMemberQueries,
  resolveLeaveSpaceError,
  resolveRemoveMemberError,
  resolveJoinSpaceError,
  OWNER_LEAVE_UNAVAILABLE_EXPLANATION,
  shouldShowOwnerLeaveExplanation,
} from "@/lib/member-management";
import { calculateListFallback } from "@/lib/focus-fallback";

export default function SpacePage() {
  const params = useParams();
  const router = useRouter();
  const spaceId = params.spaceId as string;
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [memberToRemove, setMemberToRemove] = useState<{
    uid: string;
    email: string;
    displayName: string;
  } | null>(null);
  const [isLeaveDialogOpen, setIsLeaveDialogOpen] = useState(false);

  const removeButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const removeReturnFocusRef = useRef<HTMLElement | null>(null);
  const removeActionReturnFocusRef = useRef<HTMLElement | null>(null);
  const leaveTriggerRef = useRef<HTMLButtonElement | null>(null);
  const leaveReturnFocusRef = useRef<HTMLElement | null>(null);
  const leaveActionReturnFocusRef = useRef<HTMLElement | null>(null);
  const membersContainerRef = useRef<HTMLDivElement | null>(null);

  const { data: space, isLoading: loadingSpace } = useQuery<Space | null>({
    queryKey: ["space", spaceId],
    queryFn: () => getSpace(spaceId),
    enabled: !!spaceId && !!user,
  });

  const { data: docs = [], isLoading: loadingDocs } = useQuery<SidebarNode[]>({
    queryKey: ["sidebar-tree", spaceId],
    queryFn: () => getSidebarTree(spaceId),
    enabled: !!spaceId && !!user,
  });

  const { data: members = [] } = useQuery<
    { uid: string; email: string; displayName: string }[]
  >({
    queryKey: ["space-members", spaceId, space?.userIds],
    queryFn: async () => {
      if (!space?.userIds) return [];
      return await Promise.all(
        space.userIds.map(async (uid) => {
          const snap = await getDoc(doc(db, "users", uid));
          if (snap.exists()) {
            return snap.data() as { uid: string; email: string; displayName: string };
          }
          return { uid, email: "Unknown", displayName: "Unknown User" };
        })
      );
    },
    enabled: !!space?.userIds,
  });

  const { mutate: removeMember, isPending: isRemovingMember } = useMutation({
    mutationFn: async (target: { uid: string; email: string; displayName: string }) => {
      await removeMemberFromSpace(spaceId, target.uid);
    },
    onSuccess: (_, target) => {
      invalidateSpaceMemberQueries(queryClient, spaceId);
      toast({
        title: "Member removed",
        description: `${target.displayName || target.email} has been removed from the space.`,
      });
      setMemberToRemove(null);
    },
    onError: (err) => {
      const resolved = resolveRemoveMemberError(err);
      toast({
        title: "Error removing member",
        description: resolved.message,
        variant: "destructive",
      });
      setMemberToRemove(null);
    },
  });

  const { mutate: leaveSpc, isPending: isLeavingSpace } = useMutation({
    mutationFn: async () => {
      await leaveSpace(spaceId);
    },
    onSuccess: () => {
      evictSpaceQueries(queryClient, spaceId);
      toast({
        title: "Left space",
        description: `You have left ${space?.name || "the space"}.`,
      });
      setIsLeaveDialogOpen(false);
      router.push("/");
    },
    onError: (err) => {
      const resolved = resolveLeaveSpaceError(err);
      toast({
        title: "Error leaving space",
        description: resolved.message,
        variant: "destructive",
      });
      setIsLeaveDialogOpen(false);
    },
  });

  const { mutate: joinSpc, isPending: isJoiningSpace } = useMutation({
    mutationFn: async () => {
      await joinSpace(spaceId);
    },
    onSuccess: () => {
      invalidateSpaceMemberQueries(queryClient, spaceId);
      toast({
        title: "Joined space",
        description: `You are now a member of ${space?.name || "this space"}.`,
      });
    },
    onError: (err) => {
      const resolved = resolveJoinSpaceError(err);
      toast({
        title: "Error joining space",
        description: resolved.message,
        variant: "destructive",
      });
    },
  });

  const handleOpenRemoveDialog = (m: { uid: string; email: string; displayName: string }) => {
    const trigger = removeButtonRefs.current.get(m.uid);
    removeReturnFocusRef.current = trigger || null;

    const fallback = calculateListFallback(
      members.map((item) => ({ id: item.uid })),
      m.uid
    );
    let fallbackEl: HTMLElement | null = null;
    if (fallback.type === "item") {
      fallbackEl = removeButtonRefs.current.get(fallback.id) || null;
    }
    if (!fallbackEl || !fallbackEl.isConnected) {
      fallbackEl = membersContainerRef.current;
    }
    removeActionReturnFocusRef.current = fallbackEl;
    setMemberToRemove(m);
  };

  const handleOpenLeaveDialog = () => {
    leaveReturnFocusRef.current = leaveTriggerRef.current;
    leaveActionReturnFocusRef.current = null;
    setIsLeaveDialogOpen(true);
  };

  const loading = loadingSpace || loadingDocs;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!space || space.deletedAt) {
    notFound();
  }

  const isOwner = !!user && space.ownerId === user.uid;
  const isMember = !!user && Array.isArray(space.userIds) && space.userIds.includes(user.uid);
  const isMemberOrOwner = isOwner || isMember;
  const canLeave = isMember && !isOwner;
  const showOwnerExplanation = shouldShowOwnerLeaveExplanation({ isOwner, canLeave });

  const formattedDate = space.createdAt?.toDate
    ? space.createdAt.toDate().toLocaleDateString()
    : space.createdAt instanceof Date
    ? space.createdAt.toLocaleDateString()
    : null;

  return (
    <div className="mx-auto max-w-4xl p-8">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-8 border-b pb-6 border-border">
        <div className="space-y-2">
          <h1 className="text-4xl font-bold">{space.name}</h1>
          <p className="text-muted-foreground text-lg">
            {space.description || "No description provided."}
          </p>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="flex items-center gap-1 bg-secondary text-secondary-foreground px-2 py-1 rounded">
              {space.isPublic ? "Public Space" : "Private Space"}
            </span>
            {formattedDate && (
              <>
                <span>•</span>
                <span>Created {formattedDate}</span>
              </>
            )}
          </div>
          {showOwnerExplanation && (
            <div
              data-testid="owner-explanation"
              className="mt-3 rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-foreground/90 max-w-xl"
            >
              {OWNER_LEAVE_UNAVAILABLE_EXPLANATION}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2 shrink-0">
          {isMemberOrOwner && (
            <RenameSpaceDialog
              space={space}
              trigger={
                <Button size="sm" variant="outline" className="gap-2">
                  <Pencil className="h-4 w-4" /> Rename
                </Button>
              }
            />
          )}
          {isMemberOrOwner && <InviteMemberDialog spaceId={space.id} />}
          {canLeave && (
            <Button
              ref={leaveTriggerRef}
              size="sm"
              variant="outline"
              className="gap-2 text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={handleOpenLeaveDialog}
            >
              <LogOut className="h-4 w-4" /> Leave Space
            </Button>
          )}
          {space.isPublic && !isMemberOrOwner && user && (
            <Button
              size="sm"
              variant="default"
              className="gap-2"
              onClick={() => joinSpc()}
              disabled={isJoiningSpace}
            >
              {isJoiningSpace ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UserPlus className="h-4 w-4" />
              )}
              Join Space
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        <div className="md:col-span-2 space-y-6">
          <h2 className="text-2xl font-semibold flex items-center gap-2">
            <FileText className="h-5 w-5" /> Documents
          </h2>

          {docs.length === 0 ? (
            <div className="p-8 border border-dashed rounded-lg text-center text-muted-foreground">
              No documents yet. Create one from the sidebar!
            </div>
          ) : (
            <div className="grid gap-2">
              {docs.map((node) => (
                <Link key={node.id} href={`/space/${spaceId}/doc/${node.id}`}>
                  <div className="p-4 rounded-lg border hover:bg-muted/50 transition-colors flex items-center justify-between">
                    <span className="font-medium">{node.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {node.children && node.children.length > 0
                        ? `${node.children.length} ${
                            node.children.length === 1
                              ? "child document"
                              : "child documents"
                          }`
                        : ""}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-6">
          <h2 className="text-2xl font-semibold flex items-center gap-2">
            <Users className="h-5 w-5" /> Members
          </h2>
          <div
            ref={membersContainerRef}
            tabIndex={-1}
            className="rounded-lg border bg-card text-card-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <div className="p-4 space-y-4">
              {members.map((m) => {
                const isMemberOwner = m.uid === space.ownerId;
                const canRemoveThisMember = isOwner && !isMemberOwner;

                return (
                  <div key={m.uid} className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs uppercase shrink-0">
                      {m.displayName?.[0] || m.email?.[0] || "?"}
                    </div>
                    <div className="overflow-hidden min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">
                        {m.displayName || "User"}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {m.email}
                      </div>
                    </div>
                    {isMemberOwner && (
                      <span className="flex items-center gap-1 text-xs text-indigo-500 font-medium ml-auto shrink-0">
                        <ShieldCheck className="h-3.5 w-3.5" />
                        <span>Owner</span>
                      </span>
                    )}
                    {canRemoveThisMember && (
                      <Button
                        ref={(el) => {
                          if (el) removeButtonRefs.current.set(m.uid, el);
                          else removeButtonRefs.current.delete(m.uid);
                        }}
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10 ml-auto shrink-0 h-8 px-2 gap-1 text-xs"
                        aria-label={`Remove ${m.displayName || m.email} from space`}
                        onClick={() => handleOpenRemoveDialog(m)}
                      >
                        <UserMinus className="h-3.5 w-3.5" />
                        <span>Remove</span>
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {memberToRemove && (
        <AlertDialog
          isOpen={!!memberToRemove}
          onClose={() => !isRemovingMember && setMemberToRemove(null)}
          title="Remove from Space"
          description={
            space.isPublic
              ? `Are you sure you want to remove ${memberToRemove.displayName || memberToRemove.email} from ${space.name}? They will lose contributor access, but can continue to view this public space and re-join later. Their previous contributions will remain intact.`
              : `Are you sure you want to remove ${memberToRemove.displayName || memberToRemove.email} from ${space.name}? They will lose access to this private space and its documents. Their previous contributions will remain intact.`
          }
          actionLabel={isRemovingMember ? "Removing..." : "Remove from Space"}
          variant="destructive"
          isLoading={isRemovingMember}
          onAction={() => memberToRemove && removeMember(memberToRemove)}
          returnFocusRef={removeReturnFocusRef}
          actionReturnFocusRef={removeActionReturnFocusRef}
        />
      )}

      {isLeaveDialogOpen && (
        <AlertDialog
          isOpen={isLeaveDialogOpen}
          onClose={() => !isLeavingSpace && setIsLeaveDialogOpen(false)}
          title="Leave Space"
          description={
            space.isPublic
              ? `Are you sure you want to leave ${space.name}? You will lose contributor access, but you can continue to view this public space and re-join at any time. Your previous contributions will remain intact.`
              : `Are you sure you want to leave ${space.name}? You will lose access to this private space and its documents. Your previous contributions will remain intact.`
          }
          actionLabel={isLeavingSpace ? "Leaving..." : "Leave Space"}
          variant="destructive"
          isLoading={isLeavingSpace}
          onAction={() => leaveSpc()}
          returnFocusRef={leaveReturnFocusRef}
          actionReturnFocusRef={leaveActionReturnFocusRef}
        />
      )}
    </div>
  );
}
