import { getSchema, Extension } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import Image from "@tiptap/extension-image";

/**
 * Base editor extensions providing core nodes and marks for ProseMirror schema construction.
 */
export const coreEditorExtensions: Extension[] = [
  StarterKit.configure({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    link: false as any,
  }),
  Image,
  Link.configure({
    openOnClick: false,
    autolink: true,
  }),
  Table.configure({
    resizable: true,
  }),
  TableRow,
  TableHeader,
  TableCell,
] as unknown as Extension[];

let cachedSchema: Schema | null = null;

/**
 * Returns the cached ProseMirror Schema corresponding to Docula's editor configuration.
 */
export function getEditorSchema(): Schema {
  if (!cachedSchema) {
    cachedSchema = getSchema(coreEditorExtensions);
  }
  return cachedSchema;
}
