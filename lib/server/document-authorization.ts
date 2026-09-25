import "server-only";
import { getAdminAuth, getAdminFirestore } from "./firebase-admin";

export interface VerifiedContext {
    uid: string;
}

export async function verifyIdToken(idToken: string | undefined): Promise<VerifiedContext> {
    if (!idToken) throw new Error("Missing ID token");
    try {
        const decodedToken = await getAdminAuth().verifyIdToken(idToken);
        return { uid: decodedToken.uid };
    } catch {
        throw new Error("Invalid or expired ID token");
    }
}

export async function authorizeSpaceReader(uid: string, spaceId: string) {
    const db = getAdminFirestore();
    const spaceSnap = await db.collection("spaces").doc(spaceId).get();
    
    if (!spaceSnap.exists) {
        throw new Error("Space not found");
    }
    
    const spaceData = spaceSnap.data();
    if (!spaceData) throw new Error("Space data is missing");
    
    if (spaceData.deletedAt) {
        throw new Error("Space is deleted");
    }
    if (spaceData.purgeState) {
        throw new Error("Space is being purged");
    }

    const isPublic = spaceData.isPublic === true;
    const isOwner = spaceData.ownerId === uid;
    const isMember = Array.isArray(spaceData.userIds) && spaceData.userIds.includes(uid);

    if (!isPublic && !isOwner && !isMember) {
        throw new Error("Permission denied: not a space reader");
    }

    return spaceData;
}

export async function authorizeSpaceContributor(uid: string, spaceId: string) {
    const db = getAdminFirestore();
    const spaceSnap = await db.collection("spaces").doc(spaceId).get();
    
    if (!spaceSnap.exists) {
        throw new Error("Space not found");
    }
    
    const spaceData = spaceSnap.data();
    if (!spaceData) throw new Error("Space data is missing");
    
    if (spaceData.deletedAt) {
        throw new Error("Space is deleted");
    }
    if (spaceData.purgeState) {
        throw new Error("Space is being purged");
    }

    const isOwner = spaceData.ownerId === uid;
    const isMember = Array.isArray(spaceData.userIds) && spaceData.userIds.includes(uid);

    if (!isOwner && !isMember) {
        throw new Error("Permission denied: not a space contributor");
    }

    return spaceData;
}

export async function authorizeDocumentCleanup(uid: string, spaceId: string) {
    const db = getAdminFirestore();
    const spaceSnap = await db.collection("spaces").doc(spaceId).get();
    
    if (!spaceSnap.exists) {
        throw new Error("Space not found");
    }
    
    const spaceData = spaceSnap.data();
    if (!spaceData) throw new Error("Space data is missing");
    
    if (!spaceData.deletedAt) {
        throw new Error("Cannot cleanup an active space");
    }

    if (spaceData.ownerId !== uid) {
        throw new Error("Permission denied: only owner can cleanup deleted space");
    }

    return spaceData;
}

export async function getAndVerifyDocument(spaceId: string, docId: string) {
    const db = getAdminFirestore();
    const docSnap = await db.collection("documents").doc(docId).get();
    if (!docSnap.exists) {
        throw new Error("Document not found");
    }
    const docData = docSnap.data();
    if (!docData) throw new Error("Document data is missing");
    if (docData.spaceId !== spaceId) {
        throw new Error("Document does not belong to the specified space");
    }
    return docData;
}

