import { Timestamp } from "firebase/firestore";

export interface Document {
  id: string;
  title: string;
  content: any; // Tiptap JSON content
  parentId: string | null;
  path: string[];
  tags: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
  lock: {
    active: boolean;
    userId: string;
    userName: string;
    expiresAt: Timestamp;
  } | null;
  outboundLinks: string[];
  backlinks: string[];
}

export interface SidebarNode {
  id: string;
  title: string;
  parentId: string | null;
  children: SidebarNode[];
}
