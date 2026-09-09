export type AddMemberOperationStatus = "idle" | "submitting" | "success" | "error";

export type AddMemberErrorType = "validation" | "known_action" | "unexpected" | null;

export interface MemberEmailValidationResult {
  isValid: boolean;
  error?: string;
  trimmedEmail: string;
}

/**
 * Validates and trims an email address entered for member addition.
 * Requires a plausible non-whitespace local part and domain separated by '@'
 * without embedded whitespace.
 */
export function validateMemberEmail(email: string): MemberEmailValidationResult {
  const trimmedEmail = email ? email.trim() : "";
  if (trimmedEmail.length === 0) {
    return {
      isValid: false,
      error: "Please enter an email address.",
      trimmedEmail: "",
    };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+$/;
  if (!emailRegex.test(trimmedEmail)) {
    return {
      isValid: false,
      error: "Please enter a valid email address.",
      trimmedEmail,
    };
  }

  return {
    isValid: true,
    trimmedEmail,
  };
}

export interface ResolvedMemberActionError {
  message: string;
  type: "validation" | "known_action" | "unexpected";
}

/**
 * Maps errors from member-addition actions into clear user-facing messages
 * without exposing raw internal stack traces.
 */
export function resolveMemberActionError(err: unknown): ResolvedMemberActionError {
  if (err instanceof Error) {
    const msg = err.message || "";
    const code =
      "code" in err && typeof (err as { code: unknown }).code === "string"
        ? (err as { code: string }).code
        : "";

    if (
      code === "permission-denied" ||
      msg.toLowerCase().includes("permission-denied") ||
      msg.toLowerCase().includes("permission denied")
    ) {
      return {
        message: "You do not have permission to add members to this space.",
        type: "known_action",
      };
    }

    if (code === "unavailable" || msg.toLowerCase().includes("unavailable")) {
      return {
        message: "The service is temporarily unavailable. Please try again later.",
        type: "known_action",
      };
    }

    if (msg === "User not found. They must sign up first.") {
      return {
        message: msg,
        type: "known_action",
      };
    }

    if (msg === "User is already a member." || msg === "User is already a member of this space.") {
      return {
        message: "User is already a member.",
        type: "known_action",
      };
    }

    if (msg === "Space not found.") {
      return {
        message: "Space not found.",
        type: "known_action",
      };
    }

    if (msg.startsWith("Please enter")) {
      return {
        message: msg,
        type: "validation",
      };
    }
  }

  return {
    message: "Failed to add member. Please try again.",
    type: "unexpected",
  };
}

export interface InvalidationTarget {
  invalidateQueries: (options: { queryKey: readonly unknown[] }) => Promise<void> | void;
}

export interface EvictionTarget extends InvalidationTarget {
  removeQueries: (options: { queryKey: readonly unknown[] }) => void;
}

/**
 * Invalidates the active space, member list, and user spaces query caches
 * so visible space details and sidebar update reactively.
 */
export function invalidateSpaceMemberQueries(queryClient: InvalidationTarget, spaceId: string) {
  queryClient.invalidateQueries({ queryKey: ["space", spaceId] });
  queryClient.invalidateQueries({ queryKey: ["space-members", spaceId] });
  queryClient.invalidateQueries({ queryKey: ["user-spaces"] });
}

/**
 * Evicts cached space queries and private document caches when a user leaves
 * or is removed from a space, preventing stale private document access in memory.
 */
export function evictSpaceQueries(queryClient: EvictionTarget, spaceId: string) {
  queryClient.removeQueries({ queryKey: ["space", spaceId] });
  queryClient.removeQueries({ queryKey: ["space-members", spaceId] });
  queryClient.removeQueries({ queryKey: ["sidebar-tree", spaceId] });
  queryClient.removeQueries({ queryKey: ["doc"] });
  queryClient.invalidateQueries({ queryKey: ["user-spaces"] });
}

export interface MemberInvariantResult {
  isValid: boolean;
  error?: string;
}

/**
 * Validates member removal invariants before executing Firestore transactions:
 * 1. Requires authenticated caller.
 * 2. Requires space owner to be present in userIds (rejects inconsistent records).
 * 3. Only the space owner can remove another member.
 * 4. The space owner cannot be removed.
 * 5. Target must currently be in userIds.
 */
export function canRemoveMember(params: {
  callerId: string;
  ownerId: string;
  targetMemberId: string;
  userIds: string[];
}): MemberInvariantResult {
  const { callerId, ownerId, targetMemberId, userIds } = params;

  if (!callerId) {
    return { isValid: false, error: "You must be signed in to remove a member." };
  }

  if (!Array.isArray(userIds) || !userIds.includes(ownerId)) {
    return {
      isValid: false,
      error: "Space membership state is invalid: the space owner is missing from the member list.",
    };
  }

  if (new Set(userIds).size !== userIds.length) {
    return {
      isValid: false,
      error: "Space membership state is invalid: the member list contains duplicate user entries.",
    };
  }

  if (callerId !== ownerId) {
    return { isValid: false, error: "Only the space owner may remove another member." };
  }

  if (targetMemberId === ownerId) {
    return { isValid: false, error: "The space owner cannot be removed." };
  }

  if (!userIds.includes(targetMemberId)) {
    return { isValid: false, error: "The specified user is not a member of this space." };
  }

  return { isValid: true };
}

/**
 * Validates voluntary departure invariants before executing Firestore transactions:
 * 1. Requires authenticated caller.
 * 2. Requires space owner to be present in userIds (rejects inconsistent records).
 * 3. Space owners cannot leave their own space in this release.
 * 4. Caller must currently be in userIds.
 */
export function canLeaveSpace(params: {
  callerId: string;
  ownerId: string;
  userIds: string[];
}): MemberInvariantResult {
  const { callerId, ownerId, userIds } = params;

  if (!callerId) {
    return { isValid: false, error: "You must be signed in to leave a space." };
  }

  if (!Array.isArray(userIds) || !userIds.includes(ownerId)) {
    return {
      isValid: false,
      error: "Space membership state is invalid: the space owner is missing from the member list.",
    };
  }

  if (new Set(userIds).size !== userIds.length) {
    return {
      isValid: false,
      error: "Space membership state is invalid: the member list contains duplicate user entries.",
    };
  }

  if (callerId === ownerId) {
    return {
      isValid: false,
      error: "Space owners cannot leave their own spaces while ownership transfer is unavailable.",
    };
  }

  if (!userIds.includes(callerId)) {
    return { isValid: false, error: "You are not a member of this space." };
  }

  return { isValid: true };
}

/**
 * Maps errors from remove-member actions into accessible user-facing messages.
 */
export function resolveRemoveMemberError(err: unknown): ResolvedMemberActionError {
  if (err instanceof Error) {
    const msg = err.message || "";
    const code =
      "code" in err && typeof (err as { code: unknown }).code === "string"
        ? (err as { code: string }).code
        : "";

    if (
      code === "permission-denied" ||
      msg.toLowerCase().includes("permission-denied") ||
      msg.toLowerCase().includes("permission denied")
    ) {
      return {
        message: "You do not have permission to remove members from this space.",
        type: "known_action",
      };
    }

    if (
      msg.includes("Space not found") ||
      msg.includes("Only the space owner") ||
      msg.includes("The space owner cannot be removed") ||
      msg.includes("not a member") ||
      msg.includes("membership state is invalid")
    ) {
      return {
        message: msg,
        type: "known_action",
      };
    }

    if (
      code === "unavailable" ||
      msg.toLowerCase().includes("service is unavailable") ||
      msg.toLowerCase().includes("temporarily unavailable") ||
      msg.toLowerCase() === "unavailable"
    ) {
      return {
        message: "The service is temporarily unavailable. Please try again later.",
        type: "known_action",
      };
    }
  }

  return {
    message: "Failed to remove member. Please try again.",
    type: "unexpected",
  };
}

/**
 * Maps errors from leave-space actions into accessible user-facing messages.
 */
export function resolveLeaveSpaceError(err: unknown): ResolvedMemberActionError {
  if (err instanceof Error) {
    const msg = err.message || "";
    const code =
      "code" in err && typeof (err as { code: unknown }).code === "string"
        ? (err as { code: string }).code
        : "";

    if (
      code === "permission-denied" ||
      msg.toLowerCase().includes("permission-denied") ||
      msg.toLowerCase().includes("permission denied")
    ) {
      return {
        message: "You do not have permission to leave this space.",
        type: "known_action",
      };
    }

    if (
      msg.includes("Space not found") ||
      msg.includes("Space owners cannot leave") ||
      msg.includes("not a member") ||
      msg.includes("membership state is invalid")
    ) {
      return {
        message: msg,
        type: "known_action",
      };
    }

    if (
      code === "unavailable" ||
      msg.toLowerCase().includes("service is unavailable") ||
      msg.toLowerCase().includes("temporarily unavailable") ||
      msg.toLowerCase() === "unavailable"
    ) {
      return {
        message: "The service is temporarily unavailable. Please try again later.",
        type: "known_action",
      };
    }
  }

  return {
    message: "Failed to leave space. Please try again.",
    type: "unexpected",
  };
}

/**
 * Maps errors from join-space actions into accessible user-facing messages.
 */
export function resolveJoinSpaceError(err: unknown): ResolvedMemberActionError {
  if (err instanceof Error) {
    const msg = err.message || "";
    const code =
      "code" in err && typeof (err as { code: unknown }).code === "string"
        ? (err as { code: string }).code
        : "";

    if (
      code === "permission-denied" ||
      msg.toLowerCase().includes("permission-denied") ||
      msg.toLowerCase().includes("permission denied")
    ) {
      return {
        message: "You do not have permission to join this space.",
        type: "known_action",
      };
    }

    if (
      msg.includes("Space not found") ||
      msg.includes("Cannot join a private space") ||
      msg.includes("Cannot join a deleted space") ||
      msg.includes("signed in")
    ) {
      return {
        message: msg,
        type: "known_action",
      };
    }

    if (
      code === "unavailable" ||
      msg.toLowerCase().includes("service is unavailable") ||
      msg.toLowerCase().includes("temporarily unavailable") ||
      msg.toLowerCase() === "unavailable"
    ) {
      return {
        message: "The service is temporarily unavailable. Please try again later.",
        type: "known_action",
      };
    }
  }

  return {
    message: "Failed to join space. Please try again.",
    type: "unexpected",
  };
}

/**
 * Concise explanation for space owners that leave-space is unavailable
 * while ownership transfer remains deferred.
 */
export const OWNER_LEAVE_UNAVAILABLE_EXPLANATION =
  "As the Space owner, you cannot leave this Space while ownership transfer is unavailable.";

/**
 * Determines whether the owner explanation banner should be displayed.
 * Must be visible only for the authenticated owner, never for ordinary members or non-members.
 */
export function shouldShowOwnerLeaveExplanation(params: {
  isOwner: boolean;
  canLeave: boolean;
}): boolean {
  return params.isOwner && !params.canLeave;
}

/**
 * Contextual unavailable state headings and neutral explanations
 * that unify missing, inaccessible, soft-deleted, and permanently deleted spaces/documents.
 */
export const SPACE_UNAVAILABLE_HEADING = "Space unavailable";
export const SPACE_UNAVAILABLE_DESCRIPTION =
  "This Space may have been deleted, or you may no longer have access to it.";
export const DOCUMENT_UNAVAILABLE_HEADING = "Document unavailable";
export const DOCUMENT_UNAVAILABLE_DESCRIPTION =
  "This document may have been deleted, or you may no longer have access to it.";

export interface UnavailableConfig {
  title: string;
  description: string;
  primaryAction: { label: string; href: string };
  secondaryAction: { label: string; href: string };
}

export function getUnavailableStateConfig(
  type: "space" | "document" | "generic"
): UnavailableConfig {
  if (type === "document") {
    return {
      title: DOCUMENT_UNAVAILABLE_HEADING,
      description: DOCUMENT_UNAVAILABLE_DESCRIPTION,
      primaryAction: { label: "Go to Home", href: "/" },
      secondaryAction: { label: "Open Trash", href: "/trash" },
    };
  }
  return {
    title: SPACE_UNAVAILABLE_HEADING,
    description: SPACE_UNAVAILABLE_DESCRIPTION,
    primaryAction: { label: "Go to Home", href: "/" },
    secondaryAction: { label: "Open Trash", href: "/trash" },
  };
}

/**
 * Validates space access for route rendering without revealing specific deletion or existence state.
 */
export function isSpaceAccessible(
  space: { isPublic?: boolean; userIds?: string[]; deletedAt?: unknown } | null | undefined,
  userId: string | null | undefined
): boolean {
  if (!space || space.deletedAt) return false;
  if (!userId) return false;
  return Boolean(
    space.isPublic ||
      (Array.isArray(space.userIds) && space.userIds.includes(userId))
  );
}
