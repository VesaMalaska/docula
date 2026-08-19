import { describe, it } from "node:test";
import assert from "node:assert";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import {
  looksLikeMarkdown,
  getOrCreateMarkdownParser,
  parseMarkdown,
  createMarkdownSlice,
  createPlainTextSlice,
} from "../markdown-paste.ts";

const testSchema = getSchema([
  StarterKit.configure({
    link: false,
  }),
  Link.configure({
    openOnClick: false,
    autolink: true,
  }),
]);

describe("looksLikeMarkdown heuristic detection", () => {
  it("rejects plain text example 1: Call #123 for details.", () => {
    assert.strictEqual(looksLikeMarkdown("Call #123 for details."), false);
  });

  it("rejects plain text example 2: Version * may vary.", () => {
    assert.strictEqual(looksLikeMarkdown("Version * may vary."), false);
  });

  it("rejects plain text example 3: Use foo_bar as the identifier.", () => {
    assert.strictEqual(looksLikeMarkdown("Use foo_bar as the identifier."), false);
  });

  it("rejects plain text example 4: Meeting is at 10-12.", () => {
    assert.strictEqual(looksLikeMarkdown("Meeting is at 10-12."), false);
  });

  it("rejects plain text example 5: This is a #tag in a sentence.", () => {
    assert.strictEqual(looksLikeMarkdown("This is a #tag in a sentence."), false);
  });

  it("rejects weak markdown-like input: The issue number is #42 and version * may vary.", () => {
    assert.strictEqual(
      looksLikeMarkdown("The issue number is #42 and version * may vary."),
      false
    );
  });

  it("rejects plain text math expressions and file paths", () => {
    assert.strictEqual(looksLikeMarkdown("3 * 4 = 12 and 5 * 6 = 30"), false);
    assert.strictEqual(looksLikeMarkdown("C:\\Users\\foo\\bar.txt"), false);
    assert.strictEqual(looksLikeMarkdown(""), false);
    assert.strictEqual(looksLikeMarkdown("   "), false);
  });

  it("detects H1 heading", () => {
    assert.strictEqual(looksLikeMarkdown("# Character Notes"), true);
  });

  it("detects H2 heading with body text", () => {
    assert.strictEqual(looksLikeMarkdown("## Background\nSome notes here"), true);
  });

  it("detects fenced code blocks", () => {
    assert.strictEqual(
      looksLikeMarkdown("```ts\nconst wolf = \"hopping\";\n```"),
      true
    );
  });

  it("detects multi-line bullet lists", () => {
    assert.strictEqual(
      looksLikeMarkdown("- Born in Kotka\n- Likes strange adventures"),
      true
    );
  });

  it("detects ordered lists", () => {
    assert.strictEqual(
      looksLikeMarkdown("1. First step\n2. Second step"),
      true
    );
  });

  it("detects blockquotes", () => {
    assert.strictEqual(
      looksLikeMarkdown("> Something interesting happened here."),
      true
    );
  });

  it("detects markdown links", () => {
    assert.strictEqual(looksLikeMarkdown("[OpenAI](https://openai.com)"), true);
  });

  it("detects paired bold and italic formatting", () => {
    assert.strictEqual(
      looksLikeMarkdown("This is **important** and this is *emphasized*."),
      true
    );
  });

  it("detects full example raw markdown input", () => {
    const fullInput = `# Character Notes

This is **important** and this is *emphasized*.

## Background

- Born in Kotka
- Likes strange adventures
- Carries:
  - notebook
  - flashlight

1. First step
2. Second step

> Something interesting happened here.

Use \`npm run dev\` to start the application.

\`\`\`ts
const wolf = "hopping";
\`\`\`

[OpenAI](https://openai.com)`;

    assert.strictEqual(looksLikeMarkdown(fullInput), true);
  });

  it("detects strong markdown input (Test G)", () => {
    const strongInput = `## Notes

- one
- two
- three

> Important`;

    assert.strictEqual(looksLikeMarkdown(strongInput), true);
  });
});

