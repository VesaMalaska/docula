import { auth, db } from "@/lib/firebase";
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
  arrayUnion,
  runTransaction
} from "firebase/firestore";
import type { Space } from "@/lib/types";
import { validateSpaceName } from "@/lib/space-validation";
import { validateMemberEmail, canRemoveMember, canLeaveSpace } from "@/lib/member-management";

export { validateSpaceName, validateMemberEmail, canRemoveMember, canLeaveSpace };
export type { SpaceNameValidationResult } from "@/lib/space-validation";
export type { MemberEmailValidationResult } from "@/lib/member-management";

export async function renameSpace(spaceId: string, name: string): Promise<string> {
  const validation = validateSpaceName(name);
  if (!validation.isValid) {
    throw new Error(validation.error || "Invalid space name");
  }

  const spaceRef = doc(db, "spaces", spaceId);
  await updateDoc(spaceRef, {
    name: validation.trimmedName,
    updatedAt: serverTimestamp(),
  });

  return validation.trimmedName;
}

export async function createSpace(name: string, isPublic: boolean, description: string = "", ownerId: string) {
  const validation = validateSpaceName(name);
  if (!validation.isValid) {
    throw new Error(validation.error || "Invalid space name");
  }

  const newSpace = {
    name: validation.trimmedName,
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

export async function joinSpace(spaceId: string, userIdArg?: string): Promise<boolean> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error("You must be signed in to join a space.");
  }
  if (userIdArg && userIdArg !== currentUser.uid) {
    throw new Error("Cannot join a space on behalf of another user.");
  }
  const userId = currentUser.uid;
  const spaceRef = doc(db, "spaces", spaceId);

  return await runTransaction(db, async (transaction) => {
    const spaceSnap = await transaction.get(spaceRef);
    if (!spaceSnap.exists()) {
      throw new Error("Space not found.");
    }

    const data = spaceSnap.data();
    if (!data.isPublic) {
      throw new Error("Cannot join a private space.");
    }
    if (data.deletedAt) {
      throw new Error("Cannot join a deleted space.");
    }

    const userIds: string[] = Array.isArray(data.userIds) ? data.userIds : [];
    if (userIds.includes(userId)) {
      return true;
    }

    transaction.update(spaceRef, {
      userIds: arrayUnion(userId),
      updatedAt: serverTimestamp(),
    });

    return true;
  });
}

export async function removeMemberFromSpace(spaceId: string, memberId: string): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error("You must be signed in to remove a member.");
  }
  const callerId = currentUser.uid;

  const spaceRef = doc(db, "spaces", spaceId);

  await runTransaction(db, async (transaction) => {
    const spaceSnap = await transaction.get(spaceRef);
    if (!spaceSnap.exists()) {
      throw new Error("Space not found.");
    }

    const data = spaceSnap.data();

    if (data.deletedAt) {
      throw new Error("Cannot modify a deleted space.");
    }

    const userIds: string[] = Array.isArray(data.userIds) ? data.userIds : [];
    const ownerId: string = data.ownerId;

    const validation = canRemoveMember({
      callerId,
      ownerId,
      targetMemberId: memberId,
      userIds,
    });

    if (!validation.isValid) {
      throw new Error(validation.error || "Failed to remove member.");
    }

    transaction.update(spaceRef, {
      userIds: userIds.filter((id: string) => id !== memberId),
      updatedAt: serverTimestamp(),
    });
  });
}

export async function leaveSpace(spaceId: string): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error("You must be signed in to leave a space.");
  }
  const callerId = currentUser.uid;

  const spaceRef = doc(db, "spaces", spaceId);

  await runTransaction(db, async (transaction) => {
    const spaceSnap = await transaction.get(spaceRef);
    if (!spaceSnap.exists()) {
      throw new Error("Space not found.");
    }

    const data = spaceSnap.data();

    if (data.deletedAt) {
      throw new Error("Cannot modify a deleted space.");
    }

    const userIds: string[] = Array.isArray(data.userIds) ? data.userIds : [];
    const ownerId: string = data.ownerId;

    const validation = canLeaveSpace({
      callerId,
      ownerId,
      userIds,
    });

    if (!validation.isValid) {
      throw new Error(validation.error || "Failed to leave space.");
    }

    transaction.update(spaceRef, {
      userIds: userIds.filter((id: string) => id !== callerId),
      updatedAt: serverTimestamp(),
    });
  });
}

