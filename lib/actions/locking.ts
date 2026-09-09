import { db } from "@/lib/firebase";
import { doc, runTransaction, Timestamp } from "firebase/firestore";

const LOCK_TTL_MINUTES = 5;

export type AcquireLockResult = {
  success: boolean;
  reason?: "locked" | "permission_denied" | "not_found" | "error";
  message?: string;
  lockedBy?: string;
};

export async function acquireLock(
  docId: string,
  userId: string,
  userName: string
): Promise<AcquireLockResult> {
  const docRef = doc(db, "documents", docId);

  try {
    let lockHolder: string | undefined;
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
            lockHolder = currentLock.userName || "another user";
            throw new Error(`Locked by ${lockHolder}`);
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
    return { success: true };
  } catch (e: unknown) {
    console.error("Failed to acquire lock:", e);
    const msg = e instanceof Error ? e.message : String(e);
    const code = e && typeof e === "object" && "code" in e ? (e as { code: unknown }).code : "";

    if (msg.startsWith("Locked by")) {
      return { success: false, reason: "locked", message: msg, lockedBy: msg.replace("Locked by ", "") };
    }
    if (
      code === "permission-denied" ||
      msg.toLowerCase().includes("permission-denied") ||
      msg.toLowerCase().includes("permission denied")
    ) {
      return {
        success: false,
        reason: "permission_denied",
        message: "You do not have permission to edit documents in this space. Join the space to contribute.",
      };
    }
    if (msg === "Document does not exist") {
      return { success: false, reason: "not_found", message: msg };
    }
    return { success: false, reason: "error", message: msg };
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
