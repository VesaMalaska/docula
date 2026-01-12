import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractImageUrls(content: any): string[] {
  if (!content) return [];
  const images = new Set<string>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function traverse(node: any) {
    if (node.type === 'image' && node.attrs?.src) {
      images.add(node.attrs.src);
    }
    if (node.content) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      node.content.forEach(traverse);
    }
  }

  traverse(content);
  return Array.from(images);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function replaceImageUrls(content: any, mapping: Record<string, string>): any {
  if (!content) return content;
  const newContent = JSON.parse(JSON.stringify(content));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function traverse(node: any) {
    if (node.type === 'image' && node.attrs?.src) {
      if (mapping[node.attrs.src]) {
        node.attrs.src = mapping[node.attrs.src];
      }
    }
    if (node.content) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      node.content.forEach(traverse);
    }
  }

  traverse(newContent);
  return newContent;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function stripImageParams(content: any): any {
    if(!content) return content;
    const newContent = JSON.parse(JSON.stringify(content));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function traverse(node: any) {
        if (node.type === 'image' && node.attrs?.src) {
            try {
                const url = new URL(node.attrs.src);
                url.search = "";
                node.attrs.src = url.toString();
            } catch {
                // Ignore invalid URLs
            }
        }
        if (node.content) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            node.content.forEach(traverse);
        }
    }
    traverse(newContent);
    return newContent;
}
