"use client";

import { getSidebarTree } from "@/lib/actions/document";
import { getSpace } from "@/lib/actions/spaces";
import { useRouter, useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Space, SidebarNode } from "@/lib/types";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";

export default function SpacePage() {
  const params = useParams();
  const spaceId = params.spaceId as string;
  const router = useRouter();
  const { user, loading } = useAuth();
  
  const [space, setSpace] = useState<Space | null>(null);
  const [isLoadingSpace, setIsLoadingSpace] = useState(true);

  useEffect(() => {
    async function init() {
        if (loading) return;
        if (!user) {
             setIsLoadingSpace(false);
             return; 
        }

        try {
            const spaceData = await getSpace(spaceId);
            if (!spaceData) {
                // Should be handled by layout, but fallback here
                return;
            }
            setSpace(spaceData);

            // Fetch tree to redirect
            const tree = await getSidebarTree(spaceId);
            if (tree.length > 0) {
                router.replace(`/space/${spaceId}/doc/${tree[0].id}`);
            }
        } catch (e) {
            console.error("Error loading space", e);
        } finally {
            setIsLoadingSpace(false);
        }
    }

    init();
  }, [spaceId, user, loading, router]);


  if (loading || isLoadingSpace) {
      return <div className="flex h-full items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  if (!space) {
      // If layout didn't catch it
      return <div className="flex h-full items-center justify-center text-muted-foreground">Space not found or access denied</div>;
  }

  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
      <h2 className="text-2xl font-bold mb-2">Welcome to {space.name}</h2>
      <p>Create a new document to get started.</p>
    </div>
  );
}
