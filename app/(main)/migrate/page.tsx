"use client";

import { useState, useEffect } from "react";
import { db } from "@/lib/firebase";
import { collection, getDocs, doc, setDoc, updateDoc, deleteField } from "firebase/firestore";
import { useAuth } from "@/components/providers/auth-provider";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

export default function MigratePage() {
  const { user, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ success: boolean; migrated?: number; skipped?: number; error?: string } | null>(null);

  async function handleMigrate() {
    if (!user) return;
    setLoading(true);
    setResult(null);
    try {
      const docsSnap = await getDocs(collection(db, "documents"));
      let migratedCount = 0;
      let skippedCount = 0;
      
      for (const document of docsSnap.docs) {
        const data = document.data();
        if (data.content !== undefined) {
          // 1. Write to subcollection
          const contentRef = doc(db, "documents", document.id, "content", "main");
          await setDoc(contentRef, { content: data.content });
          
          // 2. Remove from main document
          const docRef = doc(db, "documents", document.id);
          await updateDoc(docRef, { content: deleteField() });
          
          migratedCount++;
        } else {
          skippedCount++;
        }
      }

      setResult({ success: true, migrated: migratedCount, skipped: skippedCount });
    } catch (error: any) {
      console.error("Migration error:", error);
      setResult({ success: false, error: error.message || String(error) });
    } finally {
      setLoading(false);
    }
  }

  if (authLoading) {
     return <div className="p-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  if (!user) {
    return <div className="p-12 text-center text-muted-foreground">Please log in to run the migration.</div>;
  }

  return (
    <div className="max-w-xl mx-auto p-12 space-y-6">
      <h1 className="text-2xl font-bold">Migration: Content Subcollection</h1>
      <p className="text-muted-foreground">
        This will migrate the content of all existing documents into the new nested subcollections, greatly improving load times for the sidebar.
        You only need to run this once.
      </p>

      {result && (
        <div className={`p-4 rounded-md ${result.success ? "bg-green-100 text-green-900" : "bg-red-100 text-red-900"}`}>
          {result.success ? (
            <p><strong>Success!</strong> Migrated {result.migrated} documents. (Skipped {result.skipped} already migrated).</p>
          ) : (
            <p><strong>Error:</strong> {result.error}</p>
          )}
        </div>
      )}

      <Button onClick={handleMigrate} disabled={loading}>
        {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {loading ? "Migrating..." : "Start Migration"}
      </Button>
    </div>
  );
}
