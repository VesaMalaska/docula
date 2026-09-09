"use client";

import { useAuth } from "@/components/providers/auth-provider";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useState, useRef, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { Header } from "@/components/header";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  getSidebarInertState,
  restoreFocusToTrigger,
  handleDesktopToMobileTransition,
} from "@/lib/sidebar-focus";

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const sidebarContainerRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const pendingRestoreFocusRef = useRef(false);
  const prevIsSidebarOpenRef = useRef(isSidebarOpen);

  const handleMediaQueryChange = useCallback((matches: boolean) => {
    if (matches) {
      // Transitioned to desktop
      setIsSidebarOpen(false);
    } else {
      // Transitioned to mobile
      const isFocusedInSidebar = Boolean(
        sidebarContainerRef.current &&
          document.activeElement &&
          sidebarContainerRef.current.contains(document.activeElement)
      );
      handleDesktopToMobileTransition({
        isFocusedInSidebar,
        trigger: menuButtonRef.current,
      });
    }
  }, []);

  const isDesktop = useMediaQuery("(min-width: 1024px)", handleMediaQueryChange);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  const { isSidebarInert, isContentInert } = getSidebarInertState({
    isDesktop,
    isSidebarOpen,
  });

  const handleOpenSidebar = useCallback(() => {
    setIsSidebarOpen(true);
  }, []);

  const handleCloseSidebar = useCallback(
    ({ returnFocus = true }: { returnFocus?: boolean } = {}) => {
      if (returnFocus) {
        pendingRestoreFocusRef.current = true;
      }
      setIsSidebarOpen(false);
    },
    []
  );

  // Coordinate focus transitions after inert state changes are committed
  useIsomorphicLayoutEffect(() => {
    const wasOpen = prevIsSidebarOpenRef.current;
    prevIsSidebarOpenRef.current = isSidebarOpen;

    if (!wasOpen && isSidebarOpen) {
      // Transitioned from closed to open:
      // Sidebar is now non-inert, background content is inert.
      // Move focus to the visible close control for all activations.
      closeButtonRef.current?.focus();
    } else if (wasOpen && !isSidebarOpen) {
      // Transitioned from open to closed:
      // Background content is now non-inert, sidebar is inert.
      // Restore focus to the connected hamburger button if an explicit dismissal requested it.
      if (pendingRestoreFocusRef.current) {
        pendingRestoreFocusRef.current = false;
        restoreFocusToTrigger(menuButtonRef.current);
      }
    }
  }, [isSidebarOpen]);

  const handleSidebarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      handleCloseSidebar({ returnFocus: true });
    }
  };

  if (loading || !user) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      {/* Mobile Sidebar Overlay */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/50 transition-opacity lg:hidden",
          isSidebarOpen
            ? "opacity-100"
            : "opacity-0 pointer-events-none",
        )}
        onClick={() => handleCloseSidebar({ returnFocus: true })}
      />

      <div
        ref={sidebarContainerRef}
        inert={isSidebarInert || undefined}
        aria-hidden={isSidebarInert || undefined}
        onKeyDown={handleSidebarKeyDown}
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 xl:w-[296px] 2xl:w-96 transform transition-transform lg:static lg:translate-x-0",
          isSidebarOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <Sidebar
          onClose={handleCloseSidebar}
          closeButtonRef={closeButtonRef}
        />
      </div>

      <div
        className="flex flex-1 flex-col overflow-hidden"
        inert={isContentInert || undefined}
      >
        <Header
          menuButtonRef={menuButtonRef}
          isSidebarOpen={isSidebarOpen}
          onMenuClick={handleOpenSidebar}
        />
        <main className="flex-1 overflow-y-auto pb-4 md:pb-8">
          {children}
        </main>
      </div>
    </div>
  );
}
