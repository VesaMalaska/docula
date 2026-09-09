import { describe, it } from "node:test";
import assert from "node:assert";
import { getEditorSchema } from "../editor-schema.ts";
import {
  validateMarkdownFile,
  validateMarkdownContent,
  extractFirstH1,
  deriveTitleFromFilename,
  deriveDocumentTitle,
  parseMarkdownDocument,
} from "../markdown-import.ts";
import { jsonToMarkdown } from "../markdown-converter.ts";

const schema = getEditorSchema();

describe("Markdown File Validation", () => {
  it("accepts .md file with text/markdown MIME type", () => {
    const result = validateMarkdownFile({
      name: "guide.md",
      size: 1024,
      type: "text/markdown",
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.error, undefined);
  });

  it("accepts .md file with generic text/plain MIME type", () => {
    const result = validateMarkdownFile({
      name: "architecture.md",
      size: 2048,
      type: "text/plain",
    });
    assert.strictEqual(result.valid, true);
  });

  it("accepts .markdown file with empty MIME type", () => {
    const result = validateMarkdownFile({
      name: "notes.markdown",
      size: 512,
      type: "",
    });
    assert.strictEqual(result.valid, true);
  });

  it("accepts uppercase .MD extension", () => {
    const result = validateMarkdownFile({
      name: "README.MD",
      size: 512,
      type: "application/octet-stream",
    });
    assert.strictEqual(result.valid, true);
  });

  it("rejects binary or non-markdown file types", () => {
    const result = validateMarkdownFile({
      name: "image.png",
      size: 5000,
      type: "image/png",
    });
    assert.strictEqual(result.valid, false);
    assert.match(result.error || "", /Invalid file type/);
  });

  it("rejects files exceeding the 10MB size limit", () => {
    const result = validateMarkdownFile({
      name: "huge-document.md",
      size: 15 * 1024 * 1024,
      type: "text/markdown",
    });
    assert.strictEqual(result.valid, false);
    assert.match(result.error || "", /exceeds the 10MB limit/);
  });
});

describe("Markdown Content Validation", () => {
  it("rejects empty string", () => {
    const result = validateMarkdownContent("");
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.error, "This Markdown file is empty.");
  });

  it("rejects whitespace-only string (spaces, tabs, newlines)", () => {
    const result = validateMarkdownContent("   \n\n\t  \r\n  ");
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.error, "This Markdown file is empty.");
  });

  it("accepts non-empty content", () => {
    const result = validateMarkdownContent("# Valid Markdown\n\nContent goes here.");
    assert.strictEqual(result.valid, true);
  });
});

describe("Title Derivation Logic", () => {
  it("derives title from filename fallback by stripping only the final .md extension", () => {
    assert.strictEqual(
      deriveTitleFromFilename("deployment-notes.md"),
      "deployment-notes"
    );
    assert.strictEqual(
      deriveTitleFromFilename("my.complex_name-v1.0.md"),
      "my.complex_name-v1.0"
    );
    assert.strictEqual(
      deriveTitleFromFilename("README.markdown"),
      "README"
    );
    assert.strictEqual(
      deriveTitleFromFilename("archive.MD"),
      "archive"
    );
    assert.strictEqual(
      deriveTitleFromFilename(".md"),
      "Untitled"
    );
    assert.strictEqual(
      deriveTitleFromFilename(""),
      "Untitled"
    );
  });

  it("prefers first valid H1 over filename", () => {
    const raw = "# API Architecture\n\nThis document describes the API.";
    const parsed = parseMarkdownDocument(schema, raw, "fallback-filename.md");

    assert.strictEqual(parsed.title, "API Architecture");
  });

  it("preserves H1 in the document body AST", () => {
    const raw = "# API Architecture\n\nThis document describes the API.";
    const parsed = parseMarkdownDocument(schema, raw, "fallback-filename.md");

    assert.strictEqual(parsed.doc.childCount, 2);
    const firstNode = parsed.doc.child(0);
    assert.strictEqual(firstNode.type.name, "heading");
    assert.strictEqual(firstNode.attrs.level, 1);
    assert.strictEqual(firstNode.textContent, "API Architecture");

    const secondNode = parsed.doc.child(1);
    assert.strictEqual(secondNode.type.name, "paragraph");
    assert.strictEqual(secondNode.textContent, "This document describes the API.");
  });

  it("uses filename if document has no H1 (e.g. only H2 or paragraphs)", () => {
    const raw = "## Secondary Section\n\nSome content without H1.";
    const parsed = parseMarkdownDocument(schema, raw, "architecture-notes.md");

    assert.strictEqual(parsed.title, "architecture-notes");
  });

  it("uses first H1 when multiple H1s exist", () => {
    const raw = "# Primary Heading\n\nBody text.\n\n# Secondary Heading\n\nMore text.";
    const parsed = parseMarkdownDocument(schema, raw, "notes.md");

    assert.strictEqual(parsed.title, "Primary Heading");
  });

  it("directly tests extractFirstH1 and deriveDocumentTitle helpers", () => {
    const rawWithH1 = "# Direct Title\n\nContent";
    const parsedWithH1 = parseMarkdownDocument(schema, rawWithH1, "file.md");
    assert.strictEqual(extractFirstH1(parsedWithH1.doc), "Direct Title");
    assert.strictEqual(deriveDocumentTitle(parsedWithH1.doc, "fallback.md"), "Direct Title");

    const rawWithoutH1 = "## Only H2\n\nContent";
    const parsedWithoutH1 = parseMarkdownDocument(schema, rawWithoutH1, "file.md");
    assert.strictEqual(extractFirstH1(parsedWithoutH1.doc), null);
    assert.strictEqual(deriveDocumentTitle(parsedWithoutH1.doc, "custom-name.md"), "custom-name");
  });
});

