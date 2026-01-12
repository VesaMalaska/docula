import { Timestamp } from "firebase/firestore";

export interface Document {
  id: string;
  spaceId: string;
  title: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  deleted?: boolean;
  deletedAt?: Timestamp | null;
  deletedBy?: string | null;
}


export interface SidebarNode {
  id: string;
  title: string;
  parentId: string | null;
  children: SidebarNode[];
}

export interface Space {
  id: string;
  name: string;
  description?: string;
  isPublic: boolean;
  ownerId: string;
  userIds: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
