"use client";

import { getSidebarTree } from "@/lib/actions/document";
import { getSpace } from "@/lib/actions/spaces";
import { useRouter, useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Space, SidebarNode } from "@/lib/types";
import { Loader2, Users, FileText, Plus, ShieldCheck } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { InviteMemberDialog } from "@/components/invite-member-dialog";

export default function SpacePage() {
  const params = useParams();
  const spaceId = params.spaceId as string;
  const { user } = useAuth();
  
  const [space, setSpace] = useState<Space | null>(null);
  const [docs, setDocs] = useState<SidebarNode[]>([]);
  const [members, setMembers] = useState<{uid: string, email: string, displayName: string}[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
        if (!user) return;
        try {
            const s = await getSpace(spaceId);
            if (!s) return;
            setSpace(s);

            const tree = await getSidebarTree(spaceId);
            setDocs(tree);

            // Fetch members
            const memberData = await Promise.all(s.userIds.map(async (uid) => {
                const snap = await getDoc(doc(db, "users", uid));
                if (snap.exists()) {
                    return snap.data() as {uid: string, email: string, displayName: string};
                }
                return { uid, email: "Unknown", displayName: "Unknown User" };
            }));
            setMembers(memberData);

        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    }
    load();
  }, [spaceId, user]);


  if (loading) {
      return <div className="flex h-full items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  if (!space) {
      return <div className="flex h-full items-center justify-center text-muted-foreground">Space not found</div>;
  }

  return (
    <div className="mx-auto max-w-4xl p-8">
      <div className="flex items-start justify-between mb-8 border-b pb-6 dark:border-zinc-800">
          <div>
            <h1 className="text-4xl font-bold mb-2">{space.name}</h1>
            <p className="text-muted-foreground text-lg">{space.description || "No description provided."}</p>
            <div className="flex items-center gap-2 mt-4 text-sm text-gray-500">
                <span className="flex items-center gap-1 bg-secondary px-2 py-1 rounded">
                    {space.isPublic ? "Public Space" : "Private Space"}
                </span>
                <span>•</span>
                <span>Created {space.createdAt?.toDate().toLocaleDateString()}</span>
            </div>
          </div>
          
          <div className="flex gap-2">
              <InviteMemberDialog spaceId={space.id} currentMembers={space.userIds} />
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
                   {/* Simplified Recursive List could go here, but flat list of top level is fine for now */}
                   {docs.map(node => (
                       <Link key={node.id} href={`/space/${spaceId}/doc/${node.id}`}>
                           <div className="p-4 rounded-lg border hover:bg-muted/50 transition-colors flex items-center justify-between">
                               <span className="font-medium">{node.title}</span>
                               <span className="text-xs text-muted-foreground">
                                   {node.children && node.children.length > 0 ? `${node.children.length} sub-pages` : ''}
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
             <div className="rounded-lg border bg-card text-card-foreground shadow-sm">
                <div className="p-4 space-y-4">
                    {members.map(m => (
                        <div key={m.uid} className="flex items-center gap-3">
                            <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs uppercase">
                                {m.displayName?.[0] || m.email?.[0] || "?"}
                            </div>
                            <div className="overflow-hidden">
                                <div className="text-sm font-medium truncate">{m.displayName || "User"}</div>
                                <div className="text-xs text-muted-foreground truncate">{m.email}</div>
                            </div>
                            {m.uid === space.ownerId && (
                                <ShieldCheck className="h-3 w-3 text-indigo-500 ml-auto" />
                            )}
                        </div>
                    ))}
                </div>
             </div>
          </div>
      </div>
    </div>
  );
}
