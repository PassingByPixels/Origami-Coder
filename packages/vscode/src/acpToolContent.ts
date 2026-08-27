// acpToolContent.ts — decode a `tool_call_update.content` array.
//
// Extracted from acpClient.ts's tool_call_update case, which sat against its
// architecture cap when the browser tool's SCREENSHOTS needed a third block
// kind. The array can carry several blocks at once (acp/tool.ts's
// completedToolContent pushes text, then any diff, then any image), and the
// donor read only `content[0]` — so an edit's diff was dropped. Reading the
// WHOLE array is the rule this module exists to keep:
//   { type:'content', content:{ type:'text' } }  -> the first one is the body
//   { type:'diff' }                              -> the structured before/after
//   { type:'content', content:{ type:'image' } } -> a data: URI, in order
// An image block is the `browser` tool's screenshot; every other tool sends
// none, so the field stays absent and no card changes.

export interface ToolContentBlocks {
  contentText?: string;
  diff?: { path: string; oldText: string; newText: string };
  /** Data URIs (`data:<mime>;base64,<data>`), ready for an <img src>. */
  images?: string[];
}

export function decodeToolContent(contents: unknown): ToolContentBlocks {
  const out: ToolContentBlocks = {};
  const images: string[] = [];
  if (!Array.isArray(contents)) return out;

  for (const entry of contents) {
    const e = entry as { type?: string };
    if (e?.type === 'content') {
      const inner = (entry as { content?: { type?: string; text?: string; data?: string; mimeType?: string } }).content;
      if (!inner) continue;
      if (inner.type === 'text' && typeof inner.text === 'string' && out.contentText === undefined) {
        out.contentText = inner.text;
      } else if (inner.type === 'image' && typeof inner.data === 'string' && typeof inner.mimeType === 'string') {
        images.push(`data:${inner.mimeType};base64,${inner.data}`);
      }
    } else if (e?.type === 'diff') {
      const d = entry as { path?: string; oldText?: string; newText?: string };
      out.diff = {
        path: typeof d.path === 'string' ? d.path : '',
        oldText: typeof d.oldText === 'string' ? d.oldText : '',
        newText: typeof d.newText === 'string' ? d.newText : '',
      };
    }
  }
  if (images.length) out.images = images;
  return out;
}
