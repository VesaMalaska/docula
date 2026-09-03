"use client";

import * as React from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "../ui/dropdown-menu";
import {
  BLOCK_STYLE_OPTIONS,
  getCurrentBlockStyle,
  applyBlockStyle,
} from "@/lib/editor-toolbar-utils";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface BlockStyleSelectorProps {
  editor: Editor | null;
}

export function BlockStyleSelector({ editor }: BlockStyleSelectorProps) {
  const currentStyle =
    useEditorState({
      editor,
      selector: (ctx) => getCurrentBlockStyle(ctx.editor),
    }) ?? getCurrentBlockStyle(editor);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center justify-between gap-1.5 rounded px-2 py-1 text-xs font-medium min-w-[105px] h-7 border border-transparent hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring",
            currentStyle.id !== "paragraph" && "bg-accent/60 text-accent-foreground",
          )}
          title={`Text style: ${currentStyle.label}`}
          aria-label={`Text style: ${currentStyle.label}`}
        >
          <span className="truncate">{currentStyle.label}</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-60 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[130px]">
        <DropdownMenuRadioGroup
          value={currentStyle.id}
          onValueChange={(value) => {
            const option = BLOCK_STYLE_OPTIONS.find((o) => o.id === value);
            if (option) {
              applyBlockStyle(editor, option);
            }
          }}
        >
          {BLOCK_STYLE_OPTIONS.map((option) => {
            const isActive = currentStyle.id === option.id;
            return (
              <DropdownMenuRadioItem
                key={option.id}
                value={option.id}
                className={cn(
                  "flex items-center gap-2 text-xs cursor-pointer",
                  isActive && "font-semibold text-accent-foreground",
                )}
              >
                <span>{option.label}</span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
