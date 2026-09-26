import { db, auth } from "@/lib/firebase";
import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  updateDoc,
  runTransaction,
  serverTimestamp, 
  query,
  orderBy,
  where,
  writeBatch,
  DocumentSnapshot,
  FirestoreError,
  deleteField,
  type Timestamp
} from "firebase/firestore";
import type { Document, SidebarNode, RestoreDestination } from "@/lib/types";
import { getPresignedGetUrl, cleanupRemovedDocumentImages } from "./s3";
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

function normalizeImageKey(urlOrKey: string): string {
  try {
    const urlObj = new URL(urlOrKey);
    let path = decodeURIComponent(urlObj.pathname);
    if (path.startsWith("/")) path = path.substring(1);
    if (path.startsWith("deleted/uploads/")) path = path.substring(16);
    else if (path.startsWith("uploads/")) path = path.substring(8);
    return path;
  } catch {
    let path = urlOrKey.startsWith("/") ? urlOrKey.substring(1) : urlOrKey;
    if (path.startsWith("deleted/uploads/")) path = path.substring(16);
    else if (path.startsWith("uploads/")) path = path.substring(8);
    return path;
  }
}

function getTimestampMillis(ts: unknown): number | null {
    if (!ts) return null;
    if (typeof ts === "number") return ts;
    if (ts instanceof Date) return ts.getTime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (ts as any).toMillis === "function") return (ts as any).toMillis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (ts as any).toDate === "function") return (ts as any).toDate().getTime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (ts as any).seconds === "number") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (ts as any).seconds * 1000 + Math.floor(((ts as any).nanoseconds || 0) / 1_000_000);
    }
    return null;
}

export interface UpdateDocumentData extends Partial<Document> {
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
  const docRef = doc(db, "documents", id);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
  const { id: _, content: contentField, baseRevision: dataBaseRevision, baseUpdatedAt: dataBaseUpdatedAt, ...updateData } = data as any;
  const baseRevision = options?.baseRevision !== undefined ? options.baseRevision : dataBaseRevision;
  const baseUpdatedAt = options?.baseUpdatedAt !== undefined ? options.baseUpdatedAt : dataBaseUpdatedAt;
  updateData.updatedAt = serverTimestamp();

