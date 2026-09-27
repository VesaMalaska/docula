import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from "@firebase/rules-unit-testing";
import type { RulesTestEnvironment } from "@firebase/rules-unit-testing";
import {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  runTransaction,
  collection,
  query,
  where,
  getDocs,
  writeBatch,
  deleteField,
} from "firebase/firestore";
import { extractImageUrls } from "../utils.ts";

const isEmulatorRunning = !!process.env.FIRESTORE_EMULATOR_HOST;

if (!isEmulatorRunning) {
  if (process.env.REQUIRE_EMULATOR === "true") {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST environment variable not set, but REQUIRE_EMULATOR is true. Emulator must be running."
    );
  }
  test("Firestore Security Rules Tests (skipped: requires FIRESTORE_EMULATOR_HOST)", (t) => {
    t.skip(
      "FIRESTORE_EMULATOR_HOST environment variable not set. Run via 'pnpm run test:rules' or 'firebase emulators:exec'."
    );
  });
} else {
  describe("Firestore Security Rules — Space Membership & Permissions", () => {
    let testEnv: RulesTestEnvironment;
    const rulesPath = path.resolve(process.cwd(), "firestore.rules");
    const rules = fs.readFileSync(rulesPath, "utf8");

    before(async () => {
      testEnv = await initializeTestEnvironment({
        projectId: "demo-docula-test",
        firestore: {
          rules,
        },
      });
    });

    after(async () => {
      if (testEnv) {
        await testEnv.cleanup();
      }
    });

    beforeEach(async () => {
      await testEnv.clearFirestore();
    });

    describe("Space Creation Constraints", () => {
      test("authenticated user can create space when ownerId == auth.uid and userIds == [auth.uid]", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const spaceRef = doc(alice, "spaces", "space-alice-1");

        await assertSucceeds(
          setDoc(spaceRef, {
            name: "Alice Space",
            isPublic: false,
            description: "A private space",
            ownerId: "alice",
            userIds: ["alice"],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            deletedAt: null,
            deletedBy: null,
          })
        );
      });

      test("rejects space creation by unauthenticated user", async () => {
        const unauth = testEnv.unauthenticatedContext().firestore();
        const spaceRef = doc(unauth, "spaces", "space-unauth");

        await assertFails(
          setDoc(spaceRef, {
            name: "Unauth Space",
            isPublic: true,
            ownerId: "anyone",
            userIds: ["anyone"],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("rejects space creation when ownerId does not match authenticated uid", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const spaceRef = doc(bob, "spaces", "space-spoof-owner");

        await assertFails(
          setDoc(spaceRef, {
            name: "Spoofed Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["bob"],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("rejects space creation when userIds does not contain exactly the ownerId", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const spaceRef = doc(alice, "spaces", "space-multi-user-create");

        // Attempting to add bob at creation time
        await assertFails(
          setDoc(spaceRef, {
            name: "Multi-user Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        // Attempting to omit alice from userIds at creation time
        await assertFails(
          setDoc(spaceRef, {
            name: "No-owner Space",
            isPublic: false,
            ownerId: "alice",
            userIds: [],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("rejects space creation when createdAt or updatedAt is not serverTimestamp()", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();

        // client-generated timestamp instead of request.time
        await assertFails(
          setDoc(doc(alice, "spaces", "space-client-time"), {
            name: "Client Time Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice"],
            createdAt: new Date("2020-01-01T00:00:00Z"),
            updatedAt: serverTimestamp(),
          })
        );

        await assertFails(
          setDoc(doc(alice, "spaces", "space-client-time-2"), {
            name: "Client Time Space 2",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice"],
            createdAt: serverTimestamp(),
            updatedAt: new Date("2020-01-01T00:00:00Z"),
          })
        );
      });

      test("rejects space creation when name is empty or invalid type", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();

        await assertFails(
          setDoc(doc(alice, "spaces", "space-empty-name"), {
            name: "",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice"],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        await assertFails(
          setDoc(doc(alice, "spaces", "space-numeric-name"), {
            name: 12345,
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice"],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("rejects space creation when isPublic is not boolean", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();

        await assertFails(
          setDoc(doc(alice, "spaces", "space-non-bool-public"), {
            name: "Non-Bool Space",
            isPublic: "true",
            ownerId: "alice",
            userIds: ["alice"],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("rejects space creation with non-null deletedAt or deletedBy", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();

        await assertFails(
          setDoc(doc(alice, "spaces", "space-deleted-at-create"), {
            name: "Already Deleted Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice"],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            deletedAt: serverTimestamp(),
          })
        );

        await assertFails(
          setDoc(doc(alice, "spaces", "space-deleted-by-create"), {
            name: "Already Deleted By Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice"],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            deletedBy: "alice",
          })
        );
      });
    });

    describe("Space Member Removal & Invariant Enforcement", () => {
      const spaceId = "space-removal-test";

      beforeEach(async () => {
        // Seed space with alice (owner), bob (member), charlie (member)
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await setDoc(doc(db, "spaces", spaceId), {
            name: "Team Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob", "charlie"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            deletedBy: null,
          });
        });
      });

      test("owner can remove a non-owner member", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const spaceRef = doc(alice, "spaces", spaceId);

        await assertSucceeds(
          updateDoc(spaceRef, {
            userIds: ["alice", "charlie"],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("rejects non-owner removing another member", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const spaceRef = doc(bob, "spaces", spaceId);

        // Bob tries to remove Charlie
        await assertFails(
          updateDoc(spaceRef, {
            userIds: ["alice", "bob"],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("rejects removal of the space owner by anyone (including owner)", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const bob = testEnv.authenticatedContext("bob").firestore();

        // Alice attempts to remove herself
        await assertFails(
          updateDoc(doc(alice, "spaces", spaceId), {
            userIds: ["bob", "charlie"],
            updatedAt: serverTimestamp(),
          })
        );

        // Bob attempts to remove Alice
        await assertFails(
          updateDoc(doc(bob, "spaces", spaceId), {
            userIds: ["bob", "charlie"],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("rejects owner removing multiple members in a single update", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const spaceRef = doc(alice, "spaces", spaceId);

        // Attempt to remove both bob and charlie simultaneously
        await assertFails(
          updateDoc(spaceRef, {
            userIds: ["alice"],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("rejects duplicate UID bypass attempting to drop multiple members (e.g. [owner, a, b, c] -> [owner, owner, a])", async () => {
        const fourUserSpaceId = "space-four-users";
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await setDoc(doc(db, "spaces", fourUserSpaceId), {
            name: "Four User Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob", "charlie", "david"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            deletedBy: null,
          });
        });

        const alice = testEnv.authenticatedContext("alice").firestore();
        const spaceRef = doc(alice, "spaces", fourUserSpaceId);

        // Attacker attempts to forge list with duplicate owner to satisfy subset check
        // while dropping two distinct users (charlie and david)
        await assertFails(
          updateDoc(spaceRef, {
            userIds: ["alice", "alice", "bob"],
            updatedAt: serverTimestamp(),
          })
        );

        // Also test duplicate member UID
        await assertFails(
          updateDoc(spaceRef, {
            userIds: ["alice", "bob", "bob"],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("rejects any attempt to change space ownerId during update", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const bob = testEnv.authenticatedContext("bob").firestore();
        const spaceRefAlice = doc(alice, "spaces", spaceId);
        const spaceRefBob = doc(bob, "spaces", spaceId);

        // Alice (owner) tries to change ownerId to bob
        await assertFails(
          updateDoc(spaceRefAlice, {
            ownerId: "bob",
            updatedAt: serverTimestamp(),
          })
        );

        // Bob (member) tries to hijack ownership
        await assertFails(
          updateDoc(spaceRefBob, {
            ownerId: "bob",
            updatedAt: serverTimestamp(),
          })
        );
      });
    });

    describe("Voluntary Member Departure (Leave Space)", () => {
      const spaceId = "space-departure-test";

      beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await setDoc(doc(db, "spaces", spaceId), {
            name: "Departure Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob", "charlie"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            deletedBy: null,
          });
        });
      });

      test("non-owner member can voluntarily leave the space", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const spaceRef = doc(bob, "spaces", spaceId);

        await assertSucceeds(
          updateDoc(spaceRef, {
            userIds: ["alice", "charlie"],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("space owner cannot leave their own space", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const spaceRef = doc(alice, "spaces", spaceId);

        // Alice tries to leave
        await assertFails(
          updateDoc(spaceRef, {
            userIds: ["bob", "charlie"],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("departing member cannot alter other space attributes during departure", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const spaceRef = doc(bob, "spaces", spaceId);

        // Bob leaves and also renames the space
        await assertFails(
          updateDoc(spaceRef, {
            name: "Hacked Space",
            userIds: ["alice", "charlie"],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("user cannot remove another member under the guise of departure", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const spaceRef = doc(bob, "spaces", spaceId);

        // Bob tries to remove Charlie instead of Bob
        await assertFails(
          updateDoc(spaceRef, {
            userIds: ["alice", "bob"],
            updatedAt: serverTimestamp(),
          })
        );
      });
    });

    describe("Inconsistent Existing Records Policy", () => {
      const brokenSpaceId = "broken-space-test";

      beforeEach(async () => {
        // Space where ownerId is 'alice', but userIds does NOT contain 'alice'
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await setDoc(doc(db, "spaces", brokenSpaceId), {
            name: "Inconsistent Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["bob", "charlie"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            deletedBy: null,
          });
        });
      });

      test("rejects member removal on inconsistent existing records", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const spaceRef = doc(alice, "spaces", brokenSpaceId);

        // Alice tries to remove Bob, but space already violates ownerId in userIds
        await assertFails(
          updateDoc(spaceRef, {
            userIds: ["charlie"],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("rejects member departure on inconsistent existing records", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const spaceRef = doc(bob, "spaces", brokenSpaceId);

        // Bob tries to leave, but space violates retainsOwnership
        await assertFails(
          updateDoc(spaceRef, {
            userIds: ["charlie"],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("rejects member removal or departure when existing record contains duplicate UIDs", async () => {
        const dupSpaceId = "dup-existing-space-test";
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await setDoc(doc(db, "spaces", dupSpaceId), {
            name: "Duplicate UIDs Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "alice", "bob"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            deletedBy: null,
          });
        });

        const alice = testEnv.authenticatedContext("alice").firestore();
        const bob = testEnv.authenticatedContext("bob").firestore();

        // Alice attempts removal on malformed existing record
        await assertFails(
          updateDoc(doc(alice, "spaces", dupSpaceId), {
            userIds: ["alice", "alice"],
            updatedAt: serverTimestamp(),
          })
        );

        // Bob attempts departure on malformed existing record
        await assertFails(
          updateDoc(doc(bob, "spaces", dupSpaceId), {
            userIds: ["alice", "alice"],
            updatedAt: serverTimestamp(),
          })
        );
      });
    });

    describe("Public vs Private Space Document & Content Access", () => {
      const publicSpaceId = "public-space-test";
      const privateSpaceId = "private-space-test";
      const publicDocId = "doc-pub-1";
      const privateDocId = "doc-priv-1";

      beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();

          // Public space
          await setDoc(doc(db, "spaces", publicSpaceId), {
            name: "Public Space",
            isPublic: true,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            deletedBy: null,
          });

          // Private space
          await setDoc(doc(db, "spaces", privateSpaceId), {
            name: "Private Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            deletedBy: null,
          });

          // Document in public space
          await setDoc(doc(db, "documents", publicDocId), {
            title: "Public Document",
            spaceId: publicSpaceId,
            parentId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          // Document in private space
          await setDoc(doc(db, "documents", privateDocId), {
            title: "Private Document",
            spaceId: privateSpaceId,
            parentId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        });
      });

      test("unauthenticated user cannot read any documents", async () => {
        const unauth = testEnv.unauthenticatedContext().firestore();
        await assertFails(getDoc(doc(unauth, "documents", publicDocId)));
        await assertFails(getDoc(doc(unauth, "documents", privateDocId)));
      });

      test("authenticated non-member can read public document but cannot read private document", async () => {
        const charlie = testEnv.authenticatedContext("charlie").firestore();
        await assertSucceeds(getDoc(doc(charlie, "documents", publicDocId)));
        await assertFails(getDoc(doc(charlie, "documents", privateDocId)));
      });

      test("public non-member cannot create, update, or delete documents", async () => {
        const charlie = testEnv.authenticatedContext("charlie").firestore();

        // Create document denial
        await assertFails(
          setDoc(doc(charlie, "documents", "doc-charlie-pub"), {
            title: "Charlie Doc",
            spaceId: publicSpaceId,
            parentId: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        // Update document denial (e.g. acquire edit lock or rename)
        await assertFails(
          updateDoc(doc(charlie, "documents", publicDocId), {
            title: "Vandalized Title",
            updatedAt: serverTimestamp(),
          })
        );

        // Delete document denial
        await assertFails(deleteDoc(doc(charlie, "documents", publicDocId)));

        // Create document content denial
        await assertFails(
          setDoc(doc(charlie, `documents/${publicDocId}/content`, "main"), {
            content: "Unauthorized content",
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("space member can read, create, update, and delete documents and content", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();

        // Member reads public and private documents
        await assertSucceeds(getDoc(doc(bob, "documents", publicDocId)));
        await assertSucceeds(getDoc(doc(bob, "documents", privateDocId)));

        // Member creates document
        const newDocId = "doc-bob-created";
        await assertSucceeds(
          setDoc(doc(bob, "documents", newDocId), {
            title: "Bob Doc",
            spaceId: publicSpaceId,
            parentId: null,
            path: [],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        // Member updates document
        await assertSucceeds(
          updateDoc(doc(bob, "documents", newDocId), {
            title: "Bob Doc Updated",
            updatedAt: serverTimestamp(),
          })
        );

        // Member direct write to content subcollection on existing document is denied
        await assertFails(
          setDoc(doc(bob, `documents/${newDocId}/content`, "main"), {
            content: "Bob content",
            updatedAt: serverTimestamp(),
          })
        );

        // Member direct soft-deletion via updateDoc is denied under server-authoritative lifecycle
        await assertFails(
          updateDoc(doc(bob, "documents", newDocId), {
            deleted: true,
            deletedAt: serverTimestamp(),
            deletedBy: "bob",
            updatedAt: serverTimestamp(),
          })
        );

        // Member cannot hard-delete document directly in active space
        await assertFails(deleteDoc(doc(bob, "documents", newDocId)));
      });
    });

    describe("Space Soft-Delete, Restore, and Permanent Deletion Restrictions", () => {
      const deleteSpaceId = "space-delete-lifecycle";

      beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await setDoc(doc(db, "spaces", deleteSpaceId), {
            name: "Deletion Lifecycle Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            deletedBy: null,
          });
        });
      });

      test("only owner can soft-delete a space; member is rejected", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const alice = testEnv.authenticatedContext("alice").firestore();
        const spaceRefBob = doc(bob, "spaces", deleteSpaceId);
        const spaceRefAlice = doc(alice, "spaces", deleteSpaceId);

        // Bob (non-owner member) attempts soft delete
        await assertFails(
          updateDoc(spaceRefBob, {
            deletedAt: serverTimestamp(),
            deletedBy: "bob",
          })
        );

        // Alice (owner) soft deletes
        await assertSucceeds(
          updateDoc(spaceRefAlice, {
            deletedAt: serverTimestamp(),
            deletedBy: "alice",
          })
        );
      });

      test("only owner can restore a soft-deleted space; member is rejected", async () => {
        // Mark as deleted first
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await updateDoc(doc(db, "spaces", deleteSpaceId), {
            deletedAt: new Date(),
            deletedBy: "alice",
          });
        });

        const bob = testEnv.authenticatedContext("bob").firestore();
        const alice = testEnv.authenticatedContext("alice").firestore();

        // Bob attempts restore
        await assertFails(
          updateDoc(doc(bob, "spaces", deleteSpaceId), {
            deletedAt: null,
            deletedBy: null,
          })
        );

        // Alice restores
        await assertSucceeds(
          updateDoc(doc(alice, "spaces", deleteSpaceId), {
            deletedAt: null,
            deletedBy: null,
          })
        );

        // Member can read the space again once restored
        await assertSucceeds(getDoc(doc(bob, "spaces", deleteSpaceId)));
      });

      test("permanent deletion requires soft-deleted space; active deletion rejected", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const alice = testEnv.authenticatedContext("alice").firestore();

        // 1. Owner cannot permanently delete an active space directly
        await assertFails(deleteDoc(doc(alice, "spaces", deleteSpaceId)));

        // 2. Non-owner cannot permanently delete active space
        await assertFails(deleteDoc(doc(bob, "spaces", deleteSpaceId)));

        // 3. Alice soft-deletes the space first
        await assertSucceeds(
          updateDoc(doc(alice, "spaces", deleteSpaceId), {
            deletedAt: serverTimestamp(),
            deletedBy: "alice",
            updatedAt: serverTimestamp(),
          })
        );

        // 4. Non-owner cannot permanently delete soft-deleted space
        await assertFails(deleteDoc(doc(bob, "spaces", deleteSpaceId)));

        // 5. Direct client space deletion is closed in rules (must use server action)
        await assertFails(deleteDoc(doc(alice, "spaces", deleteSpaceId)));
      });

      test("cannot soft-delete an already soft-deleted space", async () => {
        // Mark as deleted first
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await updateDoc(doc(db, "spaces", deleteSpaceId), {
            deletedAt: new Date(),
            deletedBy: "alice",
          });
        });

        const alice = testEnv.authenticatedContext("alice").firestore();
        await assertFails(
          updateDoc(doc(alice, "spaces", deleteSpaceId), {
            deletedAt: serverTimestamp(),
            deletedBy: "alice",
          })
        );
      });

      test("cannot restore an active (not soft-deleted) space", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        await assertFails(
          updateDoc(doc(alice, "spaces", deleteSpaceId), {
            deletedAt: null,
            deletedBy: null,
          })
        );
      });

      test("blocks all mutations on soft-deleted space: join, add, remove, leave, rename, doc operations", async () => {
        const publicDeletedSpaceId = "space-public-deleted";
        const docInDeletedSpaceId = "doc-in-deleted-space";

        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await setDoc(doc(db, "spaces", publicDeletedSpaceId), {
            name: "Deleted Public Space",
            isPublic: true,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: new Date(),
            deletedBy: "alice",
          });

          await setDoc(doc(db, "documents", docInDeletedSpaceId), {
            title: "Existing Doc in Deleted Space",
            spaceId: publicDeletedSpaceId,
            parentId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        });

        const alice = testEnv.authenticatedContext("alice").firestore();
        const bob = testEnv.authenticatedContext("bob").firestore();
        const charlie = testEnv.authenticatedContext("charlie").firestore();

        // 1. Charlie cannot join deleted public space
        await assertFails(
          updateDoc(doc(charlie, "spaces", publicDeletedSpaceId), {
            userIds: ["alice", "bob", "charlie"],
            updatedAt: serverTimestamp(),
          })
        );

        // 2. Alice cannot add member to deleted space
        await assertFails(
          updateDoc(doc(alice, "spaces", publicDeletedSpaceId), {
            userIds: ["alice", "bob", "charlie"],
            updatedAt: serverTimestamp(),
          })
        );

        // 3. Alice cannot remove member from deleted space
        await assertFails(
          updateDoc(doc(alice, "spaces", publicDeletedSpaceId), {
            userIds: ["alice"],
            updatedAt: serverTimestamp(),
          })
        );

        // 4. Bob cannot leave deleted space
        await assertFails(
          updateDoc(doc(bob, "spaces", publicDeletedSpaceId), {
            userIds: ["alice"],
            updatedAt: serverTimestamp(),
          })
        );

        // 5. Alice cannot rename deleted space
        await assertFails(
          updateDoc(doc(alice, "spaces", publicDeletedSpaceId), {
            name: "Renamed Deleted Space",
            updatedAt: serverTimestamp(),
          })
        );

        // 6. Cannot create document in deleted space
        await assertFails(
          setDoc(doc(alice, "documents", "new-doc-in-deleted"), {
            title: "New Doc",
            spaceId: publicDeletedSpaceId,
            parentId: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        // 7. Cannot update document in deleted space
        await assertFails(
          updateDoc(doc(alice, "documents", docInDeletedSpaceId), {
            title: "Updated Doc Title",
            updatedAt: serverTimestamp(),
          })
        );

        // 8. Cannot write content to document in deleted space
        await assertFails(
          setDoc(doc(alice, `documents/${docInDeletedSpaceId}/content`, "main"), {
            content: "New content in deleted space",
            updatedAt: serverTimestamp(),
          })
        );

        // 9. Space metadata read access is preserved so collection queries succeed without permission-denied
        await assertSucceeds(getDoc(doc(bob, "spaces", publicDeletedSpaceId)));
        await assertSucceeds(getDoc(doc(charlie, "spaces", publicDeletedSpaceId)));

        // 10. Owner CAN read deleted space metadata (for Trashbin display and recovery)
        await assertSucceeds(getDoc(doc(alice, "spaces", publicDeletedSpaceId)));

        // 11. Non-owners cannot read documents or content in deleted space
        await assertFails(getDoc(doc(bob, "documents", docInDeletedSpaceId)));
        await assertFails(getDoc(doc(charlie, "documents", docInDeletedSpaceId)));
        await assertFails(
          getDoc(doc(bob, `documents/${docInDeletedSpaceId}/content`, "main"))
        );
        await assertFails(
          getDoc(doc(charlie, `documents/${docInDeletedSpaceId}/content`, "main"))
        );

        // 12. Non-owner cannot delete document in deleted space
        await assertFails(
          deleteDoc(doc(bob, "documents", docInDeletedSpaceId))
        );
        await assertFails(
          deleteDoc(doc(charlie, "documents", docInDeletedSpaceId))
        );

        // 13. Owner CAN read and delete documents in deleted space for permanent cleanup
        await assertSucceeds(
          getDoc(doc(alice, "documents", docInDeletedSpaceId))
        );
        await assertSucceeds(
          deleteDoc(doc(alice, "documents", docInDeletedSpaceId))
        );

        // 14. Direct client space deletion is closed in rules (must use server action)
        await assertFails(
          deleteDoc(doc(alice, "spaces", publicDeletedSpaceId))
        );
      });
    });

    describe("Space Permanent Purge and Direct Deletion Restrictions (Rules Integrity)", () => {
      const purgeSpaceId = "space-purge-rules-test";
      const purgeDocId = "doc-purge-rules-test";

      beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await setDoc(doc(db, "spaces", purgeSpaceId), {
            name: "Purge Rules Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: new Date(),
            deletedBy: "alice",
            purgeState: "purging",
          });

          await setDoc(doc(db, "documents", purgeDocId), {
            title: "Doc in Purging Space",
            spaceId: purgeSpaceId,
            parentId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        });
      });

      test("direct-client space deletion is completely closed in rules for owner, member, and non-member", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const bob = testEnv.authenticatedContext("bob").firestore();
        const charlie = testEnv.authenticatedContext("charlie").firestore();

        await assertFails(deleteDoc(doc(alice, "spaces", purgeSpaceId)));
        await assertFails(deleteDoc(doc(bob, "spaces", purgeSpaceId)));
        await assertFails(deleteDoc(doc(charlie, "spaces", purgeSpaceId)));
      });

      test("restoration is blocked by rules once purge has started (purgeState set)", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const bob = testEnv.authenticatedContext("bob").firestore();

        // Alice (owner) cannot restore space when purgeState is set
        await assertFails(
          updateDoc(doc(alice, "spaces", purgeSpaceId), {
            deletedAt: null,
            deletedBy: null,
            updatedAt: serverTimestamp(),
          })
        );

        // Bob (non-owner) cannot restore space
        await assertFails(
          updateDoc(doc(bob, "spaces", purgeSpaceId), {
            deletedAt: null,
            deletedBy: null,
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("document writes and direct document cleanup are blocked by rules once purge has started", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const bob = testEnv.authenticatedContext("bob").firestore();

        // Document create blocked
        await assertFails(
          setDoc(doc(alice, "documents", "new-doc-purging"), {
            title: "New Doc",
            spaceId: purgeSpaceId,
            parentId: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        // Document update blocked
        await assertFails(
          updateDoc(doc(alice, "documents", purgeDocId), {
            title: "Updated Title",
            updatedAt: serverTimestamp(),
          })
        );

        // Direct client document cleanup delete blocked once purge has started
        await assertFails(deleteDoc(doc(alice, "documents", purgeDocId)));
        await assertFails(deleteDoc(doc(bob, "documents", purgeDocId)));
      });
    });

    describe("Mixed Active and Soft-Deleted Spaces Queries & Discovery", () => {
      const activeMemberSpaceId = "space-active-member";
      const deletedMemberSpaceId = "space-deleted-member";
      const legacyMemberSpaceId = "space-legacy-member";
      const activePublicSpaceId = "space-active-public";
      const deletedPublicSpaceId = "space-deleted-public";

      beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();

          // 1. Active private space with Alice as owner and Bob as member
          await setDoc(doc(db, "spaces", activeMemberSpaceId), {
            name: "Active Member Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: new Date("2026-01-01T10:00:00Z"),
            updatedAt: new Date("2026-01-01T10:00:00Z"),
            deletedAt: null,
            deletedBy: null,
          });

          // 2. Soft-deleted private space with Alice as owner and Bob still listed in userIds
          await setDoc(doc(db, "spaces", deletedMemberSpaceId), {
            name: "Deleted Member Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: new Date("2026-01-02T10:00:00Z"),
            updatedAt: new Date("2026-01-02T12:00:00Z"),
            deletedAt: new Date("2026-01-02T12:00:00Z"),
            deletedBy: "alice",
          });

          // 3. Legacy space where deletedAt is absent rather than explicitly null
          await setDoc(doc(db, "spaces", legacyMemberSpaceId), {
            name: "Legacy Member Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: new Date("2025-12-01T10:00:00Z"),
            updatedAt: new Date("2025-12-01T10:00:00Z"),
            // deletedAt and deletedBy are intentionally omitted
          });

          // 4. Active public space
          await setDoc(doc(db, "spaces", activePublicSpaceId), {
            name: "Active Public Space",
            isPublic: true,
            ownerId: "alice",
            userIds: ["alice"],
            createdAt: new Date("2026-01-03T10:00:00Z"),
            updatedAt: new Date("2026-01-03T10:00:00Z"),
            deletedAt: null,
            deletedBy: null,
          });

          // 5. Soft-deleted public space
          await setDoc(doc(db, "spaces", deletedPublicSpaceId), {
            name: "Deleted Public Space",
            isPublic: true,
            ownerId: "alice",
            userIds: ["alice"],
            createdAt: new Date("2026-01-04T10:00:00Z"),
            updatedAt: new Date("2026-01-04T12:00:00Z"),
            deletedAt: new Date("2026-01-04T12:00:00Z"),
            deletedBy: "alice",
          });
        });
      });

      test("ordinary member query succeeds on mixed active/deleted collection and filters deleted spaces", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();

        // Query matching getSpacesForUser: where("userIds", "array-contains", userId)
        const q = query(
          collection(bob, "spaces"),
          where("userIds", "array-contains", "bob")
        );

        // Security rules allow the query because Bob has metadata read access on all matching spaces
        const snap = await assertSucceeds(getDocs(q));
        assert.equal(snap.docs.length, 3); // active, deleted, and legacy spaces all matched

        // Application-side filtering (getSpacesForUser: !data.deletedAt)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const activeSpaces = snap.docs.filter((d) => !(d.data() as any).deletedAt);
        assert.equal(activeSpaces.length, 2);

        const activeIds = activeSpaces.map((d) => d.id);
        assert.ok(activeIds.includes(activeMemberSpaceId));
        assert.ok(activeIds.includes(legacyMemberSpaceId)); // legacy space with absent deletedAt is treated as active
        assert.ok(!activeIds.includes(deletedMemberSpaceId));
      });

      test("public space discovery query succeeds when active and deleted public spaces coexist", async () => {
        const charlie = testEnv.authenticatedContext("charlie").firestore();

        // Query matching getPublicSpaces: where("isPublic", "==", true)
        const q = query(
          collection(charlie, "spaces"),
          where("isPublic", "==", true)
        );

        const snap = await assertSucceeds(getDocs(q));
        assert.equal(snap.docs.length, 2); // active public and deleted public

        // Application-side filtering (getPublicSpaces: !data.deletedAt)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const visiblePublicSpaces = snap.docs.filter((d) => !(d.data() as any).deletedAt);
        assert.equal(visiblePublicSpaces.length, 1);
        assert.equal(visiblePublicSpaces[0].id, activePublicSpaceId);
      });

      test("owner can query deleted spaces for Trashbin; non-owner query returns empty", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const bob = testEnv.authenticatedContext("bob").firestore();

        // Query matching getDeletedSpacesForUser for owner
        const ownerTrashQuery = query(
          collection(alice, "spaces"),
          where("ownerId", "==", "alice"),
          where("deletedAt", "!=", null)
        );
        const ownerSnap = await assertSucceeds(getDocs(ownerTrashQuery));
        assert.equal(ownerSnap.docs.length, 2);
        const ownerDeletedIds = ownerSnap.docs.map((d) => d.id);
        assert.ok(ownerDeletedIds.includes(deletedMemberSpaceId));
        assert.ok(ownerDeletedIds.includes(deletedPublicSpaceId));

        // Query matching getDeletedSpacesForUser for non-owner (Bob)
        const nonOwnerTrashQuery = query(
          collection(bob, "spaces"),
          where("ownerId", "==", "bob"),
          where("deletedAt", "!=", null)
        );
        const nonOwnerSnap = await assertSucceeds(getDocs(nonOwnerTrashQuery));
        assert.equal(nonOwnerSnap.docs.length, 0);
      });

      test("restoring soft-deleted space returns it to active user spaces and public lists", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const bob = testEnv.authenticatedContext("bob").firestore();
        const charlie = testEnv.authenticatedContext("charlie").firestore();

        // Alice restores deletedMemberSpaceId
        await assertSucceeds(
          updateDoc(doc(alice, "spaces", deletedMemberSpaceId), {
            deletedAt: null,
            deletedBy: null,
          })
        );

        // Alice restores deletedPublicSpaceId
        await assertSucceeds(
          updateDoc(doc(alice, "spaces", deletedPublicSpaceId), {
            deletedAt: null,
            deletedBy: null,
          })
        );

        // Bob's active spaces now includes restored deletedMemberSpaceId
        const bobSnap = await assertSucceeds(
          getDocs(query(collection(bob, "spaces"), where("userIds", "array-contains", "bob")))
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bobActive = bobSnap.docs.filter((d) => !(d.data() as any).deletedAt);
        assert.equal(bobActive.length, 3);
        assert.ok(bobActive.map((d) => d.id).includes(deletedMemberSpaceId));

        // Charlie's public spaces now includes restored deletedPublicSpaceId
        const charlieSnap = await assertSucceeds(
          getDocs(query(collection(charlie, "spaces"), where("isPublic", "==", true)))
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const charlieActive = charlieSnap.docs.filter((d) => !(d.data() as any).deletedAt);
        assert.equal(charlieActive.length, 2);
        assert.ok(charlieActive.map((d) => d.id).includes(deletedPublicSpaceId));
      });
    });

    describe("Permanent Deletion Cascade on Soft-Deleted Space with Content & Images", () => {
      const cascadeSpaceId = "space-cascade-test";
      const cascadeDoc1Id = "doc-cascade-1";
      const cascadeDoc2Id = "doc-cascade-2";

      const sampleDocContent = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Here is a document with an image." }],
          },
          {
            type: "image",
            attrs: {
              src: "https://my-bucket.s3.us-east-1.amazonaws.com/uploads/diagram.png",
              alt: "Architecture Diagram",
            },
          },
        ],
      };

      beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();

          // Soft-deleted space
          await setDoc(doc(db, "spaces", cascadeSpaceId), {
            name: "Cascade Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: new Date("2026-01-01T10:00:00Z"),
            updatedAt: new Date("2026-01-01T12:00:00Z"),
            deletedAt: new Date("2026-01-01T12:00:00Z"),
            deletedBy: "alice",
          });

          // Document 1 with content subcollection containing an image
          await setDoc(doc(db, "documents", cascadeDoc1Id), {
            title: "Document with Image",
            spaceId: cascadeSpaceId,
            parentId: null,
            createdAt: new Date("2026-01-01T10:00:00Z"),
            updatedAt: new Date("2026-01-01T10:00:00Z"),
          });

          await setDoc(doc(db, `documents/${cascadeDoc1Id}/content`, "main"), {
            content: sampleDocContent,
            updatedAt: new Date("2026-01-01T10:00:00Z"),
          });

          // Document 2 without images
          await setDoc(doc(db, "documents", cascadeDoc2Id), {
            title: "Document without Image",
            spaceId: cascadeSpaceId,
            parentId: null,
            createdAt: new Date("2026-01-01T10:05:00Z"),
            updatedAt: new Date("2026-01-01T10:05:00Z"),
          });

          await setDoc(doc(db, `documents/${cascadeDoc2Id}/content`, "main"), {
            content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Plain text doc" }] }] },
            updatedAt: new Date("2026-01-01T10:05:00Z"),
          });
        });
      });

      test("non-owner cannot read, update, create, or delete documents or content in deleted space", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();

        // 1. Non-owner cannot enumerate documents in deleted space
        const docQuery = query(
          collection(bob, "documents"),
          where("spaceId", "==", cascadeSpaceId)
        );
        await assertFails(getDocs(docQuery));

        // 2. Non-owner cannot read specific document record
        await assertFails(getDoc(doc(bob, "documents", cascadeDoc1Id)));

        // 3. Non-owner cannot read document content subcollection
        await assertFails(getDoc(doc(bob, `documents/${cascadeDoc1Id}/content`, "main")));

        // 4. Non-owner cannot create new document in deleted space
        await assertFails(
          setDoc(doc(bob, "documents", "unauthorized-doc"), {
            title: "Unauthorized",
            spaceId: cascadeSpaceId,
            parentId: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        // 5. Non-owner cannot update existing document in deleted space
        await assertFails(
          updateDoc(doc(bob, "documents", cascadeDoc1Id), {
            title: "Tampered Title",
            updatedAt: serverTimestamp(),
          })
        );

        // 6. Non-owner cannot write content to existing document in deleted space
        await assertFails(
          setDoc(doc(bob, `documents/${cascadeDoc1Id}/content`, "main"), {
            content: { type: "doc" },
            updatedAt: serverTimestamp(),
          })
        );

        // 7. Non-owner cannot delete content or document in deleted space
        await assertFails(deleteDoc(doc(bob, `documents/${cascadeDoc1Id}/content`, "main")));
        await assertFails(deleteDoc(doc(bob, "documents", cascadeDoc1Id)));
        await assertFails(deleteDoc(doc(bob, "spaces", cascadeSpaceId)));
      });

      test("owner cannot create or update documents while space is soft-deleted", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();

        // Create new doc prohibited
        await assertFails(
          setDoc(doc(alice, "documents", "alice-new-doc"), {
            title: "Alice New Doc",
            spaceId: cascadeSpaceId,
            parentId: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        // Update existing doc prohibited
        await assertFails(
          updateDoc(doc(alice, "documents", cascadeDoc1Id), {
            title: "Alice New Title",
            updatedAt: serverTimestamp(),
          })
        );

        // Create/update content prohibited
        await assertFails(
          setDoc(doc(alice, `documents/${cascadeDoc1Id}/content`, "main"), {
            content: { type: "doc" },
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("owner executes complete permanent-deletion cascade: enumerate, extract images, delete content, delete doc, delete space", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();

        // Step 1: Enumerate documents via query
        const docQuery = query(
          collection(alice, "documents"),
          where("spaceId", "==", cascadeSpaceId)
        );
        const docsSnap = await assertSucceeds(getDocs(docQuery));
        assert.equal(docsSnap.docs.length, 2);

        const discoveredImages: string[] = [];

        // Step 2: For each document, read content to extract images and delete content subcollection + doc
        for (const docItem of docsSnap.docs) {
          const docId = docItem.id;
          const contentRef = doc(alice, `documents/${docId}/content`, "main");

          // Owner can read content subcollection during cleanup
          const contentSnap = await assertSucceeds(getDoc(contentRef));
          if (contentSnap.exists()) {
            const content = contentSnap.data()?.content;
            const images = extractImageUrls(content);
            discoveredImages.push(...images);

            // Owner can delete content subcollection record
            await assertSucceeds(deleteDoc(contentRef));
          }

          // Owner can delete the document record
          await assertSucceeds(deleteDoc(doc(alice, "documents", docId)));
        }

        // Verify that image reference was discovered from content subcollection
        assert.equal(discoveredImages.length, 1);
        assert.equal(discoveredImages[0], "https://my-bucket.s3.us-east-1.amazonaws.com/uploads/diagram.png");

        // Step 3: Direct-client Space deletion is closed in rules (must use server action)
        await assertFails(deleteDoc(doc(alice, "spaces", cascadeSpaceId)));

        // Step 4: Verify complete erasure of document records while space record remains for server action
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          assert.equal((await getDoc(doc(db, "spaces", cascadeSpaceId))).exists(), true);
          assert.equal((await getDoc(doc(db, "documents", cascadeDoc1Id))).exists(), false);
          assert.equal((await getDoc(doc(db, `documents/${cascadeDoc1Id}/content`, "main"))).exists(), false);
          assert.equal((await getDoc(doc(db, "documents", cascadeDoc2Id))).exists(), false);
          assert.equal((await getDoc(doc(db, `documents/${cascadeDoc2Id}/content`, "main"))).exists(), false);
        });
      });

      test("cleanup predicate gives no additional authority while space is active; operations follow active member policy", async () => {
        const activeSpaceId = "space-active-policy-test";
        const activeDocId = "doc-active-policy-test";

        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          // Active space with Alice as owner and Bob as member
          await setDoc(doc(db, "spaces", activeSpaceId), {
            name: "Active Policy Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: new Date("2026-01-01T10:00:00Z"),
            updatedAt: new Date("2026-01-01T10:00:00Z"),
            deletedAt: null,
            deletedBy: null,
          });

          await setDoc(doc(db, "documents", activeDocId), {
            title: "Active Document",
            spaceId: activeSpaceId,
            parentId: null,
            createdAt: new Date("2026-01-01T10:00:00Z"),
            updatedAt: new Date("2026-01-01T10:00:00Z"),
          });

          await setDoc(doc(db, `documents/${activeDocId}/content`, "main"), {
            content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Active content" }] }] },
            updatedAt: new Date("2026-01-01T10:00:00Z"),
          });
        });

        const alice = testEnv.authenticatedContext("alice").firestore();
        const bob = testEnv.authenticatedContext("bob").firestore();
        const charlie = testEnv.authenticatedContext("charlie").firestore();

        // 1. In active space, non-member Charlie CANNOT read or delete documents or content
        // (Proves canCleanupDocument does not grant access to outsiders)
        await assertFails(getDoc(doc(charlie, "documents", activeDocId)));
        await assertFails(getDoc(doc(charlie, `documents/${activeDocId}/content`, "main")));
        await assertFails(deleteDoc(doc(charlie, `documents/${activeDocId}/content`, "main")));
        await assertFails(deleteDoc(doc(charlie, "documents", activeDocId)));

        // 2. Active members (Bob) and owner (Alice) follow normal active contributor policy
        await assertSucceeds(getDoc(doc(bob, "documents", activeDocId)));
        await assertSucceeds(getDoc(doc(bob, `documents/${activeDocId}/content`, "main")));
        await assertSucceeds(
          updateDoc(doc(bob, "documents", activeDocId), {
            title: "Updated by Bob",
            updatedAt: serverTimestamp(),
          })
        );
        await assertSucceeds(getDoc(doc(alice, "documents", activeDocId)));
        await assertSucceeds(getDoc(doc(alice, `documents/${activeDocId}/content`, "main")));

        // 3. Owner CANNOT permanently delete active space directly
        await assertFails(deleteDoc(doc(alice, "spaces", activeSpaceId)));

        // 4. Now soft-delete the space
        await assertSucceeds(
          updateDoc(doc(alice, "spaces", activeSpaceId), {
            deletedAt: serverTimestamp(),
            deletedBy: "alice",
            updatedAt: serverTimestamp(),
          })
        );

        // 5. Once soft-deleted:
        // - Bob (member) loses document read/delete access
        await assertFails(getDoc(doc(bob, "documents", activeDocId)));
        await assertFails(getDoc(doc(bob, `documents/${activeDocId}/content`, "main")));
        await assertFails(deleteDoc(doc(bob, "documents", activeDocId)));
        // - Bob and Alice cannot create or update documents
        await assertFails(
          updateDoc(doc(alice, "documents", activeDocId), {
            title: "Attempted Edit in Deleted Space",
            updatedAt: serverTimestamp(),
          })
        );
        await assertFails(
          setDoc(doc(alice, "documents", "new-doc-deleted-space"), {
            title: "New Doc in Deleted Space",
            spaceId: activeSpaceId,
            parentId: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
        // - Alice (owner) CAN read and delete document & content for permanent cleanup
        await assertSucceeds(getDoc(doc(alice, `documents/${activeDocId}/content`, "main")));
        await assertSucceeds(deleteDoc(doc(alice, `documents/${activeDocId}/content`, "main")));
        await assertSucceeds(deleteDoc(doc(alice, "documents", activeDocId)));
        // - Direct client space deletion is closed in rules (must use server action)
        await assertFails(deleteDoc(doc(alice, "spaces", activeSpaceId)));
      });
    });

    describe("Add Member Permissions (Owner & Ordinary Member)", () => {
      const spaceId = "space-add-member-test";

      beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await setDoc(doc(db, "spaces", spaceId), {
            name: "Add Member Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            deletedBy: null,
          });
        });
      });

      test("space owner can add a new member", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        await assertSucceeds(
          updateDoc(doc(alice, "spaces", spaceId), {
            userIds: ["alice", "bob", "charlie"],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("ordinary space member can add a new member", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertSucceeds(
          updateDoc(doc(bob, "spaces", spaceId), {
            userIds: ["alice", "bob", "charlie"],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("non-member cannot add a member to the space", async () => {
        const charlie = testEnv.authenticatedContext("charlie").firestore();
        await assertFails(
          updateDoc(doc(charlie, "spaces", spaceId), {
            userIds: ["alice", "bob", "david"],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("rejects adding an already existing member (duplicate UID prevention)", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        // Alice attempts to re-add bob
        await assertFails(
          updateDoc(doc(alice, "spaces", spaceId), {
            userIds: ["alice", "bob", "bob"],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("rejects adding multiple members in a single update", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        await assertFails(
          updateDoc(doc(alice, "spaces", spaceId), {
            userIds: ["alice", "bob", "charlie", "david"],
            updatedAt: serverTimestamp(),
          })
        );
      });
    });

    describe("Public Space Self-Joining & Rejoining After Removal", () => {
      const publicSpaceId = "public-join-test";
      const privateSpaceId = "private-join-test";

      beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await setDoc(doc(db, "spaces", publicSpaceId), {
            name: "Public Joinable Space",
            isPublic: true,
            ownerId: "alice",
            userIds: ["alice"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            deletedBy: null,
          });

          await setDoc(doc(db, "spaces", privateSpaceId), {
            name: "Private Joinable Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            deletedBy: null,
          });
        });
      });

      test("authenticated non-member can self-join a public space", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertSucceeds(
          updateDoc(doc(bob, "spaces", publicSpaceId), {
            userIds: ["alice", "bob"],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("non-member cannot self-join a private space", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          updateDoc(doc(bob, "spaces", privateSpaceId), {
            userIds: ["alice", "bob"],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("removed member can re-join a public space", async () => {
        // Seed space with Bob as member
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await updateDoc(doc(db, "spaces", publicSpaceId), {
            userIds: ["alice", "bob"],
          });
        });

        const alice = testEnv.authenticatedContext("alice").firestore();
        const bob = testEnv.authenticatedContext("bob").firestore();

        // Alice (owner) removes Bob from public space
        await assertSucceeds(
          updateDoc(doc(alice, "spaces", publicSpaceId), {
            userIds: ["alice"],
            updatedAt: serverTimestamp(),
          })
        );

        // Bob is now a non-member; Bob re-joins public space
        await assertSucceeds(
          updateDoc(doc(bob, "spaces", publicSpaceId), {
            userIds: ["alice", "bob"],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("public self-joining user cannot add anyone other than themselves", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        // Bob attempts to add charlie instead of himself
        await assertFails(
          updateDoc(doc(bob, "spaces", publicSpaceId), {
            userIds: ["alice", "charlie"],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("public self-joining user cannot alter space metadata during join", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          updateDoc(doc(bob, "spaces", publicSpaceId), {
            name: "Renamed by Bob during Join",
            userIds: ["alice", "bob"],
            updatedAt: serverTimestamp(),
          })
        );
      });
    });

    describe("Space Rename Permissions", () => {
      const publicSpaceId = "public-rename-test";
      const privateSpaceId = "private-rename-test";

      beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await setDoc(doc(db, "spaces", publicSpaceId), {
            name: "Public Space",
            isPublic: true,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            deletedBy: null,
          });

          await setDoc(doc(db, "spaces", privateSpaceId), {
            name: "Private Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            deletedBy: null,
          });
        });
      });

      test("space owner can rename the space", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        await assertSucceeds(
          updateDoc(doc(alice, "spaces", privateSpaceId), {
            name: "Alice Renamed",
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("ordinary member can rename the space", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertSucceeds(
          updateDoc(doc(bob, "spaces", privateSpaceId), {
            name: "Bob Renamed",
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("non-member cannot rename a public space", async () => {
        const charlie = testEnv.authenticatedContext("charlie").firestore();
        await assertFails(
          updateDoc(doc(charlie, "spaces", publicSpaceId), {
            name: "Charlie Renamed",
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("non-member cannot rename a private space", async () => {
        const charlie = testEnv.authenticatedContext("charlie").firestore();
        await assertFails(
          updateDoc(doc(charlie, "spaces", privateSpaceId), {
            name: "Charlie Renamed",
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("rejects empty name during rename", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        await assertFails(
          updateDoc(doc(alice, "spaces", privateSpaceId), {
            name: "",
            updatedAt: serverTimestamp(),
          })
        );
      });
    });

    describe("Access Revocation & Document Denial After Member Removal", () => {
      const spaceId = "revocation-space-test";
      const docId = "doc-revocation-1";

      beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await setDoc(doc(db, "spaces", spaceId), {
            name: "Revocation Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            deletedBy: null,
          });

          await setDoc(doc(db, "documents", docId), {
            title: "Confidential Doc",
            spaceId: spaceId,
            parentId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          await setDoc(doc(db, `documents/${docId}/content`, "main"), {
            content: "Confidential body",
            updatedAt: new Date(),
          });
        });
      });

      test("member can access document before removal, but is denied all read/write/delete after removal", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const bob = testEnv.authenticatedContext("bob").firestore();

        // 1. Bob has access before removal
        await assertSucceeds(getDoc(doc(bob, "documents", docId)));
        await assertSucceeds(getDoc(doc(bob, `documents/${docId}/content`, "main")));

        // 2. Alice removes Bob
        await assertSucceeds(
          updateDoc(doc(alice, "spaces", spaceId), {
            userIds: ["alice"],
            updatedAt: serverTimestamp(),
          })
        );

        // 3. Post-removal denials for Bob
        // Read doc denied
        await assertFails(getDoc(doc(bob, "documents", docId)));

        // Read content denied
        await assertFails(getDoc(doc(bob, `documents/${docId}/content`, "main")));

        // Update doc denied
        await assertFails(
          updateDoc(doc(bob, "documents", docId), {
            title: "Hacked Title",
            updatedAt: serverTimestamp(),
          })
        );

        // Write content denied
        await assertFails(
          setDoc(doc(bob, `documents/${docId}/content`, "main"), {
            content: "Vandalized body",
            updatedAt: serverTimestamp(),
          })
        );

        // Delete doc denied
        await assertFails(deleteDoc(doc(bob, "documents", docId)));
      });
    });

    describe("Cross-Space Relationship Manipulation Prevention", () => {
      const spaceAId = "space-cross-a";
      const spaceBId = "space-cross-b";
      const docAId = "doc-cross-a";

      beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          // Space A: Alice is owner, Bob is member
          await setDoc(doc(db, "spaces", spaceAId), {
            name: "Space A",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            deletedBy: null,
          });

          // Space B: Charlie is owner, private (neither Alice nor Bob is member)
          await setDoc(doc(db, "spaces", spaceBId), {
            name: "Space B",
            isPublic: false,
            ownerId: "charlie",
            userIds: ["charlie"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            deletedBy: null,
          });

          // Document in Space A
          await setDoc(doc(db, "documents", docAId), {
            title: "Doc in Space A",
            spaceId: spaceAId,
            parentId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        });
      });

      test("cannot create document with foreign spaceId where caller is not a contributor", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          setDoc(doc(bob, "documents", "foreign-doc"), {
            title: "Foreign Doc",
            spaceId: spaceBId,
            parentId: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("cannot update document to change its spaceId", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        // Bob attempts to move docAId from spaceA to spaceB
        await assertFails(
          updateDoc(doc(bob, "documents", docAId), {
            spaceId: spaceBId,
            updatedAt: serverTimestamp(),
          })
        );
      });
    });

    describe("Transactional Concurrency & Preservation of Existing Contributions", () => {
      const spaceId = "contrib-space-test";
      const bobDocId = "doc-bob-contrib";

      beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await setDoc(doc(db, "spaces", spaceId), {
            name: "Contribution Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            deletedBy: null,
          });
        });
      });

      test("preserves documents and content created by departing or removed member", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const alice = testEnv.authenticatedContext("alice").firestore();

        // 1. Bob creates a document and writes content via atomic batch
        const createBatch = writeBatch(bob);
        createBatch.set(doc(bob, "documents", bobDocId), {
          title: "Bob's Work",
          spaceId: spaceId,
          parentId: null,
          path: [],
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        createBatch.set(doc(bob, `documents/${bobDocId}/content`, "main"), {
          content: "Essential research notes written by Bob",
          updatedAt: serverTimestamp(),
        });
        await assertSucceeds(createBatch.commit());

        // 2. Alice removes Bob from the space
        await assertSucceeds(
          updateDoc(doc(alice, "spaces", spaceId), {
            userIds: ["alice"],
            updatedAt: serverTimestamp(),
          })
        );

        // 3. Document and content still exist and remain accessible to Alice (owner)
        await assertSucceeds(getDoc(doc(alice, "documents", bobDocId)));
        await assertSucceeds(getDoc(doc(alice, `documents/${bobDocId}/content`, "main")));

        // 4. Alice can continue editing Bob's document
        await assertSucceeds(
          updateDoc(doc(alice, "documents", bobDocId), {
            title: "Bob's Work (Maintained by Alice)",
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("concurrent transactions: simultaneous member addition by owner and departure by member", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const bob = testEnv.authenticatedContext("bob").firestore();
        const spaceRefAlice = doc(alice, "spaces", spaceId);
        const spaceRefBob = doc(bob, "spaces", spaceId);

        // Concurrently run Alice adding charlie and Bob leaving
        const results = await Promise.allSettled([
          runTransaction(alice, async (tx) => {
            const snap = await tx.get(spaceRefAlice);
            const userIds: string[] = snap.data()?.userIds || [];
            if (!userIds.includes("charlie")) {
              tx.update(spaceRefAlice, {
                userIds: [...userIds, "charlie"],
                updatedAt: serverTimestamp(),
              });
            }
          }),
          runTransaction(bob, async (tx) => {
            const snap = await tx.get(spaceRefBob);
            const userIds: string[] = snap.data()?.userIds || [];
            if (userIds.includes("bob")) {
              tx.update(spaceRefBob, {
                userIds: userIds.filter((id) => id !== "bob"),
                updatedAt: serverTimestamp(),
              });
            }
          }),
        ]);

        const fulfilled = results.filter((r) => r.status === "fulfilled");
        // At least one transaction commits successfully
        assert.ok(fulfilled.length >= 1, "At least one concurrent transaction should succeed");

        // The space document remains in a valid invariant state (owner present, no duplicates)
        const finalSnap = await getDoc(spaceRefAlice);
        const finalUsers = finalSnap.data()?.userIds || [];
        assert.ok(finalUsers.includes("alice"), "Owner must always remain in userIds");
        assert.equal(
          new Set(finalUsers).size,
          finalUsers.length,
          "No duplicate user IDs in final state"
        );
      });

      test("concurrent transactions: simultaneous member removal by owner and departure by member", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const bob = testEnv.authenticatedContext("bob").firestore();
        const spaceRefAlice = doc(alice, "spaces", spaceId);
        const spaceRefBob = doc(bob, "spaces", spaceId);

        // Both attempt to remove bob concurrently
        const alicePromise = runTransaction(alice, async (tx) => {
          const snap = await tx.get(spaceRefAlice);
          const userIds: string[] = snap.data()?.userIds || [];
          tx.update(spaceRefAlice, {
            userIds: userIds.filter((id) => id !== "bob"),
            updatedAt: serverTimestamp(),
          });
        });

        const bobPromise = runTransaction(bob, async (tx) => {
          const snap = await tx.get(spaceRefBob);
          const userIds: string[] = snap.data()?.userIds || [];
          tx.update(spaceRefBob, {
            userIds: userIds.filter((id) => id !== "bob"),
            updatedAt: serverTimestamp(),
          });
        });

        // One transaction succeeds, while the other encounters contention and retries.
        // Upon retry, bob is already gone, so removing bob again will fail security rules.
        const results = await Promise.allSettled([alicePromise, bobPromise]);
        const fulfilled = results.filter((r) => r.status === "fulfilled");

        // At least one must succeed
        assert.ok(fulfilled.length >= 1, "At least one removal transaction should succeed");

        // After completion, Bob must not be in the space
        const finalSnap = await getDoc(spaceRefAlice);
        const finalUsers = finalSnap.data()?.userIds || [];
        assert.deepEqual(finalUsers, ["alice"]);
      });

      test("repeated departure or removal fails rules once member is no longer present", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const bob = testEnv.authenticatedContext("bob").firestore();
        const spaceRefBob = doc(bob, "spaces", spaceId);
        const spaceRefAlice = doc(alice, "spaces", spaceId);

        // Bob leaves first
        await assertSucceeds(
          updateDoc(spaceRefBob, {
            userIds: ["alice"],
            updatedAt: serverTimestamp(),
          })
        );

        // Bob attempts to leave again (not a member)
        await assertFails(
          updateDoc(spaceRefBob, {
            userIds: ["alice"],
            updatedAt: serverTimestamp(),
          })
        );

        // Alice attempts to remove Bob again (Bob is already removed)
        await assertFails(
          updateDoc(spaceRefAlice, {
            userIds: ["alice"],
            updatedAt: serverTimestamp(),
          })
        );
      });
    });

    describe("Document Creation & Hierarchy Integrity Rules", () => {
      const spaceHierarchyId = "space-hierarchy-test";
      const spaceForeignId = "space-foreign-test";
      const spaceDeletedId = "space-deleted-hierarchy-test";
      const rootDocId = "doc-root-lvl1";
      const childDocId = "doc-child-lvl2";
      const grandchildDocId = "doc-grandchild-lvl3";
      const greatGrandchildDocId = "doc-greatgrandchild-lvl4";
      const softDeletedDocId = "doc-soft-deleted";
      const foreignDocId = "doc-foreign";

      beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();

          // Active space with alice as owner, bob as member, charlie as non-member
          await setDoc(doc(db, "spaces", spaceHierarchyId), {
            name: "Hierarchy Test Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            deletedBy: null,
          });

          // Foreign space owned by charlie
          await setDoc(doc(db, "spaces", spaceForeignId), {
            name: "Foreign Space",
            isPublic: false,
            ownerId: "charlie",
            userIds: ["charlie"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            deletedBy: null,
          });

          // Soft-deleted space owned by alice
          await setDoc(doc(db, "spaces", spaceDeletedId), {
            name: "Deleted Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: new Date(),
            deletedBy: "alice",
          });

          // Root doc in spaceHierarchyId (depth 1, path: [])
          await setDoc(doc(db, "documents", rootDocId), {
            spaceId: spaceHierarchyId,
            title: "Root Doc",
            parentId: null,
            path: [],
            deleted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          // Child doc in spaceHierarchyId (depth 2, path: [rootDocId])
          await setDoc(doc(db, "documents", childDocId), {
            spaceId: spaceHierarchyId,
            title: "Child Doc",
            parentId: rootDocId,
            path: [rootDocId],
            deleted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          // Grandchild doc in spaceHierarchyId (depth 3, path: [rootDocId, childDocId])
          await setDoc(doc(db, "documents", grandchildDocId), {
            spaceId: spaceHierarchyId,
            title: "Grandchild Doc",
            parentId: childDocId,
            path: [rootDocId, childDocId],
            deleted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          // Great-grandchild doc in spaceHierarchyId (depth 4, path: [rootDocId, childDocId, grandchildDocId])
          await setDoc(doc(db, "documents", greatGrandchildDocId), {
            spaceId: spaceHierarchyId,
            title: "Great Grandchild Doc",
            parentId: grandchildDocId,
            path: [rootDocId, childDocId, grandchildDocId],
            deleted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          // Soft-deleted doc in spaceHierarchyId
          await setDoc(doc(db, "documents", softDeletedDocId), {
            spaceId: spaceHierarchyId,
            title: "Soft Deleted Doc",
            parentId: rootDocId,
            path: [rootDocId],
            deleted: true,
            deletedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          // Foreign doc in spaceForeignId
          await setDoc(doc(db, "documents", foreignDocId), {
            spaceId: spaceForeignId,
            title: "Foreign Doc",
            parentId: null,
            path: [],
            deleted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        });
      });

      test("legitimate root document creation succeeds with parentId == null and path == []", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertSucceeds(
          setDoc(doc(bob, "documents", "doc-new-root"), {
            spaceId: spaceHierarchyId,
            title: "New Root Document",
            parentId: null,
            path: [],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("legitimate nested document creation succeeds across depths 2, 3, and 4", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();

        // Level 2 under root
        await assertSucceeds(
          setDoc(doc(bob, "documents", "doc-new-level-2"), {
            spaceId: spaceHierarchyId,
            title: "New Level 2",
            parentId: rootDocId,
            path: [rootDocId],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        // Level 3 under level 2
        await assertSucceeds(
          setDoc(doc(bob, "documents", "doc-new-level-3"), {
            spaceId: spaceHierarchyId,
            title: "New Level 3",
            parentId: childDocId,
            path: [rootDocId, childDocId],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        // Level 4 under level 3
        await assertSucceeds(
          setDoc(doc(bob, "documents", "doc-new-level-4"), {
            spaceId: spaceHierarchyId,
            title: "New Level 4",
            parentId: grandchildDocId,
            path: [rootDocId, childDocId, grandchildDocId],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("atomic batch write creating document and content simultaneously succeeds", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const batch = writeBatch(bob);
        const newDocId = "doc-atomic-created";
        const docRef = doc(bob, "documents", newDocId);
        const contentRef = doc(bob, `documents/${newDocId}/content`, "main");

        batch.set(docRef, {
          spaceId: spaceHierarchyId,
          title: "Atomic Doc",
          parentId: null,
          path: [],
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        batch.set(contentRef, {
          content: { type: "doc", content: [] },
          updatedAt: serverTimestamp(),
        });

        await assertSucceeds(batch.commit());
      });

      test("rules-denied batch write persists neither metadata nor content in emulator", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const batch = writeBatch(bob);
        const deniedDocId = "doc-atomic-denied";
        const docRef = doc(bob, "documents", deniedDocId);
        const contentRef = doc(bob, `documents/${deniedDocId}/content`, "main");

        // Staged write 1: Document metadata violates rules with forged hierarchy path
        batch.set(docRef, {
          spaceId: spaceHierarchyId,
          title: "Denied Batch Doc",
          parentId: rootDocId,
          path: ["forged-wrong-path"],
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        // Staged write 2: Valid content payload that would otherwise be allowed
        batch.set(contentRef, {
          content: { type: "doc", content: [{ type: "paragraph", text: "Valid content" }] },
          updatedAt: serverTimestamp(),
        });

        // Assert batch commit is denied
        await assertFails(batch.commit());

        // Assert neither metadata nor content exists in actual emulator storage
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          const metaSnap = await getDoc(doc(adminDb, "documents", deniedDocId));
          const contentSnap = await getDoc(doc(adminDb, `documents/${deniedDocId}/content`, "main"));

          assert.equal(metaSnap.exists(), false);
          assert.equal(contentSnap.exists(), false);
        });
      });

      test("direct client cannot create document with arbitrary short but incorrect path", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        // Child under rootDocId submitting empty path []
        await assertFails(
          setDoc(doc(bob, "documents", "doc-forged-empty-path"), {
            spaceId: spaceHierarchyId,
            title: "Forged Path",
            parentId: rootDocId,
            path: [],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
        // Child under rootDocId submitting wrong ancestor
        await assertFails(
          setDoc(doc(bob, "documents", "doc-forged-wrong-path"), {
            spaceId: spaceHierarchyId,
            title: "Forged Path 2",
            parentId: rootDocId,
            path: ["wrong-ancestor-id"],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client cannot create document with cross-Space parent reference", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        // Pointing to parent in foreign space
        await assertFails(
          setDoc(doc(bob, "documents", "doc-cross-space-parent"), {
            spaceId: spaceHierarchyId,
            title: "Cross Space Parent",
            parentId: foreignDocId,
            path: [foreignDocId],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client cannot create document with nonexistent parent reference", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          setDoc(doc(bob, "documents", "doc-nonexistent-parent"), {
            spaceId: spaceHierarchyId,
            title: "Nonexistent Parent",
            parentId: "doc-does-not-exist",
            path: ["doc-does-not-exist"],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client cannot create child under a soft-deleted parent", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          setDoc(doc(bob, "documents", "doc-under-deleted-parent"), {
            spaceId: spaceHierarchyId,
            title: "Under Deleted Parent",
            parentId: softDeletedDocId,
            path: [rootDocId, softDeletedDocId],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client cannot create a fifth-level document (path.size > 3)", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        // Child under depth 4 document (would be depth 5, path length 4)
        await assertFails(
          setDoc(doc(bob, "documents", "doc-level-5"), {
            spaceId: spaceHierarchyId,
            title: "Level 5 Forbidden",
            parentId: greatGrandchildDocId,
            path: [rootDocId, childDocId, grandchildDocId, greatGrandchildDocId],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client cannot create a self-parented document", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const selfDocId = "doc-self-parented";
        await assertFails(
          setDoc(doc(bob, "documents", selfDocId), {
            spaceId: spaceHierarchyId,
            title: "Self Parented",
            parentId: selfDocId,
            path: [selfDocId],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client cannot create document with non-list or missing path", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          setDoc(doc(bob, "documents", "doc-invalid-path-type"), {
            spaceId: spaceHierarchyId,
            title: "Invalid Path Type",
            parentId: null,
            path: "not-a-list",
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client cannot create root document with non-empty path", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          setDoc(doc(bob, "documents", "doc-root-non-empty-path"), {
            spaceId: spaceHierarchyId,
            title: "Root Non Empty Path",
            parentId: null,
            path: [rootDocId],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client cannot create document into a missing space", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          setDoc(doc(bob, "documents", "doc-in-missing-space"), {
            spaceId: "space-does-not-exist",
            title: "Missing Space Doc",
            parentId: null,
            path: [],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client cannot create document into a soft-deleted space", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          setDoc(doc(bob, "documents", "doc-in-deleted-space"), {
            spaceId: spaceDeletedId,
            title: "Deleted Space Doc",
            parentId: null,
            path: [],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("unauthorized non-contributor cannot create document", async () => {
        const charlie = testEnv.authenticatedContext("charlie").firestore();
        await assertFails(
          setDoc(doc(charlie, "documents", "doc-unauth-create"), {
            spaceId: spaceHierarchyId,
            title: "Unauthorized Create",
            parentId: null,
            path: [],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });
    });

    describe("Permanent Document Deletion & Hard-Delete Protection Rules", () => {
      const activeSpaceId = "space-perm-del-active";
      const deletedSpaceId = "space-perm-del-deleted";
      const activeDocId = "doc-perm-active";
      const softDeletedDocId = "doc-perm-soft";
      const docInDeletedSpaceId = "doc-in-deleted-space-perm";

      beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          // Active space with Alice (owner) and Bob (member)
          await setDoc(doc(db, "spaces", activeSpaceId), {
            name: "Active Space",
            ownerId: "alice",
            userIds: ["alice", "bob"],
            isPublic: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            deletedAt: null,
            deletedBy: null,
          });

          // Soft-deleted space with Alice (owner) and Bob (member)
          await setDoc(doc(db, "spaces", deletedSpaceId), {
            name: "Deleted Space",
            ownerId: "alice",
            userIds: ["alice", "bob"],
            isPublic: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            deletedAt: serverTimestamp(),
            deletedBy: "alice",
          });

          // Active document and content in active space
          await setDoc(doc(db, "documents", activeDocId), {
            spaceId: activeSpaceId,
            title: "Active Document",
            parentId: null,
            path: [],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, `documents/${activeDocId}/content`, "main"), {
            content: "Active document content",
            updatedAt: serverTimestamp(),
          });

          // Soft-deleted document and content in active space
          await setDoc(doc(db, "documents", softDeletedDocId), {
            spaceId: activeSpaceId,
            title: "Soft Deleted Document",
            parentId: null,
            path: [],
            deleted: true,
            deletedAt: serverTimestamp(),
            deletedBy: "bob",
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, `documents/${softDeletedDocId}/content`, "main"), {
            content: "Soft deleted document content",
            updatedAt: serverTimestamp(),
          });

          // Document and content in deleted space
          await setDoc(doc(db, "documents", docInDeletedSpaceId), {
            spaceId: deletedSpaceId,
            title: "Doc in Deleted Space",
            parentId: null,
            path: [],
            deleted: true,
            deletedAt: serverTimestamp(),
            deletedBy: "alice",
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, `documents/${docInDeletedSpaceId}/content`, "main"), {
            content: "Content in deleted space",
            updatedAt: serverTimestamp(),
          });
        });
      });

      test("direct client cannot hard-delete an active document in active space", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const bob = testEnv.authenticatedContext("bob").firestore();

        await assertFails(deleteDoc(doc(bob, "documents", activeDocId)));
        await assertFails(deleteDoc(doc(alice, "documents", activeDocId)));
      });

      test("direct client cannot hard-delete active document content in active space", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const bob = testEnv.authenticatedContext("bob").firestore();

        await assertFails(deleteDoc(doc(bob, `documents/${activeDocId}/content`, "main")));
        await assertFails(deleteDoc(doc(alice, `documents/${activeDocId}/content`, "main")));
      });

      test("direct client cannot hard-delete a soft-deleted document from an active Space", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const bob = testEnv.authenticatedContext("bob").firestore();

        await assertFails(deleteDoc(doc(bob, "documents", softDeletedDocId)));
        await assertFails(deleteDoc(doc(alice, "documents", softDeletedDocId)));
      });

      test("direct client cannot hard-delete soft-deleted document content from an active Space", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const bob = testEnv.authenticatedContext("bob").firestore();

        await assertFails(deleteDoc(doc(bob, `documents/${softDeletedDocId}/content`, "main")));
        await assertFails(deleteDoc(doc(alice, `documents/${softDeletedDocId}/content`, "main")));
      });

      test("direct client cannot hard-delete document as an unauthorized user", async () => {
        const charlie = testEnv.authenticatedContext("charlie").firestore();

        await assertFails(deleteDoc(doc(charlie, "documents", activeDocId)));
        await assertFails(deleteDoc(doc(charlie, "documents", softDeletedDocId)));
      });

      test("direct client cannot hard-delete document as a removed member", async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await updateDoc(doc(db, "spaces", activeSpaceId), {
            userIds: ["alice"],
          });
        });

        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(deleteDoc(doc(bob, "documents", activeDocId)));
        await assertFails(deleteDoc(doc(bob, "documents", softDeletedDocId)));
      });

      test("direct client soft deletion via updateDoc is denied", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();

        await assertFails(
          updateDoc(doc(bob, "documents", activeDocId), {
            deleted: true,
            deletedAt: serverTimestamp(),
            deletedBy: "bob",
          })
        );
      });

      test("required owner-only deleted-Space cleanup of documents remains possible, but direct Space deletion is closed", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();

        await assertSucceeds(deleteDoc(doc(alice, `documents/${docInDeletedSpaceId}/content`, "main")));
        await assertSucceeds(deleteDoc(doc(alice, "documents", docInDeletedSpaceId)));
        await assertFails(deleteDoc(doc(alice, "spaces", deletedSpaceId)));
      });

      test("ordinary members cannot perform deleted-Space cleanup", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();

        await assertFails(deleteDoc(doc(bob, `documents/${docInDeletedSpaceId}/content`, "main")));
        await assertFails(deleteDoc(doc(bob, "documents", docInDeletedSpaceId)));
        await assertFails(deleteDoc(doc(bob, "spaces", deletedSpaceId)));
      });
    });

    describe("Permanent Deletion Claims & Concurrency Protection Rules", () => {
      const activeSpaceId = "space-claim-test";
      const activeDocId = "doc-claim-active";
      const softDeletedDocId = "doc-claim-soft-deleted";
      const claimedDocId = "doc-claim-claimed";
      const activeParent1Id = "doc-claim-parent-1";
      const activeParent2Id = "doc-claim-parent-2";
      const childDocId = "doc-claim-child";

      beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          // Active space with Alice (owner) and Bob (member)
          await setDoc(doc(db, "spaces", activeSpaceId), {
            name: "Claim Test Space",
            ownerId: "alice",
            userIds: ["alice", "bob"],
            isPublic: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            deletedAt: null,
            deletedBy: null,
          });

          // Unclaimed active document
          await setDoc(doc(db, "documents", activeDocId), {
            spaceId: activeSpaceId,
            title: "Active Doc",
            parentId: null,
            path: [],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            permanentDeletionClaim: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, `documents/${activeDocId}/content`, "main"), {
            content: "Active content",
            updatedAt: serverTimestamp(),
          });

          // Unclaimed soft-deleted document
          await setDoc(doc(db, "documents", softDeletedDocId), {
            spaceId: activeSpaceId,
            title: "Soft Deleted Doc",
            parentId: null,
            path: [],
            deleted: true,
            deletedAt: serverTimestamp(),
            deletedBy: "bob",
            permanentDeletionClaim: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, `documents/${softDeletedDocId}/content`, "main"), {
            content: "Soft deleted content",
            updatedAt: serverTimestamp(),
          });

          // Claimed soft-deleted document
          await setDoc(doc(db, "documents", claimedDocId), {
            spaceId: activeSpaceId,
            title: "Claimed Doc",
            parentId: null,
            path: [],
            deleted: true,
            deletedAt: serverTimestamp(),
            deletedBy: "bob",
            permanentDeletionClaim: {
              claimedAt: serverTimestamp(),
              claimedBy: "alice",
            },
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, `documents/${claimedDocId}/content`, "main"), {
            content: "Claimed content",
            updatedAt: serverTimestamp(),
          });

          // Active parents for move testing
          await setDoc(doc(db, "documents", activeParent1Id), {
            spaceId: activeSpaceId,
            title: "Active Parent 1",
            parentId: null,
            path: [],
            deleted: false,
            deletedAt: null,
            permanentDeletionClaim: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, "documents", activeParent2Id), {
            spaceId: activeSpaceId,
            title: "Active Parent 2",
            parentId: null,
            path: [],
            deleted: false,
            deletedAt: null,
            permanentDeletionClaim: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          // Child doc under Parent 1
          await setDoc(doc(db, "documents", childDocId), {
            spaceId: activeSpaceId,
            title: "Child Doc",
            parentId: activeParent1Id,
            path: [activeParent1Id],
            deleted: false,
            deletedAt: null,
            permanentDeletionClaim: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        });
      });

      test("direct client restore via updateDoc is denied", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          updateDoc(doc(bob, "documents", softDeletedDocId), {
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("restore is rejected after a permanent-deletion claim", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          updateDoc(doc(bob, "documents", claimedDocId), {
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("a direct client cannot forge a permanent-deletion claim on update", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          updateDoc(doc(bob, "documents", activeDocId), {
            permanentDeletionClaim: {
              claimedAt: serverTimestamp(),
              claimedBy: "bob",
            },
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("a direct client cannot create a document with a permanent-deletion claim", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          setDoc(doc(bob, "documents", "forged-claim-doc"), {
            spaceId: activeSpaceId,
            title: "Forged Claim",
            parentId: null,
            path: [],
            permanentDeletionClaim: {
              claimedAt: serverTimestamp(),
              claimedBy: "bob",
            },
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("a direct client cannot remove a permanent-deletion claim", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          updateDoc(doc(bob, "documents", claimedDocId), {
            permanentDeletionClaim: null,
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("a normal user cannot edit a claimed document metadata or content", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          updateDoc(doc(bob, "documents", claimedDocId), {
            title: "Hacked Title",
            updatedAt: serverTimestamp(),
          })
        );
        await assertFails(
          setDoc(doc(bob, `documents/${claimedDocId}/content`, "main"), {
            content: "Hacked content",
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("moving beneath a soft-deleted parent is rejected", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          updateDoc(doc(bob, "documents", childDocId), {
            parentId: softDeletedDocId,
            path: [softDeletedDocId],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("moving beneath a claimed parent is rejected", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          updateDoc(doc(bob, "documents", childDocId), {
            parentId: claimedDocId,
            path: [claimedDocId],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("forging a path containing the claimed document ID is rejected", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        // Attempt to forge path containing claimedDocId with null parent
        await assertFails(
          updateDoc(doc(bob, "documents", childDocId), {
            parentId: null,
            path: [claimedDocId],
            updatedAt: serverTimestamp(),
          })
        );

        // Attempt to forge path containing claimedDocId under active parent
        await assertFails(
          updateDoc(doc(bob, "documents", childDocId), {
            parentId: activeParent2Id,
            path: [claimedDocId, activeParent2Id],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client modification of hierarchy fields (parentId, path) is denied", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          updateDoc(doc(bob, "documents", childDocId), {
            parentId: activeParent2Id,
            path: [activeParent2Id],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client modification of parentId alone is denied", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          updateDoc(doc(bob, "documents", childDocId), {
            parentId: activeParent2Id,
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client modification of path alone is denied", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          updateDoc(doc(bob, "documents", childDocId), {
            path: [activeParent2Id],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client ordinary non-hierarchy document update succeeds when authorized", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertSucceeds(
          updateDoc(doc(bob, "documents", childDocId), {
            title: "Updated Child Title",
            updatedAt: serverTimestamp(),
          })
        );
      });
    });

    describe("Document Lifecycle Claims & Subtree Concurrency Rules", () => {
      const activeSpaceId = "space-lifecycle-test";
      const rootDocId = "doc-lc-root";
      const otherParentId = "doc-lc-other-parent";
      const unclaimedChildId = "doc-lc-unclaimed-child";
      const claimedParentId = "doc-lc-claimed-parent";
      const childOfClaimedId = "doc-lc-child-claimed";
      const grandchildOfClaimedId = "doc-lc-grandchild-claimed";
      const groupRootDocId = "doc-lc-group-root";
      const groupMemberDocId = "doc-lc-group-member";

      beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          // Active space with Alice (owner) and Bob (contributor)
          await setDoc(doc(db, "spaces", activeSpaceId), {
            name: "Lifecycle Rules Space",
            ownerId: "alice",
            userIds: ["alice", "bob"],
            isPublic: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            deletedAt: null,
            deletedBy: null,
          });

          // Unclaimed active root doc
          await setDoc(doc(db, "documents", rootDocId), {
            spaceId: activeSpaceId,
            title: "Root Doc",
            parentId: null,
            path: [],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            lifecycleClaim: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, `documents/${rootDocId}/content`, "main"), {
            content: "Root doc content",
            updatedAt: serverTimestamp(),
          });

          // Other active parent
          await setDoc(doc(db, "documents", otherParentId), {
            spaceId: activeSpaceId,
            title: "Other Parent",
            parentId: null,
            path: [],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            lifecycleClaim: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          // Unclaimed child under otherParent
          await setDoc(doc(db, "documents", unclaimedChildId), {
            spaceId: activeSpaceId,
            title: "Unclaimed Child",
            parentId: otherParentId,
            path: [otherParentId],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            lifecycleClaim: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          // Claimed parent document (active doc with lifecycle claim)
          await setDoc(doc(db, "documents", claimedParentId), {
            spaceId: activeSpaceId,
            title: "Claimed Parent Doc",
            parentId: null,
            path: [],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            lifecycleClaim: {
              claimedAt: serverTimestamp(),
              claimedBy: "alice",
              operation: "soft-delete",
              strategy: "delete-subtree",
              opId: "op-test-1",
            },
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          // Child of claimed parent
          await setDoc(doc(db, "documents", childOfClaimedId), {
            spaceId: activeSpaceId,
            title: "Child of Claimed",
            parentId: claimedParentId,
            path: [claimedParentId],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            lifecycleClaim: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, `documents/${childOfClaimedId}/content`, "main"), {
            content: "Child of claimed content",
            updatedAt: serverTimestamp(),
          });

          // Grandchild of claimed parent
          await setDoc(doc(db, "documents", grandchildOfClaimedId), {
            spaceId: activeSpaceId,
            title: "Grandchild of Claimed",
            parentId: childOfClaimedId,
            path: [claimedParentId, childOfClaimedId],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            lifecycleClaim: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, `documents/${grandchildOfClaimedId}/content`, "main"), {
            content: "Grandchild content",
            updatedAt: serverTimestamp(),
          });

          // Deletion group root and member
          await setDoc(doc(db, "documents", groupRootDocId), {
            spaceId: activeSpaceId,
            title: "Group Root",
            parentId: null,
            path: [],
            deleted: true,
            deletedAt: serverTimestamp(),
            deletedBy: "alice",
            deletionGroupId: "group-123",
            deletionGroupRootId: groupRootDocId,
            deletionGroupCount: 2,
            lifecycleClaim: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, "documents", groupMemberDocId), {
            spaceId: activeSpaceId,
            title: "Group Member",
            parentId: groupRootDocId,
            path: [groupRootDocId],
            deleted: true,
            deletedAt: serverTimestamp(),
            deletedBy: "alice",
            deletionGroupId: "group-123",
            deletionGroupRootId: groupRootDocId,
            deletionGroupCount: 2,
            lifecycleClaim: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        });
      });

      test("direct client cannot create a document with a lifecycle claim", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          setDoc(doc(bob, "documents", "new-forged-claim"), {
            spaceId: activeSpaceId,
            title: "Forged LC",
            parentId: null,
            path: [],
            lifecycleClaim: {
              claimedAt: serverTimestamp(),
              claimedBy: "bob",
              operation: "soft-delete",
              opId: "forged-op",
            },
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client cannot forge a lifecycle claim on an existing document", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          updateDoc(doc(bob, "documents", rootDocId), {
            lifecycleClaim: {
              claimedAt: serverTimestamp(),
              claimedBy: "bob",
              operation: "soft-delete",
              opId: "forged-op",
            },
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client cannot clear or remove a lifecycle claim", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          updateDoc(doc(bob, "documents", claimedParentId), {
            lifecycleClaim: null,
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client cannot modify lifecycleClaim.strategy on an active claim", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        await assertFails(
          updateDoc(doc(bob, "documents", claimedParentId), {
            "lifecycleClaim.strategy": "move-descendants",
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client cannot forge deletion-group metadata on create or update", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        // Create with deletionGroupId
        await assertFails(
          setDoc(doc(bob, "documents", "new-forged-group"), {
            spaceId: activeSpaceId,
            title: "Forged Group",
            parentId: null,
            path: [],
            deletionGroupId: "fake-group",
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
        // Update with deletionGroupId
        await assertFails(
          updateDoc(doc(bob, "documents", rootDocId), {
            deletionGroupId: "fake-group",
            updatedAt: serverTimestamp(),
          })
        );
        // Update with deletionGroupRootId
        await assertFails(
          updateDoc(doc(bob, "documents", rootDocId), {
            deletionGroupRootId: rootDocId,
            updatedAt: serverTimestamp(),
          })
        );
        // Update with deletionGroupCount
        await assertFails(
          updateDoc(doc(bob, "documents", rootDocId), {
            deletionGroupCount: 5,
            updatedAt: serverTimestamp(),
          })
        );
        // Create with restoreParentId
        await assertFails(
          setDoc(doc(bob, "documents", "new-forged-restore-parent"), {
            spaceId: activeSpaceId,
            title: "Forged Restore Parent",
            parentId: null,
            path: [],
            restoreParentId: "some-parent",
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
        // Update with restoreParentId
        await assertFails(
          updateDoc(doc(bob, "documents", rootDocId), {
            restoreParentId: "some-parent",
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("restoreParentId strict absence invariant: direct client cannot create or manipulate restoreParentId", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();

        const docSeedWithRestore = "doc-seed-with-restore-parent";
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          await setDoc(doc(adminDb, "documents", docSeedWithRestore), {
            spaceId: activeSpaceId,
            title: "Doc With Restore Parent",
            parentId: null,
            path: [],
            deleted: true,
            deletedAt: serverTimestamp(),
            deletedBy: "alice",
            restoreParentId: "initial-parent-id",
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        });

        // 1. Normal active document creation with no restoreParentId succeeds.
        const validDocId = "doc-valid-active-no-restore-parent";
        await assertSucceeds(
          setDoc(doc(bob, "documents", validDocId), {
            spaceId: activeSpaceId,
            title: "Valid Active Doc",
            parentId: null,
            path: [],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        // 2. Active document creation with restoreParentId: null is denied.
        const docNullId = "doc-denied-null-restore-parent";
        await assertFails(
          setDoc(doc(bob, "documents", docNullId), {
            spaceId: activeSpaceId,
            title: "Denied Null Restore Parent",
            parentId: null,
            path: [],
            restoreParentId: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        // 3. Active document creation with restoreParentId: "parent-id" is denied.
        const docStringId = "doc-denied-string-restore-parent";
        await assertFails(
          setDoc(doc(bob, "documents", docStringId), {
            spaceId: activeSpaceId,
            title: "Denied String Restore Parent",
            parentId: null,
            path: [],
            restoreParentId: "parent-id",
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        // 4. Active document creation with an empty-string value is denied.
        const docEmptyId = "doc-denied-empty-restore-parent";
        await assertFails(
          setDoc(doc(bob, "documents", docEmptyId), {
            spaceId: activeSpaceId,
            title: "Denied Empty Restore Parent",
            parentId: null,
            path: [],
            restoreParentId: "",
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        // 5. Direct-client update adding the field is denied.
        await assertFails(
          updateDoc(doc(bob, "documents", validDocId), {
            restoreParentId: "added-parent-id",
            updatedAt: serverTimestamp(),
          })
        );
        await assertFails(
          updateDoc(doc(bob, "documents", validDocId), {
            restoreParentId: null,
            updatedAt: serverTimestamp(),
          })
        );

        // 6. Direct-client update changing the field is denied.
        await assertFails(
          updateDoc(doc(bob, "documents", docSeedWithRestore), {
            restoreParentId: "changed-parent-id",
            updatedAt: serverTimestamp(),
          })
        );

        // 7. Direct-client update removing the field is denied.
        await assertFails(
          updateDoc(doc(bob, "documents", docSeedWithRestore), {
            restoreParentId: deleteField(),
            updatedAt: serverTimestamp(),
          })
        );
        await assertFails(
          updateDoc(doc(bob, "documents", docSeedWithRestore), {
            restoreParentId: null,
            updatedAt: serverTimestamp(),
          })
        );

        // 8. Every denied batch persists no writes when checked with Rules-disabled reads.
        const batchDeniedDocId = "doc-batch-denied-write";
        const batchOtherDocId = "doc-batch-other-write";
        const batch = writeBatch(bob);
        batch.set(doc(bob, "documents", batchOtherDocId), {
          spaceId: activeSpaceId,
          title: "Batch Other Doc",
          parentId: null,
          path: [],
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        batch.set(doc(bob, "documents", batchDeniedDocId), {
          spaceId: activeSpaceId,
          title: "Batch Denied Doc",
          parentId: null,
          path: [],
          restoreParentId: null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        await assertFails(batch.commit());

        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();

          // 1: Valid doc exists and has no restoreParentId
          const validSnap = await getDoc(doc(adminDb, "documents", validDocId));
          assert.equal(validSnap.exists(), true);
          assert.equal("restoreParentId" in (validSnap.data() || {}), false);

          // 2, 3, 4: Denied creates do not exist
          const nullSnap = await getDoc(doc(adminDb, "documents", docNullId));
          assert.equal(nullSnap.exists(), false);

          const stringSnap = await getDoc(doc(adminDb, "documents", docStringId));
          assert.equal(stringSnap.exists(), false);

          const emptySnap = await getDoc(doc(adminDb, "documents", docEmptyId));
          assert.equal(emptySnap.exists(), false);

          // 5, 6, 7: Seeded doc retained its original restoreParentId without change or deletion
          const seedSnap = await getDoc(doc(adminDb, "documents", docSeedWithRestore));
          assert.equal(seedSnap.exists(), true);
          assert.equal(seedSnap.data()?.restoreParentId, "initial-parent-id");

          // 8: Denied batch did not write anything
          const batchDeniedSnap = await getDoc(doc(adminDb, "documents", batchDeniedDocId));
          assert.equal(batchDeniedSnap.exists(), false);

          const batchOtherSnap = await getDoc(doc(adminDb, "documents", batchOtherDocId));
          assert.equal(batchOtherSnap.exists(), false);
        });
      });

      test("direct client cannot partially soft-delete or partially restore a deletion group", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        // Attempt to directly restore group member individually
        await assertFails(
          updateDoc(doc(bob, "documents", groupMemberDocId), {
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            updatedAt: serverTimestamp(),
          })
        );
        // Attempt to directly restore group root individually
        await assertFails(
          updateDoc(doc(bob, "documents", groupRootDocId), {
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            updatedAt: serverTimestamp(),
          })
        );
        // Attempt to directly soft-delete an active document
        await assertFails(
          updateDoc(doc(bob, "documents", rootDocId), {
            deleted: true,
            deletedAt: serverTimestamp(),
            deletedBy: "bob",
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client cannot edit metadata or content of a document with a claimed ancestor", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        // Metadata update on direct child of claimed doc
        await assertFails(
          updateDoc(doc(bob, "documents", childOfClaimedId), {
            title: "Modified Child",
            updatedAt: serverTimestamp(),
          })
        );
        // Content update on direct child of claimed doc
        await assertFails(
          setDoc(doc(bob, `documents/${childOfClaimedId}/content`, "main"), {
            content: "Modified Child Content",
            updatedAt: serverTimestamp(),
          })
        );
        // Metadata update on grandchild of claimed doc
        await assertFails(
          updateDoc(doc(bob, "documents", grandchildOfClaimedId), {
            title: "Modified Grandchild",
            updatedAt: serverTimestamp(),
          })
        );
        // Content update on grandchild of claimed doc
        await assertFails(
          setDoc(doc(bob, `documents/${grandchildOfClaimedId}/content`, "main"), {
            content: "Modified Grandchild Content",
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client cannot move documents into a claimed subtree", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        // Move under claimed parent
        await assertFails(
          updateDoc(doc(bob, "documents", unclaimedChildId), {
            parentId: claimedParentId,
            path: [claimedParentId],
            updatedAt: serverTimestamp(),
          })
        );
        // Move under child of claimed parent
        await assertFails(
          updateDoc(doc(bob, "documents", unclaimedChildId), {
            parentId: childOfClaimedId,
            path: [claimedParentId, childOfClaimedId],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client cannot move documents out of a claimed subtree", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        // Move child of claimed parent to root
        await assertFails(
          updateDoc(doc(bob, "documents", childOfClaimedId), {
            parentId: null,
            path: [],
            updatedAt: serverTimestamp(),
          })
        );
        // Move child of claimed parent to other parent
        await assertFails(
          updateDoc(doc(bob, "documents", childOfClaimedId), {
            parentId: otherParentId,
            path: [otherParentId],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client cannot create a document beneath a claimed document or claimed ancestor", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        // Create under claimed parent
        await assertFails(
          setDoc(doc(bob, "documents", "new-child-under-claimed"), {
            spaceId: activeSpaceId,
            title: "New Child Under Claimed",
            parentId: claimedParentId,
            path: [claimedParentId],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
        // Create under child of claimed parent
        await assertFails(
          setDoc(doc(bob, "documents", "new-child-under-anc-claimed"), {
            spaceId: activeSpaceId,
            title: "New Child Under Ancestor Claimed",
            parentId: childOfClaimedId,
            path: [claimedParentId, childOfClaimedId],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("legitimate document creation, editing on unaffected documents succeed; direct client movement is denied and handled authoritatively", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        // Legitimate update to title on rootDocId
        await assertSucceeds(
          updateDoc(doc(bob, "documents", rootDocId), {
            title: "Legitimate Title Update",
            updatedAt: serverTimestamp(),
          })
        );
        // Direct client content update on existing rootDocId is denied (server-authoritative save required)
        await assertFails(
          setDoc(doc(bob, `documents/${rootDocId}/content`, "main"), {
            content: "Legitimate updated content",
            updatedAt: serverTimestamp(),
          })
        );
        // Legitimate creation of new document under rootDocId
        await assertSucceeds(
          setDoc(doc(bob, "documents", "legit-new-child"), {
            spaceId: activeSpaceId,
            title: "Legit New Child",
            parentId: rootDocId,
            path: [rootDocId],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
        // Direct client move modifying parentId and path is denied
        await assertFails(
          updateDoc(doc(bob, "documents", unclaimedChildId), {
            parentId: null,
            path: [],
            updatedAt: serverTimestamp(),
          })
        );
        // Authoritative move via Admin succeeds
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          await updateDoc(doc(adminDb, "documents", unclaimedChildId), {
            parentId: null,
            path: [],
            updatedAt: serverTimestamp(),
          });
          const snap = await getDoc(doc(adminDb, "documents", unclaimedChildId));
          assert.equal(snap.data()?.parentId, null);
          assert.deepEqual(snap.data()?.path, []);
        });
      });

      test("proves claim-before-query: document created before root claim acquisition succeeds and is included, while creation after acquisition is denied", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();

        // 1. Creation before claim acquisition succeeds
        await assertSucceeds(
          setDoc(doc(bob, "documents", "child-before-claim"), {
            spaceId: activeSpaceId,
            title: "Child Created Before Claim",
            parentId: rootDocId,
            path: [rootDocId],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        // 2. Admin commits lifecycle claim on rootDocId (simulating Step 2 claim acquisition before query)
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          await updateDoc(doc(adminDb, "documents", rootDocId), {
            lifecycleClaim: {
              claimedAt: serverTimestamp(),
              claimedBy: "alice",
              operation: "soft-delete",
              strategy: "delete-subtree",
              opId: "lifecycle-op-root",
            },
          });
        });

        // 3. Direct client creation under claimed root is denied by Firestore Rules
        await assertFails(
          setDoc(doc(bob, "documents", "child-after-claim"), {
            spaceId: activeSpaceId,
            title: "Child Created After Claim",
            parentId: rootDocId,
            path: [rootDocId],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        // 4. Direct client moving an existing document under claimed root is also denied
        await assertFails(
          updateDoc(doc(bob, "documents", unclaimedChildId), {
            parentId: rootDocId,
            path: [rootDocId],
            updatedAt: serverTimestamp(),
          })
        );
      });
    });

    describe("Subtree Move & Batch Hierarchy Integrity Rules", () => {
      const moveSpaceId = "space-move-test";
      const foreignSpaceId = "space-move-foreign";
      const docAId = "doc-A";
      const docBId = "doc-B";
      const docCId = "doc-C";
      const docKuikkeliId = "doc-kuikkeli";
      const docForeignId = "doc-foreign-dest";
      const docSoftDeletedId = "doc-soft-deleted-dest";
      const docLifecycleClaimedId = "doc-lifecycle-claimed-dest";
      const docPermanentClaimedId = "doc-permanent-claimed-dest";
      const docDepth2Id = "doc-depth-2-dest";

      beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          // Active space with Alice (owner) and Bob (member)
          await setDoc(doc(db, "spaces", moveSpaceId), {
            name: "Move Test Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            deletedAt: null,
            deletedBy: null,
          });

          // Foreign space owned by charlie
          await setDoc(doc(db, "spaces", foreignSpaceId), {
            name: "Foreign Move Space",
            isPublic: false,
            ownerId: "charlie",
            userIds: ["charlie"],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            deletedAt: null,
            deletedBy: null,
          });

          await setDoc(doc(db, "documents", docForeignId), {
            spaceId: foreignSpaceId,
            title: "Foreign Doc",
            parentId: null,
            path: [],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          // Space root -> A -> B -> C
          await setDoc(doc(db, "documents", docAId), {
            spaceId: moveSpaceId,
            title: "Doc A",
            parentId: null,
            path: [],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, `documents/${docAId}/content`, "main"), {
            content: "Content A",
            updatedAt: serverTimestamp(),
          });

          await setDoc(doc(db, "documents", docBId), {
            spaceId: moveSpaceId,
            title: "Doc B",
            parentId: docAId,
            path: [docAId],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, `documents/${docBId}/content`, "main"), {
            content: "Content B",
            updatedAt: serverTimestamp(),
          });

          await setDoc(doc(db, "documents", docCId), {
            spaceId: moveSpaceId,
            title: "Doc C",
            parentId: docBId,
            path: [docAId, docBId],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, `documents/${docCId}/content`, "main"), {
            content: "Content C",
            updatedAt: serverTimestamp(),
          });

          // kuikkeli at Space root (depth 1)
          await setDoc(doc(db, "documents", docKuikkeliId), {
            spaceId: moveSpaceId,
            title: "Kuikkeli",
            parentId: null,
            path: [],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, `documents/${docKuikkeliId}/content`, "main"), {
            content: "Content Kuikkeli",
            updatedAt: serverTimestamp(),
          });

          // Depth 2 document under kuikkeli: path: [docKuikkeliId]
          await setDoc(doc(db, "documents", docDepth2Id), {
            spaceId: moveSpaceId,
            title: "Depth 2 Dest",
            parentId: docKuikkeliId,
            path: [docKuikkeliId],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          // Soft-deleted destination
          await setDoc(doc(db, "documents", docSoftDeletedId), {
            spaceId: moveSpaceId,
            title: "Soft Deleted Dest",
            parentId: null,
            path: [],
            deleted: true,
            deletedAt: serverTimestamp(),
            deletedBy: "alice",
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          // Lifecycle claimed destination
          await setDoc(doc(db, "documents", docLifecycleClaimedId), {
            spaceId: moveSpaceId,
            title: "Lifecycle Claimed Dest",
            parentId: null,
            path: [],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            lifecycleClaim: {
              claimedAt: serverTimestamp(),
              claimedBy: "alice",
              operation: "soft-delete",
              strategy: "move-descendants",
              opId: "op-test-claim",
            },
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          // Permanent deletion claimed destination
          await setDoc(doc(db, "documents", docPermanentClaimedId), {
            spaceId: moveSpaceId,
            title: "Permanent Claimed Dest",
            parentId: null,
            path: [],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            permanentDeletionClaim: {
              claimedAt: serverTimestamp(),
              claimedBy: "alice",
              opId: "op-test-perm-claim",
            },
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        });
      });

      test("direct client batch movement of subtree is denied; authoritative Admin move succeeds and preserves state", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const batch = writeBatch(alice);

        // Direct client attempts batch movement of subtree A -> B -> C under kuikkeli
        batch.update(doc(alice, "documents", docAId), {
          parentId: docKuikkeliId,
          path: [docKuikkeliId],
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(alice, "documents", docBId), {
          path: [docKuikkeliId, docAId],
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(alice, "documents", docCId), {
          path: [docKuikkeliId, docAId, docBId],
          updatedAt: serverTimestamp(),
        });

        // Direct client batch movement modifying hierarchy fields (parentId, path) is denied by Security Rules
        await assertFails(batch.commit());

        // Authoritative move via Admin transaction succeeds and updates storage
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          await adminDb.runTransaction(async (tx) => {
            tx.update(doc(adminDb, "documents", docAId), {
              parentId: docKuikkeliId,
              path: [docKuikkeliId],
              updatedAt: serverTimestamp(),
            });
            tx.update(doc(adminDb, "documents", docBId), {
              path: [docKuikkeliId, docAId],
              updatedAt: serverTimestamp(),
            });
            tx.update(doc(adminDb, "documents", docCId), {
              path: [docKuikkeliId, docAId, docBId],
              updatedAt: serverTimestamp(),
            });
          });

          const snapA = await getDoc(doc(adminDb, "documents", docAId));
          const snapB = await getDoc(doc(adminDb, "documents", docBId));
          const snapC = await getDoc(doc(adminDb, "documents", docCId));
          const contentSnapA = await getDoc(doc(adminDb, `documents/${docAId}/content`, "main"));
          const contentSnapB = await getDoc(doc(adminDb, `documents/${docBId}/content`, "main"));
          const contentSnapC = await getDoc(doc(adminDb, `documents/${docCId}/content`, "main"));

          assert.equal(snapA.exists(), true);
          const dataA = snapA.data()!;
          assert.equal(dataA.parentId, docKuikkeliId);
          assert.deepEqual(dataA.path, [docKuikkeliId]);
          assert.equal(dataA.deleted, false);
          assert.equal(dataA.deletedAt, null);
          assert.equal(dataA.deletedBy, null);
          assert.equal(dataA.lifecycleClaim, undefined);
          assert.equal(dataA.permanentDeletionClaim, undefined);
          assert.equal(contentSnapA.data()?.content, "Content A");

          assert.equal(snapB.exists(), true);
          const dataB = snapB.data()!;
          assert.equal(dataB.parentId, docAId);
          assert.deepEqual(dataB.path, [docKuikkeliId, docAId]);
          assert.equal(dataB.deleted, false);
          assert.equal(dataB.deletedAt, null);
          assert.equal(dataB.deletedBy, null);
          assert.equal(dataB.lifecycleClaim, undefined);
          assert.equal(dataB.permanentDeletionClaim, undefined);
          assert.equal(contentSnapB.data()?.content, "Content B");

          assert.equal(snapC.exists(), true);
          const dataC = snapC.data()!;
          assert.equal(dataC.parentId, docBId);
          assert.deepEqual(dataC.path, [docKuikkeliId, docAId, docBId]);
          assert.equal(dataC.deleted, false);
          assert.equal(dataC.deletedAt, null);
          assert.equal(dataC.deletedBy, null);
          assert.equal(dataC.lifecycleClaim, undefined);
          assert.equal(dataC.permanentDeletionClaim, undefined);
          assert.equal(contentSnapC.data()?.content, "Content C");
        });
      });

      test("direct client leaf move via updateDoc is denied", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        // Direct client move of leaf docC under kuikkeli is denied
        await assertFails(
          updateDoc(doc(bob, "documents", docCId), {
            parentId: docKuikkeliId,
            path: [docKuikkeliId],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("direct client move to Space root via batch is denied", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const batch = writeBatch(bob);
        batch.update(doc(bob, "documents", docBId), {
          parentId: null,
          path: [],
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(bob, "documents", docCId), {
          path: [docBId],
          updatedAt: serverTimestamp(),
        });
        // Direct client cannot modify parentId or path
        await assertFails(batch.commit());
      });

      test("direct client move beneath a document via updateDoc is denied", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        await assertFails(
          updateDoc(doc(alice, "documents", docKuikkeliId), {
            parentId: docCId,
            path: [docAId, docBId, docCId],
            updatedAt: serverTimestamp(),
          })
        );
        // Verify document was not modified by the failed direct client update
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          const snap = await getDoc(doc(adminDb, "documents", docKuikkeliId));
          assert.equal(snap.data()?.parentId, null);
          assert.deepEqual(snap.data()?.path, []);
        });
      });

      test("cross-Space destination rejection: moving under foreign space document is denied and state unchanged", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const batch = writeBatch(alice);
        batch.update(doc(alice, "documents", docAId), {
          parentId: docForeignId,
          path: [docForeignId],
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(alice, "documents", docBId), {
          path: [docForeignId, docAId],
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(alice, "documents", docCId), {
          path: [docForeignId, docAId, docBId],
          updatedAt: serverTimestamp(),
        });

        await assertFails(batch.commit());

        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          const snapA = await getDoc(doc(adminDb, "documents", docAId));
          const snapB = await getDoc(doc(adminDb, "documents", docBId));
          assert.equal(snapA.data()?.parentId, null);
          assert.deepEqual(snapA.data()?.path, []);
          assert.equal(snapB.data()?.parentId, docAId);
          assert.deepEqual(snapB.data()?.path, [docAId]);
        });
      });

      test("missing destination rejection: moving under nonexistent document is denied and state unchanged", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const batch = writeBatch(alice);
        batch.update(doc(alice, "documents", docAId), {
          parentId: "nonexistent-parent",
          path: ["nonexistent-parent"],
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(alice, "documents", docBId), {
          path: ["nonexistent-parent", docAId],
          updatedAt: serverTimestamp(),
        });

        await assertFails(batch.commit());

        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          const snapA = await getDoc(doc(adminDb, "documents", docAId));
          assert.equal(snapA.data()?.parentId, null);
          assert.deepEqual(snapA.data()?.path, []);
        });
      });

      test("soft-deleted destination rejection: moving under soft-deleted document is denied and state unchanged", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const batch = writeBatch(alice);
        batch.update(doc(alice, "documents", docAId), {
          parentId: docSoftDeletedId,
          path: [docSoftDeletedId],
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(alice, "documents", docBId), {
          path: [docSoftDeletedId, docAId],
          updatedAt: serverTimestamp(),
        });

        await assertFails(batch.commit());

        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          const snapA = await getDoc(doc(adminDb, "documents", docAId));
          assert.equal(snapA.data()?.parentId, null);
          assert.deepEqual(snapA.data()?.path, []);
        });
      });

      test("claimed destination rejection: moving under claimed destination is denied and state unchanged", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        // 1. Lifecycle claimed
        const batch1 = writeBatch(alice);
        batch1.update(doc(alice, "documents", docAId), {
          parentId: docLifecycleClaimedId,
          path: [docLifecycleClaimedId],
          updatedAt: serverTimestamp(),
        });
        await assertFails(batch1.commit());

        // 2. Permanent deletion claimed
        const batch2 = writeBatch(alice);
        batch2.update(doc(alice, "documents", docAId), {
          parentId: docPermanentClaimedId,
          path: [docPermanentClaimedId],
          updatedAt: serverTimestamp(),
        });
        await assertFails(batch2.commit());

        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          const snapA = await getDoc(doc(adminDb, "documents", docAId));
          assert.equal(snapA.data()?.parentId, null);
          assert.deepEqual(snapA.data()?.path, []);
        });
      });

      test("cycle rejection: moving beneath self or beneath descendant is denied and state unchanged", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        // 1. Moving under self
        await assertFails(
          updateDoc(doc(alice, "documents", docAId), {
            parentId: docAId,
            path: [docAId],
            updatedAt: serverTimestamp(),
          })
        );

        // 2. Moving under descendant docC
        const batch = writeBatch(alice);
        batch.update(doc(alice, "documents", docAId), {
          parentId: docCId,
          path: [docAId, docBId, docCId],
          updatedAt: serverTimestamp(),
        });
        await assertFails(batch.commit());

        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          const snapA = await getDoc(doc(adminDb, "documents", docAId));
          assert.equal(snapA.data()?.parentId, null);
          assert.deepEqual(snapA.data()?.path, []);
        });
      });

      test("forged descendant path rejection: forged path in batch is denied and state unchanged", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        const batch = writeBatch(alice);
        batch.update(doc(alice, "documents", docAId), {
          parentId: docKuikkeliId,
          path: [docKuikkeliId],
          updatedAt: serverTimestamp(),
        });
        // B claims forged path not matching A's path + A
        batch.update(doc(alice, "documents", docBId), {
          path: ["forged-parent", docAId],
          updatedAt: serverTimestamp(),
        });

        await assertFails(batch.commit());

        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          const snapA = await getDoc(doc(adminDb, "documents", docAId));
          const snapB = await getDoc(doc(adminDb, "documents", docBId));
          assert.equal(snapA.data()?.parentId, null);
          assert.deepEqual(snapA.data()?.path, []);
          assert.equal(snapB.data()?.parentId, docAId);
          assert.deepEqual(snapB.data()?.path, [docAId]);
        });
      });

      test("depth-five result rejection: moving subtree that exceeds 4-level limit is denied and state unchanged", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        // docDepth2Id is at depth 2 (path: [docKuikkeliId]).
        // Moving A beneath docDepth2Id:
        // A would be at depth 3 (path: [docKuikkeliId, docDepth2Id])
        // B would be at depth 4 (path: [docKuikkeliId, docDepth2Id, docAId])
        // C would be at depth 5 (path: [docKuikkeliId, docDepth2Id, docAId, docBId], size 4 > 3)
        const batch = writeBatch(alice);
        batch.update(doc(alice, "documents", docAId), {
          parentId: docDepth2Id,
          path: [docKuikkeliId, docDepth2Id],
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(alice, "documents", docBId), {
          path: [docKuikkeliId, docDepth2Id, docAId],
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(alice, "documents", docCId), {
          path: [docKuikkeliId, docDepth2Id, docAId, docBId],
          updatedAt: serverTimestamp(),
        });

        await assertFails(batch.commit());

        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          const snapA = await getDoc(doc(adminDb, "documents", docAId));
          const snapC = await getDoc(doc(adminDb, "documents", docCId));
          assert.equal(snapA.data()?.parentId, null);
          assert.deepEqual(snapA.data()?.path, []);
          assert.equal(snapC.data()?.parentId, docBId);
          assert.deepEqual(snapC.data()?.path, [docAId, docBId]);
        });
      });

      test("unauthorized and removed-member rejection: non-member and removed member are denied", async () => {
        // 1. Non-member Charlie
        const charlie = testEnv.authenticatedContext("charlie").firestore();
        const batch1 = writeBatch(charlie);
        batch1.update(doc(charlie, "documents", docAId), {
          parentId: docKuikkeliId,
          path: [docKuikkeliId],
          updatedAt: serverTimestamp(),
        });
        await assertFails(batch1.commit());

        // 2. Remove Bob from space
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          await updateDoc(doc(adminDb, "spaces", moveSpaceId), {
            userIds: ["alice"],
            updatedAt: serverTimestamp(),
          });
        });

        // 3. Removed Bob attempts move
        const bob = testEnv.authenticatedContext("bob").firestore();
        const batch2 = writeBatch(bob);
        batch2.update(doc(bob, "documents", docAId), {
          parentId: docKuikkeliId,
          path: [docKuikkeliId],
          updatedAt: serverTimestamp(),
        });
        await assertFails(batch2.commit());

        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          const snapA = await getDoc(doc(adminDb, "documents", docAId));
          assert.equal(snapA.data()?.parentId, null);
          assert.deepEqual(snapA.data()?.path, []);
        });
      });

      test("partial subtree update rejection: stale or omitted descendant update in batch is denied", async () => {
        const alice = testEnv.authenticatedContext("alice").firestore();
        // Case 1: A moves to kuikkeli, but B's path is updated incorrectly (e.g. omitting A)
        const batch1 = writeBatch(alice);
        batch1.update(doc(alice, "documents", docAId), {
          parentId: docKuikkeliId,
          path: [docKuikkeliId],
          updatedAt: serverTimestamp(),
        });
        batch1.update(doc(alice, "documents", docBId), {
          path: [docKuikkeliId], // Incorrect: should be [docKuikkeliId, docAId]
          updatedAt: serverTimestamp(),
        });

        await assertFails(batch1.commit());

        // Case 2: A moves to kuikkeli, B moves correctly, but C's path is updated incorrectly (omitting B)
        const batch2 = writeBatch(alice);
        batch2.update(doc(alice, "documents", docAId), {
          parentId: docKuikkeliId,
          path: [docKuikkeliId],
          updatedAt: serverTimestamp(),
        });
        batch2.update(doc(alice, "documents", docBId), {
          path: [docKuikkeliId, docAId],
          updatedAt: serverTimestamp(),
        });
        batch2.update(doc(alice, "documents", docCId), {
          path: [docKuikkeliId, docAId], // Incorrect: should be [docKuikkeliId, docAId, docBId]
          updatedAt: serverTimestamp(),
        });

        await assertFails(batch2.commit());

        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          const snapA = await getDoc(doc(adminDb, "documents", docAId));
          const snapB = await getDoc(doc(adminDb, "documents", docBId));
          assert.equal(snapA.data()?.parentId, null);
          assert.deepEqual(snapA.data()?.path, []);
          assert.equal(snapB.data()?.parentId, docAId);
          assert.deepEqual(snapB.data()?.path, [docAId]);
        });
      });

      test("lifecycle compatibility: soft-delete, restore to root, and subsequent move beneath active document succeeds", async () => {
        const groupId = "grp-lifecycle-compat";

        // Step 1: Subtree A -> B -> C is soft-deleted by Admin SDK (as server action does)
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          await updateDoc(doc(adminDb, "documents", docAId), {
            deleted: true,
            deletedAt: serverTimestamp(),
            deletedBy: "alice",
            deletionGroupId: groupId,
            deletionGroupRootId: docAId,
            deletionGroupCount: 3,
            lifecycleClaim: null,
          });
          await updateDoc(doc(adminDb, "documents", docBId), {
            deleted: true,
            deletedAt: serverTimestamp(),
            deletedBy: "alice",
            deletionGroupId: groupId,
            deletionGroupRootId: docAId,
            lifecycleClaim: null,
          });
          await updateDoc(doc(adminDb, "documents", docCId), {
            deleted: true,
            deletedAt: serverTimestamp(),
            deletedBy: "alice",
            deletionGroupId: groupId,
            deletionGroupRootId: docAId,
            lifecycleClaim: null,
          });
        });

        // Step 2: Restored to Space root by Admin SDK (lifecycle claims cleared, deleted: false)
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          await updateDoc(doc(adminDb, "documents", docAId), {
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            deletionGroupId: null,
            deletionGroupRootId: null,
            deletionGroupCount: null,
            lifecycleClaim: null,
            parentId: null,
            path: [],
          });
          await updateDoc(doc(adminDb, "documents", docBId), {
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            deletionGroupId: null,
            deletionGroupRootId: null,
            lifecycleClaim: null,
            parentId: docAId,
            path: [docAId],
          });
          await updateDoc(doc(adminDb, "documents", docCId), {
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            deletionGroupId: null,
            deletionGroupRootId: null,
            lifecycleClaim: null,
            parentId: docBId,
            path: [docAId, docBId],
          });
        });

        // Step 3: Direct client (authenticated space member) attempts to move restored subtree beneath kuikkeli -> denied
        const alice = testEnv.authenticatedContext("alice").firestore();
        const batch = writeBatch(alice);
        batch.update(doc(alice, "documents", docAId), {
          parentId: docKuikkeliId,
          path: [docKuikkeliId],
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(alice, "documents", docBId), {
          path: [docKuikkeliId, docAId],
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(alice, "documents", docCId), {
          path: [docKuikkeliId, docAId, docBId],
          updatedAt: serverTimestamp(),
        });

        await assertFails(batch.commit());

        // Step 4: Authoritative move via Admin transaction succeeds and updates storage
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          await adminDb.runTransaction(async (tx) => {
            tx.update(doc(adminDb, "documents", docAId), {
              parentId: docKuikkeliId,
              path: [docKuikkeliId],
              updatedAt: serverTimestamp(),
            });
            tx.update(doc(adminDb, "documents", docBId), {
              path: [docKuikkeliId, docAId],
              updatedAt: serverTimestamp(),
            });
            tx.update(doc(adminDb, "documents", docCId), {
              path: [docKuikkeliId, docAId, docBId],
              updatedAt: serverTimestamp(),
            });
          });
          const snapA = await getDoc(doc(adminDb, "documents", docAId));
          const snapB = await getDoc(doc(adminDb, "documents", docBId));
          const snapC = await getDoc(doc(adminDb, "documents", docCId));
          const contentSnap = await getDoc(doc(adminDb, `documents/${docAId}/content`, "main"));

          assert.equal(snapA.data()?.parentId, docKuikkeliId);
          assert.deepEqual(snapA.data()?.path, [docKuikkeliId]);
          assert.equal(snapA.data()?.deleted, false);
          assert.equal(snapA.data()?.lifecycleClaim, null);

          assert.equal(snapB.data()?.parentId, docAId);
          assert.deepEqual(snapB.data()?.path, [docKuikkeliId, docAId]);
          assert.equal(snapB.data()?.deleted, false);
          assert.equal(snapB.data()?.lifecycleClaim, null);

          assert.equal(snapC.data()?.parentId, docBId);
          assert.deepEqual(snapC.data()?.path, [docKuikkeliId, docAId, docBId]);
          assert.equal(snapC.data()?.deleted, false);
          assert.equal(snapC.data()?.lifecycleClaim, null);

          // Content intact
          assert.equal(contentSnap.data()?.content, "Content A");
        });
      });

      test("reproduction regression: moving former parent kuikkeli succeeds when its former subtree A -> B -> C is soft-deleted into Trash", async () => {
        const spaceId = "space-kuikkeli-move-test";
        const docJukukekkuliId = "doc-juku";
        const docRaikuliId = "doc-raiku";
        const docKuikkeliId = "doc-kuik";
        const docAId = "doc-a-trash";
        const docBId = "doc-b-trash";
        const docCId = "doc-c-trash";
        const groupId = "grp-trash-abc";

        // Setup active space and initial state:
        // Space root
        // ├── jukukekkuli
        // │   └── raikuli (depth 2)
        // └── kuikkeli (depth 1)
        //
        // In Trash (soft-deleted with Trash-local paths and restoreParentId: docKuikkeliId):
        // └── doc-a-trash (parentId: null, path: [], restoreParentId: docKuikkeliId)
        //     └── doc-b-trash (parentId: doc-a-trash, path: [doc-a-trash])
        //         └── doc-c-trash (parentId: doc-b-trash, path: [doc-a-trash, doc-b-trash])
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          await setDoc(doc(adminDb, "spaces", spaceId), {
            name: "Kuikkeli Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice"],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          await setDoc(doc(adminDb, "documents", docJukukekkuliId), {
            spaceId,
            title: "jukukekkuli",
            parentId: null,
            path: [],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          await setDoc(doc(adminDb, "documents", docRaikuliId), {
            spaceId,
            title: "raikuli",
            parentId: docJukukekkuliId,
            path: [docJukukekkuliId],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          await setDoc(doc(adminDb, "documents", docKuikkeliId), {
            spaceId,
            title: "kuikkeli",
            parentId: null,
            path: [],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          // Soft-deleted subtree in Trash with Trash-local paths:
          await setDoc(doc(adminDb, "documents", docAId), {
            spaceId,
            title: "A",
            parentId: null,
            path: [],
            restoreParentId: docKuikkeliId,
            deleted: true,
            deletedAt: serverTimestamp(),
            deletedBy: "alice",
            deletionGroupId: groupId,
            deletionGroupRootId: docAId,
            deletionGroupCount: 3,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          await setDoc(doc(adminDb, "documents", docBId), {
            spaceId,
            title: "B",
            parentId: docAId,
            path: [docAId],
            deleted: true,
            deletedAt: serverTimestamp(),
            deletedBy: "alice",
            deletionGroupId: groupId,
            deletionGroupRootId: docAId,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          await setDoc(doc(adminDb, "documents", docCId), {
            spaceId,
            title: "C",
            parentId: docBId,
            path: [docAId, docBId],
            deleted: true,
            deletedAt: serverTimestamp(),
            deletedBy: "alice",
            deletionGroupId: groupId,
            deletionGroupRootId: docAId,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        });

        // Direct client attempts to move kuikkeli beneath raikuli -> denied
        const alice = testEnv.authenticatedContext("alice").firestore();
        const batch = writeBatch(alice);
        batch.update(doc(alice, "documents", docKuikkeliId), {
          parentId: docRaikuliId,
          path: [docJukukekkuliId, docRaikuliId],
          updatedAt: serverTimestamp(),
        });

        await assertFails(batch.commit());

        // Authoritative Admin transaction moves kuikkeli beneath raikuli
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          await adminDb.runTransaction(async (tx) => {
            tx.update(doc(adminDb, "documents", docKuikkeliId), {
              parentId: docRaikuliId,
              path: [docJukukekkuliId, docRaikuliId],
              updatedAt: serverTimestamp(),
            });
          });

          const kuikkeliSnap = await getDoc(doc(adminDb, "documents", docKuikkeliId));
          assert.equal(kuikkeliSnap.data()?.parentId, docRaikuliId);
          assert.deepEqual(kuikkeliSnap.data()?.path, [docJukukekkuliId, docRaikuliId]);

          const aSnap = await getDoc(doc(adminDb, "documents", docAId));
          assert.equal(aSnap.data()?.deleted, true);
          assert.equal(aSnap.data()?.parentId, null);
          assert.deepEqual(aSnap.data()?.path, []);
          assert.equal(aSnap.data()?.restoreParentId, docKuikkeliId);
        });
      });
    });

    describe("Subtree Move — Broad Subtree & Rules Access-Call Limits", () => {
      const broadSpaceId = "space-broad-move-test";
      const docDestId = "doc-dest-root";

      beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await setDoc(doc(db, "spaces", broadSpaceId), {
            name: "Broad Move Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            deletedAt: null,
            deletedBy: null,
          });

          // Destination parent at Space root (depth 1, path [])
          await setDoc(doc(db, "documents", docDestId), {
            spaceId: broadSpaceId,
            title: "Destination Root",
            parentId: null,
            path: [],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        });
      });

      test("control: small valid subtree move is denied to direct clients; succeeds via authoritative Admin transaction", async () => {
        const rootId = "small-ctrl-root";
        const c1Id = "small-ctrl-c1";
        const c2Id = "small-ctrl-c2";

        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await setDoc(doc(db, "documents", rootId), {
            spaceId: broadSpaceId,
            title: "Small Root",
            parentId: null,
            path: [],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, "documents", c1Id), {
            spaceId: broadSpaceId,
            title: "Small Child 1",
            parentId: rootId,
            path: [rootId],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, "documents", c2Id), {
            spaceId: broadSpaceId,
            title: "Small Child 2",
            parentId: rootId,
            path: [rootId],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        });

        const alice = testEnv.authenticatedContext("alice").firestore();
        const batch = writeBatch(alice);

        batch.update(doc(alice, "documents", rootId), {
          parentId: docDestId,
          path: [docDestId],
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(alice, "documents", c1Id), {
          path: [docDestId, rootId],
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(alice, "documents", c2Id), {
          path: [docDestId, rootId],
          updatedAt: serverTimestamp(),
        });

        // Direct client batch move modifying hierarchy fields is denied
        await assertFails(batch.commit());

        // Authoritative Admin transaction succeeds and updates emulator storage
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          await adminDb.runTransaction(async (tx) => {
            tx.update(doc(adminDb, "documents", rootId), {
              parentId: docDestId,
              path: [docDestId],
              updatedAt: serverTimestamp(),
            });
            tx.update(doc(adminDb, "documents", c1Id), {
              path: [docDestId, rootId],
              updatedAt: serverTimestamp(),
            });
            tx.update(doc(adminDb, "documents", c2Id), {
              path: [docDestId, rootId],
              updatedAt: serverTimestamp(),
            });
          });

          const snapRoot = await getDoc(doc(adminDb, "documents", rootId));
          const snapC1 = await getDoc(doc(adminDb, "documents", c1Id));
          const snapC2 = await getDoc(doc(adminDb, "documents", c2Id));

          assert.equal(snapRoot.data()?.parentId, docDestId);
          assert.deepEqual(snapRoot.data()?.path, [docDestId]);

          assert.equal(snapC1.data()?.parentId, rootId);
          assert.deepEqual(snapC1.data()?.path, [docDestId, rootId]);

          assert.equal(snapC2.data()?.parentId, rootId);
          assert.deepEqual(snapC2.data()?.path, [docDestId, rootId]);
        });
      });

      test("broad valid subtree move: 31-document branching tree (1 root + 6 branches + 24 leaves) denied to direct client; succeeds via authoritative Admin transaction", async () => {
        const rootId = "broad-root";
        const branchIds: string[] = [];
        const leafIds: { id: string; branchId: string }[] = [];

        const branchCount = 6;
        const leavesPerBranch = 4;

        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();

          await setDoc(doc(db, "documents", rootId), {
            spaceId: broadSpaceId,
            title: "Broad Root",
            parentId: null,
            path: [],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          for (let b = 1; b <= branchCount; b++) {
            const bId = `broad-b${b}`;
            branchIds.push(bId);
            await setDoc(doc(db, "documents", bId), {
              spaceId: broadSpaceId,
              title: `Branch ${b}`,
              parentId: rootId,
              path: [rootId],
              deleted: false,
              deletedAt: null,
              deletedBy: null,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });

            for (let l = 1; l <= leavesPerBranch; l++) {
              const lId = `broad-b${b}-l${l}`;
              leafIds.push({ id: lId, branchId: bId });
              await setDoc(doc(db, "documents", lId), {
                spaceId: broadSpaceId,
                title: `Leaf ${b}-${l}`,
                parentId: bId,
                path: [rootId, bId],
                deleted: false,
                deletedAt: null,
                deletedBy: null,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });
            }
          }
        });

        const alice = testEnv.authenticatedContext("alice").firestore();
        const batch = writeBatch(alice);

        batch.update(doc(alice, "documents", rootId), {
          parentId: docDestId,
          path: [docDestId],
          updatedAt: serverTimestamp(),
        });

        for (const bId of branchIds) {
          batch.update(doc(alice, "documents", bId), {
            path: [docDestId, rootId],
            updatedAt: serverTimestamp(),
          });
        }

        for (const { id: lId, branchId } of leafIds) {
          batch.update(doc(alice, "documents", lId), {
            path: [docDestId, rootId, branchId],
            updatedAt: serverTimestamp(),
          });
        }

        // Direct client batch move modifying hierarchy fields is denied
        await assertFails(batch.commit());

        // Authoritative Admin transaction succeeds and updates emulator storage
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          await adminDb.runTransaction(async (tx) => {
            tx.update(doc(adminDb, "documents", rootId), {
              parentId: docDestId,
              path: [docDestId],
              updatedAt: serverTimestamp(),
            });

            for (const bId of branchIds) {
              tx.update(doc(adminDb, "documents", bId), {
                path: [docDestId, rootId],
                updatedAt: serverTimestamp(),
              });
            }

            for (const { id: lId, branchId } of leafIds) {
              tx.update(doc(adminDb, "documents", lId), {
                path: [docDestId, rootId, branchId],
                updatedAt: serverTimestamp(),
              });
            }
          });

          const rootSnap = await getDoc(doc(adminDb, "documents", rootId));
          assert.equal(rootSnap.data()?.parentId, docDestId);
          assert.deepEqual(rootSnap.data()?.path, [docDestId]);

          for (const bId of branchIds) {
            const bSnap = await getDoc(doc(adminDb, "documents", bId));
            assert.equal(bSnap.data()?.parentId, rootId);
            assert.deepEqual(bSnap.data()?.path, [docDestId, rootId]);
          }

          for (const { id: lId, branchId } of leafIds) {
            const lSnap = await getDoc(doc(adminDb, "documents", lId));
            assert.equal(lSnap.data()?.parentId, branchId);
            assert.deepEqual(lSnap.data()?.path, [docDestId, rootId, branchId]);
          }
        });
      });

      test("flat broad subtree move: 51 documents (1 root + 50 direct children) denied to direct client; succeeds via authoritative Admin transaction", async () => {
        const rootId = "flat50-root";
        const childIds: string[] = [];
        const childCount = 50;

        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await setDoc(doc(db, "documents", rootId), {
            spaceId: broadSpaceId,
            title: "Flat 50 Root",
            parentId: null,
            path: [],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          for (let c = 1; c <= childCount; c++) {
            const cId = `flat-c-${c}`;
            childIds.push(cId);
            await setDoc(doc(db, "documents", cId), {
              spaceId: broadSpaceId,
              title: `Flat Child ${c}`,
              parentId: rootId,
              path: [rootId],
              deleted: false,
              deletedAt: null,
              deletedBy: null,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          }
        });

        const alice = testEnv.authenticatedContext("alice").firestore();
        const batch = writeBatch(alice);

        batch.update(doc(alice, "documents", rootId), {
          parentId: docDestId,
          path: [docDestId],
          updatedAt: serverTimestamp(),
        });

        for (const cId of childIds) {
          batch.update(doc(alice, "documents", cId), {
            path: [docDestId, rootId],
            updatedAt: serverTimestamp(),
          });
        }

        // Direct client batch move modifying hierarchy fields is denied
        await assertFails(batch.commit());

        // Authoritative Admin transaction succeeds and updates emulator storage
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          await adminDb.runTransaction(async (tx) => {
            tx.update(doc(adminDb, "documents", rootId), {
              parentId: docDestId,
              path: [docDestId],
              updatedAt: serverTimestamp(),
            });

            for (const cId of childIds) {
              tx.update(doc(adminDb, "documents", cId), {
                path: [docDestId, rootId],
                updatedAt: serverTimestamp(),
              });
            }
          });

          const rootSnap = await getDoc(doc(adminDb, "documents", rootId));
          assert.equal(rootSnap.data()?.parentId, docDestId);
          assert.deepEqual(rootSnap.data()?.path, [docDestId]);

          for (const cId of childIds) {
            const cSnap = await getDoc(doc(adminDb, "documents", cId));
            assert.equal(cSnap.data()?.parentId, rootId);
            assert.deepEqual(cSnap.data()?.path, [docDestId, rootId]);
          }
        });
      });

      test("15-document branching tree with 7 branch parents denied to direct client; succeeds via authoritative Admin transaction", async () => {
        const rootId = "bound7-root";
        const branchIds: string[] = [];
        const leafIds: { id: string; branchId: string }[] = [];
        const branchCount = 7;

        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await setDoc(doc(db, "documents", rootId), {
            spaceId: broadSpaceId,
            title: "Boundary 7 Root",
            parentId: null,
            path: [],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          for (let b = 1; b <= branchCount; b++) {
            const bId = `b7-${b}`;
            branchIds.push(bId);
            await setDoc(doc(db, "documents", bId), {
              spaceId: broadSpaceId,
              title: `Branch 7-${b}`,
              parentId: rootId,
              path: [rootId],
              deleted: false,
              deletedAt: null,
              deletedBy: null,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });

            const lId = `b7-${b}-c`;
            leafIds.push({ id: lId, branchId: bId });
            await setDoc(doc(db, "documents", lId), {
              spaceId: broadSpaceId,
              title: `Leaf 7-${b}`,
              parentId: bId,
              path: [rootId, bId],
              deleted: false,
              deletedAt: null,
              deletedBy: null,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          }
        });

        const alice = testEnv.authenticatedContext("alice").firestore();
        const batch = writeBatch(alice);

        batch.update(doc(alice, "documents", rootId), {
          parentId: docDestId,
          path: [docDestId],
          updatedAt: serverTimestamp(),
        });
        for (const bId of branchIds) {
          batch.update(doc(alice, "documents", bId), {
            path: [docDestId, rootId],
            updatedAt: serverTimestamp(),
          });
        }
        for (const { id: lId, branchId } of leafIds) {
          batch.update(doc(alice, "documents", lId), {
            path: [docDestId, rootId, branchId],
            updatedAt: serverTimestamp(),
          });
        }

        // Direct client batch move modifying hierarchy fields is denied
        await assertFails(batch.commit());

        // Authoritative Admin transaction succeeds and updates emulator storage
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          await adminDb.runTransaction(async (tx) => {
            tx.update(doc(adminDb, "documents", rootId), {
              parentId: docDestId,
              path: [docDestId],
              updatedAt: serverTimestamp(),
            });
            for (const bId of branchIds) {
              tx.update(doc(adminDb, "documents", bId), {
                path: [docDestId, rootId],
                updatedAt: serverTimestamp(),
              });
            }
            for (const { id: lId, branchId } of leafIds) {
              tx.update(doc(adminDb, "documents", lId), {
                path: [docDestId, rootId, branchId],
                updatedAt: serverTimestamp(),
              });
            }
          });

          const rootSnap = await getDoc(doc(adminDb, "documents", rootId));
          assert.equal(rootSnap.data()?.parentId, docDestId);
          assert.deepEqual(rootSnap.data()?.path, [docDestId]);

          for (const bId of branchIds) {
            const bSnap = await getDoc(doc(adminDb, "documents", bId));
            assert.equal(bSnap.data()?.parentId, rootId);
            assert.deepEqual(bSnap.data()?.path, [docDestId, rootId]);
          }

          for (const { id: lId, branchId } of leafIds) {
            const lSnap = await getDoc(doc(adminDb, "documents", lId));
            assert.equal(lSnap.data()?.parentId, branchId);
            assert.deepEqual(lSnap.data()?.path, [docDestId, rootId, branchId]);
          }
        });
      });

      test("17-document branching tree (1 root + 8 branches + 8 leaves) denied to direct client; succeeds via authoritative Admin transaction", async () => {
        const rootId = "fail8-root";
        const branchIds: string[] = [];
        const leafIds: { id: string; branchId: string }[] = [];

        // 1 root + 8 branch parents + 8 leaf children = 17 documents.
        const branchCount = 8;

        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();

          await setDoc(doc(db, "documents", rootId), {
            spaceId: broadSpaceId,
            title: "Fail 8 Root",
            parentId: null,
            path: [],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          for (let b = 1; b <= branchCount; b++) {
            const bId = `b8-${b}`;
            branchIds.push(bId);
            await setDoc(doc(db, "documents", bId), {
              spaceId: broadSpaceId,
              title: `Branch 8-${b}`,
              parentId: rootId,
              path: [rootId],
              deleted: false,
              deletedAt: null,
              deletedBy: null,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });

            const lId = `b8-${b}-c`;
            leafIds.push({ id: lId, branchId: bId });
            await setDoc(doc(db, "documents", lId), {
              spaceId: broadSpaceId,
              title: `Leaf 8-${b}`,
              parentId: bId,
              path: [rootId, bId],
              deleted: false,
              deletedAt: null,
              deletedBy: null,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          }
        });

        const alice = testEnv.authenticatedContext("alice").firestore();
        const batch = writeBatch(alice);

        batch.update(doc(alice, "documents", rootId), {
          parentId: docDestId,
          path: [docDestId],
          updatedAt: serverTimestamp(),
        });

        for (const bId of branchIds) {
          batch.update(doc(alice, "documents", bId), {
            path: [docDestId, rootId],
            updatedAt: serverTimestamp(),
          });
        }

        for (const { id: lId, branchId } of leafIds) {
          batch.update(doc(alice, "documents", lId), {
            path: [docDestId, rootId, branchId],
            updatedAt: serverTimestamp(),
          });
        }

        // Direct client batch move is denied at the rules boundary
        await assertFails(batch.commit());

        // Verify atomic rollback: 0 partial writes persisted
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          const rootSnap = await getDoc(doc(db, "documents", rootId));
          assert.equal(rootSnap.data()?.parentId, null);
          assert.deepEqual(rootSnap.data()?.path, []);

          for (const bId of branchIds) {
            const bSnap = await getDoc(doc(db, "documents", bId));
            assert.equal(bSnap.data()?.parentId, rootId);
            assert.deepEqual(bSnap.data()?.path, [rootId]);
          }

          for (const { id: lId, branchId } of leafIds) {
            const lSnap = await getDoc(doc(db, "documents", lId));
            assert.equal(lSnap.data()?.parentId, branchId);
            assert.deepEqual(lSnap.data()?.path, [rootId, branchId]);
          }
        });

        // Authoritative Admin transaction succeeds for the exact 17-document topology
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const adminDb = context.firestore();
          await adminDb.runTransaction(async (tx) => {
            tx.update(doc(adminDb, "documents", rootId), {
              parentId: docDestId,
              path: [docDestId],
              updatedAt: serverTimestamp(),
            });
            for (const bId of branchIds) {
              tx.update(doc(adminDb, "documents", bId), {
                path: [docDestId, rootId],
                updatedAt: serverTimestamp(),
              });
            }
            for (const { id: lId, branchId } of leafIds) {
              tx.update(doc(adminDb, "documents", lId), {
                path: [docDestId, rootId, branchId],
                updatedAt: serverTimestamp(),
              });
            }
          });

          const rootSnap = await getDoc(doc(adminDb, "documents", rootId));
          assert.equal(rootSnap.data()?.parentId, docDestId);
          assert.deepEqual(rootSnap.data()?.path, [docDestId]);

          for (const bId of branchIds) {
            const bSnap = await getDoc(doc(adminDb, "documents", bId));
            assert.equal(bSnap.data()?.parentId, rootId);
            assert.deepEqual(bSnap.data()?.path, [docDestId, rootId]);
          }

          for (const { id: lId, branchId } of leafIds) {
            const lSnap = await getDoc(doc(adminDb, "documents", lId));
            assert.equal(lSnap.data()?.parentId, branchId);
            assert.deepEqual(lSnap.data()?.path, [docDestId, rootId, branchId]);
          }
        });
      });

      test("invalid forged-path control: one descendant in broad batch with corrupted path fails atomically and persists nothing", async () => {
        const rootId = "forged-ctrl-root";
        const bId = "forged-ctrl-b";
        const l1Id = "forged-ctrl-l1";
        const l2Id = "forged-ctrl-l2";

        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await setDoc(doc(db, "documents", rootId), {
            spaceId: broadSpaceId,
            title: "Forged Root",
            parentId: null,
            path: [],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, "documents", bId), {
            spaceId: broadSpaceId,
            title: "Forged Branch",
            parentId: rootId,
            path: [rootId],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, "documents", l1Id), {
            spaceId: broadSpaceId,
            title: "Forged Leaf 1",
            parentId: bId,
            path: [rootId, bId],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, "documents", l2Id), {
            spaceId: broadSpaceId,
            title: "Forged Leaf 2",
            parentId: bId,
            path: [rootId, bId],
            deleted: false,
            deletedAt: null,
            deletedBy: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        });

        const alice = testEnv.authenticatedContext("alice").firestore();
        const batch = writeBatch(alice);

        batch.update(doc(alice, "documents", rootId), {
          parentId: docDestId,
          path: [docDestId],
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(alice, "documents", bId), {
          path: [docDestId, rootId],
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(alice, "documents", l1Id), {
          path: [docDestId, rootId, bId],
          updatedAt: serverTimestamp(),
        });
        // Corrupt path for l2: skips bId in path even though parentId is bId
        batch.update(doc(alice, "documents", l2Id), {
          path: [docDestId, rootId],
          updatedAt: serverTimestamp(),
        });

        // The batch MUST fail
        await assertFails(batch.commit());

        // Verify atomic rollback: no writes persisted anywhere in the batch
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          const rootSnap = await getDoc(doc(db, "documents", rootId));
          const bSnap = await getDoc(doc(db, "documents", bId));
          const l1Snap = await getDoc(doc(db, "documents", l1Id));
          const l2Snap = await getDoc(doc(db, "documents", l2Id));

          assert.equal(rootSnap.data()?.parentId, null);
          assert.deepEqual(rootSnap.data()?.path, []);

          assert.equal(bSnap.data()?.parentId, rootId);
          assert.deepEqual(bSnap.data()?.path, [rootId]);

          assert.equal(l1Snap.data()?.parentId, bId);
          assert.deepEqual(l1Snap.data()?.path, [rootId, bId]);

          assert.equal(l2Snap.data()?.parentId, bId);
          assert.deepEqual(l2Snap.data()?.path, [rootId, bId]);
        });
      });
    });

    describe("Direct-Client Bypass Prevention of Image Cleanup State & Save Boundary", () => {
      const spaceTestId = "space-image-lifecycle-test";
      const docTestId = "doc-image-lifecycle-test";

      beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          // Seed active space
          await setDoc(doc(db, "spaces", spaceTestId), {
            name: "Image Lifecycle Test Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice", "bob"],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            deletedAt: null,
            deletedBy: null,
            purgeState: null,
          });

          // Seed active document
          await setDoc(doc(db, "documents", docTestId), {
            spaceId: spaceTestId,
            title: "Original Document",
            parentId: null,
            path: [],
            revision: 1,
            pendingImageCleanup: ["uploads/space-image-lifecycle-test/doc-image-lifecycle-test/old-img.png"],
            retiredImageKeys: ["space-image-lifecycle-test/doc-image-lifecycle-test/retired-img.png"],
            imageCleanupClaim: {
              claimId: "claim-worker-active",
              keys: ["uploads/space-image-lifecycle-test/doc-image-lifecycle-test/old-img.png"],
              claimedAt: serverTimestamp(),
            },
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            deleted: false,
          });

          // Seed content subcollection
          await setDoc(doc(db, `documents/${docTestId}/content`, "main"), {
            content: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Original document content" }],
                },
              ],
            },
            updatedAt: serverTimestamp(),
          });
        });
      });

      test("negative: direct client contributor cannot clear or overwrite imageCleanupClaim via updateDoc", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const docRef = doc(bob, "documents", docTestId);

        // Attempt to clear claim with null
        await assertFails(updateDoc(docRef, { imageCleanupClaim: null }));

        // Attempt to clear claim with deleteField()
        await assertFails(updateDoc(docRef, { imageCleanupClaim: deleteField() }));

        // Attempt to forge or alter claim with new claimId
        await assertFails(
          updateDoc(docRef, {
            imageCleanupClaim: {
              claimId: "forged-claim-id",
              keys: [],
            },
          })
        );
      });

      test("negative: direct client contributor cannot clear or alter pendingImageCleanup via updateDoc", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const docRef = doc(bob, "documents", docTestId);

        // Attempt to clear pending cleanup with empty array
        await assertFails(updateDoc(docRef, { pendingImageCleanup: [] }));

        // Attempt to delete pending cleanup field
        await assertFails(updateDoc(docRef, { pendingImageCleanup: deleteField() }));

        // Attempt to overwrite pending cleanup keys
        await assertFails(updateDoc(docRef, { pendingImageCleanup: ["forged-key.png"] }));
      });

      test("negative: direct client contributor cannot clear or alter retiredImageKeys via updateDoc", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const docRef = doc(bob, "documents", docTestId);

        // Attempt to clear retired keys with empty array
        await assertFails(updateDoc(docRef, { retiredImageKeys: [] }));

        // Attempt to delete retired keys field
        await assertFails(updateDoc(docRef, { retiredImageKeys: deleteField() }));

        // Attempt to overwrite retired keys
        await assertFails(updateDoc(docRef, { retiredImageKeys: ["forged-key.png"] }));
      });

      test("negative: direct client contributor cannot modify or forge document revision via updateDoc", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const docRef = doc(bob, "documents", docTestId);

        // Attempt to increment revision directly
        await assertFails(updateDoc(docRef, { revision: 2 }));

        // Attempt to set arbitrary high revision
        await assertFails(updateDoc(docRef, { revision: 999 }));

        // Attempt to delete revision field
        await assertFails(updateDoc(docRef, { revision: deleteField() }));
      });

      test("negative: direct client contributor cannot forge cleanup state or invalid revision on document create", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();

        // Attempt create with imageCleanupClaim
        await assertFails(
          setDoc(doc(bob, "documents", "doc-create-with-claim"), {
            spaceId: spaceTestId,
            title: "Doc with claim",
            parentId: null,
            path: [],
            imageCleanupClaim: { claimId: "fake", keys: [] },
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        // Attempt create with pendingImageCleanup
        await assertFails(
          setDoc(doc(bob, "documents", "doc-create-with-pending"), {
            spaceId: spaceTestId,
            title: "Doc with pending",
            parentId: null,
            path: [],
            pendingImageCleanup: ["fake-key"],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        // Attempt create with retiredImageKeys
        await assertFails(
          setDoc(doc(bob, "documents", "doc-create-with-retired"), {
            spaceId: spaceTestId,
            title: "Doc with retired",
            parentId: null,
            path: [],
            retiredImageKeys: ["fake-key"],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        // Attempt create with revision != 1
        await assertFails(
          setDoc(doc(bob, "documents", "doc-create-with-rev2"), {
            spaceId: spaceTestId,
            title: "Doc with rev 2",
            parentId: null,
            path: [],
            revision: 2,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("negative: direct client contributor cannot write or update content on existing documents directly", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const contentRef = doc(bob, `documents/${docTestId}/content`, "main");

        // Attempt direct updateDoc on content
        await assertFails(
          updateDoc(contentRef, {
            content: { type: "doc", content: [] },
            updatedAt: serverTimestamp(),
          })
        );

        // Attempt direct setDoc on content (e.g. attempting to re-introduce retired image or bypass OCC)
        await assertFails(
          setDoc(contentRef, {
            content: {
              type: "doc",
              content: [
                {
                  type: "image",
                  attrs: {
                    src: `https://test-bucket.s3.amazonaws.com/uploads/${spaceTestId}/${docTestId}/retired-img.png`,
                  },
                },
              ],
            },
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("positive: direct client contributor CAN update non-protected document metadata", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const docRef = doc(bob, "documents", docTestId);

        // Update title and tags (not in isProtectedDocKeyModified)
        await assertSucceeds(
          updateDoc(docRef, {
            title: "Updated Legitimate Title",
            tags: ["architecture", "v0.7.0"],
            updatedAt: serverTimestamp(),
          })
        );
      });

      test("positive: atomic batch write creating document and initial content simultaneously succeeds", async () => {
        const bob = testEnv.authenticatedContext("bob").firestore();
        const newBatchDocId = "doc-batch-create-valid";
        const docRef = doc(bob, "documents", newBatchDocId);
        const contentRef = doc(bob, `documents/${newBatchDocId}/content`, "main");

        const batch = writeBatch(bob);
        batch.set(docRef, {
          spaceId: spaceTestId,
          title: "Batch Created Document",
          parentId: null,
          path: [],
          revision: 1,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        batch.set(contentRef, {
          content: { type: "doc", content: [{ type: "paragraph", text: "Hello world" }] },
          updatedAt: serverTimestamp(),
        });

        await assertSucceeds(batch.commit());
      });

      test("positive: soft-deleted space owner cleanup of document and content still succeeds", async () => {
        const cleanupSpaceId = "space-cleanup-owner-test";
        const cleanupDocId = "doc-cleanup-owner-test";

        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          await setDoc(doc(db, "spaces", cleanupSpaceId), {
            name: "Soft Deleted Space",
            isPublic: false,
            ownerId: "alice",
            userIds: ["alice"],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            deletedAt: serverTimestamp(),
            deletedBy: "alice",
          });
          await setDoc(doc(db, "documents", cleanupDocId), {
            spaceId: cleanupSpaceId,
            title: "Doc to Cleanup",
            parentId: null,
            path: [],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await setDoc(doc(db, `documents/${cleanupDocId}/content`, "main"), {
            content: { type: "doc" },
            updatedAt: serverTimestamp(),
          });
        });

        const alice = testEnv.authenticatedContext("alice").firestore();
        const docRef = doc(alice, "documents", cleanupDocId);
        const contentRef = doc(alice, `documents/${cleanupDocId}/content`, "main");

        // Space owner can delete content subcollection record during cleanup
        await assertSucceeds(deleteDoc(contentRef));

        // Space owner can delete document record during cleanup
        await assertSucceeds(deleteDoc(docRef));
      });
    });
  });
}
