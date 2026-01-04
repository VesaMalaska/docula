import { NodeViewWrapper, NodeViewProps } from "@tiptap/react";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";

export const ResizableImageNodeView = (props: NodeViewProps) => {
  const { node, updateAttributes, selected, editor } = props;
  const { src, alt, title, width: initialWidth } = node.attrs;
  const [width, setWidth] = useState(initialWidth || "auto");
  const [isResizing, setIsResizing] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (initialWidth) {
      setWidth(initialWidth);
    }
  }, [initialWidth]);

  const onMouseDown = useCallback(
    (event: React.MouseEvent | React.TouchEvent) => {
      if (!editor.isEditable) return;
      
      event.preventDefault();
      event.stopPropagation();
      
      setIsResizing(true);
      
      const startX = "touches" in event ? event.touches[0].clientX : event.clientX;
      const startWidth = imageRef.current?.clientWidth || 0;

      const onMouseMove = (moveEvent: MouseEvent | TouchEvent) => {
        const currentX = "touches" in moveEvent ? moveEvent.touches[0].clientX : moveEvent.clientX;
        const diffX = currentX - startX;
        const newWidth = Math.max(50, startWidth + diffX);
        setWidth(newWidth);
      };

      const onMouseUp = () => {
        setIsResizing(false);
        const finalWidth = imageRef.current?.clientWidth;
        if (finalWidth) {
          updateAttributes({ width: finalWidth });
        }
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.removeEventListener("touchmove", onMouseMove);
        document.removeEventListener("touchend", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.addEventListener("touchmove", onMouseMove, { passive: false });
      document.addEventListener("touchend", onMouseUp);
    },
    [updateAttributes, editor.isEditable]
  );

  return (
    <NodeViewWrapper className={cn(
      "relative inline-block leading-0 line-height-0",
      selected && "outline-2 outline-indigo-500 outline-solid"
    )}>
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        title={title}
        style={{
          width: width === "auto" ? "auto" : `${width}px`,
          maxWidth: "100%",
          height: "auto",
        }}
        className={cn(
          "rounded-md transition-shadow",
          selected && "shadow-lg"
        )}
      />
      {selected && editor.isEditable && (
        <>
          <div
            className="absolute bottom-0 right-0 w-4 h-4 bg-indigo-500 cursor-nwse-resize rounded-full border-2 border-white shadow-sm -mr-2 -mb-2 z-20"
            onMouseDown={onMouseDown}
            onTouchStart={onMouseDown}
          />
          {/* Visual indicator for resizing overlay */}
          {isResizing && (
             <div className="absolute inset-0 bg-indigo-500/10 pointer-events-none rounded-md" />
          )}
        </>
      )}
    </NodeViewWrapper>
  );
};
