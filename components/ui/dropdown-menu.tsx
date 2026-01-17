"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface DropdownMenuContextType {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const DropdownMenuContext = React.createContext<DropdownMenuContextType | undefined>(undefined);

export function DropdownMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <DropdownMenuContext.Provider value={{ open, setOpen }}>
      <div className="relative inline-block text-left" ref={containerRef}>
        {children}
      </div>
    </DropdownMenuContext.Provider>
  );
}

export function DropdownMenuTrigger({ asChild, children }: { asChild?: boolean; children: React.ReactNode }) {
  const context = React.useContext(DropdownMenuContext);
  if (!context) throw new Error("DropdownMenuTrigger must be used within DropdownMenu");

  const child = asChild ? React.Children.only(children) as React.ReactElement : null;

  if (asChild && React.isValidElement(child)) {
      return React.cloneElement(child as React.ReactElement<any>, {
          onClick: (e: React.MouseEvent) => {
              (child as React.ReactElement<any>).props.onClick?.(e);
              context.setOpen(!context.open);
          }
      });
  }

  return (
    <button onClick={() => context.setOpen(!context.open)}>
      {children}
    </button>
  );
}

export function DropdownMenuContent({ 
    align = "center", 
    children, 
    className 
}: { 
    align?: "start" | "end" | "center"; 
    children: React.ReactNode; 
    className?: string 
}) {
  const context = React.useContext(DropdownMenuContext);
  if (!context) throw new Error("DropdownMenuContent must be used within DropdownMenu");

  if (!context.open) return null;

  const alignStyles = {
      start: "left-0",
      end: "right-0",
      center: "left-1/2 -translate-x-1/2"
  };

  return (
    <div className={cn(
        "absolute z-50 mt-2 min-w-32 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95",
        alignStyles[align],
        className
    )}>
      {children}
    </div>
  );
}

export function DropdownMenuItem({ 
    children, 
    onClick, 
    className 
}: { 
    children: React.ReactNode; 
    onClick?: (e: React.MouseEvent) => void; 
    className?: string 
}) {
    const context = React.useContext(DropdownMenuContext);

    return (
        <div 
            className={cn(
                "relative flex select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 cursor-pointer",
                className
            )}
            onClick={(e) => {
                onClick?.(e);
                context?.setOpen(false);
            }}
        >
            {children}
        </div>
    );
}
