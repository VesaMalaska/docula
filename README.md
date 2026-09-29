# Docula

Docula is a place to write and organize documentation with other people. Put related documents in a Space, arrange them in a tree, and link pages when the relationships do not fit neatly into that tree.

I started Docula with an idea somewhere between a team wiki and a connected notebook. The application that emerged is more specific: a small collaborative documentation tool with clear ownership, editable membership, recoverable deletion, and a few useful ways to take your writing elsewhere. It is still a work in progress, and that is part of its story.

> **Status:** Docula is an early public release. Running your own instance requires Firebase and an AWS S3 bucket.

## Take a short tour

Imagine documenting a project with a teammate.

1. **Make a Space.** Choose private access for invited people or public access for anyone signed in to read. A signed-in reader can join a public Space to become a member and contribute.
2. **Give the writing a shape.** Create documents at the Space root or under other documents. The sidebar and breadcrumbs help you move through a tree up to four levels deep. Move documents within their Space as the structure changes.
3. **Write a page.** Use headings, lists, quotes, code blocks, tables, links, and images. Markdown-style input, explicit Markdown paste, and Markdown import help bring existing writing in.
4. **Connect two pages.** Type `[` while editing to find another document in the same Space and insert a link. The destination page shows a **Linked to by** list of pages that refer to it.
5. **Work with another person.** Add a member by email, or let someone join a public Space. A temporary editing lock gives one person the current turn; revision checks reject a stale save instead of silently overwriting newer content. This is turn-taking with conflict protection, rather than simultaneous live editing.
6. **Change your mind.** Documents and Spaces go to Trash before permanent deletion. Restore a document subtree when its destination and depth allow it, or export a document as Markdown or Word (`.docx`) for use elsewhere.

Spaces contain people and documents; the tree gives documents a home; links connect related ideas across the tree. Public means visible to **signed-in** readers, not anonymous access. Joining grants contributor access; there is no separate read-only member role.

## How it works

Next.js serves the workspace and Tiptap editor. Firebase Authentication identifies users, while Cloud Firestore stores Spaces, document metadata, and structured document content. TanStack Query manages client data fetching. Markdown import and export are document-level tools, not vault or repository synchronization.

Firestore Security Rules constrain direct client access. Sensitive document saves, hierarchy changes, permanent deletion, and image lifecycle operations also verify authorization on the server using the Firebase Admin SDK. App code and Rules must be deployed together when their contract changes.

Images live in S3. The app creates scoped upload requests and serves document images through an authorized route. Firestore and S3 do not share a transaction, so deletion and cleanup use bounded, retryable steps to recover from partial failures.

### Engineering decisions

- **Bounded hierarchy:** Moves and restores check the depth of the affected document subtree against the four-level limit.
- **Locks plus revisions:** A temporary lock indicates who is editing; a revision check prevents an older editor view from overwriting a newer save.
- **Recoverable deletion:** Trash retains the structure needed to restore documents and descendants. Permanent document and Space deletion also cleans up associated S3 objects.
- **Links in both directions:** Saving a document updates backlinks on its linked targets, giving readers a way to find pages that refer to the one they are viewing.
- **Explicit access boundaries:** Firestore Rules govern direct client access; server actions verify the caller and current state before sensitive changes.

These choices came from making the application behave coherently when people move, delete, restore, and edit documents—not from treating the editor as the whole product.

## Stack

- Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, and Tiptap
- Firebase Authentication (email/password) and Cloud Firestore
- Firebase Admin SDK for server operations and AWS S3 for document images
- TanStack Query for client data fetching; Vercel for application deployment

## Run locally

### Prerequisites

- Node.js 24 and pnpm 10 (the versions used during current development and preview builds)
- A Firebase project with Cloud Firestore and Email/Password Authentication enabled
- A Firebase service account for the server-side Admin SDK
- An S3 bucket and AWS credentials scoped to that bucket for image operations

1. Clone and install:

   ```bash
   git clone https://github.com/VesaMalaska/docula.git
   cd docula
   pnpm install
   ```

2. Copy the [environment template](.env.example) and fill in values from your Firebase web app configuration, Firebase service account, and S3 setup:

   ```bash
   cp .env.example .env.local
   ```

   Keep `.env.local` private; it is ignored by Git. Only `NEXT_PUBLIC_*` variables are sent to the browser. The Firebase Admin private key and AWS credentials belong on the server. For `FIREBASE_PRIVATE_KEY`, use literal `\n` separators inside the quoted value; the server converts them to newlines.

3. Configure the S3 bucket. The application needs permission to read, write, copy, delete, and list its image objects. Scope object permissions to the bucket's `temp/`, `uploads/`, and `deleted/uploads/` prefixes; `s3:ListBucket` applies to the bucket ARN, while object actions apply to object ARNs. Allow browser uploads from `http://localhost:3000` in the bucket CORS configuration. Configure an S3 lifecycle rule to expire `temp/` uploads after one day so abandoned temporary uploads are collected.

4. Deploy the included Firestore Rules and indexes to your **own** Firebase project:

   ```bash
   pnpm exec firebase login
   pnpm exec firebase deploy --only firestore:rules,firestore:indexes --project your_project_id
   ```

5. Start the app:

   ```bash
   pnpm dev
   ```

   Open [http://localhost:3000](http://localhost:3000), create an account, and create a Space.

## Checks

```bash
pnpm test            # unit tests
pnpm run test:rules  # Firestore Rules tests in the emulator
pnpm run build       # production build and TypeScript checks
```

The Rules test command starts a local Firebase emulator. It uses the demo project ID configured in the script and does not deploy to your Firebase project.

## Deployment

Set the same environment variables in your application host and deploy the app and `firestore.rules` as a coordinated change. The current Rules restrict direct client writes to existing document content; an older app build cannot perform saves after those Rules are deployed. Deploy Firestore indexes when required by your queries. Ensure the S3 bucket CORS `AllowedOrigins` includes the deployed application’s exact origin as well as any local origin used for development so image uploads work in production. Use a separate Firebase project and S3 bucket for non-production environments.

## Finding your way around the code

| Location | What lives there |
| --- | --- |
| `app/` | Pages, layouts, and the document image API |
| `components/` | Editor, sidebar, dialogs, and other interface pieces |
| `lib/actions/` | Document, Space, membership, and image operations |
| `lib/server/` | Firebase Admin initialization and server authorization |
| `lib/__tests__/` | Unit and Firestore Rules tests |
| `firestore.rules` / `firestore.indexes.json` | Data access rules and query indexes |

## License

Docula is licensed under the [MIT License](LICENSE). Copyright (c) 2026 Vesa Malaska.

If you fork Docula, a link back to the [original project](https://github.com/VesaMalaska/docula) is appreciated. The MIT license requires retaining its copyright and permission notice in redistributed copies; it does not require a link or an in-app credit.