describe("Required Markdown Test Fixture Parsing", () => {
  const fixture = `# Imported Document

This is a normal paragraph with **bold**, *italic*, ~~strikethrough~~,
\`inline code\`, and a [link](https://example.com).

## Features

- First item
- Second item
  - Nested item

1. Ordered first
2. Ordered second

> A blockquote.

### Code

\`\`\`ts
const answer = 42;

console.log(answer);
\`\`\`

---

Final paragraph.`;

  it("parses all supported blocks and inline marks into valid ProseMirror document", () => {
    const parsed = parseMarkdownDocument(schema, fixture, "import-test.md");

    assert.strictEqual(parsed.title, "Imported Document");
    const doc = parsed.doc;
    assert.strictEqual(doc.type.name, "doc");

    // 0: H1
    const h1 = doc.child(0);
    assert.strictEqual(h1.type.name, "heading");
    assert.strictEqual(h1.attrs.level, 1);
    assert.strictEqual(h1.textContent, "Imported Document");

    // 1: Paragraph with marks
    const p1 = doc.child(1);
    assert.strictEqual(p1.type.name, "paragraph");

    let hasBold = false;
    let hasItalic = false;
    let hasStrike = false;
    let hasCode = false;
    let hasLink = false;

    p1.content.forEach((node) => {
      if (node.marks.some((m) => m.type.name === "bold")) hasBold = true;
      if (node.marks.some((m) => m.type.name === "italic")) hasItalic = true;
      if (node.marks.some((m) => m.type.name === "strike")) hasStrike = true;
      if (node.marks.some((m) => m.type.name === "code")) hasCode = true;
      const linkMark = node.marks.find((m) => m.type.name === "link");
      if (linkMark) {
        hasLink = true;
        assert.strictEqual(linkMark.attrs.href, "https://example.com");
      }
    });

    assert.ok(hasBold, "should have bold mark");
    assert.ok(hasItalic, "should have italic mark");
    assert.ok(hasStrike, "should have strike mark");
    assert.ok(hasCode, "should have code mark");
    assert.ok(hasLink, "should have link mark");

    // 2: H2 Features
    const h2 = doc.child(2);
    assert.strictEqual(h2.type.name, "heading");
    assert.strictEqual(h2.attrs.level, 2);
    assert.strictEqual(h2.textContent, "Features");

    // 3: Bullet List
    const bulletList = doc.child(3);
    assert.strictEqual(bulletList.type.name, "bulletList");
    assert.strictEqual(bulletList.childCount, 2);

    // 4: Ordered List
    const orderedList = doc.child(4);
    assert.strictEqual(orderedList.type.name, "orderedList");
    assert.strictEqual(orderedList.childCount, 2);

    // 5: Blockquote
    const bq = doc.child(5);
    assert.strictEqual(bq.type.name, "blockquote");

    // 6: H3 Code
    const h3 = doc.child(6);
    assert.strictEqual(h3.type.name, "heading");
    assert.strictEqual(h3.attrs.level, 3);
    assert.strictEqual(h3.textContent, "Code");

    // 7: Code Block
    const codeBlock = doc.child(7);
    assert.strictEqual(codeBlock.type.name, "codeBlock");
    assert.strictEqual(codeBlock.attrs.language, "ts");
    assert.ok(codeBlock.textContent.includes("const answer = 42;"));

    // 8: Horizontal Rule
    const hr = doc.child(8);
    assert.strictEqual(hr.type.name, "horizontalRule");

    // 9: Final Paragraph
    const finalP = doc.child(9);
    assert.strictEqual(finalP.type.name, "paragraph");
    assert.strictEqual(finalP.textContent, "Final paragraph.");
  });

  it("produces valid JSON format matching Tiptap doc structure", () => {
    const parsed = parseMarkdownDocument(schema, fixture, "import-test.md");
    assert.strictEqual(parsed.json.type, "doc");
    assert.ok(Array.isArray(parsed.json.content));
    assert.strictEqual(parsed.json.content.length, parsed.doc.childCount);
  });
});

