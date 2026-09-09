"use client";

import * as React from "react";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { renameSpace, validateSpaceName } from "@/lib/actions/spaces";
import { useToast } from "@/components/ui/use-toast";

interface RenameSpaceDialogProps {
  space: {
    id: string;
    name: string;
  };
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: React.ReactNode;
  /** Ref to the element that should receive focus when the dialog closes. */
  returnFocusRef?: React.MutableRefObject<HTMLButtonElement | null>;
}

function RenameSpaceForm({
  space,
  onClose,
}: {
  space: { id: string; name: string };
  onClose: () => void;
}) {
  const [name, setName] = useState(space?.name || "");
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { mutate, isPending } = useMutation({
    mutationFn: async (newName: string) => {
      return await renameSpace(space.id, newName);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-spaces"] });
      queryClient.invalidateQueries({ queryKey: ["public-spaces"] });
      queryClient.invalidateQueries({ queryKey: ["space", space.id] });
      toast({
        title: "Space renamed",
        description: "The space name has been updated.",
      });
      onClose();
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Failed to rename space.";
      setError(message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const validation = validateSpaceName(name);
    if (!validation.isValid) {
      setError(validation.error || "Space name cannot be empty.");
      return;
    }

    // If unchanged, close gracefully without redundant network write
    if (validation.trimmedName === space.name) {
      onClose();
      return;
    }

    mutate(validation.trimmedName);
  };

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>Rename Space</DialogTitle>
        <DialogDescription>
          Enter a new name for this space.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 py-4">
        <div className="grid gap-2">
          <Label htmlFor="rename-space-name">Name</Label>
          <Input
            id="rename-space-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Space name"
            autoFocus
            disabled={isPending}
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <DialogFooter className="gap-2 sm:gap-0">
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Rename
        </Button>
      </DialogFooter>
    </form>
  );
}

export function RenameSpaceDialog({
  space,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  trigger,
  returnFocusRef,
}: RenameSpaceDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;

  const handleOpenChange = (nextOpen: boolean) => {
    if (isControlled) {
      controlledOnOpenChange?.(nextOpen);
    } else {
      setInternalOpen(nextOpen);
    }
  };

  const handleCloseAutoFocus = (event: Event) => {
    const target = returnFocusRef?.current;

    if (returnFocusRef) {
      returnFocusRef.current = null;
    }

    if (target?.isConnected) {
      event.preventDefault();
      target.focus();
    }
    // Without a custom target, allow Radix to restore focus to its own
    // DialogTrigger when one exists.
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent
        className="sm:max-w-[425px]"
        onCloseAutoFocus={handleCloseAutoFocus}
      >
        {isOpen && (
          <RenameSpaceForm
            space={space}
            onClose={() => handleOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
