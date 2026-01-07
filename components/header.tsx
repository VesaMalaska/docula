"use client";

import { useAuth } from "@/components/providers/auth-provider";
import { Menu } from "lucide-react";
import { UserButton } from "./user-button";
import { cn } from "@/lib/utils";

interface HeaderProps {
  onMenuClick: () => void;
  className?: string;
}

export function Header({ onMenuClick, className }: HeaderProps) {
  const { user, logout } = useAuth();

  return (
    <header className={cn("flex h-14 items-center justify-between border-b border-border bg-background px-4 shrink-0", className)}>
      <div className="flex items-center gap-2">
        <button
          onClick={onMenuClick}
          className="p-2 -ml-2 text-muted-foreground hover:text-foreground lg:hidden cursor-pointer"
        >
          <Menu className="h-6 w-6" />
        </button>
        {/* Helper span for mobile branding if needed, though Layout usually handles 'Docula' title. 
            However, moving the header out of Layout's generic header tag into this component 
            means we should probably include the Title here if we want it visible at all times 
            or just on mobile. The previous Layout had 'Docula' next to the menu button.
        */}
        <span className="font-bold text-foreground lg:hidden">Docula</span>
      </div>

      <div className="flex items-center gap-2 ml-auto">
        <UserButton />
      </div>
    </header>
  );
}
