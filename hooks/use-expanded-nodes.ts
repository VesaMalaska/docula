"use client";

import { useState, useEffect } from "react";

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

  const toggleNode = (nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  const isExpanded = (nodeId: string) => expandedNodes.has(nodeId);

  return { expandedNodes, toggleNode, isExpanded };
}
