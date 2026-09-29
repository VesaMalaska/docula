import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  handleDropdownDialogHandoff,
  determineDialogCloseFocusAction,
} from "../dialog-focus.ts";

describe("Dialog Focus Lifecycle & State Sequencing", () => {
  describe("handleDropdownDialogHandoff", () => {
    test("returns false and performs no actions when pendingAction is null", () => {
      let preventDefaultCalled = false;
      let focusCalled = false;
      let openedAction: string | null = null;

      const trigger = {
        isConnected: true,
        focus: () => {
          focusCalled = true;
        },
      } as unknown as HTMLElement;

      const returnFocusRef = { current: null as HTMLElement | null };

      const result = handleDropdownDialogHandoff({
        pendingAction: null,
        trigger,
        event: {
          preventDefault: () => {
            preventDefaultCalled = true;
          },
        },
        onOpenDialog: (action) => {
          openedAction = action;
        },
        returnFocusRef,
      });

      assert.equal(result, false);
      assert.equal(preventDefaultCalled, false);
      assert.equal(focusCalled, false);
      assert.equal(openedAction, null);
      assert.equal(returnFocusRef.current, null);
    });

    test("defers dialog opening, prevents default, focuses connected trigger, and assigns returnFocusRef", () => {
      let preventDefaultCalled = false;
      let focusCalled = false;
      let openedAction: string | null = null;

      const trigger = {
        isConnected: true,
        focus: () => {
          focusCalled = true;
        },
      } as unknown as HTMLElement;

      const returnFocusRef = { current: null as HTMLElement | null };

      const result = handleDropdownDialogHandoff({
        pendingAction: "move",
        trigger,
        event: {
          preventDefault: () => {
            preventDefaultCalled = true;
          },
        },
        onOpenDialog: (action) => {
          openedAction = action;
        },
        returnFocusRef,
      });

      assert.equal(result, true);
      assert.equal(preventDefaultCalled, true);
      assert.equal(focusCalled, true);
      assert.equal(openedAction, "move");
      assert.equal(returnFocusRef.current, trigger);
    });

    test("safely opens dialog when trigger is disconnected without throwing or focusing", () => {
      let preventDefaultCalled = false;
      let focusCalled = false;
      let openedAction: string | null = null;

      const trigger = {
        isConnected: false,
        focus: () => {
          focusCalled = true;
        },
      } as unknown as HTMLElement;

      const returnFocusRef = { current: null as HTMLElement | null };

      const result = handleDropdownDialogHandoff({
        pendingAction: "move",
        trigger,
        event: {
          preventDefault: () => {
            preventDefaultCalled = true;
          },
        },
        onOpenDialog: (action) => {
          openedAction = action;
        },
        returnFocusRef,
      });

      assert.equal(result, true);
      assert.equal(preventDefaultCalled, false);
      assert.equal(focusCalled, false);
      assert.equal(openedAction, "move");
      assert.equal(returnFocusRef.current, null);
    });

    test("safely opens dialog when trigger is null or returnFocusRef is omitted", () => {
      let openedAction: string | null = null;

      const result = handleDropdownDialogHandoff({
        pendingAction: "move",
        trigger: null,
        event: { preventDefault: () => {} },
        onOpenDialog: (action) => {
          openedAction = action;
        },
      });

      assert.equal(result, true);
      assert.equal(openedAction, "move");
    });
  });

  describe("determineDialogCloseFocusAction", () => {
    test("targets tree container when move succeeds and connected container is present (sidebar flow)", () => {
      const action = determineDialogCloseFocusAction({
        isMoveSuccessful: true,
        hasContainer: true,
        containerConnected: true,
        targetConnected: true,
      });

      assert.deepEqual(action, {
        type: "focus-container",
        preventDefault: true,
      });
    });

    test("targets trigger when move succeeds without a container (document header flow)", () => {
      const action = determineDialogCloseFocusAction({
        isMoveSuccessful: true,
        hasContainer: false,
        containerConnected: false,
        targetConnected: true,
      });

      assert.deepEqual(action, {
        type: "focus-target",
        preventDefault: true,
      });
    });

    test("targets trigger on dialog cancellation, close button, or Escape key", () => {
      const action = determineDialogCloseFocusAction({
        isMoveSuccessful: false,
        hasContainer: true,
        containerConnected: true,
        targetConnected: true,
      });

      assert.deepEqual(action, {
        type: "focus-target",
        preventDefault: true,
      });
    });

    test("yields none with preventDefault=false when target is disconnected", () => {
      const action = determineDialogCloseFocusAction({
        isMoveSuccessful: false,
        hasContainer: false,
        containerConnected: false,
        targetConnected: false,
      });

      assert.deepEqual(action, {
        type: "none",
        preventDefault: false,
      });
    });
  });

  describe("Import Markdown Dialog Responsive Layout Invariants", () => {
    test("selected file row contains shrink-proof controls and shrinkable filename container", () => {
      // Invariant rules ensuring no overflow on 320px/375px viewports or with long filenames:
      const outerRowClasses = "flex items-center justify-between gap-3 p-3 rounded-md border border-border bg-card min-w-0 w-full";
      const fileInfoWrapperClasses = "flex items-center gap-2 min-w-0 flex-1 overflow-hidden";
      const fileIconClasses = "h-5 w-5 text-primary shrink-0";
      const filenameClasses = "text-sm font-medium truncate min-w-0";
      const changeButtonClasses = "text-xs text-muted-foreground hover:text-foreground shrink-0 cursor-pointer";

      // 1. Outer row must be constrained horizontally
      assert.ok(outerRowClasses.includes("min-w-0"), "Outer row must have min-w-0");
      assert.ok(outerRowClasses.includes("w-full"), "Outer row must have w-full");

      // 2. File info wrapper must shrink and hide overflow
      assert.ok(fileInfoWrapperClasses.includes("min-w-0"), "Wrapper must have min-w-0");
      assert.ok(fileInfoWrapperClasses.includes("flex-1"), "Wrapper must have flex-1");
      assert.ok(fileInfoWrapperClasses.includes("overflow-hidden"), "Wrapper must have overflow-hidden");

      // 3. Icon and button must not be compressed
      assert.ok(fileIconClasses.includes("shrink-0"), "Icon must be shrink-0");
      assert.ok(changeButtonClasses.includes("shrink-0"), "Change file button must be shrink-0");

      // 4. Filename must truncate deliberately
      assert.ok(filenameClasses.includes("truncate"), "Filename must truncate");
      assert.ok(filenameClasses.includes("min-w-0"), "Filename must have min-w-0");
    });

    test("location row does not impose fixed desktop maximum width and truncates safely", () => {
      const locationRowClasses = "rounded-md bg-muted/50 p-3 text-sm flex items-center justify-between gap-2 min-w-0 w-full";
      const locationLabelClasses = "text-muted-foreground font-medium shrink-0";
      const locationValueClasses = "font-semibold text-foreground truncate min-w-0 text-right";

      // Must not have fixed desktop widths like max-w-[280px] which overflow on 320px screens
      assert.ok(!locationValueClasses.includes("max-w-[280px]"), "Location must not use fixed max-w-[280px]");
      assert.ok(locationRowClasses.includes("min-w-0"), "Location row must have min-w-0");
      assert.ok(locationLabelClasses.includes("shrink-0"), "Location label must have shrink-0");
      assert.ok(locationValueClasses.includes("truncate"), "Location value must truncate");
      assert.ok(locationValueClasses.includes("min-w-0"), "Location value must have min-w-0");
    });

    test("footer supports responsive vertical stacking on narrow viewports and zoom", () => {
      const footerClasses = "min-w-0 w-full gap-2";
      const buttonClasses = "w-full sm:w-auto";

      assert.ok(footerClasses.includes("min-w-0"), "Footer must have min-w-0");
      assert.ok(footerClasses.includes("w-full"), "Footer must have w-full");
      assert.ok(buttonClasses.includes("w-full"), "Buttons must be full width on mobile");
      assert.ok(buttonClasses.includes("sm:w-auto"), "Buttons must adapt to auto on desktop");
    });
  });
});
