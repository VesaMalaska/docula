"use client";

import { useAuth } from "@/components/providers/auth-provider";
import { LogOut, User, Moon, Sun, ChevronDown } from "lucide-react";
import { useState } from "react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

export function UserButton() {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const [isOpen, setIsOpen] = useState(false);

  if (!user) return null;

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <button
          className="flex items-center gap-2 rounded-full p-1 hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
          aria-label="Open account menu"
        >
          {user.photoURL ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={user.photoURL}
              alt="User avatar"
              className="w-8 h-8 rounded-full object-cover border border-border"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center border border-border">
              <User className="w-5 h-5 text-primary" />
            </div>
          )}
          <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform duration-200", isOpen && "rotate-180")} />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col space-y-1 font-normal p-2">
          <p className="text-sm font-medium leading-none text-foreground">
              {user.displayName || "User"}
          </p>
          <p className="text-xs leading-none text-muted-foreground truncate">
            {user.email}
          </p>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            setTheme(theme === "light" ? "dark" : "light");
          }}
          className="cursor-pointer gap-3"
        >
          {theme === "dark" ? (
            <>
              <Sun className="h-4 w-4" />
              <span>Light Mode</span>
            </>
          ) : (
            <>
              <Moon className="h-4 w-4" />
              <span>Dark Mode</span>
            </>
          )}
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={() => logout()}
          className="cursor-pointer gap-3 text-destructive focus:bg-destructive/10 focus:text-destructive"
        >
          <LogOut className="h-4 w-4" />
          <span>Logout</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
