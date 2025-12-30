"use client";

import { useQuery } from "@tanstack/react-query";
import { getSidebarTree } from "@/lib/actions/document";
import { SidebarNode } from "@/lib/types";
import { ChevronRight, Home } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";

interface BreadcrumbsProps {
  path: string[];
  currentTitle: string;
}

export function Breadcrumbs({ path, currentTitle }: BreadcrumbsProps) {
  const { data: tree } = useQuery({
    queryKey: ["sidebar-tree"],
    queryFn: getSidebarTree,
  });

  const resolvedPath = useMemo(() => {
    if (!tree) return [];

    const findNode = (id: string, nodes: SidebarNode[]): SidebarNode | null => {
      for (const node of nodes) {
        if (node.id === id) return node;
        if (node.children) {
          const found = findNode(id, node.children);
          if (found) return found;
        }
      }
      return null;
    };

    return path.map((id) => {
      const node = findNode(id, tree);
      return {
        id,
        title: node?.title || "Unknown",
      };
    });
  }, [path, tree]);

  return (
    <nav className="flex items-center gap-1 text-sm text-gray-500 dark:text-zinc-500 mb-4 overflow-x-auto whitespace-nowrap pb-2 scrollbar-hide">
      <Link 
        href="/" 
        className="flex items-center gap-1 hover:text-gray-900 dark:hover:text-zinc-300 transition-colors"
      >
        <Home className="h-3.5 w-3.5" />
        <span className="sr-only">Home</span>
      </Link>

      {resolvedPath.map((item) => (
        <div key={item.id} className="flex items-center gap-1">
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          <Link 
            href={`/doc/${item.id}`}
            className="hover:text-gray-900 dark:hover:text-zinc-300 transition-colors truncate max-w-[150px]"
          >
            {item.title}
          </Link>
        </div>
      ))}

      <div className="flex items-center gap-1 text-gray-900 dark:text-zinc-100 font-medium">
        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate max-w-[200px]">{currentTitle}</span>
      </div>
    </nav>
  );
}
