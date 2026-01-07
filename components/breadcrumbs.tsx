"use client";

import { useQuery } from "@tanstack/react-query";
import { getSidebarTree } from "@/lib/actions/document";
import { SidebarNode } from "@/lib/types";
import { ChevronRight, Home } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";

interface BreadcrumbsProps {
  documentId: string;
  title: string;
}

export function Breadcrumbs({ documentId, title }: BreadcrumbsProps) {
  const { data: tree } = useQuery({
    queryKey: ["sidebar-tree"],
    queryFn: getSidebarTree,
  });

  const breadcrumbs = useMemo(() => {
    if (!tree) return [];

    const findPath = (
      targetId: string, 
      nodes: SidebarNode[], 
      currentPath: { id: string; title: string }[]
    ): { id: string; title: string }[] | null => {
      for (const node of nodes) {
        if (node.id === targetId) {
          return currentPath;
        }
        if (node.children) {
          const found = findPath(targetId, node.children, [
            ...currentPath,
            { id: node.id, title: node.title },
          ]);
          if (found) return found;
        }
      }
      return null;
    };

    return findPath(documentId, tree, []) || [];
  }, [documentId, tree]);

  return (
    <nav className="flex items-center gap-1 text-sm text-muted-foreground mb-4 overflow-x-auto whitespace-nowrap pb-2 scrollbar-hide">
      <Link 
        href="/" 
        className="flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer"
      >
        <Home className="h-3.5 w-3.5" />
        <span className="sr-only">Home</span>
      </Link>

      {breadcrumbs.map((item) => (
        <div key={item.id} className="flex items-center gap-1">
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          <Link 
            href={`/doc/${item.id}`}
            className="hover:text-foreground transition-colors truncate max-w-[150px] cursor-pointer"
          >
            {item.title}
          </Link>
        </div>
      ))}

      <div className="flex items-center gap-1 text-foreground font-medium">
        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate max-w-[200px]">{title}</span>
      </div>
    </nav>
  );
}
