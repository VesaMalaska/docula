"use server";

import { FieldValue } from "firebase-admin/firestore";
import { verifyIdToken } from "../server/document-authorization";
import { getAdminFirestore } from "../server/firebase-admin";
import {
  calculateDescendantPath,
  calculateSubtreeHeightFromPaths,
  isDepthAllowed,
  MAX_LIFECYCLE_DOCUMENT_LIMIT,
} from "../utils/hierarchy";

export interface MoveDocumentResult {
  success: boolean;
  movedCount: number;
  destinationDepth?: number;
}

/**
 * Server-authoritative document and subtree move action.
 * Executes atomically in a single Firebase Admin transaction with complete
 * validation of Space membership, deletion state, lifecycle claims, cycle safety,
 * canonical paths, and maximum 4-level hierarchy depth.
 */
export async function moveDocumentAction(
  idToken: string | undefined,
  docId: string,
  newParentId: string | null,
  spaceId?: string
): Promise<MoveDocumentResult> {
  if (!docId || typeof docId !== "string") {
    throw new Error("Invalid source document ID");
  }
  if (newParentId !== null && typeof newParentId !== "string") {
    throw new Error("Invalid destination parent ID");
  }
  if (spaceId !== undefined && (typeof spaceId !== "string" || !spaceId)) {
    throw new Error("Invalid space ID");
  }
  if (docId === newParentId) {
    throw new Error("Cannot move a document under itself");
  }

  // 1. Authenticate caller via Firebase ID token
  const { uid } = await verifyIdToken(idToken);

  const db = getAdminFirestore();
  const sourceRef = db.collection("documents").doc(docId);

  // 2. Perform entire move atomically inside one Firestore transaction.
  // All reads occur before any writes.
  return await db.runTransaction(async (tx) => {
    // Read source document
    const sourceSnap = await tx.get(sourceRef);
    if (!sourceSnap.exists) {
      throw new Error("Document not found");
    }
    const sourceData = sourceSnap.data();
    if (!sourceData) {
      throw new Error("Document data is missing");
    }

    const actualSpaceId = sourceData.spaceId;
    if (!actualSpaceId || typeof actualSpaceId !== "string") {
      throw new Error("Document space ID is missing or invalid");
    }
    if (spaceId && spaceId !== actualSpaceId) {
      throw new Error("Document does not belong to the specified space");
    }

    // Read and validate Space
    const spaceRef = db.collection("spaces").doc(actualSpaceId);
    const spaceSnap = await tx.get(spaceRef);
    if (!spaceSnap.exists) {
      throw new Error("Space not found");
    }
    const spaceData = spaceSnap.data();
    if (!spaceData) {
      throw new Error("Space data is missing");
    }
    if (spaceData.deletedAt != null) {
      throw new Error("Space is deleted");
    }

    // Authorize caller: must be Space owner or active member/contributor
    const isOwner = spaceData.ownerId === uid;
    const isMember = Array.isArray(spaceData.userIds) && spaceData.userIds.includes(uid);
    if (!isOwner && !isMember) {
      throw new Error("Permission denied: not a space contributor");
    }

    // Validate source document state
    if (sourceData.deleted === true || sourceData.deletedAt != null) {
      throw new Error("Cannot move a deleted document");
    }
    if (sourceData.permanentDeletionClaim != null) {
      throw new Error("Cannot move a document that is pending permanent deletion");
    }
    if (sourceData.lifecycleClaim != null) {
      throw new Error("Document is currently locked by another lifecycle operation");
    }

    const sourceCurrentPath = Array.isArray(sourceData.path) ? sourceData.path : null;
    if (
      sourceCurrentPath === null ||
      sourceCurrentPath.includes(docId) ||
      sourceCurrentPath.length > 3 ||
      new Set(sourceCurrentPath).size !== sourceCurrentPath.length
    ) {
      throw new Error("Malformed active hierarchy: source document path is invalid");
    }

    if (sourceData.parentId === null) {
      if (sourceCurrentPath.length !== 0) {
        throw new Error("Malformed active hierarchy: root document path must be empty");
      }
    } else if (typeof sourceData.parentId === "string" && sourceData.parentId.length > 0) {
      if (
        sourceCurrentPath.length === 0 ||
        sourceCurrentPath[sourceCurrentPath.length - 1] !== sourceData.parentId
      ) {
        throw new Error("Malformed active hierarchy: source path does not match parentId");
      }
    } else {
      throw new Error("Malformed active hierarchy: source document parentId is invalid");
    }

    // Intentional and documented same-parent / no-op handling:
    // If the document is already in the requested location, succeed without writing.
    const currentParentId = (sourceData.parentId ?? null) as string | null;
    if (currentParentId === newParentId) {
      return { success: true, movedCount: 0, destinationDepth: sourceCurrentPath.length };
    }

    // Read and validate Destination (when non-null)
    let destinationDepth = 0;
    let destinationPath: string[] = [];

    if (newParentId !== null) {
      const destRef = db.collection("documents").doc(newParentId);
      const destSnap = await tx.get(destRef);
      if (!destSnap.exists) {
        throw new Error("Destination document not found");
      }
      const destData = destSnap.data();
      if (!destData) {
        throw new Error("Destination document data is missing");
      }
      if (destData.spaceId !== actualSpaceId) {
        throw new Error("Cannot move document to a different space");
      }
      if (destData.deleted === true || destData.deletedAt != null) {
        throw new Error("Destination document is deleted, claimed, or unavailable");
      }
      if (destData.permanentDeletionClaim != null || destData.lifecycleClaim != null) {
        throw new Error("Destination document is locked by another lifecycle operation");
      }

      const rawDestPath = Array.isArray(destData.path) ? destData.path : null;
      if (
        rawDestPath === null ||
        rawDestPath.includes(newParentId) ||
        rawDestPath.length > 3 ||
        new Set(rawDestPath).size !== rawDestPath.length
      ) {
        throw new Error("Destination document has malformed hierarchy");
      }
      if (destData.parentId === null) {
        if (rawDestPath.length !== 0) {
          throw new Error("Destination document has malformed hierarchy");
        }
      } else if (typeof destData.parentId === "string" && destData.parentId.length > 0) {
        if (
          rawDestPath.length === 0 ||
          rawDestPath[rawDestPath.length - 1] !== destData.parentId
        ) {
          throw new Error("Destination document has malformed hierarchy");
        }
      } else {
        throw new Error("Destination document has malformed hierarchy");
      }
      if (rawDestPath.includes(docId)) {
        throw new Error("Cannot move a document under its own descendant");
      }

      // Re-read and validate all destination ancestors
      for (const ancId of rawDestPath) {
        if (ancId === docId) {
          throw new Error("Cannot move a document under its own descendant");
        }
        const ancSnap = await tx.get(db.collection("documents").doc(ancId));
        if (!ancSnap.exists) {
          throw new Error("Destination ancestor document not found");
        }
        const ancData = ancSnap.data();
        if (
          !ancData ||
          ancData.spaceId !== actualSpaceId ||
          ancData.deleted === true ||
          ancData.deletedAt != null ||
          ancData.permanentDeletionClaim != null ||
          ancData.lifecycleClaim != null
        ) {
          throw new Error("Destination ancestor document is deleted, claimed, or unavailable");
        }
        if (
          !Array.isArray(ancData.path) ||
          ancData.path.includes(docId) ||
          ancData.path.includes(ancId)
        ) {
          throw new Error("Destination ancestor document has malformed hierarchy");
        }
      }

      destinationDepth = rawDestPath.length + 1;
      destinationPath = [...rawDestPath, newParentId];
    }

    // Read complete active subtree
    const descendantsQuery = db
      .collection("documents")
      .where("spaceId", "==", actualSpaceId)
      .where("path", "array-contains", docId);

    const descendantsSnap = await tx.get(descendantsQuery);

    // Distinguish active descendants from historical already-deleted documents.
    // Soft-deleted historical groups in Trash are not moved or rewritten.
    const activeDescDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    for (const descDoc of descendantsSnap.docs) {
      const d = descDoc.data();
      if (d.deleted === true || d.deletedAt != null) {
        continue;
      }
      activeDescDocs.push(descDoc);
    }

    const totalDocsToMove = 1 + activeDescDocs.length;
    if (totalDocsToMove > MAX_LIFECYCLE_DOCUMENT_LIMIT) {
      throw new Error(
        `Operation exceeds safe atomic limit of ${MAX_LIFECYCLE_DOCUMENT_LIMIT} documents. Too many descendants.`
      );
    }

    const activeDescendantIds = new Set(activeDescDocs.map((d) => d.id));

    // Verify destination is not inside the moved subtree
    if (newParentId !== null && activeDescendantIds.has(newParentId)) {
      throw new Error("Cannot move a document under its own descendant");
    }

    // Revalidate authorization, claims, deletion state, cycle safety, same-Space ownership
    // and canonical hierarchy consistency across all active descendants
    for (const descDoc of activeDescDocs) {
      const d = descDoc.data();
      if (d.spaceId !== actualSpaceId) {
        throw new Error("Descendant document belongs to a different space");
      }
      if (d.permanentDeletionClaim != null) {
        throw new Error("A subdocument is pending permanent deletion (locked by another lifecycle operation)");
      }
      if (d.lifecycleClaim != null) {
        throw new Error("A subdocument is currently locked by another lifecycle operation");
      }
      if (!Array.isArray(d.path) || d.path.length === 0 || d.path.length > 4) {
        throw new Error("Malformed active hierarchy: descendant path is missing or invalid");
      }
      if (d.path.includes(descDoc.id)) {
        throw new Error("Malformed active hierarchy: cycle detected in descendant path");
      }
      if (new Set(d.path).size !== d.path.length) {
        throw new Error("Malformed active hierarchy: cycle detected in descendant path");
      }
      const docIdx = d.path.indexOf(docId);
      if (docIdx === -1) {
        throw new Error("Malformed active hierarchy: descendant path does not contain source ID");
      }
      if (!d.parentId || typeof d.parentId !== "string") {
        throw new Error("Malformed active hierarchy: descendant parentId is missing or invalid");
      }
      if (d.parentId === descDoc.id) {
        throw new Error("Malformed active hierarchy: descendant cannot be self-parented");
      }
      if (d.parentId !== docId && !activeDescendantIds.has(d.parentId)) {
        throw new Error("Malformed active hierarchy: descendant parentId references external or missing document");
      }
      if (d.path[d.path.length - 1] !== d.parentId) {
        throw new Error("Malformed active hierarchy: descendant path does not match parentId");
      }
    }

    // Validate 4-level hierarchy depth invariant: destinationDepth + subtreeHeight <= 4
    const activeDescendantPaths = activeDescDocs.map((d) =>
      Array.isArray(d.data().path) ? (d.data().path as string[]) : []
    );
    const subtreeHeight = calculateSubtreeHeightFromPaths(docId, activeDescendantPaths);

    if (!isDepthAllowed(destinationDepth, subtreeHeight)) {
      throw new Error("Moving this document exceeds the maximum hierarchy depth of 4 levels");
    }

    // ── Writes Phase (All reads have occurred prior to this point) ──
    const newSourcePath = destinationPath;

    // Update source document with exact new parentId and canonical path
    tx.update(sourceRef, {
      parentId: newParentId,
      path: newSourcePath,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Update every active descendant with its exact canonical rewritten path.
    // Preserve descendant parentId relationships, titles, content, deletion metadata, etc.
    for (const descDoc of activeDescDocs) {
      const oldPath = Array.isArray(descDoc.data().path) ? (descDoc.data().path as string[]) : [];
      const descendantNewPath = calculateDescendantPath(oldPath, docId, newSourcePath);

      tx.update(descDoc.ref, {
        path: descendantNewPath,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    return {
      success: true,
      movedCount: totalDocsToMove,
      destinationDepth,
    };
  });
}
