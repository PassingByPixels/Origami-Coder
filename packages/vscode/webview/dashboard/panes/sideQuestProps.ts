// The SHAPE of one side quest as the webview sees it, and the props the drawer
// and the popup take (t-f89g49).
//
// Its own file for the reason subagentProps.ts is: three components and a dock
// pass the same rows around, and a type declared inside one `.svelte` instance
// script is not importable by the other two.
//
// This is the HOST's payload, narrowed — `sideQuestsData.quests` arrives as the
// engine's own file records (src/dashboard/sideQuestFile.ts). `status` is not
// here: the host only ever sends the OPEN ones, so a field the UI would have to
// filter on again is a second source of truth for the same question.

/** One open side quest, as the drawer and the popup render it. */
export interface SideQuest {
  /** `SQ-<n>`. The id every action is addressed by, and the only handle the
   *  webview ever holds — the host resolves it to a path, so a webview cannot
   *  name a file. */
  id: string;
  title: string;
  summary: string;
  /** '' when the raiser wrote none. */
  rationale: string;
  /** The brief a fresh agent starts from; Start sends this as the first message. */
  instructions: string;
  /** ISO 8601 as written by the engine, shown verbatim. */
  created: string;
}

/** The host payload this feature listens for. */
export interface SideQuestsData {
  type: 'sideQuestsData';
  quests: SideQuest[];
}

/** True for a `sideQuestsData` message with a usable `quests` array. A host that
 *  is older than this feature never sends one, so the shape is checked rather
 *  than assumed: an undefined `quests` would blank a drawer that has rows. */
export function isSideQuestsData(msg: unknown): msg is SideQuestsData {
  const m = msg as { type?: unknown; quests?: unknown } | null;
  return m?.type === 'sideQuestsData' && Array.isArray(m.quests);
}

/** Is this the PHONE page rather than the desk panel? The remote shell publishes
 *  `__ORIGAMI_REMOTE_READY__` on its own window (webview/remote/main.ts) and the
 *  desk panel never does, so its presence is the marker — the popup hides the
 *  three actions on a mount whose messages the desk's allowlist refuses anyway.
 *
 *  A PRESENTATION check and nothing more. The refusal that matters is
 *  remoteVerbsTable.ts's, on the desk, where a phone cannot edit it. */
export function isPhoneMount(w: unknown = typeof window === 'undefined' ? undefined : window): boolean {
  return (w as { __ORIGAMI_REMOTE_READY__?: unknown } | undefined)?.__ORIGAMI_REMOTE_READY__ !== undefined;
}
