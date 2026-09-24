// Origami Remote — the REFUSED verb names, the other half of remoteVerbsTable.ts.
// A name here is a real handled message type the phone may NOT send: default deny
// already drops anything unlisted, so these rows exist to say the refusal was a
// DECISION rather than an omission, and remoteVerbsCoverage.test.ts fails on any
// shipped postMessage type with neither this nor a PHONE_VERBS row.
//
// Extracted from remoteVerbsTable.ts (250/250) rather than raising that cap.

/** The verbs a phone must never reach, named so a test can enumerate them and so
 *  the next reader sees what the table is FOR. Not consulted at runtime —
 *  default-deny needs no deny-list — and it holds panes a solo-mounted phone
 *  chat cannot reach, so a route added tomorrow cannot reopen the gate. */
import { GROUP_REFUSALS } from './groupRefusals';

export const NAMED_REFUSALS: readonly string[] = [
  // `/auto`, `/bypass` and the ChatPane YOLO button all post THIS, so refusing it
  // makes them inert from a phone; the signed `remote/set-mode` is the only road.
  'setApproveMode',
  // Remote's own pane messages. A phone that could re-point the relay, mint a
  // pairing or rename its own device row would own the feature gating it.
  'remoteSetRelayUrl',
  'remoteSetEnabled',
  'remoteSetApprovals',
  'remoteSetDeviceName',
  'remotePair',
  'remoteRevoke',
  'remoteTakeOver',
  'remoteRequest',
  // t-rz1b14 — the device group's seven, in groupRefusals.ts: this file is at
  // its cap and its own header says extract rather than raise.
  ...GROUP_REFUSALS,
  // t-q910fo: stopping ONE sub-agent. Unlike `cancel` and `stopBackgroundShell`
  // (both `watch`), this reaches INTO a chat the phone is not in: the id it
  // carries is a CHILD session the phone never renders and cannot have looked
  // at, so nothing on the page could tell the holder which agent they killed.
  // A phone may still stop the whole turn.
  'stopSubagent',
  // Scheduled execution: a cron is a shell command with no one watching.
  'createCron',
  'updateCron',
  'runCronNow',
  // A SETTINGS write on the desk, like the remote rows above: the sub-agent time
  // limit governs how long an unattended agent may run on the owner's machine.
  // Its READ half is `requestSubagentLimit`, covered by the prefix rule.
  'subagentLimitSet',
  // t-qn0lpl: "Reveal shot" writes a PNG on the DESK and opens the desk's file
  // explorer at it. From a phone the picture would land on a machine the holder
  // is not sitting at, and a window would open in front of whoever is. The frame
  // itself already never reaches a phone — `browserSnapshot` is in NEVER
  // (remoteScope.ts) — so the button has nothing to act on there either.
  'revealBrowserFrame',
  // Desk settings writes (t-ntmm93); the read half `requestBrowserViewport` is by prefix.
  'setBrowserViewport',
  'setBrowserOpenBeside',
  'setBrowserReveal',
  // Desk settings write (t-ntmmvh); the read half `requestCacheWarming` is by prefix.
  'cacheWarmingSet',
  'claudeSubscriptionAdd', 'claudeSubscriptionDisconnect', // t-tsw90t: desk-only modal + a setting write, same reason as removeProvider
  'chatBackdropSet', // desk settings write (t-s9jr6u); read half `requestChatBackdrop` by prefix
  // Retention (t-dcjs40): rewrites stored tool output on the desk behind a confirm a phone
  // cannot be held to; its read half `requestStorageStats` is by prefix.
  'storagePrune',
  // Repo/branch pills (t-qcx1cb): the two reads enumerate every registered repo root and
  // every open chat's directory (a map of the owner's work); the two writes create a
  // worktree or open a chat at a cwd of the phone's choosing.
  'repoPickerOptions',
  'repoPickerBranches',
  'repoPickerSelect',
  'repoPickerNewBranch',
  // Endpoint switch with no signature behind it, and files on the desk.
  'setEngineUrl',
  'createInstructionFile',
  'openAbsoluteFile',
  'openWorkspaceFile',
  // ...and the third of that family (t-qmzegs): a tool card's path reveals the
  // file in the DESK's file manager. Refused on the strongest version of the
  // reason the two above are — it does not open a document the phone could at
  // least then read, it pops a window on a machine nobody is standing at.
  'revealInExplorer',
  // Below: real handled message types with no row above — panes a solo phone
  // mount does not render, refused by the table's own default.
  'boardOpenDocs',
  'boardReady',
  'boardSectionShown',
  'botMemoryClear',
  'botMemoryRead',
  'collabArchetypeSetModel',
  'deleteCollabAgentDef',
  // These three stay refused: the two exports write files on the desk for nobody
  // on the phone, and mcpAdd can point the MCP tool surface at an arbitrary
  // command.
  'exportCollab',
  'exportRepoMap',
  'exportSession', 'historyLoad', 'historySearch', // t-ucnp7t: the phone keeps its tail (plan 3.5); older pages and whole-chat search are desk-pane reads
  'labDeleteSession',
  'mcpAdd',
  'mcpRequest',
  'modelPanel.refresh',
  'openMemoryFullscreen',
  'openSkillFile',
  'pickWikiFolder',
  'pluginsAddFolder',
  'pluginsRequest',
  'pluginsSetEnabled',
  'promptCapture',
  'providerAuthStart',
  'removeProvider',
  'renameProvider',
  'reopenLoopChat',
  'resizeLabyrinthColumn',
  'saveCollabAgentDef',
  'saveLabyrinthPrices',
  'setFrequencyPenalty',
  'setLoopPersistent',
  'startBotSession',
  'toolsCopyPath',
  'toolsDeleteProblem',
  'toolsOpenProblem',
  'toolsRequest',
  'toolsScaffold',
  'toolsSetCodeMode',
  'toolsSetState',
  // ...and its per-agent twin, refused for the same reason and one more: it
  // rewrites an AGENT's own config block, which decides what every sub-agent
  // that type spawns may do on the owner's machine.
  'toolsSetSubagentState',
  // ...and the ledger's two BULK forms of that same write (t-f1j2y3), refused
  // on the stronger version of the reason: one message rewrites a whole agent
  // block, or one tool across every agent block, in a single unsigned call.
  'toolsSetSubagentColumn',
  'toolsSetSubagentRow',
  // ...and the ledger's RESET (t-f3a74m), refused for the same reason read the
  // other way: with no `agent` it strips the tool overrides from every agent
  // block at once, so one unsigned call could widen every delegate on the
  // owner's machine back past a narrowing they set by hand.
  'toolsResetSubagentDefaults',
  // The three ACTIONS on a side quest (t-f89g49), each refused for its own
  // reason and all three desktop-only this pass. `sideQuestStart` opens a chat
  // AND sends its first message unattended — a turn from a pocket, on a brief
  // the owner has not read. `sideQuestExport` raises a save dialog and writes a
  // file on the DESK, for nobody who is holding the phone (the same reasoning
  // `exportSession` and `exportCollab` are refused on). `sideQuestDismiss`
  // rewrites a file in the workspace and hides a row every other surface reads.
  // The phone keeps the LIST and the popup: `requestSideQuests` under the
  // `request*` prefix rule, and `openSideQuestsDrawer` by its own row above.
  'sideQuestStart',
  'sideQuestExport',
  'sideQuestDismiss',
];
