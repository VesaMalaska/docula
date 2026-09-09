import Link from "next/link";
import { FolderX, FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getUnavailableStateConfig } from "@/lib/member-management";

export interface UnavailableStateProps {
  type?: "space" | "document" | "generic";
  customTitle?: string;
  customDescription?: string;
}

export function UnavailableState({
  type = "space",
  customTitle,
  customDescription,
}: UnavailableStateProps) {
  const config = getUnavailableStateConfig(type);
  const title = customTitle || config.title;
  const description = customDescription || config.description;
  const isDocument = type === "document";
  const Icon = isDocument ? FileQuestion : FolderX;

  return (
    <section
      aria-labelledby="unavailable-heading"
      className="flex flex-col items-center justify-center min-h-[60vh] px-4 py-12 text-center max-w-md mx-auto"
    >
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted/60 mb-6 ring-1 ring-border/50">
        <Icon className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      </div>

      <h1
        id="unavailable-heading"
        className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-3"
      >
        {title}
      </h1>

      <p className="text-muted-foreground text-sm sm:text-base leading-relaxed mb-8 max-w-sm">
        {description}
      </p>

      <div className="flex flex-col sm:flex-row items-center gap-3 w-full sm:w-auto">
        <Button asChild className="w-full sm:w-auto min-w-[130px]">
          <Link href="/">Go to Home</Link>
        </Button>
        <Button
          asChild
          variant="outline"
          className="w-full sm:w-auto min-w-[130px]"
        >
          <Link href="/trash">Open Trash</Link>
        </Button>
      </div>
    </section>
  );
}
