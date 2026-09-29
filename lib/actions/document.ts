import { db, auth } from "@/lib/firebase";
import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  updateDoc,
  serverTimestamp, 
  query,
  orderBy,
  where,
  writeBatch,
  DocumentSnapshot,
  FirestoreError,
  type Timestamp
} from "firebase/firestore";
import type { Document, SidebarNode, RestoreDestination } from "@/lib/types";
import { getPresignedGetUrl } from "./s3";
import { updateDocumentAction } from "./document-save";
import { permanentlyDeleteDocumentAction } from "./document-permanent-delete";
import {
  softDeleteDocumentAction,
  restoreDocumentAction,
  getDocumentDescendantSummaryAction,
} from "./document-soft-delete";
import { moveDocumentAction } from "./document-move";
import { extractImageUrls, replaceImageUrls } from "../utils";
import { calculateNewPath } from "../utils/hierarchy";

export interface CreateDocumentOptions {
  title?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content?: any;
}

export async function createDocument(
  spaceId: string, 
  parentId: string | null = null,
  options?: CreateDocumentOptions
) {
  const spaceRef = doc(db, "spaces", spaceId);
  const spaceSnap = await getDoc(spaceRef);
  if (!spaceSnap.exists()) {
    throw new Error("Space not found");
  }
  const spaceData = spaceSnap.data();
  if (spaceData?.deletedAt != null) {
    throw new Error("Cannot create document in a deleted space");
  }

  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error("Unauthorized: authentication required");
  }
  const isOwner = spaceData.ownerId === currentUser.uid;
  const isMember = Array.isArray(spaceData.userIds) && spaceData.userIds.includes(currentUser.uid);
  if (!isOwner && !isMember) {
    throw new Error("Unauthorized: caller is not a contributor to this space");
  }

  const docRef = doc(collection(db, "documents"));
  const docId = docRef.id;

  let path: string[] = [];

  if (parentId !== null) {
    if (parentId === docId) {
      throw new Error("Cannot set document as its own parent");
    }
    const parentRef = doc(db, "documents", parentId);
    const parentSnap = await getDoc(parentRef);
    if (!parentSnap.exists()) {
      throw new Error("Parent document not found");
    }
    const parentData = parentSnap.data();
    if (parentData?.deleted === true || parentData?.deletedAt != null) {
      throw new Error("Parent document is deleted");
    }
    if (parentData?.spaceId !== spaceId) {
      throw new Error("Parent document belongs to a different space");
    }
    path = calculateNewPath(parentData?.path, parentId);
    if (path.length > 3) {
      throw new Error("Document creation exceeds maximum hierarchy depth of 4 levels");
    }
  }

  const title = options?.title || "Untitled";
  const content = options?.content ?? null;
  const outboundLinks = content ? extractLinks(content) : [];

  const newDoc = {
    spaceId,
    title,
    parentId,
    path, 
    tags: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    revision: 1,
    lock: null,
    outboundLinks,
    backlinks: [],
    deleted: false,
  };

  const contentRef = doc(db, "documents", docId, "content", "main");
  const batch = writeBatch(db);
  batch.set(docRef, newDoc);
  batch.set(contentRef, { content });
  await batch.commit();

  return docId;
}

export function isFirestorePermissionDeniedError(error: unknown): boolean {
  if (error instanceof FirestoreError) {
    return error.code === "permission-denied";
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    return code === "permission-denied" || code === "firestore/permission-denied";
  }
  return false;
}

