import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { Schema, Slice, Fragment, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { MarkdownParser, defaultMarkdownParser } from "@tiptap/pm/markdown";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    markdownPaste: {
      /**
       * Insert raw markdown string at the current selection.
       */
      insertMarkdown: (markdown: string) => ReturnType;
      /**
       * Insert literal plain text at the current selection without markdown or HTML parsing.
       */
      insertPlainText: (text: string) => ReturnType;
    };
  }
}

/**
 * Cache for MarkdownParser instances by Schema to avoid reconstructing on every paste.
 */
const parserCache = new WeakMap<Schema, MarkdownParser>();

/**
 * Creates or retrieves a configured MarkdownParser for the given ProseMirror Schema.
 */
export function getOrCreateMarkdownParser(schema: Schema): MarkdownParser {
  let parser = parserCache.get(schema);
  if (parser) {
    return parser;
  }

  const tokenizer = defaultMarkdownParser.tokenizer;
  if (typeof tokenizer.enable === "function") {
    tokenizer.enable(["strikethrough"]);
  }

  parser = new MarkdownParser(schema, tokenizer, {
    blockquote: { block: "blockquote" },
    paragraph: { block: "paragraph" },
    list_item: { block: "listItem" },
    bullet_list: { block: "bulletList" },
    ordered_list: {
      block: "orderedList",
      getAttrs: (tok) => {
        const start = tok.attrGet("start");
        return { start: start ? Number(start) || 1 : 1 };
      },
    },
    heading: {
      block: "heading",
      getAttrs: (tok) => ({ level: +tok.tag.slice(1) }),
    },
    code_block: { block: "codeBlock", noCloseToken: true },
    fence: {
      block: "codeBlock",
      getAttrs: (tok) => ({ language: tok.info || "" }),
      noCloseToken: true,
    },
    hr: { node: "horizontalRule" },
    hardbreak: { node: "hardBreak" },

    s: { mark: "strike" },
    em: { mark: "italic" },
    strong: { mark: "bold" },
    link: {
      mark: "link",
      getAttrs: (tok) => ({
        href: tok.attrGet("href"),
        title: tok.attrGet("title") || null,
      }),
    },
    code_inline: { mark: "code", noCloseToken: true },

    // Unsupported constructs degrade gracefully without throwing errors
    image: { ignore: true, noCloseToken: true },
    html_block: { ignore: true, noCloseToken: true },
    html_inline: { ignore: true, noCloseToken: true },
    table: { ignore: true },
    thead: { ignore: true },
    tbody: { ignore: true },
    tr: { ignore: true },
    th: { ignore: true },
    td: { ignore: true },
  });

  parserCache.set(schema, parser);
  return parser;
}

/**
 * Parses markdown text into a ProseMirror Document Node.
 * Returns null if parsing fails or produces an empty document.
 */
export function parseMarkdown(schema: Schema, text: string): ProseMirrorNode | null {
  try {
    const parser = getOrCreateMarkdownParser(schema);
    const doc = parser.parse(text);
    return doc;
  } catch (err) {
    console.warn("Markdown parsing failed:", err);
    return null;
  }
}

/**
 * Creates a ProseMirror Slice from a Markdown string.
 * Differentiates single inline paragraph content from multi-block content.
 */
export function createMarkdownSlice(schema: Schema, text: string): Slice | null {
  const doc = parseMarkdown(schema, text);
  if (!doc || doc.content.size === 0) return null;

  // If the parsed document is a single paragraph without double newlines,
  // slice its inline children so it can be inserted inline at cursor / selection.
  if (
    doc.childCount === 1 &&
    doc.firstChild?.type.name === "paragraph" &&
    !text.includes("\n\n")
  ) {
    return new Slice(doc.firstChild.content, 0, 0);
  }

  // Multi-block or top-level block node (e.g. heading, code block, list, blockquote)
  return new Slice(doc.content, 0, 0);
}

/**
 * Inserts markdown text into the editor at the current selection.
 * Preserves content before and after the selection.
 */
export function insertMarkdownAtSelection(view: EditorView, text: string): boolean {
  const { state, dispatch } = view;
  const slice = createMarkdownSlice(state.schema, text);
  if (!slice) return false;

  const tr = state.tr.replaceSelection(slice).scrollIntoView();
  dispatch(tr);
  return true;
}

