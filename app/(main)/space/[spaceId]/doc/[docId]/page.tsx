"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getDocument,
  updateDocument,
  getSidebarTree,
} from "@/lib/actions/document";
import { acquireLock, releaseLock } from "@/lib/actions/locking";
import { permanentizeImages, deleteImages } from "@/lib/actions/s3";
import { useHeartbeat } from "@/hooks/use-heartbeat";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { Editor } from "@/components/editor";
import { useState, useEffect, useRef } from "react";
import { Loader2, Save, Edit2, AlertCircle } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import Link from "next/link";
import { SidebarNode } from "@/lib/types";
import {
  cn,
  extractImageUrls,
  replaceImageUrls,
  stripImageParams,
} from "@/lib/utils";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Download } from "lucide-react";
import { jsonToMarkdown } from "@/lib/markdown-converter";
import { jsonToDocx } from "@/lib/docx-converter";

function BacklinksList({
  docIds,
  spaceId,
}: {
  docIds: string[];
  spaceId: string;
}) {
  const { data: tree } = useQuery({
    queryKey: ["sidebar-tree", spaceId],
    queryFn: () => getSidebarTree(spaceId),
  });

  const findTitle = (id: string, nodes: SidebarNode[]): string | null => {
    for (const node of nodes) {
      if (node.id === id) return node.title;
      if (node.children) {
        const found = findTitle(id, node.children);
        if (found) return found;
      }
    }
    return null;
  };

  if (!tree)
    return (
      <div className="text-gray-400 dark:text-zinc-500 text-xs">
        Loading links...
      </div>
    );

  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {docIds.map((id) => {
        const title = findTitle(id, tree) || "Unknown Doc";
        return (
          <Link
            key={id}
            href={`/space/${spaceId}/doc/${id}`}
            className="bg-gray-100 dark:bg-zinc-800 px-2 py-1 rounded text-xs hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-700 dark:text-zinc-300 transition-colors cursor-pointer"
          >
            {title}
          </Link>
        );
      })}
    </div>
  );
}

function DocSkeleton() {
  return (
    <div className="mx-auto max-w-4xl px-4 md:px-8 pt-4 md:pt-8">
      <div className="flex items-center gap-2 mb-4">
        <Skeleton className="h-4 w-4" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-16" />
      </div>
      <div className="mb-6 border-b dark:border-zinc-800 pb-4 flex justify-between items-center">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-8 w-20" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-4/6" />
        <Skeleton className="h-64 w-full mt-8" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </div>
  );
}

