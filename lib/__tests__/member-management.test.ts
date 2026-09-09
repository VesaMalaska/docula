import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  canRemoveMember,
  canLeaveSpace,
  resolveRemoveMemberError,
  resolveLeaveSpaceError,
  resolveJoinSpaceError,
  invalidateSpaceMemberQueries,
  evictSpaceQueries,
  validateMemberEmail,
  resolveMemberActionError,
  OWNER_LEAVE_UNAVAILABLE_EXPLANATION,
  shouldShowOwnerLeaveExplanation,
  SPACE_UNAVAILABLE_HEADING,
  SPACE_UNAVAILABLE_DESCRIPTION,
  DOCUMENT_UNAVAILABLE_HEADING,
  DOCUMENT_UNAVAILABLE_DESCRIPTION,
  getUnavailableStateConfig,
  isSpaceAccessible,
} from "../member-management.ts";

describe("Member Management - Invariants & Error Resolution", () => {
  describe("canRemoveMember", () => {
    const ownerId = "user-owner";
    const memberId = "user-member-1";
    const otherMemberId = "user-member-2";
    const nonMemberId = "user-stranger";
    const validUserIds = [ownerId, memberId, otherMemberId];

    test("rejects when callerId is empty", () => {
      const result = canRemoveMember({
        callerId: "",
        ownerId,
        targetMemberId: memberId,
        userIds: validUserIds,
      });
      assert.equal(result.isValid, false);
      assert.match(result.error || "", /signed in/i);
    });

    test("rejects when owner is missing from userIds (inconsistent existing record)", () => {
      const inconsistentUserIds = [memberId, otherMemberId];
      const result = canRemoveMember({
        callerId: ownerId,
        ownerId,
        targetMemberId: memberId,
        userIds: inconsistentUserIds,
      });
      assert.equal(result.isValid, false);
      assert.match(result.error || "", /space owner is missing/i);
    });

    test("rejects non-owner attempting to remove another member", () => {
      const result = canRemoveMember({
        callerId: memberId,
        ownerId,
        targetMemberId: otherMemberId,
        userIds: validUserIds,
      });
      assert.equal(result.isValid, false);
      assert.match(result.error || "", /only the space owner/i);
    });

    test("rejects attempt to remove the space owner", () => {
      const result = canRemoveMember({
        callerId: ownerId,
        ownerId,
        targetMemberId: ownerId,
        userIds: validUserIds,
      });
      assert.equal(result.isValid, false);
      assert.match(result.error || "", /owner cannot be removed/i);
    });

    test("rejects attempt to remove a user who is not in userIds", () => {
      const result = canRemoveMember({
        callerId: ownerId,
        ownerId,
        targetMemberId: nonMemberId,
        userIds: validUserIds,
      });
      assert.equal(result.isValid, false);
      assert.match(result.error || "", /not a member/i);
    });

    test("rejects when member list contains duplicate UIDs", () => {
      const duplicateUserIds = [ownerId, memberId, memberId];
      const result = canRemoveMember({
        callerId: ownerId,
        ownerId,
        targetMemberId: memberId,
        userIds: duplicateUserIds,
      });
      assert.equal(result.isValid, false);
      assert.match(result.error || "", /duplicate user entries/i);
    });

    test("accepts valid removal by space owner of a non-owner member", () => {
      const result = canRemoveMember({
        callerId: ownerId,
        ownerId,
        targetMemberId: memberId,
        userIds: validUserIds,
      });
      assert.equal(result.isValid, true);
      assert.equal(result.error, undefined);
    });
  });

  describe("canLeaveSpace", () => {
    const ownerId = "user-owner";
    const memberId = "user-member-1";
    const nonMemberId = "user-stranger";
    const validUserIds = [ownerId, memberId];

    test("rejects when callerId is empty", () => {
      const result = canLeaveSpace({
        callerId: "",
        ownerId,
        userIds: validUserIds,
      });
      assert.equal(result.isValid, false);
      assert.match(result.error || "", /signed in/i);
    });

    test("rejects when owner is missing from userIds (inconsistent existing record)", () => {
      const inconsistentUserIds = [memberId];
      const result = canLeaveSpace({
        callerId: memberId,
        ownerId,
        userIds: inconsistentUserIds,
      });
      assert.equal(result.isValid, false);
      assert.match(result.error || "", /space owner is missing/i);
    });

    test("rejects when member list contains duplicate UIDs", () => {
      const duplicateUserIds = [ownerId, memberId, memberId];
      const result = canLeaveSpace({
        callerId: memberId,
        ownerId,
        userIds: duplicateUserIds,
      });
      assert.equal(result.isValid, false);
      assert.match(result.error || "", /duplicate user entries/i);
    });

    test("rejects space owner attempting to leave their own space", () => {
      const result = canLeaveSpace({
        callerId: ownerId,
        ownerId,
        userIds: validUserIds,
      });
      assert.equal(result.isValid, false);
      assert.match(result.error || "", /owners cannot leave/i);
    });

    test("rejects user who is not a member of the space", () => {
      const result = canLeaveSpace({
        callerId: nonMemberId,
        ownerId,
        userIds: validUserIds,
      });
      assert.equal(result.isValid, false);
      assert.match(result.error || "", /not a member/i);
    });

    test("accepts valid departure by a non-owner member", () => {
      const result = canLeaveSpace({
        callerId: memberId,
        ownerId,
        userIds: validUserIds,
      });
      assert.equal(result.isValid, true);
      assert.equal(result.error, undefined);
    });
  });

  describe("resolveRemoveMemberError", () => {
    test("maps permission-denied error code", () => {
      const err = Object.assign(new Error("Missing or insufficient permissions"), {
        code: "permission-denied",
      });
      const resolved = resolveRemoveMemberError(err);
      assert.equal(resolved.type, "known_action");
      assert.equal(
        resolved.message,
        "You do not have permission to remove members from this space."
      );
    });

    test("maps permission-denied error message string", () => {
      const err = new Error("FirebaseError: permission-denied");
      const resolved = resolveRemoveMemberError(err);
      assert.equal(resolved.type, "known_action");
      assert.equal(
        resolved.message,
        "You do not have permission to remove members from this space."
      );
    });

    test("maps service unavailable error", () => {
      const err = Object.assign(new Error("Service unavailable"), {
        code: "unavailable",
      });
      const resolved = resolveRemoveMemberError(err);
      assert.equal(resolved.type, "known_action");
      assert.match(resolved.message, /temporarily unavailable/i);
    });

    test("preserves known business and validation messages", () => {
      const err = new Error("The space owner cannot be removed.");
      const resolved = resolveRemoveMemberError(err);
      assert.equal(resolved.type, "known_action");
      assert.equal(resolved.message, "The space owner cannot be removed.");
    });

    test("maps unexpected error to safe generic message", () => {
      const err = new Error("Internal segmentation failure in driver");
      const resolved = resolveRemoveMemberError(err);
      assert.equal(resolved.type, "unexpected");
      assert.equal(resolved.message, "Failed to remove member. Please try again.");
    });

    test("handles non-Error objects safely", () => {
      const resolved = resolveRemoveMemberError({ arbitrary: 123 });
      assert.equal(resolved.type, "unexpected");
      assert.equal(resolved.message, "Failed to remove member. Please try again.");
    });
  });

  describe("resolveLeaveSpaceError", () => {
    test("maps permission-denied error code", () => {
      const err = Object.assign(new Error("Missing or insufficient permissions"), {
        code: "permission-denied",
      });
      const resolved = resolveLeaveSpaceError(err);
      assert.equal(resolved.type, "known_action");
      assert.equal(
        resolved.message,
        "You do not have permission to leave this space."
      );
    });

    test("maps unavailable error", () => {
      const err = Object.assign(new Error("Service unavailable"), {
        code: "unavailable",
      });
      const resolved = resolveLeaveSpaceError(err);
      assert.equal(resolved.type, "known_action");
      assert.match(resolved.message, /temporarily unavailable/i);
    });

    test("preserves known departure constraint error messages", () => {
      const err = new Error(
        "Space owners cannot leave their own spaces while ownership transfer is unavailable."
      );
      const resolved = resolveLeaveSpaceError(err);
      assert.equal(resolved.type, "known_action");
      assert.match(resolved.message, /owners cannot leave/i);
    });

    test("maps unexpected error to safe generic message", () => {
      const err = new Error("Fatal network partition 0xdeadbeef");
      const resolved = resolveLeaveSpaceError(err);
      assert.equal(resolved.type, "unexpected");
      assert.equal(resolved.message, "Failed to leave space. Please try again.");
    });
  });

  describe("resolveJoinSpaceError", () => {
    test("maps permission-denied error code", () => {
      const err = Object.assign(new Error("Missing or insufficient permissions"), {
        code: "permission-denied",
      });
      const resolved = resolveJoinSpaceError(err);
      assert.equal(resolved.type, "known_action");
      assert.equal(
        resolved.message,
        "You do not have permission to join this space."
      );
    });

    test("maps unavailable error", () => {
      const err = Object.assign(new Error("Service unavailable"), {
        code: "unavailable",
      });
      const resolved = resolveJoinSpaceError(err);
      assert.equal(resolved.type, "known_action");
      assert.match(resolved.message, /temporarily unavailable/i);
    });

    test("preserves known join error messages", () => {
      const err = new Error("Cannot join a private space.");
      const resolved = resolveJoinSpaceError(err);
      assert.equal(resolved.type, "known_action");
      assert.equal(resolved.message, "Cannot join a private space.");

      const deletedErr = new Error("Cannot join a deleted space.");
      const resolvedDeleted = resolveJoinSpaceError(deletedErr);
      assert.equal(resolvedDeleted.type, "known_action");
      assert.equal(resolvedDeleted.message, "Cannot join a deleted space.");
    });

    test("maps unexpected error to safe generic message", () => {
      const err = new Error("Fatal network partition 0xdeadbeef");
      const resolved = resolveJoinSpaceError(err);
      assert.equal(resolved.type, "unexpected");
      assert.equal(resolved.message, "Failed to join space. Please try again.");
    });
  });

  describe("invalidateSpaceMemberQueries", () => {
    test("invalidates space, space-members, and user-spaces cache keys", () => {
      const invalidatedKeys: string[][] = [];
      const mockQueryClient = {
        invalidateQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => {
          invalidatedKeys.push(queryKey as string[]);
        },
      };

      invalidateSpaceMemberQueries(mockQueryClient, "space-xyz-123");

      assert.equal(invalidatedKeys.length, 3);
      assert.deepEqual(invalidatedKeys[0], ["space", "space-xyz-123"]);
      assert.deepEqual(invalidatedKeys[1], ["space-members", "space-xyz-123"]);
      assert.deepEqual(invalidatedKeys[2], ["user-spaces"]);
    });
  });

  describe("evictSpaceQueries", () => {
    test("removes cached private space and document queries and invalidates user spaces on departure", () => {
      const removedKeys: string[][] = [];
      const invalidatedKeys: string[][] = [];
      const mockQueryClient = {
        removeQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => {
          removedKeys.push(queryKey as string[]);
        },
        invalidateQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => {
          invalidatedKeys.push(queryKey as string[]);
        },
      };

      evictSpaceQueries(mockQueryClient, "space-depart-456");

      assert.equal(removedKeys.length, 4);
      assert.deepEqual(removedKeys[0], ["space", "space-depart-456"]);
      assert.deepEqual(removedKeys[1], ["space-members", "space-depart-456"]);
      assert.deepEqual(removedKeys[2], ["sidebar-tree", "space-depart-456"]);
      assert.deepEqual(removedKeys[3], ["doc"]);
      assert.equal(invalidatedKeys.length, 1);
      assert.deepEqual(invalidatedKeys[0], ["user-spaces"]);
    });
  });

  describe("validateMemberEmail & resolveMemberActionError (existing)", () => {
    test("validates email correctly", () => {
      assert.equal(validateMemberEmail("user@example.com").isValid, true);
      assert.equal(validateMemberEmail("  user@example.com  ").trimmedEmail, "user@example.com");
      assert.equal(validateMemberEmail("").isValid, false);
      assert.equal(validateMemberEmail("invalid-email").isValid, false);
    });

    test("resolves member action errors correctly", () => {
      const resolved = resolveMemberActionError(new Error("User is already a member."));
      assert.equal(resolved.type, "known_action");
      assert.equal(resolved.message, "User is already a member.");
    });
  });

  describe("Owner Leave Unavailable Explanation", () => {
    test("defines the exact required user-facing explanation message", () => {
      assert.equal(
        OWNER_LEAVE_UNAVAILABLE_EXPLANATION,
        "As the Space owner, you cannot leave this Space while ownership transfer is unavailable."
      );
    });

    test("shows explanation for space owner", () => {
      const result = shouldShowOwnerLeaveExplanation({
        isOwner: true,
        canLeave: false,
      });
      assert.equal(result, true);
    });

    test("does not show explanation for ordinary space member", () => {
      const result = shouldShowOwnerLeaveExplanation({
        isOwner: false,
        canLeave: true,
      });
      assert.equal(result, false);
    });

    test("does not show explanation for non-member", () => {
      const result = shouldShowOwnerLeaveExplanation({
        isOwner: false,
        canLeave: false,
      });
      assert.equal(result, false);
    });
  });

  describe("Contextual Unavailable State & Space Access Invariance", () => {
    test("defines exact required neutral wording and actions for unavailable spaces", () => {
      assert.equal(SPACE_UNAVAILABLE_HEADING, "Space unavailable");
      assert.equal(
        SPACE_UNAVAILABLE_DESCRIPTION,
        "This Space may have been deleted, or you may no longer have access to it."
      );

      const config = getUnavailableStateConfig("space");
      assert.equal(config.title, "Space unavailable");
      assert.equal(
        config.description,
        "This Space may have been deleted, or you may no longer have access to it."
      );
      assert.deepEqual(config.primaryAction, { label: "Go to Home", href: "/" });
      assert.deepEqual(config.secondaryAction, { label: "Open Trash", href: "/trash" });
    });

    test("defines exact required neutral wording and actions for unavailable documents", () => {
      assert.equal(DOCUMENT_UNAVAILABLE_HEADING, "Document unavailable");
      assert.equal(
        DOCUMENT_UNAVAILABLE_DESCRIPTION,
        "This document may have been deleted, or you may no longer have access to it."
      );

      const config = getUnavailableStateConfig("document");
      assert.equal(config.title, "Document unavailable");
      assert.equal(
        config.description,
        "This document may have been deleted, or you may no longer have access to it."
      );
      assert.deepEqual(config.primaryAction, { label: "Go to Home", href: "/" });
      assert.deepEqual(config.secondaryAction, { label: "Open Trash", href: "/trash" });
    });

    test("isSpaceAccessible unifies missing, soft-deleted, and inaccessible spaces under false", () => {
      const uid = "user-alice";

      // 1. Never existed / null
      assert.equal(isSpaceAccessible(null, uid), false);
      assert.equal(isSpaceAccessible(undefined, uid), false);

      // 2. Soft-deleted space
      assert.equal(
        isSpaceAccessible(
          { isPublic: false, userIds: [uid], deletedAt: new Date() },
          uid
        ),
        false
      );

      // 3. Inaccessible private space
      assert.equal(
        isSpaceAccessible(
          { isPublic: false, userIds: ["user-bob"], deletedAt: null },
          uid
        ),
        false
      );

      // 4. Missing userId
      assert.equal(
        isSpaceAccessible(
          { isPublic: true, userIds: ["user-bob"], deletedAt: null },
          null
        ),
        false
      );

      // 5. Accessible active member space
      assert.equal(
        isSpaceAccessible(
          { isPublic: false, userIds: [uid, "user-bob"], deletedAt: null },
          uid
        ),
        true
      );

      // 6. Accessible active public space
      assert.equal(
        isSpaceAccessible(
          { isPublic: true, userIds: ["user-bob"], deletedAt: null },
          uid
        ),
        true
      );
    });
  });
});

