"use client";

import * as React from "react";
import type { Editor } from "@tiptap/react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../ui/dropdown-menu";
import {
  BLOCK_STYLE_OPTIONS,
  getCurrentBlockStyle,
} from "@/lib/editor-toolbar-utils";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface BlockStyleSelectorProps {
  editor: Editor | null;
}

export function BlockStyleSelector({ editor }: BlockStyleSelectorProps) {
  const currentStyle = getCurrentBlockStyle(editor);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center justify-between gap-1.5 rounded px-2 py-1 text-xs font-medium min-w-[105px] h-7 border border-transparent hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer outline-none",
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
        {BLOCK_STYLE_OPTIONS.map((option) => {
          const isActive = currentStyle.id === option.id;
          return (
            <DropdownMenuItem
              key={option.id}
              onClick={() => {
                if (!editor) return;
                if (option.level) {
                  editor
                    .chain()
                    .focus()
                    .toggleHeading({ level: option.level })
                    .run();
                } else {
                  editor.chain().focus().setParagraph().run();
                }
              }}
              className={cn(
                "flex items-center justify-between gap-2 text-xs",
                isActive && "font-semibold text-accent-foreground",
              )}
            >
              <span>{option.label}</span>
              {isActive && <Check className="h-3.5 w-3.5 shrink-0 opacity-80" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
