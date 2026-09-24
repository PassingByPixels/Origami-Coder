// composerAttachments.ts — the composer's NON-IMAGE drop intake: what a
// dropped file becomes when it is not a picture.
//
// Mirrors composerImages.ts's shape (FileReader-based, answers rather than
// throws, so a bad file cannot become an unhandled promise rejection in a
// drop handler) so the composer's two intake paths read the same way.

/** The largest text attachment KEPT — a file bigger than this is truncated,
 *  not refused, and the block sent to the model says so. */
export const MAX_TEXT_CHARS = 256 * 1024; // 256 KB
/** How far into the file we look for a NUL byte before calling it binary. */
export const BINARY_SNIFF_CHARS = 8 * 1024; // 8 KB

export type TextAttachmentIntake =
  | { kind: 'text'; name: string; content: string; truncated: boolean }
  | { kind: 'binary'; name: string };

/**
 * Read a dropped file as text. A NUL byte in the first {@link BINARY_SNIFF_CHARS}
 * means "not text" — the caller inserts the file NAME only, no chip and no
 * error, the same as an editor declining to open a binary rather than
 * complaining about it.
 */
// Built via fromCharCode rather than typed as an escape sequence, so no tool
// in the chain ever has to round-trip a literal control character.
const NUL = String.fromCharCode(0);

export function readTextAttachment(file: File): Promise<TextAttachmentIntake> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const full = String(reader.result ?? '');
      if (full.slice(0, BINARY_SNIFF_CHARS).includes(NUL)) {
        resolve({ kind: 'binary', name: file.name || 'attachment' });
        return;
      }
      const truncated = full.length > MAX_TEXT_CHARS;
      resolve({ kind: 'text', name: file.name || 'attachment', content: truncated ? full.slice(0, MAX_TEXT_CHARS) : full, truncated });
    };
    // A read failure is not a reason to lose the caret insertion the caller
    // already made — fall back to "binary" (name only) rather than throwing.
    reader.onerror = () => resolve({ kind: 'binary', name: file.name || 'attachment' });
    reader.readAsText(file);
  });
}

/** A file attached whole: its content rides in the outgoing prompt (see
 *  {@link foldAttachments}), never through the host's image route. */
export interface TextAttachmentFile { id: number; name: string; content: string; truncated: boolean; }

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
/** A file counts as an image if its MIME says so, or — an OS drag can hand
 *  over an empty MIME — its extension is one a picture uses. A file with a
 *  REAL non-image MIME never falls into the extension check. */
export function looksLikeImage(file: File): boolean {
  if (file.type) return file.type.startsWith('image/');
  const ext = file.name.split('.').pop()?.toLowerCase();
  return !!ext && IMAGE_EXTENSIONS.includes(ext);
}

/** Fold this turn's text attachments into the outgoing prompt, one block each,
 *  AFTER the user's own words. A no-op with none attached, so every existing
 *  send path is unchanged when nothing was dropped. */
export function foldAttachments(text: string, attachments: TextAttachmentFile[]): string {
  if (attachments.length === 0) return text;
  const blocks = attachments
    .map((a) => `<attached-file name="${a.name.replace(/"/g, '&quot;')}" truncated="${a.truncated}">\n${a.content}\n</attached-file>`)
    .join('\n');
  return text ? `${text}\n\n${blocks}` : blocks;
}
