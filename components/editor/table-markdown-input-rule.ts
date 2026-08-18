import { Extension } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';

export const TableMarkdownInputRule = Extension.create({
  name: 'tableMarkdownInputRule',

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { state, view } = editor;
        const { selection, tr, schema } = state;
        const { $from, empty } = selection;

        // Ensure we are in an empty selection (not selecting multiple things)
        if (!empty) return false;

        const parent = $from.parent;
        // Only trigger inside normal paragraphs
        if (parent.type.name !== 'paragraph') return false;

        const text = parent.textContent;
        // Match things like "| col 1 | col 2 |" or "|col1|col2|" at the end of the line
        const match = text.match(/^\|(?:[^\n|]*\|)+$/);
        
        // Ensure the entire paragraph matches and cursor is at the very end
        if (!match || text.length === 0 || $from.parentOffset !== text.length) return false;

        // Parse columns
        const columns = text.split('|').map(s => s.trim());
        if (columns.length > 0 && columns[0] === '') columns.shift();
        if (columns.length > 0 && columns[columns.length - 1] === '') columns.pop();
        
        if (columns.length === 0) return false;

        const tableRow = schema.nodes.tableRow;
        const tableHeader = schema.nodes.tableHeader;
        const tableCell = schema.nodes.tableCell;
        const paragraph = schema.nodes.paragraph;

        if (!tableRow || !tableHeader || !tableCell || !paragraph || !schema.nodes.table) {
            return false;
        }

        // Build header cells
        const headerCells = columns.map(colText => {
          const textNode = colText ? schema.text(colText) : undefined;
          const pNode = paragraph.create(null, textNode ? [textNode] : []);
          return tableHeader.create(null, pNode);
        });

        // Build body cells (1 row of empty cells)
        const bodyCells = columns.map(() => {
          const pNode = paragraph.create(null, []);
          return tableCell.create(null, pNode);
        });

        const headerRowNode = tableRow.create(null, headerCells);
        const bodyRowNode = tableRow.create(null, bodyCells);

        const tableNode = schema.nodes.table.create(null, [headerRowNode, bodyRowNode]);

        // Replace the current paragraph with the table
        const start = $from.before();
        const end = $from.after();
        
        tr.replaceWith(start, end, tableNode);
        
        const headerRowSize = headerRowNode.nodeSize;
        const firstBodyCellPos = start + 1 + headerRowSize + 1 + 1;
        
        try {
           const $pos = tr.doc.resolve(firstBodyCellPos);
           if ($pos.parent.type === paragraph) {
              tr.setSelection(Selection.near($pos));
           }
        } catch (err) {
            // fallback
        }

        view.dispatch(tr);
        return true;
      },
    };
  },
});
