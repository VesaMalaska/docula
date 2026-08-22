export interface BlockStyleOption {
  id: "paragraph" | "h1" | "h2" | "h3" | "h4";
  label: string;
  level?: 1 | 2 | 3 | 4;
}

export const BLOCK_STYLE_OPTIONS: BlockStyleOption[] = [
  { id: "paragraph", label: "Paragraph" },
  { id: "h1", label: "Heading 1", level: 1 },
  { id: "h2", label: "Heading 2", level: 2 },
  { id: "h3", label: "Heading 3", level: 3 },
  { id: "h4", label: "Heading 4", level: 4 },
];

export interface ActiveChecker {
  isActive: (name: string, attributes?: Record<string, unknown>) => boolean;
}

/**
 * Resolves the currently active block style from editor state.
 * Returns one of Paragraph, Heading 1, Heading 2, Heading 3, or Heading 4.
 */
export function getCurrentBlockStyle(editor?: ActiveChecker | null): BlockStyleOption {
  if (!editor) {
    return BLOCK_STYLE_OPTIONS[0];
  }

  if (editor.isActive("heading", { level: 1 })) {
    return BLOCK_STYLE_OPTIONS[1];
  }
  if (editor.isActive("heading", { level: 2 })) {
    return BLOCK_STYLE_OPTIONS[2];
  }
  if (editor.isActive("heading", { level: 3 })) {
    return BLOCK_STYLE_OPTIONS[3];
  }
  if (editor.isActive("heading", { level: 4 })) {
    return BLOCK_STYLE_OPTIONS[4];
  }

  return BLOCK_STYLE_OPTIONS[0];
}

export interface BlockStyleApplicable {
  chain: () => {
    focus: () => {
      setHeading: (options: { level: 1 | 2 | 3 | 4 }) => { run: () => boolean };
      setParagraph: () => { run: () => boolean };
    };
  };
}

/**
 * Applies the selected block style using deterministic Tiptap commands.
 * Uses setHeading({ level }) for headings and setParagraph() for paragraph.
 */
export function applyBlockStyle(
  editor: BlockStyleApplicable | null | undefined,
  option: BlockStyleOption
): boolean {
  if (!editor) return false;
  if (option.level) {
    return editor.chain().focus().setHeading({ level: option.level }).run();
  }
  return editor.chain().focus().setParagraph().run();
}