  if (contentField !== undefined) {
      // Mandatory base revision validation for all content saves
      if (
          baseRevision === undefined ||
          baseRevision === null ||
          typeof baseRevision !== "number" ||
          !Number.isInteger(baseRevision) ||
          baseRevision < 0
      ) {
          throw new Error("Cannot save document: missing or invalid base revision for content save.");
      }

      const newOutboundLinks = extractLinks(contentField);
      const contentRef = doc(db, "documents", id, "content", "main");
      
      let hasPendingCleanup = false;
      let docSpaceId = "";

      await runTransaction(db, async (transaction) => {
          // Phase 1: READ ALL
          const docSnap = await transaction.get(docRef);
          if (!docSnap.exists()) throw new Error("Doc not found");
          
          const currentDoc = docSnap.data();
          const currentRevision = typeof currentDoc.revision === "number" ? currentDoc.revision : 0;

          // Rule 0: Mandatory Stale-save protection (Optimistic Concurrency Control via Revision)
          if (baseRevision !== currentRevision) {
              throw new Error(
                  "Cannot save document: document has been modified by another edit. Please reload before saving."
              );
          }

          docSpaceId = currentDoc.spaceId;
          const oldOutboundLinks = currentDoc.outboundLinks || [];
          
          const added = newOutboundLinks.filter(l => !oldOutboundLinks.includes(l));
          const removed = oldOutboundLinks.filter((l: string) => !newOutboundLinks.includes(l));
          
          // Pre-fetch all targets to ensure we read everything before any write
          const allTargetIds = [...new Set([...added, ...removed])];
          const targetSnaps: Record<string, DocumentSnapshot> = {};
          
          for (const targetId of allTargetIds) {
             const targetRef = doc(db, "documents", targetId);
             // Note: if targetId is same as id, we already read it in docSnap?
             // Not necessarily for the purpose of this map, but firestore handles redundant reads if they are same ref efficiently usually.
             // However, to be safe and avoid read-start-after-write if logic gets complex:
             if (targetId === id) {
                 targetSnaps[targetId] = docSnap;
             } else {
                 targetSnaps[targetId] = await transaction.get(targetRef);
             }
          }

          // Read previous content in Phase 1
          const contentSnap = await transaction.get(contentRef);
          const previousContent = contentSnap.exists() ? contentSnap.data()?.content : null;
          const oldImageUrls = extractImageUrls(previousContent);
          const newImageUrls = extractImageUrls(contentField);

          const newImageKeysSet = new Set(newImageUrls.map(normalizeImageKey));

          // Rule 1A: Check if new content attempts to reference an image claimed for S3 deletion.
          // Claim expiry enables cleanup recovery, but must NOT authorize reintroducing a key
          // while an older S3 deletion can still be in flight or finish.
          const activeClaim = currentDoc.imageCleanupClaim;
          if (activeClaim && Array.isArray(activeClaim.keys) && activeClaim.keys.length > 0) {
              const claimedKeysSet = new Set(activeClaim.keys.map(normalizeImageKey));
              for (const newKey of Array.from(newImageKeysSet)) {
                  if (claimedKeysSet.has(newKey)) {
                      throw new Error(
                          `Cannot save document: image is currently being deleted by a prior edit. Please re-upload the image.`
                      );
                  }
              }
          }

          // Rule 1B: Check if new content attempts to reference an image that was already retired (deleted from S3)
          const retiredKeys = currentDoc.retiredImageKeys;
          if (Array.isArray(retiredKeys) && retiredKeys.length > 0) {
              const retiredKeysSet = new Set(retiredKeys.map(normalizeImageKey));
              for (const newKey of Array.from(newImageKeysSet)) {
                  if (retiredKeysSet.has(newKey)) {
                      throw new Error(
                          `Cannot save document: image has been deleted by a prior edit. Please re-upload the image.`
                      );
                  }
              }
          }

          const newlyRemoved = oldImageUrls.filter((u) => !newImageKeysSet.has(normalizeImageKey(u)));

          const pendingSet = new Set<string>(
              Array.isArray(currentDoc.pendingImageCleanup) ? currentDoc.pendingImageCleanup : []
          );
          for (const url of newlyRemoved) {
              pendingSet.add(url);
          }

          // Rule 2: If new content contains/re-adds any previously pending image (not in active claim), rescue it
          for (const key of Array.from(pendingSet)) {
              if (newImageKeysSet.has(normalizeImageKey(key))) {
                  pendingSet.delete(key);
              }
          }

          hasPendingCleanup = pendingSet.size > 0;

          // Phase 2: WRITE ALL
          
          const nextRevision = currentRevision + 1;
          // Update main doc
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const docUpdatePayload: Record<string, any> = {
              ...updateData,
              revision: nextRevision,
              outboundLinks: newOutboundLinks
          };
          if (hasPendingCleanup) {
              docUpdatePayload.pendingImageCleanup = Array.from(pendingSet);
          } else if (currentDoc.pendingImageCleanup !== undefined) {
              docUpdatePayload.pendingImageCleanup = deleteField();
          }

          transaction.update(docRef, docUpdatePayload);

          // Write to subcollection
          transaction.set(contentRef, { content: contentField });
          
          // Update added backlinks
          for (const targetId of added) {
              const targetRef = doc(db, "documents", targetId);
              const targetSnap = targetSnaps[targetId];
              
              if (targetSnap.exists()) {
                  const targetData = targetSnap.data();
                  const backlinks = targetData.backlinks || [];
                  if (!backlinks.includes(id)) {
                      transaction.update(targetRef, {
                          backlinks: [...backlinks, id]
                      });
                  }
              }
          }
          
          // Update removed backlinks
          for (const targetId of removed) {
              const targetRef = doc(db, "documents", targetId);
              const targetSnap = targetSnaps[targetId]; // Use pre-fetched snapshot
              
              if (targetSnap.exists()) {
                   const targetData = targetSnap.data();
                   const backlinks = targetData.backlinks || [];
                   const newBacklinks = backlinks.filter((bid: string) => bid !== id);
                   transaction.update(targetRef, {
                       backlinks: newBacklinks
                   });
              }
          }
      });

      if (hasPendingCleanup) {
          const idToken = await auth.currentUser?.getIdToken();
          if (docSpaceId) {
              try {
                  const cleanupResult = await cleanupRemovedDocumentImages(idToken, docSpaceId, id);
                  if (cleanupResult && cleanupResult.remainingPendingCount > 0) {
                      return { contentSaved: true, cleanupPending: true };
                  }
                  return { contentSaved: true, cleanupPending: false };
              } catch (cleanupErr) {
                  console.warn("Storage cleanup for removed images failed post-save; pendingImageCleanup retained for retry:", cleanupErr);
                  return {
                      contentSaved: true,
                      cleanupPending: true,
                      cleanupError: cleanupErr instanceof Error ? cleanupErr.message : "Cleanup failed",
                  };
              }
          }
      }

      return { contentSaved: true, cleanupPending: false };
  } else {
      if (baseRevision !== undefined && baseRevision !== null) {
          const docSnap = await getDoc(docRef);
          if (docSnap.exists()) {
              const currentDoc = docSnap.data();
              const currentRevision = typeof currentDoc.revision === "number" ? currentDoc.revision : 0;
              if (
                  typeof baseRevision !== "number" ||
                  !Number.isInteger(baseRevision) ||
                  baseRevision < 0 ||
                  baseRevision !== currentRevision
              ) {
                  throw new Error(
                      "Cannot save document: document has been modified by another edit. Please reload before saving."
                  );
              }
              updateData.revision = currentRevision + 1;
          }
      } else if (baseUpdatedAt !== undefined && baseUpdatedAt !== null) {
          const docSnap = await getDoc(docRef);
          if (docSnap.exists()) {
              const currentDoc = docSnap.data();
              const currentMillis =
                  getTimestampMillis(currentDoc.updatedAt) ?? getTimestampMillis(currentDoc.createdAt);
              const baseMillis = getTimestampMillis(baseUpdatedAt);
              if (currentMillis !== null && baseMillis !== null && currentMillis !== baseMillis) {
                  throw new Error(
                      "Cannot save document: document has been modified by another edit. Please reload before saving."
                  );
              }
          }
      }
      await updateDoc(docRef, updateData);
      return { contentSaved: true, cleanupPending: false };
  }
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

export async function searchDocuments(queryText: string, spaceId: string): Promise<{ id: string; title: string }[]> {
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
