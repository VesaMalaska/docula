
import { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, ExternalHyperlink } from "docx";

// Tiptap types (reused or imported if available in types.ts)
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

export async function jsonToDocx(content: TiptapNode, spaceId: string, docId: string, idToken?: string): Promise<Blob> {
    if (!content) return new Blob();

    const children: (Paragraph)[] = [];

    if (content.type === 'doc' && content.content) {
        for (const node of content.content) {
            const paragraphs = await processNode(node, spaceId, docId, idToken);
            children.push(...paragraphs);
        }
    } else {
        children.push(...await processNode(content, spaceId, docId, idToken));
    }

    const doc = new Document({
        sections: [{
            properties: {},
            children: children,
        }],
    });

    return await Packer.toBlob(doc);
}

async function processNode(node: TiptapNode, spaceId: string, docId: string, idToken?: string): Promise<Paragraph[]> {
    const paragraphs: Paragraph[] = [];

    switch (node.type) {
        case 'paragraph':
            paragraphs.push(new Paragraph({
                children: await processInlineContent(node),
                spacing: { after: 120 }
            }));
            break;
        
        case 'heading':
            paragraphs.push(new Paragraph({
                text: node.content?.map(c => c.text).join('') || '',
                heading: getHeadingLevel(node.attrs?.level),
                spacing: { after: 120, before: 240 }
            }));
            break;
        
        case 'bulletList':
            if (node.content) {
                for (const listItem of node.content) {
                     paragraphs.push(...await processListItem(listItem, false, spaceId, docId, idToken));
                }
            }
            break;
        
        case 'orderedList':
             if (node.content) {
                for (const listItem of node.content) {
                     paragraphs.push(...await processListItem(listItem, true, spaceId, docId, idToken));
                }
            }
            break;

        case 'codeBlock':
             paragraphs.push(new Paragraph({
                children: [new TextRun({
                    text: node.content?.map(c => c.text).join('\n') || '',
                    font: "Courier New",
                })],
                spacing: { after: 120 }
            }));
            break;
        
        case 'image':
             const src = node.attrs?.src;
             if (src) {
                 try {
                     const urlObj = new URL(src);
                     
                     // Check if it's a Docula-managed presigned GET URL or S3 URL
                     if (urlObj.hostname.includes("amazonaws.com") && (urlObj.pathname.includes("/uploads/") || urlObj.pathname.includes("/temp/"))) {
                         // Fetch through the secure document-image route
                         let token = idToken;
                         if (!token) {
                             const { auth } = await import("@/lib/firebase");
                             token = await auth.currentUser?.getIdToken();
                         }

                         if (!token) {
                             paragraphs.push(new Paragraph({ text: "[Image unavailable]" }));
                             break;
                         }

                         const cleanKey = urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname;
                         const proxyUrl = `/api/document-image?spaceId=${encodeURIComponent(spaceId)}&docId=${encodeURIComponent(docId)}&key=${encodeURIComponent(cleanKey)}`;

                         const response = await fetch(proxyUrl, {
                             headers: {
                                 "Authorization": `Bearer ${token}`
                             }
                         });

                         if (!response.ok) throw new Error(`Failed to fetch image via proxy: ${response.status}`);

                         const blob = await response.blob();
                         const buffer = await blob.arrayBuffer();

                         const extension = blob.type.split('/')[1]?.toLowerCase();
                         let type: "jpg" | "png" | "gif" | "bmp" = "png";
                         if (extension === 'jpeg' || extension === 'jpg') type = "jpg";
                         else if (extension === 'gif') type = "gif";
                         else if (extension === 'bmp') type = "bmp";
                         else if (extension === 'png') type = "png";

                         paragraphs.push(new Paragraph({
                             children: [
                                 new ImageRun({
                                     data: buffer,
                                     transformation: {
                                         width: 400,
                                         height: 300,
                                     },
                                     type: type,
                                 })
                             ]
                         }));
                     } else {
                         // External image: Do not fetch. Preserve URL as text link.
                         paragraphs.push(new Paragraph({
                             children: [
                                 new ExternalHyperlink({
                                     children: [
                                         new TextRun({
                                             text: `External image: ${src}`,
                                             style: "Hyperlink",
                                         })
                                     ],
                                     link: src,
                                 })
                             ]
                         }));
                     }
                 } catch (e) {
                     console.error("Failed to load image for docx export:", e instanceof Error ? e.message : "Unknown error");
                     paragraphs.push(new Paragraph({ text: "[Image unavailable]" }));
                 }
             }
             break;

        case 'blockquote':
              if (node.content) {
                  for (const child of node.content) {
                      const childParas = await processNode(child, spaceId, docId, idToken);
                      childParas.forEach(p => {
                          paragraphs.push(p);
                      });
                  }
              }
             break;

        case 'horizontalRule':
             paragraphs.push(new Paragraph({
                 border: {
                     bottom: {
                         color: "auto",
                         space: 1,
                         style: "single",
                         size: 6,
                     }
                 }
             }));
             break;

        default:
             if (node.content) {
                 for (const child of node.content) {
                     paragraphs.push(...await processNode(child, spaceId, docId, idToken));
                 }
             }
             break;
    }

    return paragraphs;
}

async function processListItem(node: TiptapNode, ordered: boolean, spaceId: string, docId: string, idToken?: string): Promise<Paragraph[]> {
    const paragraphs: Paragraph[] = [];
    // List item content is usually a paragraph
    if (node.content) {
        for (const child of node.content) {
            // If child is paragraph, convert to list item paragraph
            if (child.type === 'paragraph') {
                 paragraphs.push(new Paragraph({
                    children: await processInlineContent(child),
                    bullet: {
                        level: 0, 
                    }
                }));
            } else {
                 paragraphs.push(...await processNode(child, spaceId, docId, idToken));
            }
        }
    }
    return paragraphs;
}

async function processInlineContent(node: TiptapNode): Promise<(TextRun | ExternalHyperlink | ImageRun)[]> {
    if (!node.content) return [];
    
    const runs: (TextRun | ExternalHyperlink | ImageRun)[] = [];
    
    for (const child of node.content) {
        if (child.type === 'text') {
            const text = child.text || '';
            const marks = child.marks || [];
            
            let bold = false;
            let italics = false;
            let strike = false;
            let code = false;
            let link = null;

            marks.forEach(mark => {
                if (mark.type === 'bold') bold = true;
                if (mark.type === 'italic') italics = true;
                if (mark.type === 'strike') strike = true;
                if (mark.type === 'code') code = true;
                if (mark.type === 'link') link = mark.attrs?.href;
            });

            const textRun = new TextRun({
                text: text,
                bold: bold,
                italics: italics,
                strike: strike,
                font: code ? "Courier New" : undefined,
            });

            if (link) {
                runs.push(new ExternalHyperlink({
                    children: [textRun],
                    link: link,
                }));
            } else {
                runs.push(textRun);
            }
        }
        // Handle hard break
        else if (child.type === 'hardBreak') {
             runs.push(new TextRun({ break: 1 }));
        }
    }
    return runs;
}

function getHeadingLevel(level?: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
    switch (level) {
        case 1: return HeadingLevel.HEADING_1;
        case 2: return HeadingLevel.HEADING_2;
        case 3: return HeadingLevel.HEADING_3;
        case 4: return HeadingLevel.HEADING_4;
        case 5: return HeadingLevel.HEADING_5;
        case 6: return HeadingLevel.HEADING_6;
        default: return HeadingLevel.HEADING_1;
    }
}
