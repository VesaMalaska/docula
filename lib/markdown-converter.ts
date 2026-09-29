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

const MARK_ORDER: Record<string, number> = {
  link: 0,
  bold: 1,
  italic: 2,
  strike: 3,
};

function markEquals(a: TiptapMark, b: TiptapMark): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "link") {
    return (a.attrs?.href || "") === (b.attrs?.href || "");
  }
  return true;
}

function getMarkOpenDelimiter(mark: TiptapMark): string {
  switch (mark.type) {
    case "bold":
      return "**";
    case "italic":
      return "*";
    case "strike":
      return "~~";
    case "link":
      return "[";
    default:
      return "";
  }
}

function getMarkCloseDelimiter(mark: TiptapMark): string {
  switch (mark.type) {
    case "bold":
      return "**";
    case "italic":
      return "*";
    case "strike":
      return "~~";
    case "link":
      return `](${mark.attrs?.href || ""})`;
    default:
      return "";
  }
}

/**
 * Serializes inline nodes (text, hardBreak, inline marks, etc.) as a continuous stream
 * tracking active mark stacks across node transitions.
 */
function serializeInline(nodes: TiptapNode[]): string {
  if (!nodes || nodes.length === 0) return "";

  let result = "";
  const activeMarks: TiptapMark[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    if (node.type === "hardBreak") {
      while (activeMarks.length > 0) {
        const closed = activeMarks.pop()!;
        result += getMarkCloseDelimiter(closed);
      }
      result += "  \n";
      continue;
    }

    if (node.type === "image") {
      while (activeMarks.length > 0) {
        const closed = activeMarks.pop()!;
        result += getMarkCloseDelimiter(closed);
      }
      const alt = node.attrs?.alt || "";
      const src = node.attrs?.src || "";
      if (src) {
        result += `![${alt}](${src})`;
      }
      continue;
    }

    const text = node.text || "";
    if (!text && (!node.content || node.content.length === 0)) {
      continue;
    }

    if (node.content && node.content.length > 0) {
      while (activeMarks.length > 0) {
        const closed = activeMarks.pop()!;
        result += getMarkCloseDelimiter(closed);
      }
      result += serializeInline(node.content);
      continue;
    }

    const nodeMarks = node.marks || [];
    const hasCodeMark = nodeMarks.some((m) => m.type === "code");

    if (hasCodeMark) {
      const linkMark = nodeMarks.find((m) => m.type === "link");
      const targetMarks: TiptapMark[] = linkMark ? [linkMark] : [];

      let commonLength = 0;
      while (
        commonLength < activeMarks.length &&
        commonLength < targetMarks.length &&
        markEquals(activeMarks[commonLength], targetMarks[commonLength])
      ) {
        commonLength++;
      }

      while (activeMarks.length > commonLength) {
        const closed = activeMarks.pop()!;
        result += getMarkCloseDelimiter(closed);
      }

      for (let m = commonLength; m < targetMarks.length; m++) {
        const openMark = targetMarks[m];
        result += getMarkOpenDelimiter(openMark);
        activeMarks.push(openMark);
      }

      result += `\`${text}\``;
      continue;
    }

    const validMarks = nodeMarks.filter((m) => MARK_ORDER[m.type] !== undefined);

    const targetMarks: TiptapMark[] = [];
    let activeMatchIndex = 0;
    while (activeMatchIndex < activeMarks.length) {
      const activeMark = activeMarks[activeMatchIndex];
      const foundInNode = validMarks.find((m) => markEquals(m, activeMark));
      if (foundInNode) {
        targetMarks.push(activeMark);
        activeMatchIndex++;
      } else {
        break;
      }
    }

    const remainingMarks = validMarks.filter(
      (m) => !targetMarks.some((tm) => markEquals(tm, m))
    );
    remainingMarks.sort(
      (a, b) => (MARK_ORDER[a.type] ?? 99) - (MARK_ORDER[b.type] ?? 99)
    );
    targetMarks.push(...remainingMarks);

    const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const leadingSpace = match ? match[1] : "";
    const coreText = match ? match[2] : "";
    const trailingSpace = match ? match[3] : "";

    if (!coreText) {
      if (activeMarks.length > 0 && targetMarks.length === activeMarks.length) {
        result += text;
      } else {
        let commonLength = 0;
        while (
          commonLength < activeMarks.length &&
          commonLength < targetMarks.length &&
          markEquals(activeMarks[commonLength], targetMarks[commonLength])
        ) {
          commonLength++;
        }
        while (activeMarks.length > commonLength) {
          const closed = activeMarks.pop()!;
          result += getMarkCloseDelimiter(closed);
        }
        for (let m = commonLength; m < targetMarks.length; m++) {
          const openMark = targetMarks[m];
          result += getMarkOpenDelimiter(openMark);
          activeMarks.push(openMark);
        }
        result += text;
      }
      continue;
    }

    let commonLength = 0;
    while (
      commonLength < activeMarks.length &&
      commonLength < targetMarks.length &&
      markEquals(activeMarks[commonLength], targetMarks[commonLength])
    ) {
      commonLength++;
    }

    while (activeMarks.length > commonLength) {
      const closed = activeMarks.pop()!;
      result += getMarkCloseDelimiter(closed);
    }

    if (leadingSpace) {
      result += leadingSpace;
    }

    for (let m = commonLength; m < targetMarks.length; m++) {
      const openMark = targetMarks[m];
      result += getMarkOpenDelimiter(openMark);
      activeMarks.push(openMark);
    }

    result += coreText;

    if (trailingSpace) {
      const nextNode = i + 1 < nodes.length ? nodes[i + 1] : null;
      const nextTargetMarks: TiptapMark[] = [];
      if (nextNode && nextNode.type === "text") {
        const nextNodeMarks = (nextNode.marks || []).filter((m) => MARK_ORDER[m.type] !== undefined);
        let idx = 0;
        while (idx < activeMarks.length) {
          const am = activeMarks[idx];
          if (nextNodeMarks.some((m) => markEquals(m, am))) {
            nextTargetMarks.push(am);
            idx++;
          } else {
            break;
          }
        }
      }

      if (activeMarks.length > nextTargetMarks.length) {
        while (activeMarks.length > nextTargetMarks.length) {
          const closed = activeMarks.pop()!;
          result += getMarkCloseDelimiter(closed);
        }
        result += trailingSpace;
      } else {
        result += trailingSpace;
      }
    }
  }

  while (activeMarks.length > 0) {
    const closed = activeMarks.pop()!;
    result += getMarkCloseDelimiter(closed);
  }

  return result;
}
