// chatBackdropClass.ts — t-qn0wj5, proposal 24 (port of Mock-Redesign CHANGES.md
// #38). Pure so the AND-of-two-gates is testable with no render; ChatPane.svelte
// (at 2453/2477 lines) calls this once and binds the result to a class.
export function chatBackdropOn(settingOn: boolean, reducedMotion: boolean): boolean {
  return settingOn && !reducedMotion;
}

/** t-s9jr6u: the Settings view's backdrop row writes the setting, and the
 *  host BROADCASTS `chatBackdropData`, so an open chat pane follows it without
 *  a reload. Returns the unsubscribe, for an $effect. */
export function watchChatBackdrop(onChange: (on: boolean) => void): () => void {
  const onMsg = (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type === 'chatBackdropData' && typeof msg.enabled === 'boolean') onChange(msg.enabled);
  };
  window.addEventListener('message', onMsg);
  return () => window.removeEventListener('message', onMsg);
}
