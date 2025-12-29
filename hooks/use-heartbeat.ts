import { useEffect } from "react";
import { renewLock } from "@/lib/actions/locking";

export function useHeartbeat(docId: string, isEditing: boolean, userId?: string) {
    useEffect(() => {
        if (!isEditing || !userId) return;

        const interval = setInterval(() => {
            renewLock(docId, userId);
        }, 1000 * 60 * 4); // 4 minutes

        return () => clearInterval(interval);
    }, [docId, isEditing, userId]);
}