export async function getDocument(id: string): Promise<Document | null> {
  const docRef = doc(db, "documents", id);
  let docSnap: DocumentSnapshot;
  try {
    docSnap = await getDoc(docRef);
  } catch (error: unknown) {
    if (isFirestorePermissionDeniedError(error)) {
      return null;
    }
    throw error;
  }

  if (docSnap.exists()) {
    const data = docSnap.data();
    const docData = { 
        id: docSnap.id, 
        ...data 
    } as Document;

    if (Boolean(docData.deleted) || docData.deletedAt != null) {
      return null;
    }

    // Fetch content from subcollection
    const contentRef = doc(db, "documents", id, "content", "main");
    let contentSnap: DocumentSnapshot;
    try {
      contentSnap = await getDoc(contentRef);
    } catch (error: unknown) {
      if (isFirestorePermissionDeniedError(error)) {
        return null;
      }
      throw error;
    }
    if (contentSnap.exists()) {
        docData.content = contentSnap.data().content;
    } else {
        docData.content = null;
    }

    // Sign images for private bucket access
    if (docData.content) {
        const images = extractImageUrls(docData.content);
        const mapping: Record<string, string> = {};
        
        const idToken = await auth.currentUser?.getIdToken();

        await Promise.all(images.map(async (url) => {
            try {
                // Extract key from URL
                // URL format: https://bucket.s3.region.amazonaws.com/path/to/key
                const urlObj = new URL(url);
                const path = decodeURIComponent(urlObj.pathname); // e.g. /path/to/key
                
                // We expect keys to start with 'uploads/' or 'temp/'
                // Remove leading slash if present
                const key = path.startsWith('/') ? path.substring(1) : path;
                
                const signedUrl = await getPresignedGetUrl(idToken, docData.spaceId, docData.id, key);
                if (signedUrl) {
                    mapping[url] = signedUrl;
                }
            } catch {
                console.error("Failed to sign url:", url);
            }
        }));

        docData.content = replaceImageUrls(docData.content, mapping);
    }

    return docData;
  } else {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractLinks(content: any): string[] {
  const links = new Set<string>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function traverse(node: any) {
    if (node.marks) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      node.marks.forEach((mark: any) => {
        if (mark.type === 'link') {
          const href = mark.attrs.href;
          if (href && href.includes('/doc/')) {
             const id = href.split('/doc/')[1];
             if (id) links.add(id);
          }
        }
      });
    }
    if (node.content) {
      node.content.forEach(traverse);
    }
  }

  if (content) traverse(content);
  return Array.from(links);
}

export interface UpdateDocumentData {
  id?: string;
  title?: string;
  tags?: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content?: any;
  baseRevision?: number | null;
  baseUpdatedAt?: Timestamp | Date | number | null;
}

export interface UpdateDocumentOptions {
  baseRevision?: number | null;
  baseUpdatedAt?: Timestamp | Date | number | null;
}

export interface UpdateDocumentResult {
  contentSaved: boolean;
  cleanupPending: boolean;
  cleanupError?: string | null;
}

export async function updateDocument(
  id: string,
  data: UpdateDocumentData,
  options?: UpdateDocumentOptions
): Promise<UpdateDocumentResult> {
  const idToken = await auth.currentUser?.getIdToken();
  return updateDocumentAction(idToken, id, data, options);
}

export interface DeleteDocumentOptions {
  strategy?: "move-descendants" | "delete-subtree";
  destinationParentId?: string | null;
}

export async function deleteDocument(
  id: string,
  optionsOrUserId?: DeleteDocumentOptions | string
) {
  const docRef = doc(db, "documents", id);
  const docSnap = await getDoc(docRef);
  if (!docSnap.exists()) {
    throw new Error("Document not found");
  }
  const data = docSnap.data();
  const spaceId = data.spaceId;

  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) {
    throw new Error("Authentication required");
  }

  let strategy: "move-descendants" | "delete-subtree" = "move-descendants";
  let destinationParentId: string | null = data.parentId || null;

  if (optionsOrUserId && typeof optionsOrUserId === "object") {
    if (optionsOrUserId.strategy) strategy = optionsOrUserId.strategy;
    if (optionsOrUserId.destinationParentId !== undefined) {
      destinationParentId = optionsOrUserId.destinationParentId;
    }
  }

  return await softDeleteDocumentAction(idToken, spaceId, id, strategy, destinationParentId);
}

export async function getDeletedDocuments(spaceId: string): Promise<Document[]> {
    try {
        const q = query(
            collection(db, "documents"), 
            where("spaceId", "==", spaceId),
            where("deleted", "==", true),
            orderBy("deletedAt", "desc")
        );
        const querySnapshot = await getDocs(q);
        const docs: Document[] = [];
        querySnapshot.forEach((doc) => {
            const data = doc.data();
            docs.push({ id: doc.id, ...data } as Document);
        });
        console.log("Fetched deleted documents:", docs);
        return docs;
    } catch (error) {
        console.error("Error fetching deleted documents:", error);
        throw error;
    }
}

export async function restoreDocument(id: string, destination: RestoreDestination = { kind: "original" }) {
    const docRef = doc(db, "documents", id);
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) {
        throw new Error("Document not found");
    }
    const data = docSnap.data();
    if (data.permanentDeletionClaim) {
        throw new Error("Cannot restore a document that is pending permanent deletion");
    }
    const spaceId = data.spaceId;

    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) {
        throw new Error("Authentication required");
    }

    try {
        return await restoreDocumentAction(idToken, spaceId, id, destination);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Invalid or expired ID token")) {
            await updateDoc(docRef, {
                deleted: false,
                deletedAt: null,
                deletedBy: null,
            });
            return { restoredCount: 1, restoredIds: [id] };
        }
        throw error;
    }
}

export async function getDocumentDescendantSummary(spaceId: string, docId: string) {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) {
        throw new Error("Authentication required");
    }
    return await getDocumentDescendantSummaryAction(idToken, spaceId, docId);
}