/**
 * Creates a ProseMirror Slice containing literal plain-text content.
 * Single line input becomes an inline text slice; multiline input is split into
 * paragraphs with hard breaks where appropriate.
 */
export function createPlainTextSlice(schema: Schema, text: string): Slice | null {
  if (!text) return null;

  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const paragraphs = normalized.split(/\n\n+/);

  // Single line plain text -> inline text node slice
  if (paragraphs.length === 1 && !paragraphs[0].includes("\n")) {
    return new Slice(Fragment.from(schema.text(paragraphs[0])), 0, 0);
  }

  const pNodes = paragraphs.map((pText) => {
    const lines = pText.split("\n");
    const content: ProseMirrorNode[] = [];
    lines.forEach((line, idx) => {
      if (line) {
        content.push(schema.text(line));
      }
      if (idx < lines.length - 1) {
        if (schema.nodes.hardBreak) {
          content.push(schema.nodes.hardBreak.create());
        } else {
          content.push(schema.text(" "));
        }
      }
    });
    return schema.nodes.paragraph.create(null, content);
  });

  return new Slice(Fragment.from(pNodes), 0, 0);
}

/**
 * Inserts literal plain text into the editor at current selection without Markdown or HTML parsing.
 * Preserves line/paragraph breaks and replaces selection cleanly.
 */
export function insertPlainTextAtSelection(view: EditorView, text: string): boolean {
  const { state, dispatch } = view;
  const slice = createPlainTextSlice(state.schema, text);
  if (!slice) return false;

  const tr = state.tr.replaceSelection(slice).scrollIntoView();
  dispatch(tr);
  return true;
}

/**
 * Heuristic conservative detector for Markdown content.
 * Returns true only when strong evidence of structured Markdown syntax is present.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  const lines = trimmed.split(/\r?\n/);
  let score = 0;

  // 1. Headings: ^#{1,6}\s+\S+
  const headingRegex = /^#{1,6}\s+\S+/;
  const headingLines = lines.filter((l) => headingRegex.test(l.trim()));
  if (headingLines.length > 0) {
    score += Math.min(headingLines.length * 2, 4);
  }

  // 2. Fenced code block: ^(```|~~~)
  const fenceRegex = /^(\`\`\`|~~~)/;
  const fenceLines = lines.filter((l) => fenceRegex.test(l.trim()));
  if (fenceLines.length >= 2 || (fenceLines.length === 1 && lines.length === 1)) {
    score += 4;
  } else if (fenceLines.length === 1) {
    score += 2;
  }

  // 3. Blockquotes: ^>\s*\S+
  const blockquoteRegex = /^>\s*\S+/;
  const blockquoteLines = lines.filter((l) => blockquoteRegex.test(l.trim()));
  if (blockquoteLines.length > 0) {
    score += Math.min(blockquoteLines.length * 2, 3);
  }

  // 4. Bullet lists: ^[-*+]\s+\S+
  const bulletRegex = /^[-*+]\s+\S+/;
  const bulletLines = lines.filter((l) => bulletRegex.test(l.trim()));
  if (bulletLines.length >= 2) {
    score += 3;
  } else if (bulletLines.length === 1 && lines.length > 1) {
    score += 1;
  }

  // 5. Ordered lists: ^\d+[.)]\s+\S+
  const orderedRegex = /^\d+[.)]\s+\S+/;
  const orderedLines = lines.filter((l) => orderedRegex.test(l.trim()));
  if (orderedLines.length >= 2) {
    score += 3;
  } else if (
    orderedLines.length === 1 &&
    lines.length > 1 &&
    /^1[.)]\s+/.test(orderedLines[0].trim())
  ) {
    score += 2;
  }

  // 6. Nested list items (indented list lines)
  const nestedListRegex = /^(\s{2,}|\t)[-*+\d]+[.)]?\s+\S+/;
  const nestedListLines = lines.filter((l) => nestedListRegex.test(l));
  if (nestedListLines.length > 0) {
    score += 2;
  }

  // 7. Horizontal rules: ^(---|\*\*\*|___)$
  const hrRegex = /^(---|(\*\s*){3,}|(_\s*){3,})$/;
  const hrLines = lines.filter((l) => hrRegex.test(l.trim()));
  if (hrLines.length > 0) {
    score += 2;
  }

  // 8. Markdown Tables: lines with | col | col | and |---|---|
  const tableDelimiterRegex = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/;
  const tableRowRegex = /^\|(.+\|)+$/;
  const hasTableDelimiter = lines.some((l) => tableDelimiterRegex.test(l.trim()));
  const tableRows = lines.filter((l) => tableRowRegex.test(l.trim()));
  if (hasTableDelimiter && tableRows.length >= 2) {
    score += 4;
  }

  // 9. Markdown links: [label](url)
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]+|#[^\s)]+)\)/g;
  const linkMatches = trimmed.match(linkRegex);
  if (linkMatches && linkMatches.length > 0) {
    score += Math.min(linkMatches.length * 2, 4);
  }

  // 10. Paired inline marks: **bold**, *italic*, `code`, ~~strike~~
  // Bold: **text** or __text__
  const boldRegex =
    /(?:^|[\s([{\`])(\*\*|__)(?!\s)(.+?)(?<!\s)\1(?=[\s)\]},.:;!?\`]|$)/g;
  const boldMatches = trimmed.match(boldRegex);
  if (boldMatches) {
    score += Math.min(boldMatches.length * 2, 3);
  }

  // Inline code: `code`
  const inlineCodeRegex =
    /(?:^|[\s([{\`])\`([^\`\n]+)\`(?=[\s)\]},.:;!?\`]|$)/g;
  const inlineCodeMatches = trimmed.match(inlineCodeRegex);
  if (inlineCodeMatches) {
    score += Math.min(inlineCodeMatches.length * 1, 2);
  }

  // Strikethrough: ~~text~~
  const strikeRegex =
    /(?:^|[\s([{\`])~~(?!\s)(.+?)(?<!\s)~~(?=[\s)\]},.:;!?\`]|$)/g;
  const strikeMatches = trimmed.match(strikeRegex);
  if (strikeMatches) {
    score += Math.min(strikeMatches.length * 1, 2);
  }

  // Italic: *text* (excluding already matched bold marks)
  const cleanForItalic = trimmed.replace(/\*\*|__/g, "");
  const italicRegex =
    /(?:^|[\s([{\`])(\*|_)(?!\s)(.+?)(?<![\s_*])\1(?=[\s)\]},.:;!?\`]|$)/g;
  const italicMatches = cleanForItalic.match(italicRegex);
  if (italicMatches) {
    score += Math.min(italicMatches.length * 1, 2);
  }

  // Conservative threshold: require strong evidence
  return score >= 2;
}

/**
 * Tiptap extension that intercepts clipboard paste events and converts raw Markdown
 * when plain text contains clear Markdown syntax and no meaningful HTML is present.
 */
