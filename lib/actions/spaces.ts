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

export async function joinSpace(spaceId: string, userId: string) {
  const spaceRef = doc(db, "spaces", spaceId);
  const spaceSnap = await getDoc(spaceRef);

  if (spaceSnap.exists()) {
    const data = spaceSnap.data();
    if (data.isPublic && !data.userIds.includes(userId)) {
      await updateDoc(spaceRef, {
        userIds: [...data.userIds, userId]
      });
    }
  }
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
        spaces.push({ 
            id: doc.id, 
            ...data 
        } as Space);
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
        spaces.push({ 
            id: doc.id, 
            ...data 
        } as Space);
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

export async function deleteSpace(spaceId: string) {
    await deleteDoc(doc(db, "spaces", spaceId));
    // NOTE: Ideally we should delete all documents in this space as well.
    // implementing that requires a recursive deletion or a cloud function.
    // For now, let's leave documents orphaned or delete them if possible.
}
