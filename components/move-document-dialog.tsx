"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { getSidebarTree, moveDocument } from "@/lib/actions/document";
import { SidebarNode } from "@/lib/types";
import { ChevronRight, ChevronDown, FileText, Loader2, Home } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/use-toast";

interface MoveDocumentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  spaceId: string;
  documentId: string;
  currentParentId: string | null;
}

export function MoveDocumentDialog({ isOpen, onClose, spaceId, documentId, currentParentId }: MoveDocumentDialogProps) {
  const { data: tree, isLoading } = useQuery({
    queryKey: ["sidebar-tree", spaceId],
    queryFn: () => getSidebarTree(spaceId),
    enabled: isOpen,
  });

  const [selectedParentId, setSelectedParentId] = useState<string | null | undefined>(undefined);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const toggleNode = (id: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const { mutate: handleMove, isPending } = useMutation({
    mutationFn: async () => {
      if (selectedParentId === undefined) return;
      await moveDocument(documentId, selectedParentId);
    },
    onSuccess: () => {
      toast({ title: "Document moved successfully" });
      queryClient.invalidateQueries({ queryKey: ["sidebar-tree", spaceId] });
      queryClient.invalidateQueries({ queryKey: ["doc", documentId] });
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to move document", description: err.message, variant: "destructive" });
    }
  });

  // Calculate if a node is disabled (it's the doc itself, or descendant of the doc)
  const isNodeDisabled = (node: SidebarNode, isDescendantOfTarget: boolean): boolean => {
    return node.id === documentId || isDescendantOfTarget;
  };

  const renderTree = (nodes: SidebarNode[], level: number, isDescendantOfTarget: boolean) => {
    return nodes.map(node => {
      const isTargetDescendant = isDescendantOfTarget || node.id === documentId;
      const disabled = isNodeDisabled(node, isTargetDescendant);
      const isSelected = selectedParentId === node.id;
      const isOpen = expandedNodes.has(node.id);
      const hasChildren = node.children.length > 0;

      return (
        <div key={node.id}>
          <div 
            className={cn(
              "flex items-center gap-1 rounded py-1.5 px-2 text-sm transition-colors",
              disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:bg-accent",
              isSelected ? "bg-accent font-medium" : ""
            )}
            style={{ paddingLeft: `${level * 16 + 8}px` }}
            onClick={() => {
              if (!disabled) setSelectedParentId(node.id);
            }}
          >
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleNode(node.id);
              }}
              className={cn("h-4 w-4 shrink-0 text-muted-foreground", !hasChildren && "invisible")}
            >
              {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{node.title}</span>
            {node.id === currentParentId && <span className="text-xs text-muted-foreground ml-auto">(Current)</span>}
          </div>
          {isOpen && hasChildren && (
            <div>{renderTree(node.children, level + 1, isTargetDescendant)}</div>
          )}
        </div>
      );
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Move document</DialogTitle>
          <DialogDescription>Select a new location for this document.</DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {isLoading ? (
            <div className="flex justify-center p-4"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : (
            <div className="border rounded-md max-h-[300px] overflow-y-auto p-1">
              <div 
                className={cn(
                  "flex items-center gap-2 rounded py-1.5 px-2 text-sm transition-colors cursor-pointer",
                  selectedParentId === null ? "bg-accent font-medium" : "hover:bg-accent"
                )}
                onClick={() => setSelectedParentId(null)}
              >
                <Home className="h-4 w-4 text-muted-foreground ml-1" />
                <span>Space root</span>
                {currentParentId === null && <span className="text-xs text-muted-foreground ml-auto">(Current)</span>}
              </div>
              <div className="my-1 border-t"></div>
              {renderTree(tree || [], 0, false)}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button 
            onClick={() => handleMove()} 
            disabled={isPending || selectedParentId === undefined || selectedParentId === currentParentId}
          >
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
