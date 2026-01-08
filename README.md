# Docula

**Docula** is a lightweight, high-performance documentation platform designed for engineering teams. It combines the structured organization of a traditional wiki with the networked thought capabilities of tools like Obsidian.

Built with a philosophy of **"Speed and Solidity,"** Docula prioritizes sub-second load times and rigid data integrity through document locking, ensuring a seamless and conflict-free writing experience.

## 🚀 Key Features

- **Hybrid Navigation:** Organize content hierarchically with infinite nesting while leveraging bi-directional backlinks to discover related documents.
- **Concurrency Control:** Heartbeat-based document locking prevent overwrite conflicts. If a teammate is editing, the document is locked for them.
- **High-Performance Editor:** Powered by Tiptap, supporting Markdown shortcuts, code blocks, and resizable images.
- **Image Optimization:** Automatic conversion of uploaded images to WebP and intelligent resizing to ensure performance and storage efficiency.
- **Trash & Recovery:** Secure soft-delete mechanism for documents and associated images, allowing for easy restoration.
- **Instant Search & Access:** Fast client-side search and quick navigation.
- **Modern UI:** Clean, dark/light mode supported interface built with Shadcn/UI and TailwindCSS 4.

## 🛠 Tech Stack

- **Framework:** Next.js 16.1 (App Router)
- **Language:** TypeScript
- **Frontend:** React 19.2, TailwindCSS 4, Shadcn/UI, Lucide Icons
- **State Management:** TanStack Query (Server State)
- **Editor:** Tiptap (Headless)
- **Backend:** Firebase Authentication, Firestore
- **Storage:** AWS S3 (with Presigned URLs and Soft-Delete Support)
- **Deployment:** Vercel

## 📦 Getting Started

### Prerequisites

- Node.js 18+
- pnpm

### Installation

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/your-org/docula.git
    cd docula
    ```

2.  **Install dependencies:**

    ```bash
    pnpm install
    ```

3.  **Environment Setup:**
    Create a `.env.local` file in the root directory and add your Firebase and AWS credentials:

    ```env
    # Firebase
    NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
    NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
    NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id

    # AWS S3 (For Images)
    AWS_REGION=your_aws_region
    AWS_ACCESS_KEY_ID=your_access_key
    AWS_SECRET_ACCESS_KEY=your_secret_key
    AWS_BUCKET_NAME=your_bucket_name
    ```

4.  **Run the development server:**

    ```bash
    pnpm dev
    ```

    Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## 📂 Project Structure

- `/app`: Next.js App Router pages and layouts. Includes `(main)` group for the core application.
- `/components`: Reusable UI components and feature-specific components (Editor, Sidebar, Header, etc.).
- `/lib`: Core logic, including server actions (`/actions`), Firebase config, types, and utility functions.
- `/hooks`: Custom React hooks, such as `useHeartbeat` for document locking.
- `/public`: Static assets.

## 🤝 Contributing

1.  Fork the repository.
2.  Create a feature branch (`git checkout -b feature/amazing-feature`).
3.  Commit your changes (`git commit -m 'Add some amazing feature'`).
4.  Push to the branch (`git push origin feature/amazing-feature`).
5.  Open a Pull Request.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
