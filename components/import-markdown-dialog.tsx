"use client";

import * as React from "react";
import { useState, useRef, ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { createDocument } from "@/lib/actions/document";
import { getEditorSchema } from "@/lib/editor-schema";
import {
  validateMarkdownFile,
  parseMarkdownDocument,
} from "@/lib/markdown-import";
import { FileText, Loader2, Upload, AlertCircle } from "lucide-react";

interface ImportMarkdownDialogProps {
  isOpen: boolean;
  onClose: () => void;
  spaceId: string;
  parentId: string | null;
  destinationName?: string;
  isSpaceRoot?: boolean;
  onSuccess?: (newDocId: string) => void;
  /** Ref to the element that should receive focus when the dialog closes. */
  returnFocusRef?: React.MutableRefObject<HTMLElement | null>;
}

export function ImportMarkdownDialog({
  isOpen,
  onClose,
  spaceId,
  parentId,
  destinationName,
  isSpaceRoot = false,
  onSuccess,
  returnFocusRef,
}: ImportMarkdownDialogProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const resetState = () => {
    setSelectedFile(null);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      resetState();
      onClose();
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const files = e.target.files;
    if (!files || files.length === 0) {
      setSelectedFile(null);
      return;
    }

    const file = files[0];
    const validation = validateMarkdownFile(file);
    if (!validation.valid) {
      setError(validation.error || "Invalid Markdown file.");
      setSelectedFile(null);
      return;
    }

    setSelectedFile(file);
  };

  const { mutate: handleImport, isPending: isImporting } = useMutation({
    mutationFn: async () => {
      if (!selectedFile) {
        throw new Error("Please select a Markdown file.");
      }

      let text: string;
      try {
        text = await selectedFile.text();
      } catch (readErr) {
        console.error("Failed to read file:", readErr);
        throw new Error("Failed to read file content.");
      }

      const schema = getEditorSchema();
      const parsed = parseMarkdownDocument(schema, text, selectedFile.name);

      const newDocId = await createDocument(spaceId, parentId, {
        title: parsed.title,
        content: parsed.json,
      });

      return newDocId;
    },
    onSuccess: (newDocId) => {
      toast({
        title: "Markdown document imported",
      });
      queryClient.invalidateQueries({ queryKey: ["sidebar-tree", spaceId] });
      onSuccess?.(newDocId);
      handleOpenChange(false);
      router.push(`/space/${spaceId}/doc/${newDocId}`);
    },
    onError: (err: unknown) => {
      const message =
        err instanceof Error ? err.message : "Failed to import Markdown file.";
      setError(message);
    },
  });

  const locationLabel = isSpaceRoot
    ? "Space root"
    : destinationName || "Parent document";

  const descriptionText = isSpaceRoot
    ? `Import a Markdown document into "${destinationName || "Space"}".`
    : `Import a Markdown document under "${destinationName || "Document"}".`;

  const isPointerInteractionRef = useRef(false);

  const handleCloseAutoFocus = (event: Event) => {
    const target = returnFocusRef?.current;
    const isPointer = isPointerInteractionRef.current;
    isPointerInteractionRef.current = false;

    if (returnFocusRef) {
      returnFocusRef.current = null;
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
        className="p-4 sm:p-6 sm:max-w-[480px] min-w-0"
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
        <DialogHeader className="min-w-0">
          <DialogTitle>Import Markdown</DialogTitle>
          <DialogDescription className="min-w-0 [overflow-wrap:anywhere] break-words">
            {descriptionText}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-3 min-w-0 w-full">
          <div className="rounded-md bg-muted/50 p-3 text-sm flex items-center justify-between gap-2 min-w-0 w-full">
            <span className="text-muted-foreground font-medium shrink-0">Location:</span>
            <span className="font-semibold text-foreground truncate min-w-0 text-right" title={locationLabel}>
              {locationLabel}
            </span>
          </div>

          <div className="space-y-2 min-w-0 w-full">
            <input
              ref={fileInputRef}
              id="markdown-file-input"
              type="file"
              accept=".md,text/markdown,text/plain"
              className="hidden"
              onChange={handleFileChange}
              disabled={isImporting}
              aria-label="Choose Markdown file"
            />

            {!selectedFile ? (
              <Button
                type="button"
                variant="outline"
                className="w-full h-24 border-dashed border-2 flex flex-col items-center justify-center gap-2 cursor-pointer hover:bg-accent/50"
                onClick={() => fileInputRef.current?.click()}
                disabled={isImporting}
              >
                <Upload className="h-6 w-6 text-muted-foreground" />
                <span className="text-sm font-medium">Choose Markdown file</span>
                <span className="text-xs text-muted-foreground">
                  Accepts .md files
                </span>
              </Button>
            ) : (
              <div className="flex items-center justify-between gap-3 p-3 rounded-md border border-border bg-card min-w-0 w-full">
                <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
                  <FileText className="h-5 w-5 text-primary shrink-0" aria-hidden="true" />
                  <span className="text-sm font-medium truncate min-w-0" title={selectedFile.name}>
                    {selectedFile.name}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isImporting}
                >
                  Change file
                </Button>
              </div>
            )}
          </div>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm min-w-0 w-full"
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
              <span className="min-w-0 [overflow-wrap:anywhere] break-words flex-1">{error}</span>
            </div>
          )}
        </div>

        <DialogFooter className="min-w-0 w-full gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isImporting}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => handleImport()}
            disabled={isImporting || !selectedFile}
            className="w-full sm:w-auto"
          >
            {isImporting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isImporting ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