export async function getDocumentContentUrls(docId: string): Promise<string[]> {
    const db = getAdminFirestore();
    const docRef = db.collection("documents").doc(docId);
    
    // Check main doc content (legacy or current inline)
    const docSnap = await docRef.get();
    let content = docSnap.exists ? docSnap.data()?.content : null;

    // Check subcollection
    const contentSnap = await docRef.collection("content").doc("main").get();
    if (contentSnap.exists && contentSnap.data()?.content) {
        content = contentSnap.data()?.content;
    }

    if (!content) return [];
    
    return extractImageUrls(content);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractImageUrls(content: any): string[] {
    if (!content) return [];
    const images = new Set<string>();
  
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function traverse(node: any) {
      if (node.type === 'image' && node.attrs?.src) {
        images.add(node.attrs.src);
      }
      if (node.content) {
         
        node.content.forEach(traverse);
      }
    }
  
    traverse(content);
    return Array.from(images);
}

const VALID_KEY_SEGMENT_REGEX = /^[a-zA-Z0-9._-]+$/;

function validateAndExtractPathFromUrl(urlString: string): string | null {
    const bucket = process.env.AWS_BUCKET_NAME;
    if (!bucket) return null;

    let urlObj: URL;
    try {
        urlObj = new URL(urlString);
    } catch {
        return null;
    }

    // Must be HTTPS
    if (urlObj.protocol !== "https:") return null;

    // Check pathname for directory traversal, backslashes, or encoded slashes/traversal in pathname
    const rawPathname = urlObj.pathname;
    if (
        rawPathname.includes("..") ||
        rawPathname.includes("\\") ||
        /%2e%2e/i.test(rawPathname) ||
        /%2f/i.test(rawPathname) ||
        /%5c/i.test(rawPathname)
    ) {
        return null;
    }

    const hostname = urlObj.hostname.toLowerCase();
    let pathname = decodeURIComponent(rawPathname);

    // Virtual-hosted style: {bucket}.s3.{region}.amazonaws.com or {bucket}.s3.amazonaws.com
    const isVirtualHosted =
        hostname === `${bucket}.s3.amazonaws.com` ||
        (hostname.startsWith(`${bucket}.s3.`) &&
            hostname.endsWith(".amazonaws.com") &&
            hostname.split(".").length === 5);

    // Path-style: s3.amazonaws.com or s3.{region}.amazonaws.com
    const isPathStyle =
        hostname === "s3.amazonaws.com" ||
        (/^s3\.[a-z0-9-]+\.amazonaws\.com$/.test(hostname) && hostname.split(".").length === 4);

    if (isVirtualHosted) {
        if (pathname.startsWith("/")) pathname = pathname.substring(1);
        return pathname;
    } else if (isPathStyle) {
        // Path-style MUST start with /{bucket}/
        if (pathname.startsWith(`/${bucket}/`)) {
            return pathname.substring(bucket.length + 2);
        }
        // If it starts with another bucket or doesn't have /{bucket}/, reject
        return null;
    }

    // Reject arbitrary external hosts and other customer buckets
    return null;
}

export function extractCanonicalKey(urlOrKey: string): string | null {
    try {
        if (!urlOrKey || typeof urlOrKey !== "string") return null;

        // Reject raw string control characters
        if (/[\x00-\x1F\x7F]/.test(urlOrKey)) {
            return null;
        }

        let path: string;

        if (urlOrKey.startsWith("https://")) {
            const extracted = validateAndExtractPathFromUrl(urlOrKey);
            if (!extracted) return null;
            path = extracted;
        } else if (urlOrKey.startsWith("http://") || urlOrKey.includes("://")) {
            // Reject HTTP and non-HTTPS protocols
            return null;
        } else {
            // Raw key: reject encoded traversal, encoded slashes, encoded backslashes,
            // literal directory traversal, or backslashes
            if (
                /%2e%2e/i.test(urlOrKey) ||
                /%2f/i.test(urlOrKey) ||
                /%5c/i.test(urlOrKey) ||
                urlOrKey.includes("..") ||
                urlOrKey.includes("\\")
            ) {
                return null;
            }
            // Raw key: strip single leading slash if present
            path = urlOrKey.startsWith("/") ? urlOrKey.substring(1) : urlOrKey;
        }

        // Strip known Docula prefix exactly once
        if (path.startsWith("deleted/uploads/")) {
            path = path.substring(16);
        } else if (path.startsWith("deleted/")) {
            path = path.substring(8);
        } else if (path.startsWith("uploads/")) {
            path = path.substring(8);
        } else if (path.startsWith("temp/")) {
            path = path.substring(5);
        }

        // Reject duplicate prefixes (e.g. uploads/uploads/..., temp/temp/...)
        if (
            path.startsWith("uploads/") ||
            path.startsWith("temp/") ||
            path.startsWith("deleted/")
        ) {
            return null;
        }

        // Validate segments of canonical key
        const segments = path.split("/");
        // Must have at least 1 segment and at most 4 segments (e.g. legacy filename, space/doc/file, or temp space/doc/uid/file)
        if (segments.length === 0 || segments.length > 4) {
            return null;
        }

        for (const segment of segments) {
            if (!segment || segment === "." || segment === ".." || !VALID_KEY_SEGMENT_REGEX.test(segment)) {
                return null;
            }
        }

        return path;
    } catch {
        return null;
    }
}

export async function verifyLegacyKeyOwnership(docId: string, requestedKey: string) {
    const urls = await getDocumentContentUrls(docId);
    const requestedCanonical = extractCanonicalKey(requestedKey);
    
    if (!requestedCanonical) return false;

    for (const url of urls) {
        const canonical = extractCanonicalKey(url);
        if (canonical === requestedCanonical) return true;
    }
    
    return false;
}
