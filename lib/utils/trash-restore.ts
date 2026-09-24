import type { RestoreDestination } from "@/lib/types";

/**
 * Pure helpers for the Trash restore flow and tagged destination selection.
 */

export interface RestoreResponse {
  success?: boolean;
  restoredCount?: number;
  requiresDestination?: boolean;
  subtreeHeight?: number;
}

export interface RehomeDocState {
  id: string;
  title: string;
  subtreeHeight: number;
}

export type RestoreResultAction =
  | { type: "OPEN_DESTINATION_PICKER"; rehomeDoc: RehomeDocState; explanation: string }
  | { type: "RESTORE_SUCCESS"; restoredCount: number }
  | { type: "NOOP" };

/**
 * Evaluates the server restore response and determines whether to open the
 * destination picker or finalize the restore.
 * Never automatically falls back to Space root.
 */
export function evaluateRestoreResult(
  result: RestoreResponse | null | undefined,
  doc: { id: string; title?: string; subtreeHeight?: number }
): RestoreResultAction {
  if (result && typeof result === "object" && result.requiresDestination === true) {
    return {
      type: "OPEN_DESTINATION_PICKER",
      rehomeDoc: {
        id: doc.id,
        title: doc.title || "Document",
        subtreeHeight: result.subtreeHeight ?? doc.subtreeHeight ?? 1,
      },
      explanation: "The original parent document is no longer available. Please select a new destination to restore this document.",
    };
  }

  if (result && typeof result === "object" && result.success === true) {
    return {
      type: "RESTORE_SUCCESS",
      restoredCount: result.restoredCount || 1,
    };
  }

  return { type: "NOOP" };
}

/**
 * Creates the initial restore payload using { kind: "original" }.
 */
export function createInitialRestorePayload(docId: string): { docId: string; destination: RestoreDestination } {
  return {
    docId,
    destination: { kind: "original" },
  };
}

/**
 * Formats a restore payload for the mutation given a docId and RestoreDestination.
 */
export function formatRestorePayload(
  docId: string,
  destination: RestoreDestination
): { docId: string; destination: RestoreDestination } {
  return { docId, destination };
}

/**
 * Handles confirmation in the destination picker:
 * - Selecting Space root (null) passes { kind: "root" }
 * - Selecting a document (string) passes { kind: "document", parentId: selectedParentId }
 * - undefined throws an error
 */
export function resolvePickerDestination(selectedParentId: string | null | undefined): RestoreDestination {
  if (selectedParentId === undefined) {
    throw new Error("No destination selected");
  }
  if (selectedParentId === null) {
    return { kind: "root" };
  }
  return { kind: "document", parentId: selectedParentId };
}

/**
 * Handles cancelling the destination picker:
 * Returns null to clear the rehome state without executing any restore.
 */
export function handlePickerCancel(): null {
  return null;
}

/**
 * Determines whether a destination item can be selected in the picker.
 * Invalid destinations (e.g. over-depth, self, cycle) cannot be selected.
 */
export function canSelectDestination(validity: { valid: boolean }): boolean {
  return validity.valid;
}

/**
 * Determines whether the destination picker confirmation button should be enabled.
 * Only enabled when an active mutation is not pending, a destination has been explicitly
 * chosen, and the chosen destination passes validation.
 */
export function isDestinationConfirmationEnabled(
  selectedParentId: string | null | undefined,
  validity: { valid: boolean },
  isPending = false
): boolean {
  return !isPending && selectedParentId !== undefined && validity.valid;
}
