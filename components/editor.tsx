"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TiptapImage from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { useEffect, useState } from "react";
import { Bold, Italic, List, ListOrdered, Code, Heading1, Heading2, Image as ImageIcon, Loader2, Link as LinkIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { getPresignedUrl } from "@/lib/actions/s3";

interface EditorProps {
  content: any;
  editable: boolean;
  onChange?: (content: any) => void;
}

export function Editor({ content, editable, onChange }: EditorProps) {
  const [isUploading, setIsUploading] = useState(false);

  const editor = useEditor({
    extensions: [
        StarterKit, 
        TiptapImage,
        Link.configure({
            openOnClick: false,
            autolink: true,
        })
    ],
    content: content,
    editable: editable,
    editorProps: {
      attributes: {
        class: "prose prose-sm sm:prose-base lg:prose-lg xl:prose-2xl m-5 focus:outline-none max-w-none",
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

  const addImage = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      setIsUploading(true);
      try {
        const presigned = await getPresignedUrl(file.name, file.type);
        if (!presigned) {
            alert("Failed to get upload URL. Check AWS config.");
            return;
        }

        const { url } = presigned;
        
        await fetch(url, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type }
        });

        const imageUrl = url.split("?")[0]; 
        
        editor?.chain().focus().setImage({ src: imageUrl }).run();

      } catch (e) {
        console.error(e);
        alert("Upload failed");
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
        <div className="sticky top-0 z-10 mb-4 flex gap-1 rounded-md border bg-white p-1 shadow-sm flex-wrap">
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
          <div className="w-px bg-gray-200 mx-1" />
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
          <div className="w-px bg-gray-200 mx-1" />
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
           <div className="w-px bg-gray-200 mx-1" />
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
           <div className="w-px bg-gray-200 mx-1" />
           <ToolbarBtn
            onClick={addImage}
            isActive={false}
            icon={isUploading ? <Loader2 className="h-4 w-4 animate-spin"/> : <ImageIcon className="h-4 w-4" />}
          />
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}

function ToolbarBtn({ onClick, isActive, icon }: { onClick: () => void; isActive: boolean; icon: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded p-1.5 hover:bg-gray-100",
        isActive && "bg-gray-200 text-gray-900"
      )}
    >
      {icon}
    </button>
  );
}
