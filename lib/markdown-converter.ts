
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

export function jsonToMarkdown(content: TiptapNode): string {
  if (!content) return "";
  
  // If it's the root doc, process its content
  if (content.type === 'doc' && content.content) {
      return content.content.map(node => processNode(node)).join('');
  }
  
  return processNode(content);
}

function processNode(node: TiptapNode, parentType?: string, index?: number): string {
  const children = node.content ? node.content.map((n, i) => processNode(n, node.type, i)).join('') : '';
  const text = node.text || '';
  
  // Apply marks to text if present
  let processedText = text;
  if (node.marks) {
      node.marks.forEach(mark => {
          processedText = applyMark(processedText, mark);
      });
  }

  // Handle block types
  switch (node.type) {
      case 'paragraph':
          return `${children}${processedText}\n\n`;
      
      case 'heading':
          const level = node.attrs?.level || 1;
          return `${'#'.repeat(level)} ${children}${processedText}\n\n`;
      
      case 'bulletList':
          return `${children}\n`; 
      
      case 'orderedList':
          return `${children}\n`;

      case 'listItem':
          // Simple heuristic: if parent is orderedList, could try numbered, but keeping it simple with dash usually safe 
          // or we can just always use dash. To be better, we could pass context.
          // Let's assume generic usage first.
          // For proper nesting, we might need more logic, but essentially:
          if (parentType === 'orderedList' && typeof index === 'number') {
              return `${index + 1}. ${children}${processedText}\n`;
          }
          return `- ${children}${processedText}\n`;
      
      case 'codeBlock':
          const language = node.attrs?.language || '';
          // Code block contents are usually text nodes causing separate recursive calls.
          // But in Tiptap, the code block often has a single text child or multiple.
          // If children returns the code text, we wrap it.
          // Note: `children` here accumulates processed text. 
          // We need raw text usually for code blocks to avoid markdown escaping inside.
          // Let's use `node.content` directly to get raw text.
          const rawCode = node.content ? node.content.map(n => n.text).join('') : '';
          return `\`\`\`${language}\n${rawCode}\n\`\`\`\n\n`;

      case 'image':
          const alt = node.attrs?.alt || '';
          const src = node.attrs?.src || '';
          if (!src) return '';
          return `![${alt}](${src})\n\n`;
      
      case 'blockquote':
          const blockContent = (children + processedText).trim();
          return blockContent.split('\n').map(line => `> ${line}`).join('\n') + '\n\n';

      case 'horizontalRule':
          return '---\n\n';
          
      case 'hardBreak':
          return '  \n';

      case 'text':
          return processedText;

      default:
          return children + processedText;
  }
}

function applyMark(text: string, mark: TiptapMark): string {
    switch (mark.type) {
        case 'bold':
            return `**${text}**`;
        case 'italic':
            return `*${text}*`;
        case 'strike':
            return `~~${text}~~`;
        case 'code':
            return `\`${text}\``;
        case 'link':
            return `[${text}](${mark.attrs?.href || ''})`;
        default:
            return text;
    }
}
