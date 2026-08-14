"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ResizableImage } from "./editor/resizable-image";
import Link from "@tiptap/extension-link";
import { LinkSuggestion } from "./editor/link-suggestion";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableMarkdownInputRule } from "./editor/table-markdown-input-rule";
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
  Heading1,
  Heading2,
  Image as ImageIcon,
  Loader2,
  Link as LinkIcon,
  Table as TableIcon,
} from "lucide-react";
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

  if (!editor) {
    return null;
  }

  return (
    <div className="w-full">
      {editable && (
        <div
          className={cn(
            "sticky z-10 mb-4 flex gap-1 bg-gray-50 dark:bg-gray-900 flex-wrap items-center border-b border-border dark:border-zinc-800 rounded-none -mx-4 px-4 md:-mx-8 md:px-8 py-2 shadow-sm transition-all duration-200",
            isScrolled ? "top-[52px]" : "top-0",
          )}
        >
          <ToolbarBtn
            onClick={() => editor.chain().focus().toggleBold().run()}
            isActive={editor.isActive("bold")}
            icon={<Bold className="h-4 w-4" />}
          />
          <ToolbarBtn
            onClick={() => editor.chain().focus().toggleItalic().run()}
            isActive={editor.isActive("italic")}
            icon={<Italic className="h-4 w-4" />}
          />
          <div className="w-px h-6 bg-border mx-1" />
          <ToolbarBtn
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 1 }).run()
            }
            isActive={editor.isActive("heading", { level: 1 })}
            icon={<Heading1 className="h-4 w-4" />}
          />
          <ToolbarBtn
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 2 }).run()
            }
            isActive={editor.isActive("heading", { level: 2 })}
            icon={<Heading2 className="h-4 w-4" />}
          />
          <div className="w-px h-6 bg-border mx-1" />
          <ToolbarBtn
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            isActive={editor.isActive("bulletList")}
            icon={<List className="h-4 w-4" />}
          />
          <ToolbarBtn
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            isActive={editor.isActive("orderedList")}
            icon={<ListOrdered className="h-4 w-4" />}
          />
          <div className="w-px h-6 bg-border mx-1" />
          <ToolbarBtn
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            isActive={editor.isActive("codeBlock")}
            icon={<Code className="h-4 w-4" />}
          />
          <ToolbarBtn
            onClick={addLink}
            isActive={editor.isActive("link")}
            icon={<LinkIcon className="h-4 w-4" />}
          />
          <div className="w-px h-6 bg-border mx-1" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  "rounded p-1.5 hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer outline-none",
                  editor.isActive("table") &&
                    "bg-accent text-accent-foreground",
                )}
              >
                <TableIcon className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {!editor.isActive("table") && (
                <DropdownMenuItem
                  onClick={() =>
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
              {editor.isActive("table") && (
                <>
                  <DropdownMenuItem
                    onClick={() =>
                      editor.chain().focus().addColumnBefore().run()
                    }
                  >
                    Add Column Before
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      editor.chain().focus().addColumnAfter().run()
                    }
                  >
                    Add Column After
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => editor.chain().focus().deleteColumn().run()}
                  >
                    Delete Column
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => editor.chain().focus().addRowBefore().run()}
                  >
                    Add Row Before
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => editor.chain().focus().addRowAfter().run()}
                  >
                    Add Row After
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => editor.chain().focus().deleteRow().run()}
                  >
                    Delete Row
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => editor.chain().focus().deleteTable().run()}
                    className="text-destructive focus:text-destructive"
                  >
                    Delete Table
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="w-px h-6 bg-border mx-1" />
          <ToolbarBtn
            onClick={addImage}
            isActive={false}
            icon={
              isUploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ImageIcon className="h-4 w-4" />
              )
            }
          />
          <div className="w-px h-6 bg-border mx-1" />
          {/* Font Size Controls */}
          <div className="flex items-center gap-1">
            <button
              onClick={decreaseFontSize}
              className="rounded p-1.5 hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer text-xs font-medium"
              title="Decrease Font Size"
            >
              A-
            </button>
            <span className="text-xs text-muted-foreground min-w-[2rem] text-center select-none">
              {fontSize}px
            </span>
            <button
              onClick={increaseFontSize}
              className="rounded p-1.5 hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer text-xs font-medium"
              title="Increase Font Size"
            >
              A+
            </button>
          </div>
        </div>
      )}
      <div
        style={{ fontSize: `${fontSize}px` }}
        className="transition-all duration-200"
      >
        <EditorContent editor={editor} className="prose-dynamic" />
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
  isActive,
  icon,
}: {
  onClick: () => void;
  isActive: boolean;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded p-1.5 hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer",
        isActive && "bg-accent text-accent-foreground",
      )}
    >
      {icon}
    </button>
  );
}