describe("parseMarkdown and createMarkdownSlice", () => {
  it("caches and reuses MarkdownParser instance for the same schema", () => {
    const p1 = getOrCreateMarkdownParser(testSchema);
    const p2 = getOrCreateMarkdownParser(testSchema);
    assert.strictEqual(p1, p2);
  });

  it("correctly parses full raw markdown into structured ProseMirror document AST", () => {
    const fullInput = `# Character Notes

This is **important** and this is *emphasized*.

## Background

- Born in Kotka
- Likes strange adventures
- Carries:
  - notebook
  - flashlight

1. First step
2. Second step

> Something interesting happened here.

Use \`npm run dev\` to start the application.

\`\`\`ts
const wolf = "hopping";
\`\`\`

[OpenAI](https://openai.com)`;

    const doc = parseMarkdown(testSchema, fullInput);
    assert.ok(doc, "doc should not be null");
    assert.strictEqual(doc.type.name, "doc");

    // Check headings
    const h1 = doc.child(0);
    assert.strictEqual(h1.type.name, "heading");
    assert.strictEqual(h1.attrs.level, 1);
    assert.strictEqual(h1.textContent, "Character Notes");

    // Check paragraph with bold and italic marks
    const p1 = doc.child(1);
    assert.strictEqual(p1.type.name, "paragraph");
    let hasBold = false;
    let hasItalic = false;
    p1.content.forEach((node) => {
      if (node.marks.some((m) => m.type.name === "bold")) hasBold = true;
      if (node.marks.some((m) => m.type.name === "italic")) hasItalic = true;
    });
    assert.ok(hasBold, "should contain bold mark");
    assert.ok(hasItalic, "should contain italic mark");

    // Check H2
    const h2 = doc.child(2);
    assert.strictEqual(h2.type.name, "heading");
    assert.strictEqual(h2.attrs.level, 2);
    assert.strictEqual(h2.textContent, "Background");

    // Check bullet list & nested list
    const bulletList = doc.child(3);
    assert.strictEqual(bulletList.type.name, "bulletList");
    assert.strictEqual(bulletList.childCount, 3);

    // Check ordered list
    const orderedList = doc.child(4);
    assert.strictEqual(orderedList.type.name, "orderedList");
    assert.strictEqual(orderedList.childCount, 2);

    // Check blockquote
    const bq = doc.child(5);
    assert.strictEqual(bq.type.name, "blockquote");

    // Check code block
    const codeBlock = doc.child(7);
    assert.strictEqual(codeBlock.type.name, "codeBlock");
    assert.strictEqual(codeBlock.attrs.language, "ts");
    assert.strictEqual(codeBlock.textContent, 'const wolf = "hopping";');

    // Check link
    const linkPara = doc.child(8);
    assert.strictEqual(linkPara.type.name, "paragraph");
    let hasLink = false;
    linkPara.content.forEach((node) => {
      const linkMark = node.marks.find((m) => m.type.name === "link");
      if (linkMark) {
        hasLink = true;
        assert.strictEqual(linkMark.attrs.href, "https://openai.com");
      }
    });
    assert.ok(hasLink, "should contain link mark");
  });

  it("handles malformed markdown safely without crashing", () => {
    const malformed = [
      "```ts\nconst unclosed = true;\n",
      "**unclosed bold text",
      "[unclosed link](https://openai.com",
      "###",
      ">>> nested unclosed",
      "random *** ___ ~~~ ``` [[(( text",
    ];

    for (const input of malformed) {
      const doc = parseMarkdown(testSchema, input);
      assert.ok(doc, `Should safely parse malformed input: ${input}`);
      assert.strictEqual(doc.type.name, "doc");
    }
  });

  it("inserts multi-block markdown at cursor while keeping surrounding text intact", () => {
    const initialDoc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, [testSchema.text("Before paragraph.")]),
      testSchema.node("paragraph", null, [testSchema.text("After paragraph.")]),
    ]);

    let state = EditorState.create({ doc: initialDoc, schema: testSchema });
    // Cursor at end of 'Before paragraph.' (pos 18)
    const cursorPos = 18;
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, cursorPos))
    );

    const slice = createMarkdownSlice(
      testSchema,
      "## New Section\n\n- item one\n- item two"
    );
    assert.ok(slice);

    const tr = state.tr.replaceSelection(slice);
    state = state.apply(tr);

    assert.strictEqual(state.doc.childCount, 4);
    assert.strictEqual(state.doc.child(0).textContent, "Before paragraph.");
    assert.strictEqual(state.doc.child(1).type.name, "heading");
    assert.strictEqual(state.doc.child(1).textContent, "New Section");
    assert.strictEqual(state.doc.child(2).type.name, "bulletList");
    assert.strictEqual(state.doc.child(3).textContent, "After paragraph.");
  });

  it("replaces selected text with inline markdown without breaking paragraph", () => {
    const initialDoc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, [
        testSchema.text("Keep this. target text Keep that."),
      ]),
    ]);

    let state = EditorState.create({ doc: initialDoc, schema: testSchema });
    // Select 'target text' (pos 12 to 23)
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 12, 23))
    );

    const slice = createMarkdownSlice(testSchema, "**bold replacement**");
    assert.ok(slice);

    const tr = state.tr.replaceSelection(slice);
    state = state.apply(tr);

    assert.strictEqual(state.doc.childCount, 1);
    const p = state.doc.child(0);
    assert.strictEqual(
      p.textContent,
      "Keep this. bold replacement Keep that."
    );
    let boldText = "";
    p.content.forEach((n) => {
      if (n.marks.some((m) => m.type.name === "bold")) {
        boldText = n.text || "";
      }
    });
    assert.strictEqual(boldText, "bold replacement");
  });

  it("explicitly parses ambiguous markdown when forced (e.g. *possibly markdown*)", () => {
    // *possibly markdown* fails conservative auto-detection
    assert.strictEqual(looksLikeMarkdown("*possibly markdown*"), false);

    // But parseMarkdown parses it into italic formatting
    const doc = parseMarkdown(testSchema, "*possibly markdown*");
    assert.ok(doc);
    const p = doc.child(0);
    let hasItalic = false;
    p.content.forEach((n) => {
      if (n.marks.some((m) => m.type.name === "italic")) {
        hasItalic = true;
      }
    });
    assert.ok(hasItalic, "explicit parse should create italic mark");
  });
});

