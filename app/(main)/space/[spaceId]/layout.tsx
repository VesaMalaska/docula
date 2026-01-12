"use client";

import { useAuth } from "@/components/providers/auth-provider";
import { getSpace } from "@/lib/actions/spaces";
import { Loader2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Space } from "@/lib/types";

export default function SpaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();
  const params = useParams();
  const spaceId = params.spaceId as string;
  const router = useRouter();
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    async function checkAccess() {
      if (loading) return;
      if (!user) {
         // Main layout handles redirect to login, but safe to wait
         return; 
      }

      try {
        const space = await getSpace(spaceId);
        if (!space) {
            // Space doesn't exist
            router.push("/404"); 
            return;
        }

        const hasAccess = space.isPublic || space.userIds.includes(user.uid);
        if (!hasAccess) {
             router.push("/"); // Or some "Access Denied" page
             return;
        }
        
        setIsChecking(false);
      } catch (e) {
        console.error("Error checking space access", e);
        router.push("/");
      }
    }

    checkAccess();
  }, [user, loading, spaceId, router]);

  if (loading || isChecking) {
      return (
        <div className="flex h-full w-full items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      );
  }

  return <>{children}</>;
}
