import { db } from "@/lib/firebase";
import { doc, runTransaction, Timestamp } from "firebase/firestore";

const LOCK_TTL_MINUTES = 5;

export async function acquireLock(docId: string, userId: string, userName: string): Promise<boolean> {
  const docRef = doc(db, "documents", docId);

  try {
    await runTransaction(db, async (transaction) => {
      const docSnap = await transaction.get(docRef);
      if (!docSnap.exists()) throw new Error("Document does not exist");

      const data = docSnap.data();
      const currentLock = data.lock;
      const now = new Date();

      // Check if locked
      if (currentLock && currentLock.active) {
         const expiresAt = currentLock.expiresAt.toDate();
         if (expiresAt > now && currentLock.userId !== userId) {
            throw new Error(`Locked by ${currentLock.userName}`);
         }
      }

      // Set Lock
      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + LOCK_TTL_MINUTES);

      transaction.update(docRef, {
        lock: {
          active: true,
          userId,
          userName,
          expiresAt: Timestamp.fromDate(expiresAt)
        }
      });
    });
    return true;
  } catch (e) {
    console.error("Failed to acquire lock:", e);
    return false;
  }
}

export async function renewLock(docId: string, userId: string): Promise<boolean> {
   const docRef = doc(db, "documents", docId);
    try {
        await runTransaction(db, async (transaction) => {
             const docSnap = await transaction.get(docRef);
             if (!docSnap.exists()) throw new Error("Document does not exist");
             const data = docSnap.data();
             
             if (data.lock?.userId !== userId) {
                 throw new Error("Lost lock");
             }
             
             const expiresAt = new Date();
             expiresAt.setMinutes(expiresAt.getMinutes() + LOCK_TTL_MINUTES);
             
             transaction.update(docRef, {
                 "lock.expiresAt": Timestamp.fromDate(expiresAt)
             });
        });
        return true;
    } catch(e) {
        console.error("Renew lock failed", e);
        return false;
    }
}

export async function releaseLock(docId: string, userId: string): Promise<void> {
    const docRef = doc(db, "documents", docId);
    try {
        await runTransaction(db, async (transaction) => {
             const docSnap = await transaction.get(docRef);
             if (!docSnap.exists()) return;
             const data = docSnap.data();
             
             if (data.lock?.userId === userId) {
                  transaction.update(docRef, {
                     lock: null
                  });
             }
        });
    } catch(e) {
        console.error("Release lock failed", e);
    }
}