describe("createPlainTextSlice and plain text insertion", () => {
  it("creates literal plain text slice without markdown or html interpretation", () => {
    const input = "## Heading\n\nThis is **bold**.";
    const slice = createPlainTextSlice(testSchema, input);
    assert.ok(slice);

    const initialDoc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, []),
    ]);
    let state = EditorState.create({ doc: initialDoc, schema: testSchema });
    state = state.apply(state.tr.replaceSelection(slice));

    // Must be 2 paragraphs of literal text, NO heading or bold marks
    assert.strictEqual(state.doc.childCount, 2);
    assert.strictEqual(state.doc.child(0).type.name, "paragraph");
    assert.strictEqual(state.doc.child(0).textContent, "## Heading");
    assert.strictEqual(state.doc.child(1).type.name, "paragraph");
    assert.strictEqual(state.doc.child(1).textContent, "This is **bold**.");

    // Verify no marks were applied
    state.doc.descendants((node) => {
      assert.strictEqual(
        node.marks.length,
        0,
        `Node ${node.type.name} with text "${node.text}" should have no marks`
      );
    });
  });

  it("replaces selected text with literal plain text", () => {
    const initialDoc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, [
        testSchema.text("Some text OLD VALUE more text."),
      ]),
    ]);

    let state = EditorState.create({ doc: initialDoc, schema: testSchema });
    // Select 'OLD VALUE' (pos 11 to 20)
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 11, 20))
    );

    const slice = createPlainTextSlice(testSchema, "**new value**");
    assert.ok(slice);

    state = state.apply(state.tr.replaceSelection(slice));

    assert.strictEqual(state.doc.childCount, 1);
    assert.strictEqual(
      state.doc.child(0).textContent,
      "Some text **new value** more text."
    );

    // Verify no bold mark exists
    state.doc.descendants((node) => {
      assert.strictEqual(
        node.marks.length,
        0,
        "Should contain literal asterisks and no bold marks"
      );
    });
  });

  it("preserves multiline paragraph and hard-break structure for plain text", () => {
    const multilineInput = `First paragraph.

Second paragraph.
Third line.`;

    const slice = createPlainTextSlice(testSchema, multilineInput);
    assert.ok(slice);

    const initialDoc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, [testSchema.text("Before.")]),
      testSchema.node("paragraph", null, [testSchema.text("After.")]),
    ]);

    let state = EditorState.create({ doc: initialDoc, schema: testSchema });
    // Cursor at end of 'Before.' (pos 8)
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 8))
    );

    state = state.apply(state.tr.replaceSelection(slice));

    assert.strictEqual(state.doc.childCount, 4);
    assert.strictEqual(state.doc.child(0).textContent, "Before.");
    assert.strictEqual(state.doc.child(1).textContent, "First paragraph.");
    assert.strictEqual(state.doc.child(2).textContent, "Second paragraph.Third line.");
    assert.strictEqual(state.doc.child(3).textContent, "After.");

    // Check hardBreak in 2nd paragraph
    const p2 = state.doc.child(2);
    let hasHardBreak = false;
    p2.forEach((n) => {
      if (n.type.name === "hardBreak") hasHardBreak = true;
    });
    assert.ok(hasHardBreak, "Should contain hardBreak node");
  });
});
