"use client";

import React, { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

interface AlertDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  variant?: "default" | "destructive";
}

export function AlertDialog({
  isOpen,
  onClose,
  title,
  description,
  actionLabel = "OK",
  onAction,
  variant = "default",
}: AlertDialogProps) {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "unset";
    }
    return () => {
      document.body.style.overflow = "unset";
    };
  }, [isOpen]);

  if (!isMounted || !isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      {/* Overlay */}
      <div 
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200" 
        onClick={onClose}
      />
      
      {/* Dialog Content */}
      <div 
        className={cn(
          "relative w-full max-w-md scale-100 rounded-xl border border-border bg-background p-6 shadow-2xl animate-in zoom-in-95 fade-in duration-200",
          "flex flex-col gap-4"
        )}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="alert-dialog-title"
        aria-describedby="alert-dialog-description"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="alert-dialog-title" className="text-xl font-semibold tracking-tight">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p id="alert-dialog-description" className="text-sm text-muted-foreground leading-relaxed">
          {description}
        </p>

        <div className="mt-2 flex justify-end gap-3">
          <button
            onClick={() => {
              onAction?.();
              onClose();
            }}
            className={cn(
              "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 shadow-sm",
              variant === "destructive" 
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" 
                : "bg-primary text-primary-foreground hover:bg-primary/90"
            )}
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
