import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  getSidebarInertState,
  restoreFocusToTrigger,
  handleDesktopToMobileTransition,
} from "../sidebar-focus.ts";

describe("Sidebar Responsive Inert & Focus Lifecycle", () => {
  describe("getSidebarInertState", () => {
    test("closed mobile sidebar receives inert state; content remains interactive", () => {
      const state = getSidebarInertState({
        isDesktop: false,
        isSidebarOpen: false,
      });
      assert.deepEqual(state, {
        isSidebarInert: true,
        isContentInert: false,
      });
    });

    test("open mobile sidebar removes inert from sidebar; marks background content inert", () => {
      const state = getSidebarInertState({
        isDesktop: false,
        isSidebarOpen: true,
      });
      assert.deepEqual(state, {
        isSidebarInert: false,
        isContentInert: true,
      });
    });

    test("desktop sidebar is never inert when closed", () => {
      const state = getSidebarInertState({
        isDesktop: true,
        isSidebarOpen: false,
      });
      assert.deepEqual(state, {
        isSidebarInert: false,
        isContentInert: false,
      });
    });

    test("desktop sidebar is never inert when open", () => {
      const state = getSidebarInertState({
        isDesktop: true,
        isSidebarOpen: true,
      });
      assert.deepEqual(state, {
        isSidebarInert: false,
        isContentInert: false,
      });
    });
  });

  describe("restoreFocusToTrigger", () => {
    test("dispatches focus call to connected trigger element", () => {
      let focusCalled = false;
      const trigger = {
        isConnected: true,
        focus: () => {
          focusCalled = true;
        },
      } as unknown as HTMLElement;

      const result = restoreFocusToTrigger(trigger);
      assert.equal(result, true);
      assert.equal(focusCalled, true);
    });

    test("does not dispatch focus on disconnected trigger; falls back to connected fallback element", () => {
      let triggerFocusCalled = false;
      let fallbackFocusCalled = false;

      const disconnectedTrigger = {
        isConnected: false,
        focus: () => {
          triggerFocusCalled = true;
        },
      } as unknown as HTMLElement;

      const connectedFallback = {
        isConnected: true,
        focus: () => {
          fallbackFocusCalled = true;
        },
      } as unknown as HTMLElement;

      const result = restoreFocusToTrigger(disconnectedTrigger, connectedFallback);
      assert.equal(result, true);
      assert.equal(triggerFocusCalled, false);
      assert.equal(fallbackFocusCalled, true);
    });

    test("safely returns false without throwing when trigger and fallback are null or undefined", () => {
      assert.equal(restoreFocusToTrigger(null), false);
      assert.equal(restoreFocusToTrigger(undefined), false);
      assert.equal(restoreFocusToTrigger(null, null), false);
    });

    test("safely returns false when both trigger and fallback are disconnected", () => {
      const trigger = { isConnected: false, focus: () => {} } as unknown as HTMLElement;
      const fallback = { isConnected: false, focus: () => {} } as unknown as HTMLElement;

      assert.equal(restoreFocusToTrigger(trigger, fallback), false);
    });
  });

  describe("handleDesktopToMobileTransition", () => {
    test("evacuates focus to trigger when focus was inside sidebar during desktop-to-mobile resize", () => {
      let focusCalled = false;
      const trigger = {
        isConnected: true,
        focus: () => {
          focusCalled = true;
        },
      } as unknown as HTMLElement;

      const result = handleDesktopToMobileTransition({
        isFocusedInSidebar: true,
        trigger,
      });

      assert.equal(result, true);
      assert.equal(focusCalled, true);
    });

    test("does not move focus when focus was outside sidebar during resize", () => {
      let focusCalled = false;
      const trigger = {
        isConnected: true,
        focus: () => {
          focusCalled = true;
        },
      } as unknown as HTMLElement;

      const result = handleDesktopToMobileTransition({
        isFocusedInSidebar: false,
        trigger,
      });

      assert.equal(result, false);
      assert.equal(focusCalled, false);
    });

    test("safely handles disconnected trigger during desktop-to-mobile resize", () => {
      const disconnectedTrigger = {
        isConnected: false,
        focus: () => {},
      } as unknown as HTMLElement;

      const result = handleDesktopToMobileTransition({
        isFocusedInSidebar: true,
        trigger: disconnectedTrigger,
      });

      assert.equal(result, false);
    });
  });
});
