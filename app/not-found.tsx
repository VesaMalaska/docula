import { UnavailableState } from "@/components/unavailable-state";

export default function RootNotFound() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-4">
      <UnavailableState
        type="generic"
        customTitle="Page not found"
        customDescription="The page you are looking for does not exist or has been moved."
      />
    </div>
  );
}
