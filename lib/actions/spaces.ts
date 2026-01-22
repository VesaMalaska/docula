import { db, auth } from "@/lib/firebase";
import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  addDoc, 
  updateDoc, 
  query, 
  where, 
  serverTimestamp,
  orderBy,
  deleteDoc
} from "firebase/firestore";
import { Space } from "@/lib/types";

export async function createSpace(name: string, isPublic: boolean, description: string = "", ownerId: string) {
  const newSpace = {
    name,
    description,
    isPublic,
    ownerId,
    userIds: [ownerId],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
      const docRef = await addDoc(collection(db, "spaces"), newSpace);
      return docRef.id;
  } catch (e) {
      console.error("Error creating space:", e);
      throw e;
  }
}

export async function joinSpace(spaceId: string, userId: string): Promise<boolean> {
  const spaceRef = doc(db, "spaces", spaceId);

  try {
    const spaceSnap = await getDoc(spaceRef);

    if (spaceSnap.exists()) {
      const data = spaceSnap.data();
      // Check if already a member to avoid unnecessary writes
      if (data.userIds && data.userIds.includes(userId)) {
          console.log(`User ${userId} is already a member of space ${spaceId}`);
          return true;
      }

      if (data.isPublic) {
        await updateDoc(spaceRef, {
          userIds: [...(data.userIds || []), userId]
        });
        console.log(`User ${userId} joined space ${spaceId}`);
        return true;
      } else {
          console.warn(`User ${userId} attempted to join private space ${spaceId}`);
      }
    } else {
        console.error(`Space ${spaceId} not found`);
    }
  } catch (error) {
    console.error(`Error joining space ${spaceId} for user ${userId}:`, error);
    throw error;
  }
  return false;
}

export async function leaveSpace(spaceId: string, userId: string) {
    const spaceRef = doc(db, "spaces", spaceId);
    const spaceSnap = await getDoc(spaceRef);
  
    if (spaceSnap.exists()) {
      const data = spaceSnap.data();
      if (data.userIds.includes(userId)) {
        await updateDoc(spaceRef, {
          userIds: data.userIds.filter((id: string) => id !== userId)
        });
      }
    }
}

export async function getSpacesForUser(userId: string): Promise<Space[]> {
    const q = query(
        collection(db, "spaces"), 
        where("userIds", "array-contains", userId),
        orderBy("createdAt", "desc")
    );
    const querySnapshot = await getDocs(q);
    const spaces: Space[] = [];
    querySnapshot.forEach((doc) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = doc.data() as any; // Cast to any to handle timestamps
        // Filter out soft-deleted spaces (where deletedAt is set)
        if (!data.deletedAt) {
             spaces.push({ 
                id: doc.id, 
                ...data 
            } as Space);
        }
    });
    return spaces;
}

export async function getPublicSpaces(): Promise<Space[]> {
    const q = query(
        collection(db, "spaces"), 
        where("isPublic", "==", true),
        orderBy("createdAt", "desc")
    );
    const querySnapshot = await getDocs(q);
    const spaces: Space[] = [];
    querySnapshot.forEach((doc) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = doc.data() as any; 
        if (!data.deletedAt) {
            spaces.push({ 
                id: doc.id, 
                ...data 
            } as Space);
        }
    });
    return spaces;
}

export async function getSpace(spaceId: string): Promise<Space | null> {
    const docRef = doc(db, "spaces", spaceId);
    const docSnap = await getDoc(docRef);

    if (docSnap.exists()) {
        const data = docSnap.data();
        return { id: docSnap.id, ...data } as Space;
    }
    return null;
}

export async function getDeletedSpacesForUser(userId: string): Promise<Space[]> {
    // Only show spaces where the user is the owner
    const q = query(
        collection(db, "spaces"), 
        where("ownerId", "==", userId),
        where("deletedAt", "!=", null),
        orderBy("deletedAt", "desc")
    );
    const querySnapshot = await getDocs(q);
    const spaces: Space[] = [];
    querySnapshot.forEach((doc) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = doc.data() as any;
        spaces.push({ 
            id: doc.id, 
            ...data 
        } as Space);
    });
    return spaces;
}

export async function deleteSpace(spaceId: string, userId: string) {
    const spaceRef = doc(db, "spaces", spaceId);
    await updateDoc(spaceRef, {
        deletedAt: serverTimestamp(),
        deletedBy: userId
    });
}

export async function restoreSpace(spaceId: string) {
    const spaceRef = doc(db, "spaces", spaceId);
    await updateDoc(spaceRef, {
        deletedAt: null,
        deletedBy: null
    });
}

import { getDeletedDocuments, permanentlyDeleteDocument } from "./document";

export async function permanentlyDeleteSpace(spaceId: string) {
    // 1. Permanently delete all documents in the space
    // We can re-use getDeletedDocuments API-wise, but we actually want ALL documents (even not deleted ones?)
    // Actually, if space is deleted, documents might still be there.
    // Let's use getDocs directly here to be safe and thorough.
    
    // NOTE: Ideally this should be a backend function / recursive delete.
    // Doing it client side has risk of timeout for large spaces.
    
    const q = query(collection(db, "documents"), where("spaceId", "==", spaceId));
    const querySnapshot = await getDocs(q);
    
    // Delete documents one by one (to handle image deletion logic in permanentlyDeleteDocument)
    const deletePromises = querySnapshot.docs.map(doc => permanentlyDeleteDocument(doc.id));
    await Promise.all(deletePromises);

    // 2. Delete the space itself
    await deleteDoc(doc(db, "spaces", spaceId));
}
