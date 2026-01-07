"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ResizableImage } from "./editor/resizable-image";
import Link from "@tiptap/extension-link";
import { useEffect, useState } from "react";
import { Bold, Italic, List, ListOrdered, Code, Heading1, Heading2, Image as ImageIcon, Loader2, Link as LinkIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { getPresignedUrl, getPresignedGetUrl } from "@/lib/actions/s3";
import { optimizeImage } from "@/lib/image-optimization";
import { AlertDialog } from "./ui/alert-dialog";

interface EditorProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any;
  editable: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChange?: (content: any) => void;
  onImageUpload?: (url: string) => void;
}

export function Editor({ content, editable, onChange, onImageUpload }: EditorProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [alertState, setAlertState] = useState<{ isOpen: boolean; title: string; message: string }>({
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
        })
    ],
    content: content,
    editable: editable,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "prose prose-sm sm:prose-base lg:prose-lg xl:prose-2xl m-5 focus:outline-none max-w-none dark:prose-invert",
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
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      setIsUploading(true);
      try {
        // Optimize image before upload
        const optimizedFile = await optimizeImage(file);
        
        const presigned = await getPresignedUrl(optimizedFile.name, optimizedFile.type);
        if (!presigned) {
            showAlert("Configuration Error", "Failed to get upload URL. Check AWS config.");
            return;
        }

        const { url, key } = presigned;
        
        try {
          const uploadRes = await fetch(url, {
            method: "PUT",
            body: optimizedFile,
            headers: { 
              "Content-Type": optimizedFile.type,
            }
          });

          if (!uploadRes.ok) {
            throw new Error(`Upload failed with status: ${uploadRes.status}`);
          }
        } catch (uploadError) {
          console.error("S3 Upload Error:", uploadError);
          showAlert("Upload Failed", "Check console for CORS or Network errors.");
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
          if (e.message === 'NOT_AN_IMAGE' || e.message === 'Failed to load image') {
            showAlert("Invalid Image", "Please upload a valid image file (JPEG, PNG, WebP, etc.).");
          } else {
            console.error(e);
            showAlert("Upload Error", e.message);
          }
        } else {
          console.error(e);
          showAlert("Upload Error", "An unexpected error occurred during upload.");
        }
      } finally {
        setIsUploading(false);
      }
    };
    input.click();
  };

  const addLink = () => {
      const previousUrl = editor?.getAttributes('link').href;
      const url = window.prompt('URL', previousUrl);

      // cancelled
      if (url === null) {
        return;
      }

      // empty
      if (url === '') {
        editor?.chain().focus().extendMarkRange('link').unsetLink().run();
        return;
      }

      // update
      editor?.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  if (!editor) {
    return null;
  }

  return (
    <div className="w-full">
      {editable && (
        <div className="sticky top-0 z-10 mb-4 flex gap-1 rounded-md border border-border bg-background p-1 shadow-sm flex-wrap">
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
          <div className="w-px bg-border mx-1" />
           <ToolbarBtn
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            isActive={editor.isActive("heading", { level: 1 })}
            icon={<Heading1 className="h-4 w-4" />}
          />
          <ToolbarBtn
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            isActive={editor.isActive("heading", { level: 2 })}
            icon={<Heading2 className="h-4 w-4" />}
          />
          <div className="w-px bg-border mx-1" />
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
           <div className="w-px bg-border mx-1" />
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
           <div className="w-px bg-border mx-1" />
           <ToolbarBtn
            onClick={addImage}
            isActive={false}
            icon={isUploading ? <Loader2 className="h-4 w-4 animate-spin"/> : <ImageIcon className="h-4 w-4" />}
          />
        </div>
      )}
      <EditorContent editor={editor} />
      <AlertDialog
        isOpen={alertState.isOpen}
        onClose={() => setAlertState((s) => ({ ...s, isOpen: false }))}
        title={alertState.title}
        description={alertState.message}
      />
    </div>
  );
}

function ToolbarBtn({ onClick, isActive, icon }: { onClick: () => void; isActive: boolean; icon: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded p-1.5 hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer",
        isActive && "bg-accent text-accent-foreground"
      )}
    >
      {icon}
    </button>
  );
}
