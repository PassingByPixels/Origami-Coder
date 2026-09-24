// paneDrop.ts — ChatPane's pane-level drop fallback, extracted (ChatPane.svelte
// was at its architecture cap).
//
// A file dropped anywhere on the pane that is NOT the composer's own textarea
// used to fall through to the browser default: the webview navigating to the
// dropped file. This runs instead: find the ACTIVE session's textarea (the
// same `data-session-id` convention `scrollToBottom` in ChatPane.svelte uses
// to reach one cell in a multi-up grid — `bind:this` does not survive an
// `{#each}`) and re-dispatch a synthetic `drop` carrying the same
// DataTransfer, so InputBar's own `ondrop` runs its normal triage.
export function forwardPaneDropToComposer(
  activeSessionId: string | null | undefined,
  dt: DataTransfer,
  doc: Document = document,
): boolean {
  const el = doc.querySelector<HTMLTextAreaElement>(`textarea.input[data-session-id="${activeSessionId}"]`);
  if (!el) return false; // no active composer on screen (e.g. an empty pane)
  const forwarded = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
  // `dataTransfer` is a read-only getter on a real DragEvent — defineProperty
  // is what lets the synthetic one carry it through to InputBar's `ondrop`,
  // which reads nothing else off the event beyond it, `preventDefault` and
  // `stopPropagation`.
  Object.defineProperty(forwarded, 'dataTransfer', { value: dt, configurable: true });
  el.dispatchEvent(forwarded);
  return true;
}