describe("Malformed and Unsupported Markdown Resilience", () => {
  it("gracefully handles unclosed bold syntax without crashing", () => {
    const input = "# Notes\n\n**unfinished bold\n\n- item one\n- item two";
    const parsed = parseMarkdownDocument(schema, input, "notes.md");

    assert.strictEqual(parsed.title, "Notes");
    assert.strictEqual(parsed.doc.type.name, "doc");
  });

  it("gracefully handles unclosed code fence without crashing", () => {
    const input = "```ts\nconst unclosed = true;\n";
    const parsed = parseMarkdownDocument(schema, input, "code.md");

    assert.strictEqual(parsed.title, "code");
    assert.strictEqual(parsed.doc.type.name, "doc");
  });

  it("gracefully handles unclosed link syntax without crashing", () => {
    const input = "[unclosed link](https://example.com";
    const parsed = parseMarkdownDocument(schema, input, "link.md");

    assert.strictEqual(parsed.title, "link");
    assert.strictEqual(parsed.doc.type.name, "doc");
  });

  it("safely ignores Markdown images without breaking parser or importing unverified S3 URLs", () => {
    const input = "# Document With Image\n\n![External Image](https://example.com/pic.png)\n\nParagraph after.";
    const parsed = parseMarkdownDocument(schema, input, "image.md");

    assert.strictEqual(parsed.title, "Document With Image");
    assert.strictEqual(parsed.doc.type.name, "doc");
  });
});

describe("Round-Trip Interoperability: Import Markdown -> Docula -> Export Markdown", () => {
  it("preserves document structure through import and export", () => {
    const sourceMarkdown = `# Interoperability Guide

This is a paragraph with **bold** and *italic* formatting.

## Subheading

- Bullet 1
- Bullet 2

1. Numbered 1
2. Numbered 2

> Quoted wisdom.

\`\`\`javascript
const test = "interop";
\`\`\`

---

Closing paragraph.
`;

    // 1. Import
    const parsed = parseMarkdownDocument(schema, sourceMarkdown, "interop.md");

    // 2. Export via jsonToMarkdown
    const exportedMarkdown = jsonToMarkdown(parsed.json);

    // 3. Verify semantic structure in exported markdown
    assert.ok(exportedMarkdown.includes("# Interoperability Guide"));
    assert.ok(exportedMarkdown.includes("**bold**"));
    assert.ok(exportedMarkdown.includes("*italic*"));
    assert.ok(exportedMarkdown.includes("## Subheading"));
    assert.ok(exportedMarkdown.includes("- Bullet 1"));
    assert.ok(exportedMarkdown.includes("- Bullet 2"));
    assert.ok(exportedMarkdown.includes("1. Numbered 1"));
    assert.ok(exportedMarkdown.includes("2. Numbered 2"));
    assert.ok(exportedMarkdown.includes("> Quoted wisdom."));
    assert.ok(exportedMarkdown.includes("```javascript"));
    assert.ok(exportedMarkdown.includes('const test = "interop";'));
    assert.ok(exportedMarkdown.includes("---"));
    assert.ok(exportedMarkdown.includes("Closing paragraph."));
  });
});
