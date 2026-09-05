import { describe, it } from "node:test";
import assert from "node:assert";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { getEditorSchema, coreEditorExtensions } from "../editor-schema.ts";
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

const editorSchema = getEditorSchema();

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

  it("detects standard GFM table with outer pipes", () => {
    const tableInput = `| Name | Role |
| --- | --- |
| Martta | Farmer |
| Pena | Tractor philosopher |`;
    assert.strictEqual(looksLikeMarkdown(tableInput), true);
  });

  it("detects GFM table with alignment markers", () => {
    const tableInput = `| Left | Center | Right |
| :--- | :---: | ---: |
| A | B | C |`;
    assert.strictEqual(looksLikeMarkdown(tableInput), true);
  });

  it("detects GFM table with optional outer pipes", () => {
    const tableInput = `Name | Role
--- | ---
Martta | Farmer
Pena | Tractor philosopher`;
    assert.strictEqual(looksLikeMarkdown(tableInput), true);
  });

  it("detects GFM table with empty cells", () => {
    const tableInput = `| Name | Note |
| --- | --- |
| Martta | |
| | Missing name |`;
    assert.strictEqual(looksLikeMarkdown(tableInput), true);
  });

  it("rejects non-table pipe text in ordinary prose", () => {
    assert.strictEqual(
      looksLikeMarkdown("This is a pipe | in normal text.\nAnother line without delimiter."),
      false
    );
  });

  it("rejects table-like text without delimiter row", () => {
    assert.strictEqual(
      looksLikeMarkdown("| Name | Role |\n| Martta | Farmer |"),
      false
    );
  });

  it("rejects delimiter row without preceded header row", () => {
    assert.strictEqual(looksLikeMarkdown("--- | ---"), false);
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

describe("GFM table parsing and editor conversion", () => {
  it("converts standard GFM table into native table structure with header and body cells", () => {
    const tableMd = `| Name | Role |
| --- | --- |
| Martta | Farmer |
| Pena | Tractor philosopher |`;

    const doc = parseMarkdown(editorSchema, tableMd);
    assert.ok(doc, "doc should not be null");
    assert.strictEqual(doc.childCount, 1);

    const table = doc.child(0);
    assert.strictEqual(table.type.name, "table");
    assert.strictEqual(table.childCount, 3, "should have 3 rows (1 header + 2 body)");

    // Header row
    const headerRow = table.child(0);
    assert.strictEqual(headerRow.type.name, "tableRow");
    assert.strictEqual(headerRow.childCount, 2);
    assert.strictEqual(headerRow.child(0).type.name, "tableHeader");
    assert.strictEqual(headerRow.child(0).textContent, "Name");
    assert.strictEqual(headerRow.child(1).type.name, "tableHeader");
    assert.strictEqual(headerRow.child(1).textContent, "Role");

    // Body row 1
    const bodyRow1 = table.child(1);
    assert.strictEqual(bodyRow1.type.name, "tableRow");
    assert.strictEqual(bodyRow1.childCount, 2);
    assert.strictEqual(bodyRow1.child(0).type.name, "tableCell");
    assert.strictEqual(bodyRow1.child(0).textContent, "Martta");
    assert.strictEqual(bodyRow1.child(1).type.name, "tableCell");
    assert.strictEqual(bodyRow1.child(1).textContent, "Farmer");

    // Body row 2
    const bodyRow2 = table.child(2);
    assert.strictEqual(bodyRow2.type.name, "tableRow");
    assert.strictEqual(bodyRow2.childCount, 2);
    assert.strictEqual(bodyRow2.child(0).type.name, "tableCell");
    assert.strictEqual(bodyRow2.child(0).textContent, "Pena");
    assert.strictEqual(bodyRow2.child(1).type.name, "tableCell");
    assert.strictEqual(bodyRow2.child(1).textContent, "Tractor philosopher");

    // Verify raw table delimiters do not appear anywhere in the document
    const rawDelimiters = ["|", "---"];
    doc.descendants((node) => {
      if (node.isText && node.text) {
        for (const delim of rawDelimiters) {
          assert.strictEqual(
            node.text.includes(delim),
            false,
            `Text node should not contain delimiter '${delim}': got '${node.text}'`
          );
        }
      }
    });
  });

  it("handles alignment markers without leaking colons into cell content", () => {
    const tableMd = `| Left | Center | Right |
| :--- | :---: | ---: |
| A | B | C |`;

    const doc = parseMarkdown(editorSchema, tableMd);
    assert.ok(doc);
    assert.strictEqual(doc.childCount, 1);

    const table = doc.child(0);
    assert.strictEqual(table.type.name, "table");
    assert.strictEqual(table.childCount, 2);

    const headerRow = table.child(0);
    assert.strictEqual(headerRow.child(0).textContent, "Left");
    assert.strictEqual(headerRow.child(1).textContent, "Center");
    assert.strictEqual(headerRow.child(2).textContent, "Right");

    const bodyRow = table.child(1);
    assert.strictEqual(bodyRow.child(0).textContent, "A");
    assert.strictEqual(bodyRow.child(1).textContent, "B");
    assert.strictEqual(bodyRow.child(2).textContent, "C");

    // Verify alignment markers :---, :---:, ---: do not leak as text
    doc.descendants((node) => {
      if (node.isText && node.text) {
        assert.strictEqual(node.text.includes(":---"), false);
        assert.strictEqual(node.text.includes("---:"), false);
      }
    });
  });

  it("converts table syntax with optional outer pipes", () => {
    const tableMd = `Name | Role
--- | ---
Martta | Farmer
Pena | Tractor philosopher`;

    const doc = parseMarkdown(editorSchema, tableMd);
    assert.ok(doc);
    assert.strictEqual(doc.childCount, 1);

    const table = doc.child(0);
    assert.strictEqual(table.type.name, "table");
    assert.strictEqual(table.childCount, 3);

    const headerRow = table.child(0);
    assert.strictEqual(headerRow.child(0).type.name, "tableHeader");
    assert.strictEqual(headerRow.child(0).textContent, "Name");
    assert.strictEqual(headerRow.child(1).type.name, "tableHeader");
    assert.strictEqual(headerRow.child(1).textContent, "Role");

    const bodyRow1 = table.child(1);
    assert.strictEqual(bodyRow1.child(0).textContent, "Martta");
    assert.strictEqual(bodyRow1.child(1).textContent, "Farmer");

    const bodyRow2 = table.child(2);
    assert.strictEqual(bodyRow2.child(0).textContent, "Pena");
    assert.strictEqual(bodyRow2.child(1).textContent, "Tractor philosopher");
  });

  it("preserves empty cells and column alignment without shifting cell contents", () => {
    const tableMd = `| Name | Note |
| --- | --- |
| Martta | |
| | Missing name |`;

    const doc = parseMarkdown(editorSchema, tableMd);
    assert.ok(doc);

    const table = doc.child(0);
    assert.strictEqual(table.type.name, "table");
    assert.strictEqual(table.childCount, 3);

    // Row 1: Martta in col 0, empty in col 1
    const row1 = table.child(1);
    assert.strictEqual(row1.childCount, 2);
    assert.strictEqual(row1.child(0).textContent, "Martta");
    assert.strictEqual(row1.child(1).textContent, "");
    assert.strictEqual(row1.child(1).child(0).type.name, "paragraph");

    // Row 2: empty in col 0, 'Missing name' in col 1
    const row2 = table.child(2);
    assert.strictEqual(row2.childCount, 2);
    assert.strictEqual(row2.child(0).textContent, "");
    assert.strictEqual(row2.child(0).child(0).type.name, "paragraph");
    assert.strictEqual(row2.child(1).textContent, "Missing name");
  });

  it("preserves surrounding Markdown paragraphs in exact sequence with the table", () => {
    const md = `Paragraph before the table.

| Name | Role |
| --- | --- |
| Martta | Farmer |

Paragraph after the table.`;

    const doc = parseMarkdown(editorSchema, md);
    assert.ok(doc);
    assert.strictEqual(doc.childCount, 3);

    assert.strictEqual(doc.child(0).type.name, "paragraph");
    assert.strictEqual(doc.child(0).textContent, "Paragraph before the table.");

    assert.strictEqual(doc.child(1).type.name, "table");
    assert.strictEqual(doc.child(1).childCount, 2);
    assert.strictEqual(doc.child(1).child(0).child(0).textContent, "Name");
    assert.strictEqual(doc.child(1).child(1).child(0).textContent, "Martta");

    assert.strictEqual(doc.child(2).type.name, "paragraph");
    assert.strictEqual(doc.child(2).textContent, "Paragraph after the table.");
  });

  it("does not convert ordinary prose containing pipe characters into a table", () => {
    const prose = "This is a pipe | in normal text.\nAnother line without delimiter.";
    const doc = parseMarkdown(editorSchema, prose);
    assert.ok(doc);
    assert.strictEqual(doc.childCount, 1);
    assert.strictEqual(doc.child(0).type.name, "paragraph");
    assert.strictEqual(
      doc.child(0).textContent,
      "This is a pipe | in normal text. Another line without delimiter."
    );
  });

  it("does not convert table-like text lacking a delimiter row into a table", () => {
    const textWithoutDelimiter = `| Name | Role |
| Martta | Farmer |
| Pena | Tractor philosopher |`;

    const doc = parseMarkdown(editorSchema, textWithoutDelimiter);
    assert.ok(doc);
    assert.strictEqual(doc.childCount, 1);
    assert.strictEqual(doc.child(0).type.name, "paragraph");
    assert.ok(
      doc.child(0).textContent.includes("Martta"),
      "Should retain text as ordinary paragraph"
    );
  });

  it("inserts table slice cleanly into editor selection between surrounding paragraphs", () => {
    const initialDoc = editorSchema.node("doc", null, [
      editorSchema.node("paragraph", null, [editorSchema.text("Before table.")]),
      editorSchema.node("paragraph", null, [editorSchema.text("After table.")]),
    ]);

    let state = EditorState.create({ doc: initialDoc, schema: editorSchema });
    // Place cursor at end of 'Before table.' (pos 14)
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 14))
    );

    const tableMd = `| Name | Role |
| --- | --- |
| Martta | Farmer |`;
    const slice = createMarkdownSlice(editorSchema, tableMd);
    assert.ok(slice);

    const tr = state.tr.replaceSelection(slice);
    state = state.apply(tr);

    // Structure: Before table. -> table -> After table.
    assert.strictEqual(state.doc.childCount, 3);
    assert.strictEqual(state.doc.child(0).textContent, "Before table.");
    assert.strictEqual(state.doc.child(1).type.name, "table");
    assert.strictEqual(state.doc.child(1).childCount, 2);
    assert.strictEqual(state.doc.child(2).textContent, "After table.");
  });

  it("parses rich inline marks within table cells (bold, italic, link, code, strike)", () => {
    const richTable = `| Feature | Example |
| --- | --- |
| **Bold** | *Italic* |
| [Link](https://docula.local) | \`inlineCode\` and ~~strike~~ |`;

    const doc = parseMarkdown(editorSchema, richTable);
    assert.ok(doc);

    const table = doc.child(0);
    assert.strictEqual(table.type.name, "table");

    const row1 = table.child(1);
    // Bold in col 0
    let hasBold = false;
    row1.child(0).descendants((node) => {
      if (node.marks.some((m) => m.type.name === "bold")) hasBold = true;
    });
    assert.ok(hasBold, "cell should contain bold mark");

    // Italic in col 1
    let hasItalic = false;
    row1.child(1).descendants((node) => {
      if (node.marks.some((m) => m.type.name === "italic")) hasItalic = true;
    });
    assert.ok(hasItalic, "cell should contain italic mark");

    const row2 = table.child(2);
    // Link in col 0
    let linkHref = "";
    row2.child(0).descendants((node) => {
      const lm = node.marks.find((m) => m.type.name === "link");
      if (lm) linkHref = lm.attrs.href;
    });
    assert.strictEqual(linkHref, "https://docula.local");

    // Code & Strike in col 1
    let hasCode = false;
    let hasStrike = false;
    row2.child(1).descendants((node) => {
      if (node.marks.some((m) => m.type.name === "code")) hasCode = true;
      if (node.marks.some((m) => m.type.name === "strike")) hasStrike = true;
    });
    assert.ok(hasCode, "cell should contain code mark");
    assert.ok(hasStrike, "cell should contain strike mark");
  });

  it("preserves all header and cell content in reading order when schema lacks table extensions", () => {
    const tableMd = `| Name | Role |
| --- | --- |
| Martta | Farmer |
| Pena | Tractor philosopher |`;

    // testSchema does not have table extensions
    assert.strictEqual(testSchema.nodes.table, undefined);

    const doc = parseMarkdown(testSchema, tableMd);
    assert.ok(doc, "parsing should succeed without throwing error");

    // Verify no native table node exists anywhere in the document
    let hasTableNode = false;
    doc.descendants((node) => {
      if (
        node.type.name === "table" ||
        node.type.name === "tableRow" ||
        node.type.name === "tableHeader" ||
        node.type.name === "tableCell"
      ) {
        hasTableNode = true;
      }
    });
    assert.strictEqual(hasTableNode, false, "no native table nodes should exist in fallback doc");

    // Verify Name, Role, Martta, Farmer, Pena, and Tractor philosopher all remain present in reading order
    const expectedValues = [
      "Name",
      "Role",
      "Martta",
      "Farmer",
      "Pena",
      "Tractor philosopher",
    ];

    const extractedParagraphTexts: string[] = [];
    doc.forEach((node) => {
      if (node.type.name === "paragraph" && node.textContent) {
        extractedParagraphTexts.push(node.textContent);
      }
    });

    assert.deepStrictEqual(
      extractedParagraphTexts,
      expectedValues,
      "all header and body cell values must remain in exact reading order"
    );

    // Verify no value is duplicated
    const seen = new Set<string>();
    for (const val of extractedParagraphTexts) {
      assert.strictEqual(
        seen.has(val),
        false,
        `Value '${val}' must not be duplicated in fallback content`
      );
      seen.add(val);
    }
  });

  it("idempotently initializes tokenizer across multiple compatible schema instances without duplicate rules or extra paragraphs", () => {
    const compatibleSchema2 = getSchema(coreEditorExtensions);
    assert.notStrictEqual(editorSchema, compatibleSchema2);

    // Repeatedly retrieve parsers across both schema instances to exercise the configuration path
    const p1 = getOrCreateMarkdownParser(editorSchema);
    const p2 = getOrCreateMarkdownParser(compatibleSchema2);
    const p3 = getOrCreateMarkdownParser(editorSchema);
    const p4 = getOrCreateMarkdownParser(compatibleSchema2);
    assert.ok(p1 && p2 && p3 && p4);

    const tableMd = `| Name | Role |
| --- | --- |
| Martta | Farmer |
| Pena | Tractor philosopher |`;

    const doc = p4.parse(tableMd);
    assert.ok(doc);
    assert.strictEqual(doc.childCount, 1, "exactly one root node");

    const table = doc.child(0);
    assert.strictEqual(table.type.name, "table", "exactly one table produced");
    assert.strictEqual(table.childCount, 3, "table rows must not be duplicated (1 header + 2 body rows)");

    const expectedCells = [
      ["Name", "Role"],
      ["Martta", "Farmer"],
      ["Pena", "Tractor philosopher"],
    ];

    for (let rowIndex = 0; rowIndex < table.childCount; rowIndex++) {
      const row = table.child(rowIndex);
      assert.strictEqual(row.type.name, "tableRow");
      assert.strictEqual(
        row.childCount,
        expectedCells[rowIndex].length,
        `row ${rowIndex} cells must not be duplicated`
      );

      for (let colIndex = 0; colIndex < row.childCount; colIndex++) {
        const cell = row.child(colIndex);
        const expectedText = expectedCells[rowIndex][colIndex];

        // Each cell contains exactly one required paragraph node
        assert.strictEqual(
          cell.childCount,
          1,
          `cell [${rowIndex}, ${colIndex}] must contain exactly one paragraph, got ${cell.childCount}`
        );
        const paragraph = cell.child(0);
        assert.strictEqual(paragraph.type.name, "paragraph");

        // No extra empty paragraph or leaked content; text appears exactly once
        assert.strictEqual(
          cell.textContent,
          expectedText,
          `cell [${rowIndex}, ${colIndex}] text must appear exactly once`
        );
        assert.strictEqual(
          paragraph.textContent,
          expectedText,
          `paragraph in cell [${rowIndex}, ${colIndex}] must match expected text`
        );
      }
    }
  });
});
