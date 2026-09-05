"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, UserPlus, Check } from "lucide-react";
import { collection, query, where, getDocs, doc, updateDoc, arrayUnion } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useMutation, useQueryClient } from "@tanstack/react-query";

interface InviteMemberDialogProps {
    spaceId: string;
    currentMembers: string[];
}

export function InviteMemberDialog({ spaceId, currentMembers }: InviteMemberDialogProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [email, setEmail] = useState("");
    const [status, setStatus] = useState<"idle" | "searching" | "success" | "error">("idle");
    const [errorMessage, setErrorMessage] = useState("");

    const queryClient = useQueryClient();

    const invite = async () => {
        if (!email) return;
        setStatus("searching");
        setErrorMessage("");

        try {
            // 1. Find user by email
            const q = query(collection(db, "users"), where("email", "==", email));
            const snapshot = await getDocs(q);

            if (snapshot.empty) {
                setStatus("error");
                setErrorMessage("User not found. They must sign up first.");
                return;
            }

            const userDoc = snapshot.docs[0];
            const userId = userDoc.id;

            if (currentMembers.includes(userId)) {
                setStatus("error");
                setErrorMessage("User is already a member.");
                return;
            }

            // 2. Add to space
            await updateDoc(doc(db, "spaces", spaceId), {
                userIds: arrayUnion(userId)
            });

            setStatus("success");
            setEmail("");
            queryClient.invalidateQueries({ queryKey: ["user-spaces"] }); // Update sidebar if needed (though this affects other user)
            
            setTimeout(() => {
                setIsOpen(false);
                setStatus("idle");
                // Refresh parent page to show new member
                window.location.reload(); 
            }, 1000);

        } catch (e) {
            console.error(e);
            setStatus("error");
            setErrorMessage("Failed to add member.");
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
                <Button size="sm" variant="outline" className="gap-2">
                    <UserPlus className="h-4 w-4" /> Invite
                </Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Invite Member</DialogTitle>
                    <DialogDescription>
                        Add a user to this space by their email address.
                    </DialogDescription>
                </DialogHeader>
                
                <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                        <Label htmlFor="email">Email Address</Label>
                        <Input 
                            id="email" 
                            type="email" 
                            placeholder="colleague@example.com" 
                            value={email} 
                            onChange={(e) => setEmail(e.target.value)}
                        />
                    </div>
                    {status === "error" && (
                         <p className="text-sm text-destructive">{errorMessage}</p>
                    )}
                    {status === "success" && (
                         <p className="text-sm text-green-700 dark:text-green-400 flex items-center gap-2"><Check className="h-4 w-4" /> Member added!</p>
                    )}
                </div>

                <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setIsOpen(false)}>Cancel</Button>
                    <Button onClick={invite} disabled={status === "searching" || status === "success" || !email}>
                        {status === "searching" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Add Member
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
