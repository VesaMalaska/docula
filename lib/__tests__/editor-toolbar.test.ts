import { describe, it } from "node:test";
import assert from "node:assert";
import {
  BLOCK_STYLE_OPTIONS,
  getCurrentBlockStyle,
  applyBlockStyle,
  DEFAULT_TOOLBAR_STATE,
  getToolbarActiveState,
} from "../editor-toolbar-utils.ts";

describe("Editor Toolbar Utilities", () => {
  describe("BLOCK_STYLE_OPTIONS configuration", () => {
    it("defines the expected block style options in order", () => {
      assert.strictEqual(BLOCK_STYLE_OPTIONS.length, 5);
      assert.deepStrictEqual(
        BLOCK_STYLE_OPTIONS.map((opt) => opt.id),
        ["paragraph", "h1", "h2", "h3", "h4"]
      );
      assert.deepStrictEqual(
        BLOCK_STYLE_OPTIONS.map((opt) => opt.label),
        ["Paragraph", "Heading 1", "Heading 2", "Heading 3", "Heading 4"]
      );
      assert.strictEqual(BLOCK_STYLE_OPTIONS[0].level, undefined);
      assert.strictEqual(BLOCK_STYLE_OPTIONS[1].level, 1);
      assert.strictEqual(BLOCK_STYLE_OPTIONS[2].level, 2);
      assert.strictEqual(BLOCK_STYLE_OPTIONS[3].level, 3);
      assert.strictEqual(BLOCK_STYLE_OPTIONS[4].level, 4);
    });
  });

  describe("getCurrentBlockStyle resolution", () => {
    it("returns Paragraph when editor is null or undefined", () => {
      assert.strictEqual(getCurrentBlockStyle(null).id, "paragraph");
      assert.strictEqual(getCurrentBlockStyle(null).label, "Paragraph");
      assert.strictEqual(getCurrentBlockStyle(undefined).id, "paragraph");
    });

    it("resolves Heading 1 correctly", () => {
      const mockEditor = {
        isActive: (name: string, attrs?: Record<string, unknown>) =>
          name === "heading" && attrs?.level === 1,
      };
      const style = getCurrentBlockStyle(mockEditor);
      assert.strictEqual(style.id, "h1");
      assert.strictEqual(style.label, "Heading 1");
      assert.strictEqual(style.level, 1);
    });

    it("resolves Heading 2 correctly", () => {
      const mockEditor = {
        isActive: (name: string, attrs?: Record<string, unknown>) =>
          name === "heading" && attrs?.level === 2,
      };
      const style = getCurrentBlockStyle(mockEditor);
      assert.strictEqual(style.id, "h2");
      assert.strictEqual(style.label, "Heading 2");
      assert.strictEqual(style.level, 2);
    });

    it("resolves Heading 3 correctly", () => {
      const mockEditor = {
        isActive: (name: string, attrs?: Record<string, unknown>) =>
          name === "heading" && attrs?.level === 3,
      };
      const style = getCurrentBlockStyle(mockEditor);
      assert.strictEqual(style.id, "h3");
      assert.strictEqual(style.label, "Heading 3");
      assert.strictEqual(style.level, 3);
    });

    it("resolves Heading 4 correctly", () => {
      const mockEditor = {
        isActive: (name: string, attrs?: Record<string, unknown>) =>
          name === "heading" && attrs?.level === 4,
      };
      const style = getCurrentBlockStyle(mockEditor);
      assert.strictEqual(style.id, "h4");
      assert.strictEqual(style.label, "Heading 4");
      assert.strictEqual(style.level, 4);
    });

    it("falls back to Paragraph when no heading is active (e.g. normal paragraph or mixed state)", () => {
      const mockEditor = {
        isActive: (name: string) => name === "paragraph",
      };
      const style = getCurrentBlockStyle(mockEditor);
      assert.strictEqual(style.id, "paragraph");
      assert.strictEqual(style.label, "Paragraph");
    });

    it("falls back to Paragraph when cursor is in code block or list", () => {
      const mockEditor = {
        isActive: (name: string) => name === "codeBlock",
      };
      const style = getCurrentBlockStyle(mockEditor);
      assert.strictEqual(style.id, "paragraph");
    });
  });

  describe("applyBlockStyle deterministic command execution", () => {
    it("handles null or undefined editor gracefully", () => {
      assert.strictEqual(applyBlockStyle(null, BLOCK_STYLE_OPTIONS[0]), false);
      assert.strictEqual(applyBlockStyle(undefined, BLOCK_STYLE_OPTIONS[1]), false);
    });

    it("executes setParagraph when Paragraph option is selected", () => {
      let setParagraphCalled = false;
      let focusCalled = false;

      const mockEditor = {
        chain: () => ({
          focus: () => {
            focusCalled = true;
            return {
              setHeading: () => ({ run: () => false }),
              setParagraph: () => {
                setParagraphCalled = true;
                return { run: () => true };
              },
            };
          },
        }),
      };

      const result = applyBlockStyle(mockEditor, BLOCK_STYLE_OPTIONS[0]);
      assert.strictEqual(result, true);
      assert.strictEqual(focusCalled, true);
      assert.strictEqual(setParagraphCalled, true);
    });

    it("executes setHeading with exact level when Heading option is selected", () => {
      const levelsTested: number[] = [];

      const createMockEditor = (expectedLevel: number) => ({
        chain: () => ({
          focus: () => ({
            setHeading: (opts: { level: 1 | 2 | 3 | 4 }) => {
              levelsTested.push(opts.level);
              assert.strictEqual(opts.level, expectedLevel);
              return { run: () => true };
            },
            setParagraph: () => ({ run: () => false }),
          }),
        }),
      });

      // Test H1, H2, H3, H4
      assert.strictEqual(applyBlockStyle(createMockEditor(1), BLOCK_STYLE_OPTIONS[1]), true);
      assert.strictEqual(applyBlockStyle(createMockEditor(2), BLOCK_STYLE_OPTIONS[2]), true);
      assert.strictEqual(applyBlockStyle(createMockEditor(3), BLOCK_STYLE_OPTIONS[3]), true);
      assert.strictEqual(applyBlockStyle(createMockEditor(4), BLOCK_STYLE_OPTIONS[4]), true);

      assert.deepStrictEqual(levelsTested, [1, 2, 3, 4]);
    });
  });

  describe("getToolbarActiveState resolution", () => {
    it("returns default inactive state when editor is null or undefined", () => {
      assert.deepStrictEqual(getToolbarActiveState(null), DEFAULT_TOOLBAR_STATE);
      assert.deepStrictEqual(getToolbarActiveState(undefined), DEFAULT_TOOLBAR_STATE);
    });

    it("accurately detects individual formatting active states", () => {
      const createMockEditorForActive = (activeName: string) => ({
        isActive: (name: string) => name === activeName,
      });

      assert.strictEqual(getToolbarActiveState(createMockEditorForActive("bold")).bold, true);
      assert.strictEqual(getToolbarActiveState(createMockEditorForActive("bold")).italic, false);

      assert.strictEqual(getToolbarActiveState(createMockEditorForActive("italic")).italic, true);
      assert.strictEqual(getToolbarActiveState(createMockEditorForActive("code")).code, true);
      assert.strictEqual(getToolbarActiveState(createMockEditorForActive("bulletList")).bulletList, true);
      assert.strictEqual(getToolbarActiveState(createMockEditorForActive("orderedList")).orderedList, true);
      assert.strictEqual(getToolbarActiveState(createMockEditorForActive("codeBlock")).codeBlock, true);
      assert.strictEqual(getToolbarActiveState(createMockEditorForActive("link")).link, true);
      assert.strictEqual(getToolbarActiveState(createMockEditorForActive("table")).table, true);
    });

    it("accurately detects multiple simultaneous active states (e.g. bold + italic + link inside a table)", () => {
      const activeSet = new Set(["bold", "italic", "link", "table"]);
      const mockEditor = {
        isActive: (name: string) => activeSet.has(name),
      };

      const state = getToolbarActiveState(mockEditor);
      assert.strictEqual(state.bold, true);
      assert.strictEqual(state.italic, true);
      assert.strictEqual(state.link, true);
      assert.strictEqual(state.table, true);
      assert.strictEqual(state.code, false);
      assert.strictEqual(state.bulletList, false);
      assert.strictEqual(state.orderedList, false);
      assert.strictEqual(state.codeBlock, false);
    });
  });
});
