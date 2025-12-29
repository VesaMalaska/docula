# Project Nexus Roadmap

## Phase 1: Skeleton & Auth
- [x] **Project Setup**
  - [x] Verify/Install dependencies (`firebase`, `lucide-react`, `clsx`, `tailwind-merge`).
  - [x] Initialize Shadcn UI (or compatible base components).
  - [x] Configure Tailwind CSS & Theme Provider (Dark/Light mode).
- [x] **Firebase Integration**
  - [x] Create `lib/firebase.ts` client config.
  - [x] Create `lib/firebase-admin.ts` (if needed for server actions) or use Client SDK for MVP if applicable, though Server Actions + Admin SDK is safer for "All-Admin" policy enforcement.
- [x] **Authentication**
  - [x] Implement `AuthContext` or Provider.
  - [x] Create Login Page (`/login`).
  - [x] Implement Route Protection (Middleware or Layout check).
  - [x] Display User Avatar/Profile in Sidebar.
- [x] **Layout Architecture**
  - [x] Create Main App Layout (Sidebar + Content Area).
  - [x] Implement Breadcrumbs component.

## Phase 2: CRUD & Hierarchy
- [x] **Database & Actions**
  - [x] Define Firestore Schema (Types).
  - [x] Implement `actions/document.ts` (`createDocument`, `getDocument`, `getSidebarTree`, `updateDocument`).
- [x] **Sidebar Navigation**
  - [x] Create Recursive Tree Component.
  - [x] Implement Expand/Collapse state persistence.
- [x] **Editor Implementation**
  - [x] Install Tiptap dependencies.
  - [x] Create `Editor` component with minimal toolbar (Bold, Italic, Code, Heading).
  - [x] Connect Editor to `getDocument` (Load) and `updateDocument` (Save).
- [x] **Document Operations**
  - [x] Implement "Create Child Page" functionality.
  - [x] Implement "Delete Page" (Soft delete).
  - [x] Implement "Move/Reparent" (Basic settings modal).

## Phase 3: Locking Mechanism (Concurrency)
- [x] **Locking Logic**
  - [x] Implement `actions/locking.ts` (`acquireLock`, `renewLock`, `releaseLock`).
  - [x] Update `getDocument` to return lock status.
- [x] **UI Feedback**
  - [x] Add "Locked by [User]" banner/alert.
  - [x] Disable Editor if locked by another user.
- [x] **Heartbeat**
  - [x] Implement `useHeartbeat` hook to renew lock every 4 mins.
  - [x] Handle window close/unload to release lock.

## Phase 4: S3 & Backlinks (Networked Thought)
- [x] **Image Upload (S3)**
  - [x] Implement `actions/s3.ts` (`getPresignedUrl`).
  - [x] Add Drag & Drop image handler to Tiptap.
- [x] **Backlinks System**
  - [x] Implement Link Parsing logic in `saveDocument` action.
  - [x] Implement "Linked to by" footer section.
  - [x] Update Transaction logic to handle `backlinks` array updates on target documents.

## Phase 5: Polish & Refinement
- [ ] **Performance Tuning**
  - [ ] Optimize Sidebar loading (Caching?).
- [ ] **UI Polish**
  - [ ] Review Loading states/Skeletons.
  - [ ] Ensure Mobile responsiveness (basic).
