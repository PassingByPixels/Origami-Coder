// Architecture ratchet (pattern from Kilo Code's agent-manager-arch test):
// the shell's god-files may SHRINK but never grow. When a cap bites, extract
// a module (a handler file, a child component, a store) instead of raising
// the number — raising the cap defeats the test's entire purpose and needs
// an explicit owner decision in review.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Caps = current size at introduction (2026-07-17), rounded up slightly so
// small in-place fixes still land. They are ceilings, not budgets.
const CAPS: Record<string, number> = {
  // 6200->6210: S3.6 defect fix — broadcastModelOptions seeds the configured
  // model catalog when no chat session is active (else the board's pickers show
  // empty). A leaf fallback, not new surface area.
  // 6210->6240 (S4, owner-approved): the ManagerHost gains three small apply-to-main
  // methods (openFileDiff via vscode.diff + makeBaseUri, info toast, openConflicted)
  // + three message types; the apply LOGIC lives in the new apply.ts/diffProvider.ts.
  // 6240->6260 (S6a, 2026-07-21, owner-approved, within the +25 restamp limit): the
  // ManagerHost host-impl gains four small typed-agent leaves (agentModes /
  // setSessionAgentMode via the ACP 'mode' config option, agentTypes / saveAgentTypes
  // globalState pass-throughs). All the roster logic lives in agentManager/agentTypes.ts.
  // 6260->6285 (S6b, 2026-07-21, within the +25 restamp limit): the host-impl gained
  // four small background-agent session leaves so the board could drive a worktree session.
  // 6285->6295 (S6c, 2026-07-21, within the +20 restamp limit): two genuinely-thin
  // host leaves — harvestAnySessionModes (roster pre-fill) + openCrossDiff (race
  // A-vs-B native diff) — partly offset by extracting the shared mode->roster
  // mapping (modesFromOption) to agentTypes.ts, which collapsed agentModes to a line.
  // 6295->6310 (S6d, 2026-07-21, within the +15 restamp limit): the race Compare
  // EDITOR TAB — a thin openRaceCompareInEditor (ensure-current, then hand off), an
  // amOpenCompare interception, a __ORIGAMI_RACE_COMPARE__ render param + global.
  // The createWebviewPanel + dedupe live in the new agentManager/compareTab.ts.
  // 6310->6210 (S8, 2026-07-22, DOWNWARD restamp): the in-place chat verified-loop path
  // was retired (its handle, dispatch, cancel wiring, the decision handler and session
  // fields), reclaiming ~110 lines; cap locked to actual + slack.
  // 6210->6225 (S7 question-attention, 2026-07-22, within the +15 restamp limit): the
  // panel-side wiring for the "needs you" surface — the onQuestion buffer+toast branch,
  // the fire-once inject-on-mount in replaySessionsTo, the mounted-permission forward,
  // and the status-bar aggregate mirror. The PURE decisions (isSessionMounted / preview /
  // boardAggregate / aggregateText) live in the new agentManager/attention.ts.
  // 6225->6235 (S7.1 defect-fix, 2026-07-22, within the +10 restamp limit): the buffered-question
  // routing gained its missing lifecycle edges — engine-death cleanup on onClose/onError (drop buffer
  // + drain respond + clear chip), a grid-mode-on replay of buffered questions, and the plan_exit/dream
  // preview on the buffered-then-replayed path (via a shared replayBufferedQuestionFor helper that
  // collapsed the inline replay block). The PURE routing leaves stay in agentManager/questionRouting.ts.
  // 6235->6210 (0.2.171, DOWNWARD): the board Kami agent type was removed - its host
  // leaves, the /goal pointer, and the contract webview routing deleted. Cap = actual + slack.
  // 6210->6240 (S15, owner-approved, mirrors the S6d +15 compare-tab raise): the repo-map
  // EDITOR TAB wiring - a thin openRepoMapInEditor (read+validate map.json, then hand off),
  // an amOpenMap interception + amMapRepo/amCancelMap message-type registration, a
  // __ORIGAMI_REPO_MAP__ render param + global, and the marker v3->v4 bump. The
  // createWebviewPanel + dedupe live in the new agentManager/mapTab.ts; the run lifecycle
  // in agentManager/mapRun.ts. Irreducible tab wiring, same shape the compare tab took.
  // 6240->6280 (0.2.177 Connect Ollama, owner-approved restamp — flag for sign-off):
  // an irreducible message-handler case (`connectOllama`) that wires the real deps
  // (readGlobalProviders / fetchLmStudioModels / httpGetJson / writeModelConfig /
  // post / broadcast + the reload toast) into the new connectOllama.ts leaf, plus
  // its import. The whole flow (dedupe, reachability guard, write, re-probe) lives
  // in the leaf; this is only the wiring. Same shape as the other provider cases.
  // 6280->6295 (t-kgtw47, cache hit ratio): the `cacheStats` case + its import —
  // irreducible thin wiring, same shape as `promptCapture` above it. The read/
  // decode/aggregate logic all lives in the new src/dashboard/cacheStats.ts leaf.
  // 6295->6298 (t-kgtaac Tools pane): EXTRACTION FIRST — the whole pane (catalog
  // read, code-mode setting write, tool-file scaffold) went into the new
  // src/dashboard/toolsPane.ts, and what stayed here is the two-line dispatch
  // that COLLAB_MESSAGE_TYPES / CHAT_SECTION_MESSAGE_TYPES already established
  // above it, plus its import. Three lines of irreducible routing; there is no
  // fourth module to split them into.
  // 6298->6311 (t-kgtr6c, +13, within the +15 restamp limit — FLAG FOR SIGN-OFF):
  // the per-chat vision-profile write. EXTRACTION CAME FIRST: the client call,
  // the optimistic-echo rule (a refused write echoes '' so the eye button cannot
  // stay lit for a profile the engine rejected) and the failure wording all live
  // in the new src/dashboard/visionProfile.ts. What is left here is the
  // irreducible message-handler wiring — resolve the posting panel's session,
  // hand the leaf a post + a setConfigOption — plus its import. Same shape, and
  // the same reasoning, as the connectOllama.ts restamp above.
  // 6311->6318 (t-kgu05m, +7 — the SMALLEST raise the feature admits, FLAG FOR
  // SIGN-OFF): the panel gains an `onPeerMessage` handler, because a handoff
  // from another agent session has to reach the webview somehow and this file is
  // where every ACP handler is wired. EXTRACTION CAME FIRST: both decisions —
  // why it is not `echoUser`, and why the ARCHIVE keeps it as a `system` row
  // rather than migrating the saved transcript shape — live in the new
  // src/dashboard/peerMessages.ts, which also owns the row it builds. What is
  // left here is a post + a push, plus the import. The file was sitting EXACTLY
  // on 6311, so no addition of any size could have fitted; the next thing to
  // land in it should extract a whole handler group, not shave lines.
  // 6318->6331 (t-kgsupy round 3, +13 — the SMALLEST raise the feature admits,
  // FLAG FOR SIGN-OFF): the panel gains `requestBrowserAutoApprove` /
  // `setBrowserAutoApprove` — the composer's Browser Ask/Bypass control's host
  // wiring, replacing the deleted `ensureYoloAutoApproveConsent` call site
  // (net: one import swapped for another, one call site removed, two cases
  // added, and the comment explaining the removal is longer than the removed
  // call). EXTRACTION CAME FIRST: the read-live / write logic lives in the new
  // src/dashboard/browserAutoApproveControl.ts leaf, same shape as
  // visionProfile.ts. What is left here is the message-handler wiring — two
  // thin cases plus the import — and the file was sitting at its cap, one
  // line of slack, so no addition of any size could have fitted without it.
  // 6331->6334 (t-kgtolm round 3, +3 — the SMALLEST raise the feature admits,
  // FLAG FOR SIGN-OFF): the Plugins pane's dispatch — an import plus the same
  // one-line `PLUGINS_PANE_MESSAGE_TYPES.has(m.type)` routing form
  // TOOLS_PANE_MESSAGE_TYPES already established, with its own one-line
  // comment. EXTRACTION CAME FIRST: the whole pane (list/enable-disable/
  // add-from-folder) lives in the new src/dashboard/pluginsPane.ts, mirroring
  // toolsPane.ts. The file was sitting at 6330/6331 — one line of slack — so
  // even the minimum two-line addition (import + dispatch) could not have
  // fitted without a raise.
  // 6334->6336 (OAuth connections, +2 — the SMALLEST raise the feature admits,
  // FLAG FOR SIGN-OFF): EXTRACTION CAME FIRST and took everything with it — the
  // flow, the browser hand-off, the config write and the baked provider catalog
  // all live in the new src/dashboard/providerAuthPane.ts + oauthConnections.ts.
  // What is left here is the same one-line
  // `PROVIDER_AUTH_MESSAGE_TYPES.has(m.type)` routing form
  // PLUGINS_PANE_MESSAGE_TYPES established directly above it, its one-line
  // comment, and one import. The file was sitting at 6333 with ONE line of
  // slack, so exactly one of those three fitted.
  // 6336 HELD (live model mirror fix): the cap DID NOT MOVE — the file SHRANK
  // to 6318. EXTRACTION CAME FIRST: broadcastModelOptions' inline poll/prune/
  // merge block left for the new src/dashboard/liveModelMerge.ts, taking the
  // defect with it (one `Promise.all` under one `catch {}`, so a single
  // rejecting poll discarded every provider's live list). What is left here is
  // one `mergeLiveModels(...)` call, its comment, and one import.
  // 6336 HELD AGAIN (picker UAT: open lag + Connect-Ollama removal): the cap DID
  // NOT MOVE. The `connectOllama` handler case and its import went with the
  // connectOllama.ts file (see its removed row below), and broadcastProviderStatus'
  // per-provider fan-out left for the new src/dashboard/providerProbe.ts, which is
  // what paid for the concurrency wrapper landing here.
  // 6336 HELD A THIRD TIME (optional API keys on self-hosted connections): the cap
  // DID NOT MOVE — the file SHRANK 6335 -> 6098. The file was sitting ONE LINE
  // under its cap, so threading an optional apiKey through the endpoint probes had
  // nowhere to go; EXTRACTION CAME FIRST and the whole node:http probe cluster
  // (httpGetJson/httpPostJson/fetchOllamaContextLength/fetchModelInfo/
  // fetchLmStudioModels/detectLocalFlavor) left for src/dashboard/localProbe.ts.
  // The `lms` CLI helpers deliberately stayed: they drive a local PROCESS, not an
  // endpoint, which is the seam the split follows.
  'src/dashboard/DashboardPanel.ts': 6336,
  // localProbe.ts: every node:http probe against a self-hosted OpenAI-compatible
  // server (LM Studio / Ollama / vLLM / SGLang) — liveness, model list, context
  // window, server flavor. Extracted from DashboardPanel.ts at 6335/6336 (which
  // SHRANK to 6098). Cohesive by transport AND by subject: node:http means
  // loopback/LAN only, so the https cloud gateways keep their fetch-based probes
  // in DashboardPanel.ts. Every entry point takes an OPTIONAL apiKey; the keyless
  // path sends no Authorization header at all. Intro 304 + slack.
  'src/dashboard/localProbe.ts': 330,
  // liveModelMerge.ts: the picker's live-mirror projection — which providers are
  // pollable (protocol, never name), and the per-provider prune/add/reconcile
  // against what each server reports NOW. Pure and vscode-free for the
  // providerProbe.ts reason: the panel injects the real fetcher, a test injects
  // one that throws. Intro 104 + slack.
  'src/dashboard/liveModelMerge.ts': 130,
  // providerProbe.ts: the fan-out half of broadcastProviderStatus — every
  // configured provider's liveness probe runs AT ONCE, per-provider isolated and
  // bounded, so the picker waits on the slowest probe rather than the sum of all
  // of them. Same defect and same fix liveModelMerge.ts applied to the sibling
  // `modelOptions` broadcast. Generic (no provider vocabulary) BECAUSE that is
  // what makes concurrency/isolation/bound assertable with no vscode host.
  // A LEAF; capped at introduction (74) + slack.
  'src/dashboard/providerProbe.ts': 90,
  // toolsPane.ts: the Tools view's host side — the `list_tools` read, the
  // origami.experimentalCodeMode write, the .origami/tool/<name>.ts seed, the
  // per-tool load/unload override, and copy-path. The cap DID NOT MOVE when
  // round 3 added the last two (t-kgtaac): EXTRACTION CAME FIRST — the scaffold
  // template + name validation left for toolScaffold.ts and the origami.json
  // read/merge/write for toolDeferConfig.ts, both of them pure and
  // vscode-free, which is also why they can be unit-tested with no host. What
  // stayed is dispatch and the two freshly-resolved lookups. 148/150.
  // t-q41knp (+2, landing EXACTLY on the held cap): tool_search's synthetic
  // row (withToolSearchRow, new toolSearchRow.ts) folded into the one
  // existing catalogPayload return line, and setDefer's re-post now patches
  // the write it just confirmed (patchDeferredPayload, toolDeferConfig.ts) —
  // one import line, one comment, the call itself replacing its old line.
  // No room left; the next feature extracts.
  // BROKEN-USER-TOOL INCIDENT: the pane gained a `problems` list (a user tool
  // file the engine found but could not load). The cap DID NOT MOVE — the
  // extraction the comment above promised happened: catalogPayload + findEntry
  // and the host contract left for toolsCatalog.ts, taking this file from
  // 150/150 down to 120.
  'src/dashboard/toolsPane.ts': 150,
  // toolsCatalog.ts: the Tools pane's catalog READ — the `list_tools` call, the
  // three `toolsData` payload shapes it can answer with, and the fresh-lookup
  // helper the two writes resolve their target through. Extracted from
  // toolsPane.ts (which was at 150/150) when the problems list landed. It owns
  // the host contract because the only thing the host is asked for is the
  // client this module reads through. Intro 53 + slack.
  'src/dashboard/toolsCatalog.ts': 70,
  // toolProblemActions.ts: the two actions the failed-tool-file card offers —
  // open it, or delete it. Its own module because it is one self-contained
  // unit and toolsPane.ts had 30 lines of slack that the delete's safety check
  // alone would have eaten. That check is the reason the file exists: every
  // other write on the pane takes a tool ID and resolves the path itself, but
  // a file that produced no tool has no id, so the PATH is the identity — and
  // it is refused unless a FRESH engine read is still naming it, or a webview
  // could name any path on disk and have it unlinked. Intro 79 + slack.
  'src/dashboard/toolProblemActions.ts': 95,
  // toolScaffold.ts: the scaffolded tool's NAME rule and starter text, lifted
  // out of toolsPane.ts above. Pure, no `vscode` import. It is the file the cap
  // comment on toolsPane.ts had already predicted would be needed ("a second
  // template belongs in its own file"). Intro 49 + slack.
  'src/dashboard/toolScaffold.ts': 65,
  // toolDeferConfig.ts: the tool state control's single write target in the
  // GLOBAL origami.json, read/merged/written as one unit so no two keys can
  // ever name the same tool differently. Same shape as firstFold.ts's config
  // writers, and pure Node I/O so it needs no VS Code host to test. Intro 76.
  // t-q41knp: gained patchDeferredPayload — the toggle looked cosmetic-only
  // because the re-read catalog still answered from the RUNNING engine's
  // cached verdict (this file's own top comment); patches the one entry the
  // write just confirmed onto the fresh payload before it is re-posted.
  // TRI-STATE (Loaded/Deferred/Off): writeDeferOverride -> writeToolState, now
  // spanning `experimental.tool_search.{always,defer}` AND `tools`. CAP HELD at
  // 95, not raised: the parse + toast wording went to toolStateMessage.ts and
  // the file's own header prose was tightened to pay for the writer. 95/95.
  'src/dashboard/toolDeferConfig.ts': 95,
  // toolStateMessage.ts: reading the pane's state message and saying what the
  // write did. Extracted from toolsPane.ts when the two-state toggle became
  // three and that file hit its cap. Pure — no `vscode`, no fs. It is here
  // rather than inline because one of its two functions decides whether a tool
  // gets switched OFF from a webview-supplied string, and an unrecognised value
  // must be refused rather than rounded to a state. Intro 38 + slack.
  'src/dashboard/toolStateMessage.ts': 45,
  // globalConfig.ts (connections review 2026-08-15): the extension's single
  // answer to "where is the global origami config, and how do I read and write
  // it". It exists because the path/parse/write block was hand-copied into
  // firstFold.ts and toolDeferConfig.ts, and both copies diverged from the
  // ENGINE in four ways at once — hardcoded ~/.config vs XDG_CONFIG_HOME,
  // JSON.parse vs JSONC, truncating write vs atomic, one .bak slot vs a
  // rotation. Extraction SHRANK both callers (firstFold 1084->1028,
  // toolDeferConfig 86->71). Pure Node I/O, no `vscode` import. Intro 252 + slack.
  'src/dashboard/globalConfig.ts': 270,
  // configShape.ts: a MIRROR of the parts of the engine config schema this
  // package's writers can violate, so a writer refuses before it persists a
  // document the engine would throw the whole file away for. A mirror because
  // `effect`/`@origami/core` are unresolvable from this package (per-package
  // installs) — with the house obligation of a drift test that reads the real
  // schema source, in configShape.test.ts. Intro 148 + slack.
  'src/dashboard/configShape.ts': 165,
  // contextLimitWarning.ts: the once-per-model user line for a probed context
  // window that could not be persisted (auto-compaction stays off, silently).
  // Its own file because DashboardPanel.ts sits ON its cap — extraction first.
  // Intro 54 + slack.
  'src/dashboard/contextLimitWarning.ts': 70,
  // toolSearchRow.ts (t-q41knp): `tool_search` is never a registry tool (the
  // engine synthesizes it per-turn, only once something is deferred), so
  // `GET /experimental/tool` never reports it and the Tools pane rendered as
  // if the tool that DOES the deferring did not exist. A synthetic row,
  // id-checked against a future engine change so it can never duplicate.
  // Pure, no `vscode` import. Intro 33 + slack.
  'src/dashboard/toolSearchRow.ts': 45,
  // engineEnv.ts: what the shell adds to the engine child's environment, taken
  // OUT of acpClient.ts (1357/1360, no room) when the code-mode toggle needed a
  // second flag there. The pure half is the point: the env overlay is decided
  // without a workbench, so "code mode off writes no variable at all" — the rule
  // that keeps an ORIGAMI_EXPERIMENTAL set outside VS Code from being
  // overridden — is a test rather than a claim. Intro 58 + slack.
  'src/engineEnv.ts': 75,
  // --- Cross-session agent messaging leaves (t-kgu05m), capped at introduction. ---
  // peerName.ts: this window's peer-discovery NAME — the setting id, the env var
  // the engine's broker reads it from, and the trimmed reader. Split OUT of
  // engineEnv.ts (which held its 75 cap as a result): that file is the
  // experimental-TOGGLE mirror against runtime-flags.ts, and a name has a
  // different reader, a different guard and a different lifetime. Intro 41 + slack.
  'src/peerName.ts': 55,
  // acpPeerMeta.ts: the fail-closed `_meta.origami_peer` reader, a sibling of
  // acpTaskMeta.ts / questionBatch.ts. A LEAF; intro 29 + slack.
  'src/acpPeerMeta.ts': 45,
  // acpAudience.ts: the `annotations.audience` reader — "is this replayed text for
  // the human at all". The engine's LIVE stream drops `synthetic` parts, but
  // `session/load` replays them tagged `audience: ['assistant']` instead
  // (acp/content.ts's partToContentChunks), so a reloaded chat rendered the
  // interject envelope under the user's own name. Deliberately FAIL-OPEN, the
  // inverse of acpPeerMeta.ts beside it: there a broken rider must not mislabel
  // the operator's words, here it must not silently delete a turn. A LEAF; intro 38.
  'src/acpAudience.ts': 55,
  // acpTodoWrite.ts: WHICH list a `todowrite` frame carries — rawInput.todos
  // preferred, else the COMPLETED frame's JSON text (whose title is the tool's own
  // summary and which carries no structured payload at all). Lifted VERBATIM out of
  // acpClient.ts's tryHandleTodoWrite to pay for acpAudience.ts landing in a file
  // sitting exactly on 1370 — the ratchet's own remedy. It had NO coverage inline;
  // it has its own suite now. A LEAF; intro 65 + slack.
  'src/acpTodoWrite.ts': 85,
  // peerMessages.ts: what the shell does with a received handoff — the archive
  // row, and the two decisions behind it (not `echoUser`; `system` in the saved
  // shape). Extracted because DashboardPanel.ts sat ON its cap. Intro 31 + slack.
  'src/dashboard/peerMessages.ts': 45,
  // PeerMessageRow.svelte: the agent-origin row — badge, sender, reply address,
  // body. Owns the envelope-stripping rule (`peerBody`) as an exported pure
  // function, the InstructionRowActions.svelte pattern, so "the human should not
  // read the XML the model does" is testable without mounting. Intro 91 + slack.
  'webview/dashboard/components/PeerMessageRow.svelte': 115,
  // 2700->2600 (S8, 2026-07-22, DOWNWARD restamp): the S8 chat-mode retirement removed
  // the in-chat contract card mount + its handlers, a session field + message case, and
  // the related send/queue plumbing. Cap = actual (2594) + slack.
  // 2600->2635 (0.2.174 feel-tweaks, within a +35 restamp): three thin chat-surface
  // wirings — the pinned last-user header (PinnedUserMessage.svelte), the permission
  // `command` prop threaded to PermissionBar, and the run-time todo overlay's collapse
  // props + a per-session flag. The real logic lives in the child components; this is
  // mount/prop wiring only. Cap = actual (2620) + slack.
  // 2635->2665 (0.2.176 chat-surface polish): the pin ungated off inFlight (via the
  // latestUserText selector), the live-thought branch gained the rotating ThinkingGlyph +
  // an isLiveThought class/open toggle + its .live styles, and the todo overlay got
  // overflow-x: clip for the drawer. Mount/style wiring; logic lives in the leaves.
  // 2630->2590 (bash IN/OUT card, 2026-08-06, DOWNWARD restamp): the 'toolCall'/
  // 'toolResult' case bodies — the transcript's tool-message merge rules — were
  // EXTRACTED to chatToolMsg.ts when the pane sat ONE line under its cap and the
  // shell-detail threading (toolShell) needed room. 2629 -> 2582; cap = actual + slack.
  // t-kgu05m: the peer-message row landed with NO raise (2700/2700 exactly). The
  // whole surface — badge, sender, reply address, envelope stripping and its
  // styles — is the new components/PeerMessageRow.svelte; what is here is a
  // `peer` kind, one `peerReplyTo` field, a two-line dispatch and a one-line
  // mount. `addMessage` gained an `extra?: Partial<Message>` tail parameter so a
  // kind with its own field needs no second pass over the list. This file has no
  // room left at all: the next feature here extracts.
  // tab-waiting colour: the same "needs you" semantic the sidebar ring carries
  // (chat/sessionRowState.ts) — an open question batch OR a pending permission
  // approval — now lights `.session-tab`. The OR itself EXTRACTED to
  // tabWaiting.ts as predicted above; ChatPane only gained one import, one
  // `class:tab-waiting` bound onto the existing `class:active` line, one
  // `closeAsk` call in `sessionClosed` (merged onto its neighbour line to hold
  // the cap), and one compact CSS rule for the dot. Cap held at 2700 exactly —
  // no room for anything but extraction.
  // t-q41knp (owner redesign): the dot was a placeholder from day one - the
  // brand crane already appears everywhere else Origami shows a status
  // glyph, so the waiting affordance became THAT, tinted, instead of a
  // second mark. One `<span class="tab-crane">` per tab (CraneMark was
  // already imported - no new import line) replaced the one-line `::before`
  // dot rule with a one-line `.tab-waiting .tab-crane { color }` rule: net
  // +1, landing EXACTLY on the held cap again. No room left; the next
  // feature extracts.
  // t-r7c757 (rotating empty-state tips, DOWNWARD): the file was sitting at
  // 2699/2700 — no room for a rotation timer inline. The whole empty state
  // (crane + hint markup + its CSS) EXTRACTED to the new
  // components/ChatEmptyState.svelte, which also picked up the tip-rotation
  // effect; components/emptyStateTips.ts holds the pure list/advance/seed
  // rules. What is left here is a single component tag with three props.
  // 2699 -> 2654; cap left at 2700 (well under, not a ratchet-down).
  // todo scratchbook (the "the list keeps getting dropped" defect): the file was
  // back ON 2700/2700, so the visibility RULE went out to panes/todoScratchbook.ts
  // rather than inline. Net zero here — one import in, one `s.todos = []` out —
  // and the other three sites (turnDone's condition, the {#if} gate, the
  // error/closed wipes) were same-line edits. No room left; the next one extracts.
  // send echo (the "my message is missing, then doubled" UAT): the cap did NOT
  // move — the file was at 2698/2700 and landed on 2699. EXTRACTION CAME FIRST:
  // rewindTo()'s walk-back left for panes/rewindSlice.ts (-7 lines here), which
  // paid for the optimistic user row. What is left is a `pendingEcho` field, one
  // line each in the send path and the `echoUser` case, and an addMessage folded
  // onto the existing one-line onInterject handler. Both rules live in leaves
  // (userEcho.ts, rewindSlice.ts); the pane holds pointers, not reasoning.
  // image lightbox (a click on any chat image opens it enlarged): the cap did
  // NOT move — the file was at 2699/2700, with room for neither the import nor
  // the mount. EXTRACTION CAME FIRST: the two pure `stop_reason` switches and
  // their types left for panes/turnVerdict.ts (-47 lines here), which is the
  // honest piece — a wire taxonomy is a rule, and inline it could only be
  // checked by driving a whole turnEnd message through a rendered pane. What
  // landed is one import pair, one `lightbox` state + its one-line opener, one
  // pane-level <ImageLightbox> mount, and same-line props on the two MessageRow
  // tags and the InputBar tag. 2699 -> 2665; cap left at 2700 (well under, not
  // a ratchet-down).
  // interject SPLIT (the out-of-order transcript): cap did NOT move — the WHEN
  // rule went to panes/interjectSplit.ts before a line was written here, and
  // what is left is one import, one session field, the two-line seal inside
  // addMessage, and a resolve call on each of the four host answers. 2664 ->
  // 2694. That is SIX lines of slack: the next change to this file extracts
  // first, it does not get to trust there is room.
  // Enter-interjects (the composer queue retired): the cap did NOT move, and the
  // file grew by exactly ONE line, 2695 -> 2696. EXTRACTION CAME FIRST, as the
  // note above demanded: the retry RULE — which interject failure means the line
  // must be sent again — went out to panes/interjectRetry.ts before a line was
  // written here, and the FIFO/drain rule went into interjectSplit.ts. DELETION
  // paid for most of the rest: the `queuedMessage` field, its two mount
  // callbacks and its init all went with the chip. What is left is one import,
  // one `retryAsPrompt` branch on the error case, and two `drainInterject` calls
  // replacing two single-line resolves. FOUR lines of slack now, and the
  // instruction hardens rather than relaxes: the next change here extracts.
  // Engine-message keying (2026-08-20): the cap did NOT move and three of the
  // four remaining lines were spent — 2696 -> 2699. EXTRACTION CAME FIRST: the
  // rule (WHEN a delta belongs to a different engine message than the open
  // bubble, and the two conservative cases where it does not) went out to
  // panes/agentStreamSeal.ts before a line was written here, so this file kept
  // one import and one guard. ONE line of slack: the next change is an
  // extraction that GIVES lines back, not another guard.
  // thought open-persists (a user-opened reasoning block re-closing itself the
  // instant the next stream delta lands): the cap did NOT move — the file was
  // at 2699/2700, no room for both the open/onToggle props and their import.
  // EXTRACTION CAME FIRST: isThoughtOpen/withThoughtOpen went to the new
  // panes/thoughtOpenState.ts before a line was written here. What landed is
  // one import, one `openThoughtIds` session field (a trailing-comment line,
  // no separate JSDoc), and two props on the existing ThoughtPill tag, paid
  // for by trimming that tag's now-stale comment. 2699 -> 2700, landing
  // EXACTLY on the cap; the next change here extracts first.
  // 2700->2420 (0.4.45, DOWNWARD restamp): the per-message loop and its 145 lines
  // of scoped CSS left for components/ChatTranscript.svelte so a read-only
  // sub-agent transcript can share the renderer instead of growing a second one.
  // The file SHRANK 2700 -> 2397. Restamped down deliberately: a ratchet left at
  // 2700 over a 2397-line file hands back every line the extraction bought, which
  // is the same as not having extracted. Same move as the S8 restamp above.
  'webview/dashboard/panes/ChatPane.svelte': 2420,
  // ChatTranscript.svelte: given a message list, the ROWS — the {#each} and its
  // whole kind dispatch (tool / verdict / todo / thought / compacted / peer /
  // agent+rewind / else), with the CSS that dresses them. Extracted from
  // ChatPane.svelte at 2700/2700. The boundary is deliberate: rows moved, the
  // once-off per-session furniture around them (agent banner, pinned message,
  // rewind-undo banner) did NOT, because a transcript renderer's contract is
  // "given messages, render rows" and that furniture reads pane-level layout
  // state a read-only caller has no concept of. Intro 285 + slack.
  'webview/dashboard/components/ChatTranscript.svelte': 320,
  // chatMessage.ts: the `Message` and `TodoInfo` row shapes. NOT a mirror — the
  // one declaration. A type declared inside a .svelte <script> cannot be named
  // by another component, so sharing the renderer forced the shape into a leaf.
  // Imports only webview-side siblings, so it stays TS6059-clean. Intro 122 + slack.
  'webview/dashboard/panes/chatMessage.ts': 150,
  // agentStreamSeal.ts: WHICH engine message an agent-text delta belongs to.
  // The pane merged two engine messages into one bubble because nothing closed
  // the open one when the engine moved on — invisible on a tidy turn, and
  // character-level garbage on 2026-08-20 when a second turn loop streamed onto
  // the same session (root cause fixed in engine server/server.ts). A LEAF,
  // pure, no DOM — which is what lets the two "keep appending" cases (no id on
  // the delta, bubble not yet stamped) be assertions instead of a rendered
  // pane. Intro 26 + slack.
  'webview/dashboard/panes/agentStreamSeal.ts': 50,
  // interjectSplit.ts: WHEN an interjected line becomes a transcript row. The
  // counterpart to userEcho.ts below and the OPPOSITE call — that row goes up
  // optimistically to skip a 4 s model reprobe; this one waits for the host,
  // because it also marks a SPLIT in the turn under it and a split is only true
  // once the engine has taken the line. The seal itself is deliberately NOT
  // here: it belongs on the user row in addMessage, or a REPLAYED interjection
  // (which never passes through this file) could not split the same way, and
  // live and reloaded transcripts would disagree. A LEAF, pure, no DOM.
  // Intro 71 + slack.
  // FIFO (Enter delivers on the keypress, so several lines can be outstanding):
  // the cap did NOT move. The one-slot field became a queue and `drainInterject`
  // joined it, which put the file at 89/85 — over. NOTHING WAS EXTRACTED and
  // nothing should be: three tiny pure functions do not want a fourth module.
  // The header paid instead, trimmed back to 84 with every rule it states
  // intact. ONE line of slack: the next rule here is a new leaf, not a fourth
  // function.
  'webview/dashboard/panes/interjectSplit.ts': 85,
  // turnVerdict.ts: what a turn's terminal `stop_reason` MEANS (verdictForStopReason)
  // and what the transcript calls it (verdictLabel). Lifted VERBATIM out of
  // ChatPane.svelte, which was ON its cap when the lightbox needed a mount line.
  // Pure, no DOM — which is the point: "an unrecognised label is NEVER promoted
  // to a benign verdict" is now one assertion instead of a rendered pane. A LEAF;
  // intro 57 + slack.
  'webview/dashboard/panes/turnVerdict.ts': 70,
  // userEcho.ts: WHEN the user's own message appears, and how many of it there
  // are. The row used to wait on the host's `echoUser`, which DashboardPanel.ts
  // posts only AFTER `await this.reprobeModel()` — two 4 s-timeout HTTP probes —
  // so a chat on an unreachable-probe provider showed a running turn with no
  // question in it. Drawing it locally makes `echoUser` ambiguous (a confirmation
  // of this pane's send, or a turn nobody here typed: history replay, a
  // host-expanded slash command, an Agent Manager task), and `pendingEcho` is the
  // one-shot match that separates them. A LEAF, pure, no DOM. Intro 45.
  'webview/dashboard/panes/userEcho.ts': 60,
  // sessionReplay.ts: what a CATCH-UP post means. `replaySessionsTo` re-posts
  // `sessionCreated` + the whole `messageLog` to a view it is catching up, and
  // a new chat guarantees a second view (its editor tab auto-opens the moment
  // the engine answers) — so the pane meets its own session, and its own rows,
  // twice. Read as new state that appended a second entry under one id (a
  // keyed-each duplicate: the popped tab drew the chat twice) and a second copy
  // of the transcript (the user's message on screen twice). A LEAF, pure, no
  // DOM. The pane paid for it in the same case it guards: the eight default
  // fields of a fresh session fold onto two lines, so 2699/2700 held.
  // 70->90 (W9 round 2, FLAG FOR SIGN-OFF): `botGlyph` joined the identity set,
  // and identity is exactly this file's subject. NOTHING WAS EXTRACTED, and that
  // is the honest report rather than a skipped step: the file is already a
  // two-rule leaf, and moving a five-line normaliser into a sixth module beside
  // the module that owns announcement normalisation would move the number
  // without making anything simpler. `glyphOf` is exported rather than inlined
  // in ChatPane BECAUSE both paths need the same rule — a first announcement
  // and a catch-up replay disagreeing about one chat is the class of bug this
  // whole file exists for.
  'webview/dashboard/panes/sessionReplay.ts': 90,
  // rewindSlice.ts: WHICH messages a "Rewind to here" drops — the walk-back to
  // the user message that OPENED the turn, because the engine's `revert` resolves
  // to the last user message and cutting from the agent row would strand the
  // question above a turn the engine already deleted. Lifted out of
  // ChatPane.svelte, which was at cap; a rule, testable with no render. Intro 36.
  'webview/dashboard/panes/rewindSlice.ts': 50,
  // The pure predicate behind that overlay: `hasOpenWork` + `todoOverlayVisible`.
  // Small on purpose — it is a rule, not a store; the state stays in ChatPane.
  'webview/dashboard/panes/todoScratchbook.ts': 60,
  // 1350->1360 (t-kgtw47, cache hit ratio): the prompt() usage cast widened to
  // stop silently dropping `cachedWriteTokens` the engine already sends, plus
  // threading it through onUsageUpdate's args and the handler signature —
  // an in-place bugfix on the exact lines with the defect, not new surface;
  // nothing here was extractable. `cacheStats()` itself needed no method on
  // this file at all (cacheStats.ts calls the existing extMethod directly).
  // 1360->1370 (t-kgu05m, +10, FLAG FOR SIGN-OFF): peer messages arrive in the
  // SAME wire slot as the human's own turn (`user_message_chunk`), separated
  // only by a `_meta.origami_peer` rider — so the routing has to happen inside
  // this file's sessionUpdate switch. There is nowhere else: a rider cannot be
  // decoded from outside the decode. EXTRACTION CAME FIRST — the fail-closed
  // reader is the new src/acpPeerMeta.ts, a sibling of the acpTaskMeta.ts and
  // questionBatch.ts leaves this file already routes on, and the peer-NAME
  // setting went to src/peerName.ts rather than growing engineEnv.ts. What is
  // left here is one handler declaration and a two-line branch. Like
  // DashboardPanel.ts above, this file was sitting EXACTLY on its cap.
  // audience filter (the interject-envelope replay leak): the cap did NOT move —
  // the file SHRANK to 1344. EXTRACTION CAME FIRST and paid several times over:
  // tryHandleTodoWrite's two-source list read left for acpTodoWrite.ts (-31), and
  // the new rule is one import plus a condition folded onto the two `content.type
  // === 'text'` guards that were already there. Both replay slots are covered
  // (user AND agent) because both go through the same partsToContentChunks.
  // cap debt clearance (0.4.45): the cap DID NOT MOVE — the file SHRANK 1426 -> 1330.
  // It had been sitting 56 lines OVER, i.e. the ratchet was red on the release line,
  // and two unrelated fixes were routing around this file rather than land in it.
  // EXTRACTION CAME FIRST and followed this file's own established pattern (the
  // acpPeerMeta / acpTaskMeta / questionBatch / acpTodoWrite / peerName leaves): the
  // four structure-payload readers left for acpNotify.ts, the DISPATCH stayed.
  'src/acpClient.ts': 1370,
  // acpNotify.ts: the four `origami/*` notifications whose payload is a whole
  // STRUCTURE (plan candidates, task shape, todo snapshot, arbiter decision) —
  // wire frame in, handler args out. Read out of acpClient.ts's extNotification
  // switch, which had four inline decoders sitting inside one dispatch. Todo rows
  // are acpTodoWrite.ts's `TodoRow`, imported rather than mirrored — both feeds
  // fill the same strip, so a mirror here would be a drift guard nobody wrote.
  'src/acpNotify.ts': 190,
  // 1050->955 (S8, 2026-07-22, DOWNWARD restamp): the S8 chat-mode retirement removed a
  // toggle button + its state + handler, a queued-chip badge, and the related prop
  // plumbing/CSS. Cap = actual (948) + slack.
  // t-kgsdsw: the compaction gauge's right-click menu — a state pair, one
  // message case, two small handlers, and the gauge markup wrapped in a
  // sibling span (so a menu-option click can never bubble into the gauge's
  // own onclick and fire an accidental compact). The MENU ITSELF is its own
  // new leaf, CompactionThresholdMenu.svelte — this is wiring only. Landed at
  // 1199/1200 — no raise, but the next feature here should extract rather
  // than trust there is still room.
  // interject: the composer's queued line goes INTO the running turn instead of
  // waiting for the turn boundary. The cap did NOT move — InputBar was at
  // 1199/1200 and ChatPane at 2700/2700, so all three parts below were extracted
  // BEFORE the feature was written, and both files SHRANK (1200->1171,
  // 2700->2698). DashboardPanel.ts held 6336 exactly: its `stopBackgroundShell`
  // case became the first entry in turnMessages.ts's set, so one switch case out
  // paid for one dispatch line in.
  // Enter-interjects: the cap did NOT move and the file SHRANK again, 1176 ->
  // 1174. Three props (`queued`, `onQueue`, `onUnqueue`) and the queue branch of
  // `doSend` left; what replaced them is the same branch posting to `onInterject`
  // instead, which now carries the text. The chip mount stayed one line.
  'webview/dashboard/components/InputBar.svelte': 1200,
  // ModeControl.svelte + modeControl.ts (deep-plan): the composer's session-mode
  // control, widened from a two-state Plan toggle to Build / Plan / Deep Plan.
  // EXTRACTION CAME FIRST and was forced: InputBar.svelte sat at 1183 of its 1200
  // and a third state needs a trigger, a popover and its own styles. What stayed
  // in InputBar is the mount plus one `selectMode` — it came DOWN to 1190 with
  // the old toggle and inline button gone. Both capped at introduction + slack;
  // the .svelte one is the Effort/Approve popover idiom, the .ts one is a pure
  // leaf (no DOM, no `vscode`) holding the label, the option list and the
  // is-this-a-planning-mode predicate the approve rail gates on.
  'webview/dashboard/components/ModeControl.svelte': 145,
  'webview/dashboard/components/modeControl.ts': 120,
  // InterjectingChip.svelte: what is LEFT of the retired QueuedChip.svelte (cap
  // row DELETED with the file). Enter during a turn now delivers on the
  // keypress, so there is no queued line to show, no Interject button to press
  // and no ✕ to cancel with — only the "interjecting…" interim state, which
  // still earns its place: the transcript row waits for the host answer
  // (interjectSplit.ts) and the composer clears at once, so without this the
  // user's words are nowhere on screen for one round trip. Intro 58 + slack, and
  // WELL under the 120 the chip it replaces held: three quarters of that file
  // was the queue's own markup and rules, deleted rather than carried over.
  'webview/dashboard/components/InterjectingChip.svelte': 70,
  // queuedFlush.ts: what a finished turn does with text that was waiting on it —
  // now ONE thing, the plan-mode "Revise" revision, plus the clear-before-arm
  // rule and the `setTimeout(…, 0)` that keeps the todo summary and the linger
  // resolving against the turn that ENDED. Lifted VERBATIM out of ChatPane.svelte's
  // turnDone case. The `queuedMessage` branch it used to order against went with
  // the composer queue — Enter mid-turn interjects, so nothing parks there any
  // more. Cap left at 60 (file SHRANK 47 -> 42; not a ratchet-down).
  'webview/dashboard/panes/queuedFlush.ts': 60,
  // interjectRetry.ts: WHICH interject failure means the line must be sent
  // again. With no queue chip left holding a copy, a refused line is either
  // re-sent or lost — and re-sending the wrong failure is the double-send the
  // retired queue guarded, so exactly one qualifies: turnMessages.ts's own
  // pre-wire refusal. Carries a MIRRORED copy of that sentence (webview .ts
  // cannot import from src/ at all — tsconfig rootDir), with the drift test the
  // house rule demands in composerEnter.test.ts. A LEAF, pure. Intro 41.
  'webview/dashboard/panes/interjectRetry.ts': 55,
  // turnMessages.ts: the messages that act on the turn a chat is RUNNING — the
  // pre-existing `stopBackgroundShell` (delegating to backgroundShellMessage.ts
  // unchanged) and the new `interject`, behind the one-line
  // `TURN_MESSAGE_TYPES.has(m.type)` routing form TOOLS_PANE_MESSAGE_TYPES
  // established. It holds the ACP call leaf too (interjectIntoTurn), on a
  // structural client interface, because acpClient.ts is at 1370/1370 and
  // `shell_stop` already proves the generic extMethod needs no wrapper.
  // Intro 68 + slack.
  'src/dashboard/turnMessages.ts': 85,
  // engineSessionId.ts: which id a session-scoped ext-method may name on the
  // wire. Extracted BEFORE the plan_action fix, not after: DashboardPanel.ts
  // held 6335/6336, so the resolver had to pay for itself there — one import
  // line in, one comment line out, panel back to 6335 and NEITHER cap moved.
  // Mostly header: the rule is 8 lines of code, and WHY it must have no
  // fallback is the part the next reader needs. Intro 63 + slack.
  'src/dashboard/engineSessionId.ts': 75,
  // Agent Manager modules, capped at introduction (2026-07-17).
  // chatCommands.ts: the /loop scheduler + /compose coach + the shell-gate runner
  // (runGate, used by the worktree setup-script path) + turn-text capture, split out of
  // the former helper module when the board Kami agent type was removed. Prompt-heavy.
  'src/dashboard/chatCommands.ts': 320,
  // completion.ts: the plain single-prompt run completion (persistDone + completeRun),
  // extracted from the deleted run-completion module. Small; capped at introduction.
  'src/dashboard/agentManager/completion.ts': 50,
  // worktrees.ts (S6d): the git child-process layer (runGit / runGitStdoutToFile /
  // + the new runGitStdout) EXTRACTED to gitRun.ts so the third variant could land
  // beside its siblings; worktrees.ts shrank ~298->216 and re-exports them. Cap held.
  'src/dashboard/agentManager/worktrees.ts': 300,
  // gitRun.ts (S6d): the extracted git-run layer + runGitStdout (stdout-only capture,
  // stderr separated) - the fix for numstat's stderr-glued-to-stdout count corruption.
  'src/dashboard/agentManager/gitRun.ts': 160,
  // compareTab.ts (S6d): the race-Compare editor tab (createWebviewPanel + the
  // one-tab-per-group dedupe), kept out of DashboardPanel behind a thin dispatch.
  'src/dashboard/agentManager/compareTab.ts': 90,
  // state.ts 160->175 for S3.7: WorktreeRecord gains queuedTask.
  'src/dashboard/agentManager/state.ts': 175,
  // manager.ts restamped 430->470 for S3.6 (kanban), then 470->490 for the S3.6
  // defect-fix pass. S3.7 held the 490 cap by EXTRACTING the agent-run lifecycle
  // into run.ts (the queue could not fit) - it SHRANK back to ~430, cap unchanged.
  // S6b held the 490 cap AGAIN by EXTRACTING the ManagerHost interface -> host.ts
  // and the AgentRow projection -> rows.ts. 490->450 (0.2.171, DOWNWARD): the Kami
  // agent type removal shed the contract map, dispatch and settle helpers.
  // 450->470 (S15, owner-approved): the cartographer map routing - two cache maps
  // (mapRuns/mapStatus), the amMapRepo/amCancelMap cases + mapCtx builder, the
  // broadcast `map` field, and the request/poll status refresh. The whole run
  // lifecycle (runMap/cancelMap/finish/stamp/staleness) lives in mapRun.ts; this is
  // only the residual routing + broadcast wiring, irreducible after that extraction.
  'src/dashboard/agentManager/manager.ts': 470,
  // host.ts (S6b): the ManagerHost interface, extracted from manager.ts. 100->80
  // (0.2.171, DOWNWARD): the board's background-agent session leaves were removed.
  'src/dashboard/agentManager/host.ts': 80,
  // rows.ts (S6b): the record+runtime -> AgentRow projection, extracted from manager.ts.
  // 90->75 (0.2.171, DOWNWARD): the row's verified-loop fields were removed.
  'src/dashboard/agentManager/rows.ts': 75,
  // fanout.ts (S5): the multi-model race — variant validation + the fan-out
  // loop (each variant a plain runCreate, staggered launches, shared groupId).
  'src/dashboard/agentManager/fanout.ts': 120,
  // run.ts (S3.7): the extracted create/start/queue lifecycle, capped at intro.
  // 240->280 for S3.8 (owner-approved): a completed run now PERSISTS a done
  // marker on its record (persistDone at idle in both runCreate and runStart) so
  // it stays visibly done across a reload, and runStart CLEARS it at start (a
  // restarted agent is no longer done) - two small helpers + three call sites.
  // 280->300 for S3.9 (owner-approved): the Chat-on-Done reopen orchestration
  // (openChat) is EXTRACTED here (mirroring runCreate/runStart) rather than
  // inlined in manager.ts, holding manager.ts at its 490 cap; + death-proof
  // resolution guards and runCreate catch parity.
  // 300->308 (S6a, 2026-07-21, thin seam lines): two syncAgentType call sites
  // (harvest roster + set the session mode before the prompt) + its import; ALL
  // the logic lives in the new agentManager/agentTypes.ts (its own cap below).
  // 308->300 (0.2.171, DOWNWARD): shed the verified-loop params; the plain completion
  // moved to completion.ts (imported here), so the lifecycle stayed sub-cap.
  'src/dashboard/agentManager/run.ts': 300,
  // setupScript.ts (macOS port): the .origami/setup-script lookup, EXTRACTED from
  // run.ts rather than raising its cap when the runner order became a per-platform
  // decision (Windows ps1/cmd/sh vs sh/pwsh elsewhere) — run.ts was 299/300 and
  // came back to 285. Intro 60 (incl. the sh-quoting rule) + slack; a leaf, keep it one.
  'src/dashboard/agentManager/setupScript.ts': 75,
  'src/dashboard/agentManager/registry.ts': 140,
  // tickets.ts (Folds Board B): the ticket-file store — parse/serialize (unknown
  // frontmatter keys preserved, targeted line edits only), TicketRow projection,
  // quick-add/close/stamp lifecycle helpers, the launch composition (id-first
  // rawName + prompt envelope) and the poll-tick change hash + activity throttle.
  // Its own module so manager.ts stays a thin dispatch. Intro 463 + slack.
  // The cap DID NOT MOVE — the file SHRANK 498 -> 396. It had crept 8 over, and 8
  // over is the tripwire saying one of the five jobs named above wants its own
  // module, not that 8 lines want shaving: the DOCUMENT format left for ticketDoc.ts
  // and took a third of the file with it.
  'src/dashboard/agentManager/tickets.ts': 490,
  // ticketDoc.ts (Folds Board B): the ticket DOCUMENT format, extracted from
  // tickets.ts at its cap — the frontmatter round-trip (every line kept as raw
  // bytes, so unknown keys survive a rewrite), the scalar/list readers, the
  // insert-in-place line edit and the two body sections. Pure text, no fs: a
  // round-trip assertion needs no temp dir. Intro 126 + slack.
  'src/dashboard/agentManager/ticketDoc.ts': 150,
  // specRun.ts (Folds Board UAT-1 item 3): the SPEC conversation — session at the
  // REPO ROOT (no worktree, no record), chat opened before the prompt, the brief,
  // the live-spec marks the board's chip reads, and the file-decides-it settle.
  // Its own module because manager.ts had ONE line under its cap; stamped at
  // authored size with NO slack — the next thing to land in it extracts.
  'src/dashboard/agentManager/specRun.ts': 108,
  // repoFile.ts (Folds Board B): composes (workspace + known) -> atomic write of
  // ~/.origami/repos.json, the disk registry the engine's board_* tools and any
  // outside agent read. Best-effort by design (a failed write never blocks boot).
  // Intro 88 + slack. The cap DID NOT MOVE for the repo-cards slice: `primary`,
  // the merge model and adopt-on-read all wanted room, so the MERGE RULE and the
  // shared shapes were extracted to repoMerge.ts and this file kept only its fs
  // half (path / read / atomic write / sync / the two lookups), landing at 98.
  'src/dashboard/agentManager/repoFile.ts': 100,
  // repoMerge.ts (repo cards): the merge model for ~/.origami/repos.json, now
  // that the extension is NOT its only writer. Key by root, change only what your
  // operation touched, keep every other entry and every unknown field verbatim —
  // plus setPrimary / dropEntry / adoptRoots, the three operations the board
  // performs on it. Pure over plain objects, so the whole rule is tested on
  // literals with no temp dir. A LEAF; intro 151 + slack.
  'src/dashboard/agentManager/repoMerge.ts': 175,
  // repoCards.ts (repo cards): the REPOSITORY behind the registered path — the
  // git-ident cache the broadcast reads synchronously, the worktree-row
  // projection, adopt-on-read, and the four am* routes (worktrees / terminal /
  // chat here / make primary), each re-checking that the path it was handed is
  // really one of that repository's worktrees. Its own module so manager.ts stays
  // a thin dispatch. Intro 162 + slack.
  'src/dashboard/agentManager/repoCards.ts': 190,
  // board.ts (repo cards): the amState projection + the roster pre-fill,
  // EXTRACTED from manager.ts (461/470 after the slice's routing landed) when
  // every field of a RepoBoard had to start resolving the repo's PRIMARY
  // checkout. The cap on manager.ts did not move. A LEAF; intro 96 + slack.
  'src/dashboard/agentManager/board.ts': 120,
  // agentTypes.ts (S6a): the typed-agent seam — the pure roster merge + the
  // harvest/apply orchestration (syncAgentType) driven from the run lifecycle.
  'src/dashboard/agentManager/agentTypes.ts': 90,
  // archetypes.ts (S9): the Folds predefined agent archetypes (architect/ask/debug/
  // orchestrator) shipped as engine agent-definition files + the write-if-missing,
  // install-once installer. Mostly the four long-form prompt strings; capped at
  // introduction with slack for prompt wording tweaks.
  // 180->340 (S11, owner-approved): the v2 permission hardening DOUBLES the payload
  // — the four v2 prompt strings gain deny-by-default permission blocks + one worked
  // example each, AND the exact v1 strings are frozen alongside (ARCHETYPES_V1) so
  // the upgrade pass can tell a pristine v1 file from a user-edited one.
  // 340->300 (S12, DOWNWARD restamp): the frozen PRIOR payloads (v1 + v2) moved to
  // archetypesLegacy.ts, so this file holds ONE live set (v3, now 5 files incl. the
  // scout subagent) + the generalized upgrade pass. Shrank to actual (285) + slack.
  // 300->370 (S15, owner-approved, same pattern as the S11 180->340 raise): a SIXTH
  // archetype - cartographer.md - is added inline (frontmatter permission block + the
  // ~380-word prompt with the embedded map schema + a worked example). New surface,
  // not a god-file; a new archetype legitimately grows this data module.
  // 370->395 (map-v2): cartographer prompt rewritten with 5-pillar table, sub-section
  // docs, v2 schema with status/section fields, and updated worked example.
  'src/dashboard/agentManager/archetypes.ts': 395,
  // mapSchema.ts (S15): the repo-map schema types + validateMap (structural + reference
  // integrity). A pure LEAF; capped at introduction (175) + slack.
  'src/dashboard/agentManager/mapSchema.ts': 200,
  // mapRun.ts (S15): the cartographer run lifecycle extracted from manager.ts - run/
  // cancel, on-disk status read + staleness, builtAt stamp + html render, and the
  // task-run brief injection. Capped at introduction (207) + slack.
  'src/dashboard/agentManager/mapRun.ts': 230,
  // mapHtml.ts (S15): the self-contained static map.html renderer (inline CSS + JSON +
  // flow-selection JS, no external assets). A pure LEAF; capped at introduction (139) + slack.
  // 160->195 (map-v2): added 5-pillar column layout with section groups, status badges,
  // purpose subtitles, and conventions sidebar section.
  // map-iso: the artifact became an ISOMETRIC drawing (stats strip, grouped component
  // list, extruded map, two-tab detail panel, pan/zoom) and the cap did NOT move. The
  // four parts were extracted first — isoProject/isoLayout (geometry), mapHtmlCss
  // (sheet), mapHtmlSvg (picture), mapHtmlScript (behaviour) — leaving this file as the
  // assembler at 142. It also dropped its OWN third copy of the five pillars, which the
  // mirror's drift guard never covered, and now reads them from mapSchema.ts.
  'src/dashboard/agentManager/mapHtml.ts': 195,
  // isoProject.ts (map-iso): the 2:1 isometric CAMERA — grid cell to screen point, and
  // a grid box to its three visible faces. A pure LEAF, split from the layout because
  // placement changes and a camera does not; intro 105 + slack.
  'src/dashboard/agentManager/isoProject.ts': 125,
  // isoLayout.ts (map-iso): where every node stands, how big it is, and which lines
  // join them. Computed ONCE on the host and serialized into both renderers (the static
  // artifact and the webview payload) instead of being mirrored — a mirror is the right
  // trade for a five-entry constant table and the wrong one for ~180 lines of geometry,
  // whose only possible drift guard is a byte-compare. A pure LEAF; intro 239 + slack.
  // flow-spine: the plan became STREETS (one per flow) plus a docked district slab, and
  // the cap did NOT move — it SHRANK to 159, because sizing/emitting one solid went to
  // isoBox.ts, the packing search to isoPack.ts, the dock to isoDock.ts and the
  // connectors to isoWires.ts. This file is now the streets and the assembly.
  'src/dashboard/agentManager/isoLayout.ts': 260,
  // isoBox.ts (flow-spine): ONE component as a solid — footprint from connectivity,
  // height from flow participation, the pillar-5 stack, the badge. Shared by both
  // placements (a box on a street and a box in a district are sized identically), which
  // is exactly why it is one function and not two. Intro 118 + slack.
  'src/dashboard/agentManager/isoBox.ts': 140,
  // isoPack.ts (flow-spine): the shelf-packing SEARCH — every ordering, every wrap
  // width, smallest W + D wins (which IS the projected picture's size). A search wants
  // its own tests: "does it beat the naive order" is a question about this module, not
  // about where flows go. Intro 125 + slack.
  'src/dashboard/agentManager/isoPack.ts': 145,
  // isoDock.ts (flow-spine): everything no flow touches, packed into pillar districts
  // and dropped below the last street. Split from the streets because it is the half
  // that grows — a new grouping rule or bias lands here. Intro 108 + slack.
  'src/dashboard/agentManager/isoDock.ts': 130,
  // isoWires.ts (flow-spine): the bowed connector an edge draws as (with the arrowhead
  // whose sign no screenshot can check) and the traced flow path with its step badges.
  // Builds NO path strings — each renderer formats `M s Q c e` itself. Intro 140 + slack.
  'src/dashboard/agentManager/isoWires.ts': 160,
  // mapPalette.ts (flow-spine): the kind / pillar / flow colour tables + shade(). DATA
  // ENCODING, not theme chrome, so they are literal hexes on both surfaces; MIRRORED
  // into webview/dashboard/components/repoMapPalette.ts under the usual drift guard.
  // Intro 72 + slack.
  'src/dashboard/agentManager/mapPalette.ts': 90,
  // mapHtmlCss.ts / mapHtmlSvg.ts / mapHtmlScript.ts (map-iso): the artifact's sheet,
  // picture and behaviour, extracted from mapHtml.ts so the assembler kept its cap —
  // the same shape labyrinthAtlasCss.ts + labyrinthAtlas.ts take beside labyrinthHtml.ts.
  // Each is a pure LEAF capped at introduction (100 / 89 / 204) + slack. NOT in
  // THEMED_FILES, deliberately: map.html opens off a file:// URL where no --og-* var
  // exists and no running document can be read, so it commits to one fixed palette.
  // flow-spine: the artifact became the picked mockup's drawing (kind colours, two
  // filter legends, two folding rails) and NONE of these three caps moved. Four more
  // leaves were extracted instead: mapHtmlDrawCss (the picture's sheet), mapHtmlWires
  // (the connectors), mapHtmlDetail (the right panel) and mapHtmlRails (the controls).
  'src/dashboard/agentManager/mapHtmlCss.ts': 120,
  'src/dashboard/agentManager/mapHtmlSvg.ts': 110,
  'src/dashboard/agentManager/mapHtmlScript.ts': 230,
  // mapHtmlDrawCss.ts (flow-spine): the DRAWING's sheet — stage, solids, connectors,
  // labels, hover card — split from the page sheet beside it. The page changes when a
  // control moves; the drawing changes when the visual language does. Intro 69 + slack.
  'src/dashboard/agentManager/mapHtmlDrawCss.ts': 90,
  // mapHtmlWires.ts (flow-spine): every edge and every flow trace, rendered UP FRONT
  // and shown by class — which is what lets the inline script build no SVG at all, and
  // therefore need no namespace URI in a document that must contain no URL. Intro 53.
  'src/dashboard/agentManager/mapHtmlWires.ts': 70,
  // mapHtmlDetail.ts / mapHtmlRails.ts (flow-spine): the artifact's right-hand panel
  // and its two rails. Both are SPLICED INSIDE mapHtmlScript.ts's IIFE as text, so the
  // three share one closure rather than handshaking through `window` in a sealed
  // offline page. Split because the script hit its cap. Intro 91 / 128 + slack.
  'src/dashboard/agentManager/mapHtmlDetail.ts': 110,
  'src/dashboard/agentManager/mapHtmlRails.ts': 150,
  // mapExport.ts (flow-spine): "save this map as a page" — the ONE part of the map tab
  // that talks to VS Code chrome. Same split as DashboardPanel's exportLabyrinth case
  // (webview asks, host owns the dialog and the write), reversed only in who renders:
  // a map's content is host-side and pure, so nothing but the request crosses. Intro 41.
  'src/dashboard/agentManager/mapExport.ts': 60,
  // mapTab.ts (S15): the repo-map editor tab (createWebviewPanel + one-tab-per-repo
  // dedupe), mirroring compareTab.ts. Capped at introduction (62) + slack.
  // map-iso: +18 for RepoMapPayload — the tab computes the map's geometry at open and
  // ships it with the map, which is what spares the webview a mirrored layout module.
  'src/dashboard/agentManager/mapTab.ts': 90,
  // archetypesLegacy.ts (S12): the FROZEN prior-generation payloads (ARCHETYPES_V1 =
  // S9, ARCHETYPES_V2 = S11), moved out of archetypes.ts so the live file stays
  // readable. Append-only static data (a new generation appends a const); capped at intro.
  'src/dashboard/agentManager/archetypesLegacy.ts': 240,
  // archetypeGlyphs.ts (S11): the brand-menagerie glyph data (crane/elephant/cat/fox/
  // wolf/dragon/deer polygon lists, harvested from origami-svgs) + the id->glyph lookup.
  // Almost entirely static polygon data; a LEAF, capped at actual + slack.
  // 170->190 (W9, owner-approved — FLAG FOR SIGN-OFF). EXTRACTION CAME FIRST, three
  // times over: the owner's "many more glyphs" ruling added TWENTY-SIX creatures and
  // not one polygon of them landed here (menagerieGlyphs.ts, 354 lines), and the alias
  // table + key rules left collabGlyphs.ts for glyphNames.ts rather than growing either.
  // What is left here is the COMPOSITION (three imports, one spread) plus `glyphKeys`,
  // the picker's list, which must live with the table it is derived from — the literal
  // it replaces sat in CollabAgentForm.svelte and had already fallen a glyph behind it.
  // The remaining growth is the header explaining a four-file layout that did not exist
  // before; squeezing it out would move the number without making anything simpler.
  'webview/dashboard/components/archetypeGlyphs.ts': 190,
  // menagerieGlyphs.ts (W9): the twenty-six new origami creatures, data only. Pure
  // append-only art in a fixed shape (64x64 viewBox, polygons, per-polygon opacity,
  // no colour anywhere — glyphRegistry.test.ts enumerates and parses every one). A
  // new creature legitimately grows a data module; capped at introduction (354) + slack.
  'webview/dashboard/components/menagerieGlyphs.ts': 380,
  // glyphNames.ts (W9): the alias table, `glyphKey`, and which keys the PICKER offers.
  // Split from collabGlyphs.ts (80/85 when the menagerie arrived) because that file's
  // own header already said it held two jobs — art, and names — and only the second
  // one grew: one alias became seven. Pure, and it never imports the glyph table (that
  // would be a cycle), so `offeredGlyphKeys` is handed the keys. Intro 66 + slack.
  'webview/dashboard/components/glyphNames.ts': 80,
  // NO glyphIconSvg.ts / botTabIcon.ts HERE, and the absence is the record.
  // W9 shipped a bot's glyph as its EDITOR TAB icon (a generated media/glyphs
  // pair per creature, resolved at panel creation). It failed live UAT — the
  // tab fell back to the crane — and the owner reversed the whole surface:
  // "we had a lot of issues changing the editor tab svg before... bad idea
  // given the complexity it exposed". tabIcon.ts is back to its pre-wave shape
  // and its own header still carries the four falsified swap schemes. The
  // replacement surface is the CHAT PANE's empty state, which is ordinary
  // webview markup (ChatEmptyState.svelte) and needs no assets at all.
  // ArchetypeGlyph.svelte (S11): the tiny presentational renderer for a glyph's
  // polygon list in currentColor (nothing for an unmapped type). Capped at intro.
  'webview/dashboard/components/ArchetypeGlyph.svelte': 40,
  // permissions.ts (S5.2): the pure auto-approve decision + allow-option picker
  // for background agent permission asks. A LEAF — capped at introduction.
  'src/dashboard/agentManager/permissions.ts': 80,
  // permScope.ts (S6e, 2026-07-22): the repo-scoped auto-approve — repo-root
  // ascent + Windows-aware path-inside check + the allow/deny/forward decision,
  // extracted (NOT restamped into permissions.ts) so the safety logic is its own
  // testable leaf. Capped at introduction.
  'src/dashboard/agentManager/permScope.ts': 130,
  // attention.ts (S7, 2026-07-22): the pure, vscode-free decision leaves for the
  // "needs you" surface — isSessionMounted (mounted-view check), questionPreview,
  // and the board aggregate (running/need-you counts + the status-bar label).
  // Capped at introduction; a LEAF (grows only if the derivations themselves change).
  'src/dashboard/agentManager/attention.ts': 70,
  // questionRouting.ts (S7.1, 2026-07-22): the pure discriminator + routing leaves —
  // isQuestionShaped (no allow_always => a question, not a real permission),
  // shouldBufferQuestion, questionReplayAction. A LEAF; capped at introduction.
  'src/dashboard/agentManager/questionRouting.ts': 60,
  // permissionPreview.ts (S7.1, 2026-07-22): the plan_exit + dream-review previews
  // extracted VERBATIM from onPermissionRequest so DashboardPanel held its cap while
  // the S7.1 question routing landed. Behaviour-preserving; capped at introduction.
  'src/dashboard/agentManager/permissionPreview.ts': 60,
  // persistentPermissions.ts (0.2.175): the shell-side recall of allow_always across
  // engine restarts — the pure wildcard matcher (mirrors core/util/wildcard.ts), the
  // rule store over a workspaceState Memento, the replay decision, and the forward/reply
  // stash. A LEAF; capped at introduction (165) + slack.
  'src/dashboard/agentManager/persistentPermissions.ts': 185,
  // sessionRestore.ts (0.2.175): the full open-set (engine ids + active + grid) persist
  // + reopen-via-recall planner and enactor. Pure planners + memento glue; capped at
  // introduction (133) + slack.
  'src/dashboard/agentManager/sessionRestore.ts': 155,
  // sessionOrder.ts (sidebar drag-to-reorder): the PURE "apply a webview id order
  // to the live sessions map" rank, owning the never-lose-a-session rule for an
  // order sent from a stale list. A SIBLING of sessionRestore.ts rather than a
  // part of it — that file had 8 lines under its cap, so the ratchet's own remedy
  // (extract, never raise) applies. A LEAF; capped at introduction (40) + slack.
  'src/dashboard/agentManager/sessionOrder.ts': 55,
  // chatSections.ts (extension half, t-kgserq): persistence for the sidebar's
  // chat-grouping sections — membership/collapsed/name, memento glue mirroring
  // sessionRestore.ts's split (pure planners + a thin load/save). The webview
  // half (grouping rule, divider clamp) is the separate webview/chat/
  // chatSections.ts — see that file's own comment for why the split is not a
  // mirror. A LEAF; capped at introduction (78) + slack.
  // 78->176 (t-kgserq v2, EXTRACT FIRST): Main/N-custom-sections/Loops
  // replaced the old fixed Loops+one-custom shape — a genuinely bigger
  // responsibility (addSection/removeSection/renameSection/
  // toggleSectionCollapse didn't exist before), not bloat. The ONE-TIME v1
  // blob conversion was pulled OUT to chatSectionsMigration.ts BEFORE raising
  // this — a separable concern (read an old shape once) from the ongoing
  // state machine this file now is. Still over after that extraction, so
  // raised to 190 rather than folding CRUD functions into the migration file
  // just to hit the old number.
  // t-r43glr (2026-08-14): built-in "Loops" and the pre-v2 "spare" custom
  // section are RETIRED (owner wants Main-only built-ins, user sections
  // remain). chatSectionsMigration.ts's whole job — synthesizing a section
  // out of an old blob — was exactly the behaviour being removed, so the
  // file is DELETED rather than kept dead; the one thing still needed from
  // it, the legacy id a prior release may already have saved to disk, is now
  // a two-line rejection inline in parseSections. Cap left at 190 (well
  // under, not a ratchet-down — shrinking below cap needs no cap change).
  'src/dashboard/chatSections.ts': 190,
  // chatSectionsManager.ts (t-kgserq v2): chat-section messages routed OUT of
  // DashboardPanel.ts's inline switch, mirroring collabManager.ts's own
  // dispatcher shape (a MESSAGE_TYPES set + a handle()) — the same remedy
  // that file's own cap comment already used once. Wiring only; the state
  // machine is chatSections.ts. Intro 98 + slack.
  'src/dashboard/chatSectionsManager.ts': 120,
  // Apply-to-main modules — never ratcheted at S4 (a verify gap). Stamped at
  // S4.2 at current size rounded up: apply.ts gained markUntracked wiring +
  // already-applied (reverse --check) detection; the other three are unchanged.
  'src/dashboard/agentManager/apply.ts': 300,
  'src/dashboard/agentManager/diffProvider.ts': 90,
  // raceCompare.ts (S6c): the race Compare surface's server side — per-sibling
  // change sets (reusing apply.ts diffFiles) + the cross-diff path resolution.
  'src/dashboard/agentManager/raceCompare.ts': 100,
  // repoOps 80->160 for S5: onAddRepo + onRemoveRepo moved here (their natural
  // home) to reclaim room in manager.ts for the fan-out routing.
  'src/dashboard/agentManager/repoOps.ts': 160,
  'webview/dashboard/components/AgentDiffPanel.svelte': 280,
  // AgentCard (S5): THE CARD extracted from the pane (line1/line2, icon rail,
  // inline queued-task editor, AgentDiffPanel mount).
  // 320->318 (0.2.171, DOWNWARD): the verified-loop status panel mount + row fields removed.
  'webview/dashboard/components/AgentCard.svelte': 318,
  // AgentManagerPane restamped 340->560 for the S3.6 kanban rewrite, 560->720
  // for the S3.7 UX pass (always-on collapsible sections, repo/card filters, the
  // per-card ⋯ menu, Queue button, the AgentModelSelect swap).
  // 720->760 for S4.1 (owner-approved): a fourth "Merged" board section (retired
  // cards from a clean apply-to-main) with its own bucket branch, collapsed-by-
  // default rule, "· merged" line2, and a Chat/Delete/Prune rail; reclaiming
  // couldn't fit the extra section+rail branch.
  // 760->650 for S5: THE CARD extracted to AgentCard.svelte (the ratchet working
  // as intended — stamped DOWN to the new size + margin). The pane gained the
  // race toggle + variant rows + grouped rendering but still shrank overall.
  // 650->660 (S6b, 2026-07-21, thin seam): the create form gained an extra
  // control shown only for one agent type. 660->625 (0.2.171, DOWNWARD): that
  // control + its state and the row's verified-loop fields were removed with the type.
  // 625->660 (S15, owner-approved, within the historical 660 the pane held pre-0.2.171):
  // the per-column map header row (Map repo / Remap / View map / Cancel + the fresh /
  // N-behind / failed status), its RepoMapState type, and the map styles.
  'webview/dashboard/panes/AgentManagerPane.svelte': 660,
  // AgentModelSelect (S3.7): the compact searchable model combobox.
  'webview/dashboard/components/AgentModelSelect.svelte': 240,
  // AgentTypeSelect (S6a): the roster-driven agent-type picker shared by the
  // create form, the card editor and each race-variant row.
  // 60->160 (S12, owner-approved): the native <select> became a custom listbox so
  // each entry shows its brand GLYPH + a capitalized name — trigger + fixed-position
  // popup (anti-clip, mirroring AgentModelSelect), keyboard nav + ARIA, click-outside
  // backdrop, and scoped styles. Capped at actual (143) + slack.
  // 160->180 (S15, owner-approved): the popup became a 3-column TILE GRID (glyph/
  // initial-letter over the name) with 2D keyboard nav + the grid styles.
  'webview/dashboard/components/AgentTypeSelect.svelte': 180,
  // RaceGroup (S6c; S6d): the race cluster header extracted from the pane (at cap) —
  // count, a Compare button (S6d: posts amOpenCompare to open the tab), Prune rest.
  'webview/dashboard/components/RaceGroup.svelte': 120,
  // RaceCompareScreen (S6d): the full editor-tab compare SCREEN — two aligned
  // columns of REAL per-file diff text for the file union, sibling selectors,
  // refresh. Replaces the deleted in-column RaceComparePanel (Passing's UAT).
  'webview/dashboard/panes/RaceCompareScreen.svelte': 250,
  // RepoMapScreen (S15): the full editor-tab map SCREEN - layer columns of node boxes,
  // the flows list, the selected-flow steps panel + SVG path connectors. Capped at
  // introduction (202) + slack.
  // repoMapPillars.ts: the five-pillar mirror, the section grouping and the
  // fit-to-width maths, EXTRACTED from RepoMapScreen.svelte during map-v2.
  // Grouping earns a test without a DOM — "a node with no section still appears
  // in its column" is invisible in a screenshot — and the mirror needs a drift
  // guard (repoMapPillars.test.ts), because tsconfig.webview.json pins rootDir
  // to `webview/` so the webview cannot import mapSchema.ts's copy. Intro 73.
  'webview/dashboard/components/repoMapPillars.ts': 110,
  // 250->265 (map-v2): 5-pillar layout with section groups, status badges,
  // conventions, pillar number badges, and the fit-to-width control. Raised
  // ONLY after the extraction above took the pillars, grouping and fit maths
  // out; the remaining 15 lines are the feature itself. Compressing unrelated
  // rules to get back under 250 would move the number without making the pane
  // simpler, which is the thing this ratchet exists to prevent.
  // map-iso: the pane became an ISOMETRIC drawing with a stats strip, a grouped
  // component list, a two-tab detail panel and a hint bar — and the cap did NOT
  // move. It SHRANK to 223, because the picture went to IsoStage.svelte, the
  // camera maths to isoView.ts, and the geometry off this side of the seam
  // entirely (isoLayout.ts, host-computed, arriving in the tab payload).
  'webview/dashboard/panes/RepoMapScreen.svelte': 265,
  // IsoStage.svelte (map-iso): the map's picture + the camera that moves it,
  // extracted from RepoMapScreen.svelte, which was ONE line under its cap before
  // this view existed. It computes no geometry — every coordinate arrives
  // pre-projected and pre-sorted into painter's order. Intro 127 + slack.
  'webview/dashboard/components/IsoStage.svelte': 150,
  // isoView.ts (map-iso): the stage's pure viewport arithmetic — the zoom that
  // keeps the point under the pointer under the pointer, which is exactly the
  // class of bug a screenshot cannot show. A LEAF; intro 104 + slack.
  'webview/dashboard/components/isoView.ts': 125,
  // --- flow-spine: the map screen becomes the picked mockup. RepoMapScreen and
  // IsoStage both stayed UNDER their existing caps, because everything the rewrite
  // added went into new leaves rather than into them. ---
  // repoMapPalette.ts: the colour tables mirrored from mapPalette.ts (rootDir again).
  // Its own file, not more lines in repoMapPillars.ts — that leaf is named for the
  // pillars and was at its cap, and a colour table is a different kind of thing from a
  // grouping rule. Guarded by repoMapPillars.test.ts. Intro 55 + slack.
  'webview/dashboard/components/repoMapPalette.ts': 70,
  // repoMapFilters.ts: what a search matches and which captions a crowded picture may
  // draw. Pure, so the edge cases that are invisible on screen get asserted directly —
  // an empty query matching EVERYTHING rather than nothing is the sharpest. Intro 79.
  'webview/dashboard/components/repoMapFilters.ts': 100,
  // The picture in four painted layers. They are four components and not one because
  // SVG paints in document order and that order IS the layering: a caption emitted
  // beside the plate it names would vanish under the first tall solid standing on it.
  // Ground = plates, Nodes = solids, Wires = connectors + traces, Labels = every
  // caption, drawn last. Intro 37 / 65 / 81 / 70 + slack.
  'webview/dashboard/components/IsoGround.svelte': 55,
  'webview/dashboard/components/IsoNodes.svelte': 85,
  'webview/dashboard/components/IsoWires.svelte': 100,
  'webview/dashboard/components/IsoLabels.svelte': 90,
  // The two rails, extracted from RepoMapScreen.svelte so the pane owns state and
  // layout only. Both must fold away and drag to resize, which is why they are their
  // own elements rather than markup inside the pane. Intro 90 / 146 + slack.
  'webview/dashboard/panes/RepoMapFilters.svelte': 110,
  'webview/dashboard/panes/RepoMapDetail.svelte': 170,
  // 0.2.174 feel-tweaks — leaf components touched/added by the chat-surface pass, each
  // capped at its new actual size + slack (leaf, not god-file; grows only with real UI).
  // PermissionBar gained the verbatim-command block (tweak 1).
  'webview/dashboard/components/PermissionBar.svelte': 245,
  'webview/dashboard/components/QuestionModal.svelte': 450,
  // TodoStrip gained the run-time collapse tab + hidden-list gating (0.2.174 tweak 3).
  // 325->360 (0.2.176 tweak 1): the in-place collapse became a SIDE DRAWER — a .todo-panel
  // wrapper that slides off + a pull-tab handle + the always-mounted list + the drawer CSS.
  'webview/dashboard/components/TodoStrip.svelte': 360,
  // ModelPicker gained the structured provider/quant/name label rendering (tweak 4).
  // 515->590 (0.2.177 provider-picker simplify, owner-approved restamp — flag for
  // sign-off): tier-1 now renders one tab per LOCAL provider + a single "Lab" tab
  // that folds all cloud/compat providers behind a second-level sub-select, plus a
  // "+ Connect Ollama" affordance. New UI surface (a whole grouping tier), not a
  // god-file; the PURE projection lives in the modelGrouping.ts leaf below.
  // 590->610 (sub-agent model override, t-kgtuxp): EXTRACTION CAME FIRST — the
  // tier-2 model projection (visibleModels + MODEL_CAP) moved out to the new
  // modelList.ts leaf, which paid for about two thirds of what landed. What is
  // left is genuinely new SURFACE, not fat: a target control (this chat vs the
  // sub-agents it spawns) that redirects the pick to setSubagentModel, plus its
  // four style rules. Squeezing the rest would mean folding the ctx-prompt block
  // or the model row into a child component — two lifetimes' worth of CSS split
  // across three files to move a number, which is exactly what this table exists
  // to prevent.
  // 610->558 (round 5, t-o92558): tier-1 now renders one tab per SECTION
  // (Local/Hosted/Providers/Labs/Other, see modelGrouping.ts) instead of a
  // hardcoded local-vs-Lab split — a single generic loop replaced the old
  // per-tier markup block, which is why this SHRANK despite gaining three
  // more groups. Cap left at its old value; no reason to lower a number that
  // is not being gamed.
  'webview/dashboard/components/ModelPicker.svelte': 610,
  // modelLabel.ts (tweak 4): the pure parseModelId provider/quant/name split — a LEAF.
  'webview/dashboard/components/modelLabel.ts': 75,
  // modelGrouping.ts (0.2.177): the pure tier-1 projection — group local-vs-Lab.
  // Round 5 (t-o92558, 78->99): replaced the hardcoded local/Lab split with the
  // SAME four-way section connectionSection.ts already uses (Local/Hosted/
  // Providers/Labs), so OpenCode's Providers reclassification reads the same
  // way here as in the sidebar. EXTRACTION CAME FIRST: WHICH tab is actually
  // selected (resolveTopSelection/resolveGroupProvider/resolveSelectedProvider)
  // moved out to the new modelSelection.ts leaf below — grouping decides WHERE
  // a provider sits, selection decides WHAT is picked, and the two have
  // different callers. What is left is the real cost of the four-way split
  // (bySection bucketing + the collapsed-pill shape) with nothing left to
  // extract without cutting one cohesive function in half. Cap raised with the
  // extraction, not instead of it.
  'webview/dashboard/components/modelGrouping.ts': 105,
  // modelSelection.ts (0.2.177 round 5, t-o92558): the pure "what is active"
  // half of modelGrouping.ts's old scope — top-level tab, in-pill sub-provider,
  // and the concrete provider a Grouping resolves to, incl. current-model
  // auto-select. A LEAF; capped at introduction (39) + slack.
  'webview/dashboard/components/modelSelection.ts': 55,
  // modelList.ts: the pure tier-2 projection — which model rows a provider
  // shows, filtered (name OR id) and with the already-loaded model floated to
  // the head. EXTRACTED from ModelPicker.svelte (589/590) before the sub-agent
  // target control was written. A LEAF; capped at introduction (53) + slack.
  'webview/dashboard/components/modelList.ts': 70,
  // permissionBanner.ts: the sticky permission-mode banner's per-session state,
  // extracted when the dead `get_permission_mode` poll was replaced by the live
  // mode stream — so "does the banner follow mode updates?" is testable without
  // a webview host. A LEAF; capped at introduction (63) + slack.
  'src/dashboard/permissionBanner.ts': 80,
  // connectOllama.ts (0.2.177) is GONE — row removed with the file. The picker's
  // "+ Connect Ollama" was the only caller, and it was a config WRITE sitting in
  // a selection-only surface; establishing a connection is the sidebar's job
  // (ControlStrip.svelte), where setupCatalog.ts already offers Ollama as a
  // normal localAuto preset. The picker now shows a text-only pointer instead.
  // keyOnlyPresets.ts (t-o92558 round 4): the per-preset table for providers whose
  // setup is key-only — base URL, key-probe shape, keyless catalog, default model —
  // plus the probe itself. Extracted BECAUSE the old code hard-coded OpenRouter, so
  // Zen/Go were validated nowhere and named wrong. `fetch` is injected; no vscode
  // import. Capped at introduction (231) + slack. Comment-heavy on purpose: the
  // "why this model id" and "why 401-only" reasoning is the whole value.
  'src/dashboard/keyOnlyPresets.ts': 250,
  // gatewayEntitlements.ts: which of a keyless-catalog gateway's models can THIS
  // key call — a one-token probe per catalog id, the same route the engine uses,
  // because Zen/Go's GET /models is a menu (same 64 ids for every key) while the
  // tier is enforced per request. Pure and fetch-injected like keyOnlyPresets.ts;
  // the panel owns caching/pacing, this leaf owns only the verdicts and the
  // concurrency bound. Intro 68 + slack.
  'src/dashboard/gatewayEntitlements.ts': 85,
  // setupProvider.ts (t-o92558 round 4): the add/re-key flow, lifted WHOLE out of
  // DashboardPanel.ts's message switch — which sat EXACTLY on its 6334 cap, so this
  // was extract-or-stop, not a preference. Dependency-injected like connectOllama.ts.
  // Capped at introduction (183) + slack.
  // RAISED 200→215 (notifyError, 2026-08-21): the file sat at 199/200 when the
  // owner hit "connect did NOTHING" — every failure exit posted to a chat
  // transcript that may not be visible from the CONFIG view. The fix (a `fail`
  // helper + an injected host toast) is +10 lines IN the flow's own failure
  // exits; there is no cohesive unit to extract from a file that IS the
  // extraction, so this is the honest raise the cap rule allows.
  'src/dashboard/setupProvider.ts': 215,
  // providerAuthPane.ts: the OAuth connections flow (ChatGPT / SuperGrok) — the
  // three provider_auth_* ACP calls, the browser hand-off and the config write.
  // Its own file for the pluginsPane.ts reason: DashboardPanel.ts was AT its cap
  // and the whole flow is the feature. Dependency-injected like setupProvider.ts
  // (write / openExternal / notifyReload / refresh are all passed in), which is
  // what lets a test prove "no apiKey is ever written" without a browser.
  // Capped at introduction (260) + slack.
  'src/dashboard/providerAuthPane.ts': 285,
  // providerUsage.ts: the READ half of an OAuth connection — one lazy
  // `provider_auth_usage` call per fold open, and the wording for its line. Not
  // folded into providerAuthPane.ts because that file sat at 284 of 285, and
  // because a read and a sign-in FLOW are different subjects. The engine holds
  // the credential and answers in percentages, so nothing here can see a token.
  // Intro 106 + slack.
  'src/dashboard/providerUsage.ts': 130,
  // providerRefresh.ts: "the key you just pasted counts NOW" — one
  // `provider_refresh` ext call fired after every provider-auth config write, so
  // the connect form, the Re-key form and the OAuth completion stop needing a
  // window reload. Its own file, not a line inside either flow, because BOTH
  // setupProvider.ts (199/200) and providerAuthPane.ts (284/285) sit one line
  // under their caps — and because both already take the same injected `write`,
  // so wrapping that one dependency covers all three flows and adds nothing to
  // either leaf. No wrapper in acpClient.ts either: it is at 1370/1370, and the
  // generic extMethod needs none (same call the collab_* and shell_stop paths
  // make). Intro 86 + slack.
  'src/dashboard/providerRefresh.ts': 110,
  // visionDetect.ts: "which of your models can see", asked of whichever local
  // server will answer — LM Studio's `/api/v0/models` type tag and Ollama's
  // `/api/show` capabilities array. Extracted from DashboardPanel.ts, which SHRANK
  // by 21 lines in the same pass: the old LM-Studio-only mapper lived inline and
  // adding a second flavour there would have pushed the file past its cap. Split
  // pure-parse (lmStudioVision / ollamaVision) from transport (fetchVisionProbe)
  // so both mappings are testable with fixtures and no server. Intro 141 + slack.
  'src/dashboard/visionDetect.ts': 165,
  // visionPin.ts: the per-model vision PIN — the third bit that tells a detected
  // answer from a manual one. Its own module beside visionDetect.ts rather than
  // inside it, because detection must stay a pure "what does the server say" and
  // the pin is "what did the owner say"; folding them would put the owner's
  // override inside the thing it overrules. Holds the store shape (a Memento, so
  // no `vscode` import), the reconcile write PLAN with both skips, and the click
  // handler — none of which needs a panel to test. Intro 179 + slack.
  'src/dashboard/visionPin.ts': 200,
  // oauthConnections.ts: the provider blocks an OAuth sign-in writes, plus the
  // method filter. A pure LEAF (no vscode, no network, no disk) so the catalog
  // is readable in one place and testable without a host. It is a MIRROR of
  // models.dev + each plugin's own allowlist, which is exactly why it is small,
  // heavily commented, and separate from the flow. Intro 136 + slack.
  'src/dashboard/oauthConnections.ts': 160,
  // ControlStrip.svelte: FIRST CAP, set here rather than raised. The connections
  // surface had no tripwire at all and had grown to 1059 lines before the OAuth
  // sign-in form (+174) landed in it. Capped at the new actual with NO slack on
  // purpose: the next thing to land in this file must extract, and the obvious
  // seam is already visible — the `{#if setupProvider.kind === 'oauth'}` block
  // is a self-contained form over four host messages and would leave as an
  // OauthConnectForm.svelte child. It was not extracted in the same pass that
  // introduced it because the pane's own state (methods/connected/error) is
  // shared with the pill logic, and splitting that under the same change would
  // have been two refactors at once.
  'webview/sidebar/ControlStrip.svelte': 1241,
  // providerIdentity.ts: the Add/Re-key form's pure decisions — the minted-vs-
  // reused provider id, the base-URL/model rules, and (0.4.28 incident) whether
  // a submit intends to CLEAR the stored API key. The whole payload builder
  // moved here out of ControlStrip.svelte, which was sitting EXACTLY on the cap
  // above with no room for the new field — extraction, not a raise, and the
  // rules gained a DOM-free test file (providerIdentity.test.ts) they never had.
  'webview/sidebar/providerIdentity.ts': 145,
  // PinnedUserMessage.svelte (tweak 2): the sticky last-user-message mirror — a LEAF.
  'webview/dashboard/components/PinnedUserMessage.svelte': 70,
  // pinnedUser.ts (0.2.176 tweak 2): the pure latestUserText selector split out of ChatPane
  // so the pin's "most-recent user message, not inFlight-gated" rule is a testable leaf.
  'webview/dashboard/components/pinnedUser.ts': 40,
  // ChatEmptyState.svelte (t-r7c757): the new-chat empty state, extracted WHOLE out
  // of ChatPane.svelte (crane + hint markup + CSS) to make room for the rotating-tip
  // timer. Mirrors ThinkingGlyph.svelte's shape below — a $effect-owned setInterval
  // whose teardown fires on unmount, except here the "active" gate is the component's
  // own mount lifecycle (ChatPane's hasConversation {#if}), so there is nothing to
  // duplicate. A LEAF; capped at introduction (108) + slack.
  // 130->150 (W9 round 2, FLAG FOR SIGN-OFF): a bot chat opens under its OWN
  // creature instead of the crane — the replacement for the reversed editor-tab
  // icon, and a far cheaper surface (ordinary markup; no generated assets, no
  // panel-creation ordering, none of what tabIcon.ts's four falsified schemes
  // cost). The growth is a prop, two imports, a one-line gate and a two-branch
  // hero. NOTHING WAS EXTRACTED: the tips already live in emptyStateTips.ts,
  // and pushing a one-line predicate into a module of its own to dodge a number
  // is the exact gaming this ratchet exists to prevent. Said plainly, in the
  // table, where the next person reads it.
  'webview/dashboard/components/ChatEmptyState.svelte': 150,
  // emptyStateTips.ts (t-r7c757): the pure tip list + the wraparound advance +
  // the seed->start mapping behind ChatEmptyState.svelte. Math.random lives ONLY
  // at the component's call site, never here, so a fixed seed reproduces the same
  // start under test. A LEAF; capped at introduction (37) + slack.
  'webview/dashboard/components/emptyStateTips.ts': 55,
  // ThinkingGlyph.svelte (0.2.176 tweak 3): the rotating origami animal shown while a
  // thought streams — an active-gated setInterval over ArchetypeGlyph with $effect teardown.
  'webview/dashboard/components/ThinkingGlyph.svelte': 75,
  // BoardShell.svelte: the Agents board's left nav rail + view routing (Folds/
  // Skills/Loops/Crons), added when the board grew from a single pane into a
  // multi-view surface. One VIEWS array drives both the rail and the routed
  // component; capped at introduction (169) + slack.
  // 190->190 (Crons->Loops rename, owner-directed): the mislabeled Crons tab
  // (it only ever showed /loop timers) renamed to Loops, incl. a repeat-glyph
  // icon swapped in for the old clock. Net +2 lines from the icon comment,
  // landing exactly at the existing cap — no raise.
  'webview/dashboard/panes/BoardShell.svelte': 190,
  // LoopsPane.svelte (Crons->Loops rename, owner-directed): the /loop
  // schedules view, now honestly describing PERSISTENCE (loopPersistence.ts)
  // instead of disclaiming it, plus a per-row cancel control and a
  // needs-attention section for a loop whose session didn't survive a
  // restore. A LEAF; capped at introduction (157) + slack.
  // Held at 185 through the persistent-loops + filter work by EXTRACTING the row
  // to LoopCard.svelte — the ratchet doing its job.
  'webview/dashboard/panes/LoopsPane.svelte': 185,
  // LoopCard.svelte: ONE loop row, serving both the live and the needs-attention
  // kinds, incl. the persistence toggle and the per-state sentence (the headless
  // "no chat open, still scheduled" case is the one that would otherwise read as
  // a lie). A LEAF; capped at introduction (77) + slack.
  'webview/dashboard/components/LoopCard.svelte': 100,
  // LoopCardHead.svelte: a loop card's identity + controls row (chat label,
  // interval, the persistence switch, Reopen, Cancel), extracted from LoopCard
  // at its cap when the reopen control landed. A LEAF; intro 48 + slack.
  'webview/dashboard/components/LoopCardHead.svelte': 70,
  // loopRows.ts: the Loops pane's two row wire shapes + canReopenChat, extracted
  // from LoopsPane.svelte at its cap in the same pass. Pure, so "is there a chat
  // to bring back?" — the rule deciding whether a control renders at all — is
  // testable without a DOM. A LEAF; intro 52 + slack.
  'webview/dashboard/panes/loopRows.ts': 70,
  // loopReopen.ts: the PURE plan + ordered enactment for bringing a persistent
  // loop's chat back. Owns the one-client-per-engine-session invariant
  // (detach before open) that also makes double-arming impossible, and the
  // honest degradation when the engine session will not load. Intro 143 + slack.
  'src/dashboard/agentManager/loopReopen.ts': 170,
  // loopRearm.ts: the PURE restore decisions for persisted loops — re-arm on a
  // live chat, recall headlessly when persistent, leave alone otherwise.
  // Extracted from loopPersistence.ts at its cap when `persistent` landed, the
  // same split cronService.ts/cronReconcile.ts took. Intro 63 + slack.
  'src/dashboard/agentManager/loopRearm.ts': 85,
  // loopSchedules.ts: the pure Session-map -> LoopScheduleInfo[] projection
  // behind the Loops pane's listLoopSchedules/loopSchedulesData wire.
  // Held at 100 through the next-run/last-run fields by EXTRACTING the
  // needs-attention wire shape to loopAttention.ts — the ratchet doing its job.
  'src/dashboard/loopSchedules.ts': 100,
  // loopAttention.ts: the PersistedLoop -> NeedsAttentionLoop wire shape,
  // extracted from loopSchedules.ts at its cap. Split along the honesty line
  // the two shapes already had — one of these has no armed timer to report.
  // A LEAF; capped at introduction (49) + slack.
  'src/dashboard/loopAttention.ts': 70,
  // loopFormat.ts: the Loops card's derived text — the next-run countdown and
  // the last-run line, both of which return '' rather than invent a value when
  // the underlying record is absent or half-present. Pure (clock injected),
  // mirroring cronFormat.ts. A LEAF; capped at introduction (46) + slack.
  'webview/dashboard/panes/loopFormat.ts': 70,
  // PersistSwitch.svelte: the loop persistence SETTING as a real switch —
  // replacing a button whose caption was the current fact ("Dies with chat"),
  // which read as a status label and hid that it was a control at all.
  // A LEAF; capped at introduction (63) + slack.
  'webview/dashboard/components/PersistSwitch.svelte': 85,
  // CronRowDetail.svelte: what a cron DOES, under its own row — the full
  // prompt (contained, never widening the table) plus the agent/model/
  // workspace/task/script/log facts the row cannot fit. Pure presentation over
  // data the table already holds, so expanding re-reads nothing.
  // A LEAF; capped at introduction (93) + slack.
  'webview/dashboard/components/CronRowDetail.svelte': 115,
  // loopPersistence.ts (Crons->Loops durability work): persisted /loop
  // schedules across a window reload, keyed by engine session id — save on
  // start/tick, remove on stop (the one choke point /loop stop and the
  // Loops-pane cancel both funnel through), split+arm live-vs-needs-attention
  // on restore. Mirrors agentManager/sessionRestore.ts's memento-glue +
  // host-callback pattern. A LEAF; capped at introduction (113) + slack.
  'src/dashboard/agentManager/loopPersistence.ts': 135,
  // --- Wave 4a board views: Labyrinth + Instructions (capped at introduction). ---
  // labyrinthLayout.ts: the PURE map geometry (thread / corridor / flight) +
  // the glyph and formatting leaves, so every mode's defining property is
  // testable with no DOM. Mirrors modelGrouping.ts. Intro 179 + slack.
  'webview/dashboard/components/labyrinthLayout.ts': 200,
  // labyrinthLanes.ts: the lane / threshold / tone rules, extracted when the
  // map gained lanes and labyrinthLayout.ts had no room under its cap. A LEAF;
  // capped at introduction (81) + slack.
  'webview/dashboard/components/labyrinthLanes.ts': 100,
  // labyrinthFormat.ts: the duration/clock/truncate/caption printing leaves,
  // extracted from labyrinthLayout.ts at its cap. Intro 32 + slack.
  'webview/dashboard/components/labyrinthFormat.ts': 50,
  // labyrinthBranches.ts (UAT-2 branch model): a sub-agent's steps as a BRANCH
  // that departs the trunk, runs its own column and merges back — the column
  // allocate/release ledger plus the three rail paths. Extracted rather than
  // grown into labyrinthLayout.ts, which was at its cap. Intro 180 + slack.
  'webview/dashboard/components/labyrinthBranches.ts': 200,
  // labyrinthMinimap.ts (corridor-as-minimap): the FIXED-canvas grid — cells
  // derived from the step count, the boustrophedon cell walk, and a delegated
  // stretch reserved as an inset CHAMBER block. Extracted rather than grown
  // into labyrinthLayout.ts, which was at its cap. Intro 176 + slack.
  'webview/dashboard/components/labyrinthMinimap.ts': 200,
  // LabyrinthMinimap.svelte (corridor-as-minimap): markup over those points —
  // chamber rects, the corridor line, and one caption-less marker per step.
  // A LEAF; capped at introduction (76) + slack.
  'webview/dashboard/components/LabyrinthMinimap.svelte': 95,
  // labyrinthMarks.ts (corridor kind marks, owner's UAT): the one-character mark
  // per step KIND plus its size/placement against the minimap's derived cell
  // pitch — including the size below which it is dropped rather than smeared.
  // A LEAF; capped at introduction (68) + slack.
  'webview/dashboard/components/labyrinthMarks.ts': 90,
  // labyrinthCaptions.ts (flight caption collision, owner's UAT): the rule that
  // drops a caption rather than draw it through its neighbour's. Extracted
  // rather than grown into labyrinthSwim.ts, which had 22 lines left under its
  // cap. A LEAF; capped at introduction (75) + slack. Held at 95 through the
  // TIME-AXIS round: it gained swimClockHidden but GAVE UP its greedy loop to
  // labyrinthCollide.ts, so both label rules share one policy.
  'webview/dashboard/components/labyrinthCaptions.ts': 95,
  // labyrinthCollide.ts (flight time-axis collision, owner's UAT): THE greedy
  // per-row drop, generalised out of labyrinthCaptions.ts so the caption row
  // and the clock row cannot end up with two policies that disagree about the
  // same strip. A LEAF; capped at introduction (71) + slack.
  'webview/dashboard/components/labyrinthCollide.ts': 90,
  // labyrinthThreadFit.ts (thread label overrun): how much furniture ONE marker
  // may print before it runs into the column beside it. Everything
  // LabyrinthNode.svelte draws was sized for the SPINE (LANE_GAP, 110); branch
  // columns are BRANCH_COL_GAP (40) apart, so the meta text ran clean across the
  // neighbour. A pure LEAF, mirroring labyrinthCollide.ts — jsdom has no layout
  // engine, so an overlap is only catchable as arithmetic. Intro 86 + slack.
  'webview/dashboard/components/labyrinthThreadFit.ts': 105,
  // labyrinthSearch.ts (run-index filter): which groups a query selects. Pure,
  // because the rule that is invisible in a screenshot is the one worth testing —
  // a collab HEADER survives when a MEMBER matches, since the member row is only
  // reachable underneath it. A LEAF; intro 50 + slack.
  'webview/dashboard/components/labyrinthSearch.ts': 65,
  // labyrinthFlightFrame.ts (fit-to-width): the six flight-only derivations —
  // lane extents, handoff arcs, the three density gates and the named rows — as
  // ONE value, extracted from LabyrinthMap.svelte, which had no room under its
  // cap when the map gained its fit control. Decides nothing new; it only says
  // which of labyrinthSwim/labyrinthCaptions/labyrinthRails flight needs
  // together, and hands the other two modes one empty value. Intro 51 + slack.
  'webview/dashboard/components/labyrinthFlightFrame.ts': 65,
  // LabyrinthFlightLabels.svelte (thread label overrun): the labels ONE flight
  // marker prints under itself — caption, inline detail rows, time-axis clock.
  // Extracted from LabyrinthNode.svelte, which was at its cap when THREAD's
  // furniture had to start budgeting itself against the column pitch. It is the
  // only consumer of the node's four density props. A LEAF; intro 53 + slack.
  'webview/dashboard/components/LabyrinthFlightLabels.svelte': 70,
  // LabyrinthMapToolbar.svelte (fit-to-width + collapsible inspector): the map
  // panel's toolbar — threshold filter, the three layouts, the two view switches
  // and Export. Extracted from LabyrinthPane.svelte, which was at its cap when
  // the fit and collapse controls landed. Presentation only: every control
  // reports up, so the pane still owns all of the state. Intro 65 + slack.
  'webview/dashboard/components/LabyrinthMapToolbar.svelte': 85,
  // LabyrinthRunSearch.svelte (run-index filter): the index's head — what the
  // panel is, how many rows it OFFERS, the filter box and the reload. Extracted
  // from LabyrinthRunIndex.svelte, which was at its cap when the filter landed.
  // Presentation only; the parent owns the query and does the matching.
  // Intro 42 + slack.
  'webview/dashboard/components/LabyrinthRunSearch.svelte': 55,
  // labyrinthColumns.ts (t-q41pe0, resizable Labyrinth columns): the pure
  // clamp + defaults behind the run-index/inspector dividers. A LEAF, no
  // vscode/DOM import — the drag GESTURE needs a human eyeball (jsdom has no
  // layout engine), but the clamp math is fully unit-tested here. Intro 28 + slack.
  'webview/dashboard/components/labyrinthColumns.ts': 45,
  // LabyrinthDivider.svelte (t-q41pe0): the draggable column divider itself —
  // pointer drag + capture, ArrowLeft/ArrowRight nudge, a real WAI-ARIA
  // separator — mirroring SidebarLauncher.svelte's Chats/Collabs divider
  // (t-kgserq) but kept as its OWN leaf rather than restamped into
  // LabyrinthPane.svelte, which had no room under its cap (see that entry
  // below). A LEAF; intro 104 + slack.
  'webview/dashboard/components/LabyrinthDivider.svelte': 120,
  // labyrinthHtml.ts (map export as a PAGE, owner's UAT): the self-contained
  // artifact — run header, the pane's own truncation notice, the inline map and
  // the step LEDGER the picture drops, everything from run content escaped.
  // Extracted rather than grown into labyrinthExport.ts, which had 13 lines
  // left under its cap. A LEAF; capped at introduction (162) + slack.
  // 185->130 (atlas, DOWNWARD restamp): the page became a full-bleed console and
  // grew a usage strip, a filter row, an inspector rail and a ledger drawer —
  // none of which is here. Its layout went to labyrinthAtlasCss.ts, its spend to
  // labyrinthStrip.ts, its chrome to labyrinthAtlas.ts and its table to
  // labyrinthLedger.ts, so this file ASSEMBLES and nothing else: 179 -> 115.
  // The ratchet working exactly as intended. Cap = actual + slack.
  'webview/dashboard/components/labyrinthHtml.ts': 130,
  // labyrinthAtlas.ts (atlas export): the exported console's CHROME — the run
  // content escaper shared by every part that writes markup, the kind filter row
  // (counts + a swatch off the SHARED tone table), the pinned inspector rail,
  // the ledger drawer and the drawer's behaviour. Extracted from labyrinthHtml.ts
  // rather than restamping it. A LEAF; capped at introduction (103) + slack.
  'webview/dashboard/components/labyrinthAtlas.ts': 125,
  // labyrinthAtlasCss.ts (atlas export): the console's LAYOUT — pinned header,
  // filter row, one scrolling map pane with the picture centred in it, the 400px
  // rail and the drawer. Almost entirely a CSS string; capped at intro (110) + slack.
  'webview/dashboard/components/labyrinthAtlasCss.ts': 135,
  // labyrinthStrip.ts (atlas export): the header's Flock usage strip, built off
  // the SAME usageBreakdown the live pane's strip reads — so the artifact and the
  // pane cannot disagree about a run's spend, `≥` included. Plus the wall-clock
  // leaf. A pure LEAF; capped at introduction (101) + slack.
  'webview/dashboard/components/labyrinthStrip.ts': 125,
  // labyrinthLedger.ts (atlas export): the step table, extracted VERBATIM from
  // labyrinthHtml.ts when it moved into the drawer. A LEAF; intro 43 + slack.
  'webview/dashboard/components/labyrinthLedger.ts': 60,
  // labyrinthTone.ts (atlas export): the kind -> theme-var table, shared by the
  // export's filter swatches and asserted against LabyrinthNode.svelte's own
  // tone rules, so the chip and the marker cannot end up two colour languages.
  // A pure LEAF; capped at introduction (34) + slack.
  'webview/dashboard/components/labyrinthTone.ts': 50,
  // labyrinthReport.ts (export as a REPORT, owner's UAT "click a node and you
  // get the stream's information"): the exported page's INTERACTIVE layer — the
  // per-step detail as JSON-escaped data, the selection/filter CSS and the
  // inline textContent painter. Extracted rather than grown into
  // labyrinthHtml.ts, which had 23 lines left under its cap. A LEAF; capped at
  // introduction (204) + slack — it prints the usage line via labyrinthUsage's
  // stepUsageText rather than keeping a second copy of the formatting.
  'webview/dashboard/components/labyrinthReport.ts': 225,
  // labyrinthExport.ts (map export, owner's UAT): the displayed SVG turned into
  // a file that renders standalone — computed presentation properties inlined
  // over the scoped cascade, then any surviving `var(--og-*)` resolved against
  // the live root palette. A LEAF; capped at introduction (97) + slack.
  'webview/dashboard/components/labyrinthExport.ts': 120,
  // LabyrinthRunIndex.svelte (map export, owner's UAT): the run-index panel
  // EXTRACTED from LabyrinthPane.svelte, which was at its cap when the map
  // toolbar needed its export control. Presentation only — the pane keeps the
  // history wire. A LEAF; capped at introduction (75) + slack.
  'webview/dashboard/components/LabyrinthRunIndex.svelte': 95,
  // labyrinthFlight.ts (UAT-2): the flight strip's geometry + its time-based
  // honesty gate, extracted from labyrinthLayout.ts (at cap) when flight grew
  // into the DETAIL view and needed its own sizing. Intro 87 + slack.
  'webview/dashboard/components/labyrinthFlight.ts': 105,
  // labyrinthSwim.ts (flight-as-swimlanes): the strip's LANE PER SUB-AGENT —
  // lane y off the branch-column ledger labyrinthBranches.ts already keeps, the
  // lane-aware canvas/clock row, each lane's clock-gated extent + departure +
  // rejoin, and the density rule that drops detail rather than overlapping it.
  // Extracted rather than grown into labyrinthFlight.ts (at 104/105) or
  // labyrinthLayout.ts. Intro 153 + slack.
  'webview/dashboard/components/labyrinthSwim.ts': 175,
  // LabyrinthSwimLane.svelte (flight-as-swimlanes): ONE lane's markup — depart,
  // bar, rejoin or open terminus. A LEAF; capped at introduction (45) + slack.
  'webview/dashboard/components/LabyrinthSwimLane.svelte': 60,
  // labyrinthSpans.ts (background sub-agents): WHEN a delegated run really
  // happened — detached?, returned?, and the merge index its clock supports.
  // Extracted from labyrinthBranches.ts at its cap once thread rails and the
  // flight strip both needed it. A LEAF; intro 94 + slack.
  'webview/dashboard/components/labyrinthSpans.ts': 115,
  // labyrinthRails.ts (background sub-agents): the drawn EXTENT of a delegated
  // run — depart/spine/trail/merge in thread, duration bars in flight.
  // Extracted from labyrinthBranches.ts when a branch became a span that can
  // outlive its own last step. Intro 131 + slack.
  'webview/dashboard/components/labyrinthRails.ts': 155,
  // labyrinthTime.ts (thread by clock): the ROW ORDER a run's clock supports —
  // rank by startedAt at a bounded pitch, plus the branch merges re-read against
  // that axis. Null when the clock is incomplete, so the view degrades to list
  // order wholesale. A LEAF; intro 85 + slack.
  'webview/dashboard/components/labyrinthTime.ts': 100,
  // labyrinthNotice.ts (thread by clock): what the map must SAY when it fell
  // back to list order — the two clock-positioned modes' wording in one place.
  // A LEAF; intro 31 + slack.
  'webview/dashboard/components/labyrinthNotice.ts': 45,
  // labyrinthDetail.ts (UAT-2): which inline detail rows a step has EARNED on
  // the flight strip — absent field, no row. A LEAF; intro 42 + slack.
  'webview/dashboard/components/labyrinthDetail.ts': 60,
  // labyrinthUsage.ts (per-turn token counts): what a run SPENT, totalled per
  // sub-agent branch / per agent / for the run, off the SAME branch model the
  // map is drawn from. Also owns the honesty rules for a total — a step with no
  // usage adds nothing, and a sum that is provably short says so. A pure LEAF
  // (no DOM), mirroring labyrinthSpans/labyrinthCollide; intro 197 + slack.
  'webview/dashboard/components/labyrinthUsage.ts': 220,
  // LabyrinthUsageStrip.svelte (per-turn token counts): the bounded spend strip
  // above the map — run headline, its components, a chip per agent and per
  // delegated branch, and the approximate warning. Markup over labyrinthUsage;
  // capped at introduction (103) + slack. The cap DID NOT MOVE for the real-cost
  // work: the headline went to LabyrinthSpendHeadline.svelte and the models row
  // to LabyrinthSpendModels.svelte, so this file assembles and nothing else.
  'webview/dashboard/components/LabyrinthUsageStrip.svelte': 125,
  // labyrinthCost.ts (real-cost headline): what a run REALLY cost, and on which
  // models — input equivalents (a cache read bills at a tenth, so the raw total
  // is not the bill), the cache-hit ratio, the per-model split with its request
  // counts and cutovers, and the indicative figure from the user's own prices.
  // Pure, and it sums through labyrinthUsage's own accumulator rather than
  // keeping a second copy of the arithmetic. Intro 172 + slack.
  'webview/dashboard/components/labyrinthCost.ts': 190,
  // LabyrinthSpendHeadline.svelte (real-cost headline): the one line that leads
  // the strip — real / raw / cached, the run's cost and the indicative figure —
  // plus the five raw components as one aligned row. Extracted from
  // LabyrinthUsageStrip.svelte at its cap. Intro 72 + slack.
  'webview/dashboard/components/LabyrinthSpendHeadline.svelte': 90,
  // LabyrinthSpendModels.svelte (models used, not model selected): which models
  // actually ran, with request counts, and the cutovers where the run changed
  // hands. Extracted from LabyrinthUsageStrip.svelte at its cap. Intro 56 + slack.
  'webview/dashboard/components/LabyrinthSpendModels.svelte': 70,
  // LabyrinthPrices.svelte (price panel): the user's own $/Mtok figures, one row
  // per model that ran. There is deliberately NO bundled price list, so the panel
  // is empty until they type. Intro 89 + slack.
  'webview/dashboard/components/LabyrinthPrices.svelte': 105,
  // LabyrinthCollabRows.svelte (price panel): a collab's member runs under their
  // header — the expander and the rows. Extracted from LabyrinthRunIndex.svelte,
  // which had no room left when the gear landed. Intro 49 + slack.
  'webview/dashboard/components/LabyrinthCollabRows.svelte': 65,
  // labyrinthExportMap.ts (price panel): the export ASSEMBLY step, extracted
  // from LabyrinthPane.svelte at its cap. The host/webview split it encodes is
  // unchanged by the move. Intro 59 + slack.
  'webview/dashboard/components/labyrinthExportMap.ts': 75,
  // labyrinthPrices.ts: the price table's HOST side — workspaceState round trip
  // plus the sanitiser, because a webview message is JSON that crossed a
  // boundary. Same shape as toolsPane.ts beside it. Intro 79 + slack.
  'src/dashboard/labyrinthPrices.ts': 95,
  // labyrinthHealth.ts (run-index cache health): WHEN a hit rate may be drawn at
  // all — never for a provider that reported no cache (a 0% there sends the
  // reader after a bug that is not real), and never on a sample too small to
  // mean anything. A pure LEAF; intro 62 + slack.
  'webview/dashboard/components/labyrinthHealth.ts': 80,
  // labyrinthBreaks.ts (0.4.51 UAT, model-change breaks): WHERE the run changed
  // model, as opposed to how many times it did — which labyrinthCost.ts's
  // `modelCutovers` already counts for the strip. Its own leaf and not more of
  // that file because the two answer different questions from the same data:
  // a count over BILLED requests is right for a total, and this one is
  // TRUNK-ONLY, because `run_steps` inlines a delegated child's steps and a
  // sub-agent on another model would otherwise read as two switches the run
  // never made. Pure; intro 68 + slack.
  'webview/dashboard/components/labyrinthBreaks.ts': 90,
  // LabyrinthBreaks.svelte (0.4.51 UAT): those breaks DRAWN — a rule across the
  // run's axis in thread and flight, and a tick on the cell in corridor, whose
  // boustrophedon snake has no line that means "after this point". Extracted
  // rather than grown into LabyrinthMap.svelte, which had three lines under its
  // cap. Intro 83 + slack.
  'webview/dashboard/components/LabyrinthBreaks.svelte': 105,
  // labyrinthHighlight.ts (0.4.51 UAT, chip-to-map highlight): what FADES while
  // a spend chip is hovered, off the same branch ledger and `agent` buckets the
  // chip's own total was summed from — a second model here is how a chip and
  // the region it lights end up describing different runs. Returns what to
  // fade, so an empty answer is the ordinary map, and it answers for MARKERS
  // and for RAILS separately: a `task` call is the step of the thread that made
  // it, so a rail keyed on its own spawn stays bright around faded work.
  // Pure; intro 90 + slack.
  'webview/dashboard/components/labyrinthHighlight.ts': 110,
  // labyrinthNav.ts (0.4.51 UAT, the back journey): which directory a run
  // belongs to, which message asks the host for it, and the trail back out of a
  // click-through. Extracted from LabyrinthPane.svelte at its cap; the cwd rules
  // moved VERBATIM, and the trail joined them because a rung has to REMEMBER the
  // directory it came from — a nested click-through's parent is not in the index
  // to recompute it from. It also owns WHEN Escape means back, because that is
  // the same journey reached by a key. Pure; intro 63 + slack.
  'webview/dashboard/components/labyrinthNav.ts': 80,
  // LabyrinthInspectColumn.svelte (0.4.51 UAT): the inspector column — its drag
  // divider and the panel behind it — moved VERBATIM out of LabyrinthPane.svelte
  // at its cap. No behaviour came with it: the pane still owns the width state
  // and the host round trip. Intro 34 + slack.
  'webview/dashboard/components/LabyrinthInspectColumn.svelte': 50,
  // LabyrinthMapCanvas.svelte (run-index cache health): the scrolling box the
  // map sits in, and the ResizeObserver that measures it — the fit denominator
  // now lives with the element it measures. Extracted from LabyrinthPane.svelte
  // at its cap; the pane still binds the element, because the EXPORT reads the
  // rendered SVG out of it. Intro 54 + slack.
  'webview/dashboard/components/LabyrinthMapCanvas.svelte': 70,
  // runStats.ts: the `run_stats` host leaf — per-run counts for one PAGE of the
  // run index. Separate from boardData.ts, which sits on its cap, and asked for
  // once per index load: every id costs the engine a whole message read, which
  // is why it is not folded into the `requestHistory` wire the chat history
  // dropdown also waits on. Intro 66 + slack.
  'src/dashboard/runStats.ts': 85,
  // historyRows.ts: the `requestHistory` → `historyList` projection, EXTRACTED
  // VERBATIM out of DashboardPanel.ts (which is far past any cap) so the drop
  // rules are assertable without an extension host. It is the file that decides
  // what counts as history, which is why it carries the reasoning for keeping
  // the OPEN chat in the list rather than dropping it. A leaf; intro 87 + slack.
  'src/dashboard/historyRows.ts': 110,
  // sessionPaging.ts: the `session/list` cursor loop, EXTRACTED from
  // acpClient.ts when following `nextCursor` to exhaustion pushed that file
  // past its cap (1403/1370). A leaf with no `vscode` import, so the loop's two
  // guards — de-duplicate by id, stop on a repeated cursor — are assertable
  // without an extension host. Intro 56 + slack.
  'src/sessionPaging.ts': 75,
  // LabyrinthNotices.svelte (per-turn token counts): the truncation + clock
  // notices EXTRACTED VERBATIM from LabyrinthPane.svelte, which was at its cap
  // when the spend strip needed mounting. A LEAF; intro 26 + slack.
  'webview/dashboard/components/LabyrinthNotices.svelte': 40,
  // LabyrinthMap.svelte: markup over those points — no geometry of its own.
  // Intro 92 + slack.
  'webview/dashboard/components/LabyrinthMap.svelte': 110,
  // LabyrinthNode.svelte: ONE marker — lane connector, threshold bar, circle,
  // glyph, labels. Extracted from LabyrinthMap.svelte at its cap when lanes and
  // per-kind glyphs landed. Capped at introduction (99) + slack.
  'webview/dashboard/components/LabyrinthNode.svelte': 120,
  // LabyrinthRail.svelte (background sub-agents): ONE branch rail — its four
  // segments plus the open terminus of a sub-agent that never returned.
  // Extracted from LabyrinthMap.svelte at its cap. A LEAF; intro 46 + slack.
  'webview/dashboard/components/LabyrinthRail.svelte': 60,
  // LabyrinthGlyph.svelte: the per-kind 24x24 stroke glyph table. A LEAF;
  // capped at introduction (52) + slack.
  'webview/dashboard/components/LabyrinthGlyph.svelte': 70,
  // LabyrinthInspector.svelte: one selected step, every row gated on the field
  // actually being present. Intro 77 + slack.
  'webview/dashboard/components/LabyrinthInspector.svelte': 95,
  // LabyrinthPane.svelte: the three-panel shell (run index / map / inspector)
  // + the requestRunSteps wire and the four honest states. Intro 184 + slack.
  // 205->195 (map export, DOWNWARD restamp): the run index was EXTRACTED to
  // LabyrinthRunIndex.svelte so the toolbar could gain its export control; the
  // pane shrank 203->185 net. Cap = actual + slack, per the ratchet.
  // 195->215 (t-q41pe0 resizable columns, +16, the SMALLEST raise the feature
  // admits — FLAG FOR SIGN-OFF): the pane was sitting 194/195, one line of
  // slack, when the two-divider feature landed. EXTRACTION CAME FIRST — the
  // clamp math went to the new labyrinthColumns.ts leaf and the divider's own
  // drag/keyboard/ARIA mechanics to the new LabyrinthDivider.svelte, mirroring
  // the run-index extraction above. What is left here is genuinely new
  // surface the pane must own itself (it is the only place holding both
  // columns' state and the shared container rect): two width state fields, a
  // container ref, two one-line commit posts, the mount-time restore request,
  // one more `else if` in the existing message listener, and two
  // <LabyrinthDivider> mounts. Cap = actual (211) + slack.
  'webview/dashboard/panes/LabyrinthPane.svelte': 215,
  // InstructionsPane.svelte: the system-prompt inventory, biggest-first, with
  // the chars/4 estimate labelled as such. Intro 140 + slack.
  'webview/dashboard/panes/InstructionsPane.svelte': 160,
  // PromptCaptureSection.svelte: the harness-transparency section under that
  // inventory — the labelled parts of the last turn's REAL prompt, the final
  // assembled system after any plugin reshaped it, and the tool inventory,
  // each row expandable to its full text. Its own component rather than more
  // pane, because InstructionsPane.svelte had 19 lines under its cap and the
  // ratchet's remedy is extraction. A LEAF; capped at introduction (166) + slack.
  'webview/dashboard/components/PromptCaptureSection.svelte': 190,
  // CacheStatsCard.svelte (t-kgtw47): the cache-hit-ratio card — its own
  // component rather than more pane, same reason as PromptCaptureSection.svelte
  // directly above (InstructionsPane.svelte had only 3 lines under its cap).
  // Self-contained: owns its own cacheStats/cacheStatsData wire. A LEAF;
  // capped at introduction (100) + slack.
  'webview/dashboard/components/CacheStatsCard.svelte': 115,
  // cacheRatio.ts (t-kgtw47): the pure read/(fresh+read+write) formula behind
  // the card, split out so it is testable with no DOM (mirrors modelLabel.ts /
  // pinnedUser.ts). A LEAF; capped at introduction (21) + slack.
  'webview/dashboard/components/cacheRatio.ts': 35,
  // InstructionRowActions.svelte: the "Restore default" button — split out of
  // InstructionsPane.svelte, which had NO lines under its cap (see above) and
  // the ratchet's remedy is extraction, not a raise. A LEAF, exports the pure
  // restoreKindFor rule alongside the button. Capped at introduction (57) + slack.
  'webview/dashboard/components/InstructionRowActions.svelte': 75,
  // instructionRows.ts: the pure PINNED-row rules of the Instructions pane
  // (order, display name, badge, and which host message a click sends) for the
  // three shipped prompts a user can override. Its own module because the pane
  // sat exactly ON its 160-line cap when the two collab rows arrived, and the
  // ratchet's remedy is extraction, not a raise — the pane came back to 152.
  // A LEAF, vscode-free and render-free. Capped at introduction (64) + slack.
  // 80->78 (M4.1 wave R2x, DOWNWARD restamp): `collab-manual` was retired with the
  // engine row that fed it — dropped from PINNED, NAMES and the collab tier. Deletions
  // only, so the cap goes to the new ACTUAL (78) with no slack: this file has been at
  // its ceiling twice already, and the next thing to land in it extracts.
  'webview/dashboard/components/instructionRows.ts': 78,
  // boardData.ts: the vscode-free host leaves (no-session guard, throw ->
  // error field, defensive read of truncated/total). Intro 87 + slack.
  'src/dashboard/boardData.ts': 100,
  // promptCapture.ts: the `prompt_capture` host leaf. A SIBLING of boardData.ts
  // rather than a part of it (94/100 lines) and not a method on AcpClient
  // (1349/1350) — both were at their caps, so the ratchet's remedy applies.
  // Owns the one honesty rule the wire cannot: a session that has never sent a
  // message has a NULL capture, which is not an error and must not render as one.
  // A LEAF; capped at introduction (54) + slack.
  'src/dashboard/promptCapture.ts': 75,
  // cacheStats.ts (t-kgtw47): the `cache_stats` host leaf, same reason as
  // promptCapture.ts above — AcpClient and boardData.ts were both at their
  // caps, so this is a new sibling module rather than a raise on either.
  // A LEAF; capped at introduction (61) + slack.
  'src/dashboard/cacheStats.ts': 75,
  // engineStale.ts (t-kgs7om): "is this session talking to a pre-deploy engine
  // process, and what should the user be told". Its own module for the reason
  // above — carrying the stat and the tolerance rule inline took acpClient.ts
  // from 1353 to 1369 against a 1360 cap, so the ratchet's remedy applies and
  // the client now exposes only the facts it owns. The verdict is pure so the
  // tolerance can be tested without a filesystem.
  // A LEAF; capped at introduction (77) + slack.
  'src/dashboard/engineStale.ts': 95,
  // engineShutdown.ts (t-kgu05m round 4): closing a chat is a REQUEST to the
  // engine (stdin EOF, so its peer-heartbeat finalizer runs) with a kill only
  // as the guarantee. Its own module for the engineStale.ts reason — acpClient
  // .ts sits close to its cap and this is a policy with a grace period, worth
  // testing on fake timers rather than by spawning a process.
  // A LEAF; capped at introduction (57) + slack.
  'src/engineShutdown.ts': 75,
  // RETIRED: src/dashboard/subagentStreamTab.ts. The drawer's "open in tab"
  // full-stream document was fed from the webview's forwarded-chunk buffer,
  // which is transient and never logged — so a reopened chat's buffer was empty
  // and the tab said "(no output yet)" for a whole multi-hour run, one snapshot
  // taken at click time and never refreshed. Every child with a session of its
  // own now opens the STRUCTURED transcript instead (SubagentDock.svelte), which
  // the engine projects from the store while the child is still running. The
  // module, its provider registration and its message case are gone rather than
  // left unreachable: a registered scheme nothing opens is a tab waiting to lie
  // again.
  // --- Crons view: scheduled runs that fire with VS Code CLOSED (real OS
  // scheduled tasks), as opposed to Loops, which die with the window. ---
  // BoardShell held its 190 cap while gaining a SEVENTH view by EXTRACTING its
  // icon table to boardIcons.ts (189 -> 177) — the ratchet working as intended.
  // boardIcons.ts: the rail's static SVG child markup, one const per view.
  // Pure data; capped at introduction (35) + slack.
  'webview/dashboard/panes/boardIcons.ts': 50,
  // boardLinkIcons.ts: the rail's NON-VIEW glyph. Extracted from boardIcons.ts
  // when the MCP view landed and that file sat EXACTLY on 50/50 — the cap did
  // not move; the one glyph that belongs to no VIEWS row came out instead.
  // The split is the board's own: Docs is a LINK, not a view (boardViews.ts's
  // comment, boardShell.test.ts's rail-order test), and BoardShell already
  // imported it separately. Intro 13 + slack.
  'webview/dashboard/panes/boardLinkIcons.ts': 20,
  // ToolsPane.svelte: the eighth board view — every tool the model can reach,
  // split into LOADED (full schema in every request) and DEFERRED (one catalog
  // line until tool_search). Round 3 (t-kgtaac) turned the rows into CARDS with
  // a filter box and gave each one a load/unload toggle and copy-path, and the
  // cap STILL DID NOT MOVE: the card markup left for ToolCard.svelte and the
  // create box for NewToolPanel.svelte, so what stayed is the catalog state, the
  // filter derivation and the code-mode switch. Host logic is all in
  // src/dashboard/toolsPane.ts. 192/220.
  // FAILED-TOOL-FILE CARD: the cap DID NOT MOVE again. The problems list was
  // one line of muted text the owner could not see on the pane; it is now an
  // error-toned card with Open and Delete, and ALL of that (the loop, the
  // per-card markup and the confirm state) went to ToolProblemCards.svelte.
  // What this file gained is the mount plus the two postMessage helpers. 220/220.
  'webview/dashboard/panes/ToolsPane.svelte': 220,
  // ToolProblemCards.svelte: the user tool files the engine found but could
  // NOT load, one error-toned card each, drawn ABOVE everything else on the
  // pane. It takes the whole LIST rather than one problem — unlike ToolCard
  // beside it — because the delete needs a confirm step, and holding "which
  // card is confirming" here (one name, exactly MCPPane.svelte's shape) keeps
  // both the loop and that state out of a parent with no lines to give.
  // Presentation only: the parent owns both postMessages. Intro 73 + slack.
  'webview/dashboard/panes/ToolProblemCards.svelte': 90,
  // ToolsNotes.svelte: the pane's prose — what loaded/deferred/off actually
  // cost, and that both settings take effect on the NEXT engine start. Pinned
  // above the scroller, so it does not scroll away from the cards it explains.
  // Extracted from ToolsPane.svelte, which had no room left when the failed-tool
  // cards moved into the grid. Intro 30 + slack.
  'webview/dashboard/panes/ToolsNotes.svelte': 45,
  // ToolCard.svelte: one tool as it reads — name, source badge, first
  // description line, loaded/deferred badge, copy-path and the load/unload
  // switch. Extracted from the pane above (t-kgtaac round 3), the same move
  // InstructionsPane's rows got with InstructionRow.svelte. Pure presentation:
  // the parent owns every state write and every postMessage. Intro 84 + slack.
  'webview/dashboard/panes/ToolCard.svelte': 105,
  // ToolStateSwitch.svelte: the tool's three states as one segmented control.
  // Extracted from ToolCard the moment the two-state switch became three — a
  // third state is markup plus a colour rule per segment, and the card had 15
  // lines of slack. A segmented control rather than a cycling toggle on
  // purpose: a toggle shows what a tool IS but not what else it could be, which
  // is survivable at two states and a guessing game at three. Intro 71 + slack.
  'webview/dashboard/panes/ToolStateSwitch.svelte': 80,
  // NewToolPanel.svelte: the honest-create box — the name field, the
  // scaffold+open+copy button, and the sentence saying outright that this is a
  // scaffold and not a tool builder. Extracted alongside ToolCard for the same
  // reason. Intro 43 + slack.
  'webview/dashboard/panes/NewToolPanel.svelte': 60,
  // pluginsPane.ts (t-kgtolm round 3): the Plugins view's host side — the
  // `list_agent_plugins` read, the enable/disable toggle write, and the
  // add-from-folder validate+append, all over the active session's generic
  // `extMethod` (mirroring `listSkills`'s inline use in DashboardPanel.ts,
  // since the engine owns the loader state and the manifest parser). Capped
  // at introduction (106) + slack.
  // t-q41knp: setEnabled patches a CONFIRMED write onto the re-read list —
  // agent_plugin_set_enabled writes the config file but the engine's own
  // AgentPlugins loader is a per-instance cache with no file watcher, so the
  // immediate re-fetch that follows every write (success or failure, this
  // pane's own established shape) still answered from the stale pre-write
  // snapshot and the switch looked like it did nothing.
  'src/dashboard/pluginsPane.ts': 130,
  // PluginsPane.svelte (t-kgtolm round 3): the ninth board view — one card
  // per installed plugin (name/version/mode, root, discovered skills, MCP
  // servers + connection state, load warnings, enable/disable switch) plus
  // the add-from-folder box, mirroring the Skills/Tools pane idiom. Capped
  // at introduction (274) + slack.
  'webview/dashboard/panes/PluginsPane.svelte': 310,
  // mcpPane.ts: the MCP view's host side — the `mcp_list` read and the seven
  // writes (add / remove / set_enabled / connect / disconnect / authenticate /
  // auth_remove), all over the active session's generic `extMethod` for the
  // reason pluginsPane.ts states: the ENGINE owns the config files, the merge
  // with plugin-provided servers, every live client and the OAuth flow.
  // Deliberately WITHOUT pluginsPane's optimistic patch: `mcp_set_enabled`
  // drives the live client too, and `mcp_list` reads MCP.status() — the
  // runtime map — so the re-read already carries the post-write truth.
  // Capped at introduction (174) + slack. NOT raised for the add-form round:
  // it CAME DOWN to 162 instead, because what an `mcpAdd` means moved out to
  // mcpAddServer.ts below.
  'src/dashboard/mcpPane.ts': 195,
  // mcpAddServer.ts: ONE `mcpAdd` message -> the server object `mcp_add` wants
  // — the quote-aware argv split (a Windows interpreter under "Program Files"
  // was being split into two nonexistent paths) and the optional
  // cwd/environment/headers, omitted rather than written as empty. Extracted
  // from mcpPane.ts, which had 21 lines of slack and needed ~70. Pure: no
  // vscode, no engine, no config file. Intro 92 + slack.
  'src/dashboard/mcpAddServer.ts': 110,
  // MCPPane.svelte: the tenth board view — one card per MCP server (name,
  // source, shadow marker, type, status pill with the engine's own error text,
  // credential state) plus the per-server actions. The two columns it exists
  // for are `source` and `shadowed`: the engine merges
  // `{ ...pluginServers, ...cfg.mcp }`, so a config entry silently overrides a
  // plugin's server of the same name. Capped at introduction (300) + slack;
  // now 238, the add box having moved to MCPAddForm.svelte below.
  'webview/dashboard/panes/MCPPane.svelte': 330,
  // MCPAddForm.svelte: the "Add a server" box, extracted out of MCPPane.svelte
  // when it grew the fields a real server needs. The engine has validated
  // ConfigMCPV1.Info's cwd/environment/headers since it shipped — the FORM was
  // the part that could only offer a command or a URL, so a hosted server added
  // here had nowhere to put its API key and failed to connect minutes later.
  // Intro 153 + slack.
  'webview/dashboard/components/MCPAddForm.svelte': 175,
  // mcpAddForm.ts: that form's two text-block fields as pure functions — one
  // `KEY=VALUE` / `Header: value` per line, split at the FIRST separator, and a
  // line with no separator NAMED rather than silently dropped. Webview-side
  // because the pane needs the same answer it shows the user and cannot import
  // from src/ (tsconfig.webview.json pins rootDir). Intro 59 + slack.
  'webview/dashboard/components/mcpAddForm.ts': 80,
  // cronSchedule.ts: the four schedule shapes that map 1:1 onto a schtasks /SC
  // mode, their flag translation, next-run computation, and the RESTRICTED cron
  // expression acceptor (only the forms that round-trip; ranges and day-of-month
  // are refused, never approximated). A pure LEAF; intro 216 + slack.
  'src/dashboard/crons/cronSchedule.ts': 240,
  // cronCommand.ts: the exact /TR command line + schtasks argv. Pure, so the
  // generated line can be asserted verbatim — the only test that catches a task
  // registered to do the wrong thing. Carries the cmd.exe quoting rules that
  // were established by execution, not reasoning. Intro 172 + slack.
  'src/dashboard/crons/cronCommand.ts': 200,
  // cronState.ts: .origami/crons.json — atomic write, corrupt-file backup, and
  // per-entry validation that REPORTS a malformed hand-edit rather than dropping
  // it. Mirrors agentManager/state.ts's house pattern. Intro 142 + slack.
  'src/dashboard/crons/cronState.ts': 165,
  // cronRow.ts: the SHAPE the Crons pane renders — one row plus the payload
  // that carries a list of them. Type-only, nothing to execute. Split out of
  // cronService.ts at that file's cap (327/330) so `validate` had room to
  // require a model AND explain why an unpinned cron is a money bug rather
  // than a blank field. cronService re-exports both names, so no import site
  // moved; the extraction took cronService to 297. Intro 58 + slack.
  'src/dashboard/crons/cronRow.ts': 65,
  // schedulerBackend.ts: the ONE seam that touches the OS (schtasks via execFile,
  // no shell) plus the honest non-Windows refusal. Everything above it runs
  // against a fake in tests. Intro 107 + slack.
  'src/dashboard/crons/schedulerBackend.ts': 130,
  // collabSteps.ts: the COLLAB map's step source - N member ROOT sessions read
  // as ONE run. A Collab owns no session (collab/runner.ts), so this builds the
  // run the engine does not store: collab_state for the roster, then the SAME
  // boardData.runStepsPayload leaf per member (no duplicated ext plumbing),
  // merged by startedAt with per-member lane stamping. Also owns the
  // sessionId -> collab mark that decorates historyList. No vscode import.
  // Intro 149 + slack.
  'src/dashboard/collabSteps.ts': 165,
  // labyrinthCollabIndex.ts: pure collab grouping for the run index + the
  // agent->lane derivation that replaced the disproven branchModel stamping
  // (LABYRINTH_COLLAB_CONTRACTS S8). Intro 100 + slack.
  'webview/dashboard/components/labyrinthCollabIndex.ts': 105,
  // cronPosix.ts (2026-08-06): the macOS counterparts of cronCommand/
  // cronLauncher's Windows primitives — shQuote, the sh launcher, the launchd
  // plist, the launchctl-list parse. PURE by the same covenant, so the Mac
  // artifacts are asserted verbatim on any OS (cronMac.test.ts). Intro 124 + slack.
  'src/dashboard/crons/cronPosix.ts': 140,
  // launchdBackend.ts (2026-08-06): the macOS SchedulerBackend — plists in
  // ~/Library/LaunchAgents driven through an injectable launchctl seam,
  // mirroring windowsBackend's shape and its no-half-registration covenant.
  // Intro 98 + slack.
  'src/dashboard/crons/launchdBackend.ts': 115,
  // cronService.ts: create/update/enable/delete/run-now over an injected backend.
  // No vscode import and no spawning, so every path is exercised against a fake.
  // Held at 330 through the launcher-script work by EXTRACTING the pure drift
  // reconcile to cronReconcile.ts and the on-disk side to cronFiles.ts, rather
  // than restamping — the ratchet doing its job.
  'src/dashboard/crons/cronService.ts': 330,
  // cronLauncher.ts: the per-cron .cmd launcher and the tiny /TR that points at
  // it. Exists because schtasks refuses a /TR over 261 chars, which killed the
  // original inline command line outright. Carries the BATCH escaping rules,
  // which invert the command-line ones. Intro 88 + slack.
  'src/dashboard/crons/cronLauncher.ts': 110,
  // cronFiles.ts: launcher write/remove, the orphan sweep, and the self-carrying
  // .gitignore for both generated directories. Extracted from cronService.ts at
  // its cap. Intro 86 + slack.
  'src/dashboard/crons/cronFiles.ts': 110,
  // cronReconcile.ts: the PURE file-vs-machine comparison (missing registration,
  // stray registration, orphan launcher scripts). Reports, never repairs.
  // Extracted from cronService.ts at its cap. Intro 51 + slack.
  'src/dashboard/crons/cronReconcile.ts': 75,
  // CronsPane.svelte: the view — list, form, enable/disable, run-now, open-log,
  // the standing "runs unattended and auto-approved" statement, and the drift
  // report. Capped at introduction (265) + slack.
  // Held at 290 through the TABLE rewrite (the ratchet working as intended): the
  // draft form went to CronForm.svelte and the list to CronTable.svelte, so the
  // pane SHRANK 269 -> 201 even while gaining the filter box and a third empty
  // state. Cap deliberately NOT restamped down — it is a ceiling, not a budget.
  'webview/dashboard/panes/CronsPane.svelte': 290,
  // cronLog.ts: runs + last outcome derived from the cron's OWN log — the audit
  // trail is the only counter, so no second number can drift from it. Carries
  // the on-disk record shape (why [start] anchors and [end] must not) and the
  // bounded tail read. A pure-ish LEAF; capped at introduction (154) + slack.
  'src/dashboard/crons/cronLog.ts': 180,
  // cronFormat.ts: the Crons table's derived text — relative when, row status,
  // the failure note. Pure (clock injected). A LEAF; intro 110 + slack.
  'webview/dashboard/panes/cronFormat.ts': 135,
  // paneSearch.ts: the filter-box matching rule + the empty/no-matches/has-rows
  // discriminator, SHARED by Crons and Loops so the two panes cannot end up
  // disagreeing about what "matches" means. A LEAF; intro 31 + slack.
  'webview/dashboard/panes/paneSearch.ts': 50,
  // CronForm.svelte: the create/edit draft, extracted from CronsPane when the
  // list became a table. Behaviour-preserving; capped at introduction (97) + slack.
  'webview/dashboard/components/CronForm.svelte': 120,
  // CronRunTarget.svelte: WHAT a cron runs as — the agent, the model picker,
  // and the warning that carries this feature's whole point (there is no
  // "workspace default" model; an unpinned job adopts the machine's last-used
  // one). Split out of CronForm when the model went from a free-text box to a
  // real AgentModelSelect plus that warning, which put CronForm at 132/120.
  // Intro 58 + slack.
  'webview/dashboard/components/CronRunTarget.svelte': 65,
  // CronTable.svelte: the ops table — JOB (name / model+agent / log path) ·
  // SCHEDULE · NEXT RUN · LAST RUN · STATUS · RUNS. Markup over cronFormat.ts;
  // capped at introduction (107) + slack.
  'webview/dashboard/components/CronTable.svelte': 135,
  // SamplingControl.svelte: per-chat temperature/top_p, extracted VERBATIM
  // from InputBar.svelte when the (since-deleted) F4b routing indicator needed
  // the room back under InputBar's cap (0 slack left) — the same move
  // ThinkingGlyph/PinnedUserMessage/PersistSwitch made earlier for the same
  // file. NOT in THEMED_FILES: its one box-shadow literal mirrors
  // ModelPicker.svelte's `.mp-menu` (also excluded) — no `--og-*` shadow var
  // exists in this codebase. Capped at introduction (81) + slack.

  // wikiGraphPhysics.ts: the memory-graph mind map's force-directed physics,
  // extracted from WikiSearchPane.svelte so force clamping, alpha annealing,
  // the rebuild merge and the golden-angle seed spread are unit-testable pure
  // functions (no canvas/DOM) — the fix for the "nodes explode past ~80
  // pages" instability. A LEAF; capped at introduction (143) + slack.
  'webview/dashboard/panes/wikiGraphPhysics.ts': 165,

  // wikiGraphLabels.ts: the Labels control's states, extracted from
  // WikiSearchPane.svelte when a fourth ('clean', no text at all) was added.
  // The old decision was split across a condition chain in the render loop and
  // a separate template `{#if}`, which is how 'none' shipped still showing
  // hover labels, the legend strip and the page count. A LEAF (no canvas/DOM,
  // no imports); capped at introduction (75) + slack.
  'webview/dashboard/panes/wikiGraphLabels.ts': 90,

  // wikiGraphForces.ts: the "Showcase" recipe's tuned force constants plus the
  // four forces the memory graph did not have before it — the perimeter tag
  // ring, bubble containment, the settle-only swirl, and a centre pull anchored
  // on the WORLD point under the view centre rather than the canvas midpoint.
  // Extracted at birth for the same reason wikiGraphPhysics.ts was: the pane's
  // render path needs a 2d context, which jsdom does not have, so maths left
  // inside the component cannot be tested at all. A LEAF (no canvas/DOM, no
  // imports); mostly the provenance comment naming the lab dial each number
  // came from. Intro 267 + slack.
  'webview/dashboard/panes/wikiGraphForces.ts': 285,

  // wikiGraphTheme.ts: the same split for the paint side — the FIXED palette the
  // canvas paints with, the recipe's look constants, and the two tints derived
  // from that palette (the hub halo and the vignette).
  // The graph no longer follows the running theme: on 2026-08-27 the owner
  // pinned it to Harbour on every theme, because the light ones made the canvas
  // hard to look at. So HARBOUR_GRAPH_THEME replaced the getComputedStyle read,
  // and the luminance maths that told Ember's paper from a dark surface went
  // with it. Only the CANVAS is pinned; the pane's chrome stays live-themed.
  // DELIBERATELY not in THEMED_FILES, for the reason labyrinthExport.ts is not:
  // its JOB is producing concrete colour strings for a canvas that cannot read
  // var(), so "no literal colour" is the wrong rule for it — and its own test
  // parses theme.css to prove each literal still equals what Harbour ships.
  // A LEAF (no DOM at all). Intro 230 + slack.
  'webview/dashboard/panes/wikiGraphTheme.ts': 250,

  // WikiSearchPane.svelte: a NEW tripwire, not a raise — this file has never
  // had a cap, which is part of why it reached four figures. Set at the size it
  // reached when the Showcase recipe landed (1322), after that work's maths went
  // out to the two leaves above rather than into the component. The slack is
  // deliberately near-nil: at four figures the next growth should be somebody
  // deciding what comes OUT, not a number quietly going up.
  // The next extraction is already obvious to whoever trips this: render() is a
  // ~140-line draw routine (edges, halos, nodes, labels, vignette) that only
  // needs the ctx and a palette, and the pane's leftover graph-BUILD half
  // (link resolution, hue tables) is pure and testable today.
  'webview/dashboard/panes/WikiSearchPane.svelte': 1330,
  // --- Collabs M1: the sidebar's Collabs half goes live, a collab opens as its
  // own editor tab, and two seed collab agents ship as engine agent defs. ---
  // collabData.ts: the six `collab_*` host leaves over the GENERIC extMethod
  // seam. Its own module rather than methods on AcpClient (1348/1350) — both
  // that file and boardData.ts (94/100) were at their caps, so the ratchet's
  // own remedy applies, the same split promptCapture.ts took. No vscode
  // import; every guard is exercised against a fake. Intro 223 + slack.
  'src/dashboard/collabData.ts': 250,
  // collabAgents.ts: the two SEED collab agents (crane/heron) as engine
  // agent-definition files + the write-if-absent, install-once installer.
  // Almost entirely the two prompt strings; a DATA module, capped like
  // archetypes.ts with slack for prompt wording tweaks. Intro 158 + slack.
  // W9 (generation v5) SHRANK it to 160 and the cap did not move: the shared
  // COLLAB_DISCIPLINE block was deleted outright — every word of it is taught
  // by the engine's own room manual, and the same def also runs solo and as a
  // sub-agent, where naming the room is simply false. The prior payload is
  // frozen in collabAgentsLegacyV4.ts (its own entry above).
  'src/dashboard/agentManager/collabAgents.ts': 200,
  // collabTab.ts: a collab's stream editor tab (createWebviewPanel + the
  // one-tab-per-collab dedupe), mirroring mapTab.ts line for line and capped
  // at the same number. Intro 69 + slack.
  'src/dashboard/agentManager/collabTab.ts': 90,
  // CollabPane.svelte: ONE collab's screen — roster chips with the shared
  // pill-sweep rings, the message stream, the suspended banner + cap control,
  // the composer, and the poll loop that drives all of it. The pane's poll is
  // the FAST one; since lane L1 the host runs a slow watch of its own
  // (collabWatch.ts) so a shut tab is no longer a blind one. Intro 468 + slack.
  // 520->440 (shared composer, DOWNWARD restamp): the hand-rolled composer —
  // its markup, its `/` palette and ~90 lines of styles — was REPLACED by the
  // chat's InputBar in bare mode, so the pane keeps only what a composed line
  // MEANS (submit/dispatch) and sheds the box itself: 486 -> 409. Cap = actual
  // + slack, per the ratchet.
  'webview/chat/CollabPane.svelte': 440,
  // SidebarLauncher.svelte: FIRST cap, stamped in the change that took the
  // Collabs half from a placeholder to a live list (779 -> 912). It was
  // uncapped through everything before this, so the number is actual + slack
  // per the ratchet's own convention, not a budget for the next feature: the
  // next thing to land in this file extracts a component (the Chats half and
  // the Collabs half are each an obvious seam) instead of raising it.
  // 731->378 (t-kgserq, DOWNWARD restamp): the Chats half took the same move
  // CollabsList.svelte made for the other half at M2 — extracted WHOLE into
  // ChatsList.svelte (below), which is also where its new drag-into-a-section
  // feature landed. This file kept only the shell (brand/theme/Settings/
  // Memory) plus a small NEW piece, the Chats/Collabs divider's drag-to-resize
  // (t-kgserq). Cap = actual (378) + slack, per the ratchet.
  // DELIBERATELY not in THEMED_FILES, for the same reason it never was: the
  // remaining --og-* usage is ordinary; the alpha-stencil mask that used to
  // justify the exemption left with the ring CSS (now in ChatsList.svelte,
  // which inherits the same exemption for the same reason).
  'webview/chat/SidebarLauncher.svelte': 420,
  // --- Collabs M2: the Slack-style stream, agent-def CRUD, the roster picker,
  // sidebar archive/History/rings, the `/` palette and the context tracker.
  // Every entry below is a NEW file; not one existing cap was raised, and the
  // two that bit (SidebarLauncher at 938/950, CollabPane at 486/520) were paid
  // for by extraction exactly as the ratchet prescribes.
  //
  // CollabsList.svelte: the sidebar's Collabs half, extracted WHOLE from
  // SidebarLauncher.svelte — the seam its own cap comment above names. Owns
  // that half's wire end to end (handshake, list, create, archive, rings), so
  // the launcher keeps only Chats and the shell. It shrank 938 -> 803 even
  // while M2 added an archive flow, a History subsection and per-row rings.
  // Capped at introduction (390) + slack.
  'webview/chat/CollabsList.svelte': 420,
  // ChatsList.svelte (t-kgserq): the sidebar's Chats half, extracted WHOLE
  // from SidebarLauncher.svelte — the seam that file's own cap comment names,
  // the same move CollabsList.svelte made for the other half at M2. Owns the
  // session list end to end (handshake, ring lifecycle, drag reorder, rename,
  // history) PLUS the new chat-grouping sections (two collapsible sections a
  // chat can be dragged into: "Loops", fixed name, and one user-renamable
  // one). Capped at introduction (744) + slack.
  // t-kgserq v2: Main (pinned top)/N user sections/Loops (pinned bottom)
  // replaced the two-fixed-section shape, and stayed UNDER the existing cap
  // (762/800) — the new ChatSectionBlock.svelte (below) took the three
  // header blocks' near-identical markup+CSS out before this could grow past
  // it, so no raise was needed.
  // t-q41knp: the requestSessions/reorder mount-time handshake's own gap — it
  // recovers a session's EXISTENCE from before this listener was ready but
  // not a `requestPermission` that arrived in the same window, so that ask
  // was lost forever. `pendingAskIds` (host-reported, DashboardPanel.ts) now
  // seeds the ring the same way; falls back to the prior in-memory state only
  // for an older host reply. Landed EXACTLY on the held cap (799->800); no
  // room left.
  'webview/chat/ChatsList.svelte': 800,
  // ChatSectionBlock.svelte (t-kgserq v2): ONE collapsible section's header
  // (chevron/count/optional delete) + row-list shell, generic over Main/a
  // custom section/Loops so three near-identical header blocks did not have
  // to exist in ChatsList.svelte. The section NAME area and every ROW's own
  // markup stay in ChatsList.svelte (passed in as snippets) — Svelte scopes a
  // snippet's CSS to the file that WRITES its markup, not the one that
  // renders it. A LEAF; intro 131 + slack.
  'webview/chat/ChatSectionBlock.svelte': 155,
  // chatSections.ts (webview half, t-kgserq): the pure grouping rule (which
  // chat renders under which section, keeping the global reorder array as the
  // one order source) and the Collabs-divider clamp — pulled out so both are
  // testable without jsdom's missing layout engine. The EXTENSION half of the
  // same feature (persisted shape, memento glue) is a separate file,
  // src/dashboard/chatSections.ts, because webview code cannot import a
  // runtime value from src/ (tsconfig.webview.json pins rootDir to webview/) —
  // not a mirror needing a drift guard, since the two share no literal the
  // other side must independently agree on. A LEAF; intro 58 + slack.
  // t-kgserq v2: groupSessionIds now returns {main, loops, bySection} for
  // Main/N-custom/Loops instead of {loops, custom, ungrouped} — same file,
  // same size class (67/80), no raise needed.
  'webview/chat/chatSections.ts': 80,
  // sessionRowState.ts: the sidebar row's THIRD ring state (waiting-for-user,
  // beating working) — the pure priority rule plus the pending-toolCallId
  // Set reducers ChatsList.svelte's requestPermission/permissionAudit cases
  // call. A LEAF, sibling of chatSections.ts; capped at introduction (56) + slack.
  'webview/chat/sessionRowState.ts': 70,
  // CollabStream.svelte: the message stream as a Slack-style transcript —
  // consecutive same-author runs under ONE avatar/name/time header, a brand
  // glyph where one resolves and a stable per-slug letter disc where none does.
  // Extracted from CollabPane.svelte, which had 34 lines under its cap.
  // Capped at introduction (223) + slack.
  'webview/chat/CollabStream.svelte': 250,
  // collabStreamFollow.ts (W2, report 1.11/F10): the stream's FOLLOW - which
  // events feed the chat's stick rule and when the transcript is told to catch
  // up. The RULE itself stays in chatScroll.ts, where it was hardened twice; a
  // second derivation of it is exactly what this file exists to prevent. Its
  // own module because CollabStream.svelte was 2 lines under its cap and a
  // scroll rule nobody can test is a rule nobody can trust. LEAF; intro 75 + slack.
  'webview/chat/collabStreamFollow.ts': 100,
  // collabStreamMarks.ts (W2): the per-slug disc tone, the disc letter and the
  // clock - CollabStream.svelte's only logic that never touches the DOM, taken
  // out so the follow rule and the flow rail could land inside its cap. A pure
  // LEAF, mirroring collabKinds.ts's split out of the same component. Intro 44 + slack.
  'webview/chat/collabStreamMarks.ts': 70,
  // collabWaiting.ts (W2, report 2.3): which asks are still unanswered - the
  // standing "waiting on..." line's whole rule. Pure: an ask names a target, the
  // TARGET answering closes it, an ask that named nobody is not a wait. Its own
  // file rather than collabKinds.ts's, which answers what a kind MEANS on
  // screen; this answers what the room is blocked on. LEAF; intro 56 + slack.
  'webview/chat/collabWaiting.ts': 80,
  // CollabWaitingRow.svelte (W2, report 2.3): the standing "waiting on..." line
  // at the foot of the stream - the difference between a room that has FINISHED
  // and one that is blocked on a question, which read identically before it.
  // Its own component because CollabStream.svelte is at its cap. Intro 52 + slack.
  'webview/chat/CollabWaitingRow.svelte': 75,
  // CollabAvatar.svelte (W2): ONE speaker's mark - brand animal where one
  // resolves, tinted letter disc where none does. Extracted from
  // CollabStream.svelte, which went 9 lines past its cap once the follow rule
  // and the flow rail landed. The stream still hands it DOWN as a snippet, so an
  // agent cannot be a glyph in the transcript and a disc in its own live pill.
  // Intro 74 + slack.
  'webview/chat/CollabAvatar.svelte': 100,
  // CollabRoster.svelte: the roster strip + the per-agent CONTEXT drawer. Its
  // chips are buttons now (click = show that agent's last real prompt), and it
  // owns the two honest empty states the drawer needs — "no session yet" and
  // "capture evicted" are different facts and are not folded into one message.
  // Extracted alongside the stream. Capped at introduction (256) + slack.
  'webview/chat/CollabRoster.svelte': 290,
  // CollabRosterPicker.svelte: M3 REPURPOSED — create moved to title-only (the
  // owner's Slack-model call, see CollabsList.svelte's top comment for the
  // race that closed), so the New-collab checkbox multi-select this used to be
  // no longer has a job. Same file, new role: the roster's own Invite `+`
  // trigger + popover, over the already-merged candidate list from
  // collabInvite.ts. A LEAF; cap unchanged (135) — actual landed at 122.
  'webview/chat/CollabRosterPicker.svelte': 135,
  // collabInvite.ts (M3): the PURE invite-candidate merge — engine agents
  // (joinable now) ∪ fs-only defs (disabled, "joins after the engine
  // restarts"), minus anyone already an active participant. A LEAF, mirroring
  // modelGrouping.ts's house pattern; capped at introduction (62) + slack.
  'webview/chat/collabInvite.ts': 85,
  // collabNames.ts: the SHORT-name rule shared by roster chips, message
  // author lines and the invite list — mined from "Name - blurb", or the
  // slug itself when there is no separator to mine. A LEAF; capped at
  // introduction (27) + slack.
  'webview/chat/collabNames.ts': 45,
  // collabMarkdown.ts: the collab stream's markdown pipeline, mirroring
  // MessageRow.svelte's chat renderer (same escaping, same highlighted code
  // blocks) so a collab bubble reads like a chat one. Configured PER CALL
  // (options passed to marked.parse, never marked.setOptions) — ChatView
  // mounts CollabPane unconditionally, so this and MessageRow's own
  // setOptions() both live in the one chat bundle, and a shared mutable
  // global would let whichever loaded last override the other's renderer.
  // Capped at introduction (102) + slack.
  'webview/chat/collabMarkdown.ts': 130,
  // CollabMessageBubble.svelte: one message's bordered, chat-style bubble —
  // extracted from CollabStream.svelte, which had 10 lines under its cap and
  // needed real room for markdown + code-block styling. Owns the copy-button
  // click (the one interactive part of the {@html} markdown). Capped at
  // introduction (154) + slack.
  // 190->191 (2026-08-07, owner-approved, ONE line): the chart-fence hint. The
  // collab seam emitted `.chart-hint` with no rule for it at all, so a hint
  // that is warning-coloured in chat was unstyled here — the two seams are a
  // sync invariant and this was drift. The file was at exactly 190/190, and the
  // fix is one declaration block for markup this component ALREADY renders: no
  // new responsibility, so no extraction to buy it. Bounded exception, not a
  // licence — the next line still has to be paid for.
  'webview/chat/CollabMessageBubble.svelte': 191,
  // collabSlash.ts: the collab composer's `/` vocabulary as a PURE leaf — six
  // commands and the parse that maps a typed line onto one of them. Its own
  // module so the load-bearing rule (anything unrecognised POSTS, it is never
  // swallowed) is testable with no DOM. Intro 84 + slack.
  'webview/chat/collabSlash.ts': 105,
  // collabExport.ts: the stream as a markdown file. Its own leaf rather than a
  // reuse of the chat's renderSessionMarkdown, which prints a ROLE ("Agent") —
  // enough for a one-agent transcript, useless for a collab, where WHO said a
  // line is most of the information. Attributes through the SAME short-name
  // rule the stream draws with, so the document and the pane cannot disagree
  // about an agent's name. A pure LEAF; capped at introduction (42) + slack.
  // 60->165 (M4.1 wave R2x, restamp of a file BELOW its cap — 43/60 — not a raise of a
  // breached one): the document now tells the same PROTOCOL truth the stream does. It
  // gained the kind-labelled header, the one-line italic form for a task_*/system row,
  // the per-turn trace summary and the `## Board` section, all reusing collabKinds' own
  // kindOf/kindLabel so the file and the pane cannot disagree about what a message was.
  // New surface on a leaf, not a god-file; cap = actual (144) + slack.
  'webview/chat/collabExport.ts': 165,
  // collabGlyphs.ts: the heron polygon set (new art) plus the slug -> table-key
  // normaliser that resolves `collab-crane` onto the tsuru sigil. Extracted
  // because archetypeGlyphs.ts had 13 lines under its cap and the ratchet's
  // remedy is a module. Almost entirely static polygon data; intro 63 + slack.
  'webview/dashboard/components/collabGlyphs.ts': 85,
  // collabAgentCrud.ts: create/edit/delete a collab agent by writing the same
  // .md def collabAgents.ts seeds — filesystem, deliberately NOT an engine
  // method (defs are read once at startup, so an engine-listed def you just
  // saved would not exist yet). Carries the deliberately-not-YAML frontmatter
  // reader and the refusal to delete a file that is not a collab agent.
  // No vscode import; every path runs against a real temp dir. Intro 172 + slack.
  'src/dashboard/collabAgentCrud.ts': 200,
  // archetypeRefs.ts (Folds Board D7): read-only reference cards for the
  // archetypes (architect/ask/debug/orchestrator/scout/cartographer) that share
  // the collab agent directory — same directory-listing rules, plus a
  // byte-surgical `model:` line edit. Extracted straight out of
  // collabAgentCrud.ts, which was AT its 200-line cap when this landed.
  // No vscode import; every path runs against a real temp dir. Intro 126 + slack.
  'src/dashboard/archetypeRefs.ts': 150,
  // CollabAgentsPane.svelte: the Agents board's eighth view — the def list, the
  // create/edit form (slug grammar, model, glyph picker, persona) and delete
  // with confirm, over that CRUD leaf. Carries the restart caveat as a standing
  // notice rather than a tooltip. Capped at introduction (347) + slack.
  // t-kgtr6c: this pane became a multi-TAB shell and gave the FORM away to
  // CollabAgentForm.svelte to pay for it — it stood at 378 of 380. The cap is
  // UNCHANGED. Round 3 then dropped the third tab (SubAgents) on owner
  // decision, leaving Collab / Vision.
  'webview/dashboard/panes/CollabAgentsPane.svelte': 380,
  // CollabAgentForm.svelte: the agent-def editor, extracted from the pane above.
  // Shared by the Collab and Vision tabs, which is what makes it an extraction
  // rather than a move — a second copy for profiles would have drifted on the
  // first change to the persona seed. Intro 256 + slack.
  'webview/dashboard/components/CollabAgentForm.svelte': 280,
  // SubAgentsPane.svelte is GONE (t-kgtr6c round 3, owner decision) — with it
  // went the mirror of ModelPicker's sub-agent override and the drift guard
  // that mirror owed. ModelPicker is the sole sender now, and
  // visionAgents.test.ts asserts it stays the only one.
  // ApprovePopover.svelte: the approve popover SHELL — backdrop, panel,
  // row titles/separators. Originally the notch rail itself, extracted from
  // InputBar.svelte (1199/1200, one line of slack) so the composer had room for
  // the vision indicator. State stays in InputBar — this draws and reports.
  // t-kgsupy round 4 merged the composer's two separate Approve/Browser
  // popovers into one with two labeled rows, which took this file to 149 —
  // FOURTEEN over. Extracted first: the rail/dot/label rendering moved to the
  // new ApproveRail.svelte below, mounted once per row. This file came back
  // to 81; the cap comes DOWN with it rather than keeping 1199/1200's old
  // headroom for a file that no longer needs it. Intro 81 + slack.
  'webview/dashboard/components/ApprovePopover.svelte': 100,
  // ApproveRail.svelte: ONE notch rail + label row — the piece extracted out
  // of ApprovePopover.svelte above when round 4's second row took it over
  // cap. Generic over mode/options/onSelect/disabled, which is what lets the
  // popover mount it twice (Actions, Browser) with neither row aware of the
  // other. Intro 88 + slack.
  'webview/dashboard/components/ApproveRail.svelte': 110,
  // approveButtonState.ts: what the composer's ONE merged Approve button
  // says/wears, as a pure function of the Actions preset and the Browser
  // setting — the extraction that let InputBar.svelte absorb round 4's merge
  // (Browser folded into the Actions gauge) without going over its own
  // 1200-line cap. Same shape as visionButtonState.ts below: a decision
  // should be checkable without rendering anything. Intro 46 + slack.
  'webview/dashboard/components/approveButtonState.ts': 70,
  // VisionProfileMenu.svelte: the composer's Vision button + its profile list.
  // Extracted AT BIRTH rather than after the fact, for the same reason: there
  // was no room for it inside InputBar. Intro 99 + slack.
  // t-kgtr6c round 3 folded the separate read-out chip into this button, which
  // took it to 132 — TWELVE over. The cap is UNCHANGED: the state table went to
  // visionButtonState.ts and the file came back to 112.
  'webview/dashboard/components/VisionProfileMenu.svelte': 120,
  // visionButtonState.ts: what the Vision button says and what a click opens,
  // as a pure table — the extraction that paid for the cap above. Its own module
  // because the rule that matters (a NATIVE model wins the label and gets a note
  // instead of a picker, because the engine drops the profile for it) is a
  // decision, and a decision should be checkable without rendering anything.
  // Intro 80 + slack.
  'webview/dashboard/components/visionButtonState.ts': 100,
  // VisionPinRow.svelte: the Auto/On/Off row inside the Vision popover, extracted
  // AT BIRTH for the same reason VisionProfileMenu.svelte was — that file sits AT
  // its 120 cap, and InputBar.svelte at its 1200 one, so there was nowhere else
  // for it to go. It posts its own click (no InputBar callback) because the host
  // owns the pin and answers with a fresh modelStatus. Intro 68 + slack.
  'webview/dashboard/components/VisionPinRow.svelte': 90,
  // visionPinState.ts: what the tri-state SAYS, as a table — "Auto (on — detected)"
  // is a different sentence from "On (pinned)" even though both write the same
  // config flag, and that difference is the whole feature. A MIRROR of the
  // VisionState union in src/dashboard/visionPin.ts (webview code cannot import
  // host code: tsconfig.webview.json pins rootDir to webview/), guarded by
  // visionPinState.test.ts. Intro 73 + slack.
  'webview/dashboard/components/visionPinState.ts': 95,
  // visionPersonaSeed.ts: the body a NEW vision profile is born with. Its own
  // module rather than a third branch of collabPersonaSeed.ts — that file seeds
  // COLLAB agents, and seeding a profile from its observer preset is exactly the
  // round-3 defect (a describe-only agent born calling itself a reviewer).
  // Intro 46 + slack.
  'webview/dashboard/components/visionPersonaSeed.ts': 70,
  // agentFrontmatter.ts: the `---` block primitives (FRONT_BLOCK / frontValue /
  // permissionBlockIn), extracted from collabAgentDef.ts when the vision-profile
  // gate took that file past its 175 cap. It knows about frontmatter and nothing
  // about defs, which is what makes it the right seam. Intro 49 + slack.
  'src/dashboard/agentFrontmatter.ts': 70,
  // visionProfile.ts: the per-chat vision-profile write, extracted OUT of
  // DashboardPanel.ts (which sat AT its cap) so only the message-handler wiring
  // stayed behind. Owns the optimistic-echo rule. Intro 45 + slack.
  'src/dashboard/visionProfile.ts': 65,
  // browserAutoApproveControl.ts: the composer's Browser Ask/Bypass control's
  // read-live-and-broadcast + write, extracted OUT of DashboardPanel.ts (which
  // sat AT its cap, 6317/6318) at birth — same shape as visionProfile.ts above
  // it. Owns the "absent means off, never write false" rule. Intro 39 + slack.
  'src/dashboard/browserAutoApproveControl.ts': 60,
  // --- Collabs M4: collab agents become WORKERS. Three NEW files; not one cap
  // above was raised, and the two that bit (collabAgentCrud at 183/200 and the
  // pane at 379/380) were paid for by extraction and by shaving comment lines,
  // exactly as the ratchet prescribes. ---
  //
  // collabPresets.ts: the WORKER / OBSERVER permission blocks, their per-turn
  // `steps` budgets, and the exact-match detection that says which preset (or
  // `custom`) a def on disk carries. Shared by the seed installer, the def
  // writer and the pane, so a block cannot drift between the three. A DATA
  // leaf. Intro 95 + slack.
  'src/dashboard/agentManager/collabPresets.ts': 130,
  // collabAgentsLegacy.ts: the FROZEN prior-generation seed payloads, mirroring
  // archetypesLegacy.ts. Never edited — an edit here would make an untouched
  // install read as user-edited and silence the reseed note. RAISED 140->210
  // when COLLAB_AGENTS_V3 (the pinned generation the v3 marker shipped) was
  // appended alongside V1 for the v4 unpinned-seeds change — there is nothing
  // to extract from a file whose entire job is archiving frozen text verbatim;
  // the two generations' payloads ARE the content. Intro 204 + slack.
  'src/dashboard/agentManager/collabAgentsLegacy.ts': 210,
  // collabAgentsLegacyV4.ts (W9): the FROZEN v4 seed pair — the last generation
  // whose personas were written for a ROOM ("in this collab" + the shared
  // COLLAB_DISCIPLINE block), which the W9 ruling retired. Its own file and not
  // a fourth const above because collabAgentsLegacy.ts stood at 204 of its 210
  // cap and a frozen generation is ~55 lines: extract, never raise. Append-only
  // static data under the same DO-NOT-EDIT rule; capped at introduction (82).
  'src/dashboard/agentManager/collabAgentsLegacyV4.ts': 95,
  // collabAgentDef.ts: the def FILE FORMAT — parse, serialize, and the rule
  // that a permission block matching neither preset is copied back verbatim.
  // Extracted from collabAgentCrud.ts, which was 17 lines under its cap when
  // the preset fields landed. Pure; no fs, no vscode. Intro 142 + slack.
  'src/dashboard/collabAgentDef.ts': 175,
  // --- Flock M4 wave X1 (ext thread + extraction): TWO NEW files; not one
  // cap above was raised. collabData.ts (247/250) is untouched — the six new
  // methods live in a sibling, and the collab message switch that used to be
  // inline in DashboardPanel.ts moved out wholesale, which is what bought
  // DashboardPanel.ts's own cap comment its slack back (6280 cap, actual
  // dropped ~150 lines by this extraction). ---
  //
  // collabManager.ts: the collab board dispatcher, extracted out of
  // DashboardPanel.ts's inline switch — mirrors agentManager/manager.ts's
  // shape (a COLLAB_MESSAGE_TYPES set the panel checks before its own switch,
  // plus a handle()). Every case is wiring only; the wire calls live in
  // collabData.ts/collabBoardData.ts/collabAgentCrud.ts. Intro 262 + slack.
  'src/dashboard/collabManager.ts': 300,
  // collabBoardData.ts: the six NEW `collab_*` host leaves (lead, objective,
  // the task board's two mutations, the ledger, stop) — a SIBLING of
  // collabData.ts, not an addition to it, for the reason collabData.ts's own
  // cap comment already gives (247/250, the ratchet's remedy is a new
  // module). Same house pattern: no-session guard, throw -> `error` field,
  // defensive array reads. Intro 160 + slack.
  'src/dashboard/collabBoardData.ts': 190,
  // --- Flock M4 wave X2 (ext UI): NINE NEW files; not one cap above was
  // raised. The four that bit were each paid for by extraction, exactly as the
  // ratchet prescribes: InputBar.svelte (948/955) gave up its dropdown markup,
  // CollabsList.svelte (418/420) its create draft, CollabRoster.svelte
  // (288/290) its context drawer, and CollabPane.svelte (409/440) its control
  // strip — which is what bought room for the task board and the mention
  // picker to land at all. ---
  //
  // SlashDropdown.svelte: the composer's dropdown, extracted VERBATIM from
  // InputBar.svelte. Generic over {name, description, category} so the `/`
  // palette and the `@` picker draw through ONE component — two copies of that
  // markup would be two places for the two vocabularies to drift apart.
  // DELIBERATELY not in THEMED_FILES: its one box-shadow literal came across
  // with the markup and carries the same exemption InputBar.svelte already had
  // (no --og-* shadow var exists anywhere in this codebase). Intro 50 + slack.
  'webview/dashboard/components/SlashDropdown.svelte': 70,
  // CompactionThresholdMenu.svelte (t-kgsdsw): the compaction gauge's
  // right-click menu — percentage presets + a custom token-count field. A
  // pure picker (no vscode api, no postMessage of its own): InputBar owns the
  // wire, the same split ModelPicker draws between its menu markup and the
  // caller's setEffort/setApproveMode posts. Capped at introduction (163) + slack.
  'webview/dashboard/components/CompactionThresholdMenu.svelte': 200,
  // ContextLengthPrompt.svelte (t-lmqe0g): the "one number, confirm/cancel"
  // context-length prompt, extracted so ModelPicker's existing LM Studio load
  // prompt and the new sub-agent context-override prompt draw through ONE
  // component instead of two near-identical copies. A pure picker (no vscode
  // api, no postMessage of its own) — same split as CompactionThresholdMenu.
  // Intro 99 + slack.
  'webview/dashboard/components/ContextLengthPrompt.svelte': 120,
  // collabMentions.ts: the composer's `@` grammar as a PURE leaf — what a
  // SUBMITTED line targets (the mentions array that rides collab_post and
  // drives wake rule C17) and what the PICKER should offer mid-keystroke, off
  // one token shape. Its own module because the load-bearing rule (an unknown
  // slug is DROPPED here, since collab_post refuses the whole message for one)
  // has to be testable with no DOM. Intro 95 + slack.
  'webview/chat/collabMentions.ts': 120,
  // collabKinds.ts: what a message's KIND means on screen — the absent-kind
  // fallback ('say', for every pre-M4 row and every older engine), which kinds
  // are one-line system rows, the bubble tone, the label, and the grouping a
  // system row must BREAK rather than join. A pure LEAF, mirroring
  // collabSlash.ts's split. Intro 114 + slack.
  'webview/chat/collabKinds.ts': 140,
  // CollabCreateForm.svelte: the New-collab draft, extracted from
  // CollabsList.svelte so M4's objective textarea could land without raising
  // its 420 cap. Markup + styles carried across verbatim. Intro 108 + slack.
  'webview/chat/CollabCreateForm.svelte': 130,
  // CollabSystemRow.svelte: a task_*/system message as ONE LINE. Its own
  // component rather than a branch inside the bubble, because it is the
  // opposite shape — full width, no avatar, no bubble. Intro 53 + slack.
  'webview/chat/CollabSystemRow.svelte': 70,
  // CollabTrace.svelte: the folded "N tools ran" row (C27) and its entries,
  // borrowing PromptCaptureSection's open-state idiom. Shared by the bubble and
  // the system row — which tools ran is a fact about the TURN, not about the
  // shape of its message. A LEAF; intro 88 + slack.
  'webview/chat/CollabTrace.svelte': 110,
  // CollabContextDrawer.svelte: the per-agent context drawer + the ledger's
  // per-agent spend chips, extracted from CollabRoster.svelte (288/290) so the
  // lead badge could land on the chips. Keeps the two honest empty states the
  // roster established and follows labyrinthUsage's "never invent a number"
  // discipline for the chips. Intro 134 + slack.
  'webview/chat/CollabContextDrawer.svelte': 160,
  // CollabControls.svelte: the suspended banner and the standing objective,
  // extracted from CollabPane.svelte to pay for the task board mounted there.
  // 185->85 (M4.2 UAT, DOWNWARD restamp): the cap/hop/STOP row LEFT this strip
  // for CollabHopBar.svelte under the composer, taking capText/hopText and ~45
  // lines of styles with it, and the suspended wording moved to the shared
  // collabHop.ts leaf. 158 -> 68; cap = actual + slack, per the ratchet.
  'webview/chat/CollabControls.svelte': 85,
  // TaskBoard.svelte: the collab's task board + the cost ledger. Engine-
  // authoritative with no local splice, and it draws ONLY legal transitions — a
  // human sees Accept/Reopen on a done task and nothing at all on the others,
  // because a disabled button would say "you may do this, later", which is not
  // what the state machine means. Intro 262 + slack. M4.2 handed its FOLD to
  // CollabTaskDrawer.svelte (open/onToggle props in, its own `open` state and
  // onExpand out) — the board shrank, the cap is untouched.
  'webview/chat/TaskBoard.svelte': 300,
  // --- Flock M4.1 wave R2x (ext UI): FIVE NEW files; not one existing cap was
  // raised. The three that bit were each paid for by extraction, exactly as the
  // ratchet prescribes: ChatPane.svelte (2659/2665) gave up the reasoning block,
  // InstructionsPane.svelte (158/160) its row markup, and CollabStream.svelte
  // went 36 lines OVER when the pill landed and gave up both the pill row and
  // its rules rather than take a raise. instructionRows.ts and ChatPane.svelte
  // were restamped DOWNWARD; collabExport.ts was restamped from 42/60 (a file
  // below its cap) to its new actual.
  //
  // HistoryDropdown.svelte: the sidebar's "which past one?" panel, extracted
  // VERBATIM from SidebarLauncher.svelte so the Collabs half could draw its
  // archived rooms with the same object instead of a second, thinner list.
  // Generic over {id, title, meta} for the reason SlashDropdown.svelte is
  // generic over {name, description, category}: the CALLER filters (a chat
  // matches on title+folder, an archived collab on title alone) and this draws.
  // DELIBERATELY not in THEMED_FILES: its one box-shadow literal came across
  // with the markup and carries the same exemption SidebarLauncher.svelte and
  // SlashDropdown.svelte already have — no --og-* shadow var exists anywhere in
  // this codebase. Capped at introduction (141) + slack.
  'webview/chat/HistoryDropdown.svelte': 165,
  // ThoughtPill.svelte: the reasoning block, extracted from ChatPane.svelte at
  // its cap so a collab agent's live turn and a chat model's thought are ONE
  // object — two surfaces drawing "a model is thinking" would otherwise drift.
  // The mark is a snippet rather than a branch: the chat keeps its static brain
  // (its rotating crane lives on the stream indicator, and a second one here
  // would run out of phase), the collab passes the rotating glyph instead.
  // A LEAF; capped at introduction (103) + slack.
  // + onToggle (the open-persists fix, see ChatPane.svelte's note above): one
  // prop, one ontoggle handler on the <details> tag, a rewritten `open` doc.
  // 114 -> 119; cap did NOT move.
  'webview/dashboard/components/ThoughtPill.svelte': 125,
  // collabActivity.ts: WHICH agents get a live pill and what it may say. Its own
  // module because the load-bearing rules are honesty rules about a brand-new
  // OPTIONAL wire field — only a running agent gets a pill, a malformed or
  // absent activity reads as "thinking…" rather than as a blank row, and the
  // engine's 200-char bound is re-applied — and every one has to be testable
  // with no DOM. Mirrors collabKinds.ts's split. A pure LEAF; intro 71 + slack.
  'webview/chat/collabActivity.ts': 90,
  // CollabLivePill.svelte: ONE running agent's row, extracted from
  // CollabStream.svelte, which was 287 lines against its 250 cap once the pill
  // landed. Takes the avatar down as a SNIPPET rather than drawing it again, so
  // an agent that is a brand animal in the transcript cannot become a letter
  // disc in its own pill. A LEAF; capped at introduction (75) + slack.
  'webview/chat/CollabLivePill.svelte': 95,
  // InstructionRow.svelte: ONE instruction row, extracted from
  // InstructionsPane.svelte (158/160) so the pane could grow the "+ New file"
  // affordance without a raise. RENAMED from InstructionCard.svelte — the card
  // GRID it was extracted for was reverted to the pre-grid STACK of full-width
  // rows (a share bar only compares against a bar of the same width), and a
  // file called Card that draws a row is a comment that lies. A rename of the
  // key, not a raise: the number is untouched. It carries the pane's THEME
  // obligation with it (see THEMED_FILES below) — its badges encode a prompt's
  // SOURCE in colour, so a literal here is a row that mis-reads in whichever of
  // the five themes it clashes with. A LEAF; capped at introduction (87) + slack.
  'webview/dashboard/components/InstructionRow.svelte': 110,
  // --- The Collab agents view becomes CARDS (M4.2). The pane was 378/380, so
  // BOTH halves of the change were paid for by extraction, never a raise: the
  // def row went out as a card component, and the persona seed text — long
  // enough on its own to blow the pane's remaining two lines — went out as a
  // pure module. The pane SHRANK. ---
  //
  // CollabAgentCard.svelte: ONE collab agent def, as a card. Extracted from
  // CollabAgentsPane.svelte, which had TWO lines under its cap when the card
  // work landed, so the ratchet's remedy applied before a single line was
  // written. Draws the def fields the list is chosen ON (name, model, preset,
  // step budget, description) plus edit/delete, and owns the delete CONFIRM
  // as local state — a pane-wide "which slug is confirming" was one more thing
  // for the pane to hold and nothing outside the card ever read it.
  // THEMED: the preset chip carries worker-vs-observer — the difference between
  // an agent that can edit files and one that cannot — partly in colour, so a
  // literal here is a permission level that mis-reads in one of the five themes.
  // A LEAF; capped at introduction (117) + slack. RAISED 135->150 for the
  // unpinned-model warning (v4 seeds change): a `modelWarning` $derived plus
  // one more `{#if}` block reusing the EXISTING `.ca-card-stale` class — no
  // new CSS, and nothing here to extract that would not just move the same
  // one ternary into a second file for no reader's benefit.
  'webview/dashboard/components/CollabAgentCard.svelte': 150,
  // ArchetypeAgentCard.svelte (Folds Board D7): ONE archetype reference card
  // (architect/ask/debug/orchestrator/scout/cartographer) — glyph, mode badge,
  // model chip, Set model popover (AgentModelSelect over collabArchetypeSetModel)
  // and Open file. No persona editor, no delete. UAT r2 item 3: scout is
  // pinnable like every other archetype (its security surface is the permission
  // block, not the model line) and the shipped-file caveat is a hint ON its mode
  // badge, not a badge of its own. A LEAF; capped at introduction (102) + slack.
  'webview/dashboard/components/ArchetypeAgentCard.svelte': 130,
  // collabPersonaSeed.ts: the default persona a NEW collab agent's body arrives
  // pre-filled with, per preset, plus the name rule both it and the card read
  // (a def is addressed by its slug WITHOUT the `collab-` filing prefix). Its
  // own module because the seed TEXT alone is longer than the pane's entire
  // remaining headroom, and because a seed is prose that gets reviewed as prose
  // — it should be diffable on its own, not buried in a form. Mirrors
  // instructionRows.ts's split. A pure LEAF, vscode-free and render-free;
  // capped at introduction (69) + slack.
  'webview/dashboard/components/collabPersonaSeed.ts': 85,
  // --- Flock M4.2 (the collab UAT wave): SIX NEW files; not one existing cap
  // was raised. The four that bit were each paid for by extraction exactly as
  // the ratchet prescribes — InputBar.svelte (948/955) gave up its image strip
  // AND its image intake, CollabMessageBubble.svelte (188/190) its attachment
  // markup, CollabPane.svelte (437/440) its cap row, and CollabControls.svelte
  // was restamped DOWNWARD after that row left it. ---
  //
  // collabHop.ts: the budget's derived TEXT — the three cap sentences, what is
  // LEFT of the hop budget, the low-state threshold and the suspended wording.
  // Its own module because TWO surfaces read the same pair of numbers now (the
  // control strip says why a room is paused, the bar under the composer says
  // how much is left), and the rules have to be testable with no DOM.
  // cronFormat.ts/loopFormat.ts are the precedent. Intro 75 + slack.
  'webview/chat/collabHop.ts': 100,
  // CollabHopBar.svelte: the remaining-budget read-out, the cap input and STOP,
  // moved OUT of CollabControls.svelte and remounted as the pane's LAST child,
  // directly under the composer — the budget is spent by posting, so its
  // controls belong where the posting happens. Its own component rather than
  // more markup in CollabPane.svelte, which sat two lines under its cap.
  // The count is SERVER truth: it moves when a poll lands and never on a local
  // tick, which would run the number down while the engine's own budget stood
  // still. Intro 122 + slack.
  'webview/chat/CollabHopBar.svelte': 145,
  // CollabWidthControl.svelte (W5): the room's DISPATCH WIDTH — how many
  // participant turns run at once. Its own component because the hop bar sat at
  // 121/145 and the control plus the rules that keep it apart from the cap (no
  // blank-means-default, no 0-means-off, refuse rather than clamp, and never
  // assert a width locally because the engine can refuse a raise) is 35 lines.
  // Extraction before addition, per the ratchet. Intro 83 + slack.
  'webview/chat/CollabWidthControl.svelte': 105,
  // CollabFlavorControl.svelte (W5-L2): what KIND of room this is — a chain, or
  // a COUNCIL that puts one question to every member at once. Beside the width
  // on the hop bar, because the bar already answers "how much may this room do
  // before it comes back to me" and this is the third face of it. Its own
  // component for the reason the width is: the bar sits at 136/145, and the
  // ratchet's remedy for that is a module. Intro 71 + slack.
  'webview/chat/CollabFlavorControl.svelte': 95,
  // CollabGroupRow.svelte (W5-L2): one SPEAKER'S run — avatar column, one
  // header, every bubble under it. EXTRACTED from CollabStream.svelte, which
  // stood at 246/250 when the council's round row needed a branch: extraction
  // before addition. The stream is a router over row kinds now, and each kind's
  // markup lives with the CSS that draws it. Intro 109 + slack.
  'webview/chat/CollabGroupRow.svelte': 135,
  // CollabRoundGroup.svelte (W5-L2): ONE council round as one block — every
  // member's independent answer collapsed to a line (the value of a round is
  // the SPREAD of positions, and three open essays show a reader one of them),
  // the room's own n-of-m record, and the reconciliation under them. Bigger
  // than the other chat leaves because it carries three states of one thing
  // (open, closed, closed-without-synthesis) and the CSS for the frame that
  // says they belong together. Intro 154 + slack.
  'webview/chat/CollabRoundGroup.svelte': 185,
  // collabCouncil.ts (W5-L2): which messages belong to one round, whether it
  // has closed, and what its one line says — a PURE leaf beside collabKinds.ts,
  // testable with no DOM. It folds the rows `buildStreamRows` already produced
  // rather than forking that model, because collabExport.ts renders a shipped
  // transcript from the same builder. Intro 118 + slack.
  'webview/chat/collabCouncil.ts': 150,
  // CollabTaskDrawer.svelte: the task board as a right-edge SLIDE-OUT drawer
  // over the stream, in the idiom ChatPane's run-time todo overlay established
  // (absolute right-edge box + a pull-tab + translateX(calc(100% - 16px))).
  // The idiom is COPIED, not factored: generalising TodoStrip.svelte and this
  // into one component would mean one file serving a per-turn checklist and a
  // persistent task board — two lifetimes, two data flows, one set of props
  // pulled both ways. The geometry is thirty lines of CSS; the coupling would
  // be permanent. TaskBoard.svelte mounts inside it, whole. DELIBERATELY not in
  // THEMED_FILES: its one box-shadow literal is the same neutral black lift
  // ChatPane's overlay, SlashDropdown and HistoryDropdown already carry, and no
  // --og-* shadow var exists anywhere in this codebase. Intro 156 + slack.
  'webview/chat/CollabTaskDrawer.svelte': 180,
  // CollabDrawerTab.svelte (W2, owner screenshot): the drawer's PULL-TAB, and
  // the only part of it on screen while it is shut - which is why the lone
  // unlabelled chevron read as an unexplained pill floating over the room. It
  // names the board and states the work still owed. Extracted when that took
  // CollabTaskDrawer.svelte 13 lines past its cap. Intro 82 + slack.
  'webview/chat/CollabDrawerTab.svelte': 110,
  // CollabActivityList.svelte (W2): one agent's RETAINED activity log, beside
  // its prompt capture. Wave 1 shipped the retention engine-side and nothing
  // extension-side mirrored the field, so it arrived on every poll and was
  // dropped. Newest-first, newest few only. Its own component so the drawer
  // stayed inside its cap with the F14 re-poll in it too. Intro 82 + slack.
  'webview/chat/CollabActivityList.svelte': 110,
  // CollabImages.svelte: the images a human attached to a collab message, as
  // thumbnails under the bubble's text — MessageRow.svelte's `.attached-images`
  // idiom, so an attachment reads the same in a chat and in a room. Its own
  // component because CollabMessageBubble.svelte had TWO lines under its cap
  // when this landed. A LEAF; intro 49 + slack.
  'webview/chat/CollabImages.svelte': 70,
  // ImageStrip.svelte: the composer's attached-image row, extracted VERBATIM
  // from InputBar.svelte — the same move SamplingControl/SlashDropdown/
  // PinnedUserMessage made, for the same reason (that file at its cap, and now
  // TWO composers drawing the strip). Purely presentational. Intro 32 + slack.
  'webview/dashboard/components/ImageStrip.svelte': 50,
  // ImageLightbox.svelte: ENLARGE-TO-FIT for any chat image — the composer's
  // 48px `cover` thumbnail (a CROP: you cannot see what you attached) and the
  // transcript's 280x200 one. Its own component rather than a branch in either
  // of them because ONE pane-level mount is the whole design: the backdrop is
  // position:fixed, so a per-row or per-cell mount would stack N veils. No zoom,
  // no pan, no paging — every part beyond "show me that one, bigger" would be
  // machinery with its own failure modes. Mirrors ConfirmModal.svelte's overlay
  // shape (fixed backdrop, window Escape, stopPropagation on the content) and,
  // like it, is DELIBERATELY not in THEMED_FILES: its one rgba is a dimming
  // veil, which is opacity over whatever is behind it rather than a themed
  // surface. A LEAF; intro 107 + slack.
  'webview/dashboard/components/ImageLightbox.svelte': 125,
  // composerImages.ts: the composer's image INTAKE — the accepted types, the
  // size ceiling, the read timeout, the over-large resize, and the refusal
  // WORDING (each one names the limit it hit). Extracted from InputBar.svelte
  // for the same cap reason, and the rules matter more with two callers than
  // with one: two surfaces now send the results to two different places, and a
  // second copy of the validation would be a second answer to "is this legal?".
  // Answers rather than throws — a rejected promise inside a paste handler is
  // an unhandled rejection. Intro 87 + slack.
  'webview/dashboard/components/composerImages.ts': 115,
  // --- Flock M4.4 (the composer/permission/board UAT wave): SEVEN NEW files;
  // not one existing cap was raised. FOUR bit and each was paid for by
  // extraction exactly as the ratchet prescribes — PermissionBar.svelte
  // (243/245) gave up its Revise box, CollabAgentsPane.svelte (377/380) its
  // glyph picker, ChatPane.svelte went 3 lines OVER when the scroll stick and
  // the sub-agent drawer landed and gave up the todo overlay, and acpClient.ts
  // (1349/1350) took the `_meta.answerText` branch as a NET-ZERO rewrite of the
  // respond callback rather than a raise. Both panes SHRANK. ---
  //
  // modelBanner.ts: WHICH of the three things `ok: false` means — probed and
  // dead, or NOT PROBED YET. Its own module because the `Checking provider…`
  // sentinel is MIRRORED across the src/webview boundary (tsconfig.webview.json
  // pins rootDir to `webview/`), and a mirror needs a test that reads
  // DashboardPanel.ts and asserts the two literals still agree. A pure LEAF,
  // mirroring modelGrouping.ts's split from ModelPicker.svelte. Intro 68 + slack.
  'webview/dashboard/components/modelBanner.ts': 90,
  // permissionOptions.ts: the bar's three option rules — question-vs-consent
  // shape, the allow-option preference order a YOLO click must not exceed, and
  // the "Other" finder. MIRRORS agentManager/questionRouting.ts and
  // agentManager/permissions.ts for the same rootDir reason, with the same
  // read-the-host-file drift guard. A pure LEAF; intro 67 + slack.
  'webview/dashboard/components/permissionOptions.ts': 90,
  // questionBatch.ts: BOTH directions of the batched-question `_meta` contract —
  // parse `_meta.questions` off an ask, build the `_meta` a reply reads back,
  // parse a webview batch reply. EXTRACTED from acpClient.ts, which went 4 lines
  // over its 1350 cap carrying them inline, and from DashboardPanel.ts. Pure and
  // DOM-free because the shapes come off a wire this package does not control.
  // Intro 97 + slack.
  'src/questionBatch.ts': 130,
  // PermissionTextEntry.svelte: the bar's free-text sub-panel, EXTRACTED from
  // PermissionBar.svelte at its cap. ONE component for both text paths (plan
  // "Revise" and a question's "Other") because they are the same object — type
  // something, send it with an option — and a second copy of the markup would
  // be a second place for them to drift. Intro 114 + slack.
  'webview/dashboard/components/PermissionTextEntry.svelte': 140,
  // TodoOverlay.svelte: the right-edge live task overlay, EXTRACTED from
  // ChatPane.svelte when it went OVER its cap. Deliberately NOT factored
  // together with SubagentDrawer.svelte below — a per-turn checklist and a
  // roster of live sub-agents are two lifetimes and two data flows, and the
  // shared part is thirty lines of CSS. Same call CollabTaskDrawer.svelte's own
  // cap comment records for the same idiom. Intro 84 + slack.
  'webview/dashboard/components/TodoOverlay.svelte': 110,
  // SubagentDrawer.svelte: the LEFT-edge roster of sub-agents still out. Borrows
  // TodoStrip's pull-tab INTERACTION, not its top-strip layout. Draws nothing at
  // all (not even a tab) with no rows. Intro 148 + slack.
  // 172->181 (t-kgryh1 polish, EXTRACT FIRST): one row's markup/CSS moved out
  // to the new SubagentRow.svelte below BEFORE this grew — the dismiss button
  // landed there, not here. What's left is the list's own collapse header
  // (default collapsed, count always visible) and an explicit px cap+scroll
  // on .sa-list, independent of the ancestor's percentage max-height. Still 6
  // over after extraction, so raised to 185 rather than squeezing CSS to hit
  // the old number.
  'webview/dashboard/components/SubagentDrawer.svelte': 185,
  // SubagentGroup.svelte: ONE labelled band of the sub-agent drawer — its
  // heading, its count, and the rows under it. EXTRACTED from
  // SubagentDrawer.svelte (183/185) when the roster split into Running and
  // Complete, so adding a band is one more tag rather than a second copy of an
  // {#each} and its <ul> styling. An empty band draws nothing, not a standing
  // "Complete 0" — the drawer is a 240px glance surface. A LEAF; intro 66 + slack.
  'webview/dashboard/components/SubagentGroup.svelte': 85,
  // SubagentTranscriptView.svelte: a finished sub-agent's OWN session, drawn
  // with the chat's renderer instead of the flat forwarded log. Owns the
  // request keyed to the child id, the four draw states (loading / error /
  // gone / empty) and the READ-ONLY handoff into ChatTranscript — the child id
  // is real, so without that flag Kill and Stop would reach a live session.
  // The thought open-set is local $state here: there is no session to write to.
  // Intro 165 + slack.
  'webview/dashboard/components/SubagentTranscriptView.svelte': 195,
  // SubagentRow.svelte (t-kgryh1 polish): ONE roster row — dot/name/age/model/
  // activity tail, plus a FAILED row's dismiss (x). Extracted OUT of
  // SubagentDrawer.svelte (see its cap comment above) rather than grown
  // in place. A LEAF; intro 108 + slack.
  'webview/dashboard/components/SubagentRow.svelte': 130,
  // chatScroll.ts: the follow-the-stream predicate. Its own module because the
  // threshold is the whole decision — an exact bottom test unsticks a user who
  // never touched the wheel — and a threshold nobody can unit-test is one
  // nobody can trust. A pure LEAF, mirroring pinnedUser.ts's split out of the
  // same pane. Intro 40 + slack.
  'webview/dashboard/panes/chatScroll.ts': 60,
  // subagentRows.ts: which sub-agents are still out, derived from the
  // transcript's OWN `task` cards rather than a second wire that could disagree
  // with the tool card above it. Owns the honesty rules — dedupe a RESUMED
  // agent to one row, treat an unknown status as still running, print no age
  // rather than a fake one. Clock injected. A pure LEAF; intro 94 + slack.
  // Sat at 120/120 until the failed-spawn rule needed room; the lifecycle half
  // went to subagentEntry.ts below and this file fell to 81. Cap left where it
  // is rather than restamped down — the ratchet only ever needs to bite.
  'webview/dashboard/panes/subagentRows.ts': 120,
  // subagentFormat.ts: how a sub-agent row PRINTS — its age and the tail of its
  // live activity. EXTRACTED from subagentRows.ts when the live-activity tail
  // took that file to 121/120: the split is by responsibility, not to move a
  // number — one file decides who is still out (a lifecycle rule that has to be
  // right), this one decides what a row looks like. Pure LEAF; intro 41 + slack.
  'webview/dashboard/panes/subagentFormat.ts': 60,
  // subagentTiming.ts: WHERE a row's duration comes from — the engine's stored
  // span first, the card's own build stamp only as a last resort. EXTRACTED
  // rather than added to subagentRows.ts, which was at 119/120 when the reload
  // defect ("every row reads 0s") had to be fixed there; the split is by
  // responsibility anyway, since that file answers WHO is on the roster and
  // this one HOW LONG one has been out. A LEAF; intro (76) + slack.
  'webview/dashboard/panes/subagentTiming.ts': 85,
  // subagentEntry.ts: the roster ADMISSION rules — is this card a sub-agent of
  // this chat, what identity does it have, is it still out. EXTRACTED from
  // subagentRows.ts (120/120) when the failed-spawn rule landed: a denied ask
  // and an unknown agent type both fail before a child session exists, so such
  // a card has no session id and has to be keyed and stated differently. The
  // split is the same responsibility line the format leaf took — lifecycle
  // here, dedupe and row shaping there. Pure LEAF; intro 112 + slack.
  'webview/dashboard/panes/subagentEntry.ts': 130,
  // subagentInbox.ts: where a sub-agent SIDE-CHANNEL event lands — the child id
  // it carries, the card it belongs to, the stream cap, and the counted line a
  // DROP now prints. EXTRACTED from ChatPane.svelte (2700/2700) when the drawer
  // clock needed room: the pane kept the dispatch, the rules came here where
  // they can be checked without a render. Pure LEAF; intro 82 + slack.
  'webview/dashboard/panes/subagentInbox.ts': 110,
  // taskRiders.ts: the `task` riders a tool card carries — identity, plus the
  // engine's own run span — and the single rule for merging them:
  // write-if-present, never overwrite (the END is write-ONCE), because the
  // engine only learns them once the CHILD SESSION exists and they land on
  // later updates in no guaranteed order. `taskDone` is the one that bites: the
  // drawer retires a background row on that field alone. EXTRACTED from
  // chatToolMsg.ts at 180/180 (which came back to 170), and kept OUT of
  // subagentInbox.ts — that file owns where a side-channel event GOES, not what
  // a card's fields mean. A pure LEAF; intro 53 + slack.
  'webview/dashboard/panes/taskRiders.ts': 70,
  // SubagentDock.svelte: the drawer's LIVE wiring — this chat's rows plus the
  // 1s CLOCK that keeps their ages honest (they used to freeze at whatever age
  // they were born with, because the pane read Date.now() inline once per
  // render). EXTRACTED from ChatPane.svelte at its cap rather than growing it:
  // the drawer's shape stays in SubagentDrawer.svelte, one row in
  // SubagentRow.svelte, and "a roster is a live thing" lives here. Intro 50 + slack.
  'webview/dashboard/components/SubagentDock.svelte': 70,
  // chatToolMsg.ts (2026-08-06): the transcript's tool-message merge rules
  // ('toolCall' append / 'toolResult' merge-by-id / detached fallback),
  // extracted from ChatPane's router at its cap, PLUS the shell-fact shaper
  // (bash rawInput/rawOutput.metadata -> toolShell). Pure array-in/array-out,
  // unit-tested without a DOM. Intro 163 + slack.
  'webview/dashboard/panes/chatToolMsg.ts': 180,
  // chatToolTitle.ts: the collapsed chat row's LABEL rules — the "Edit: " prefix,
  // the one-line guarantee, and adopt-vs-freeze (only apply_patch takes a later
  // frame's title, because only its pending row is born useless: the part is
  // created with input:{}, so the row read "Edit: apply_patch" until the user
  // expanded it). EXTRACTED from chatToolMsg.ts at 180/180, which came back to
  // 180. A pure LEAF, no DOM — which is the point, since the row itself cannot
  // be asserted. Intro 66 + slack.
  'webview/dashboard/panes/chatToolTitle.ts': 80,
  // CollabGlyphPicker.svelte: the collab-agent form's glyph picker, EXTRACTED
  // from CollabAgentsPane.svelte (377/380) before the vision checkbox and the
  // card grid were written — the pane came back to 376. A LEAF; intro 57 + slack.
  'webview/dashboard/components/CollabGlyphPicker.svelte': 75,
  // --- Folds board v2 (the transposed ticket kanban): EIGHT NEW files, not one
  // existing cap raised. AgentManagerPane (660) and AgentCard (318) both HELD
  // through a rewrite that added seven columns, repo pills, ticket cards, a
  // launch popover and a live activity line — because every pixel moved out into
  // the leaves below and the pane came back 625 -> 358, the card 314 -> 301. ---
  //
  // boardBuckets.ts: the PURE bucket + cluster logic — which column a fold row or
  // a ticket lands in (incl. Blocked, which is DERIVED from needsYou/error and
  // never stored), the launched-ticket dedupe, the card filters and the race
  // clustering. Its own module precisely so those rules are testable with no DOM;
  // mirrors modelGrouping.ts's split from ModelPicker. A pure LEAF; capped at
  // introduction (175) + slack. The repo-pill badge counts LEFT with the pills
  // (repo cards): the card face carries no counts, so nothing called them.
  'webview/dashboard/components/boardBuckets.ts': 200,
  // RepoCards.svelte: the top strip's selector, REPLACING RepoPills.svelte (deleted
  // with its 115 cap). A pill was one per registered PATH, so a repo checked out
  // twice drew two, and its working/blocked/queued badges duplicated the In
  // progress and Blocked columns two inches below — both gone. A card is one
  // REPOSITORY (grouped by git common dir) and its face is the name + the
  // primary's branch. The grouping itself is pure and lives in repoGroups.ts, so
  // this file is the picture.
  // 195->120 (folds-ui2, DOWNWARD restamp): the under-card worktree reveal and its
  // three row actions moved OUT into RepoDetail.svelte, because UAT round 2 threw
  // out a design where every open card pushed the board further down. The file
  // came back 167 -> 98; cap = actual + slack, so the ratchet keeps the win.
  // folds-ui4 (UAT round 4) added the rename pencil back ONTO the card and the cap
  // HELD (98 -> 118): the pencil opens RepoHeader's field rather than a second one,
  // so the card gained a button and a callback, not an editor.
  'webview/dashboard/components/RepoCards.svelte': 120,
  // RepoDetail.svelte: the SELECTED repository, as the right-hand pane of the top
  // strip — its checkouts (primary first, each with terminal / chat here / make
  // primary) and then its local branches, READ-ONLY, each marked with the checkout
  // that has it out. That mark is DERIVED from the rows rather than sent a second
  // time, which is the only logic in the file; everything else is the picture the
  // card's reveal used to draw. A LEAF; intro 164 + slack.
  // 185->160 (folds-ui3, DOWNWARD restamp): UAT round 3 asked for hierarchy, which
  // the pane paid for by giving the CHECKOUT ROW its own file — the two-line
  // structure, the badges and the hover/focus action cluster all left with it. What
  // stays is the pane: the branch list, the derivation behind it, and the control
  // that says which list you are looking at. 201 -> 145; cap = actual + slack.
  // folds-ui4 (UAT round 4): the two stacked sections became a TOGGLE — one list at
  // a time, each with the pane's full height — and the cap HELD (145 -> 157). The
  // mini-header idiom paid for it: it went out as the two buttons came in.
  'webview/dashboard/components/RepoDetail.svelte': 160,
  // RepoCheckoutRow.svelte (folds-ui3): ONE checkout and the three things you do to
  // it. Split out of RepoDetail.svelte when UAT round 3 read that pane as "busy and
  // disorganized" — a row that wrapped its name, its badges and three buttons onto
  // three ragged lines became a FIXED two lines with the actions in one cluster
  // that fades in on hover or :focus-within. A pure LEAF (no state of its own; it
  // posts the same three payloads the card's reveal always did); intro 82 + slack.
  'webview/dashboard/components/RepoCheckoutRow.svelte': 100,
  // repoGroups.ts: which entries are ONE repository, and which of them the card
  // is led by. Split from the component for the reason boardBuckets.ts was: a
  // grouping rule is decidable from data alone, so it gets a test with no DOM.
  // Carries the MIRRORED WorktreeRowInfo + RepoDetailInfo (a webview .ts cannot
  // import from src/) under the drift guard in repoGroups.test.ts. A pure LEAF;
  // intro 59 + slack.
  'webview/dashboard/components/repoGroups.ts': 80,
  // RepoHeader.svelte: the selected repo's toolbar — default model, the
  // cartographer map controls + status, the card filter, auto-approve, and
  // unregister. Everything that used to sit atop a repo COLUMN, now that there is
  // one repo on screen. A LEAF; intro 116 + slack.
  // folds-ui4 (UAT round 4): the rename field it owns is now opened by TWO pencils —
  // its own and the strip card's — so the open/closed flag moved up to the pane that
  // enforces "one editor at a time". Two props, not a second editor; cap HELD at 139.
  'webview/dashboard/components/RepoHeader.svelte': 140,
  // StatusColumn.svelte: one column — head (label / count / one-line subtitle),
  // an optional head action, and a snippet body, so the column knows nothing
  // about ticket-vs-fold cards. A LEAF; intro 78 + slack.
  'webview/dashboard/components/StatusColumn.svelte': 95,
  // TicketCard.svelte: the Hermes ticket anatomy (id chip · priority · labels ·
  // title · @assignee · acceptance · age) plus the open / launch / close actions
  // its status has earned. A LEAF; intro 106 + slack.
  'webview/dashboard/components/TicketCard.svelte': 130,
  // QuickAdd.svelte: the capture SHELL — the draft state, the submit, the
  // keyboard rule and the Add button. The boxes are QuickAddFields, the wire
  // shape is lib/quickAddTicket. A LEAF; intro 42 + slack.
  // The cap DID NOT MOVE — the file SHRANK 101 -> 59. It had grown from "one-field
  // capture" to a five-field form and gone 41 over; EXTRACTION CAME FIRST, twice,
  // because logic was only 42 of its 101 lines and a lib-only cut could never have
  // reached 60.
  'webview/dashboard/components/QuickAdd.svelte': 60,
  // QuickAddFields.svelte: the capture's five input boxes and nothing else. All
  // five, not just the four that grew: ONE rule dresses title/tasks/acceptance as
  // a family, and Svelte scoping would have split it into two drifting copies.
  // Renders no wrapper, so the boxes stay direct flex children of .am-qa and DOM
  // order is unchanged. A LEAF; intro 75 + slack.
  'webview/dashboard/components/QuickAddFields.svelte': 95,
  // quickAddTicket.ts: the quick-capture's pure half — the amTicketQuickAdd wire
  // shape (required title, a field at its default left OUT, the two list splits)
  // and the tasks box row count. String in, object out, no DOM, so the rules have
  // a test that does not need a board. A LEAF; intro 45 + slack.
  'webview/dashboard/lib/quickAddTicket.ts': 60,
  // LaunchPopover.svelte: the ONLY place an agent type and a model are chosen on
  // this board, plus the race-variant rows. A LEAF; intro 168 + slack.
  'webview/dashboard/components/LaunchPopover.svelte': 195,
  // CardOverflow.svelte: the card's ⋯ menu — WORDED entries (an icon rail can say
  // "✕", a menu has to say what it destroys) and the inline two-click confirm a
  // destructive entry carries. A LEAF; intro 98 + slack.
  'webview/dashboard/components/CardOverflow.svelte': 120,
  // chartBlock.ts: the shared chart-block parse/render leaf (this wave's chart
  // card support). Capped at introduction + slack.
  'webview/shared/chartBlock.ts': 455,
  // browserBridge.ts: this wave's browser-tool bridge leaf. Capped at
  // introduction (318) + slack. 350->360: S5 UAT round 3 typecheck fix imports.
  'src/browserBridge.ts': 360,
  // acpToolContent.ts: this wave's ACP tool-content leaf. Capped at
  // introduction (49) + slack.
  'src/acpToolContent.ts': 55,
  // acpTaskMeta.ts: the sub-agent `_meta` riders (child session, detached flag,
  // routed model, terminal marker), EXTRACTED from acpClient.ts — which sat SIX
  // lines under its 1350 cap — when the drawer needed three more facts than the
  // child's session id. A MIRROR of packages/engine/src/acp/event.ts, so it
  // owes the drift guard in acpTaskMeta.test.ts. Intro 64 + slack.
  'src/acpTaskMeta.ts': 80,
  // chatToolMeta.ts: this wave's chat tool-metadata leaf. Capped at
  // introduction (100) + slack.
  'webview/dashboard/panes/chatToolMeta.ts': 110,
  // BrowserCard.svelte: this wave's browser tool-card leaf. Capped at
  // introduction (205) + slack.
  'webview/dashboard/components/toolcards/BrowserCard.svelte': 230,
  // ChartCard.svelte: the `chart` tool-card leaf — it draws the tool's spec
  // through shared/chartBlock.ts and owns no drawing of its own, so it must
  // stay small. Capped at introduction (98) + slack.
  'webview/dashboard/components/toolcards/ChartCard.svelte': 120,
  // stuckCall.ts (t-kgs7om): when a running tool call has been running long
  // enough to say so. Extracted from BashCard when the age chip and the Kill
  // button had to move into ToolCard's HEADER — they had shipped in the card
  // BODY, which mounts only once the card is expanded, so on a live wedged
  // command nobody had clicked, the Kill button was not in the DOM at all.
  // SHARED rather than mirrored, so header and card cannot disagree about what
  // "stuck" means. Pure; capped at introduction (36) + slack.
  'webview/dashboard/components/toolcards/stuckCall.ts': 50,
  // browserTools.ts: the VS Code integrated-browser CONTRACT, extracted from
  // browserBridge.ts (318/350, no room) when the page verbs were rebuilt
  // against the real shipped tool schemas. Pure and vscode-free: the real tool
  // ids, the per-action input builders, the page-list/page-id parsing, the
  // tool-result part split, and the three distinct "why it could not act"
  // answers. The split is along the testable line — this half needs no
  // extension host, the other half is nothing but invocations. Every value in
  // it was read off a shipped 1.132.0 bundle, so it changes only when VS Code
  // does — which is also why it is capped generously: a new VS Code browser
  // tool is a few lines HERE and nowhere else. It took the last of the bridge's
  // prose (noOpenerError / unsharedOpenNote) in the same pass, so that every
  // sentence this feature can say sits in one file. Intro 282 + slack.
  'src/browserTools.ts': 310,
  // browserResult.ts: what VS Code ANSWERED, extracted from browserTools.ts
  // (282/310, no room) when the bridge was taught to read FAILURE. Pure and
  // vscode-free like the file it came from: the page list and its three states,
  // the opened page id, the withheld-page tail, the declined open, and the
  // split of a tool result into text, image and error. It is one leaf because
  // the failure signals only make sense beside the parts they are read out of —
  // VS Code emits two of them and `$invokeTool` forwards only part of each, so
  // reading one without the other is what painted a failed click green. Intro
  // 188 + slack.
  'src/browserResult.ts': 220,
  // browserVsCode.ts: the two VS Code SURFACES this bridge reaches through —
  // the integrated-browser open command (probed, because its id moved between
  // releases) and `vscode.lm` tool discovery/invocation. Extracted from
  // browserBridge.ts (341/350, no room) in the same pass; it is the paragraph
  // that file's header already described as separate. Every `vscode.` call this
  // feature makes is in here and nowhere else, which is also what lets the
  // other three files stay testable without an extension host. It grows only
  // when VS Code adds a surface. Intro 92 + slack.
  // 115->130: VS Code added a surface, which is the one growth this cap was
  // written to expect — the shared page's EDITOR (revealed by its resource uri)
  // and the global auto-approve setting, both needed by the t-kgswmj round-3
  // click work. EXTRACTION CAME FIRST and it came twice: that work put
  // browserPage.ts and browserForce.ts on disk and moved lookupPage out of
  // browserBridge.ts. Nothing here can join them — this file exists precisely
  // so that every `vscode.` call in the feature sits in one place, so moving
  // these two calls out would undo the split that makes the other five files
  // testable without an extension host. What is here is 6 lines of call under
  // 16 of why.
  'src/browserVsCode.ts': 130,
  // browserRetry.ts: the ONE bounded retry a failed page verb gets, extracted
  // rather than folded into browserBridge.ts (356/360, no room) because it is a
  // different question — that file decides which TOOL a verb means, this one
  // decides whether the way a tool FAILED earns a second attempt and with what
  // selector. Pure and vscode-free like its three siblings, which is what lets
  // both branches be tested off the verbatim Playwright error strings instead of
  // a live browser: the strict-mode refusal (retried as `>> nth=0`, reporting
  // WHICH element it then acted on) and the actionability timeout (retried as
  // `>> visible=true`). It is capped tightly because it must stay a classifier:
  // a third retry shape is a few lines here, but a retry LOOP belongs nowhere.
  // Intro 151 + slack.
  'src/browserRetry.ts': 170,
  // browserPage.ts: which page a verb acts on, and whether that page is ON
  // SCREEN. `lookupPage` moved here OUT of browserBridge.ts (357/360, no room)
  // when the UAT proved the clicks were failing on a background editor tab
  // rather than on a bad selector — a page VS Code lists as "not visible" has
  // no layout, so Playwright's actionability check can never pass, whatever the
  // selector says. The decision half (planReveal / screenNote) is pure, so both
  // the reveal and the four sentences a failure can carry are tested without a
  // workbench; only the `vscode.open` call itself lives in browserVsCode.ts.
  // Most of the file is the bundle evidence for WHY the page list, and not
  // vscode.window.tabGroups, is the surface that can answer this. Intro 128 +
  // slack.
  'src/browserPage.ts': 145,
  // browserForce.ts: the LAST rung of the click ladder — the forced click, and
  // the one attempt that skips Playwright's own actionability checks. Separate
  // from browserRetry.ts (158/170, no room) and a different question: that file
  // asks whether a narrower SELECTOR would work, this one accepts the selector
  // and gives up on the checks. It is mostly its own justification, because
  // round 2 refused to do this and the refusal was correct at the time — the
  // header carries the bundle reading (`shouldAutoConfirm`, the no-chat-context
  // branch of `invokeTool`) that shows exactly which setting changed the
  // answer, and the residual opt-in dialog that setting cannot suppress. The
  // gate is pure and takes the setting as a boolean, so both sides of it are
  // tested without a workbench. Intro 166 + slack.
  'src/browserForce.ts': 185,
  // browserDrive.ts: the eight DRIVEN verbs — what input each one's tool takes,
  // and the run against the page already shared. Extracted twice over when
  // hover/drag/dialog/raw were mapped: out of browserBridge.ts (335/360, which
  // four more cases would have burst) and out of browserTools.ts (309/310, which
  // had no room for a single line). Both halves of a verb live here for the
  // reason browserForce.ts already keeps `forceInput` beside the force: the
  // input IS the verb — `drag_element` names its two ends fromSelector/
  // toSelector, and a builder filed away from the case that calls it is exactly
  // how the first bridge came to send fields VS Code silently ignored. Every
  // field is quoted from the 1.133.0 `inputSchema` it was read from. Intro 287 +
  // slack; a new VS Code verb is one builder and one case.
  'src/browserDrive.ts': 320,
  // questionAsks.ts: who OWNS a clarifying-question batch, and which one the
  // modal may render. EXTRACTED from ChatPane.svelte, which was at 2700/2700
  // with no room for the fix at all — the ownership rules (one batch per chat,
  // shown only over a cell on screen, active cell first, draft kept across a
  // tab switch, replay of the same toolCallId resumes rather than wipes) are
  // the whole reason the modal used to land on the wrong tab, so they belong
  // where they can be tested without a render. Pure LEAF; intro 136 + slack.
  'webview/dashboard/panes/questionAsks.ts': 150,
  // tabWaiting.ts: the ONE derivation the tab strip's waiting colour needs —
  // hasOpenQuestion OR hasPendingApproval — EXTRACTED from ChatPane.svelte,
  // which was at 2700/2700 with no room for even this one-line rule. Trivial
  // on its own, but it is the single source of truth for "this tab needs you"
  // (the same semantic chat/sessionRowState.ts's ring already carries) and it
  // is what makes the rule testable without a render. Pure LEAF; intro 14 + slack.
  'webview/dashboard/panes/tabWaiting.ts': 25,
  // acpToolMeta.ts (replay-toolcards fix): the `_meta.origami_tool_name` rider
  // reader, EXTRACTED from acpClient.ts (1367/1370, no room) so the tool_call
  // AND tool_call_update cases share ONE accessor instead of the update case
  // going without — which was the whole defect: a replayed update with no
  // matched initial call fell to GenericCard despite the engine sending the
  // rider on every event. A pure LEAF; intro 17 + slack.
  'src/acpToolMeta.ts': 30,
  // sessionLog.ts + chatRestore.ts (reload-toolcards fix): the SECOND half of
  // the same defect. acpToolMeta.ts made the engine's rider readable, but a
  // reloaded chat never rendered a card at all — its tab opens AFTER start(),
  // so the replayed tool posts land on no webview and the tab is rebuilt from
  // the host's message log, which kept only a tool's TITLE and restored it as
  // a text row. sessionLog.ts owns the log's shape + its tool-entry writes
  // (EXTRACTED from DashboardPanel.ts at 6336/6336, which SHRANK as a result);
  // chatRestore.ts owns the rebuild (EXTRACTED from ChatPane.svelte) so the
  // rule that was wrong is assertable without a render. Pure LEAVES, driven in
  // tests by a REAL captured `session/load` stream; intro 85/62 + slack.
  // 100->115 (0.4.45 stale sub-agent row, +15 — FLAG FOR SIGN-OFF): a THIRD
  // write rule, `logSubagentDone`. A background child's terminal marker arrives
  // on its own channel rather than as a tool_call_update, so neither existing
  // writer saw it, and the drawer retires that row on `taskDone` alone — a
  // reload therefore resurrected finished sub-agents as permanently "running".
  // EXTRACTION CAME FIRST and went the other way, out of the webview half of
  // the same fix (taskRiders.ts, which also took 10 lines off chatToolMsg.ts at
  // 180/180). What is left here is irreducible: it is a peer of logToolCall and
  // logToolResult, writing the same log by the same rules, and there is no
  // fourth module to split three sibling writers into. `archiveLog` below is a
  // separable concern and is the extraction to make if this file grows again.
  'src/dashboard/sessionLog.ts': 115,
  // subagentTranscript.ts: the engine's transcript entries as sessionLog.ts's
  // REPLAY-LOG rows, so the webview rebuilds them through chatRestore's own
  // merge rules rather than a second mapper free to disagree with the first.
  // The per-field readers are the live path's (decodeToolContent /
  // toolNameRider / taskRiders). No `vscode` import, so the shaping is testable
  // without an extension host — boardData.ts's rule. Intro 161 + slack.
  'src/dashboard/subagentTranscript.ts': 190,
  'webview/dashboard/panes/chatRestore.ts': 75,
  // --- Collab lane L1 (host plumbing): the engine's `no-lead` notice reaches
  // the room, and the host polls collabs itself so a shut tab is not a blind
  // one. Five LEAVES, four of them extractions that PAID for the additions —
  // every central collab file was on or one line under its cap.
  //
  // collabPayloads.ts: the reply SHAPES a collab host leaf answers in, out of
  // collabData.ts (250/250, and `notice` still to add). Types only, no runtime.
  // collabData.ts shrank 250 -> 215 and re-exports every name. Intro 74 + slack.
  'src/dashboard/collabPayloads.ts': 100,
  // collabAttention.ts (W2, report F12/1.13): does this room NEED the user? The
  // rule alone - a tripped loop breaker, or a done task with no agent still
  // working - so the answer is testable with no webview panel, no poll and no
  // engine. Deliberately does not badge "an agent is running": a badge that is
  // always on is a badge nobody reads. Pure LEAF; intro 38 + slack.
  'src/dashboard/collabAttention.ts': 70,
  // collabWatch.ts: the HOST-side collab poll — one slow re-armed timer for the
  // workspace, armed from every collab list, so the sidebar ring survives a
  // closed tab (report F1). Module state on purpose (collabs are
  // workspace-scoped and one engine answers for all of them); DashboardPanel
  // stops it on dispose. No vscode import — the whole lifecycle is driven with
  // fake timers in collabWatch.test.ts. Intro 89 + slack.
  'src/dashboard/collabWatch.ts': 120,
  // collabAgentDefForm.ts: the stated-only field rule for a saved agent def,
  // out of collabManager.ts (300/300) to pay for the watch's wiring. Pure — an
  // unstated field must not reach the writer, which resolves absent fields from
  // the file on disk. Intro 35 + slack.
  'src/dashboard/collabAgentDefForm.ts': 60,
  // collabExportFile.ts: the collab transcript's save dialog + write, out of
  // DashboardPanel.ts (which was EXACTLY on 6336 and SHRANK to 6323). Mirrors
  // mapExport.ts; the webview still renders the markdown. Intro 37 + slack.
  'src/dashboard/collabExportFile.ts': 60,
  // collabPollLoop.ts + CollabBanners.svelte: out of CollabPane.svelte
  // (439/440) to pay for the notice line. The loop is the pane's re-arm +
  // two-speed cadence rule, now provable with fake timers alone; the banners
  // leaf owns the error line, the notice line and the WORDING of every notice
  // code. CollabPane.svelte shrank 439 -> 423. Intro 47/55 + slack.
  'webview/chat/collabPollLoop.ts': 70,
  'webview/chat/CollabBanners.svelte': 80,
  // --- Collab lane W2-L1 (setting a room up): the guided card an empty room
  // opens with, multi-select invite, model + provider health on every
  // candidate, a settable lead and an editable objective. SIX leaves, four of
  // them extractions that PAID for the additions — CollabPane.svelte was
  // 432/440, CollabRosterPicker.svelte 132/135 and collabInvite.ts 64/85.
  //
  // collabHealth.ts: CAN this agent take a turn? Reads the host's existing
  // `providerStatus` broadcast. Keeps UNPINNED (the shipped seeds' ordinary
  // state), DEAD and UNKNOWN (no probe yet) apart — folding the last two would
  // mark every candidate unreachable for one round trip. Intro 67 + slack.
  'webview/chat/collabHealth.ts': 90,
  // CollabInviteList.svelte: the candidates as a MULTI-SELECT list, out of
  // CollabRosterPicker.svelte (132/135). Shared by the roster's ＋ popover and
  // the setup card, so there is ONE invite control rather than two that can
  // disagree. The picker shrank 132 -> 88 and keeps only its close rule.
  // Intro 159 + slack.
  'webview/chat/CollabInviteList.svelte': 180,
  // CollabSetupCard.svelte: the three-step guide (invite / lead / objective) a
  // room opened with an empty roster offers. Written against the M3 scar — a
  // Create button disabled by a list that had not arrived — so it is not a
  // modal, no step gates another, and dismissing costs nothing. Mounted by
  // CollabRoster.svelte, which already holds every prop it needs.
  // Intro 218 + slack.
  'webview/chat/CollabSetupCard.svelte': 250,
  // CollabRosterChip.svelte: ONE chip, out of CollabRoster.svelte (271/290) so
  // the lead star could become a real control. The star is a SIBLING of the
  // chip button — a button inside a button is invalid markup, and clicking it
  // must not also open the context drawer. Intro 156 + slack.
  'webview/chat/CollabRosterChip.svelte': 175,
  // CollabObjectiveRow.svelte: the standing objective, editable in place, out
  // of CollabControls.svelte. It used to draw NOTHING when unset, which left
  // the one state needing the control without one. Intro 120 + slack.
  'webview/chat/CollabObjectiveRow.svelte': 140,
  // collabActions.ts: the board mutations as one factory, out of
  // CollabPane.svelte to pay for the wiring above. Mirrors makeCollabPollLoop —
  // no Svelte in it, so the cap's three values (null/0/N) are provable without
  // a render. CollabPane.svelte shrank 432 -> 433 while gaining all of X2's
  // wiring. Intro 55 + slack.
  'webview/chat/collabActions.ts': 75,
  // W3-L1's Collabs OVERVIEW view (collabRows.ts, CollabsOverviewPane.svelte,
  // CollabOverviewRow.svelte) was REMOVED at W6-L3 (owner ruling): the board
  // rail does not need a second surface for rooms already visible in the
  // Collabs half of the sidebar. No cap entries — the files are gone.
  // --- W3-L2: SUPERVISION + PREVIEW IN THE ROOM (report 2.4 / 2.5 / F8 / F13).
  // Wave 1 put four per-member methods on the engine — stop one agent, redirect
  // one, a verdict on one task, the token-free composer preview — and every one
  // of them landed on files already at their caps (CollabPane 437/440,
  // CollabRoster 275/290, collabManager 292/300). So this slice is eight
  // extractions and one host module, not one line anywhere.
  //
  // collabSupervision.ts: the JUDGEMENTS — which ring a status draws (the new
  // `error` kind), whether a stop has anything to end, what its
  // `{interrupted,dequeued}` answer says, and which task_done row may take a
  // verdict. Pure, so "an agent that was neither is already idle" and "running
  // beats a carried-forward failure" are provable with no DOM. Intro 162 + slack.
  'webview/chat/collabSupervision.ts': 185,
  // collabPreview.ts: the C14 preview's DRIVER — debounce, plus a memo of the
  // last address list so prose costs nothing. Its exposed surface is asserted
  // (draft/reset/stop and nothing else): with no in-flight flag there is no
  // state a send could ever be gated on. Intro 115 + slack.
  'webview/chat/collabPreview.ts': 140,
  // collabDispatch.ts: which host message a composer line becomes, out of
  // CollabPane.svelte to pay for the supervision wiring. `/context` comes back
  // as a REQUEST, not a message, because the drawer is the pane's. Intro 61 + slack.
  'webview/chat/collabDispatch.ts': 90,
  // CollabChipControls.svelte: one chip's Stop + Redirect. Stop is ABSENT on an
  // idle agent rather than disabled — a disabled control says "later", which is
  // not what idle means. Intro 137 + slack.
  'webview/chat/CollabChipControls.svelte': 165,
  // CollabChipError.svelte: the `!` badge + its expanded text, moved WHOLE out
  // of CollabRosterChip.svelte to pay for the controls and the error ring. It
  // draws for archived/removed too, unlike the controls. Intro 58 + slack.
  'webview/chat/CollabChipError.svelte': 80,
  // CollabFailureRow.svelte (F13): the room says a turn failed. Drawn from the
  // STATUSES, never the transcript — a failure is deliberately not appended
  // (runner.ts's drain), so no agent ever reads this. Mirrors
  // CollabWaitingRow.svelte, which sits above it. Intro 60 + slack.
  'webview/chat/CollabFailureRow.svelte': 85,
  // CollabReviewRow.svelte: approve / send-back on a task_done row, via
  // `collab_review`. The reason is asked for BEFORE the call, as TaskBoard's
  // own reopen already does — the engine's refusal would arrive a round trip
  // later, with nothing left on screen to correct. Intro 109 + slack.
  'webview/chat/CollabReviewRow.svelte': 135,
  // CollabPreviewRow.svelte: the "Will wake: …" line. Draws only; the wording is
  // collabPreview.ts's. Renders NOTHING when empty rather than reserving a row,
  // so the composer does not jump as a draft starts. Intro 41 + slack.
  'webview/chat/CollabPreviewRow.svelte': 65,
  // CollabComposer.svelte: the bare InputBar + the preview under it, out of
  // CollabPane.svelte. It observes the draft through a bubbled `input` on its
  // own wrapper rather than a new InputBar prop — the chat composer must not
  // grow a collab-only callback. Intro 136 + slack.
  'webview/chat/CollabComposer.svelte': 165,
  // collabSupervise.ts: the HOST half — the four ext-method leaves AND their
  // dispatch, in one module because collabData (250) and collabManager (300)
  // were both within single figures. collabManager keeps one fall-through line.
  // `collabPreview` alone answers a failure with SILENCE: a red line under a
  // half-typed draft is worse than no preview. Intro 216 + slack.
  'src/dashboard/collabSupervise.ts': 250,
  // --- W4: the BOTS section. SEVEN new files, and not one cap above was raised.
  // Every file that bit was paid for by extraction first, exactly as the ratchet
  // prescribes: collabManager.ts (298/300) shed its four def-CRUD cases to
  // botsManager.ts and came back at 267; collabAgentDef.ts (171/175) shed its
  // serializer to collabAgentSerialize.ts; BoardShell.svelte (188/190) shed its
  // VIEWS table to boardViews.ts and came back at 164; CollabAgentCard.svelte
  // (149/150) shed its facts grid to BotContractFacts.svelte and its text rules
  // to botContractView.ts; CollabAgentForm.svelte (264/280) shed nothing and
  // gained one component tag, because the whole contract editor is
  // BotContractFields.svelte; CollabAgentsPane.svelte (305/380) shed the memory
  // viewer to BotMemoryPanel.svelte. ---
  //
  // botContract.ts: the frontmatter SCALARS that turn an agent definition into a
  // configured bot — read, written, and the omit-at-its-default rule for each.
  // A MIRROR of the engine's vocabulary (packages/engine is not resolvable from
  // this package), so it carries the house obligation a mirror owes: the drift
  // test in botContract.test.ts reads bot.ts itself.
  // W6 took THREE things out and the cap did not move — it went 155 -> 82.
  // `skills:` and `model_prefer:` were stripped on owner ruling (the tool
  // checklist replaced the first, a pinned model the second), and `frontList`
  // went with them: they were its only two consumers. WHICH TOOLS a bot has is
  // a `permission:` BLOCK with its own grammar, so it lives in botTools.ts
  // rather than here. Pure; no fs, no vscode. Intro 155.
  'src/dashboard/botContract.ts': 180,
  // collabAgentSerialize.ts: the WRITE half of the def file format, split out of
  // collabAgentDef.ts. Reading a def answers "what does this file say"; writing
  // one answers "what may this board put back", and the second is the half that
  // keeps growing. Intro 71 + slack.
  'src/dashboard/collabAgentSerialize.ts': 90,
  // botMemoryStore.ts: per-bot memory, read and cleared. Its own fenced leaf
  // rather than a path.join at a call site BECAUSE the clear is destructive and
  // its slug arrives over a webview message — resolveInBotRoot is the whole
  // point, and `configDir` is a required argument so no path here can resolve
  // the developer's real config dir. Intro 156 + slack.
  'src/dashboard/botMemoryStore.ts': 180,
  // botsManager.ts: the Bots section's host half — the four def-CRUD cases moved
  // out of collabManager.ts, plus bot sessions, bot memory and the board-section
  // handshake. Same MESSAGE_TYPES-set + handler shape as collabSupervise.ts,
  // with one difference: it RETURNS whether it took the message, because
  // collabManager's `default:` still has to reach the supervision four.
  // Intro 172 + slack.
  'src/dashboard/botsManager.ts': 200,
  // botSessionStart.ts: what "start a session as this bot" does — create the
  // chat under the bot's NAME, then point its `mode` config option at the SLUG.
  // Its own file because DashboardPanel.ts owns session creation and sits AT
  // its cap; what stays there is one line handing this two closures. Structural
  // deps, not an AcpClient import, so every failure path runs with no extension
  // host. Intro 60 + slack.
  'src/dashboard/botSessionStart.ts': 80,
  // activeSession.ts: which session a host-side request resolves to when the
  // stored `activeSessionId` may name one that was DELETED. Its own file
  // because the rule has two callers on opposite sides of DashboardPanel.ts —
  // the tear-down that creates the corpse, and every pane that reads through
  // it — and fifteen call sites had each been left to remember their own
  // fallback inline. Pure, so the corpse case is a Map literal. Intro 54 + slack.
  'src/dashboard/activeSession.ts': 70,
  // skillsPane.ts: the Skills pane's host half, lifted out of
  // DashboardPanel.ts's message switch (which sat two lines under its cap) so
  // the resolution bug above could be TESTED rather than argued about. Same
  // extMethod seam as pluginsPane.ts / toolsPane.ts; unlike those two it
  // resolves its own session, because the resolution is the thing that broke.
  // Intro 65 + slack.
  'src/dashboard/skillsPane.ts': 85,
  // sessionAnnounce.ts: WHEN a new session may be shown. One rule — a session
  // the engine can legitimately refuse (a chat created as a bot) is announced
  // only after it is accepted — and it is a rule rather than a line of
  // createSession because "a refused start announced nothing" is exactly the
  // claim a test has to make. Pure, no extension host. Intro 47 + slack.
  'src/dashboard/sessionAnnounce.ts': 65,
  // viewWiring.ts: attachView's per-webview wiring, extracted from
  // DashboardPanel (at cap). Owns the doubled-send guard: a re-resolved
  // sidebar view re-attaches the same webview, and without teardown-first it
  // sat in extraViews twice — two prompts and two echoes per click.
  'src/dashboard/viewWiring.ts': 55,
  // boardViews.ts: the board rail's TABLE, extracted from BoardShell.svelte.
  // A .ts and not markup because `isViewId` and `viewForSection` are RULES over
  // it — a saved id whose view was deleted must degrade to Folds rather than to
  // a blank body — and a rule earns a test without rendering ten panes.
  // Intro 85 + slack.
  'webview/dashboard/panes/boardViews.ts': 105,
  // botContractView.ts: what a bot CARD and the bot FORM say about a contract.
  // Pure, and its own module because the interesting cases are the ones a
  // screenshot cannot show: "an unstated tier is not `open`", "a def with no
  // permission block is not a bot with no tools". W6 took two functions out of
  // it (skills, model preference, both keys stripped) and put two back — the
  // tool summary, and the editor's model hint, which moved here from
  // CollabAgentForm.svelte so the card and the form cannot drift into
  // disagreeing about what an unpinned def does. Intro 143 + slack.
  'webview/dashboard/components/botContractView.ts': 170,
  // botTools.ts (W6): WHICH TOOLS a bot has — the tool universe mirrored off the
  // engine registry, the gate model (`edit`/`write`/`apply_patch` are ONE
  // permission key, so they are one checkbox), the Worker/Observer tick sets,
  // and the `permission:` block a tick set becomes and comes back from. Its own
  // module and not part of botContract.ts because that file is about
  // frontmatter SCALARS and this is about a block with its own grammar — and
  // because the mirror needs a drift guard of its own (botTools.test.ts reads
  // packages/engine/src/tool/*.ts). Intro 177 + slack.
  'src/dashboard/botTools.ts': 200,
  // BotContractFacts.svelte: the facts grid of a bot card. One component and not
  // six rows, because they are read together — the question a card answers is
  // "is this bot ready to work", and that is the whole row. Intro 91 + slack.
  'webview/dashboard/components/BotContractFacts.svelte': 115,
  // BotContractFields.svelte: the permissions + memory half of the def editor.
  // W6 rebuilt it — the tier row, the block row, the skills allowlist and the
  // model-preference chain came out, and two preset buttons plus A CHECKBOX PER
  // TOOL went in. It stayed under the cap through the swap, so the cap did NOT
  // move: 320 is still the ceiling, and the file is at 247. Intro 287.
  'webview/dashboard/components/BotContractFields.svelte': 320,
  // BotMemoryPanel.svelte: one bot's own store, READ ONLY — a bot's memory is
  // written by the bot, and the only edit this board offers is the whole-store
  // wipe. Extracted from CollabAgentsPane.svelte, which the panel pushed to
  // 389 of its 380 cap. Intro 57 + slack.
  'webview/dashboard/components/BotMemoryPanel.svelte': 75,
};

