"use client";

import React, { useState, useRef } from "react";
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
import { Loader2, UserPlus, Check, AlertCircle } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { addMemberToSpace } from "@/lib/actions/spaces";
import {
  validateMemberEmail,
  resolveMemberActionError,
  invalidateSpaceMemberQueries,
  type AddMemberOperationStatus,
  type AddMemberErrorType,
} from "@/lib/member-management";

export interface AddMemberDialogProps {
  spaceId: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: React.ReactNode;
  returnFocusRef?: React.MutableRefObject<HTMLElement | null>;
}

export type InviteMemberDialogProps = AddMemberDialogProps;

function AddMemberForm({
  spaceId,
  onClose,
}: {
  spaceId: string;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<AddMemberOperationStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorType, setErrorType] = useState<AddMemberErrorType>(null);
  const [addedEmail, setAddedEmail] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const queryClient = useQueryClient();

  const isSubmitting = status === "submitting";
  const isSuccess = status === "success";

  const { mutate } = useMutation({
    mutationFn: async (targetEmail: string) => {
      return await addMemberToSpace(spaceId, targetEmail);
    },
    onSuccess: (result) => {
      invalidateSpaceMemberQueries(queryClient, spaceId);
      setStatus("success");
      setAddedEmail(result.email);
      setEmail("");
      setError(null);
      setErrorType(null);
    },
    onError: (err: unknown) => {
      const resolved = resolveMemberActionError(err);
      setStatus("error");
      setError(resolved.message);
      setErrorType(resolved.type);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (isSubmitting) return;

    setError(null);
    setErrorType(null);

    const validation = validateMemberEmail(email);
    if (!validation.isValid) {
      setStatus("error");
      setError(validation.error || "Please enter a valid email address.");
      setErrorType("validation");
      inputRef.current?.focus();
      return;
    }

    setStatus("submitting");
    mutate(validation.trimmedEmail);
  };

  const handleResetToAddAnother = () => {
    setStatus("idle");
    setAddedEmail(null);
    setError(null);
    setErrorType(null);
    setEmail("");
    inputRef.current?.focus();
  };

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(e.target.value);
    if (error) {
      setError(null);
      setErrorType(null);
      setStatus("idle");
    }
    if (isSuccess) {
      setStatus("idle");
      setAddedEmail(null);
    }
  };

  return (
    <form onSubmit={handleSubmit} aria-busy={isSubmitting} noValidate>
      <DialogHeader>
        <DialogTitle>Add member</DialogTitle>
        <DialogDescription>
          Add a user to this space by their email address.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 py-4">
        <div className="grid gap-2">
          <Label htmlFor="add-member-email">Email address</Label>
          <Input
            ref={inputRef}
            id="add-member-email"
            type="email"
            placeholder="colleague@example.com"
            value={email}
            onChange={handleEmailChange}
            disabled={isSubmitting}
            autoFocus
            aria-invalid={status === "error" && !!error}
            aria-describedby={
              error
                ? "add-member-error-message"
                : isSuccess
                ? "add-member-success-message"
                : undefined
            }
          />
        </div>

        {status === "error" && error && (
          <div
            role="alert"
            aria-live="assertive"
            id="add-member-error-message"
            data-error-type={errorType || undefined}
            className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm font-medium"
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {isSuccess && (
          <div
            role="status"
            aria-live="polite"
            id="add-member-success-message"
            className="flex items-center gap-2 p-3 rounded-md bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800/40 text-green-700 dark:text-green-400 text-sm font-medium"
          >
            <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              {addedEmail ? `Added ${addedEmail} to the space.` : "Member added successfully."}
            </span>
          </div>
        )}
      </div>

      <DialogFooter className="gap-2 sm:gap-0">
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={isSubmitting}
        >
          {isSuccess ? "Close" : "Cancel"}
        </Button>
        <Button
          type={isSuccess ? "button" : "submit"}
          onClick={isSuccess ? handleResetToAddAnother : undefined}
          disabled={isSubmitting}
        >
          {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          {isSubmitting ? "Adding…" : isSuccess ? "Add another member" : "Add member"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function AddMemberDialog({
  spaceId,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  trigger,
  returnFocusRef,
}: AddMemberDialogProps) {
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
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {trigger ? (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      ) : (
        <DialogTrigger asChild>
          <Button size="sm" variant="outline" className="gap-2">
            <UserPlus className="h-4 w-4" aria-hidden="true" /> Add member
          </Button>
        </DialogTrigger>
      )}
      <DialogContent
        className="sm:max-w-[425px]"
        onCloseAutoFocus={handleCloseAutoFocus}
      >
        {isOpen && (
          <AddMemberForm
            spaceId={spaceId}
            onClose={() => handleOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export const InviteMemberDialog = AddMemberDialog;
