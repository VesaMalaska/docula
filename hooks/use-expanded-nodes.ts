"use client";

import { useState, useEffect, useCallback } from "react";

export function useExpandedNodes() {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    const saved = localStorage.getItem("sidebar-expanded-nodes");
    if (saved) {
      try {
        return new Set(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to parse expanded nodes from localStorage", e);
      }
    }
    return new Set();
  });

  useEffect(() => {
    localStorage.setItem("sidebar-expanded-nodes", JSON.stringify(Array.from(expandedNodes)));
  }, [expandedNodes]);

  const toggleNode = useCallback((nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const expandNode = useCallback((nodeId: string) => {
    setExpandedNodes((prev) => {
      if (prev.has(nodeId)) return prev;
      const next = new Set(prev);
      next.add(nodeId);
      return next;
    });
  }, []);

  const expandNodes = useCallback((nodeIds: string[]) => {
    setExpandedNodes((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of nodeIds) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const isExpanded = useCallback((nodeId: string) => expandedNodes.has(nodeId), [expandedNodes]);

  return { expandedNodes, toggleNode, expandNode, expandNodes, isExpanded };
}
