"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface AlertDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description: string;
  actionLabel?: string;
  cancelLabel?: string;
  onAction?: () => void;
  variant?: "default" | "destructive";
  /** Whether an asynchronous operation triggered by the dialog action is in progress. */
  isLoading?: boolean;
  /** Ref to the element that should receive focus when the dialog closes. */
  returnFocusRef?: React.MutableRefObject<HTMLElement | null>;
  /** Optional ref to the element that should receive focus when the action is confirmed. */
  actionReturnFocusRef?: React.MutableRefObject<HTMLElement | null>;
}

export function AlertDialog({
  isOpen,
  onClose,
  title,
  description,
  actionLabel = "OK",
  cancelLabel = "Cancel",
  onAction,
  variant = "default",
  isLoading,
  returnFocusRef,
  actionReturnFocusRef,
}: AlertDialogProps) {
  const isPointerInteractionRef = React.useRef(false);
  const isSubmittingRef = React.useRef(false);

  React.useEffect(() => {
    if (!isOpen) {
      isSubmittingRef.current = false;
    }
  }, [isOpen]);

  const handleOpenChange = (open: boolean) => {
    if (!open && !isLoading) {
      onClose();
    }
  };

  const handleCloseAutoFocus = (event: Event) => {
    const target = returnFocusRef?.current;
    const isPointer = isPointerInteractionRef.current;
    isPointerInteractionRef.current = false;

    if (returnFocusRef) {
      returnFocusRef.current = null;
    }

    if (actionReturnFocusRef) {
      actionReturnFocusRef.current = null;
    }

    if (target?.isConnected) {
      event.preventDefault();
      if (isPointer) {
        target.focus({ focusVisible: false } as FocusOptions);
      } else {
        target.focus();
      }
    }
    // Without a custom target, allow Radix to restore focus to its own
    // DialogTrigger when one exists.
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        role="alertdialog"
        className="sm:max-w-md"
        onCloseAutoFocus={handleCloseAutoFocus}
        onPointerDown={() => {
          isPointerInteractionRef.current = true;
        }}
        onPointerDownOutside={() => {
          isPointerInteractionRef.current = true;
        }}
        onKeyDown={() => {
          isPointerInteractionRef.current = false;
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <DialogFooter className="gap-2 sm:gap-2">
          {onAction ? (
            <>
              <Button
                type="button"
                variant="ghost"
                disabled={isLoading}
                onClick={onClose}
              >
                {cancelLabel}
              </Button>
              <Button
                type="button"
                variant={variant === "destructive" ? "destructive" : "default"}
                disabled={isLoading}
                onClick={() => {
                  if (isLoading || isSubmittingRef.current) return;
                  isSubmittingRef.current = true;
                  if (actionReturnFocusRef?.current) {
                    if (returnFocusRef) {
                      returnFocusRef.current = actionReturnFocusRef.current;
                    }
                  } else if (returnFocusRef) {
                    returnFocusRef.current = null;
                  }
                  onAction?.();
                  if (isLoading === undefined) {
                    onClose();
                  }
                }}
              >
                {actionLabel}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              disabled={isLoading}
              onClick={onClose}
            >
              {actionLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
