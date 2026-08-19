interface TiptapNode {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attrs?: Record<string, any>;
  content?: TiptapNode[];
  marks?: TiptapMark[];
  text?: string;
}

interface TiptapMark {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attrs?: Record<string, any>;
}

/**
 * Converts a Tiptap JSON document AST into clean, deterministic Markdown.
 *
 * Spacing Policy:
 * - Normal top-level blocks are separated by exactly one blank line (\n\n).
 * - Compact lists have items separated by a single newline (\n).
 * - Code blocks preserve internal whitespace without modification.
 * - Non-empty documents terminate with exactly one newline (\n).
 * - Empty documents return an empty string ("").
 */
export function jsonToMarkdown(content?: TiptapNode | null): string {
  if (!content) return "";

  if (content.type === "doc") {
    const blocks = content.content || [];
    const serializedBlocks = blocks
      .map((block) => serializeBlock(block))
      .filter((blockStr) => blockStr.length > 0);

    if (serializedBlocks.length === 0) {
      return "";
    }

    return `${serializedBlocks.join("\n\n")}\n`;
  }

  const singleBlock = serializeBlock(content);
  return singleBlock ? `${singleBlock}\n` : "";
}

/**
 * Serializes a block-level node into its Markdown representation without trailing blank lines.
 */
function serializeBlock(node: TiptapNode, depth: number = 0): string {
  switch (node.type) {
    case "paragraph":
      return serializeInline(node.content || []);

    case "heading": {
      const rawLevel = typeof node.attrs?.level === "number" ? node.attrs.level : 1;
      const level = Math.min(Math.max(rawLevel, 1), 6);
      const text = serializeInline(node.content || []);
      return `${"#".repeat(level)} ${text}`;
    }

    case "bulletList":
    case "orderedList":
      return serializeList(node, depth);

    case "codeBlock": {
      const language = node.attrs?.language || "";
      const rawCode = node.content
        ? node.content.map((n) => n.text || "").join("")
        : node.text || "";
      return `\`\`\`${language}\n${rawCode}\n\`\`\``;
    }

    case "image": {
      const alt = node.attrs?.alt || "";
      const src = node.attrs?.src || "";
      if (!src) return "";
      return `![${alt}](${src})`;
    }

    case "blockquote": {
      const childBlocks = (node.content || [])
        .map((child) => serializeBlock(child, depth))
        .filter((str) => str.length > 0);

      if (childBlocks.length === 0) {
        return ">";
      }

      const joined = childBlocks.join("\n\n");
      return joined
        .split("\n")
        .map((line) => (line.trim().length > 0 ? `> ${line}` : ">"))
        .join("\n");
    }

    case "horizontalRule":
      return "---";

    case "table":
      return serializeTable(node);

    default:
      if (node.content && node.content.length > 0) {
        return serializeInline(node.content);
      }
      return node.text || "";
  }
}

/**
 * Serializes bullet and ordered lists with support for nesting and custom start indices.
 */
function serializeList(listNode: TiptapNode, indentLevel: number = 0): string {
  const isOrdered = listNode.type === "orderedList";
  const start = isOrdered && typeof listNode.attrs?.start === "number" ? listNode.attrs.start : 1;
  const items = listNode.content || [];

  const serializedItems: string[] = [];

  items.forEach((itemNode, index) => {
    if (itemNode.type !== "listItem") {
      const fallback = serializeBlock(itemNode, indentLevel);
      if (fallback) serializedItems.push(fallback);
      return;
    }

    const itemIndent = "  ".repeat(indentLevel);
    const marker = isOrdered ? `${start + index}. ` : "- ";
    const prefix = `${itemIndent}${marker}`;

    const childNodes = itemNode.content || [];
    if (childNodes.length === 0) {
      serializedItems.push(prefix.trimEnd());
      return;
    }

    const lines: string[] = [];
    let isFirstBlock = true;

    childNodes.forEach((child) => {
      if (child.type === "bulletList" || child.type === "orderedList") {
        const nestedListStr = serializeList(child, indentLevel + 1);
        if (nestedListStr) {
          lines.push(nestedListStr);
        }
      } else {
        const blockContent = serializeBlock(child, indentLevel);
        if (isFirstBlock) {
          lines.push(`${prefix}${blockContent}`);
          isFirstBlock = false;
        } else {
          // Indent subsequent block children inside the same list item
          const contIndent = "  ".repeat(indentLevel + 1);
          const indentedContent = blockContent
            .split("\n")
            .map((line) => (line ? `${contIndent}${line}` : line))
            .join("\n");
          lines.push(indentedContent);
        }
      }
    });

    serializedItems.push(lines.join("\n"));
  });

  return serializedItems.join("\n");
}

/**
 * Serializes table nodes into Markdown table format.
 */
function serializeTable(node: TiptapNode): string {
  const rows = node.content || [];
  if (rows.length === 0) return "";

  const tableLines: string[] = [];
  let headerCellsCount = 0;

  rows.forEach((row, rowIndex) => {
    if (row.type !== "tableRow") return;
    const cells = row.content || [];
    if (rowIndex === 0) {
      headerCellsCount = cells.length;
    }

    const cellTexts = cells.map((cell) => {
      const cellContent = (cell.content || [])
        .map((c) => serializeBlock(c))
        .join(" ")
        .replace(/\n+/g, " ")
        .trim();
      return cellContent;
    });

    tableLines.push(`| ${cellTexts.join(" | ")} |`);

    if (rowIndex === 0) {
      const delimiters = Array(headerCellsCount || 1).fill("---");
      tableLines.push(`| ${delimiters.join(" | ")} |`);
    }
  });

  return tableLines.join("\n");
}

/**
 * Serializes inline nodes (text, hardBreak, inline marks, etc.) without adding trailing newlines.
 */
function serializeInline(nodes: TiptapNode[]): string {
  return nodes.map((node) => processInlineNode(node)).join("");
}

function processInlineNode(node: TiptapNode): string {
  switch (node.type) {
    case "text": {
      let text = node.text || "";
      if (node.marks && node.marks.length > 0) {
        node.marks.forEach((mark) => {
          text = applyMark(text, mark);
        });
      }
      return text;
    }

    case "hardBreak":
      return "  \n";

    case "image": {
      const alt = node.attrs?.alt || "";
      const src = node.attrs?.src || "";
      if (!src) return "";
      return `![${alt}](${src})`;
    }

    default:
      if (node.text) {
        let text = node.text;
        if (node.marks) {
          node.marks.forEach((mark) => {
            text = applyMark(text, mark);
          });
        }
        return text;
      }
      if (node.content) {
        return serializeInline(node.content);
      }
      return "";
  }
}

/**
 * Wraps text with appropriate Markdown formatting according to the mark type.
 */
function applyMark(text: string, mark: TiptapMark): string {
  switch (mark.type) {
    case "bold":
      return `**${text}**`;
    case "italic":
      return `*${text}*`;
    case "strike":
      return `~~${text}~~`;
    case "code":
      return `\`${text}\``;
    case "link": {
      const href = mark.attrs?.href || "";
      return `[${text}](${href})`;
    }
    default:
      return text;
  }
}
