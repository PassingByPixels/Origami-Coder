// droppedFiles.ts (t-z69b8m) — the HOST half of a composer drop from the VS Code
// explorer. The webview gets URIs only (it has no fs), so it posts
// `readDroppedFiles { dropId, uris }`; this reads each file and answers
// `droppedFiles { dropId, files: [{ name, mime, base64 }] }`. The composer then
// runs its normal image / text intake on the bytes (composerDropIntake.ts).
// The fs is injected so the rules are testable without an extension host.

/** Same ceiling as the composer's image intake; a text file is cut to 256 KB there. */
export const MAX_DROP_BYTES = 10 * 1024 * 1024;

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
};

export interface DropFs {
  /** Size in bytes, or null when the URI is not a readable FILE (missing, a folder). */
  fileSize(uri: string): Promise<number | null>;
  read(uri: string): Promise<Uint8Array>;
}

export interface DroppedFile { name: string; mime: string; base64: string }

function baseName(uri: string): string {
  const path = decodeURIComponent(uri.replace(/[?#].*$/, ''));
  return path.split(/[\\/]/).filter(Boolean).pop() || 'attachment';
}

/** Read what can be read; skip the rest and name it in `skipped`. Never throws. */
export async function readDroppedFiles(uris: unknown, fs: DropFs): Promise<{ files: DroppedFile[]; skipped: string[] }> {
  const files: DroppedFile[] = [];
  const skipped: string[] = [];
  for (const uri of Array.isArray(uris) ? uris : []) {
    if (typeof uri !== 'string' || !uri) continue;
    const name = baseName(uri);
    try {
      const size = await fs.fileSize(uri);
      if (size === null || size > MAX_DROP_BYTES) { skipped.push(name); continue; }
      const bytes = await fs.read(uri);
      const ext = name.split('.').pop()?.toLowerCase() ?? '';
      // Not an image: `text/plain` so the composer's text intake takes it (it sniffs binary itself).
      files.push({ name, mime: MIME[ext] ?? 'text/plain', base64: Buffer.from(bytes).toString('base64') });
    } catch {
      skipped.push(name);
    }
  }
  return { files, skipped };
}