export async function addMemberToSpace(
  spaceId: string,
  email: string
): Promise<{ uid: string; email: string }> {
  const validation = validateMemberEmail(email);
  if (!validation.isValid) {
    throw new Error(validation.error || "Please enter a valid email address.");
  }
  const cleanEmail = validation.trimmedEmail;

  // 1. Find user by email
  const q = query(collection(db, "users"), where("email", "==", cleanEmail));
  const snapshot = await getDocs(q);

  if (snapshot.empty) {
    throw new Error("User not found. They must sign up first.");
  }

  const userDoc = snapshot.docs[0];
  const userId = userDoc.id;

  // 2. Authoritative membership check and atomic update in a transaction
  const spaceRef = doc(db, "spaces", spaceId);

  await runTransaction(db, async (transaction) => {
    const spaceSnap = await transaction.get(spaceRef);
    if (!spaceSnap.exists()) {
      throw new Error("Space not found.");
    }

    const data = spaceSnap.data();
    const userIds: string[] = Array.isArray(data.userIds) ? data.userIds : [];

    if (userIds.includes(userId)) {
      throw new Error("User is already a member.");
    }

    transaction.update(spaceRef, {
      userIds: arrayUnion(userId),
      updatedAt: serverTimestamp(),
    });
  });

  return { uid: userId, email: cleanEmail };
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

export async function getSpace(spaceId: string, includeDeleted: boolean = false): Promise<Space | null> {
    const docRef = doc(db, "spaces", spaceId);
    const docSnap = await getDoc(docRef);

    if (docSnap.exists()) {
        const data = docSnap.data();
        if (!includeDeleted && data.deletedAt) {
            return null;
        }
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

export async function deleteSpace(spaceId: string, userIdArg?: string): Promise<void> {
    if (!spaceId || typeof spaceId !== "string") {
        throw new Error("Invalid space identifier");
    }
    const currentUser = auth.currentUser;
    if (!currentUser) {
        throw new Error("You must be signed in to delete a space.");
    }
    const resolvedUserId = currentUser.uid;
    if (userIdArg && userIdArg !== resolvedUserId) {
        throw new Error("Cannot delete a space on behalf of another user.");
    }
    const spaceRef = doc(db, "spaces", spaceId);
    await runTransaction(db, async (transaction) => {
        const spaceSnap = await transaction.get(spaceRef);
        if (!spaceSnap.exists()) throw new Error("Space not found.");
        const data = spaceSnap.data();
        if (data.ownerId !== resolvedUserId) {
            throw new Error("Only the space owner can delete this space.");
        }
        if (data.deletedAt) {
            throw new Error("Space is already deleted.");
        }
        if (data.purgeState) {
            throw new Error("Cannot delete a space that is being permanently deleted.");
        }
        transaction.update(spaceRef, {
            deletedAt: serverTimestamp(),
            deletedBy: resolvedUserId,
            updatedAt: serverTimestamp(),
        });
    });
}

export async function restoreSpace(spaceId: string): Promise<void> {
    if (!spaceId || typeof spaceId !== "string") {
        throw new Error("Invalid space identifier");
    }
    const currentUser = auth.currentUser;
    if (!currentUser) {
        throw new Error("You must be signed in to restore a space.");
    }
    const resolvedUserId = currentUser.uid;
    const spaceRef = doc(db, "spaces", spaceId);
    await runTransaction(db, async (transaction) => {
        const spaceSnap = await transaction.get(spaceRef);
        if (!spaceSnap.exists()) throw new Error("Space not found.");
        const data = spaceSnap.data();
        if (data.ownerId !== resolvedUserId) {
            throw new Error("Only the space owner can restore this space.");
        }
        if (!data.deletedAt) {
            throw new Error("Cannot restore an active space.");
        }
        if (data.purgeState) {
            throw new Error("Cannot restore a space that is being permanently deleted.");
        }
        transaction.update(spaceRef, {
            deletedAt: null,
            deletedBy: null,
            updatedAt: serverTimestamp(),
        });
    });
}

import { purgeSpaceStepAction } from "./space-purge";

const SAFE_PURGE_MESSAGES = new Set([
    "Failed to delete space images during permanent purge. Please try again.",
    "Purge stalled: no documents could be processed. Please retry.",
    "Failed to permanently delete space. Please try again.",
    "Failed to permanently delete space. You can retry.",
    "Permission denied: only space owner can permanently delete this space",
    "Cannot permanently delete an active space. Soft-delete it first.",
    "You must be signed in to permanently delete a space.",
    "Invalid space identifier",
    "Space not found",
    "Space not found.",
]);

export function getSafePurgeErrorMessage(err: unknown): string {
    const fallback = "Failed to permanently delete space. You can retry.";
    if (err instanceof Error && typeof err.message === "string" && SAFE_PURGE_MESSAGES.has(err.message)) {
        return err.message;
    }
    return fallback;
}

export async function permanentlyDeleteSpace(
    spaceId: string,
    onProgress?: (progress: { processedCount: number; done: boolean }) => void
): Promise<void> {
    if (!spaceId || typeof spaceId !== "string") {
        throw new Error("Invalid space identifier");
    }
    const currentUser = auth.currentUser;
    if (!currentUser) {
        throw new Error("You must be signed in to permanently delete a space.");
    }

    let done = false;
    let totalProcessed = 0;
    let consecutiveStalls = 0;

    while (!done) {
        let idToken: string;
        try {
            idToken = await currentUser.getIdToken();
        } catch (tokenErr) {
            console.error("Failed to acquire auth token for space purge:", tokenErr);
            throw new Error("Failed to permanently delete space. Please try again.");
        }

        let result;
        try {
            result = await purgeSpaceStepAction(idToken, spaceId);
        } catch (err: unknown) {
            if (
                (totalProcessed > 0 || consecutiveStalls > 0) &&
                err instanceof Error &&
                (err.message === "Space not found" || err.message === "Space not found.")
            ) {
                done = true;
                if (onProgress) {
                    onProgress({ processedCount: totalProcessed, done: true });
                }
                break;
            }
            throw new Error(getSafePurgeErrorMessage(err));
        }

        if (result.processedCount === 0 && !result.done) {
            consecutiveStalls++;
            if (consecutiveStalls >= 3) {
                throw new Error("Purge stalled: no documents could be processed. Please retry.");
            }
            continue;
        }

        consecutiveStalls = 0;
        totalProcessed += result.processedCount;
        done = result.done;
        if (onProgress) {
            onProgress({ processedCount: totalProcessed, done });
        }
    }
}