export default function DocPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const spaceId = params.spaceId as string;
  const id = params.docId as string;
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [isEditing, setIsEditing] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [content, setContent] = useState<any>(null);
  const [title, setTitle] = useState("");
  const [sessionImages, setSessionImages] = useState<string[]>([]);

  const isEditingRef = useRef(false);
  const sessionImagesRef = useRef<string[]>([]);

  const { data: doc, isLoading } = useQuery({
    queryKey: ["doc", id],
    queryFn: () => getDocument(id),
  });

  useEffect(() => {
    if (doc) {
      if (!isEditing) {
        setContent(doc.content);
        setTitle(doc.title);
        setSessionImages([]);
        sessionImagesRef.current = [];
      }
    }
  }, [doc, isEditing]);

  useEffect(() => {
    isEditingRef.current = isEditing;
  }, [isEditing]);

  useEffect(() => {
    sessionImagesRef.current = sessionImages;
  }, [sessionImages]);

  useHeartbeat(id, isEditing, user?.uid);

  useEffect(() => {
    if (isLoading || !doc || !sentinelRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsScrolled(!entry.isIntersecting);
      },
      // Give it a tiny root margin negative offset so it triggers right as we scroll
      { threshold: 0, rootMargin: "-1px 0px 0px 0px" },
    );

    observer.observe(sentinelRef.current);

    return () => observer.disconnect();
  }, [isLoading, doc]);

  useEffect(() => {
    return () => {
      if (isEditingRef.current) {
        if (user?.uid) releaseLock(id, user.uid);
        // Delete temp images if navigated away without saving
        if (sessionImagesRef.current.length > 0) {
          deleteImages(sessionImagesRef.current);
        }
      }
    };
  }, [id, user?.uid]);

  const handleEdit = async () => {
    if (!user) return;
    const success = await acquireLock(
      id,
      user.uid,
      user.displayName || user.email || "Unknown",
    );
    if (success) {
      setIsEditing(true);
      queryClient.invalidateQueries({ queryKey: ["doc", id] });
    } else {
      alert(
        "Could not acquire lock. Document is being edited by someone else.",
      );
    }
  };

  useEffect(() => {
    if (
      searchParams?.get("edit") === "true" &&
      user &&
      doc &&
      !isEditingRef.current
    ) {
      const autoEditKey = `auto-edit-${id}`;
      if (!sessionStorage.getItem(autoEditKey)) {
        sessionStorage.setItem(autoEditKey, "true");
        router.replace(`/space/${spaceId}/doc/${id}`);
        // Defer handleEdit to avoid synchronous setState lint warning
        setTimeout(() => {
          handleEdit();
        }, 0);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, user, doc, id, spaceId, router]);

  const handleCancel = async () => {
    setIsEditing(false);
    if (doc) {
      setContent(doc.content);
      setTitle(doc.title);
    }

    // Delete temp images uploaded during this session
    if (sessionImages.length > 0) {
      await deleteImages(sessionImages);
      setSessionImages([]);
    }

    if (user) await releaseLock(id, user.uid);
    queryClient.invalidateQueries({ queryKey: ["doc", id] });
  };

  const handleExport = async (format: "markdown" | "docx" | "pdf") => {
    if (!doc || !doc.content) return;

    let blob: Blob | null = null;
    let extension = "";

    try {
      if (format === "markdown") {
        const contentStr = jsonToMarkdown(doc.content);
        blob = new Blob([contentStr], { type: "text/markdown" });
        extension = "md";
      } else if (format === "docx") {
        blob = await jsonToDocx(doc.content);
        extension = "docx";
      }

      if (!blob) {
        console.error("No blob generated");
        return;
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${doc.title || "document"}.${extension}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Export failed", e);
      alert("Export failed. Please check console.");
    }
  };

  const { mutate: save, isPending: isSaving } = useMutation({
    mutationFn: async () => {
      // 1. Clean content from signed URLs (strip params) to get clean/permanent keys
      let finalContent = stripImageParams(content);

      // 2. Find all images in the CLEAN content (these are now Unsigned URLs)
      const currentImages = extractImageUrls(finalContent);

      // 3. Filter sessionImages to only those still present in content
      const imagesToPermanentize: string[] = [];
      const imagesToDelete: string[] = [];

      // We need to compare "Unsigned Session URL" vs "Unsigned Content URL"
      sessionImages.forEach((signedUrl) => {
        try {
          const urlObj = new URL(signedUrl);
          urlObj.search = "";
          const unsignedUrl = urlObj.toString();

          if (currentImages.includes(unsignedUrl)) {
            // We pass the UNSIGNED URL to permanentizeImages
            // This ensures the mapping keys returned are Unsigned, matching finalContent
            imagesToPermanentize.push(unsignedUrl);
          } else {
            imagesToDelete.push(signedUrl);
          }
        } catch (e) {
          console.error("Invalid session image URL:", signedUrl);
        }
      });

      // 4. Move images from temp to uploads
      if (imagesToPermanentize.length > 0) {
        // permanentizeImages returns { "unsignedTempUrl": "unsignedUploadsUrl" }
        const mapping = await permanentizeImages(imagesToPermanentize);

        // 5. Update content with new URLs
        // Since finalContent has Unsigned URLs, and mapping keys are Unsigned URLs, this works.
        finalContent = replaceImageUrls(finalContent, mapping);
      }

      // 6. Delete images that were uploaded but then removed from editor before saving
      if (imagesToDelete.length > 0) {
        await deleteImages(imagesToDelete);
      }

      await updateDocument(id, {
        title,
        content: finalContent,
      });

      setSessionImages([]);
      if (user) await releaseLock(id, user.uid);
    },
    onSuccess: () => {
      setIsEditing(false);
      queryClient.invalidateQueries({ queryKey: ["doc", id] });
      queryClient.invalidateQueries({ queryKey: ["sidebar-tree", spaceId] });
    },
  });

  if (isLoading) return <DocSkeleton />;
  if (!doc)
    return (
      <div className="p-8 text-gray-500 dark:text-zinc-400">
        Document not found
      </div>
    );

  const isLockedByOther =
    doc.lock?.active &&
    doc.lock.expiresAt.toDate() > new Date() &&
    doc.lock.userId !== user?.uid;

  return (
    <div className="relative w-full">
      <div
        ref={sentinelRef}
        className="absolute top-0 w-full h-1 pointer-events-none"
      />
      <div className="mx-auto max-w-4xl px-4 md:px-8">
        <Breadcrumbs spaceId={spaceId} documentId={doc.id} title={doc.title} />

        {isLockedByOther && (
          <div className="mb-4 rounded-md bg-amber-50 dark:bg-amber-900/20 p-4 border border-amber-200 dark:border-amber-900/30">
            <div className="flex">
              <div className="shrink-0">
                <AlertCircle
                  className="h-5 w-5 text-amber-400 dark:text-amber-500"
                  aria-hidden="true"
                />
              </div>
              <div className="ml-3">
                <h3 className="text-sm font-medium text-amber-800 dark:text-amber-200">
                  Document is locked
                </h3>
                <div className="mt-2 text-sm text-amber-700 dark:text-amber-300">
                  <p>
                    This document is currently being edited by{" "}
                    {doc.lock?.userName}. You can only view it until they release
                    the lock (expires{" "}
                    {doc.lock?.expiresAt.toDate().toLocaleTimeString()}).
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div
        className={cn(
          "w-full bg-gray-50 dark:bg-gray-900 border-b dark:border-zinc-800 transition-all duration-200 z-20",
          isScrolled ? "sticky top-0 shadow-sm" : "relative",
        )}
      >
        <div className="mx-auto max-w-4xl px-4 md:px-8 flex items-center justify-between py-3">
          {isEditing ? (
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={cn(
                "font-bold text-gray-900 dark:text-zinc-100 bg-transparent focus:outline-none w-full mr-4 placeholder-gray-400 dark:placeholder-zinc-600 transition-all duration-200",
                isScrolled ? "text-xl" : "text-3xl",
              )}
              placeholder="Untitled"
            />
          ) : (
            <h1
              className={cn(
                "font-bold text-gray-900 dark:text-zinc-100 transition-all duration-200 transform origin-left",
                isScrolled ? "text-xl" : "text-3xl",
              )}
            >
              {doc.title}
            </h1>
          )}

          <div
            className={cn(
              "flex gap-2 transition-transform duration-200 origin-right",
              isScrolled && "scale-90",
            )}
          >
            {isEditing ? (
              <>
                <button
                  onClick={handleCancel}
                  className="px-3 py-1 text-sm text-gray-600 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={() => save()}
                  disabled={isSaving}
                  className="flex items-center gap-1 rounded bg-indigo-600 dark:bg-indigo-500 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-700 dark:hover:bg-indigo-600 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {isSaving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  Save
                </button>
              </>
            ) : (
              <div className="flex gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="flex items-center gap-1 rounded border dark:border-zinc-700 dark:text-zinc-300 px-3 py-1 text-sm font-medium hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer">
                      <Download className="h-4 w-4" />
                      Export
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => handleExport("markdown")}
                      className="cursor-pointer"
                    >
                      Markdown (.md)
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => handleExport("docx")}
                      className="cursor-pointer"
                    >
                      Word Document (.docx)
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <button
                  onClick={handleEdit}
                  disabled={!!isLockedByOther}
                  className="flex items-center gap-1 rounded border dark:border-zinc-700 dark:text-zinc-300 px-3 py-1 text-sm font-medium hover:bg-gray-50 dark:hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  <Edit2 className="h-4 w-4" />
                  {isLockedByOther ? "Locked" : "Edit"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={cn("min-h-[500px]", isScrolled && "pt-6")}>
        <Editor
          key={doc.id + (isEditing ? "-edit" : "-view")}
          content={content}
          editable={isEditing}
          onChange={setContent}
          onImageUpload={(url) => setSessionImages((prev) => [...prev, url])}
          spaceId={spaceId}
          isScrolled={isScrolled}
        />
      </div>

      <div className="mx-auto max-w-4xl px-4 md:px-8">
        <div className="mt-10 border-t dark:border-zinc-800 pt-4 text-sm text-gray-400 dark:text-zinc-500">
          <p>
            Last updated:{" "}
            {doc.updatedAt?.toDate
              ? doc.updatedAt.toDate().toLocaleString()
              : "Just now"}
          </p>
          <div className="mt-2">
            <span className="font-semibold text-gray-900 dark:text-zinc-200">
              Linked to by:
            </span>
            {doc.backlinks?.length > 0 ? (
              <BacklinksList docIds={doc.backlinks} spaceId={spaceId} />
            ) : (
              " None"
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
