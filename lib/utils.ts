import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function extractImageUrls(content: any): string[] {
    const urls: string[] = [];
    function traverse(node: any) {
        if (!node) return;
        if (node.type === 'image' && node.attrs?.src) {
            urls.push(node.attrs.src);
        }
        if (node.content) {
            node.content.forEach(traverse);
        }
    }
    if (content) traverse(content);
    return urls;
}

export function replaceImageUrls(content: any, mapping: Record<string, string>): any {
    if (!content) return content;
    
    // Deep clone to avoid mutating original state
    const newContent = JSON.parse(JSON.stringify(content));

    function traverse(node: any) {
        if (!node) return;
        if (node.type === 'image' && node.attrs?.src) {
            if (mapping[node.attrs.src]) {
                node.attrs.src = mapping[node.attrs.src];
            }
        }
        if (node.content) {
            node.content.forEach(traverse);
        }
    }
    traverse(newContent);
    return newContent;
}

export function stripImageParams(content: any): any {
    if (!content) return content;
    
    // Deep clone
    const newContent = JSON.parse(JSON.stringify(content));

    function traverse(node: any) {
        if (!node) return;
        if (node.type === 'image' && node.attrs?.src) {
            try {
                const url = new URL(node.attrs.src);
                // Reset search (query params) to empty
                url.search = "";
                node.attrs.src = url.toString();
            } catch (e) {
                // Invalid URL, ignore
            }
        }
        if (node.content) {
            node.content.forEach(traverse);
        }
    }
    traverse(newContent);
    return newContent;
}
