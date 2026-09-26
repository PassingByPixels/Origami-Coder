// Desk-only verbs, named as refused for the phone (t-x3a89j). A leaf of its own: remoteRefusalsTable.ts is at
// its cap and its header says extract, do not raise. Not consulted at runtime (default-deny needs no deny-list);
// listed so remoteVerbsCoverage.test.ts sees the refusal was a decision.
//
// `chatFocus`: the DESKTOP sidebar's keyboard focus decides which grid tile is the chat the user works in
// (elastic/sessionSignals.ts). The phone runs the same bundle; its page focus must not set the desk's. The
// phone's own chat is `remote/focus`. `sidebarChat` (t-xp0dzr): the chat the DESKTOP sidebar displays, the same
// reason. `openEngineLog`: opens a file in the desk's editor, for nobody holding the phone (the same reason
// `exportSession` is refused).
export const DESK_REFUSALS: readonly string[] = ['chatFocus', 'sidebarChat', 'openEngineLog'];
