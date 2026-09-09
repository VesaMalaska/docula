"use client";

import { useAuth } from "@/components/providers/auth-provider";
import { getSpace } from "@/lib/actions/spaces";
import { isSpaceAccessible } from "@/lib/member-management";
import { Loader2 } from "lucide-react";
import { useParams, notFound } from "next/navigation";
import { useEffect, useState } from "react";

export default function SpaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();
  const params = useParams();
  const spaceId = params.spaceId as string;
  const [isChecking, setIsChecking] = useState(true);
  const [isUnavailable, setIsUnavailable] = useState(false);

  useEffect(() => {
    async function checkAccess() {
      if (loading) return;
      if (!user) {
        // Main layout handles redirect to login, but safe to wait
        return;
      }

      try {
        const space = await getSpace(spaceId);
        if (!isSpaceAccessible(space, user.uid)) {
          setIsUnavailable(true);
          setIsChecking(false);
          return;
        }

        setIsChecking(false);
      } catch {
        // Space was permanently deleted, does not exist, or caller lacks access
        setIsUnavailable(true);
        setIsChecking(false);
      }
    }

    checkAccess();
  }, [user, loading, spaceId]);

  if (loading || isChecking) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isUnavailable) {
    notFound();
  }

  return <>{children}</>;
}
