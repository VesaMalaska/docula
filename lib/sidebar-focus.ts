export interface SidebarInertState {
  isSidebarInert: boolean;
  isContentInert: boolean;
}

export interface SidebarInertOptions {
  isDesktop: boolean;
  isSidebarOpen: boolean;
}

/**
 * Calculates whether the sidebar and the main content layout should be inert.
 *
 * - On desktop (width >= 1024px): Neither the sidebar nor the content is ever inert.
 * - On mobile (width < 1024px) when sidebar is closed: Sidebar is inert; content is interactive.
 * - On mobile (width < 1024px) when sidebar is open: Sidebar is interactive; content is inert.
 */
export function getSidebarInertState({
  isDesktop,
  isSidebarOpen,
}: SidebarInertOptions): SidebarInertState {
  if (isDesktop) {
    return {
      isSidebarInert: false,
      isContentInert: false,
    };
  }

  return {
    isSidebarInert: !isSidebarOpen,
    isContentInert: isSidebarOpen,
  };
}

/**
 * Safely attempts to dispatch keyboard focus to a trigger element if it is mounted and connected.
 * If the trigger is absent or disconnected, safely attempts the fallback element.
 *
 * Note: A return value of `true` indicates that .focus() was safely invoked on a connected DOM node.
 * It does not guarantee that the element successfully acquired focus (for instance, if an ancestor
 * is currently inert or the element cannot receive focus). The caller is responsible for ensuring
 * the target's containing subtree is non-inert before attempting focus.
 */
export function restoreFocusToTrigger(
  trigger?: HTMLElement | null,
  fallback?: HTMLElement | null
): boolean {
  if (trigger && typeof trigger.focus === "function" && trigger.isConnected) {
    trigger.focus();
    return true;
  }

  if (fallback && typeof fallback.focus === "function" && fallback.isConnected) {
    fallback.focus();
    return true;
  }

  return false;
}

export interface DesktopToMobileTransitionOptions {
  isFocusedInSidebar: boolean;
  trigger?: HTMLElement | null;
  fallback?: HTMLElement | null;
}

/**
 * Safely evacuates keyboard focus when transitioning from desktop width to mobile width
 * while the mobile sidebar is closed. If focus was inside the sidebar, moves focus to the
 * visible trigger (or fallback) before the sidebar becomes inert.
 */
export function handleDesktopToMobileTransition({
  isFocusedInSidebar,
  trigger,
  fallback,
}: DesktopToMobileTransitionOptions): boolean {
  if (isFocusedInSidebar) {
    return restoreFocusToTrigger(trigger, fallback);
  }

  return false;
}