export async function permanentlyDeleteDocument(spaceIdOrDocId: string, docId?: string) {
    let actualSpaceId = spaceIdOrDocId;
    let actualDocId = docId;

    if (!actualDocId) {
        actualDocId = spaceIdOrDocId;
        const docRef = doc(db, "documents", actualDocId);
        const docSnap = await getDoc(docRef);
        if (!docSnap.exists()) {
            throw new Error("Document not found");
        }
        actualSpaceId = docSnap.data().spaceId;
    }

    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) {
        throw new Error("Authentication required");
    }

    return await permanentlyDeleteDocumentAction(idToken, actualSpaceId, actualDocId);
}

export async function getSidebarTree(spaceId: string): Promise<SidebarNode[]> {
  try {
    const spaceSnap = await getDoc(doc(db, "spaces", spaceId));
    if (!spaceSnap.exists() || spaceSnap.data()?.deletedAt) {
      return [];
    }
  } catch {
    return [];
  }

  const q = query(
      collection(db, "documents"), 
      where("spaceId", "==", spaceId),
      orderBy("title", "asc")
  );
  const querySnapshot = await getDocs(q);
  
  const docs: { id: string; title: string; parentId: string | null }[] = [];
  
  querySnapshot.forEach((doc) => {
    const data = doc.data();
    if (!data.deleted) {
        docs.push({
          id: doc.id,
          title: data.title || "Untitled",
          parentId: data.parentId || null,
        });
    }
  });

  // Build tree
  const tree: SidebarNode[] = [];
  const map = new Map<string, SidebarNode>();

  // Initialize map
  docs.forEach((d) => {
    map.set(d.id, { ...d, children: [] });
  });

  // Connect nodes
  docs.forEach((d) => {
    const node = map.get(d.id)!;
    if (d.parentId && map.has(d.parentId)) {
      map.get(d.parentId)!.children.push(node);
    } else {
      tree.push(node);
    }
  });

  return tree;
}

export async function searchDocuments(queryText: string, spaceId: string, currentDocId?: string): Promise<{ id: string; title: string }[]> {
  try {
    // Firestore does not support native text search.
    // We will use a simple prefix match for now, or just client-side filtering if the set is small.
    // For scalability, we should ideally use Algolia or similar, but for this app size:
    
    // Option 1: Fetch all titles in space and filter (simplest for < 1000 docs)
    // Option 2: Prefix query (case sensitive usually)
    
    // Let's go with Option 1 for best UX (case-insensitive fuzzy-ish) without external deps
    // We can reuse getSidebarTree logic but flatter
    
    const q = query(
        collection(db, "documents"), 
        where("spaceId", "==", spaceId),
        // where("deleted", "==", false) -- removed because legacy docs might miss this field
    );
    
    const querySnapshot = await getDocs(q);
    const results: { id: string; title: string }[] = [];
    
    const lowerQuery = queryText.toLowerCase();
    
    querySnapshot.forEach((doc) => {
        if (currentDocId && doc.id === currentDocId) return;
        const data = doc.data();
        if (data.deleted) return; 

        const title = data.title || "Untitled";
        if (title.toLowerCase().includes(lowerQuery)) {
            results.push({
                id: doc.id,
                title: title
            });
        }
    });
    
    // Sort by relevance (exact match first, then starts with, then includes)
    results.sort((a, b) => {
        const aTitle = a.title.toLowerCase();
        const bTitle = b.title.toLowerCase();
        
        const aExact = aTitle === lowerQuery;
        const bExact = bTitle === lowerQuery;
        if (aExact && !bExact) return -1;
        if (!aExact && bExact) return 1;
        
        const aStarts = aTitle.startsWith(lowerQuery);
        const bStarts = bTitle.startsWith(lowerQuery);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        
        return a.title.localeCompare(b.title);
    });

    return results.slice(0, 10); // Limit to 10 suggestions
  } catch (error) {
    console.error("Error searching documents:", error);
    return [];
  }
}

export async function moveDocument(id: string, newParentId: string | null): Promise<void> {
  if (!id || typeof id !== "string") {
    throw new Error("Invalid document ID");
  }
  if (newParentId !== null && typeof newParentId !== "string") {
    throw new Error("Invalid parent ID");
  }

  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error("Authentication required");
  }

  const idToken = await currentUser.getIdToken(true);
  if (!idToken) {
    throw new Error("Authentication required");
  }

  try {
    await moveDocumentAction(idToken, id, newParentId);
  } catch (error: unknown) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    if (
      rawMessage.includes("maximum hierarchy depth") ||
      rawMessage.includes("Destination") ||
      rawMessage.includes("locked by another") ||
      rawMessage.includes("Cannot move") ||
      rawMessage.includes("not found") ||
      rawMessage.includes("Permission denied") ||
      rawMessage.includes("Authentication required") ||
      rawMessage.includes("exceeds safe atomic limit") ||
      rawMessage.includes("pending permanent deletion")
    ) {
      throw new Error(rawMessage);
    }
    throw new Error("Failed to move document. Please try again.");
  }
}
