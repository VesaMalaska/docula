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
  deleteDoc,
  writeBatch,
  DocumentSnapshot,
  FirestoreError
} from "firebase/firestore";
import type { Document, SidebarNode } from "@/lib/types";
import { getPresignedGetUrl, softDeleteImages, permanentDeleteImages, restoreImages } from "./s3";
import { extractImageUrls, replaceImageUrls } from "../utils";
import { calculateNewPath, calculateDescendantPath, calculateSubtreeHeightFromPaths } from "../utils/hierarchy";

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

export async function updateDocument(id: string, data: Partial<Document>) {
  const docRef = doc(db, "documents", id);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
  const { id: _, content: contentField, ...updateData } = data as any;
  updateData.updatedAt = serverTimestamp();

  if (contentField !== undefined) {
      const newOutboundLinks = extractLinks(contentField);
      const contentRef = doc(db, "documents", id, "content", "main");
      
      await runTransaction(db, async (transaction) => {
          // Phase 1: READ ALL
          const docSnap = await transaction.get(docRef);
          if (!docSnap.exists()) throw new Error("Doc not found");
          
          const currentDoc = docSnap.data();
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

          // Phase 2: WRITE ALL
          
          // Update main doc
          transaction.update(docRef, {
              ...updateData,
              outboundLinks: newOutboundLinks
          });

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
  } else {
      await updateDoc(docRef, updateData);
  }
}

export async function deleteDocument(id: string, userId: string = "unknown") {
  const docRef = doc(db, "documents", id);
  
  // Fetch document content to find images
  const docSnap = await getDoc(docRef);
  if (docSnap.exists()) {
      const data = docSnap.data();
      if (data.content) {
          const imageUrls = extractImageUrls(data.content);
          if (imageUrls.length > 0) {
              const idToken = await auth.currentUser?.getIdToken();
              await softDeleteImages(idToken, data.spaceId, id, imageUrls);
          }
      }
  }

  await updateDoc(docRef, { 
      deleted: true,
      deletedAt: serverTimestamp(),
      deletedBy: userId
  });
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

export async function restoreDocument(id: string) {
    const docRef = doc(db, "documents", id);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
        const data = docSnap.data();
        if (data.content) {
            const imageUrls = extractImageUrls(data.content);
            if (imageUrls.length > 0) {
                const idToken = await auth.currentUser?.getIdToken();
                await restoreImages(idToken, data.spaceId, id, imageUrls);
            }
        }
    }
    await updateDoc(docRef, { 
        deleted: false,
        deletedAt: null,
        deletedBy: null
    });
}

export async function permanentlyDeleteDocument(id: string) {
    const docRef = doc(db, "documents", id);
    const docSnap = await getDoc(docRef);
    
    if (docSnap.exists()) {
        const data = docSnap.data();
        // 1. Discover content (either from subcollection /content/main or inline legacy)
        let content = data.content;
        const contentRef = doc(db, "documents", id, "content", "main");
        const contentSnap = await getDoc(contentRef);
        if (contentSnap.exists()) {
            content = contentSnap.data()?.content ?? content;
        }

        // 2. Permanently delete images from "deleted/" folder
        if (content) {
            const imageUrls = extractImageUrls(content);
            if (imageUrls.length > 0) {
                const idToken = await auth.currentUser?.getIdToken();
                await permanentDeleteImages(idToken, data.spaceId, id, imageUrls);
            }
        }

        // 3. Delete content subcollection document if present
        if (contentSnap.exists()) {
            await deleteDoc(contentRef);
        }

        // 4. Delete root document record
        await deleteDoc(docRef);
    }
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

export async function moveDocument(id: string, newParentId: string | null) {
  const docRef = doc(db, "documents", id);
  const docSnap = await getDoc(docRef);

  if (!docSnap.exists()) {
    throw new Error("Document not found");
  }

  const docData = docSnap.data();
  const spaceId = docData.spaceId;

  // No-op check
  if (docData.parentId === newParentId) {
    return; // Already in the requested location
  }

  // Prevent self-move
  if (id === newParentId) {
    throw new Error("Cannot move a document under itself");
  }

  let newPath: string[] = [];
  let destinationDepth = 0;
  
  if (newParentId) {
    const parentRef = doc(db, "documents", newParentId);
    const parentSnap = await getDoc(parentRef);
    
    if (!parentSnap.exists()) {
      throw new Error("Destination parent not found");
    }
    
    const parentData = parentSnap.data();

    if (parentData.deleted) {
      throw new Error("Destination parent not found");
    }
    
    // Validate same space
    if (parentData.spaceId !== spaceId) {
      throw new Error("Cannot move document to a different space");
    }

    // Prevent cycle (moving under a descendant)
    if ((parentData.path || []).includes(id)) {
      throw new Error("Cannot move a document under its own descendant");
    }
    
    destinationDepth = (parentData.path?.length || 0) + 1;
    newPath = calculateNewPath(parentData.path, newParentId);
  }

  // Find all descendants
  const descendantsQuery = query(
    collection(db, "documents"),
    where("spaceId", "==", spaceId),
    where("path", "array-contains", id)
  );
  
  const descendantsSnap = await getDocs(descendantsQuery);

  // Validate 4-level hierarchy depth invariant: destination depth + moved subtree height <= 4
  const descendantPaths = descendantsSnap.docs.map((d) => d.data().path || []);
  const subtreeHeight = calculateSubtreeHeightFromPaths(id, descendantPaths);

  if (destinationDepth + subtreeHeight > 4) {
    throw new Error("Moving this document exceeds the maximum hierarchy depth of 4 levels");
  }
  
  // Use a single batch for atomicity. If limit (500) exceeded, it will fail safely.
  const batch = writeBatch(db);
  
  if (descendantsSnap.docs.length + 1 > 500) {
     throw new Error("Move operation exceeds batch limits (500 docs). Too many descendants.");
  }
  
  // Update the moved document
  batch.update(docRef, {
    parentId: newParentId,
    path: newPath,
    updatedAt: serverTimestamp()
  });

  // Update descendants
  descendantsSnap.docs.forEach((descendantDoc) => {
    const descendantData = descendantDoc.data();
    const oldPath = descendantData.path || [];
    const index = oldPath.indexOf(id);
    
    if (index !== -1) {
      const descendantNewPath = calculateDescendantPath(oldPath, id, newPath);
      
      batch.update(descendantDoc.ref, {
        path: descendantNewPath,
        updatedAt: serverTimestamp()
      });
    }
  });

  await batch.commit();
}
