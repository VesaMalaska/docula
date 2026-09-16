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

        // Member writes content
        await assertSucceeds(
          setDoc(doc(bob, `documents/${newDocId}/content`, "main"), {
            content: "Bob content",
            updatedAt: serverTimestamp(),
          })
        );

        // Member deletes document
        await assertSucceeds(deleteDoc(doc(bob, "documents", newDocId)));
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

        // 5. Owner can permanently delete soft-deleted space
        await assertSucceeds(deleteDoc(doc(alice, "spaces", deleteSpaceId)));
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

        // 14. Owner CAN permanently delete the deleted space itself
        await assertSucceeds(
          deleteDoc(doc(alice, "spaces", publicDeletedSpaceId))
        );
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

        // Step 3: Delete the space document itself
        await assertSucceeds(deleteDoc(doc(alice, "spaces", cascadeSpaceId)));

        // Step 4: Verify complete erasure of all records
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          assert.equal((await getDoc(doc(db, "spaces", cascadeSpaceId))).exists(), false);
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
        // - Alice (owner) CAN permanently delete the soft-deleted space
        await assertSucceeds(deleteDoc(doc(alice, "spaces", activeSpaceId)));
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

        // 1. Bob creates a document and writes content
        await assertSucceeds(
          setDoc(doc(bob, "documents", bobDocId), {
            title: "Bob's Work",
            spaceId: spaceId,
            parentId: null,
            path: [],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );

        await assertSucceeds(
          setDoc(doc(bob, `documents/${bobDocId}/content`, "main"), {
            content: "Essential research notes written by Bob",
            updatedAt: serverTimestamp(),
          })
        );

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
  });
}
