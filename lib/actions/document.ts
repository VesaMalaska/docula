import { db } from "@/lib/firebase";
import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  addDoc, 
  setDoc,
  updateDoc,
  runTransaction,
  serverTimestamp, 
  query,
  orderBy,
  where,
  deleteDoc
} from "firebase/firestore";
import { Document, SidebarNode } from "@/lib/types";
import { getPresignedGetUrl, softDeleteImages, permanentDeleteImages, restoreImages } from "./s3";
import { extractImageUrls, replaceImageUrls } from "../utils";

export async function createDocument(spaceId: string, parentId: string | null = null) {
  let path: string[] = [];
  
  if (parentId) {
    const parentRef = doc(db, "documents", parentId);
    const parentSnap = await getDoc(parentRef);
    if (parentSnap.exists()) {
      const parentData = parentSnap.data();
      path = [...(parentData.path || []), parentId];
    }
  }

  const newDoc = {
    spaceId,
    title: "Untitled",
    parentId,
    path, 
    tags: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lock: null,
    outboundLinks: [],
    backlinks: [],
    deleted: false,
  };

  const docRef = await addDoc(collection(db, "documents"), newDoc);
  const contentRef = doc(db, "documents", docRef.id, "content", "main");
  await setDoc(contentRef, { content: null });
  return docRef.id;
}

export async function getDocument(id: string): Promise<Document | null> {
  const docRef = doc(db, "documents", id);
  const docSnap = await getDoc(docRef);

  if (docSnap.exists()) {
    const data = docSnap.data();
    const docData = { 
        id: docSnap.id, 
        ...data 
    } as Document;

    // Fetch content from subcollection
    const contentRef = doc(db, "documents", id, "content", "main");
    const contentSnap = await getDoc(contentRef);
    if (contentSnap.exists()) {
        docData.content = contentSnap.data().content;
    } else {
        docData.content = null;
    }

    // Sign images for private bucket access
    if (docData.content) {
        const images = extractImageUrls(docData.content);
        const mapping: Record<string, string> = {};
        
        await Promise.all(images.map(async (url) => {
            try {
                // Extract key from URL
                // URL format: https://bucket.s3.region.amazonaws.com/path/to/key
                const urlObj = new URL(url);
                const path = decodeURIComponent(urlObj.pathname); // e.g. /path/to/key
                
                // We expect keys to start with 'uploads/' or 'temp/'
                // Remove leading slash if present
                const key = path.startsWith('/') ? path.substring(1) : path;
                
                const signedUrl = await getPresignedGetUrl(key);
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
          const targetSnaps: Record<string, any> = {};
          
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
              await softDeleteImages(imageUrls);
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
                await restoreImages(imageUrls);
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
        // Permanently delete images from "deleted/" folder
        if (data.content) {
            const imageUrls = extractImageUrls(data.content);
            if (imageUrls.length > 0) {
                // We need to construct the keys that are in the deleted/ folder
                // The softDeleteImages moved them to deleted/ prefix
                // The original URLs (e.g. key) mapping logic needs to handle this.
                // However, our helper is on S3 side. Let's make a specific helper for this.
                await permanentDeleteImages(imageUrls);
            }
        }
        await deleteDoc(docRef);
    }
}

export async function getSidebarTree(spaceId: string): Promise<SidebarNode[]> {
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
