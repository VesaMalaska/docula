import { db } from "@/lib/firebase";
import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  addDoc, 
  updateDoc,
  runTransaction,
  serverTimestamp, 
  query,
  orderBy
} from "firebase/firestore";
import { Document, SidebarNode } from "@/lib/types";

export async function createDocument(parentId: string | null = null, userId: string) {
  const newDoc = {
    title: "Untitled",
    content: {}, 
    parentId,
    path: [], 
    tags: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lock: null,
    outboundLinks: [],
    backlinks: []
  };

  const docRef = await addDoc(collection(db, "documents"), newDoc);
  return docRef.id;
}

export async function getDocument(id: string): Promise<Document | null> {
  const docRef = doc(db, "documents", id);
  const docSnap = await getDoc(docRef);

  if (docSnap.exists()) {
    const data = docSnap.data();
    return { 
        id: docSnap.id, 
        ...data 
    } as Document;
  } else {
    return null;
  }
}

function extractLinks(content: any): string[] {
  const links = new Set<string>();

  function traverse(node: any) {
    if (node.marks) {
      node.marks.forEach((mark: any) => {
        if (mark.type === 'link') {
          const href = mark.attrs.href;
          if (href && href.startsWith('/doc/')) {
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
  const { id: _, ...updateData } = data as any;
  updateData.updatedAt = serverTimestamp();

  if (data.content) {
      const newOutboundLinks = extractLinks(data.content);
      
      await runTransaction(db, async (transaction) => {
          const docSnap = await transaction.get(docRef);
          if (!docSnap.exists()) throw new Error("Doc not found");
          
          const currentDoc = docSnap.data();
          const oldOutboundLinks = currentDoc.outboundLinks || [];
          
          const added = newOutboundLinks.filter(l => !oldOutboundLinks.includes(l));
          const removed = oldOutboundLinks.filter((l: string) => !newOutboundLinks.includes(l));
          
          transaction.update(docRef, {
              ...updateData,
              outboundLinks: newOutboundLinks
          });
          
          for (const targetId of added) {
              const targetRef = doc(db, "documents", targetId);
              const targetSnap = await transaction.get(targetRef);
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
          
          for (const targetId of removed) {
              const targetRef = doc(db, "documents", targetId);
              const targetSnap = await transaction.get(targetRef);
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

export async function deleteDocument(id: string) {
  const docRef = doc(db, "documents", id);
  await updateDoc(docRef, { deleted: true });
}

export async function getSidebarTree(): Promise<SidebarNode[]> {
  const q = query(collection(db, "documents"), orderBy("title", "asc"));
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
