import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateMemberEmail,
  resolveMemberActionError,
  invalidateSpaceMemberQueries,
  type InvalidationTarget,
} from "../member-management.ts";

describe("Member email validation policy", () => {
  it("accepts a normal valid email", () => {
    const result = validateMemberEmail("colleague@example.com");
    assert.strictEqual(result.isValid, true);
    assert.strictEqual(result.trimmedEmail, "colleague@example.com");
    assert.strictEqual(result.error, undefined);
  });

  it("trims leading and trailing whitespace from email", () => {
    const result = validateMemberEmail("   colleague@example.com   ");
    assert.strictEqual(result.isValid, true);
    assert.strictEqual(result.trimmedEmail, "colleague@example.com");
    assert.strictEqual(result.error, undefined);
  });

  it("accepts domain without a dot under application-level policy", () => {
    const result = validateMemberEmail("colleague@example");
    assert.strictEqual(result.isValid, true);
    assert.strictEqual(result.trimmedEmail, "colleague@example");
    assert.strictEqual(result.error, undefined);
  });

  it("rejects an empty string", () => {
    const result = validateMemberEmail("");
    assert.strictEqual(result.isValid, false);
    assert.strictEqual(result.trimmedEmail, "");
    assert.strictEqual(result.error, "Please enter an email address.");
  });

  it("rejects whitespace-only email", () => {
    const result = validateMemberEmail("   \t  \n ");
    assert.strictEqual(result.isValid, false);
    assert.strictEqual(result.trimmedEmail, "");
    assert.strictEqual(result.error, "Please enter an email address.");
  });

  it("rejects malformed emails missing @ or domain or local part", () => {
    const missingAt = validateMemberEmail("colleagueexample.com");
    assert.strictEqual(missingAt.isValid, false);
    assert.strictEqual(missingAt.error, "Please enter a valid email address.");

    const missingDomain = validateMemberEmail("colleague@");
    assert.strictEqual(missingDomain.isValid, false);
    assert.strictEqual(missingDomain.error, "Please enter a valid email address.");

    const missingLocal = validateMemberEmail("@example.com");
    assert.strictEqual(missingLocal.isValid, false);
    assert.strictEqual(missingLocal.error, "Please enter a valid email address.");

    const multipleAt = validateMemberEmail("colleague@work@example.com");
    assert.strictEqual(multipleAt.isValid, false);
    assert.strictEqual(multipleAt.error, "Please enter a valid email address.");

    const internalSpacesLocal = validateMemberEmail("col league@example.com");
    assert.strictEqual(internalSpacesLocal.isValid, false);
    assert.strictEqual(internalSpacesLocal.error, "Please enter a valid email address.");

    const internalSpacesDomain = validateMemberEmail("colleague@example com");
    assert.strictEqual(internalSpacesDomain.isValid, false);
    assert.strictEqual(internalSpacesDomain.error, "Please enter a valid email address.");
  });
});

describe("Member action error resolution and classification", () => {
  it("classifies user-not-found as a known action error", () => {
    const err = new Error("User not found. They must sign up first.");
    const resolved = resolveMemberActionError(err);
    assert.strictEqual(resolved.type, "known_action");
    assert.strictEqual(resolved.message, "User not found. They must sign up first.");
  });

  it("classifies already-member as a known action error", () => {
    const err = new Error("User is already a member.");
    const resolved = resolveMemberActionError(err);
    assert.strictEqual(resolved.type, "known_action");
    assert.strictEqual(resolved.message, "User is already a member.");
  });

  it("classifies space-not-found as a known action error", () => {
    const err = new Error("Space not found.");
    const resolved = resolveMemberActionError(err);
    assert.strictEqual(resolved.type, "known_action");
    assert.strictEqual(resolved.message, "Space not found.");
  });

  it("classifies permission-denied Firebase error as known action error", () => {
    const firebaseErr = Object.assign(new Error("Missing or insufficient permissions"), {
      code: "permission-denied",
    });
    const resolved = resolveMemberActionError(firebaseErr);
    assert.strictEqual(resolved.type, "known_action");
    assert.strictEqual(
      resolved.message,
      "You do not have permission to add members to this space."
    );
  });

  it("classifies unavailable service as known action error", () => {
    const unavailableErr = Object.assign(new Error("Service unavailable"), {
      code: "unavailable",
    });
    const resolved = resolveMemberActionError(unavailableErr);
    assert.strictEqual(resolved.type, "known_action");
    assert.strictEqual(
      resolved.message,
      "The service is temporarily unavailable. Please try again later."
    );
  });

  it("classifies validation messages as validation type", () => {
    const validationErr = new Error("Please enter a valid email address.");
    const resolved = resolveMemberActionError(validationErr);
    assert.strictEqual(resolved.type, "validation");
    assert.strictEqual(resolved.message, "Please enter a valid email address.");
  });

  it("classifies unexpected errors with a safe user-facing message without leaking internal details", () => {
    const internalErr = new Error("TypeError: Cannot read properties of undefined (reading 'xyz')");
    const resolved = resolveMemberActionError(internalErr);
    assert.strictEqual(resolved.type, "unexpected");
    assert.strictEqual(resolved.message, "Failed to add member. Please try again.");
    assert.strictEqual(resolved.message.includes("TypeError"), false);
  });
});

describe("Cache invalidation lifecycle", () => {
  it("invalidates active space and space-members query keys for the given space", () => {
    const invalidatedKeys: unknown[][] = [];
    const mockQueryClient: InvalidationTarget = {
      invalidateQueries: ({ queryKey }) => {
        invalidatedKeys.push(queryKey as unknown[]);
      },
    };

    invalidateSpaceMemberQueries(mockQueryClient, "space-42");

    assert.strictEqual(invalidatedKeys.length, 3);
    assert.deepStrictEqual(invalidatedKeys[0], ["space", "space-42"]);
    assert.deepStrictEqual(invalidatedKeys[1], ["space-members", "space-42"]);
    assert.deepStrictEqual(invalidatedKeys[2], ["user-spaces"]);
  });
});
