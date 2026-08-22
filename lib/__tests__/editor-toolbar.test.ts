import { describe, it } from "node:test";
import assert from "node:assert";
import {
  BLOCK_STYLE_OPTIONS,
  getCurrentBlockStyle,
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
});
