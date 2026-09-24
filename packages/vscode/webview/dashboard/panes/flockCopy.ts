// flockCopy.ts — copy-to-clipboard, split out of FlockPane.svelte at its cap.
//
// navigator.clipboard is available in the webview and needs no host round
// trip; a failure is silent because the text beside the button is already
// selectable, which is the fallback.
export function copy(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {});
}
