"use client";

import { usePathname } from "next/navigation";
import { UnavailableState } from "@/components/unavailable-state";

export default function MainNotFound() {
  const pathname = usePathname();
  const isDocument = Boolean(pathname?.includes("/doc/"));

  return (
    <div className="w-full h-full flex items-center justify-center p-4">
      <UnavailableState type={isDocument ? "document" : "space"} />
    </div>
  );
}