// Five themes ship with this board, two of them dark. A literal colour in a
// pane is invisible in at least one of them, and the failure mode is silent —
// it only shows up when a user switches theme. So the Wave 4a views are held
// to theme vars ONLY (the coder_mockup.html these were drawn from is
// hard-coded cream/ink; the SHAPE was taken from it, never the palette).
const THEMED_FILES = [
  'webview/dashboard/components/labyrinthLayout.ts',
  'webview/dashboard/components/labyrinthLanes.ts',
  'webview/dashboard/components/labyrinthFormat.ts',
  'webview/dashboard/components/labyrinthBranches.ts',
  'webview/dashboard/components/labyrinthFlight.ts',
  'webview/dashboard/components/labyrinthMinimap.ts',
  'webview/dashboard/components/LabyrinthMinimap.svelte',
  'webview/dashboard/components/labyrinthMarks.ts',
  'webview/dashboard/components/labyrinthCaptions.ts',
  'webview/dashboard/components/labyrinthCollide.ts',
  // The 0.4.45 batch. The two .svelte ones carry real colour — the toolbar owns
  // the Fit/Inspector ACTIVE state, where a literal would make "this is on"
  // invisible in whichever of the five themes it clashes with. The .ts leaves
  // are colour-free and opted in anyway: every other Labyrinth module is, and a
  // complete list is what stops the next colour landing in the one file nobody
  // added.
  'webview/dashboard/components/labyrinthThreadFit.ts',
  'webview/dashboard/components/labyrinthSearch.ts',
  'webview/dashboard/components/labyrinthFlightFrame.ts',
  'webview/dashboard/components/LabyrinthFlightLabels.svelte',
  'webview/dashboard/components/LabyrinthMapToolbar.svelte',
  'webview/dashboard/components/LabyrinthRunSearch.svelte',
  // labyrinthHtml.ts IS covered, deliberately: the exported page's CSS is
  // written in `var(--og-*)` terms and handed to labyrinthExport.ts's resolver,
  // so the concrete values still come only from the running document and this
  // file is held to the same "no literal colour" rule as the views.
  'webview/dashboard/components/labyrinthHtml.ts',
  // ...and so is labyrinthReport.ts, for the same reason: its selection and
  // filter rules ride the SAME resolver pass, so a literal here would be a
  // colour the exported page never got from the theme it was drawn under.
  'webview/dashboard/components/labyrinthReport.ts',
  // ...and every module the ATLAS export was split into, for the same reason.
  // labyrinthTone.ts is the sharpest of them: it is a colour table outright, so
  // one literal there is a filter swatch that disagrees with the marker it names
  // in whichever of the five themes the literal happens to clash with.
  'webview/dashboard/components/labyrinthAtlas.ts',
  'webview/dashboard/components/labyrinthAtlasCss.ts',
  'webview/dashboard/components/labyrinthStrip.ts',
  'webview/dashboard/components/labyrinthLedger.ts',
  'webview/dashboard/components/labyrinthTone.ts',
  'webview/dashboard/components/LabyrinthRunIndex.svelte',
  // LabyrinthDivider.svelte (t-q41pe0): its hover/focus state is carried in
  // colour alone (the hairline switching from --og-border to --og-accent, the
  // focus ring from --og-chat), so a literal here is a "you can grab this"
  // affordance that goes invisible in whichever of the five themes it clashes with.
  'webview/dashboard/components/LabyrinthDivider.svelte',
  'webview/dashboard/components/labyrinthDetail.ts',
  'webview/dashboard/components/labyrinthUsage.ts',
  'webview/dashboard/components/LabyrinthUsageStrip.svelte',
  // ...and every module the real-cost headline and the price panel split it
  // into. The two .svelte ones carry real colour and are the sharpest cases on
  // the strip: the headline's APPROXIMATE tone is what says a total is a floor,
  // and the models row's switch marker is what says the run's cost cannot be
  // read off one model's rates. LabyrinthPrices.svelte is a surface with its
  // own border and inputs — a literal there is a panel that fights the theme
  // behind it. The .ts leaves are colour-free and opted in anyway, on the same
  // rule as the rest of the Labyrinth: a complete list is what stops the next
  // colour landing in the one file nobody added.
  'webview/dashboard/components/labyrinthCost.ts',
  'webview/dashboard/components/labyrinthExportMap.ts',
  'webview/dashboard/components/LabyrinthSpendHeadline.svelte',
  'webview/dashboard/components/LabyrinthSpendModels.svelte',
  'webview/dashboard/components/LabyrinthPrices.svelte',
  // ...and the collab member rows extracted out of the run index, which took
  // the picked-row border with them: which run is open is carried by
  // --og-accent alone, so a literal there is a selection that goes invisible.
  'webview/dashboard/components/LabyrinthCollabRows.svelte',
  // ...and the run index's cache-health column, which is the sharpest new case
  // on that panel: a session below the healthy share is marked in --og-warning,
  // so a literal there is a cold cache that reads as fine in whichever of the
  // five themes it clashes with. Its canvas sibling joins on the weaker rule —
  // it owns the map's scrolling box, and a literal in it is a surface that
  // fights the pane behind it.
  'webview/dashboard/components/labyrinthHealth.ts',
  // ...and the 0.4.51 UAT batch. LabyrinthBreaks.svelte is the sharpest of them:
  // a model break is a MUTED rule, and its whole design is that it reads as a
  // boundary without competing with the threshold bars and branch rails it
  // crosses — a literal there is a divider that either vanishes or shouts,
  // depending on which of the five themes it lands in. LabyrinthInspectColumn
  // carries the column's own border seam. The .ts leaves are colour-free and
  // opted in anyway, on the same rule as the rest of the Labyrinth.
  'webview/dashboard/components/labyrinthBreaks.ts',
  'webview/dashboard/components/LabyrinthBreaks.svelte',
  'webview/dashboard/components/labyrinthHighlight.ts',
  'webview/dashboard/components/labyrinthNav.ts',
  'webview/dashboard/components/LabyrinthInspectColumn.svelte',
  'webview/dashboard/components/LabyrinthMapCanvas.svelte',
  'webview/dashboard/components/LabyrinthNotices.svelte',
  'webview/dashboard/components/labyrinthSpans.ts',
  'webview/dashboard/components/labyrinthRails.ts',
  'webview/dashboard/components/labyrinthSwim.ts',
  'webview/dashboard/components/LabyrinthSwimLane.svelte',
  'webview/dashboard/components/labyrinthTime.ts',
  'webview/dashboard/components/labyrinthNotice.ts',
  'webview/dashboard/components/LabyrinthMap.svelte',
  'webview/dashboard/components/LabyrinthRail.svelte',
  'webview/dashboard/components/LabyrinthNode.svelte',
  'webview/dashboard/components/LabyrinthGlyph.svelte',
  'webview/dashboard/components/LabyrinthInspector.svelte',
  'webview/dashboard/panes/LabyrinthPane.svelte',
  'webview/dashboard/panes/InstructionsPane.svelte',
  // The Tools view joins on the same rule as its Insights sibling: a row's
  // LOADED/DEFERRED badge and the code-mode switch's ON state are carried
  // partly in colour, so a literal there is a deferred tool reading as loaded
  // in whichever of the five themes the literal clashes with.
  'webview/dashboard/panes/ToolsPane.svelte',
  // ...and the CARD the pane's rows became (t-kgtaac round 3), which took both
  // of those with it: the loaded/deferred badge AND the load/unload switch's ON
  // state. The switch is the sharper of the two — a literal there is a deferred
  // tool whose toggle reads as loaded in whichever of the five themes it
  // clashes with, on the one control whose whole job is saying which it is.
  'webview/dashboard/panes/ToolCard.svelte',
  // ...and the FAILED-load card, which is the strongest case on the view: the
  // whole card is an error TONE — border, fill and heading — and that tone is
  // what makes a broken tool file impossible to mistake for a working tool. A
  // literal there is that warning going flat, or clashing, in whichever of the
  // five themes it lands wrong in. (The tone is not the only signal — the card
  // also says "tool file not loaded" in words — but it is the one that carries
  // at a glance, which is the entire reason the card replaced a text line.)
  'webview/dashboard/panes/ToolProblemCards.svelte',
  // ...and the prose extracted beside it, on the weaker but real version of the
  // rule: the note is a surface with its own border and a --og-warning seam
  // down its edge, so a literal in either is a panel that fights the theme
  // behind it, or a seam that stops reading as "mind this".
  'webview/dashboard/panes/ToolsNotes.svelte',
  // ...and the CONTROL those two states became three in, which is now the
  // sharpest case on the view: the segmented switch says which state is set
  // with a fill colour per segment, so a literal there is a tool reading as
  // Loaded when it is Off — on the one control whose only job is saying which.
  'webview/dashboard/panes/ToolStateSwitch.svelte',
  // ...and the create box beside it, on the weaker but real version of the same
  // rule: its disabled-button state and dashed border are drawn from the same
  // vars, so a literal there is a "you cannot press this yet" that disappears.
  'webview/dashboard/panes/NewToolPanel.svelte',
  // ...and the ROW component the pane's rows were extracted into (wave R2x),
  // which is where the badges went with them: a badge carries a prompt's SOURCE
  // in colour alone, so a literal there is a global instruction reading as a
  // project one in whichever of the five themes the literal clashes with.
  'webview/dashboard/components/InstructionRow.svelte',
  // The Collab agents view joins on the same rule as Loops and Crons: its card
  // carries the WORKER/OBSERVER preset — whether that agent may edit files and
  // run commands — partly in colour, so a literal there is a permission level
  // that mis-reads in whichever of the five themes it clashes with.
  'webview/dashboard/panes/CollabAgentsPane.svelte',
  'webview/dashboard/components/CollabAgentCard.svelte',
  // ...and the FORM extracted out of that pane (t-kgtr6c), which took the
  // Worker/Observer picked-state with it: which preset is selected is carried
  // by border + fill colour alone, so a literal there is a permission choice
  // that goes invisible in whichever of the five themes it clashes with.
  'webview/dashboard/components/CollabAgentForm.svelte',
  // ...and the two leaves the BOTS section split that card and form into (W4),
  // which took the same rule with them and sharpened it. BotContractFacts draws
  // the difference between a value the def CHOSE and one it never stated in
  // colour alone (the muted `.unset` tone), plus the warning tone for a
  // permission tier the engine cannot read — so a literal there is an
  // unconfigured bot reading as a set-up one, or a broken tier reading as fine,
  // in whichever of the five themes it clashes with. BotContractFields carries
  // which tier is PICKED in border and fill alone, the same way the Worker/
  // Observer row it absorbed always did.
  'webview/dashboard/components/BotContractFacts.svelte',
  'webview/dashboard/components/BotContractFields.svelte',
  // ...and the memory panel beside them, on the weaker but real version of the
  // rule: it is a surface with its own border, background and muted body text,
  // and a literal in any of the three is a panel that vanishes into — or fights
  // with — the pane behind it in at least one theme.
  'webview/dashboard/components/BotMemoryPanel.svelte',
  // DELIBERATELY ABSENT: ApprovePopover.svelte and VisionProfileMenu.svelte.
  // Both carry the composer's drop shadow — `rgba(0,0,0,0.28)`, moved verbatim
  // out of InputBar.svelte, which is not a themed file either. A shadow is
  // opacity over whatever is behind it, not a themed surface, and inventing a
  // token for it in two files would make them disagree with the other popovers
  // in that same row. Every other colour in both is an --og-* var.
  // ...and the glyph picker extracted out of that pane (M4.4), which took the
  // form's picked-state styling with it: which glyph is selected is carried by
  // border + fill colour alone, so a literal there is a selection that goes
  // invisible in whichever of the five themes it clashes with.
  'webview/dashboard/components/CollabGlyphPicker.svelte',
  // ...and the archetype reference card (D7) beside it: the managed chip
  // carries the same warning tone, so a literal there is a chip that goes
  // unreadable in whichever of the five themes it clashes with.
  'webview/dashboard/components/ArchetypeAgentCard.svelte',
  // ...and the capture section mounted inside it, for the same reason: its
  // part badges carry the SOURCE of a prompt block in colour, so a literal here
  // is a base-prompt row that reads as an instructions row in whichever theme
  // the literal clashes with.
  'webview/dashboard/components/PromptCaptureSection.svelte',
  // CronsPane joins the same rule: it leans on the warning/error tone vars for
  // its unattended-execution statement and its drift report, and a literal
  // there would be an unreadable banner in at least one of the five themes —
  // on the one surface whose whole job is telling you something is wrong.
  'webview/dashboard/panes/CronsPane.svelte',
  // ...and everything the Crons view was split INTO, for the same reason. The
  // status DOT is the sharpest case in the whole board: it carries meaning in
  // colour alone, so a literal here would be a row silently mis-reading its own
  // state in whichever theme the literal happens to clash with.
  'webview/dashboard/components/CronTable.svelte',
  'webview/dashboard/components/CronForm.svelte',
  // ...and the run-target row split out of that form, which took the warning
  // tone with it: the "no model pinned" banner is the only thing standing
  // between the user and an unattended job on an unknown model, so a literal
  // there is that warning going unreadable in whichever theme it clashes with.
  'webview/dashboard/components/CronRunTarget.svelte',
  'webview/dashboard/components/CronRowDetail.svelte',
  'webview/dashboard/panes/cronFormat.ts',
  // The Loops view joins too, now that it carries the same tone-coded surfaces:
  // a warning banner for the "a persistent loop still dies with VS Code" limit,
  // and a per-row accent for persistent-vs-plain. Its hex FALLBACKS were dropped
  // in the same pass — every var it names is defined in all five themes, so a
  // fallback only ever hid a missing one.
  'webview/dashboard/panes/LoopsPane.svelte',
  'webview/dashboard/components/LoopCard.svelte',
  // ...and the head row extracted out of it, which took the card's tone-coded
  // controls with it (the reopen button's accent hover, the cancel button's
  // error one) — the same rule, now living one file down.
  'webview/dashboard/components/LoopCardHead.svelte',
  // The persistence switch is the sharpest case on this view for the same
  // reason the cron status dot is on the other: its ON state is carried partly
  // by the track's colour, so a literal here is a switch that reads as OFF in
  // whichever theme the literal clashes with.
  'webview/dashboard/components/PersistSwitch.svelte',
  // The MCP view joins on the sharpest version of the rule the cron status dot
  // set: its status pill carries connected / failed / needs-auth in colour
  // alone, and the remove button's DANGER state is colour-only too — a literal
  // in either is a dead server reading as live, or a destructive button reading
  // as an ordinary one, in whichever of the five themes the literal clashes with.
  'webview/dashboard/panes/MCPPane.svelte',
  // ...and the add box extracted out of it, which took the pane's dashed
  // surface and its WARNING tone with it: the "name already taken" and
  // "line 2 has no =" refusals are the only thing standing between the user
  // and a server written without the credential it needs, so a literal there
  // is a refusal that goes unreadable in whichever of the five themes it
  // clashes with. It carries no drop shadow, so unlike the composer popovers
  // it has no reason to be exempt.
  'webview/dashboard/components/MCPAddForm.svelte',
];
// NOT added: webview/dashboard/components/ModeControl.svelte, on the ChatsList
// precedent below. Its trigger genuinely carries state in colour alone (Plan
// green, Deep Plan gold, Build neutral) and every one of those values IS an
// --og-* token — but the panel's drop shadow is `rgba(0, 0, 0, 0.28)`, moved
// verbatim from InputBar's `.effort-pop` and ApprovePopover's `.approve-pop`.
// A shadow is opacity over whatever is behind it rather than a themed surface,
// there is no --og-* shadow var in this codebase, and a fifth composer popover
// that alone had no shadow would read as a bug. Opting the file in would fail
// on that one deliberate literal, so ModeControl.test.ts carries its own regex
// proof that every COLOUR in the file is a var(--og-*) instead.
// NOT added: webview/chat/ChatsList.svelte. Its ring genuinely carries state
// in colour alone (working/ready/waiting), but the file's mask CSS already
// used two literal `#fff` stops before this change (`-webkit-mask: linear-
// gradient(#fff 0 0)...` — full alpha for the mask stencil, not a themed
// colour: only the alpha channel is read there, so a var would be pointless
// and #fff is the correct, permanent value). Opting the file in would fail on
// that pre-existing, unrelated literal; every *value this task added* is
// itself var(--og-*)-only — see ChatsList.test.ts's own regex proof instead.
// DELIBERATELY absent: labyrinthExport.ts. It is the one Labyrinth module whose
// JOB is to turn theme vars INTO concrete values for a file that will be opened
// outside the webview, where no --og-* exists — so "no literal colour" is the
// wrong rule for it. It happens to contain none either way; every value it
// writes is read out of the running document at export time.

describe('theme discipline — the Wave 4a board views use theme vars only', () => {
  for (const rel of THEMED_FILES) {
    it(`${rel} contains no literal colour`, () => {
      const src = readFileSync(path.join(pkgRoot, rel), 'utf8');
      const literals = [
        ...src.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
        ...src.matchAll(/\brgba?\(/g),
        ...src.matchAll(/\bhsla?\(/g),
      ].map((m) => m[0]);
      expect(literals, `${rel} hard-codes ${literals.join(', ')} — use an --og-* var instead.`).toEqual([]);
    });
  }
});

describe('architecture line caps', () => {
  for (const [rel, cap] of Object.entries(CAPS)) {
    it(`${rel} stays under ${cap} lines`, () => {
      const lines = readFileSync(path.join(pkgRoot, rel), 'utf8').split('\n').length;
      expect(
        lines,
        `${rel} is ${lines} lines (cap ${cap}). Extract a module instead of raising the cap.`,
      ).toBeLessThanOrEqual(cap);
    });
  }
});
