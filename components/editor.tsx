"use client";

import { useEditor, EditorContent, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ResizableImage } from "./editor/resizable-image";
import Link from "@tiptap/extension-link";
import { LinkSuggestion } from "./editor/link-suggestion";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableMarkdownInputRule } from "./editor/table-markdown-input-rule";
import { MarkdownPaste } from "@/lib/markdown-paste";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu";
import { useEffect, useState } from "react";
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Code,
  SquareCode,
  Quote,
  Image as ImageIcon,
  Loader2,
  Link as LinkIcon,
  Table as TableIcon,
  ClipboardPaste,
} from "lucide-react";
import { BlockStyleSelector } from "./editor/block-style-selector";
import {
  getToolbarActiveState,
  DEFAULT_TOOLBAR_STATE,
} from "@/lib/editor-toolbar-utils";
import { cn } from "@/lib/utils";
import { getPresignedUrl, getPresignedGetUrl } from "@/lib/actions/s3";
import { optimizeImage } from "@/lib/image-optimization";
import { AlertDialog } from "./ui/alert-dialog";

interface EditorProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any;
  editable: boolean;
  spaceId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChange?: (content: any) => void;
  onImageUpload?: (url: string) => void;
  isScrolled?: boolean;
}

export function Editor({
  content,
  editable,
  spaceId,
  onChange,
  onImageUpload,
  isScrolled = false,
}: EditorProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [alertState, setAlertState] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
  }>({
    isOpen: false,
    title: "",
    message: "",
  });

  const showAlert = (title: string, message: string) => {
    setAlertState({ isOpen: true, title, message });
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        link: false as any, // Disable internal link extension to avoid duplicate
      }),
      ResizableImage,
      Link.configure({
        openOnClick: false,
        autolink: true,
      }),
      LinkSuggestion.configure({
        spaceId: spaceId,
      }),
      Table.configure({
        resizable: true,
      }),
      TableRow,
      TableHeader,
      TableCell,
      TableMarkdownInputRule,
      MarkdownPaste,
    ],
    content: content,
    editable: editable,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          "prose prose-dynamic m-5 focus:outline-none max-w-none dark:prose-invert",
      },
    },
    onUpdate: ({ editor }) => {
      onChange?.(editor.getJSON());
    },
  });

  // Update editable state if prop changes
  useEffect(() => {
    if (editor && editor.isEditable !== editable) {
      editor.setEditable(editable);
    }
  }, [editable, editor]);

  // Update content if prop changes (only when not editing to avoid overwriting unsaved changes)
  useEffect(() => {
    if (editor && !editable) {
      // Deep comparison to avoid unnecessary updates
      const currentContent = editor.getJSON();
      if (JSON.stringify(content) !== JSON.stringify(currentContent)) {
        setTimeout(() => {
          editor.commands.setContent(content);
        }, 0);
      }
    }
  }, [content, editable, editor]);

  const addImage = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      setIsUploading(true);
      try {
        // Optimize image before upload
        const optimizedFile = await optimizeImage(file);

        const presigned = await getPresignedUrl(
          optimizedFile.name,
          optimizedFile.type,
        );
        if (!presigned) {
          showAlert(
            "Configuration Error",
            "Failed to get upload URL. Check AWS config.",
          );
          return;
        }

        const { url, key } = presigned;

        try {
          const uploadRes = await fetch(url, {
            method: "PUT",
            body: optimizedFile,
            headers: {
              "Content-Type": optimizedFile.type,
            },
          });

          if (!uploadRes.ok) {
            throw new Error(`Upload failed with status: ${uploadRes.status}`);
          }
        } catch (uploadError) {
          console.error("S3 Upload Error:", uploadError);
          showAlert(
            "Upload Failed",
            "Check console for CORS or Network errors.",
          );
          return;
        }

        if (!key) {
          console.error("No key returned from presigned URL");
          return;
        }

        // Get a signed URL for reading the image we just uploaded
        const signedUrl = await getPresignedGetUrl(key);
        if (signedUrl) {
          editor?.chain().focus().setImage({ src: signedUrl }).run();
          // Pass the signed URL to the parent, but the parent should strip params before saving
          // actually onImageUpload is used to track session images to permanentize/delete
          // The permanentize logic expects the url that includes "temp/"
          // The signedUrl includes "temp/" in the path, so it's fine.
          onImageUpload?.(signedUrl);
        }
      } catch (e) {
        if (e instanceof Error) {
          if (
            e.message === "NOT_AN_IMAGE" ||
            e.message === "Failed to load image"
          ) {
            showAlert(
              "Invalid Image",
              "Please upload a valid image file (JPEG, PNG, WebP, etc.).",
            );
          } else {
            console.error(e);
            showAlert("Upload Error", e.message);
          }
        } else {
          console.error(e);
          showAlert(
            "Upload Error",
            "An unexpected error occurred during upload.",
          );
        }
      } finally {
        setIsUploading(false);
      }
    };
    input.click();
  };

  const addLink = () => {
    const previousUrl = editor?.getAttributes("link").href;
    const url = window.prompt("URL", previousUrl);

    // cancelled
    if (url === null) {
      return;
    }

    // empty
    if (url === "") {
      editor?.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }

    // update
    editor
      ?.chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: url })
      .run();
  };

  const handlePasteAsMarkdown = async () => {
    if (!editor || !editable) return;
    let text = "";
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        showAlert(
          "Clipboard Unavailable",
          "Your browser does not support clipboard reading or requires a secure (HTTPS) connection."
        );
        return;
      }
      text = await navigator.clipboard.readText();
    } catch (err) {
      console.warn("Failed to read clipboard text:", err);
      showAlert(
        "Clipboard Access Denied",
        "Unable to read clipboard. Please check your browser permissions."
      );
      return;
    }

    if (!text) return;
    try {
      editor.chain().focus().insertMarkdown(text).run();
    } catch (err) {
      console.error("Failed to insert markdown:", err);
    }
  };

  const handlePasteAsPlainText = async () => {
    if (!editor || !editable) return;
    let text = "";
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        showAlert(
          "Clipboard Unavailable",
          "Your browser does not support clipboard reading or requires a secure (HTTPS) connection."
        );
        return;
      }
      text = await navigator.clipboard.readText();
    } catch (err) {
      console.warn("Failed to read clipboard text:", err);
      showAlert(
        "Clipboard Access Denied",
        "Unable to read clipboard. Please check your browser permissions."
      );
      return;
    }

    if (!text) return;
    try {
      editor.chain().focus().insertPlainText(text).run();
    } catch (err) {
      console.error("Failed to insert plain text:", err);
    }
  };

  // Font Size Logic
  const [fontSize, setFontSize] = useState(16);

  useEffect(() => {
    // Ideally we get userId from context or props, but for now we might need to assume
    // we can get it from auth.currentUser or pass it down.
    // Since EditorProps doesn't have userId, let's try to get it from a hook if available,
    // or we might have to rely on the parent or import { auth } from "@/lib/firebase";
    // For specific user persistence we need auth.
    import("@/lib/firebase").then(({ auth }) => {
      const user = auth.currentUser;
      if (user) {
        import("@/lib/actions/user-settings").then(({ getUserSettings }) => {
          getUserSettings(user.uid).then((settings) => {
            if (settings.documentFontSize) {
              setFontSize(settings.documentFontSize);
            }
          });
        });
      }
    });
  }, []);

  const updateFontSize = (newSize: number) => {
    setFontSize(newSize);
    // Persist debounce or fire-and-forget
    import("@/lib/firebase").then(({ auth }) => {
      const user = auth.currentUser;
      if (user) {
        import("@/lib/actions/user-settings").then(
          ({ updateDocumentFontSize }) => {
            updateDocumentFontSize(user.uid, newSize);
          },
        );
      }
    });
  };

  const increaseFontSize = () => updateFontSize(Math.min(fontSize + 1, 32));
  const decreaseFontSize = () => updateFontSize(Math.max(fontSize - 1, 12));

  const toolbarState =
    useEditorState({
      editor,
      selector: (ctx) => getToolbarActiveState(ctx.editor),
    }) ?? DEFAULT_TOOLBAR_STATE;

  if (!editor) {
    return null;
  }

  return (
    <div className="w-full">
      {editable && (
        <div
          className={cn(
            "sticky z-10 mb-4 w-full bg-gray-50 dark:bg-gray-900 border-b border-border dark:border-zinc-800 shadow-sm transition-all duration-200",
            isScrolled ? "top-[52px]" : "top-0",
          )}
        >
          <div className="mx-auto max-w-4xl px-4 md:px-8 py-2 flex gap-1 flex-wrap items-center">
            {/* Block Style Selector */}
            <BlockStyleSelector editor={editor} />

            <div className="w-px h-6 bg-border mx-1" />

            {/* Inline Formatting */}
            <ToolbarBtn
              onClick={() => editor.chain().focus().toggleBold().run()}
              isActive={toolbarState.bold}
              icon={<Bold className="h-4 w-4" />}
              title="Bold"
              ariaLabel="Bold"
            />
            <ToolbarBtn
              onClick={() => editor.chain().focus().toggleItalic().run()}
              isActive={toolbarState.italic}
              icon={<Italic className="h-4 w-4" />}
              title="Italic"
              ariaLabel="Italic"
            />
            <ToolbarBtn
              onClick={() => editor.chain().focus().toggleCode().run()}
              isActive={toolbarState.code}
              icon={<Code className="h-4 w-4" />}
              title="Inline code"
              ariaLabel="Inline code"
            />

            <div className="w-px h-6 bg-border mx-1" />

            {/* Lists */}
            <ToolbarBtn
              onClick={() => editor.chain().focus().toggleBulletList().run()}
              isActive={toolbarState.bulletList}
              icon={<List className="h-4 w-4" />}
              title="Bullet list"
              ariaLabel="Bullet list"
            />
            <ToolbarBtn
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
              isActive={toolbarState.orderedList}
              icon={<ListOrdered className="h-4 w-4" />}
              title="Ordered list"
              ariaLabel="Ordered list"
            />

            <div className="w-px h-6 bg-border mx-1" />

            {/* Code Block, Blockquote & Link */}
            <ToolbarBtn
              onClick={() => editor.chain().focus().toggleCodeBlock().run()}
              isActive={toolbarState.codeBlock}
              icon={<SquareCode className="h-4 w-4" />}
              title="Code block"
              ariaLabel="Code block"
            />
            <ToolbarBtn
              onClick={() => editor.chain().focus().toggleBlockquote().run()}
              isActive={toolbarState.blockquote}
              icon={<Quote className="h-4 w-4" />}
              title="Blockquote"
              ariaLabel="Blockquote"
            />
            <ToolbarBtn
              onClick={addLink}
              isActive={toolbarState.link}
              icon={<LinkIcon className="h-4 w-4" />}
              title="Insert link"
              ariaLabel="Insert link"
            />

            <div className="w-px h-6 bg-border mx-1" />

            {/* Table Menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title="Table options"
                  aria-label="Table options"
                  className={cn(
                    "rounded p-1.5 hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    toolbarState.table &&
                      "bg-accent text-accent-foreground",
                  )}
                >
                  <TableIcon className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {!toolbarState.table && (
                  <DropdownMenuItem
                    onSelect={() =>
                      editor
                        .chain()
                        .focus()
                        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                        .run()
                    }
                  >
                    Insert Table
                  </DropdownMenuItem>
                )}
                {toolbarState.table && (
                  <>
                    <DropdownMenuItem
                      onSelect={() =>
                        editor.chain().focus().addColumnBefore().run()
                      }
                    >
                      Add Column Before
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        editor.chain().focus().addColumnAfter().run()
                      }
                    >
                      Add Column After
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => editor.chain().focus().deleteColumn().run()}
                    >
                      Delete Column
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => editor.chain().focus().addRowBefore().run()}
                    >
                      Add Row Before
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => editor.chain().focus().addRowAfter().run()}
                    >
                      Add Row After
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => editor.chain().focus().deleteRow().run()}
                    >
                      Delete Row
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => editor.chain().focus().deleteTable().run()}
                      className="text-destructive focus:text-destructive"
                    >
                      Delete Table
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="w-px h-6 bg-border mx-1" />

            {/* Image */}
            <ToolbarBtn
              onClick={addImage}
              isActive={false}
              disabled={isUploading}
              title="Insert image"
              ariaLabel="Insert image"
              icon={
                isUploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ImageIcon className="h-4 w-4" />
                )
              }
            />

            <div className="w-px h-6 bg-border mx-1" />

            {/* Paste Menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="rounded p-1.5 hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title="Paste options"
                  aria-label="Paste options"
                >
                  <ClipboardPaste className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={handlePasteAsMarkdown}>
                  Paste as Markdown
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handlePasteAsPlainText}>
                  Paste as Plain Text
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="w-px h-6 bg-border mx-1" />

            {/* Font Size Controls */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={decreaseFontSize}
                className="rounded p-1.5 hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer text-xs font-medium"
                title="Decrease font size"
                aria-label="Decrease font size"
              >
                A-
              </button>
              <span className="text-xs text-muted-foreground min-w-[2rem] text-center select-none">
                {fontSize}px
              </span>
              <button
                type="button"
                onClick={increaseFontSize}
                className="rounded p-1.5 hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer text-xs font-medium"
                title="Increase font size"
                aria-label="Increase font size"
              >
                A+
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="mx-auto max-w-4xl px-4 md:px-8">
        <div
          style={{ fontSize: `${fontSize}px` }}
          className="transition-all duration-200"
        >
          <EditorContent editor={editor} className="prose-dynamic" />
        </div>
      </div>
      <AlertDialog
        isOpen={alertState.isOpen}
        onClose={() => setAlertState((s) => ({ ...s, isOpen: false }))}
        title={alertState.title}
        description={alertState.message}
      />
    </div>
  );
}

function ToolbarBtn({
  onClick,
  isActive = false,
  icon,
  title,
  ariaLabel,
  disabled = false,
}: {
  onClick: () => void;
  isActive?: boolean;
  icon: React.ReactNode;
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title || ariaLabel}
      aria-label={ariaLabel || title}
      className={cn(
        "rounded p-1.5 hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed outline-none",
        isActive && "bg-accent text-accent-foreground",
      )}
    >
      {icon}
    </button>
  );
}
