export interface DropdownDialogHandoffOptions<T> {
  pendingAction: T | null;
  trigger: HTMLElement | null;
  event: { preventDefault: () => void };
  onOpenDialog: (action: T) => void;
  returnFocusRef?: { current: HTMLElement | null } | null;
}

/**
 * Safely coordinates the focus handoff and deferred dialog opening when transitioning
 * from a Radix dropdown menu to a modal dialog.
 *
 * Ensures that the dropdown menu closes completely and focus is handed off to the
 * trigger before the dialog assumes modal control. This prevents Radix modal-layer
 * collisions and stale `pointer-events: none` on document.body.
 */
export function handleDropdownDialogHandoff<T>({
  pendingAction,
  trigger,
  event,
  onOpenDialog,
  returnFocusRef,
}: DropdownDialogHandoffOptions<T>): boolean {
  if (!pendingAction) {
    return false;
  }

  if (trigger && trigger.isConnected) {
    event.preventDefault();
    trigger.focus();
    if (returnFocusRef) {
      returnFocusRef.current = trigger;
    }
  }

  onOpenDialog(pendingAction);
  return true;
}

export interface DialogCloseFocusOptions {
  isMoveSuccessful: boolean;
  hasContainer: boolean;
  containerConnected: boolean;
  targetConnected: boolean;
}

export type DialogCloseFocusAction =
  | { type: "focus-container"; preventDefault: true }
  | { type: "focus-target"; preventDefault: true }
  | { type: "none"; preventDefault: false };

/**
 * Pure decision function determining the focus restoration target upon dialog closure.
 *
 * - When a move succeeded and a connected container exists (e.g. sidebar tree),
 *   interim focus goes to the container while tree refresh and expansion take over.
 * - In all other cases with a connected target (cancellation, escape, close button,
 *   or successful move without a container as in the document header), focus returns
 *   to the trigger target.
 */
export function determineDialogCloseFocusAction({
  isMoveSuccessful,
  hasContainer,
  containerConnected,
  targetConnected,
}: DialogCloseFocusOptions): DialogCloseFocusAction {
  if (isMoveSuccessful && hasContainer && containerConnected) {
    return { type: "focus-container", preventDefault: true };
  }
  if (targetConnected) {
    return { type: "focus-target", preventDefault: true };
  }
  return { type: "none", preventDefault: false };
}
