# Docula

Docula is a collaborative documentation app for organizing and writing team knowledge. Spaces group documents; a four-level tree keeps them navigable; links and backlinks connect related pages. The editor supports rich text, Markdown input, tables, code blocks, and images.

> **Project status:** Docula is preparing its first public release. The current repository is a prerelease; deployment and setup still require your own Firebase project and AWS S3 bucket.

## Why Docula exists

Team knowledge becomes difficult to use when documents are scattered or their relationships are hard to see. Docula brings writing, organization, and collaboration into one workspace: Spaces give a team a home for its material, a document tree gives it structure, and links and backlinks make related information easier to follow. The project also explores what it takes to keep that workspace trustworthy when people edit, move, restore, and delete content concurrently.

## What you can do

- Create private or public Spaces, invite members, and organize documents up to four levels deep.
- Edit together with document locks and revision checks that reject conflicting saves.
- Link documents, follow backlinks, and navigate the document tree from the sidebar.
- Import Markdown into a Space and export documents as Markdown or Word (`.docx`).
- Upload images through scoped S3 URLs, with client-side resizing and WebP conversion where supported.
- Move documents, send documents or Spaces to Trash, restore them, or permanently delete them.
- Use the light or dark theme on desktop and mobile.

Public Spaces can be read by signed-in users. Joining a public Space makes the user a member who can edit it.

## Stack

- Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, and Tiptap
- Firebase Authentication (email/password) and Cloud Firestore
- Firebase Admin SDK for server actions and AWS S3 for document images
- TanStack Query for client data fetching; Vercel for application deployment

## How it works

The Next.js App Router serves the workspace and editor. Tiptap manages rich-text content in the browser, while Firebase Authentication identifies users and Cloud Firestore stores Spaces, document metadata, and document content. TanStack Query keeps client views in sync with that data.

Sensitive operations such as document saves, hierarchy changes, permanent deletion, and image lifecycle work run through server actions using the Firebase Admin SDK. Those actions verify the caller and current document state inside Firestore transactions. Firestore Security Rules also constrain direct client access; the server and Rules must be deployed together when their contract changes.

Images live in S3. The application creates scoped upload requests and serves document images through an authorized route. Document and Space deletion clean up their associated images in bounded, retryable steps so a partial failure can be resumed. The implementation separates temporary uploads, active images, and images belonging to deleted documents.

### Engineering notes

- **Concurrent edits:** Document content saves use revision checks, so an older editor view cannot silently overwrite a newer save.
- **Hierarchy integrity:** Server transactions recheck ownership, parent state, and document ancestry while moving or changing lifecycle state.
- **Recoverable cleanup:** Permanent Space deletion works through bounded steps. Removed-image cleanup records and claims pending keys before deleting S3 objects, then reconciles the result with Firestore.

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

Set the same environment variables in your application host and deploy the app and `firestore.rules` as a coordinated change. The current Rules restrict direct client writes to existing document content; an older app build cannot perform saves after those Rules are deployed. Deploy Firestore indexes when required by your queries. Use a separate Firebase project and S3 bucket for non-production environments.

## Repository layout

- `app/`: routes, layouts, and the document image API
- `components/`: editor, navigation, dialogs, and UI components
- `lib/actions/`: document, Space, and S3 operations
- `lib/server/`: Firebase Admin initialization and server authorization
- `lib/__tests__/`: unit tests and Firestore Rules emulator tests
- `firestore.rules` and `firestore.indexes.json`: Firestore access and indexes

## License

Docula is licensed under the [MIT License](LICENSE). Copyright (c) 2026 Vesa Malaska.

If you fork Docula, a link back to the [original project](https://github.com/VesaMalaska/docula) is appreciated. The MIT license requires retaining its copyright and permission notice in redistributed copies; it does not require a link or an in-app credit.
