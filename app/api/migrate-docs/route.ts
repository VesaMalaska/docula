import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase';
import { collection, getDocs, doc, setDoc, updateDoc, deleteField } from 'firebase/firestore';

export const dynamic = 'force-dynamic'; // Ensure it's not cached

export async function GET() {
  try {
    const docsSnap = await getDocs(collection(db, 'documents'));
    let migratedCount = 0;
    let skippedCount = 0;
    
    // Process sequentially
    for (const document of docsSnap.docs) {
      const data = document.data();
      if (data.content !== undefined) {
        // 1. Write to subcollection
        const contentRef = doc(db, 'documents', document.id, 'content', 'main');
        await setDoc(contentRef, { content: data.content });
        
        // 2. Remove from main document
        const docRef = doc(db, 'documents', document.id);
        await updateDoc(docRef, {
          content: deleteField()
        });
        
        migratedCount++;
      } else {
        skippedCount++;
      }
    }

    return NextResponse.json({ success: true, migratedCount, skippedCount });
  } catch (error: any) {
    console.error("Migration error:", error);
    return NextResponse.json({ success: false, error: error.message || String(error) }, { status: 500 });
  }
}
