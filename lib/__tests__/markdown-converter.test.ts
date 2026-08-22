import { describe, it } from "node:test";
import assert from "node:assert";
import { jsonToMarkdown } from "../markdown-converter.ts";

describe("jsonToMarkdown serialization and whitespace policy", () => {
  it("Test 1: serializes headings and paragraphs with exact single blank lines", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Heading One" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Paragraph one." }],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Heading Two" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Paragraph two." }],
        },
      ],
    };

    const expected = "# Heading One\n\nParagraph one.\n\n## Heading Two\n\nParagraph two.\n";
    assert.strictEqual(jsonToMarkdown(doc), expected);
  });

  it("Test 2: serializes consecutive paragraphs with exactly one blank line between them", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "First paragraph." }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Second paragraph." }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Third paragraph." }],
        },
      ],
    };

    const expected = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";
    assert.strictEqual(jsonToMarkdown(doc), expected);
  });

  it("Test 3: serializes compact bullet list between paragraphs without extra blank lines", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Before." }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "One" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Two" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Three" }],
                },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "After." }],
        },
      ],
    };

    const expected = "Before.\n\n- One\n- Two\n- Three\n\nAfter.\n";
    assert.strictEqual(jsonToMarkdown(doc), expected);
  });

  it("Test 4: serializes compact ordered lists and preserves custom start attributes", () => {
    const defaultStartDoc = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "One" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Two" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Three" }],
                },
              ],
            },
          ],
        },
      ],
    };

    const expectedDefault = "1. One\n2. Two\n3. Three\n";
    assert.strictEqual(jsonToMarkdown(defaultStartDoc), expectedDefault);

    const customStartDoc = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 4 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Fourth" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Fifth" }],
                },
              ],
            },
          ],
        },
      ],
    };

    const expectedCustom = "4. Fourth\n5. Fifth\n";
    assert.strictEqual(jsonToMarkdown(customStartDoc), expectedCustom);
  });

  it("Test 5: serializes nested bullet lists with clean 2-space indentation", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Parent item" }],
                },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "Child item" }],
                        },
                      ],
                    },
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "Another child" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Second parent" }],
                },
              ],
            },
          ],
        },
      ],
    };

    const expected = "- Parent item\n  - Child item\n  - Another child\n- Second parent\n";
    assert.strictEqual(jsonToMarkdown(doc), expected);
  });

  it("Test 6: serializes mixed nested ordered and bullet lists", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Ordered parent" }],
                },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "Bullet child" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Second ordered parent" }],
                },
              ],
            },
          ],
        },
      ],
    };

    const expected = "1. Ordered parent\n  - Bullet child\n2. Second ordered parent\n";
    assert.strictEqual(jsonToMarkdown(doc), expected);
  });

  it("Test 7: serializes single and multi-paragraph blockquotes cleanly", () => {
    const singleDoc = {
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Single quoted line." }],
            },
          ],
        },
      ],
    };
    assert.strictEqual(jsonToMarkdown(singleDoc), "> Single quoted line.\n");

    const multiDoc = {
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "First quoted line." }],
            },
            {
              type: "paragraph",
              content: [{ type: "text", text: "Second quoted paragraph." }],
            },
          ],
        },
      ],
    };

    const expectedMulti = "> First quoted line.\n>\n> Second quoted paragraph.\n";
    assert.strictEqual(jsonToMarkdown(multiDoc), expectedMulti);
  });

  it("Test 8: preserves fenced code block internal blank lines and language fence", () => {
    const rawCode = "function example() {\n\n  return true;\n}";
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Before code." }],
        },
        {
          type: "codeBlock",
          attrs: { language: "js" },
          content: [{ type: "text", text: rawCode }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "After code." }],
        },
      ],
    };

    const expected =
      "Before code.\n\n```js\nfunction example() {\n\n  return true;\n}\n```\n\nAfter code.\n";
    assert.strictEqual(jsonToMarkdown(doc), expected);
  });

  it("Test 9: serializes inline marks (bold, italic, strike, code, link) correctly", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "bold",
              marks: [{ type: "bold" }],
            },
            { type: "text", text: " and " },
            {
              type: "text",
              text: "italic",
              marks: [{ type: "italic" }],
            },
            { type: "text", text: " and " },
            {
              type: "text",
              text: "strikethrough",
              marks: [{ type: "strike" }],
            },
            { type: "text", text: " and " },
            {
              type: "text",
              text: "const x = 1;",
              marks: [{ type: "code" }],
            },
            { type: "text", text: " and " },
            {
              type: "text",
              text: "my link",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
          ],
        },
      ],
    };

    const expected =
      "**bold** and *italic* and ~~strikethrough~~ and `const x = 1;` and [my link](https://example.com)\n";
    assert.strictEqual(jsonToMarkdown(doc), expected);
  });

  it("Test 10: serializes image between paragraphs with exact single blank lines", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Paragraph before." }],
        },
        {
          type: "image",
          attrs: {
            alt: "Alt text",
            src: "https://example.com/image.png",
          },
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Paragraph after." }],
        },
      ],
    };

    const expected =
      "Paragraph before.\n\n![Alt text](https://example.com/image.png)\n\nParagraph after.\n";
    assert.strictEqual(jsonToMarkdown(doc), expected);
  });

  it("Test 11: serializes horizontal rule with exact single blank lines", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Paragraph above." }],
        },
        {
          type: "horizontalRule",
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Paragraph below." }],
        },
      ],
    };

    const expected = "Paragraph above.\n\n---\n\nParagraph below.\n";
    assert.strictEqual(jsonToMarkdown(doc), expected);
  });

  it("Test 12: serializes intentional hard breaks without creating paragraph splits", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "First line" },
            { type: "hardBreak" },
            { type: "text", text: "Second line" },
          ],
        },
      ],
    };

    const expected = "First line  \nSecond line\n";
    assert.strictEqual(jsonToMarkdown(doc), expected);
  });

  it("Test 13: serializes a realistic mixed document fixture with exact deterministic spacing", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Project Overview" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Welcome to " },
            { type: "text", text: "Docula", marks: [{ type: "bold" }] },
            { type: "text", text: " documentation." },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Fast editing" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Clean Markdown export" }],
                },
              ],
            },
          ],
        },
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Simplicity is prerequisite for reliability." }],
            },
          ],
        },
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [
            {
              type: "text",
              text: "interface Config {\n  enabled: boolean;\n\n  timeout: number;\n}",
            },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Final conclusion." }],
        },
      ],
    };

    const expected =
      "# Project Overview\n\n" +
      "Welcome to **Docula** documentation.\n\n" +
      "- Fast editing\n" +
      "- Clean Markdown export\n\n" +
      "> Simplicity is prerequisite for reliability.\n\n" +
      "```ts\ninterface Config {\n  enabled: boolean;\n\n  timeout: number;\n}\n```\n\n" +
      "Final conclusion.\n";

    assert.strictEqual(jsonToMarkdown(doc), expected);
  });

  it("Test 14: enforces EOF policy and handles empty documents safely", () => {
    // Non-empty doc ends with exactly one newline
    const singlePara = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Only paragraph." }],
        },
      ],
    };
    const result = jsonToMarkdown(singlePara);
    assert.strictEqual(result, "Only paragraph.\n");
    assert.strictEqual(result.endsWith("\n"), true);
    assert.strictEqual(result.endsWith("\n\n"), false);

    // Empty doc returns empty string
    assert.strictEqual(jsonToMarkdown({ type: "doc", content: [] }), "");
    assert.strictEqual(jsonToMarkdown({ type: "doc" }), "");
    assert.strictEqual(
      jsonToMarkdown({
        type: "doc",
        content: [{ type: "paragraph", content: [] }],
      }),
      ""
    );
    assert.strictEqual(jsonToMarkdown(null), "");
    assert.strictEqual(jsonToMarkdown(undefined), "");
  });

  it("supports table serialization cleanly", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Header A" }] }],
                },
                {
                  type: "tableHeader",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Header B" }] }],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Val 1" }] }],
                },
                {
                  type: "tableCell",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Val 2" }] }],
                },
              ],
            },
          ],
        },
      ],
    };

    const expected = "| Header A | Header B |\n| --- | --- |\n| Val 1 | Val 2 |\n";
    assert.strictEqual(jsonToMarkdown(doc), expected);
  });

  it("Test 15: serializes H3, H4, and inline code correctly", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Heading Three" }],
        },
        {
          type: "heading",
          attrs: { level: 4 },
          content: [{ type: "text", text: "Heading Four" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Use " },
            {
              type: "text",
              text: "userId",
              marks: [{ type: "code" }],
            },
            { type: "text", text: " here." },
          ],
        },
      ],
    };

    const expected = "### Heading Three\n\n#### Heading Four\n\nUse `userId` here.\n";
    assert.strictEqual(jsonToMarkdown(doc), expected);
  });
});
