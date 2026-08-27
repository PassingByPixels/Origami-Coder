// composerImages.ts — the composer's image INTAKE: what a pasted or dropped
// file has to be, how it is read, and how an over-large one is shrunk.
//
// Extracted VERBATIM from InputBar.svelte, which was at its architecture cap
// when the collab composer needed the same intake. The ratchet's remedy is a
// module, never a raise — and the rules matter more now than they did with one
// caller, because two surfaces send the results to two different places.
//
// The refusals are the load-bearing part: each one NAMES the limit it hit. A
// user told only "refused" is left guessing which of three rules they broke,
// and a paste that silently does nothing reads as a broken composer.
//
// Everything below answers rather than throws: the caller decides what a
// refusal LOOKS like (the chat posts `imageError` to the host), and a promise
// that rejects into a paste handler would be an unhandled rejection.

/** The four types the engine's vision path can actually carry. */
export const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** The largest file that will be READ at all, before any resize. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
/** Anything longer on its longest side is scaled down and re-encoded. */
export const MAX_IMAGE_DIM = 2048;
/** A read that has not finished by now is treated as stuck, not as slow. */
export const READER_TIMEOUT_MS = 5000;

/** Attached, or refused with the reason to show. Never a rejected promise. */
export type ImageIntake =
  | { ok: true; name: string; dataUrl: string }
  | { ok: false; error: string };

/**
 * Resize images larger than {@link MAX_IMAGE_DIM} and re-encode as JPEG.
 *
 * A decode failure resolves the ORIGINAL rather than refusing: the bytes are
 * still a legal attachment, and dropping a picture because this optional
 * shrink could not run would be the wrong trade.
 */
export function resizeIfNeeded(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      if (img.width <= MAX_IMAGE_DIM && img.height <= MAX_IMAGE_DIM) {
        resolve(dataUrl);
        return;
      }
      const scale = MAX_IMAGE_DIM / Math.max(img.width, img.height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(dataUrl); // fallback: send as-is
    img.src = dataUrl;
  });
}

/** Validate, read and optionally resize ONE file. */
export function readComposerImage(file: File): Promise<ImageIntake> {
  if (!ALLOWED_MIME.includes(file.type)) {
    return Promise.resolve({ ok: false, error: `Unsupported image type: ${file.type}. Accepted: PNG, JPEG, GIF, WebP.` });
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return Promise.resolve({ ok: false, error: `Image too large (${(file.size / 1024 / 1024).toFixed(1)} MB, max 10 MB).` });
  }
  return new Promise<ImageIntake>((resolve) => {
    const reader = new FileReader();
    // The timer is cleared on BOTH outcomes: a read that finished at 4.9s must
    // not be reported as timed out at 5.0s.
    const timer = setTimeout(() => {
      reader.abort();
      resolve({ ok: false, error: 'Image read timed out.' });
    }, READER_TIMEOUT_MS);
    reader.onload = async () => {
      clearTimeout(timer);
      const dataUrl = await resizeIfNeeded(reader.result as string);
      resolve({ ok: true, name: file.name || 'pasted-image', dataUrl });
    };
    reader.onerror = () => {
      clearTimeout(timer);
      resolve({ ok: false, error: 'Failed to read image from clipboard.' });
    };
    reader.readAsDataURL(file);
  });
}