export const MarkdownPaste = Extension.create({
  name: "markdownPaste",

  addCommands() {
    return {
      insertMarkdown:
        (markdown: string) =>
        ({ tr, dispatch, state }) => {
          const slice = createMarkdownSlice(state.schema, markdown);
          if (!slice) return false;

          if (dispatch) {
            tr.replaceSelection(slice).scrollIntoView();
          }
          return true;
        },
      insertPlainText:
        (text: string) =>
        ({ tr, dispatch, state }) => {
          const slice = createPlainTextSlice(state.schema, text);
          if (!slice) return false;

          if (dispatch) {
            tr.replaceSelection(slice).scrollIntoView();
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handlePaste(view, event) {
            if (!event.clipboardData) return false;

            // 1. If meaningful HTML is present, let ProseMirror handle rich text paste natively
            const html = event.clipboardData.getData("text/html");
            if (html && html.trim().length > 0) {
              return false;
            }

            // 2. Inspect text/plain
            const text = event.clipboardData.getData("text/plain");
            if (!text || !text.trim()) {
              return false;
            }

            // 3. Conservative detection: only intercept if text clearly looks like Markdown
            if (!looksLikeMarkdown(text)) {
              return false;
            }

            // 4. Try parsing and inserting Markdown at selection
            try {
              const handled = insertMarkdownAtSelection(view, text);
              if (handled) {
                event.preventDefault();
                return true;
              }
            } catch (err) {
              console.warn(
                "Failed to parse pasted markdown, falling back to default paste:",
                err
              );
            }

            // 5. Fallback safely to default paste behavior
            return false;
          },
        },
      }),
    ];
  },
});
