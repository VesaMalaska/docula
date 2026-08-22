import { Schema, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { parseMarkdown } from "./markdown-paste.ts";

export interface MarkdownFileValidationResult {
  valid: boolean;
  error?: string;
}

export interface ParsedMarkdownDocument {
  doc: ProseMirrorNode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: Record<string, any>;
  title: string;
}

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Validates selected file extension, MIME type, and file size.
 * Allows legitimate .md files even if browser reports generic MIME types.
 */
export function validateMarkdownFile(file: {
  name: string;
  size?: number;
  type?: string;
}): MarkdownFileValidationResult {
  if (!file || !file.name) {
    return { valid: false, error: "Please select a file to import." };
  }

  if (typeof file.size === "number" && file.size > MAX_FILE_SIZE_BYTES) {
    return {
      valid: false,
      error: "File size exceeds the 10MB limit. Please select a smaller Markdown file.",
    };
  }

  const lowerName = file.name.toLowerCase();
  const hasMarkdownExt = lowerName.endsWith(".md") || lowerName.endsWith(".markdown");
  const hasTextMime =
    file.type === "text/markdown" ||
    file.type === "text/plain" ||
    file.type === "text/x-markdown" ||
    file.type === "";

  if (!hasMarkdownExt && (!file.type || !hasTextMime)) {
    return {
      valid: false,
      error: "Invalid file type. Please select a Markdown file (.md or .markdown).",
    };
  }

  return { valid: true };
}

/**
 * Validates that the raw text content is not empty or whitespace-only.
 */
export function validateMarkdownContent(content: string): MarkdownFileValidationResult {
  if (!content || !content.trim()) {
    return {
      valid: false,
      error: "This Markdown file is empty.",
    };
  }

  return { valid: true };
}

/**
 * Extracts the text content of the first level 1 heading (H1) in a document AST.
 */
export function extractFirstH1(doc: ProseMirrorNode): string | null {
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    if (child.type.name === "heading" && child.attrs?.level === 1) {
      const headingText = child.textContent?.trim();
      if (headingText && headingText.length > 0) {
        return headingText;
      }
    }
  }
  return null;
}

/**
 * Derives a fallback document title from the filename by stripping only the final .md or .markdown extension.
 * Preserves user's original casing, hyphens, underscores, and other punctuation.
 */
export function deriveTitleFromFilename(filename: string): string {
  if (!filename) return "Untitled";
  const stripped = filename.replace(/\.(md|markdown)$/i, "").trim();
  return stripped || "Untitled";
}

/**
 * Derives document title based on precedence:
 * 1. First valid H1 heading in the Markdown document
 * 2. Filename without Markdown extension
 */
export function deriveDocumentTitle(doc: ProseMirrorNode, filename: string): string {
  const h1Title = extractFirstH1(doc);
  if (h1Title) {
    return h1Title;
  }
  return deriveTitleFromFilename(filename);
}

/**
 * Parses raw Markdown text into a validated ProseMirror document and Tiptap JSON structure.
 * Throws a descriptive Error if parsing fails or produces an empty document.
 */
export function parseMarkdownDocument(
  schema: Schema,
  rawMarkdown: string,
  filename: string
): ParsedMarkdownDocument {
  const contentValidation = validateMarkdownContent(rawMarkdown);
  if (!contentValidation.valid) {
    throw new Error(contentValidation.error || "This Markdown file is empty.");
  }

  const doc = parseMarkdown(schema, rawMarkdown);
  if (!doc || doc.content.size === 0) {
    throw new Error("Failed to parse Markdown document into valid content.");
  }

  const title = deriveDocumentTitle(doc, filename);
  const json = doc.toJSON();

  return {
    doc,
    json,
    title,
  };
}
