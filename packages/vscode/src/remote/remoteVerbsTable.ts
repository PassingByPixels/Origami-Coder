// Origami Remote — the allowlist DATA, kept out of remoteVerbs.ts so that file
// stays the predicates. This is the FULL surface the phone can reach: it runs
// the exact dashboard bundle, so every literal `postMessage({ type: ... })` in
// the shipped webview source has a row here or a name in `NAMED_REFUSALS`.
// `remoteVerbsCoverage.test.ts` re-derives that list and fails on anything with
// neither, so a new shell message cannot go silently dead or silently live.

export type RemoteCapability = 'watch' | 'ask' | 'full';

/** The LEAST capability envelope that admits a verb. */
export type VerbNeeds = RemoteCapability;

/** ADDING A ROW HERE IS THE REVIEW. Anything absent is refused. */
export const PHONE_VERBS: ReadonlyMap<string, VerbNeeds> = new Map<string, VerbNeeds>([
  // The handshake and device identity. Answered before the gate in `inbound.ts`.
  ['remote/hello', 'watch'],
  ['remote/challenge-response', 'watch'],
  ['remote/snapshot', 'watch'],
  // Which chat the phone is READING, so outbound scoping stops filtering it
  // (`inbound.ts` acts on it and never delivers it). A read, so `watch`.
  ['remote/focus', 'watch'],
  // What the page HOLDS, re-declared after each restore. Cursors and nothing
  // else: `remote/snapshot` means "hydrate me" and this frame must not, or every
  // screen-off/on would cash in a burst (`hydrateGate.ts`). A read, so `watch`.
  ['remote/cursors', 'watch'],
  // Dropping authority, or reading, is always free. cancel/stopBackgroundShell
  // stop a running turn or shell; the rest is UI-local state no different from
  // scrolling, or a read-back that happens not to start with `request`.
  ['cancel', 'watch'],
  ['stopBackgroundShell', 'watch'],
  ['soloSession', 'watch'],
  ['activeSessionChanged', 'watch'],
  ['chatGridMode', 'watch'],
  ['toggleChatSectionCollapse', 'watch'],
  ['setCollabsCollapsed', 'watch'],
  ['resizeCollabsSection', 'watch'],
  ['setChatDensity', 'watch'], // t-qn0wj5 proposal 26 — a local, per-window UI preference, same tier as the two rows above
  ['setScheduleTab', 'watch'], // t-ru1qsp — which Schedules tab (Crons/Loops) is open, same tier as setChatDensity
  ['themeChanged', 'watch'],
  ['cacheStats', 'watch'],
  ['imageError', 'watch'],
  ['providerUsageRequest', 'watch'],
  ['providerUsageCapableRequest', 'watch'],
  ['glidepathRequest', 'watch'],
  ['flockMailboxRequest', 'watch'],
  ['listCollabAgentDefs', 'watch'],
  ['collabPoll', 'watch'],
  ['collabPreview', 'watch'],
  ['openAgentManager', 'watch'],
  ['openBoardSection', 'watch'],
  ['openBotsSection', 'watch'],
  ['openConnections', 'watch'],
  // t-dclj7z: the sidebar's workspace-wide roster count. It reveals the desk
  // panel and names the chat whose sub-agent drawer to pull out — a pane-local
  // view change, exactly like the four `open*` rows above it. It starts no
  // turn, answers no ask, sends nothing out and cannot reach a chat the host
  // does not already hold (DashboardPanel checks `this.sessions`), so `watch`.
  ['openSubagentDrawer', 'watch'],
  // t-f89g49: the Side quests pull-out, by the same reasoning one line up. It
  // reveals a pane-local view of a FOLDER the phone may already read through
  // `requestSideQuests` (the prefix rule), starts no turn, answers no ask and
  // sends nothing out. The three ACTIONS on a row are a different question and
  // are refused by name below.
  ['openSideQuestsDrawer', 'watch'],
  // t-fiszlv R9: retiring one row from the sub-agent drawer. It records the
  // key in the workspace memento for that chat and nothing else — no turn, no
  // ask, nothing sent out, and it cannot reach a chat the host does not already
  // hold. The same class of pane-local view state as the rows above, so `watch`.
  ['dismissSubagent', 'watch'],
  // Driving the session and organising work. `permission` and `remote/set-mode*`
  // drop to `watch` when they HAND authority back (see `verbNeeds`); `setMode` is
  // the AGENT mode and cannot reach bypass — that lives only under the signed
  // `remote/set-mode`. `slashCommand` rides this row EXCEPT the two spellings
  // that reach the unsigned bypass path, which `verbNeeds` refuses by name.
  ['send', 'ask'],
  ['sendWithImages', 'ask'],
  ['engineRetry', 'ask'], // t-v5qn37: start a chat's failed engine again, which sends the prompt it holds — the same reach as `send`
  ['interject', 'ask'],
  ['secondOpinion', 'ask'],
  // t-v5qv6u: the composer's Fork button. It opens a NEW chat holding a copy of
  // one the phone can already see, and writes nothing into that chat. The same
  // tier as `newSession` and `recallSession`, which also open a chat, so `ask`.
  ['forkChat', 'ask'],
  ['slashCommand', 'ask'],
  ['setMode', 'ask'],
  ['setEffort', 'ask'],
  ['setModel', 'ask'],
  ['setSubagentModel', 'ask'],
  ['setVisionPin', 'ask'],
  ['setVisionProfile', 'ask'],
  ['setCompactionThreshold', 'ask'],
  ['setBudget', 'ask'],
  ['compactContext', 'ask'],
  ['revertToMessage', 'ask'],
  ['undoRevert', 'ask'],
  ['newSession', 'ask'],
  ['closeSession', 'ask'],
  ['renameSession', 'ask'],
  ['recallSession', 'ask'],
  ['reorderSessions', 'ask'],
  ['popOutSession', 'ask'],
  ['createChatSection', 'ask'],
  ['renameChatSection', 'ask'],
  ['deleteChatSection', 'ask'],
  ['setChatSection', 'ask'],
  // Answering a contact SENDS DATA OUT on the owner's behalf, so `ask`.
  ['flockDecide', 'ask'],
  ['newCollab', 'ask'],
  ['openCollab', 'ask'],
  ['collabPromptCapture', 'ask'],
  ['collabArchive', 'ask'],
  ['reorderCollabs', 'ask'],
  ['amApply', 'ask'],
  ['amOpenFileDiff', 'ask'],
  // t-ttmo5w: the Connections Refresh button. It writes no config, key or setting, so
  // not `full`; but it drops every cache that paces the gateway sweep and so SPENDS the
  // owner's key (one probe per catalog id, per press). A cost, not a read, so `ask`.
  ['refreshModelLists', 'ask'],
  // Answering an ask. A DENY drops to `watch` (see `verbNeeds`).
  ['permission', 'ask'],
  // The escalation. A REVERT drops to `watch` (see `verbNeeds`).
  ['remote/set-mode-request', 'full'],
  ['remote/set-mode', 'full'],
  // Endpoint, credential, privilege or settings writes: repointing the provider,
  // OAuth, the browser tool's auto-approve, theme/instruction writes, and the Web
  // MCP surface. `modelPanel.unload` sits here too — it can eject every OTHER
  // chat's loaded model, the same "affects chats the phone cannot see" reasoning.
  ['setupProvider', 'full'],
  ['providerAuthRequest', 'full'],
  ['setBrowserAutoApprove', 'full'],
  ['saveWorkbenchTheme', 'full'],
  ['restoreInstructionDefault', 'full'],
  ['webmcpRequest', 'full'],
  ['webmcpRemove', 'full'],
  ['webmcpOpen', 'full'],
  ['modelPanel.unload', 'full'],
  ['planAction', 'ask'],
  ['listCrons', 'watch'],
  ['listInstructions', 'watch'],
  ['listLoopSchedules', 'watch'],
  ['listSkills', 'watch'],
  ['cancelLoopSchedule', 'watch'],
  ['webmcpAdd', 'full'],
  ['webmcpEdit', 'full'],
  ['modelPanel.load', 'full'],
  ['modelPanel.swap', 'full'],
  ['providerAuthSubmitCode', 'full'],
]);

/** The REFUSED half of the same allowlist, in a leaf of its own
 *  (remoteRefusalsTable.ts) — re-exported so every importer keeps one address.
 *  Split when this file hit its 250-line cap: the two lists answer opposite
 *  questions, one grows with every new phone capability and the other with every
 *  desk-only message, and neither was shrinking. */
export { NAMED_REFUSALS } from './remoteRefusalsTable';

/** `/auto` and `/bypass` reach the exact same unsigned `setSessionMode`
 *  escalation `setApproveMode` does, so they are closed by name, not by rank.
 *  `/plan`, `/default` and `/deep-plan` only ever restrict. */
export const ESCALATING_SLASH_COMMANDS: ReadonlySet<string> = new Set(['auto', 'bypass']);
