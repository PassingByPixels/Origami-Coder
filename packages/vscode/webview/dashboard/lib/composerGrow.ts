// composerGrow.ts — the composer textarea's auto-grow math.
//
// Pure on purpose: jsdom (InputBar.test.ts) reports scrollHeight as 0, so the
// resize logic has to be a function of numbers, not something only provable
// against a real layout engine. InputBar.svelte supplies the numbers (measured
// off computed style) and applies the result; this file just does the clamp.

export interface GrowInput {
  scrollHeight: number;
  lineHeight: number;
  padding: number;
  minRows: number;
  maxRows: number;
}

export interface GrowResult {
  height: number;
  overflow: 'hidden' | 'auto';
}

export function growHeight({ scrollHeight, lineHeight, padding, minRows, maxRows }: GrowInput): GrowResult {
  const minHeight = minRows * lineHeight + padding;
  const maxHeight = maxRows * lineHeight + padding;
  const height = Math.min(Math.max(scrollHeight, minHeight), maxHeight);
  return { height, overflow: scrollHeight > maxHeight ? 'auto' : 'hidden' };
}
