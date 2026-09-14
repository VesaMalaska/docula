import "server-only";
import { getApps, initializeApp, cert, getApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

function ensureAdminInitialized(): void {
    if (getApps().length) return;

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

    if (!projectId || !clientEmail || !privateKey) {
        // Fail closed: callers will throw "Firebase Admin is not configured"
        return;
    }

    try {
        initializeApp({
            credential: cert({ projectId, clientEmail, privateKey }),
        });
    } catch (error) {
        console.error("Firebase Admin initialization error", error);
    }
}

export function getAdminAuth() {
    ensureAdminInitialized();
    if (!getApps().length) {
        throw new Error("Firebase Admin is not configured");
    }
    return getAuth(getApp());
}

export function getAdminFirestore() {
    ensureAdminInitialized();
    if (!getApps().length) {
        throw new Error("Firebase Admin is not configured");
    }
    return getFirestore(getApp());
}
