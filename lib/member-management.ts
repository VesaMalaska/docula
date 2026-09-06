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

/**
 * Invalidates the active space and space-members query caches after adding a member
 * so the visible space details and member list update reactively.
 */
export function invalidateSpaceMemberQueries(queryClient: InvalidationTarget, spaceId: string) {
  queryClient.invalidateQueries({ queryKey: ["space", spaceId] });
  queryClient.invalidateQueries({ queryKey: ["space-members", spaceId] });
}
