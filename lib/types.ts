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
  restoreParentId?: string | null;
  permanentDeletionClaim?: PermanentDeletionClaim | null;
  lifecycleClaim?: LifecycleClaim | null;
  deletionGroupId?: string | null;
  deletionGroupRootId?: string | null;
  deletionGroupCount?: number | null;
}

export interface PermanentDeletionClaim {
  claimedAt: Timestamp;
  claimedBy: string;
}

export interface LifecycleClaim {
  claimedAt: Timestamp;
  claimedBy: string;
  operation: "soft-delete" | "restore";
  strategy?: "move-descendants" | "delete-subtree";
  opId: string;
}

export interface SoftDeleteOptions {
  strategy: "move-descendants" | "delete-subtree";
  destinationParentId?: string | null;
}

export type RestoreDestination =
  | { kind: "original" }
  | { kind: "root" }
  | { kind: "document"; parentId: string };


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
  deletedAt?: Timestamp | null;
  deletedBy?: string | null;
  purgeState?: "purging" | null;
  purgeStartedAt?: Timestamp | null;
}
