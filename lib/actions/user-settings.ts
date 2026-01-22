import { db } from "@/lib/firebase";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";

export interface UserSettings {
  documentFontSize: number;
}

const DEFAULT_SETTINGS: UserSettings = {
  documentFontSize: 16,
};

export async function getUserSettings(userId: string): Promise<UserSettings> {
  if (!userId) return DEFAULT_SETTINGS;

  const docRef = doc(db, "user_settings", userId);
  try {
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      return { ...DEFAULT_SETTINGS, ...docSnap.data() } as UserSettings;
    } else {
      // Create defaults if it doesn't exist
      await setDoc(docRef, DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    }
  } catch (error) {
    console.error("Error fetching user settings:", error);
    return DEFAULT_SETTINGS;
  }
}

export async function updateDocumentFontSize(userId: string, newSize: number) {
  if (!userId) return;
  
  const docRef = doc(db, "user_settings", userId);
  try {
    // We use set with merge just in case the doc does not exist yet for some reason
    // (though getUserSettings should have created it)
    await setDoc(docRef, { documentFontSize: newSize }, { merge: true });
  } catch (error) {
    console.error("Error updating font size:", error);
    throw error;
  }
}
