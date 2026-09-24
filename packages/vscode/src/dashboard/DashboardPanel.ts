// Dashboard webview panel — singleton. Hosts the Svelte dashboard. Each ACP
// chat session is a tab within the chat pane, not a separate VS Code panel.

import * as vscode from 'vscode';
import { AcpClient, type AcpEventHandlers, type ContextComposition, resolveOrigamiBinary } from '../acpClient';
import { questionAnswers, type QuestionAnswer } from '../questionBatch';
import { execFile } from 'node:child_process';
import { findWorkspacePath, readSettings, readWorkspaceData, readWikiPagesFromDir, resolveDefaultWikiPages, readAgentArt, displayAgentName } from '../workspace/WorkspaceReader';
import type { StatusBarController } from '../statusBar/StatusBarController';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { runFirstFold, writeModelConfig, persistModelPick, resolveModelPickProviderName, writeModelContextLimit, shouldReloadLocalModel, removeProviderConfig, renameProviderConfig, detectLocalProvider, isLoopbackBaseUrl, detectModel, listConfiguredModels, readModelVision, writeModelVision, readAgentFrequencyPenalty, writeAgentFrequencyPenalty, readGlobalProviders, agentsMdTemplate, needsFirstFold, type FirstFoldEmit, type ModelChoice, type ConfiguredProvider } from './firstFold';
import { isSelfHostedBaseUrl } from './selfHosted';
import { claudeSubscriptionEnabled } from '../claudeSubscriptionFlag';
import { claudeSubscriptionModelRows, claudeSubscriptionPickRefusal, mergeClaudeSubscriptionRows, isClaudeSubscriptionModel, CLAUDE_SUBSCRIPTION_PROVIDER } from '../claudeSubscription/models';
import { readinessFromCli } from '../claudeSubscription/readiness';
import { fetchClaudeSubscriptionReadiness } from '../claudeSubscription/engineStatus';
import { CLAUDE_SUBSCRIPTION_CARD_MESSAGE_TYPES, handleClaudeSubscriptionCardMessage } from './claudeSubscriptionCard';
import { resolveCardPath } from './revealPath';
// The self-hosted HTTP probes live in localProbe.ts; each takes an optional apiKey.
import { fetchModelInfo, fetchModelWindowFor, fetchLmStudioModels, detectLocalFlavor, primaryLocalApiKey, type ModelInfo } from './localProbe';
import { contextLimitWarner } from './contextLimitWarning';
import { detectVision, fetchVisionProbe, type VisionMap } from './visionDetect';
import { applyVisionPin, readVisionPin, splitModel, visionStateFor, visionStatesFor, visionWrites, type VisionState } from './visionPin';
import { mergeLiveModels } from './liveModelMerge';
import { GatewayEntitledCache } from './gatewayEntitledCache';
import { MODEL_LIST_REFRESH_MESSAGE_TYPES, createModelListRefresh } from './modelListRefresh';
import { probeConcurrently, PROVIDER_PROBE_TIMEOUT_MS } from './providerProbe'; import { readOauthIds } from './oauthIdsRead'; import { remoteLiveness } from './remoteLiveness'; // panel is at its cap; implementations stay in leaves
import { setupProvider } from './setupProvider';
import {
  refreshEngineProviders,
  refreshingChangeWriter,
  refreshingWriter,
  type RefreshTarget,
} from './providerRefresh';
import { createModelRefreshGate } from './modelRefreshGate';
import { ModelOpGuard, withDeadline, MODEL_SWITCH_DEADLINE_MS } from './modelOps';
import { KEY_ONLY_PRESETS, checkProviderKey, fetchCatalogIds, pickDefaultModel } from './keyOnlyPresets';
import { readSpend, accrueSessionSpend, readBudget, writeBudget, isOverBudget, budgetBlocks, accrueSessionSpendUnlessOAuth } from './spend';
import { PermissionBannerState, permBannerCopy } from './permissionBanner';
import { engineSpawnStaleNotice } from './engineStale';
import { agentBoundary, collectAgentTextSince, parseLoopCommand, buildScheduledRunPrompt, formatInterval, parseLoopDone, buildComposePrompt } from './chatCommands';
import { collectLoopSchedules, toNeedsAttentionLoops, type LoopOutcome, type LoopScheduleInfo, type NeedsAttentionLoop } from './loopSchedules';
import { runStepsPayload, instructionsPayload } from './boardData';
import { runStatsPayload, statIds } from './runStats';
import { subagentTranscriptPayload } from './subagentTranscript';
import { buildSessionModelStatus } from './sessionModelStatus';
import { collabSessionMarks, collabStepsPayload } from './collabSteps';
import { historyRows, openTabFor } from './historyRows';
import { promptCapturePayload, promptCaptureForSession } from './promptCapture';
import { cacheStatsPayload } from './cacheStats';
import { peerLogEntry } from './peerMessages';
import { archiveLog, logStreamDrop, logSubagentTokens, logToolCall, logToolResult, type SessionMessage } from './sessionLog'; import { settleSubagent } from './subagentSettle';
import { noteSubagentDismissed, readSubagentDismissed } from './subagentDismissed';
import { stampToolImages } from './toolImageStamp'; import { chatResourceRoots, desktopImageSrc, webviewImageSrc } from './toolImageUri';
import { ensureBrowserToolsConsent } from '../browserToolsConsent';
import { broadcastBrowserAutoApprove, setBrowserAutoApprove } from './browserAutoApproveControl';
import {
  broadcastBrowserViewport,
  setBrowserOpenBeside,
  setBrowserReveal,
  setBrowserViewport,
} from './browserViewportControl';
import { AgentManager, type ManagerHost } from './agentManager/manager';
import { makeBaseUri } from './agentManager/diffProvider';
import { openRaceCompareTab, type RaceCompareParams } from './agentManager/compareTab';
import { openRepoMapTab, type RepoMapParams } from './agentManager/mapTab';
import { openCollabTab, setCollabTabWaiting, type CollabTabParams } from './agentManager/collabTab';
import { collabNeedsUser, type CollabAttentionState } from './collabAttention';
import { ensureCollabAgents } from './agentManager/collabAgents';
import { COLLAB_MESSAGE_TYPES, COLLAB_ORDER_KEY, handleCollabMessage, type CollabManagerHost } from './collabManager';
import { startBotSession } from './botSessionStart';
import { saveCollabMarkdown } from './collabExportFile';
import { stopCollabWatch } from './collabWatch';
import { applyVisionProfile } from './visionProfile';
import { TOOLS_PANE_MESSAGE_TYPES, handleToolsPaneMessage } from './toolsPane';
import { SKILLS_PANE_MESSAGE_TYPES, handleSkillsPaneMessage } from './skillsPane'; import { HOST_ENGINE_MESSAGE_TYPES, hostEngine } from './hostEngineWindow'; // t-sh7cog: host features read the engine with no chat open
import { commandSeedMessages, type SeededCommand } from './sessionCommandSeed';
import { SECOND_OPINION_MESSAGE_TYPES, handleSecondOpinionMessage } from './secondOpinion';
import { liveActiveSessionId } from './activeSession';
import { configSelectorMessages, allConfigSelectorMessages } from './configSelectors';
import { startThenAnnounce } from './sessionAnnounce';
import { EngineGate, forkRetryRefusal, routeTurnMessage } from './engineGate';
import { rewireView } from './viewWiring';
import { DeltaFanout } from './deltaFanout';
import { PLUGINS_PANE_MESSAGE_TYPES, handlePluginsPaneMessage } from './pluginsPane';
import { ARTIFACTS_PANE_MESSAGE_TYPES, handleArtifactsPaneMessage } from './artifactsPane';
import { openArtifactUrl } from '../artifactsOpen';
import { autoOpenArtifact } from './artifactAutoOpen';
import { LABYRINTH_PRICES_MESSAGE_TYPES, LABYRINTH_PRICES_KEY, handleLabyrinthPricesMessage } from './labyrinthPrices'; import { SESSION_DELETE_MESSAGE_TYPES, handleSessionDeleteMessage } from './sessionDelete'; import { COLLABS_SECTION_MESSAGE_TYPES, handleCollabsSectionMessage } from './collabsSection'; import { FORK_CHAT_MESSAGE_TYPES, forkChat, sessionLabel, startSystemLine, type ForkHost } from './sessionFork'; import { boundCell } from './claudeCodeCells'; import { makeSessionStatusHandler } from './sessionStatusRoute'; import { postApproveModeFailure } from './approveModeFailure'; import { CHAT_BACKDROP_MESSAGE_TYPES, chatBackdropEnabled, handleChatBackdropMessage } from './chatBackdropSetting'; import { CHAT_DENSITY_MESSAGE_TYPES, chatDensityCompact, handleChatDensityMessage } from './chatDensity'; import { SCHEDULE_TAB_MESSAGE_TYPES, scheduleTab, handleScheduleTabMessage } from './scheduleTab'; // panel is at its cap; implementations stay in leaves
import { MCP_PANE_MESSAGE_TYPES, handleMcpPaneMessage } from './mcpPane'; import { WEBMCP_PANE_MESSAGE_TYPES, handleWebMcpPaneMessage } from './webmcpPane'; import { FLOCK_PANE_MESSAGE_TYPES, handleFlockPaneMessage } from './flockPane'; import { flockMailboxPush } from './flockMailbox'; import { flockEnabled } from '../flockEnabled'; import { REMOTE_PANE_MESSAGE_TYPES, handleRemotePaneMessage } from './remotePane'; import { SUBAGENT_LIMIT_MESSAGE_TYPES, handleSubagentLimitMessage } from './subagentLimitPane'; import { CACHE_WARMING_MESSAGE_TYPES, handleCacheWarmingMessage } from './cacheWarmingPane'; import { STORAGE_PANE_MESSAGE_TYPES, handleStorageMessage } from './storagePane'; import { SIDE_QUESTS_MESSAGE_TYPES, handleSideQuestMessage, stopSideQuestWatchers } from './sideQuestsPane'; import { saveSideQuestFile } from './sideQuestExport'; import { sideQuestsEnabled } from '../sideQuestsFlag'; import { notifyQuestionWaiting, notifyOnPost } from '../notify/notifyEvents'; import { REPO_PICKER_MESSAGE_TYPES, handleRepoPickerMessage } from './repoPicker'; import { NEST_SIDEBAR_MESSAGE_TYPES, handleNestSidebarMessage } from './nestSidebar'; import { nestHub } from './nestHubWindow'; // panel is at its cap; implementations stay in leaves
import { modelStatusReason, parseModelRef } from './modelStatusReason';
import { PROVIDER_AUTH_MESSAGE_TYPES, handleProviderAuthMessage, openExternalUrl, offerReload, oauthConnectedIds } from './providerAuthPane';
import { PROVIDER_USAGE_MESSAGE_TYPES, handleProviderUsageMessage } from './providerUsage';
import { WORKTREE_STATE_MESSAGE_TYPES, handleWorktreeStateMessage } from './worktreeState';
import { pricedTokens, rememberChildModel } from './subagentCost';
import { pushContextReading, trendField } from './contextTrend';
import { GLIDEPATH_MESSAGE_TYPES, handleGlidepathMessage, startUsageSampling, glidepathHost } from './usageHistoryHost'; // Labyrinth Glidepath: schedule in usageHistory.ts, real deps in usageHistoryHost.ts
import { validateMap } from './agentManager/mapSchema';
import { loadKnownRepos, saveKnownRepos, pickRepoFolder, loadAutoApprove, saveAutoApprove, loadAgentTypes, saveAgentTypes } from './agentManager/registry';
import { modesFromOption } from './agentManager/agentTypes';
import { syncRegistry } from './agentManager/repoRemovals';
import { activityLine } from './agentManager/tickets';
import { decideAgentPermission } from './agentManager/permScope';
import { isSessionMounted, boardAggregate, aggregateText, questionPreview, resolvePermission, drainPermissions, releaseBypassedPermissions } from './agentManager/attention';
import { applyTabIcon, waitingTitleFor } from './tabIcon';
import { shouldBufferQuestion, questionReplayAction, type BufferedQuestionPerm } from './agentManager/questionRouting';
import { engineSessionId } from './engineSessionId'; import { parseImageDataUrls } from './imageDataUrls';
import { openPermissionPreview } from './agentManager/permissionPreview'; import { permissionCommand } from './agentManager/permissionCommand'; import { TURN_MESSAGE_TYPES, handleTurnMessage } from './turnMessages'; import { postPeerName } from './peerNamePost'; import { CLAUDE_CODE_RESUME_KEY, claudeCli, claudeCodeKind, claudeCodeModelOf, claudeCodeOwns, handleClaudeCodeMessage, isEngineEchoOnBoundCell, refreshAllPlanUsage } from './claudeCodeManager'; import { claudeCodeModelRows } from '../claudeCode/models'; import { nodePlanUsageDeps } from '../claudeCode/planUsage'; import { noteTodoSnapshot, replaySessionTo, type TodoSnapshot } from './replaySession'; import { isRemoteWebview } from '../remote/phoneView'; import { remoteAcceptsZ } from '../remote/phoneCaps'; import { remoteCursor } from '../remote/remoteDelta'; import { scanClaudeHistoryReport } from './claudeHistory'; import { claudeStepsPayload, isClaudeRunId } from './claudeLabyrinth'; // panel is at its cap; implementations stay in leaves
import { permissionTarget, replayDecision, notePersistablePermission, commitPersistablePermission, loadPersistentPermissions } from './agentManager/persistentPermissions';
import { loadOpenSet, saveOpenSet, restoreOpenSet, type OpenSetState } from './agentManager/sessionRestore';
import { rankEntries } from './agentManager/sessionOrder';
import { loadPersistedLoops, savePersistedLoop, removePersistedLoop, splitPersistedLoops, armRestoredLoops, isPersistent, setPersistedLoopPersistence, type PersistedLoop } from './agentManager/loopPersistence';
import { planLoopReopen, reopenLoopChat } from './agentManager/loopReopen';
import { loadChatSections, saveChatSections, pruneChatSections } from './chatSections';
import { recordSpawn } from './runningChildren';
import { adoptRoster, adoptWindow, historyStatePost, historyUnavailable, loadHistory, logAgentChunk, logUserChunk, messageCountOf, newHistory, noteRosterChild, searchHistory, settleRestore, untilOf, HISTORY_MESSAGE_TYPES, type HostHistory } from './historyHost'; // t-ucnp7t lazy loading, host half
import { makeSubagentTodoPuller, saysTodoWrite } from './subagentTodos'; // a CHILD's todowrite never reaches the wire as a tool call — subagentTodos.ts
import { subagentTodosPayload } from './subagentTodosPayload'; // t-qd2riw — bounded engine lookup, extracted to keep subagentTodos.ts under its cap
import { subagentChangesPayload } from './subagentChangesPayload'; // t-ru0by6 — bounded engine lookup, same shape as subagentTodosPayload
import { makeSubagentChangesPuller, saysEditTool } from './subagentChanges'; // t-j3qxbp — same problem, for the changed-files pill
import { CHAT_SECTION_MESSAGE_TYPES, handleChatSectionMessage, type ChatSectionsManagerHost } from './chatSectionsManager';
import { CronService } from './crons/cronService';
import { defaultBackend } from './crons/schedulerBackend';
import { cronLogPath, cronLogRelPath } from './crons/cronCommand';

/** Module-level ref so DashboardPanel can update the status bar. */
let statusBarRef: StatusBarController | undefined;

const SESSIONS_DIR = path.join(os.homedir(), '.origami', 'sessions');

/** A read-image card's `<img src>` for ONE attached view (t-fdw2j2): the
 *  phone's webview shim has no `localResourceRoots` at all, so it must stay
 *  on plain `webviewImageSrc` (always undefined for it) and take its own
 *  thumbnail path in `RemoteView.postMessage` — routing it through
 *  `desktopImageSrc` would read the file off disk and stamp a full `data:`
 *  URI onto every phone frame instead. A real tab or the sidebar gets the
 *  desktop fallback: the resource URI when the file is under a root, else
 *  the host's own capped copy of the bytes. */
function imageSrcFor(webview: vscode.Webview, facts: Parameters<typeof desktopImageSrc>[1]): string | undefined {
  return isRemoteWebview(webview) ? webviewImageSrc(webview, facts) : desktopImageSrc(webview, facts);
}

/** Read profiling mode + VRAM headroom from settings.toml; safe defaults when the
 *  file is absent. Must match `Settings::effective_vram_headroom_mb()` on the Rust side. */
function readProfilingModeFromDisk(): {
  mode: 'normal' | 'game';
  configuredGb: number;
  effectiveGb: number;
} {
  const settingsPath = path.join(os.homedir(), '.origami', 'settings.toml');
  let mode: 'normal' | 'game' = 'normal';
  let configuredMb = 8192;
  try {
    if (fs.existsSync(settingsPath)) {
      const content = fs.readFileSync(settingsPath, 'utf-8');
      const modeMatch = content.match(/^profiling_mode\s*=\s*"(normal|game)"/m);
      if (modeMatch) mode = modeMatch[1] as 'normal' | 'game';
      const headroomMatch = content.match(/^vram_headroom_mb\s*=\s*(\d+)/m);
      if (headroomMatch) configuredMb = parseInt(headroomMatch[1], 10);
    }
  } catch {
  }
  const NORMAL_MB = 1024;
  const effectiveMb = mode === 'normal' ? NORMAL_MB : Math.max(configuredMb, NORMAL_MB);
  return {
    mode,
    configuredGb: configuredMb / 1024,
    effectiveGb: effectiveMb / 1024,
  };
}

interface SavedSession {
  id: string;
  agentName: string;
  timestamp: number;
  messages: SessionMessage[];
}

function ensureSessionsDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function saveSession(session: Session): void {
  // Only record a session with at least one USER message: a freshly-opened chat
  // accumulates non-user entries, so without this guard every accidental "New
  // chat" is saved to history as an empty row.
  if (!session.messageLog.some((m) => m.kind === 'user')) return;
  // Recalled (engine-backed) sessions are owned by the engine's own store — don't write a duplicate
  // UI-cache copy on each recall.
  if (session.loadedFromEngineId) return;
  try {
    ensureSessionsDir();
    const data: SavedSession = {
      id: session.id,
      agentName: session.agentName,
      timestamp: Date.now(),
      messages: archiveLog(session.messageLog), // screenshots stay out of the archive
    };
    const file = path.join(SESSIONS_DIR, `${session.id}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[origami] failed to save session:', e);
  }
}

interface SavedSessionRow {
  id: string;
  agentName: string;
  timestamp: number;
  messageCount: number;
  archived: boolean;
}

/** Case-insensitive substring search across saved session transcripts. Returns
 *  the listSavedSessions row shape plus a `snippet` of the first match. Caps at
 *  50 hits. Scans active AND archived sessions; the caller decides whether to
 *  offer an "include archived" control. */
function searchSavedSessions(query: string): Array<SavedSessionRow & { snippet?: string }> {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  const out: Array<SavedSessionRow & { snippet?: string }> = [];
  const HARD_CAP = 50;
  const SNIPPET_WINDOW = 60;

  const readDir = (dir: string, archived: boolean): void => {
    if (out.length >= HARD_CAP) return;
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      if (out.length >= HARD_CAP) break;
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
        const data = JSON.parse(raw) as SavedSession;
        // Cheap matches first: agent name + id before scanning the message log.
        const lowAgent = data.agentName.toLowerCase();
        const lowId = data.id.toLowerCase();
        let snippet: string | undefined;
        let matched = false;
        if (lowAgent.includes(q) || lowId.includes(q)) {
          matched = true;
        } else {
          // Stop at the first hit per session so the cap counts matching sessions.
          for (const m of data.messages) {
            const text = typeof m.text === 'string' ? m.text : '';
            const idx = text.toLowerCase().indexOf(q);
            if (idx >= 0) {
              const start = Math.max(0, idx - SNIPPET_WINDOW);
              const end = Math.min(text.length, idx + q.length + SNIPPET_WINDOW);
              snippet = (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
              matched = true;
              break;
            }
          }
        }
        if (matched) {
          out.push({
            id: data.id,
            agentName: data.agentName,
            timestamp: data.timestamp,
            messageCount: data.messages.length,
            archived,
            snippet,
          });
        }
      } catch { /* skip corrupt files */ }
    }
  };

  try {
    ensureSessionsDir();
    readDir(SESSIONS_DIR, false);
    readDir(path.join(SESSIONS_DIR, 'archived'), true);
    out.sort((a, b) => b.timestamp - a.timestamp);
    return out;
  } catch {
    return [];
  }
}

function listSavedSessions(opts: { includeArchived?: boolean } = {}): SavedSessionRow[] {
  const out: SavedSessionRow[] = [];
  const readDir = (dir: string, archived: boolean): void => {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
        const data = JSON.parse(raw) as SavedSession;
        out.push({
          id: data.id,
          agentName: data.agentName,
          timestamp: data.timestamp,
          messageCount: data.messages.length,
          archived,
        });
      } catch { /* skip corrupt files */ }
    }
  };
  try {
    ensureSessionsDir();
    readDir(SESSIONS_DIR, false);
    // Include sessions/archived/ so the ArchivePane "Show archived" toggle has data.
    if (opts.includeArchived) {
      readDir(path.join(SESSIONS_DIR, 'archived'), true);
    }
    // Newest first; archived rows interleave by timestamp. ArchivePane groups them.
    out.sort((a, b) => b.timestamp - a.timestamp);
    return out.slice(0, 50); // cap raised from 20 to fit archived
  } catch {
    return [];
  }
}

interface Session {
  id: string;
  number: number;
  agentName: string;
  /** Working directory the engine child was spawned with (`--cwd`). Frozen at
   *  create time — it must match the running engine child. */
  cwd: string;
  /** 'agent' = an Agent Manager worktree session: never steals focus, never
   *  auto-opens an editor tab. Unset/'chat' = an ordinary user chat. */
  kind?: 'chat' | 'agent';
  /** The bot glyph this chat was created AS — the creature its empty state opens under. */
  botGlyph?: string;
  client: AcpClient;
  /** Holds a prompt sent before this chat's engine is up, and reports the engine's state (engineGate.ts). */
  gate: EngineGate;
  subagentModel?: string; // host-echo of the last setSubagentModel pick — the ACP wire never round-trips it back
  /** `answers` carries a BATCHED question reply; absent for a single ask and for
   * every real permission. `options` rides beside `respond` so a bypass drain can answer with a
   *  real allow id instead of null. */
  pendingPermissions: Map<string, { respond: (optionId: string | null, answerText?: string, answers?: ReadonlyArray<QuestionAnswer>) => void; options: ReadonlyArray<{ optionId: string; name: string; kind: string }> }>;
  /** BACKGROUND `task` children still out (the sidebar ring's 4th state). Dies with
   *  this Session object — no separate registry to clean up. */
  runningChildren: Set<string>;
  estimatedTokens: number;
  messageLog: SessionMessage[];
  /** t-ucnp7t: a recalled/forked chat's older pages, cursor and roster (historyHost.ts). */
  history?: HostHistory;
  /** This session's OWN resolved context window + vision, provider-aware, so a chat
   *  on another provider never stamps its window onto this one. Undefined until probed. */
  modelWindow?: number;
  /** The FULL model id (provider/model) `modelWindow` was probed FOR. After a model
   *  switch the cached window is a stale lie, so readers must treat a mismatch as
   *  unknown and the poll recovery re-probes on it. */
  modelWindowFor?: string;
  modelIsVlm?: boolean;
  /** Active /loop scheduler. stopLoopSchedule is the one choke point that clears it. Persisted, so
   *  a reload re-arms it with `runs` preserved and its next tick a full interval out, never
   *  immediately. `persistent` opts it out of dying with its chat — it is recalled headlessly
   *  instead. `nextRunAt` is stamped only in armLoopTimer, so it can only describe a real timer. */
  loopSchedule?: {
    timer?: ReturnType<typeof setTimeout>; intervalMs: number; prompt: string; runs: number;
    stopped: boolean; createdAt: number; persistent: boolean;
    nextRunAt?: number; lastRunAt?: number; lastOutcome?: LoopOutcome;
  };
  /** True while a turn is awaited on this session. A scheduled /loop run SKIPS its
   *  cycle on this rather than racing a second prompt() on the one ACP session. */
  turnBusy?: boolean;
  /** Cumulative real token spend for the Context tracker. `write` is OUTPUT tokens;
   *  `cacheWrite` is prompt-cache tokens written this turn — never coalesce the two.
   *  Live-only. Distinct from `estimatedTokens` (a turn counter) and from cost. */
  tokenUsage?: { prefill: number; read: number; write: number; cacheWrite: number };
  /** The engine's split of the last turn's prompt tokens, held so the poll's
   *  `contextUpdate` can carry it too — the composer's gauge reads both frames.
   *  Absent until an engine that reports one has sent a turn. */
  contextComposition?: ContextComposition;
  /** Set when this UI session was created by RECALLING an engine session. The engine
   *  owns the transcript, so we do NOT also persist a UI-cache JSON — otherwise
   *  recalling the same chat K times writes K duplicate archive files. */
  loadedFromEngineId?: string;
  /** True while this chat's engine is still starting. The pane is opened BEFORE start()
   *  now (sessionAnnounce.ts), so a chat can be on screen with no engine behind it, and
   *  a tab that attaches during that window has to be told (replaySession.ts). */
  starting?: boolean;
  /** The engine's command list for this session. Cached because the engine pushes it
   *  ONCE, so a composer that mounts later has to be re-seeded (sessionCommandSeed.ts). */
  availableCommands?: readonly SeededCommand[];
  /** Display task name (tab + sidebar + editor-tab): a slug of the first user message, then the
   *  engine's generated title. */
  title?: string;
  /** True once the engine's generated title has been adopted (stops the re-query). */
  engineTitleResolved?: boolean;
  titleAttempts?: number;
  /** Absolute path of the most recent plan file the agent wrote. Opened in preview
   *  when the plan_exit approval modal shows. */
  lastPlanPath?: string;
  /** Absolute path of the most recent dream candidate. The native `dream` tool's
   *  review question opens a vscode.diff of live memory.md vs this candidate.
   *  Sibling of `lastPlanPath`. */
  lastDreamCandidatePath?: string;
  /** The last `todoUpdate` this chat posted, so an attaching view gets the task strip it had.
   *  Live-only, like the strip. */
  todoSnapshot?: TodoSnapshot;
}


/** Safe default context (tokens) when there is no real loaded window to inherit.
 *  NEVER load at a model's declared max (e.g. 262144) — that OOMs. */
const DEFAULT_LOAD_CTX = 32768;

/** Resolve the `lms` CLI. LM Studio exposes NO REST load/unload endpoint — the CLI
 *  or the GUI is the only way. Prefer the known install path, fall back to PATH. */
function lmsBinary(): string {
  const home = os.homedir();
  const win = path.join(home, '.lmstudio', 'bin', 'lms.exe');
  const nix = path.join(home, '.lmstudio', 'bin', 'lms');
  if (os.platform() === 'win32' && fs.existsSync(win)) return win;
  if (fs.existsSync(nix)) return nix;
  return os.platform() === 'win32' ? 'lms.exe' : 'lms';
}

/** Run an `lms` subcommand. `-y` / explicit ids keep every call non-interactive (a
 *  bare `lms load`/`unload` would prompt and hang a spawned process). */
function runLms(args: string[], timeoutMs = 240000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(lmsBinary(), args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}


/** OpenRouter is HTTPS and httpGetJson is node:http only, so these two use the
 *  host's global fetch. Best-effort with a short timeout so a dead network cannot hang the UI. */

/** Validate an OpenRouter API key — GET <base>/key: reachable AND the key works,
 *  not a mere ping. The probe itself lives in keyOnlyPresets.ts, so no provider's
 *  key can be checked against another provider's endpoint. */
function openRouterKeyValid(
  apiKey: string,
  baseURL = 'https://openrouter.ai/api/v1',
): Promise<{ ok: boolean; reason?: string; label?: string; freeTier?: boolean }> {
  return checkProviderKey({ presetId: 'openrouter', apiKey, baseURL, fetchImpl: fetch });
}

/** Fetch OpenRouter's model catalog. `free` = both prompt and completion prices
 *  are 0. `contextLength` is OpenRouter's own `context_length`, read by
 *  refreshModelInfoFor because localProbe's node:http probe can never reach an
 *  https: endpoint. Best-effort: [] on any failure. */
export type OpenRouterModel = { id: string; name: string; free: boolean; cost?: { input: number; output: number }; contextLength?: number };

export async function fetchOpenRouterModels(
  apiKey: string,
  baseURL = 'https://openrouter.ai/api/v1',
): Promise<OpenRouterModel[]> {
  const base = baseURL.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const j = (await res.json().catch(() => ({}))) as any;
    const data = Array.isArray(j?.data) ? j.data : [];
    return data
      .map((m: any): OpenRouterModel => {
        const p = m?.pricing ?? {};
        // OpenRouter prices are USD PER TOKEN; the engine's model.cost is USD per MILLION
        // (session.ts divides by 1e6), so scale up.
        const inPerTok = Number(p.prompt ?? 0);
        const outPerTok = Number(p.completion ?? 0);
        const free = inPerTok === 0 && outPerTok === 0;
        const ctxRaw = m?.context_length;
        const ctx = typeof ctxRaw === 'number' ? ctxRaw : (parseInt(String(ctxRaw ?? ''), 10) || 0);
        return {
          id: String(m?.id ?? ''),
          name: String(m?.name ?? m?.id ?? ''),
          free,
          cost: free ? undefined : { input: inPerTok * 1_000_000, output: outPerTok * 1_000_000 },
          contextLength: ctx > 0 ? ctx : undefined,
        };
      })
      .filter((m: OpenRouterModel) => m.id);
  } catch {
    return [];
  }
}

let sessionCounter = 0;

/** What the Labyrinth pane persists about its columns. `collapsed` is a FLAG and
 *  not a width of 0, so hiding the inspector keeps the width the user dragged to. */
interface LabyrinthColumns { indexWidthPx?: number; inspectWidthPx?: number; inspectCollapsed?: boolean }

export interface WebviewHost {
  readonly webview: vscode.Webview;
  onDidDispose(listener: () => void, thisArgs?: unknown, disposables?: vscode.Disposable[]): vscode.Disposable;
  reveal(): void;
  dispose(): void;
}

/** Which webview bundle a DashboardPanel instance renders. Only `chat` (out/webview/chat.js) is
 *  still built; `dashboard` and `config` were removed. Every live bundle emits a sidecar
 *  `<bundle>.css` carrying the four `:root[data-theme]` palettes; renderHtml links it, so the
 *  --og-* vars are defined and data-theme switching repaints independent of the workbench theme. */
export type WebviewBundle = 'dashboard' | 'config' | 'chat';

/** The shipped prompts the Instructions pane can seed, edit and restore. The webview only ever
 *  names a KIND; each kind is resolved here against the engine's `list_instructions` reply and
 *  re-checked against `file` before anything is written or deleted, so a compromised webview cannot
 *  aim either write at a path of its choosing. */
const OVERRIDE_PROMPTS = {
  'base-prompt': { field: 'basePrompt', file: 'base-prompt.md', label: 'base prompt' },
  'collab-agent-base': { field: 'collabAgentBase', file: 'collab-agent-base.md', label: 'collab base prompt' },
} as const;
type OverridePromptKind = keyof typeof OVERRIDE_PROMPTS;
const overrideKind = (value: unknown): OverridePromptKind =>
  value === 'collab-agent-base' ? value : 'base-prompt';

export class DashboardPanel {
  public static current: DashboardPanel | undefined;

  /** Editor-area chat tabs popped out PER SESSION (each scoped to one session via
   *  the injected `__ORIGAMI_SOLO_SESSION__` global), keyed by sessionId. A second
   *  pop-out of the same session reveals its existing tab. */
  private static sessionPanels = new Map<string, vscode.WebviewPanel>();

  /** Blue-dot the popped-out editor tab's TITLE while pendingAskCount > 0, strip it
   *  at 0. The tab ICON is never touched at runtime — see tabIcon.ts. No-op with no
   *  solo tab: a sidebar-only chat's waiting signal is the sidebar ring instead. */
  private static syncTabIcon(_context: vscode.ExtensionContext, sessionId: string, pendingAskCount: number): void {
    const panel = DashboardPanel.sessionPanels.get(sessionId);
    if (!panel) return;
    panel.title = waitingTitleFor(panel.title, pendingAskCount);
  }

  /** The single full-screen memory-graph editor tab (injected `__ORIGAMI_MEMORY__`). Reopening
   *  reveals the existing tab. */
  private static memoryPanel: vscode.WebviewPanel | undefined;

  /** The single Agent Manager board editor tab (injected `__ORIGAMI_BOARD__`). Reopening reveals
   *  the existing tab. */
  private static agentBoardPanel: vscode.WebviewPanel | undefined;

  /** Lazy fleet owner behind the Agent Manager board. Created on first board message; reaches back
   *  only via ManagerHost. */
  private agentManagerInstance: AgentManager | undefined;


  /** An agent QUESTION arrives as a requestPermission ask (there is no origami/question emitter).
   *  With no view
   * mounted, buffer it here (respond stays in pendingPermissions) and replay on mount — never
   *  auto-answer. */
  private readonly pendingQuestionPermissions = new Map<string, BufferedQuestionPerm>();

  /** Per-session in-flight guard so two near-simultaneous pop-outs of the same
   *  session don't spawn duplicate tabs across the `await` window. */
  private static openingSessions = new Set<string>();

  /** Wire the status bar controller so agent/model switches update it. */
  public static setStatusBar(sb: StatusBarController): void {
    statusBarRef = sb;
  }

  private readonly panel: WebviewHost;
  /** Shared-host multi-view broadcast. The single DashboardPanel owns the ACP session machinery:
   *  `panel` is the primary (owns lifecycle/dispose), `extraViews` are additional webviews that
   *  receive every outbound `post()` and route their inbound messages into the same
   *  `handleWebviewMessage`. Routing is direction-agnostic — both wires call the same handler. */
  private readonly extraViews: vscode.Webview[] = [];
  private readonly sessions = new Map<string, Session>();
  /** One sub-agent-todo puller per chat, made on first use and kept so its
   *  in-flight bookkeeping survives between chunks (subagentTodos.ts). */
  private readonly subagentTodoPullers = new Map<string, (childSessionId: string) => void>();
  private readonly subagentChangesPullers = new Map<string, (childSessionId: string) => void>();
  private readonly disposables: vscode.Disposable[] = [];
  private activeSessionId: string | null = null;
  /** The SIDEBAR chat's last-reported grid layout (grid tiles EVERY session visibly). */
  private sidebarGridMode = false;

  /** The wider context collabManager.ts's dispatcher needs — the same shape
   *  agentManager() builds ManagerHost from. Built fresh per dispatch (the
   *  dispatcher holds no state), so there is no instance field to keep in step. */
  private collabManagerHost(): CollabManagerHost {
    return {
      post: (msg) => this.post(msg),
      cwd: () => this.cwd,
      // Collabs are WORKSPACE-scoped (keyed by cwd), not session-scoped, so any live
      // client answers for them.
      collabClient: () => this.engineClient(),
      collabOrder: () => this.context.workspaceState.get<string[]>(COLLAB_ORDER_KEY) ?? [],
      saveCollabOrder: (order) => void this.context.workspaceState.update(COLLAB_ORDER_KEY, order),
      openCollab: (id, title) => DashboardPanel.openCollabInEditor(this.context, { id, title }),
      promptCaptureFor: (sessionId) => promptCaptureForSession(this.engineClient(), sessionId),
      startBotSession: (slug, displayName, glyph) => startBotSession({ create: (n, agent) => this.createSession(n, undefined, undefined, { engineAgent: agent, botGlyph: glyph }), clientOf: (sid) => this.sessions.get(sid)?.client }, slug, displayName),
    };
  }

  /** Same convention as collabManagerHost() above, for chatSectionsManager.ts. */
  private chatSectionsManagerHost(): ChatSectionsManagerHost {
    return {
      post: (msg) => this.post(msg),
      workspaceState: () => this.context.workspaceState,
    };
  }

  /**
   * Active session id, remembered across dashboard close/reopen via
   * `context.workspaceState`. Read on initialize, replayed to the webview after
   * each createSession. Pairs with `restoreActiveSession` in ChatPane.svelte.
   */
  private static readonly ACTIVE_SESSION_KEY = 'origami.activeSessionId';
  /** The Labyrinth pane's two resizable columns (run index left, inspector right):
   *  each column's dragged width in px, or absent for its default. */
  private static readonly LABYRINTH_COLUMNS_KEY = 'origami.labyrinthColumnWidths';
  private pendingRestoreSessionId: string | null = null;
  private restoring = false; // Feature 2 — suppress open-set saves while the boot session connects + the restore loop runs (interleaved activeSessionChanged echoes would persist a premature empty/partial set).

  /** Cron + ambient activity stream output channel. Created lazily on the first
   *  `origami/feedMessage`; each `BusMessage` becomes one timestamped line under View > Output >
   *  Origami Activity. The webview gets the same payload via `feedMessage`. */
  private static activityChannel: vscode.OutputChannel | undefined;

  /**
   * Append one `BusMessage` to the Origami Activity output channel. Best-effort —
   * never throws even on malformed payloads.
   */
  public static appendActivityLine(busKind: string, payload: Record<string, unknown>): void {
    if (!DashboardPanel.activityChannel) {
      DashboardPanel.activityChannel = vscode.window.createOutputChannel(
        'Origami Activity',
      );
    }
    const ts = new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const summary = DashboardPanel.summariseBusMessage(busKind, payload);
    DashboardPanel.activityChannel.appendLine(`[${ts}] ${summary}`);
  }

  /**
   * Render a one-line human summary of a `BusMessage` for the activity channel.
   * Cron job events, model load/unload and ambient turns get explicit formatting;
   * the rest fall through to a JSON tail.
   */
  private static summariseBusMessage(
    busKind: string,
    payload: Record<string, unknown>,
  ): string {
    if (busKind === 'tick') {
      const sec = payload['epoch_secs'];
      return `[tick] scheduler heartbeat (epoch=${sec ?? '?'})`;
    }
    if (busKind === 'agent_to_agent') {
      const from = payload['from'] ?? '?';
      const to = payload['to'] ?? '?';
      const body =
        ((payload['body'] as string | undefined) ?? '').slice(0, 160);
      return `[route] ${from} -> ${to}: ${body}`;
    }
    if (busKind === 'agent_to_parent') {
      const from = payload['from'] ?? '?';
      const body =
        ((payload['body'] as string | undefined) ?? '').slice(0, 160);
      return `[sub-agent] ${from}: ${body}`;
    }
    if (busKind === 'model_loaded') {
      return `[model] loaded: ${payload['model'] ?? '?'} on ${
        payload['endpoint'] ?? '?'
      }`;
    }
    if (busKind === 'model_unloaded') {
      return `[model] unloaded: ${payload['model'] ?? '?'} from ${
        payload['endpoint'] ?? '?'
      }`;
    }
    // Everything else: decode a job_name if one is present (possibly nested under a
    // `kind` envelope), else show the bus kind + a short JSON tail.
    const kind = payload['kind'];
    const jobName = payload['job_name'];
    if (kind === 'job_started') return `[cron] job started: ${jobName ?? '?'}`;
    if (kind === 'job_completed') return `[cron] job completed: ${jobName ?? '?'}`;
    if (typeof jobName === 'string') return `[${busKind}] ${jobName}`;
    return `[${busKind}] ${JSON.stringify(payload).slice(0, 200)}`;
  }

  /** Reveal the primary Origami surface — the chat view in the secondary side bar. If the shared
   *  host has resolved we reveal the chat; otherwise we focus the chat view, which lazily resolves
   *  the WebviewViewProvider and creates the first session. */
  public static async createOrShow(_context: vscode.ExtensionContext): Promise<void> {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      // Also focus the sidebar chat view. If the primary host died (the sidebar was
      // closed while a chat was popped out), `.current` still points at the instance
      // but its webview is a corpse, so `reveal()` above hit a dead wire. Focusing the
      // view id re-resolves the ChatViewProvider, which re-attaches via resolveSharedView
      // → attachView + replaySessionsTo, so every live session comes back.
      await vscode.commands.executeCommand('origami.chatView.focus');
      return;
    }
    // Not resolved yet — focus the Origami CHAT view so VS Code instantiates the
    // ChatViewProvider (which registers `.current` and bootstraps a session).
    // Focusing the view id is order-independent and works wherever the user docked it.
    await vscode.commands.executeCommand('origami.chatView.focus');
  }

  /** Pop the chat out into a MOVABLE editor-area tab. SAFETY: ensure the sidebar host exists FIRST,
   *  so the editor tab attaches as a SECONDARY mirror whose `onDidDispose` only splices it out of
   *  `extraViews`. It must never be the PRIMARY host, whose `dispose()` tears down every session's
   *  ACP child. */
  public static async openInEditor(context: vscode.ExtensionContext): Promise<void> {
    if (!DashboardPanel.current) {
      // Sidebar not up yet — bring it up first so there is an active session to pop out.
      await DashboardPanel.createOrShow(context);
      for (let i = 0; i < 30 && !DashboardPanel.current; i++) {
        await new Promise<void>((r) => setTimeout(r, 100));
      }
    }
    const sid = DashboardPanel.current?.activeSessionId;
    if (!sid) {
      vscode.window.showInformationMessage('Origami: open a chat first, then pop it out into an editor tab.');
      return;
    }
    await DashboardPanel.openSessionInEditor(context, sid);
  }

  /** Pop ONE session out into its own movable editor-area tab, scoped via the injected
   *  `__ORIGAMI_SOLO_SESSION__` global. SAFETY: the sidebar host stays PRIMARY and owns the ACP
   *  sessions; every popped tab attaches as a SECONDARY mirror, so closing one never disposes the
   *  session. */
  public static async openSessionInEditor(
    context: vscode.ExtensionContext,
    sessionId: string,
  ): Promise<void> {
    const existing = DashboardPanel.sessionPanels.get(sessionId);
    if (existing) {
      existing.reveal();
      return;
    }
    if (DashboardPanel.openingSessions.has(sessionId)) return;
    DashboardPanel.openingSessions.add(sessionId);
    try {
      // Ensure the sidebar is PRIMARY and `.current` is registered before attaching the
      // popped tab as a secondary mirror. createForHost sets `.current` synchronously.
      if (!DashboardPanel.current) {
        await DashboardPanel.createOrShow(context);
        for (let i = 0; i < 30 && !DashboardPanel.current; i++) {
          await new Promise<void>((r) => setTimeout(r, 100));
        }
      }
      const host = DashboardPanel.current;
      if (!host) {
        vscode.window.showErrorMessage('Origami: could not open the chat host.');
        return;
      }
      // Guard against a stale id (the session was closed between the click and here): a
      // solo tab for a dead session renders a permanent "No session" stub that never
      // self-heals. Bail BEFORE creating the panel.
      const session = host.sessions.get(sessionId);
      if (!session) {
        vscode.window.showInformationMessage('Origami: that chat is no longer open.');
        return;
      }
      // Tab label stays compact to save tab-strip space; the descriptive task title
      // shows in the sidebar session list.
      const title = `${session.agentName} #${session.number}`;

      const panel = vscode.window.createWebviewPanel(
        'origami.chatPanel',
        title,
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          // A CHAT surface, so also the roots a read-image card draws from (toolImageUri.ts).
          localResourceRoots: chatResourceRoots(context.extensionUri),
        },
      );
      // Brand the editor tab with the Origami crane, once — never changed at runtime (see
      // tabIcon.ts). The waiting signal is the title's blue dot.
      applyTabIcon(panel, (name) => vscode.Uri.joinPath(context.extensionUri, 'media', name));
      panel.title = waitingTitleFor(panel.title, session.pendingPermissions.size);
      DashboardPanel.sessionPanels.set(sessionId, panel);
      panel.onDidDispose(() => {
        if (DashboardPanel.sessionPanels.get(sessionId) !== panel) return;
        DashboardPanel.sessionPanels.delete(sessionId);
        // Closing this popped view unanswered would hang a FORWARDED ask; if no surface remains,
        // cancel it.
        const h = DashboardPanel.current, s = h?.sessions.get(sessionId);
        if (h && s && !isSessionMounted(sessionId, h.activeSessionId, DashboardPanel.sessionPanels, h.sidebarGridMode)) { drainPermissions(s.pendingPermissions); h.pendingQuestionPermissions.delete(sessionId); h.agentManagerInstance?.setAgentQuestion(sessionId, null); }
      });

      const wvHost: WebviewHost = {
        webview: panel.webview,
        onDidDispose: (listener, thisArgs, disposables) =>
          panel.onDidDispose(listener, thisArgs, disposables),
        reveal: () => panel.reveal(),
        dispose: () => panel.dispose(),
      };

      host.attachView(wvHost, 'chat', sessionId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Origami: pop chat out failed: ${msg}`);
    } finally {
      DashboardPanel.openingSessions.delete(sessionId);
    }
  }

  /**
   * Open the memory graph in its own full editor tab (a secondary view flagged
   * memory=true, so ChatView renders only WikiSearchPane). Reuses the chat bundle
   * and the shared broadcast host. Reopening reveals the existing tab.
   */
  public static async openMemoryInEditor(context: vscode.ExtensionContext): Promise<void> {
    const existing = DashboardPanel.memoryPanel;
    if (existing) {
      existing.reveal();
      return;
    }
    if (!DashboardPanel.current) {
      await DashboardPanel.createOrShow(context);
      for (let i = 0; i < 30 && !DashboardPanel.current; i++) {
        await new Promise<void>((r) => setTimeout(r, 100));
      }
    }
    const host = DashboardPanel.current;
    if (!host) {
      vscode.window.showErrorMessage('Origami: could not open the memory host.');
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'origami.memoryPanel',
      'Memory Graph',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')],
      },
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'media', 'origami-icon-light.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'origami-icon-dark.svg'),
    };
    DashboardPanel.memoryPanel = panel;
    panel.onDidDispose(() => {
      if (DashboardPanel.memoryPanel === panel) DashboardPanel.memoryPanel = undefined;
    });
    const wvHost: WebviewHost = {
      webview: panel.webview,
      onDidDispose: (listener, thisArgs, disposables) =>
        panel.onDidDispose(listener, thisArgs, disposables),
      reveal: () => panel.reveal(),
      dispose: () => panel.dispose(),
    };
    host.attachView(wvHost, 'chat', undefined, true);
  }

  /**
   * Open the Agent Manager board in its own editor tab (a secondary view flagged
   * board=true, so ChatView renders only AgentManagerPane). The board speaks the
   * `am*` message family, answered by the AgentManager fleet owner.
   */
  public static async openAgentManagerInEditor(context: vscode.ExtensionContext): Promise<void> {
    const existing = DashboardPanel.agentBoardPanel;
    if (existing) {
      existing.reveal();
      return;
    }
    if (!DashboardPanel.current) {
      await DashboardPanel.createOrShow(context);
      for (let i = 0; i < 30 && !DashboardPanel.current; i++) {
        await new Promise<void>((r) => setTimeout(r, 100));
      }
    }
    const host = DashboardPanel.current;
    if (!host) {
      vscode.window.showErrorMessage('Origami: could not open the Agent Manager host.');
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'origami.agentBoardPanel',
      // Just "Folds" — an editor tab's width is the scarce resource. The full
      // "Origami — <view>" branding still reads in the webview's own brand bar.
      'Folds',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')],
      },
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'media', 'origami-icon-light.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'origami-icon-dark.svg'),
    };
    DashboardPanel.agentBoardPanel = panel;
    panel.onDidDispose(() => {
      if (DashboardPanel.agentBoardPanel === panel) DashboardPanel.agentBoardPanel = undefined;
      // The webview iframe dies without running the pane's onMount cleanup, so its
      // amVisible:false never arrives — demote the poll cadence host-side or a closed board leaves
      // 5s git polling running for the window's life.
      void host.agentManagerInstance?.handle({ type: 'amVisible', visible: false });
    });
    const wvHost: WebviewHost = {
      webview: panel.webview,
      onDidDispose: (listener, thisArgs, disposables) =>
        panel.onDidDispose(listener, thisArgs, disposables),
      reveal: () => panel.reveal(),
      dispose: () => panel.dispose(),
    };
    host.attachView(wvHost, 'chat', undefined, false, true);
  }

  /** Open a race group's Compare screen in its own editor tab: ensure the shared host, then hand
   *  off to compareTab.ts (one tab per group). */
  public static async openRaceCompareInEditor(context: vscode.ExtensionContext, params: RaceCompareParams): Promise<void> {
    if (!DashboardPanel.current) {
      await DashboardPanel.createOrShow(context);
      for (let i = 0; i < 30 && !DashboardPanel.current; i++) await new Promise<void>((r) => setTimeout(r, 100));
    }
    if (DashboardPanel.current) openRaceCompareTab(context, DashboardPanel.current, params);
  }

  /** Open a repo's architecture-map screen in its own editor tab: read + validate
   *  .origami/map/map.json, ensure the shared host, then hand off to mapTab.ts. */
  public static async openRepoMapInEditor(context: vscode.ExtensionContext, root: string): Promise<void> {
    if (!root) return;
    let raw: string;
    try { raw = fs.readFileSync(path.join(root, '.origami', 'map', 'map.json'), 'utf8'); }
    catch { void vscode.window.showWarningMessage('No architecture map found for this repository — run "Map repo" first.'); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { void vscode.window.showWarningMessage('The architecture map is not valid JSON.'); return; }
    const res = validateMap(parsed);
    if (!res.ok) { void vscode.window.showWarningMessage(`The architecture map is invalid: ${res.errors[0]}`); return; }
    if (!DashboardPanel.current) {
      await DashboardPanel.createOrShow(context);
      for (let i = 0; i < 30 && !DashboardPanel.current; i++) await new Promise<void>((r) => setTimeout(r, 100));
    }
    if (DashboardPanel.current) openRepoMapTab(context, DashboardPanel.current, { root, name: path.basename(root), map: res.map });
  }

  /** Open a collab's stream screen in its own editor tab: ensure the shared host,
   *  then hand off to collabTab.ts (one tab per collab). */
  public static async openCollabInEditor(context: vscode.ExtensionContext, params: CollabTabParams): Promise<void> {
    if (!params.id) return;
    if (!DashboardPanel.current) {
      await DashboardPanel.createOrShow(context);
      for (let i = 0; i < 30 && !DashboardPanel.current; i++) await new Promise<void>((r) => setTimeout(r, 100));
    }
    if (DashboardPanel.current) openCollabTab(context, DashboardPanel.current, params);
  }

  /** Construct a DashboardPanel bound to an arbitrary webview host (the sidebar ChatViewProvider's
   *  `vscode.WebviewView`). Runs the `initialize()` bootstrap and registers the instance as
   *  `DashboardPanel.current`; `dispose()` clears the singleton only when it is this instance. */
  public static async createForHost(
    host: WebviewHost,
    context: vscode.ExtensionContext,
    bundle: WebviewBundle = 'chat',
  ): Promise<DashboardPanel> {
    const instance = new DashboardPanel(host, context, bundle);
    DashboardPanel.current = instance;
    await instance.initialize();
    return instance;
  }

  /** Resolve a view into the SHARED host. Whichever of the config and chat views resolves FIRST
   *  becomes the primary and bootstraps the ACP session; the second ATTACHES to it. VS Code can
   *  resolve them in either order, so this must stay order-independent. */
  public static async resolveSharedView(
    host: WebviewHost,
    context: vscode.ExtensionContext,
    bundle: WebviewBundle,
  ): Promise<DashboardPanel> {
    const existing = DashboardPanel.current;
    if (existing) {
      existing.attachView(host, bundle);
      return existing;
    }
    return DashboardPanel.createForHost(host, context, bundle);
  }

  /** Add a new session tab from outside (Ctrl+Shift+N). */
  public static async addSession(context: vscode.ExtensionContext): Promise<void> {
    if (!DashboardPanel.current) {
      await DashboardPanel.createOrShow(context);
      return; // createOrShow already creates the first session
    }
    await DashboardPanel.current.createSession();
  }

  /** Switch model via QuickPick. The selectable set comes from the ACP session's `configOptions`,
   *  not the dead `list_models` ext-method, and is applied with
   *  `setSessionConfigOption(configId='model')`, which the server validates. */
  public static async switchModel(context: vscode.ExtensionContext): Promise<void> {
    if (!DashboardPanel.current) {
      await DashboardPanel.createOrShow(context);
    }
    const self = DashboardPanel.current;
    if (!self) return;
    const session = self.getActiveSession();
    if (!session) {
      vscode.window.showWarningMessage('Origami: No active session.');
      return;
    }

    try {
      if (!(await session.gate.whenUp())) return; // the model list is empty until the engine is up (engineGate.ts)
      const modelOpt = session.client.getModelOption();
      const options = modelOpt?.options ?? [];
      if (options.length === 0) {
        vscode.window.showWarningMessage(
          'Origami: No models configured. Add a provider/model to ~/.config/origami/origami.json.',
        );
        return;
      }

      const items = options.map(o => ({
        label: `${o.value === modelOpt?.current ? '$(check) ' : ''}${o.name}`,
        description: o.value,
        modelValue: o.value,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: options.length === 1 ? 'Current model (add more in origami.json)' : 'Switch to model…',
        title: 'Origami — Model Switcher',
      });
      if (!pick || pick.modelValue === modelOpt?.current) return;

      const sid = self.activeSessionId ?? '';
      self.post({ type: 'system', text: `Switching to ${pick.modelValue}…`, sessionId: sid });
      // Real ACP write. The server throws InvalidModel if the id isn't a configured
      // provider/model — caught below and surfaced honestly, never a fake "Switched".
      const current = await session.client.setModel(pick.modelValue);
      self.post({ type: 'system', text: `Model set to ${current}.`, sessionId: sid });
      // Reflect the new selection in the status pill.
      self.modelInfo = { ...self.modelInfo, ok: true, modelId: current, state: 'loaded' };
      await self.refreshActiveModelInfo();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Origami model switch failed: ${msg}`);
    }
  }

  /**
   * Recall a prior chat: open the in-webview history dropdown. The webview requests
   * the session list (`requestHistory` → `historyList`) and recalls a pick
   * (`recallSession`), which loadSession-restores the transcript + context.
   */
  public static async openHistory(context: vscode.ExtensionContext): Promise<void> {
    if (!DashboardPanel.current) {
      await DashboardPanel.createOrShow(context);
      for (let i = 0; i < 30 && !DashboardPanel.current; i++) {
        await new Promise<void>((r) => setTimeout(r, 100));
      }
    }
    DashboardPanel.current?.post({ type: 'showHistory' });
  }

  /**
   * Toggle the active mode between Normal and Game by dispatching `/ram-game` /
   * `/ram-normal` through the usual slash channel, which runs the transactional
   * `mode_switch` helper (validate the target's default model, load it, then persist).
   */
  public static async toggleMode(context: vscode.ExtensionContext): Promise<void> {
    if (!DashboardPanel.current) {
      await DashboardPanel.createOrShow(context);
    }
    const self = DashboardPanel.current;
    if (!self) return;
    const session = self.getActiveSession();
    if (!session) {
      vscode.window.showWarningMessage('Origami: No active session.');
      return;
    }

    const items = [
      {
        label: '$(arrow-up) Normal mode',
        description: 'Light VRAM/RAM reserve — max context for the harness',
        cmd: 'ram-normal',
      },
      {
        label: '$(arrow-down) Game mode',
        description: 'Heavier VRAM reserve — yields headroom for games',
        cmd: 'ram-game',
      },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Switch active mode…',
      title: 'Origami — Active Mode',
    });
    if (!pick) return;
    await self.handleSlashCommand(pick.cmd, '');
  }

  /** Run any slash command from outside the dashboard. */
  public static async runSlashCommand(context: vscode.ExtensionContext, command: string, args: string = ''): Promise<void> {
    if (!DashboardPanel.current) {
      await DashboardPanel.createOrShow(context);
    }
    const self = DashboardPanel.current;
    if (!self) return;
    await self.handleSlashCommand(command, args);
  }

  private constructor(
    panel: WebviewHost,
    private readonly context: vscode.ExtensionContext,
    private readonly bundle: WebviewBundle = 'chat',
  ) {
    this.panel = panel;
    this.panel.webview.html = this.renderHtml();

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleWebviewMessage(msg),
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    hostEngine.setChats(this, () => this.chatClient()); // t-sh7cog: host features prefer this panel's chats (hostEngine.ts)
    this.disposables.push(startUsageSampling(glidepathHost(this.context, () => this.engineArg(), (x) => this.post(x)))); // trigger one of three: a dashboard exists — a glide path needs readings taken over time, so the first cannot wait for the view to be opened
  }

  private get cwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  /** Resolve the engine endpoint passed to origami-acp as ORIGAMI_API_BASE. Highest first: the
   *  `origami.engineUrl` SETTING, the existing env var, then the setting's declared default. A
   *  setting equal to the package.json default is still authoritative (VS Code returns the default
   *  for unset keys), so the env override only wins when the user has NOT customised the setting.
   *  `undefined` leaves the child env untouched. */
  private resolveEngineUrl(): string | undefined {
    const cfg = vscode.workspace.getConfiguration('origami');
    const inspected = cfg.inspect<string>('engineUrl');
    const explicit =
      inspected?.workspaceFolderValue ??
      inspected?.workspaceValue ??
      inspected?.globalValue;
    if (typeof explicit === 'string' && explicit.trim()) {
      return explicit.trim();
    }
    const env = process.env.ORIGAMI_API_BASE;
    if (typeof env === 'string' && env.trim()) {
      return env.trim();
    }
    const def = inspected?.defaultValue ?? cfg.get<string>('engineUrl');
    return typeof def === 'string' && def.trim() ? def.trim() : undefined;
  }

  private contextWindow = 0;
  /** The ACTIVE session model's real context window + vision, resolved
   *  provider-aware. Kept separate from `modelInfo`/`contextWindow` (still the LM
   *  Studio probe, load-bearing for lms load/eject + adopt) so the gauge reflects
   *  the active provider, not LM Studio. */
  private activeModelWindow = 0;
  /** The active in-panel theme, shared across every webview. Per-webview state does
   *  NOT carry into a freshly-created webview, so the host holds the shared value
   *  (persisted in globalState) and pushes it on each view's mount handshake. */
  private _currentTheme: string | null = null;
  /** The shared theme if KNOWN. `null` = unknown, in which case we do NOT push, so
   *  a view keeps its own persisted theme (no first-load flip). */
  private get currentTheme(): string | null {
    if (this._currentTheme === null) {
      const saved = this.context.globalState.get<string>('origami.theme');
      // Remap legacy ids the CSS no longer defines so we never push a dead theme.
      if (saved) {
        this._currentTheme =
          saved === 'quiet' ? 'ember' : saved === 'lilac' || saved === 'dark' ? 'meadow' : saved;
      } else {
        // No stored id yet. Infer from the workbench colour theme the switch already set
        // — persistent in settings, so a new panel inherits without a cycle. Only maps to
        // a real Origami theme; a non-Origami workbench theme → null.
        const wb = vscode.workspace.getConfiguration().get<string>('workbench.colorTheme') ?? '';
        const fromWb: Record<string, string> = {
          'Origami Meadow': 'meadow',
          'Origami Harbour': 'harbour',
          'Origami Ember': 'ember',
          'Origami Midnight': 'midnight',
          'Origami Custom': 'custom',
        };
        if (fromWb[wb]) this._currentTheme = fromWb[wb];
      }
    }
    return this._currentTheme;
  }
  private set currentTheme(v: string) {
    this._currentTheme = v;
    void this.context.globalState.update('origami.theme', v);
  }
  private wikiPath: string | null = null;
  private wikiPathIsDefault = true;
  private modelInfo: ModelInfo = { ok: false, modelId: '', contextLength: 0, state: 'unknown' };
  /** PER-CHAT lock over lms load/unload/swap and the ACP model switch: a click while
   *  THAT chat's op is in flight is dropped, not queued (modelOps.ts). */
  private modelOps = new ModelOpGuard((line) => DashboardPanel.appendActivityLine('model_op', { job_name: line }));
  /** Guards the one-time vision-capability reconcile so it runs once per panel lifetime, not on
   *  every reprobe. */
  private visionReconciled = false;
  private workspaceWatchers: vscode.Disposable[] = [];
  private wikiWatcher: vscode.Disposable | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private wikiRefreshTimer: NodeJS.Timeout | null = null;
  /** Per-session permission-mode tracking for the sticky banner in the webview shell
   *  (shown whenever the FOCUSED session is in anything other than `'default'`). No
   *  poll: it follows the live `onModeChanged` stream and `applyPermissionMode`. */
  private readonly permBanner = new PermissionBannerState();
  /** Which SINGLE session an attached view is dedicated to (a popped-out chat tab).
   *  The banner is per-webview DOM and a solo tab never posts `activeSessionChanged`,
   *  so the focused-session answer is wrong for it. Entries are dropped with the
   *  view in attachView's dispose. */
  private readonly viewSolo = new Map<vscode.Webview, string>();
  /** Per-webview teardown for attachView wiring — the doubled-send guard lives in viewWiring.ts. */
  private readonly viewWiring = new Map<vscode.Webview, () => void>();
  /** Streaming-delta batching + solo-session filtering for post() — deltaFanout.ts (t-tc2rlo #9). Only an OPEN CHAT's id is filtered (t-tydjkm: a child transcript reply is keyed on the child). */
  private readonly deltaFanout = new DeltaFanout((id) => this.sessions.has(id));

  private async initialize(): Promise<void> {
    // Write the seed collab agent defs BEFORE the engine child spawns below, because
    // the engine reads {agent,agents}/**/*.md at startup: installing them later would
    // leave `collab_agents` empty until a window reload. Write-if-absent +
    // install-once marker; non-fatal.
    ensureCollabAgents({
      marker: {
        // The shipped seeds are UNPINNED — no model pinned to a provider a fresh machine
        // may not have. The marker bump lets fresh templates land on a fresh install;
        // write-if-absent still protects any user-edited file.
        get: () => this.context.globalState.get<boolean>('origami.collab.agents.v4') === true,
        set: () => void this.context.globalState.update('origami.collab.agents.v4', true),
      },
    });
    // Once-ever "auto-approve the browser tool?" prompt; never blocks the rest of initialize on the
    // user's answer.
    void ensureBrowserToolsConsent(this.context);
    // Read the persisted active-session id before any session is created. The id
    // replays into the webview after createSession if a matching session appears.
    this.pendingRestoreSessionId =
      this.context.workspaceState.get<string>(DashboardPanel.ACTIVE_SESSION_KEY) ?? null;
    // Read the persisted OPEN-SET up front (before any write) for reopen after connect.
    const persistedOpen: OpenSetState | null = loadOpenSet(this.context.workspaceState);

    const wsPath = findWorkspacePath();
    if (wsPath) {
      try {
        const data = readWorkspaceData(wsPath);
        // The memory graph sources the OPEN workspace's wiki (this.cwd →
        // <workspace>/wiki/pages), NOT the settings.toml workspace_path used for the
        // board data above — that can be stale until the engine connects.
        this.wikiPath = resolveDefaultWikiPages(this.cwd);
        this.wikiPathIsDefault = true;
        data.wikiPages = readWikiPagesFromDir(this.wikiPath, path.dirname(this.wikiPath));
        this.post({ type: 'workspaceData', data });
        this.post({ type: 'wikiPath', path: this.wikiPath });
      } catch (e) {
        console.error('[origami] failed to read workspace data:', e);
      }
      this.setupWatchers(wsPath);
      this.post({ type: 'savedSessions', sessions: listSavedSessions() });
    }

    // Probe the inference engine — only report a model once one is really loaded.
    // Probe the SAME endpoint origami-acp is spawned against (resolveEngineUrl:
    // setting → env → default) so the status pill matches the real connection; fall
    // back to settings.toml's api_base only when no engine URL resolves.
    const apiBase = this.resolveEngineUrl() ?? readSettings().apiBase;
    if (apiBase) {
      this.modelInfo = await fetchModelInfo(apiBase, undefined, primaryLocalApiKey());
      this.contextWindow = this.modelInfo.contextLength;
      // Sync vlm image-input caps into origami.json BEFORE the engine spawns: it reads
      // model caps only at spawn, so doing this first means a later text→vision switch
      // forwards images live, with no window reload.
      await this.reconcileVisionCapabilities(apiBase);
    }
    this.broadcastModelStatus();

    // Create the first session automatically. Feature 2 — reopen every chat that was open (engine ids + order + active + grid) via the recall path; missing ids skip; a clean restore retires the boot tab. `restoring` suppresses the premature empty/partial saves the boot connect + reopen-loop echoes would otherwise persist; one authoritative saveOpen flushes after. No open-set -> the single-active fallback above stands.
    this.restoring = true; await this.createSession();
    const boot = this.sessions.values().next().value as Session | undefined;
    if (await restoreOpenSet(persistedOpen, boot?.client, {
      reopen: (id) => this.createSession(undefined, undefined, id),
      setGrid: (g) => { this.sidebarGridMode = g; if (g) this.post({ type: 'setChatLayout', grid: true }); },
      activate: (localId) => { this.activeSessionId = localId; this.post({ type: 'restoreActiveSession', sessionId: localId }); },
    }) && boot) this.closeSession(boot.id); this.restoring = false; this.saveOpen(); this.booted = true;
    // Re-arm persisted /loop schedules now that the restored chats' sessions are
    // live — rearmPersistedLoops needs `this.sessions` in its post-restore state.
    this.rearmPersistedLoops();

    // Adopt whatever LM Studio actually has loaded as the active model, so the engine
    // doesn't request a stale config.model and JIT-boot it. ACP-only; no-op if nothing is loaded.
    await this.adoptLoadedModel();
    // Seed provider liveness at BOOT. providerStatusCache is what a remote session's
    // ok/banner reads (sessionModelStatus); its only other writers are sidebar/picker
    // interactions, so without this a Spark-default workspace boots to "unreachable"
    // against a live server and stays wrong until the user opens the picker.
    void this.broadcastProviderStatus();
    // Resolve the ACTIVE model's real window + vision so a remote default shows its own gauge, not
    // LM Studio's.
    await this.refreshActiveModelInfo();

    // Paint the sticky-mode banner once the first session is up, from the engine's
    // own `mode` config-option. From here on the banner follows mode events + writes.
    this.paintPermissionBanner();
  }

  private async createSession(
    requestedAgent?: string,
    restoredFromMessages?: SessionMessage[],
    loadSessionId?: string,
    opts?: { cwd?: string; kind?: 'chat' | 'agent'; engineAgent?: string; botGlyph?: string; forkFrom?: { sessionId: string; label: string } }, // forkFrom = Fork: clone that engine session instead of opening a fresh one (sessionFork.ts)
  ): Promise<string> {
    sessionCounter++;
    const settings = readSettings();
    // The displayed agent name is an explicit `requestedAgent`, else `settings.activeAgent`, else
    // the brand default "Tsuru". A DISPLAY label only — never round-tripped to the engine (real
    // agent selection is the ACP `mode` config-option). `displayAgentName` maps any internal value
    // through the fixed roster, so nothing the user sees reads "coder".
    const agentName = requestedAgent
      ? displayAgentName(requestedAgent)
      : displayAgentName(settings.activeAgent);
    const sessionNum = sessionCounter;

    const sessionId = `session-${sessionNum}`;
    // Pre-seed the messageLog with the restored archive transcript so the next
    // saveSession round-trip doesn't drop the history. ACP itself starts fresh —
    // there is no LLM-context replay path — but the UI restores the scrollback.
    const session: Session = {
      id: sessionId,
      number: sessionNum,
      agentName,
      cwd: opts?.cwd ?? this.cwd,
      kind: opts?.kind, botGlyph: opts?.botGlyph,
      client: null as any, // set below
      gate: new EngineGate((p) => { session.starting = p.stage === 'starting'; this.post({ type: 'engineState', sessionId, ...p }); }),
      pendingPermissions: new Map(),
      runningChildren: new Set(),
      estimatedTokens: 0,
      messageLog: restoredFromMessages ? [...restoredFromMessages] : [],
      loadedFromEngineId: loadSessionId,
      starting: true, // until start() settles — the pane opens first now (sessionAnnounce.ts)
      ...(loadSessionId || opts?.forkFrom ? { history: newHistory() } : {}), // a reopen shows "Loading chat history…" until its window lands
    };

    const handlers: AcpEventHandlers = {
      onAgentMessageChunk: (text, messageId) => {
        if (isEngineEchoOnBoundCell(sessionId)) return; // a mirrored Claude turn replayed back at its own cell — claudeCodeCell.ts
        // `messageId` = the engine's assistant-message id; the webview stamps it on the agent
        // bubble as a "rewind to here" anchor.
        this.post({ type: 'agentText', text, messageId, sessionId });
        logAgentChunk(session.messageLog, text); // the same write an older page uses (historyHost.ts)
      },
      onAgentImageChunk: (data, mimeType) =>
        this.post({ type: 'agentImage', data, mimeType, sessionId }),
      // Streamed reasoning/thinking (`agent_thought_chunk`). Posted to the webview,
      // which renders a collapsed "thought process" block.
      onAgentThoughtChunk: (text) => {
        this.post({ type: 'agentThought', text, sessionId });
        // Folds board: a background agent's reasoning is its only signal between tool calls — its
        // TAIL is the live activity line.
        this.agentManagerInstance?.foldActivity(sessionId, activityLine(text, 'tail'));
      },
      // A dropped provider stream (t-q90gj9). Its OWN message type, never merged
      // into `agentChunk`: the whole point is that the system says this, not the
      // agent. Logged too, and collapsed onto the running card by sessionLog.ts,
      // so a reloaded window restores one counting card rather than a stack.
      onStreamDrop: (notice) => {
        const s = this.sessions.get(sessionId);
        if (s) logStreamDrop(s.messageLog, notice);
        this.post({ type: 'streamDrop', notice, sessionId });
      },
      // Streamed /compact summary, tagged `_meta.origami_compaction` by the engine.
      // Rendered as a collapsed "Compaction Completed" marker, NOT dumped into the chat.
      onCompactionChunk: (text) =>
        this.post({ type: 'compactionChunk', text, sessionId }),
      // A sub-agent's live output, keyed by the child session so the webview streams it
      // under the task card that spawned it. NOT appended to `messageLog`: it is
      // transient progress and a fan-out would bloat every recalled transcript.
      onSubagentChunk: ({ childSessionId, text }) => {
        this.post({ type: 'subagentChunk', childSessionId, text, sessionId });
        // The one line the engine forwards for a child's `todowrite` carries no
        // list — it is a SIGNAL to go and read that child's stored session,
        // which is the only place the todos exist on this side (subagentTodos.ts).
        if (saysTodoWrite(text)) this.pullSubagentTodos(sessionId)(childSessionId);
        // t-j3qxbp — same signal-not-data shape: a child edit never reaches
        // the parent's own message list, so the pill needs a pull too.
        if (saysEditTool(text)) this.pullSubagentChanges(sessionId)(childSessionId);
      },
      // A sub-agent's live REASONING (t-gvz8t0). Posted on its own type, NOT
      // merged into `subagentChunk`: the webview keeps it in a separate field
      // that the next prose or tool line clears, so thought can never become the
      // child's activity tail or its reply. Not logged, for the same reason the
      // chunks are not — it is transient, and the child's own stored session is
      // where a reader goes for the whole thought (subagentTranscript.ts).
      onSubagentThought: ({ childSessionId, text }) => {
        this.post({ type: 'subagentThinking', childSessionId, text, sessionId });
      },
      // A running sub-agent's token counters (t-dkkd2o). Unlike the chunk above these
      // ARE kept: ONE field overwritten on the child's card, never an appended entry
      // (t-fdvr2a), so a child still working when the window reloads restores with its
      // latest total instead of no tokens at all.
      onSubagentTokens: ({ childSessionId, tokens }) => {
        const session = this.sessions.get(sessionId);
        const priced = pricedTokens(childSessionId, tokens) ?? tokens;
        if (session) { logSubagentTokens(session.messageLog, childSessionId, priced); noteRosterChild(session.history, childSessionId, false, priced); }
        this.post({ type: 'subagentTokens', childSessionId, tokens: priced, sessionId });
      },
      // A BACKGROUND sub-agent finished. The launcher card went `completed` when the
      // child was SPAWNED, so this marker is the only thing that can retire it from the
      // drawer's roster. It IS logged: a card restored without it shows a dead
      // sub-agent as running for the rest of time.
      onSubagentDone: (done) => settleSubagent(this.sessions.get(sessionId), (x) => this.post(x), sessionId, done), // log + ring + roster + post, shared with Stop (subagentSettle.ts)
      // Replayed USER turns from a loadSession history recall — echo them so a recalled
      // conversation shows both sides. `replay: true` tells the sidebar ring this is
      // history catching up, not a turn starting; without it a restored chat's ring
      // spins amber for ever, because no turnDone ever follows a replayed turn.
      onUserMessageChunk: (text) => {
        this.post({ type: 'echoUser', text, sessionId, replay: true });
        // ALSO log it: a recalled chat opens its editor tab AFTER start(), so the live
        // echoUser above is lost and the tab is restored from `messageLog`. Append to the
        // last user entry to keep multi-chunk turns intact.
        logUserChunk(session.messageLog, text);
      },
      // A handoff from ANOTHER agent session — peerMessages.ts says why it is its own message type
      // and archived as `system`.
      onPeerMessage: (peer) => {
        this.post({ type: 'peerMessage', ...peer, sessionId });
        session.messageLog.push(peerLogEntry(peer));
      },
      onAvailableCommands: (commands) => {
        session.availableCommands = commands; // one-shot push; kept for a late composer
        this.post({ type: 'availableCommands', commands, sessionId });
      },
      // Authoritative token/context usage from the engine, forwarded so ControlStrip + composer
      // render a live meter.
      onUsageUpdate: (args) => {
        // Accrue this turn's real token breakdown into the session's running totals
        // (prefill / read / write). Cumulative across turns = total tokens spent, exactly
        // as billed — the honest "spend" figure, not a turn count.
        const s = this.sessions.get(sessionId);
        if (s) {
          const acc = s.tokenUsage ?? (s.tokenUsage = { prefill: 0, read: 0, write: 0, cacheWrite: 0 });
          acc.prefill += args.promptTokens ?? 0;
          acc.read += args.cacheReadTokens ?? 0;
          acc.write += args.outputTokens ?? 0;
          acc.cacheWrite += args.cacheWriteTokens ?? 0;
          // Held, not merged: a frame without one keeps the last real breakdown
          // rather than blanking the card mid-turn.
          if (args.composition) s.contextComposition = args.composition;
        }
        // t-ru1i84. The engine's own occupancy figure is the reading the trend is made of,
        // so the ring is fed HERE and only carried elsewhere; contextTrend.ts says why.
        pushContextReading(sessionId, args.used);
        this.post({
          type: 'usageUpdate', used: args.used, size: args.size, cost: args.cost, sessionId,
          ...(args.subagents ? { subagents: args.subagents } : {}),
          ...(args.composition ? { composition: args.composition } : {}),
          prefill: s?.tokenUsage?.prefill ?? 0,
          read: s?.tokenUsage?.read ?? 0,
          write: s?.tokenUsage?.write ?? 0,
          cacheWrite: s?.tokenUsage?.cacheWrite ?? 0,
        });
        // Accrue this session's cost into the month ledger (local AND OAuth-connected providers are
        // both 0/no-op) and broadcast it.
        if (args.cost && typeof args.cost.amount === 'number') {
          const pid = ((s?.client as { getModelOption?: () => { current?: string } } | undefined)?.getModelOption?.()?.current ?? '').split('/')[0];
          const sp = accrueSessionSpendUnlessOAuth(sessionId, args.cost.amount, pid, this.oauthProviderIds);
          this.post({ type: 'spendUpdate', month: sp.month, total: sp.total });
        }
      },
      // The engine pushes the generated title. Adopt it once it is a real (non-placeholder)
      // name — authoritative, so it supersedes the slug and ends the re-query polling.
      onSessionTitle: ({ title }) => {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        const clean = title.trim();
        if (!clean || DashboardPanel.isDefaultEngineTitle(clean)) return;
        if (session.engineTitleResolved && session.title === clean) return;
        session.engineTitleResolved = true;
        session.title = clean;
        this.applySessionTitle(session, sessionId);
      },
      onToolCallStart: (args) => {
        if (isEngineEchoOnBoundCell(sessionId)) return; // ditto: the duplicate + forever-spinning card
        this.post({ type: 'toolCall', ...args, sessionId });
        // Log the WHOLE payload, not just a title (sessionLog.ts): a recalled chat's tab
        // opens AFTER start(), so the post above is lost and the tab is rebuilt from
        // messageLog — a title-only entry can only come back as a plain text row.
        const title = logToolCall(session.messageLog, args as unknown as Record<string, unknown>);
        this.agentManagerInstance?.foldActivity(sessionId, title); // Folds board: this fold's live "doing now"
      },
      onToolCallUpdate: (args) => {
        if (isEngineEchoOnBoundCell(sessionId)) return; // ditto
        recordSpawn(session.runningChildren, args); // ring's 4th state — see runningChildren.ts
        // t-ru1i84. The child's MODEL rides this message and its token counters ride their
        // own, so the pairing is remembered here and the price applied to whichever of the
        // two arrives second. subagentCost.ts owns both halves.
        rememberChildModel(args.taskSessionId, args.taskModel);
        this.post({ type: 'toolResult', toolCallId: args.toolCallId, status: args.status, content: args.contentText ?? '', diff: args.diff, title: args.title, path: args.path, toolName: args.toolName, taskSessionId: args.taskSessionId, taskBackground: args.taskBackground, taskModel: args.taskModel, taskTokens: pricedTokens(args.taskSessionId, args.taskTokens), rawInput: args.rawInput, rawOutputMeta: args.rawOutputMeta, images: args.images, sessionId });
        logToolResult(session.messageLog, args as unknown as Record<string, unknown>); // merge onto the logged card, for the restore
        if (args.title) this.agentManagerInstance?.foldActivity(sessionId, args.title); // a long tool refines its title mid-run
        // Remember the plan file the agent just wrote so the plan_exit approval modal can open it
        // in preview.
        if (args.path && /[\\/]plans[\\/][^\\/]+\.md$/i.test(args.path)) {
          session.lastPlanPath = args.path;
        }
        // Remember the dream candidate the agent wrote so the native `dream` tool's
        // review question can open a live-vs-candidate diff. Sibling of the plan hook.
        if (args.path && /[\\/]memory\.candidate\.md$/i.test(args.path)) {
          session.lastDreamCandidatePath = args.path;
        }
      },
      onPermissionRequest: ({ toolCallId, title, kind, options, questions, respond, rawInput, locations }) => {
        session.pendingPermissions.set(toolCallId, { respond, options });
        // Ask ADDED: tint the popped-out tab waiting, ahead of every branch below
        // (including one that resolves the SAME tick).
        DashboardPanel.syncTabIcon(this.context, sessionId, session.pendingPermissions.size);
        // Surface the ground-truth target (path / dir / url / command) so the user
        // approves with context instead of a bare title. We do NOT surface any
        // agent-authored "reason" — a local model rationalises, and a
        // plausible-but-wrong justification would launder a bad approval.
        const target: string | undefined = permissionTarget(locations, rawInput);
        // A BACKGROUND agent session with no webview auto-approves in-repo asks and
        // DENIES out-of-repo ones, each noted; chat / toggle-OFF / no option forwards.
        // But a MOUNTED agent view means the user is present: FORWARD to its permission
        // UI instead of auto-answering.
        const mounted = isSessionMounted(sessionId, this.activeSessionId, DashboardPanel.sessionPanels, this.sidebarGridMode);
        // A background agent's QUESTION (requestPermission with NO allow_always; acp/question.ts)
        // must never be auto-answered: with no view mounted, buffer it for replay.
        if (shouldBufferQuestion(session.kind, mounted, options)) { this.bufferAgentQuestion(session, sessionId, toolCallId, title, kind, target, options); return; }
        // A persisted allow_always (recalled across engine restarts) pre-approves a matching CHAT
        // ask with allow_once BEFORE the UI sees it; never a question, never a deny. Falls through
        // to the agent repo-scoped path.
        const permDecision = replayDecision(session.kind, options, title, target ?? '', loadPersistentPermissions(this.context.workspaceState))
          ?? resolvePermission(mounted, () => decideAgentPermission(session.kind, loadAutoApprove(this.context.globalState), session.cwd, options, locations, rawInput, [title, target].filter(Boolean).join(' — ')));
        if (permDecision.action !== 'forward') {
          session.pendingPermissions.delete(toolCallId);
          DashboardPanel.syncTabIcon(this.context, sessionId, session.pendingPermissions.size); // t-q6jxrs — resolved same-tick (auto-decided)
          respond(permDecision.optionId!);
          if (permDecision.note) {
            session.messageLog.push({ kind: 'system', text: permDecision.note, timestamp: Date.now() });
            this.post({ type: 'system', text: permDecision.note, sessionId });
          }
          return;
        }
        this.post({
          type: 'requestPermission', toolCallId, title, kind, sessionId, target,
          command: permissionCommand(rawInput), // tweak 1: show the literal command (incl. external_directory asks, kind 'other')
          options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
          // The whole batch, when the engine sent one. The modal renders it as "Question 1 of N";
          // omitted, the webview falls back to title+options.
          ...(questions ? { questions: questions.map((q) => ({ title: q.title, options: q.options.map((o) => ({ ...o })) })) } : {}),
        });
        notePersistablePermission(session.kind, toolCallId, title, target, options); // Feature 1 — remember this ask so an allow_always reply persists (agent/target-less self-skip)
        // plan_exit / dream-review previews ride the forwarded ask (permissionPreview.ts).
        openPermissionPreview(session, title);
        this.post({
          type: 'permissionAudit',
          toolCallId, title, kind,
          action: 'requested',
          timestamp: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        });
      },
      // The server pushed an assessment update for an open permission modal. Forward to
      // whichever session owns this toolCallId so its webview refreshes the title in
      // place. Stale ids (already approved/denied) drop.
      onAssessmentUpdate: ({ toolCallId, text }) => {
        if (session.pendingPermissions.has(toolCallId)) {
          this.post({ type: 'assessmentUpdate', toolCallId, text, sessionId });
        }
      },
      // Engine-driven mode switch (plan_exit -> build). The ACP session's mode already
      // changed server-side, so just reflect it — no setConfigOption, which is the
      // outbound user-initiated path.
      onModeChanged: ({ modeId }) => {
        if (!modeId) return;
        this.post({ type: 'modeUpdate', mode: modeId, sessionId });
        // The banner's PRIMARY source: an engine-driven switch repaints it live.
        this.applyPermissionMode(sessionId, modeId);
        if (this.activeSessionId === sessionId) {
          statusBarRef?.setMode(modeId);
          this.broadcastConfigSelectors();
        }
      },
      onPlanStatus: (args) =>
        this.post({ type: 'planStatus', ...args, sessionId }),
      // First-class `origami/turnEnd` — forward the real `stop_reason` so ChatPane can
      // anchor an honest per-turn terminal verdict (verified-done / incomplete:<reason>
      // / parked).
      onTurnEnd: (args) => this.post({ type: 'turnVerdict', stopReason: args.stopReason, sessionId }),
      // `origami/sessionStatus` (acpClient.ts) — the only signal for a turn the ENGINE started.
      // Routing lives in sessionStatusRoute.ts.
      onSessionStatus: makeSessionStatusHandler({
        engineSessionId: () => session.client.currentSessionId,
        localSessionId: sessionId,
        post: (message) => this.post(message),
      }),
      // `origami/flockMailbox` — no sessionId: a mailbox belongs to the Origami, not to a chat.
      onFlockMailbox: (args) => this.post(flockMailboxPush(args)),
      // The artifacts list moved on some device. One refresh path, the pane's
      // own: the read re-posts both the list and the pill's badge count.
      onArtifactsChanged: (push) => { void handleArtifactsPaneMessage({ ...(this.getActiveSession()?.client ? { client: this.getActiveSession()!.client! } : {}), post: (x) => this.post(x) }, { type: 'artifactsRequest' });
        nestHub.touch(); // t-sj39jx: a publish or an import here sends the nest's artifact index within 2 s
        // t-s49986: v1 of a NEW artifact opens itself once, in the chat that made it (artifactAutoOpen.ts).
        if (push) void autoOpenArtifact({ client: session.client, post: (x) => this.post(x), openUrl: (url) => openArtifactUrl(url) }, push, (sid) => sid === session.client.currentSessionId); },
      onPlanReady: (args) => {
        this.post({ type: 'planReady', ...args, sessionId });
        if (args.filePath) {
          const uri = vscode.Uri.file(args.filePath);
          vscode.commands.executeCommand('markdown.showPreview', uri).then(
            () => {},
            () => vscode.window.showTextDocument(uri, { preview: true }),
          );
        }
      },
      // Best-of-N critic verdict. The Alternatives panel in PlanPanel.svelte renders
      // the scored tabs.
      onBestOfNComplete: (args) =>
        this.post({ type: 'bestOfNComplete', ...args, sessionId }),
      // Task decomposition landed. ChatPane renders the `TaskShapeCard` component
      // beside TodoStrip when this arrives.
      onTaskShape: (args) =>
        this.post({ type: 'taskShape', ...args, sessionId }),
      // Live TodoWrite snapshot mirroring the harness-owned tracker. ChatPane renders
      // `<TodoStrip>` at the top of the chat; the payload is forwarded unchanged.
      onTodoUpdate: (args) =>
        this.post({ type: 'todoUpdate', ...args, sessionId }),
      // Is this chat's prompt prefix still cached (t-rylyhm). The composer's
      // CacheWarmDot is the only reader, and the PUSH is the only thing that moves
      // it: there is no webview timer, so the engine's own expiry push is what turns
      // a stale "warm" cold. `args.sessionId` is the engine's; the closure's is the
      // one this webview knows the chat by, and they are the same chat.
      onCacheState: (args) =>
        this.post({ type: 'cacheState', ...args, sessionId }),
      // A page the agent just looked at; ChatPane rings them (browserFrames.ts).
      onBrowserSnapshot: (args) =>
        this.post({ type: 'browserSnapshot', ...args, sessionId }),
      // The SINGLE per-turn arbiter verdict (Done | Continue | AskUser). ChatPane
      // renders exactly one decision chip per turn.
      onArbiterDecision: (args) =>
        this.post({ type: 'arbiterDecision', ...args, sessionId }),
      // Cron + ambient observability. The bridge pushes every workspace `BusMessage`
      // here via `origami/feedMessage`. Routed both to the "Origami Activity" output
      // channel and to the webview as `feedMessage` for the sidebar widget.
      onFeedMessage: ({ busKind, payload }) => {
        DashboardPanel.appendActivityLine(busKind, payload);
        this.post({ type: 'feedMessage', busKind, payload, sessionId });
      },
      // The MCP sign-in URL, forwarded to the pane as its own message. NOT opened here:
      // the engine already opened a browser, so this is the "it did not open" link.
      onMcpAuthUrl: ({ name, url }) => this.post({ type: 'mcpAuthUrl', name, url }),
      // t-ucnp7t: the restore replayed only the newest page (historyHost.ts); the roster names every child, loaded or not.
      onHistoryWindow: (win) => { if (session.history) { adoptWindow(session.history, win); this.post(historyStatePost(sessionId, session.history)); } },
      onSubagentRoster: (roster) => { if (!session.history) return; if (adoptRoster(session.history, roster, session.runningChildren)) this.postSessionList(); this.post(historyStatePost(sessionId, session.history)); },
      // Engine death: drop a buffered question, drain its orphaned respond (never hang the engine),
      // clear the board chip.
      onClose: (reason) => { if (!session.gate.exited(reason)) this.post({ type: 'closed', reason, sessionId }); if (this.pendingQuestionPermissions.has(sessionId)) { this.pendingQuestionPermissions.delete(sessionId); drainPermissions(session.pendingPermissions); DashboardPanel.syncTabIcon(this.context, sessionId, 0); this.agentManagerInstance?.setAgentQuestion(sessionId, null); } },
      onError: (message) => { if (session.gate.current !== 'ready' && session.gate.exited(message)) return; this.post({ type: 'error', message, sessionId }); if (this.pendingQuestionPermissions.has(sessionId)) { this.pendingQuestionPermissions.delete(sessionId); drainPermissions(session.pendingPermissions); DashboardPanel.syncTabIcon(this.context, sessionId, 0); this.agentManagerInstance?.setAgentQuestion(sessionId, null); } },
    };

    session.client = new AcpClient(handlers);
    this.sessions.set(sessionId, session);
    // An Agent Manager session runs in the background: it never steals focus from the chat the user
    // is in.
    if (session.kind !== 'agent') this.activeSessionId = sessionId;

    // Load the agent's banner ASCII art so ChatPane can render it above the first
    // message of a fresh session. Missing file → null → ChatPane skips the banner.
    const wsPathForArt = findWorkspacePath();
    const agentArt = wsPathForArt ? readAgentArt(wsPathForArt, agentName) : null;

    // Tell the webview a new session was created. modelName is omitted — the webview
    // learns it from the separate `modelStatus` probe, so no name shows until one is
    // confirmed loaded. The three posts that MAKE the surface are ONE closure,
    // because a chat created as a bot must hold all three until the engine has
    // accepted the agent (sessionAnnounce.ts).
    const announce = () => {
      this.post({
        type: 'sessionCreated',
        sessionId,
        sessionNumber: sessionNum,
        agentName,
        agentArt,
        needsSetup: needsFirstFold(wsPathForArt ?? this.cwd), botGlyph: session.botGlyph,
        // The pane is on screen BEFORE the engine is (sessionAnnounce.ts), so it has to
        // say so where the user is looking — the composer. Cleared by `settled` below.
        starting: session.starting === true,
      });
      if (session.history) this.post(historyStatePost(sessionId, session.history));
      // Seed the new chat's OWN tagged model status (per-session statuses are the only
      // ones a non-active pane honours) and its context gauge.
      this.broadcastModelStatus();
      this.post({
        type: 'contextUpdate',
        sessionId,
        tokensUsed: 0,
        // THIS session's own (tag-valid) window — never the global LM Studio one, which stamped
        // "64k ctx" onto a fresh Spark chat at boot.
        contextWindow: this.sessionValidWindow(session),
        lastActivityAt: null,
        messageCount: 0,
      });
    };

    // When rehydrating from an archive, push the saved messageLog so ChatPane can
    // render the prior scrollback (its `restoreMessages` handler fans out into
    // addMessage()), and flag this session active so the user lands in it.
    if (restoredFromMessages && restoredFromMessages.length > 0) {
      this.post({
        type: 'restoreMessages',
        sessionId,
        messages: restoredFromMessages,
      });
      this.post({ type: 'restoreActiveSession', sessionId });
    }

    // If the persisted active-session id matches this freshly created session, replay
    // restore so the webview activates it instead of the most-recent. One-shot —
    // cleared once consumed.
    if (this.pendingRestoreSessionId === sessionId) {
      this.post({ type: 'restoreActiveSession', sessionId });
      this.pendingRestoreSessionId = null;
    }

    // Connect ACP. Pass the resolved engine endpoint so the spawned origami-acp gets
    // ORIGAMI_API_BASE. Read at spawn — a later change requires a respawn.
    await startThenAnnounce({
      // A chat created AS a bot is PROVISIONAL: the engine may legitimately refuse the
      // definition, and that refusal belongs in the Bots pane, not in a chat panel.
      provisional: !!opts?.engineAgent,
      announce,
      // The chat's own editor tab, opened WITH the announce instead of after the awaited
      // start() — the 6-8 s "New chat does nothing" and the Mac's pane that never came
      // (t-hb1b7e). Not awaited: openSessionInEditor self-guards, and nothing below may
      // wait on a webview. An agent session stays headless — the board is its surface.
      open: session.kind === 'agent' ? undefined : () => { void DashboardPanel.openSessionInEditor(this.context, sessionId); },
      // The engine answered (or refused): the composer stops saying it is starting. The
      // post is how an ALREADY-OPEN pane learns; the flag is how a tab attaching later
      // does, through replaySessionTo.
      settled: () => { session.starting = false; this.post({ type: 'sessionStarting', sessionId, starting: false }); const h = session.history; if (h && settleRestore(h, session.client?.restoredHistory)) this.post(historyStatePost(sessionId, h)); }, // an old engine sent no window: the whole chat is here (contract 6)
      start: async () => {
        // Through the gate: a prompt sent before this resolves waits for it, and a failure keeps
        // the prompt and offers Retry, which runs this same body again (engineGate.ts).
        try { await session.gate.start(async () => {
          // `loadSessionId` (history recall) makes start() call loadSession instead of
          // newSession — the server replays the transcript as sessionUpdate events.
          const acpSessionId = await session.client.start(session.cwd, this.resolveEngineUrl(), loadSessionId, session.kind === 'agent', opts?.engineAgent, opts?.forkFrom?.sessionId); postPeerName(session.client.peerName, sessionId, m => this.post(m)); // "which chat is this" for send_message/list_agents
          // The engine seeds a NEW session from config.model. When that is stale this chat
          // would request a model the GPU doesn't have and JIT-boot it on the first turn.
          // Align it now — ACP only, never an lms load, guarded against stomping a remote.
          await this.adoptLoadedModel(session);
          // The engine has now reported the session's REAL model (configOptions are empty
          // until start() resolves), so re-stamp its per-session status: the pre-start seed
          // judged it by the configured default and cannot see an engine-side override.
          this.broadcastModelStatus();
          this.post({
            type: 'system',
            text: startSystemLine(acpSessionId, loadSessionId, opts?.forkFrom?.label),
            sessionId,
          });
          // The drawer rows this chat retired before the last reload. Posted HERE because the
          // engine id is what they are keyed by and it is only resolved now (t-fiszlv R9).
          const retired = readSubagentDismissed(this.context.workspaceState, acpSessionId);
          if (retired.length > 0) this.post({ type: 'subagentDismissed', sessionId, keys: retired });
        }, () => forkRetryRefusal(!!opts?.forkFrom, session.client.currentSessionId)); } catch (e) { // a fork that never got its id is not retried
          const msg = e instanceof Error ? e.message : String(e);
          // An ordinary chat was told by the gate (the reconnect card, with Retry). An AGENT
          // session with no engine is useless and invisible: unregister it and
          // reject, so the Agent Manager's create fails with the REAL spawn error instead
          // of a later prompt() throw against a session that never started.
          if (session.kind === 'agent' || opts?.engineAgent) {
            this.post({ type: 'error', message: `Could not start origami-acp: ${msg}`, sessionId });
            session.client.dispose();
            this.sessions.delete(sessionId);
            // The active id may be THIS session — it was set at registration, before the
            // engine was up. This path is NOT closeSession, so nothing else moves it off a
            // session that no longer exists, and that corpse is what every activeSessionId
            // reader then resolves. See activeSession.ts.
            this.activeSessionId = liveActiveSessionId(this.sessions, this.activeSessionId);
            this.post({ type: 'sessionClosed', sessionId });
            throw new Error(`engine failed to start: ${msg}`);
          }
        }
      },
    });

    // The tab itself was opened by `open` above, before start(). What stays HERE is the
    // persist: saveOpenSet projects a chat by its ENGINE id and drops a session that has
    // none yet, so persisting before start() would have written this chat out of the set
    // (sessionRestore.ts, isPrematureEmpty). Feature 2 — persist a chat once its engine id
    // lands (suppressed while restoring; the boot/reopened chats are flushed by initialize).
    if (session.kind !== 'agent') this.saveOpen();
    return sessionId;
  }

  /** Buffer an unanswered agent question (respond already in pendingPermissions), flag the board
   *  row + toast once; replaySessionsTo re-posts it on mount. */
  private bufferAgentQuestion(session: Session, sessionId: string, toolCallId: string, title: string, kind: string, target: string | undefined, options: ReadonlyArray<{ optionId: string; name: string; kind: string }>): void {
    this.pendingQuestionPermissions.set(sessionId, { toolCallId, title, kind, target, options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })) });
    const preview = questionPreview(title);
    this.agentManagerInstance?.setAgentQuestion(sessionId, preview); notifyQuestionWaiting(session.agentName, preview);
    void vscode.window.showWarningMessage(`Agent ${session.agentName} needs you: ${preview}`, 'Open chat')
      .then((pick) => { if (pick) void DashboardPanel.openSessionInEditor(this.context, sessionId); });
  }

  private closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.permBanner.forget(sessionId); // a closed session's mode must not leak onto the banner
    this.pendingQuestionPermissions.delete(sessionId); // S7.1 — drop any buffered question-permission with the session
    // Clear the /loop timer so it can't fire into a dead session. A PERSISTENT loop is the
    // exception: its timer is dropped here and the loop is re-armed on a fresh headless session
    // against the SAME engine session, the persisted record left intact so a failed recall degrades
    // to "needs attention". stopLoopSchedule stays the ONE path that STOPS a loop; this branch
    // moves one. Read the engine id BEFORE dispose() takes the client.
    const loopEngineId = session.client.currentSessionId;
    const sched = session.loopSchedule;
    const persistentLoop: PersistedLoop | null = sched?.persistent && loopEngineId
      ? { sessionId: loopEngineId, intervalMs: sched.intervalMs, prompt: sched.prompt, runs: sched.runs, createdAt: sched.createdAt, persistent: true }
      : null;
    if (persistentLoop) {
      if (sched?.timer) clearTimeout(sched.timer);
      session.loopSchedule = undefined;
    } else if (sched) {
      this.stopLoopSchedule(session, sessionId, '');
    }
    // If this chat was popped out into its own editor tab, close that tab too — a solo tab for a
    // dead session renders "No session".
    const popped = DashboardPanel.sessionPanels.get(sessionId);
    if (popped) popped.dispose();
    saveSession(session);
    session.gate.drop(true); // release everything held: this chat's engine will never come up
    session.client.dispose();
    this.sessions.delete(sessionId);
    this.subagentTodoPullers.delete(sessionId); // or the map grows a dead closure per close
    this.post({ type: 'sessionClosed', sessionId });
    // Drop the closed chat's section membership, or the persisted map grows a dead id
    // every close. pruneChatSections returns the SAME object when nothing changed, so
    // the reference check below must run against ONE load, not a second fresh read.
    const loadedSections = loadChatSections(this.context.workspaceState);
    const prunedSections = pruneChatSections(loadedSections, new Set(this.sessions.keys()));
    if (prunedSections !== loadedSections) {
      saveChatSections(this.context.workspaceState, prunedSections);
      this.post({ type: 'chatSections', state: prunedSections });
    }

    // Switch to another session if the active one was closed — the same rule the failed-start
    // tear-down applies (activeSession.ts).
    this.activeSessionId = liveActiveSessionId(this.sessions, this.activeSessionId);
    // ...and repaint, or the closed chat's banner outlives it. `forget` above only
    // clears the TRACKED mode; the banner div itself keeps whatever it was last told,
    // so closing a plan chat left every surviving view wearing the plan warning.
    this.paintPermissionBanner();
    this.saveOpen();
    // Bring the persistent loop back on a headless session. Deliberately AFTER dispose:
    // two live clients on the same engine session would race each other's prompts.
    if (persistentLoop) {
      void this.recallLoopHeadless(persistentLoop).then(() => {
        this.post({ type: 'loopSchedulesData', ...this.loopSchedulesPayload() });
      });
    }
  }

  // Persist the open-set (chat engine ids in tab order + active + grid) on any change; logic in
  // sessionRestore.ts.
  private saveOpen(): void { if (this.restoring) return; saveOpenSet(this.context.workspaceState, this.sessions, this.activeSessionId, this.sidebarGridMode); }

  /** Reconnect to a (possibly changed) engine. origami-acp reads ORIGAMI_API_BASE ONCE at spawn, so
   *  an endpoint change requires respawning: tear down the active AcpClient, create a fresh session
   *  (which re-resolves the URL and spawns a new child), then re-probe so the pill reflects the
   *  REAL connection. `newUrl` is informational. */
  private async reconnectActiveSession(newUrl: string): Promise<void> {
    const sid = this.activeSessionId;
    this.post({ type: 'system', text: `Reconnecting to ${newUrl}…`, sessionId: sid ?? '' });

    // Tear down the current session (dispose kills the child, so the old ORIGAMI_API_BASE binary is
    // gone before we respawn).
    if (sid) {
      this.closeSession(sid);
    }

    // Spawn a fresh session — createSession reads resolveEngineUrl() and passes it as
    // ORIGAMI_API_BASE to the new child.
    await this.createSession();

    // Honest status: re-probe the new endpoint. broadcastModelStatus reports ok ONLY
    // if the engine answered with a loaded model — a dead endpoint leaves the pill
    // Offline with the real reason, never faked green.
    this.modelInfo = { ok: false, modelId: '', contextLength: 0, state: 'unknown' };
    this.broadcastModelStatus();
    await this.reprobeModel().catch(() => { /* leaves modelInfo Offline */ });
  }

  /** Rewrite the "Origami Custom" contributed theme JSON from the user's `--og-*` palette and apply
   *  it to the workbench. Written into the INSTALLED extension dir, so a version bump resets it and
   *  it regenerates on the next Save. Never touches workbench.colorCustomizations (banned) — the
   *  only mechanism is a contributed theme file the user opts into. */
  private async writeCustomWorkbenchTheme(palette: Record<string, string>): Promise<void> {
    const isHex = (v: unknown): v is string =>
      typeof v === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v.trim());
    const g = (key: string, fallback: string): string => {
      const v = palette[key];
      return isHex(v) ? v.trim() : fallback;
    };
    const bg = g('--og-bg', '#0e1411');
    const surface = g('--og-surface', '#131c18');
    const surfaceAlt = g('--og-surface-alt', '#1f2c24');
    const paneHeader = g('--og-pane-header', surface);
    const inputBg = g('--og-input-bg', '#1b271f');
    const text = g('--og-text', '#e7efe9');
    const textSec = g('--og-text-secondary', '#9fb3a7');
    const textMuted = g('--og-text-muted', '#6f8678');
    const chat = g('--og-chat', '#5fa382');
    const border = g('--og-border', '#2a3a31');
    const inputBorder = g('--og-input-border', border);
    const btnBg = g('--og-btn-bg', chat);
    const btnHover = g('--og-btn-hover', '#6cbf97');
    const btnText = g('--og-btn-text', bg);
    const scrollbar = g('--og-scrollbar', '#2a3a3180');
    const scrollbarHover = g('--og-scrollbar-hover', '#3f7268');

    const theme = {
      name: 'Origami Custom',
      type: 'dark',
      colors: {
        'editor.background': bg,
        'editor.foreground': text,
        'editorLineNumber.foreground': textMuted,
        'editorLineNumber.activeForeground': chat,
        'editor.selectionBackground': surfaceAlt,
        'editor.lineHighlightBackground': surface,
        'editorCursor.foreground': chat,
        'editorGutter.background': bg,
        'editorWidget.background': paneHeader,
        'editorWidget.border': border,
        'editorSuggestWidget.background': paneHeader,
        'editorSuggestWidget.border': border,
        'editorSuggestWidget.selectedBackground': surfaceAlt,
        'sideBar.background': surface,
        'sideBar.foreground': text,
        'sideBarTitle.foreground': text,
        'sideBarSectionHeader.background': paneHeader,
        'sideBarSectionHeader.foreground': text,
        'activityBar.background': bg,
        'activityBar.foreground': text,
        'activityBar.inactiveForeground': textMuted,
        'activityBarBadge.background': chat,
        'activityBarBadge.foreground': bg,
        'statusBar.background': surface,
        'statusBar.foreground': text,
        'statusBar.noFolderBackground': surface,
        'titleBar.activeBackground': bg,
        'titleBar.activeForeground': text,
        'titleBar.inactiveBackground': bg,
        'titleBar.inactiveForeground': textSec,
        'tab.activeBackground': paneHeader,
        'tab.activeForeground': text,
        'tab.inactiveBackground': bg,
        'tab.inactiveForeground': textSec,
        'tab.border': surface,
        'tab.activeBorderTop': chat,
        'editorGroupHeader.tabsBackground': surface,
        'panel.background': surface,
        'panel.border': border,
        'panelTitle.activeForeground': chat,
        'panelTitle.inactiveForeground': textSec,
        'terminal.background': bg,
        'terminal.foreground': text,
        'input.background': inputBg,
        'input.foreground': text,
        'input.border': inputBorder,
        'focusBorder': chat,
        'button.background': btnBg,
        'button.foreground': btnText,
        'button.hoverBackground': btnHover,
        'list.activeSelectionBackground': surfaceAlt,
        'list.activeSelectionForeground': text,
        'list.hoverBackground': paneHeader,
        'list.inactiveSelectionBackground': paneHeader,
        'scrollbarSlider.background': scrollbar,
        'scrollbarSlider.hoverBackground': scrollbarHover,
        'scrollbarSlider.activeBackground': chat,
        'badge.background': chat,
        'badge.foreground': bg,
        'foreground': text,
      },
      // Syntax colours stay on the stable Origami palette — the editor edits UI chrome, not token
      // colours.
      tokenColors: [
        { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: textMuted, fontStyle: 'italic' } },
        { scope: ['string', 'string.quoted'], settings: { foreground: '#9ecbb4' } },
        { scope: ['constant.numeric'], settings: { foreground: '#d9b15a' } },
        { scope: ['keyword', 'storage.type', 'storage.modifier'], settings: { foreground: '#d9776a', fontStyle: 'bold' } },
        { scope: ['entity.name.function', 'support.function'], settings: { foreground: '#6ea0d0' } },
        { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], settings: { foreground: '#d9b15a' } },
        { scope: ['variable', 'variable.parameter'], settings: { foreground: text } },
        { scope: ['markup.heading', 'entity.name.section'], settings: { foreground: '#d9b15a', fontStyle: 'bold' } },
        { scope: ['markup.bold'], settings: { foreground: '#d9776a', fontStyle: 'bold' } },
        { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
        { scope: ['markup.inline.raw', 'markup.fenced_code'], settings: { foreground: '#9ecbb4' } },
        { scope: ['markup.quote'], settings: { foreground: textSec, fontStyle: 'italic' } },
      ],
    };

    const sid = this.activeSessionId ?? '';
    try {
      const uri = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'themes', 'origami-custom.json');
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(theme, null, 2) + '\n', 'utf8'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.post({ type: 'error', message: `Couldn't write the custom theme file: ${msg}`, sessionId: sid });
      return;
    }

    // VS Code caches a theme by name, so editing the file in place doesn't re-apply.
    // Toggle off-and-back when already active, else just select it. (No colorCustomizations —
    // banned.)
    const cfg = vscode.workspace.getConfiguration();
    try {
      if (cfg.get<string>('workbench.colorTheme') === 'Origami Custom') {
        await cfg.update('workbench.colorTheme', 'Origami Meadow', vscode.ConfigurationTarget.Global);
      }
      await cfg.update('workbench.colorTheme', 'Origami Custom', vscode.ConfigurationTarget.Global);
      this.post({ type: 'system', text: 'Custom theme applied to the whole workbench.', sessionId: sid });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.post({ type: 'error', message: `Theme file written, but applying it failed: ${msg}`, sessionId: sid });
    }
  }

  /** t-ucnp7t: the pane's lazy-loading requests (historyHost.ts). Export's whole-chat load runs under a
   *  notification, so its progress shows wherever the reader is looking (plan 3.6). */
  private async handleHistoryMessage(m: { type?: string; sessionId?: string; [k: string]: unknown }): Promise<void> {
    const session = m.sessionId ? this.sessions.get(m.sessionId) : undefined;
    if (session) await session.gate.whenUp(); // a scroll-up during a reopen waits for the engine; gone = unavailable below
    const h = session?.history; const engineSessionId = session?.client?.currentSessionId;
    if (!session || !h || !engineSessionId) { if (m.sessionId) this.post(historyUnavailable(m.sessionId, m)); return; } // answered, so the pane never waits for ever
    const deps = { engineSessionId, client: session.client, post: (x: Record<string, unknown>) => this.post(x) };
    if (m.type === 'historySearch') { await searchHistory(session.id, deps, String(m.query ?? ''), typeof m.cursor === 'string' ? m.cursor : undefined); return; }
    const reason = typeof m.reason === 'string' ? m.reason : 'page';
    if (!reason.startsWith('export')) { await loadHistory(h, session.id, deps, untilOf(m.until), reason); return; }
    const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Loading the whole chat for export' }, (progress) =>
      loadHistory(h, session.id, { ...deps, report: (loaded, total) => progress.report({ message: total ? `${loaded} of ${total} messages` : `${loaded} messages` }) }, untilOf(m.until), reason));
    if (!ok) void vscode.window.showErrorMessage('Export stopped: the older messages of this chat could not be loaded, and a part-chat export would look whole. See the top of the chat.');
  }

  /** The sidebar's `sessionList` again, when the ring's running set moved on an engine push (the roster). */
  private postSessionList(): void {
    this.post({ type: 'sessionList', sessions: [...this.sessions.values()].map((s) => ({ id: s.id, number: s.number, agentName: s.agentName, title: s.title, pendingAskIds: Array.from(s.pendingPermissions.keys()), runningChildIds: Array.from(s.runningChildren) })) });
  }

  /** "Last activity" + "message count" derived from the persisted messageLog.
   *  Returns `{ lastActivityAt: null, messageCount: 0 }` for a session with no
   *  messages, so the contextUpdate payload shape is stable on every site. */
  private sessionActivityFields(session: Session): { lastActivityAt: number | null; messageCount: number } {
    const log = session.messageLog;
    if (log.length === 0) return { lastActivityAt: null, messageCount: 0 };
    return { lastActivityAt: log[log.length - 1].timestamp, messageCount: messageCountOf(log.length, session.history) };
  }

  /** Post this session's local turn count + resolved context window after a turn. The REAL token
   *  occupancy comes from the engine's `usage_update` frames, which `contextStats.fold` merges on
   *  top of this payload. This poll is the other half of that merge, and the ONLY gauge source
   *  between session start and the first `usage_update`. */
  private async pollControllerState(session: Session, sessionId: string): Promise<void> {
    // Gauge denominator = THIS session's own resolved window, never the global one,
    // so a Spark turn polled while an LM Studio chat is focused shows Spark's window.
    // Tag-valid only (see sessionValidWindow): a switched chat's stale window reads
    // as unknown (0) until a focus/model-set re-probe.
    this.post({
      type: 'contextUpdate',
      sessionId,
      turns: session.estimatedTokens,
      ...trendField(sessionId), // t-ru1i84 — the card's sparkline; absent until there is a series
      contextWindow: this.sessionValidWindow(session),
      ...this.sessionActivityFields(session),
      ...(session.contextComposition ? { composition: session.contextComposition } : {}),
    });
  }

  private getActiveSession(): Session | undefined {
    if (!this.activeSessionId) return undefined;
    return this.sessions.get(this.activeSessionId);
  }

  /** t-sh7cog (hostEngine.ts): the engine a HOST feature reads — the active chat's, any chat's, else the window's host engine if it runs. Never spawns: only the request gate in handleWebviewMessage does. */
  private chatClient(): AcpClient | undefined { return (this.getActiveSession() ?? [...this.sessions.values()][0])?.client; }
  private engineClient(): AcpClient | undefined { return this.chatClient() ?? hostEngine.current(); }
  private engineArg(): { client?: AcpClient } { const client = this.engineClient(); return client ? { client } : {}; }
  private booted = false; // initialize() made its boot chat: a request before that must not start a host engine

  /** Every engine to tell that provider config changed — EVERY live chat, not just
   *  the active one: each holds its own AcpClient and its own caches, and an
   *  Agent-Manager chat runs in its own worktree cwd. Empty before the first chat
   *  opens, which is not a failure: the next engine start reads the file. */
  private engineRefreshTargets(): RefreshTarget[] {
    return [...this.sessions.values()]
      .filter((session) => !!session.client)
      .map((session) => ({ client: session.client, ...(session.cwd ? { cwd: session.cwd } : {}) }));
  }

  /** At most one engine provider refresh per picker-open burst — see
   *  modelRefreshGate.ts for why both this and the engine memo exist. */
  private readonly modelRefreshGate = createModelRefreshGate();

  private readonly writeProviderConfig = refreshingWriter(writeModelConfig, () => this.engineRefreshTargets());

  /** writeModelContextLimit + "tell the running engines" — the SAME reload wall as the key. A
   *  probed window that only lands in origami.json is invisible to an open chat: the engine froze
   *  `limit.context` at instance start, so overflow.ts kept compacting against the old one. Fires
   *  only when the write changed the file. */
  private readonly writeContextLimit = refreshingChangeWriter(writeModelContextLimit, () => this.engineRefreshTargets());

  /** writeModelVision + "tell the running engines" — the THIRD field on the same
   *  reload wall (visionPin.ts's header has the incident). `refreshingWriter`, not
   *  the change-variant: this writer reports the config PATH, not what changed. */
  private readonly writeVision = refreshingWriter(writeModelVision, () => this.engineRefreshTargets());

  /** Crons view backing service, built per request so it always reads the CURRENT
   *  workspace and binary (both can change under a long-lived panel). defaultBackend
   *  picks the real schtasks backend on Windows and an honest refusal elsewhere. */
  private cronService(): CronService {
    return new CronService({
      repoRoot: findWorkspacePath() ?? this.cwd,
      backend: defaultBackend(),
      resolveBinary: resolveOrigamiBinary,
    });
  }

  /** A short 1-4 word task slug from the user's first message — the provisional tab
   *  name until the engine's generated title lands. */
  private static slugTitle(text: string): string {
    const words = text.trim().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (words.length === 0) return '';
    return words.slice(0, 4).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').slice(0, 40);
  }

  /** True for the engine's placeholder titles ("New session - <ISO>" / "Child session - <ISO>");
   *  mirrors isDefaultTitle. */
  private static isDefaultEngineTitle(title: string): boolean {
    return /^(New|Child) session - /.test(title.trim());
  }

  /** Broadcast the session's title to the webview (the sidebar list shows it). The
   *  editor TAB stays "Tsuru #N", to keep the tab strip compact. */
  private applySessionTitle(session: Session, sid: string): void {
    this.post({ type: 'sessionTitle', sessionId: sid, title: session.title ?? '' });
  }

  /** Set a provisional task title from the first user message (once). */
  private setProvisionalTitle(session: Session, sid: string, text: string): void {
    if (session.title) return;
    const slug = DashboardPanel.slugTitle(text);
    if (!slug) return;
    session.title = slug;
    this.applySessionTitle(session, sid);
  }

  /** After a turn, adopt the engine's generated title once it lands — best-effort and
   *  capped, since the engine titles asynchronously and some local models never title. */
  private async refreshEngineTitle(session: Session, sid: string): Promise<void> {
    if (session.engineTitleResolved) return;
    if ((session.titleAttempts ?? 0) >= 3) return;
    session.titleAttempts = (session.titleAttempts ?? 0) + 1;
    try {
      const rows = await session.client.listSessions();
      const id = session.client.currentSessionId;
      const title = rows.find(r => r.sessionId === id)?.title?.trim();
      if (title && !DashboardPanel.isDefaultEngineTitle(title)) {
        session.engineTitleResolved = true;
        session.title = title;
        this.applySessionTitle(session, sid);
      }
    } catch {
    }
  }

  /** Commands that switch the permission mode. 'deep-plan' is an engine agent like
   *  'plan', so `/deep-plan` rides the same setSessionMode path instead of being
   *  sent to the model as a prompt, which is what an unlisted slash command becomes. */
  private static readonly MODE_COMMANDS = new Set(['plan', 'deep-plan', 'default', 'auto', 'bypass']);

  private static readonly REASONING_COMMANDS = new Set(['think', 'quick', 'normal']);

  /** What sessionFork.ts needs from the panel. `send` is used only for the FORK's first prompt. */
  private forkHost(): ForkHost {
    return { post: (msg) => this.post(msg), engineIdOf: (id) => this.sessions.get(id)?.client?.currentSessionId, labelOf: (id) => { const s = this.sessions.get(id); return sessionLabel(s?.title, s?.number ?? 0); }, isPassthroughCell: (id) => !!boundCell(id), fork: (source) => this.createSession(undefined, undefined, undefined, { forkFrom: source }), send: (id, text) => void this.handleWebviewMessage({ type: 'send', text, sessionId: id }) };
  }

  private async handleSlashCommand(command: string, args: string): Promise<void> {
    const sid = this.activeSessionId;
    if (!sid) {
      this.post({ type: 'system', text: 'No active session.', sessionId: '' });
      return;
    }
    const session = this.sessions.get(sid);
    if (!session) return;

    // Shell-only intercept: /firstfold scaffolds the workspace and writes the model
    // config — it never reaches the engine. Echo the command, then run the wizard.
    if (command === 'firstfold') {
      this.post({ type: 'echoUser', text: `/firstfold${args ? ' ' + args : ''}`, sessionId: sid });
      await this.runFirstFold(sid, args);
      return;
    }

    // Shell-only intercept: /spend prints this chat's cost + the month-to-date total. Never reaches
    // the engine.
    if (command === 'spend') {
      this.post({ type: 'echoUser', text: '/spend', sessionId: sid });
      // Post turnDone on both outcomes, mirroring the generic slash-command path — this
      // shell-only path gave the sidebar ring nothing to settle on before.
      try {
        const s = readSpend();
        const monthLabel = new Date(`${s.month}-01T00:00:00`).toLocaleString(undefined, { month: 'long', year: 'numeric' });
        const sessionCost = s.sessions[sid] ?? 0;
        const fmt = (n: number) => (n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
        this.post({
          type: 'system',
          text: `Spend — this chat: ${fmt(sessionCost)} · ${monthLabel} (all chats): ${fmt(s.total)}. Local models are free; only cloud (OpenRouter) accrues.`,
          sessionId: sid,
        });
        this.post({ type: 'turnDone', stopReason: 'end_turn', sessionId: sid });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.post({ type: 'error', message: `/spend failed: ${msg}`, sessionId: sid });
        this.post({ type: 'turnDone', stopReason: 'error', sessionId: sid });
      }
      return;
    }

    // t-v5qv6u: /btw is off the command list (the composer's Fork button replaced it), but a typed /btw is still caught HERE, or the generic path below would prompt the engine with it. It only forks; sessionFork.ts.
    if (command.toLowerCase() === 'btw') { await this.sessions.get(sid)?.gate.whenUp(); /* a fork needs the engine id: wait for it (engineGate.ts) */ await forkChat(sid, this.forkHost(), args); return; }
    // Permission-mode toggles (plan / default / auto / bypass) are an ACP session-mode switch, NOT
    // a prompt command.
    if (DashboardPanel.MODE_COMMANDS.has(command)) {
      try {
        if (!(await session.gate.whenUp())) return; // engine not up: wait in order; gone: the gate showed the card (engineGate.ts)
        await session.client.setSessionMode(command);
        this.post({ type: 'modeUpdate', mode: command, sessionId: sid });
        statusBarRef?.setMode(command);
        // setSessionMode does NOT refresh configOptions, so track it locally.
        this.applyPermissionMode(sid, command);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.post({ type: 'error', message: `Couldn't switch to ${command} mode: ${msg}`, sessionId: sid });
      }
      return;
    }

    // Reasoning level maps to the model's `effort` (a model variant) via the config-option
    // surface — surface the engine's honest error if this model has no matching variant.
    if (DashboardPanel.REASONING_COMMANDS.has(command)) {
      try {
        if (!(await session.gate.whenUp())) return;
        await session.client.setConfigOption('effort', command);
        this.post({ type: 'reasoningUpdate', mode: command, sessionId: sid });
        statusBarRef?.setReasoning(command);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.post({ type: 'system', text: `Reasoning effort "${command}" isn't available for this model (${msg}).`, sessionId: sid });
        this.post({ type: 'reasoningUpdate', mode: 'normal', sessionId: sid });
      }
      return;
    }

    // Everything else is an engine command (init / review / customize-origami /
    // config / MCP / skill). Route it through the normal prompt path: the engine's
    // detectSlashCommand dispatches a known leading-`/` command to session.command.
    const text = `/${command}${args ? ' ' + args : ''}`;
    this.post({ type: 'echoUser', text, sessionId: sid });
    try {
      const turn = await session.gate.turn(() => session.client.prompt(text)); // waits for the engine, in order (engineGate.ts)
      if (!turn.sent) { this.post({ type: 'turnDone', stopReason: turn.why, sessionId: sid }); return; }
      const stopReason = turn.value;
      session.estimatedTokens++;
      await this.pollControllerState(session, sid);
      this.post({ type: 'turnDone', stopReason, sessionId: sid });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.post({ type: 'error', message: `/${command} failed: ${msg}`, sessionId: sid });
      this.post({ type: 'turnDone', stopReason: 'error', sessionId: sid });
    }
  }

  /** Drive /firstfold: scaffold the workspace + connect a model, streaming checklist
   *  steps into the chat. `/firstfold model` runs only the model-connect step. */
  private async runFirstFold(sid: string, args: string): Promise<void> {
    const cwd = findWorkspacePath() ?? this.cwd;
    const mode: 'full' | 'model' = args.trim().toLowerCase() === 'model' ? 'model' : 'full';
    // firstfold drives the SAME live todo overlay as a tool turn: firstfoldStart
    // marks the session in-flight and clears old todos, `todos` reuses the todoUpdate
    // channel, `narrate` posts system lines, firstfoldDone ends in-flight.
    const emit: FirstFoldEmit = {
      start: () => this.post({ type: 'firstfoldStart', sessionId: sid }),
      todos: (list) => this.post({ type: 'todoUpdate', sessionId: sid, source: 'firstfold', todos: list }),
      narrate: (line: string) => this.post({ type: 'system', text: line, sessionId: sid }),
      done: (summary: string) => {
        this.post({ type: 'system', text: summary, sessionId: sid });
        this.post({ type: 'firstfoldDone', sessionId: sid, needsSetup: needsFirstFold(cwd) });
      },
    };
    try {
      const result = await runFirstFold(cwd, emit, {
        mode,
        connectModel: () => this.connectModelInteractive(),
        confirmReconfigure: (existing) => this.confirmReconfigure(existing),
      });
      // The engine reads config AND scans the workspace's .origami/{command,skills}
      // ONCE at spawn, so a freshly-written model and the newly-seeded skills only take
      // effect after a respawn. A window reload applies them; offer it, don't force it.
      // A FULL fold always seeds commands/skills so it always needs the reload; a
      // model-only run needs it iff the model changed.
      const reloadReason = result.modelWritten
        ? mode === 'full'
          ? `workspace folded, model set to ${result.modelWritten.model}`
          : `model set to ${result.modelWritten.model}`
        : mode === 'full'
          ? 'workspace folded'
          : null;
      if (reloadReason) {
        void vscode.window
          .showInformationMessage(
            `Origami: ${reloadReason}. Reload the window to load your workspace's commands + skills (e.g. /wrap).`,
            'Reload Window',
          )
          .then(choice => {
            if (choice === 'Reload Window') {
              void vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
          });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.post({ type: 'system', text: `First-fold hit an error: ${msg}`, sessionId: sid });
      this.post({ type: 'firstfoldDone', sessionId: sid, needsSetup: needsFirstFold(cwd) });
    }
  }

  /** Ask whether to reconfigure an already-configured model. True to reconfigure, false (or cancel)
   *  to keep it. */
  private async confirmReconfigure(existing: string): Promise<boolean> {
    const pick = await vscode.window.showQuickPick(
      [
        { label: `Keep ${existing}`, description: 'Leave your current model as-is', redo: false },
        { label: 'Set up a different model', description: 'Pick a new provider / model', redo: true },
      ],
      {
        title: `firstfold — a model is already configured (${existing})`,
        placeHolder: 'Reconfigure your model?',
      },
    );
    return pick?.redo === true;
  }

  /** Interactive provider picker for /firstfold's model-connect step; null if the user cancels at
   *  any prompt. */
  private async connectModelInteractive(): Promise<ModelChoice | null> {
    const providers = [
      { label: 'LM Studio', description: 'Local — runs on your own GPU (recommended)', id: 'lmstudio' },
      { label: 'OpenAI (API)', description: 'Cloud — needs an API key', id: 'openai' },
      { label: 'Grok (API)', description: 'Cloud — needs an API key', id: 'xai' },
      { label: 'Claude (Anthropic API)', description: 'Cloud — needs an API key', id: 'anthropic' },
    ];
    const pick = await vscode.window.showQuickPick(providers, {
      title: 'firstfold — choose your model provider',
      placeHolder: 'Which provider should Origami use?',
    });
    if (!pick) return null;

    if (pick.id === 'lmstudio') {
      const baseURL = await vscode.window.showInputBox({
        title: 'LM Studio endpoint',
        value: 'http://127.0.0.1:1234/v1',
        prompt: 'OpenAI-compatible base URL — must end in /v1',
        ignoreFocusOut: true,
      });
      if (!baseURL?.trim()) return null;
      const modelId = await vscode.window.showInputBox({
        title: 'LM Studio model id',
        value: 'qwen/qwen3-coder-30b',
        prompt: 'The model id exactly as LM Studio reports it',
        ignoreFocusOut: true,
      });
      if (!modelId?.trim()) return null;
      return {
        providerId: 'lmstudio',
        providerName: 'LM Studio',
        npm: '@ai-sdk/openai-compatible',
        baseURL: baseURL.trim(),
        modelId: modelId.trim(),
        modelName: modelId.trim(),
      };
    }

    // Hosted providers — built-in to the engine, so just an API key + model id.
    const defaults: Record<string, { name: string; model: string }> = {
      openai: { name: 'OpenAI', model: 'gpt-5' },
      xai: { name: 'xAI', model: 'grok-4' },
      anthropic: { name: 'Claude', model: 'claude-sonnet-5' },
    };
    const d = defaults[pick.id];
    const apiKey = await vscode.window.showInputBox({
      title: `${d.name} API key`,
      password: true,
      prompt: `Stored in your global origami.json (${path.join(os.homedir(), '.config', 'origami', 'origami.json')})`,
      ignoreFocusOut: true,
    });
    if (!apiKey?.trim()) return null;
    const modelId = await vscode.window.showInputBox({
      title: `${d.name} model id`,
      value: d.model,
      ignoreFocusOut: true,
    });
    if (!modelId?.trim()) return null;
    return {
      providerId: pick.id,
      providerName: d.name,
      apiKey: apiKey.trim(),
      modelId: modelId.trim(),
      modelName: modelId.trim(),
    };
  }

  /** Parse raw image data URLs into typed { mimeType, data } pairs. The rule lives
   *  in imageDataUrls.ts so this path and the INTERJECT path cannot drift. */
  private parseImages(rawImages: Array<{ dataUrl: string; name: string }>): Array<{ mimeType: string; data: string }> {
    return parseImageDataUrls(rawImages);
  }

  /** One-time-per-window nudge: if origami-acp was rebuilt while this window kept
   *  the old process alive, the user is testing stale code. Offer a reload, which
   *  respawns the fresh binary and resets this flag with the panel. */
  private staleBinaryWarned = false;
  private maybeWarnStaleBinary(session: Session): void {
    if (this.staleBinaryWarned) return;
    // The message names the version the session's engine reported at the ACP
    // handshake — "a newer build is on disk" alone left the user unable to tell a
    // stale window from a fix that never worked.
    const notice = engineSpawnStaleNotice(session.client.engineSpawn());
    if (!notice) return;
    this.staleBinaryWarned = true;
    void vscode.window
      .showWarningMessage(notice, 'Reload Window')
      .then(choice => {
        if (choice === 'Reload Window') {
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      });
  }

  /** Loop mode (/loop): a time-interval SCHEDULER, not a convergence loop. Re-runs a prompt on a
   *  timer until stopped or a run reports LOOP-DONE; kicks off the first run now, then re-schedules
   *  after each. A REARMED loop after a reload goes through rearmPersistedLoops instead. */
  private startLoopSchedule(session: Session, sid: string, intervalMs: number, prompt: string): void {
    if (session.loopSchedule) this.stopLoopSchedule(session, sid, '');
    // Plain by default — a new loop dies with its chat. Persistence is opted into
    // from the Loops pane.
    session.loopSchedule = { intervalMs, prompt, runs: 0, stopped: false, createdAt: Date.now(), persistent: false };
    this.persistLoopSchedule(session);
    this.post({ type: 'system', text: `Loop scheduled — re-running every ${formatInterval(intervalMs)}. Run /loop stop to cancel.`, sessionId: sid });
    void this.loopTick(session, sid);
  }

  /**
   * THE one place a loop's next tick is armed, so "when does this fire next?" is
   * answered by the installed timer rather than recomputed from createdAt (which
   * drifts by the duration of every run since).
   */
  private armLoopTimer(session: Session, sid: string): void {
    const sched = session.loopSchedule;
    if (!sched || sched.stopped) return;
    sched.timer = setTimeout(() => { void this.loopTick(session, sid); }, sched.intervalMs);
    sched.nextRunAt = Date.now() + sched.intervalMs;
  }

  private async loopTick(session: Session, sid: string): Promise<void> {
    const sched = session.loopSchedule;
    if (!sched || sched.stopped) return;
    // Nothing is armed while a run is in flight: the next tick is measured from when
    // THIS one finishes. The pane renders the gap as "a run is in progress".
    sched.nextRunAt = undefined;
    await this.runLoopOnce(session, sid, sched.prompt);
    const after = session.loopSchedule;               // may have been cleared mid-run
    if (!after || after.stopped) return;
    this.armLoopTimer(session, sid);
    this.persistLoopSchedule(session);                 // keep the persisted `runs` current
  }

  /** Upsert this session's active loop into persisted storage, keyed by its ENGINE
   *  session id, so a window reload can re-arm it. No-op with no active loop. */
  private persistLoopSchedule(session: Session): void {
    const sched = session.loopSchedule;
    const engineId = session.client.currentSessionId;
    if (!sched || !engineId) return;
    savePersistedLoop(this.context.workspaceState, {
      sessionId: engineId, intervalMs: sched.intervalMs, prompt: sched.prompt, runs: sched.runs, createdAt: sched.createdAt,
      persistent: sched.persistent,
    });
  }

  /** Boot: re-arm persisted /loop schedules once sessionRestore.ts has reopened the surviving
   *  chats. A loop whose session came back is reinstalled with the SAME `runs` count and its next
   *  tick a FULL interval out. A loop whose session did NOT come back is left exactly as persisted,
   *  so the Loops pane can surface it. */
  private rearmPersistedLoops(): void {
    const persisted = loadPersistedLoops(this.context.workspaceState);
    if (persisted.length === 0) return;
    const liveByEngineId = new Map<string, string>();
    for (const [localId, session] of this.sessions) {
      const engineId = session.client.currentSessionId;
      if (engineId) liveByEngineId.set(engineId, localId);
    }
    const { recall } = armRestoredLoops(persisted, liveByEngineId, {
      arm: (localId, loop) => {
        const session = this.sessions.get(localId);
        if (!session) return; // unreachable — localId came from `this.sessions` above
        session.loopSchedule = { intervalMs: loop.intervalMs, prompt: loop.prompt, runs: loop.runs, stopped: false, createdAt: loop.createdAt, persistent: isPersistent(loop) };
        // Schedule the NEXT tick only — never run the prompt now, or a reload would fire
        // a burst of missed runs.
        this.armLoopTimer(session, localId);
        this.post({ type: 'system', text: `Loop re-armed after reload — re-running every ${formatInterval(loop.intervalMs)}, next run in ${formatInterval(loop.intervalMs)}.`, sessionId: localId });
      },
    });
    // Persistent loops whose chat did NOT come back are pulled back up headlessly.
    // Sequential, not Promise.all: each recall spawns an engine child, and a fan-out
    // of those at boot turns a window reload into a thundering herd.
    void (async () => {
      for (const loop of recall) await this.recallLoopHeadless(loop);
      if (recall.length > 0) this.post({ type: 'loopSchedulesData', ...this.loopSchedulesPayload() });
    })();
  }

  /** Pull a persistent loop back up with NO chat open: recall its engine session as a headless
   *  (`kind: 'agent'`) session — the same recall path a reopened chat uses, minus the editor tab —
   *  and arm the timer. A recall that FAILS leaves the persisted record as it was, so the loop
   *  reappears as needing attention. */
  private async recallLoopHeadless(loop: PersistedLoop): Promise<void> {
    try {
      const localId = await this.createSession(undefined, undefined, loop.sessionId, { kind: 'agent' });
      const session = this.sessions.get(localId);
      if (!session) return;
      session.loopSchedule = { intervalMs: loop.intervalMs, prompt: loop.prompt, runs: loop.runs, stopped: false, createdAt: loop.createdAt, persistent: true };
      // Next tick only — never a catch-up burst, exactly as on the armed path.
      this.armLoopTimer(session, localId);
    } catch (e) {
      console.error('[origami] persistent loop could not be recalled', loop.sessionId, e);
    }
  }

  /**
   * Reopen the chat for a loop that has none — the imperative half of
   * agentManager/loopReopen.ts, which owns every decision and the ORDER they happen
   * in (detach before open, so one engine session never has two clients).
   */
  private async reopenLoopChatFor(rowId: string): Promise<void> {
    const plan = planLoopReopen(rowId, this.sessions, loadPersistedLoops(this.context.workspaceState));
    await reopenLoopChat(plan, {
      detach: (localId) => this.detachLoopSession(localId),
      openChat: async (engineId) => {
        const localId = await this.createSession(undefined, undefined, engineId);
        const session = this.sessions.get(localId);
        // The engine id is the proof the recall LANDED: createSession swallows a failed
        // start() for a chat session, so the returned id alone would happily arm a timer
        // on a client with no session behind it.
        if (session?.client.currentSessionId === engineId) return localId;
        if (session) this.closeSession(localId);
        return null;
      },
      arm: (localId, loop) => {
        const session = this.sessions.get(localId);
        if (!session) return;
        session.loopSchedule = { intervalMs: loop.intervalMs, prompt: loop.prompt, runs: loop.runs, stopped: false, createdAt: loop.createdAt, persistent: isPersistent(loop) };
        this.armLoopTimer(session, localId);   // next tick only — never a catch-up burst
        this.post({ type: 'system', text: `Loop resumed in this chat — re-running every ${formatInterval(loop.intervalMs)}, next run in ${formatInterval(loop.intervalMs)}.`, sessionId: localId });
      },
      recallHeadless: (loop) => this.recallLoopHeadless(loop),
      reveal: (localId) => { void DashboardPanel.openSessionInEditor(this.context, localId); },
      report: (text) => this.post({ type: 'system', text, sessionId: this.activeSessionId ?? '' }),
    });
  }

  /** Move a loop OFF its session without STOPPING it: drop the armed timer and the live
   *  schedule first, so closeSession finds nothing to recall and stopLoopSchedule — the
   * one path that clears persistence — is never entered. The record is what a reopened chat re-arms
   *  from. */
  private detachLoopSession(localId: string): void {
    const session = this.sessions.get(localId);
    if (session?.loopSchedule) {
      if (session.loopSchedule.timer) clearTimeout(session.loopSchedule.timer);
      session.loopSchedule = undefined;
    }
    this.closeSession(localId);
  }

  /** Live /loop schedules + any persisted loop whose session isn't back yet — the
   *  payload behind loopSchedulesData. */
  private loopSchedulesPayload(): { schedules: LoopScheduleInfo[]; needsAttention: NeedsAttentionLoop[] } {
    const liveEngineIds = new Set<string>();
    for (const session of this.sessions.values()) {
      const id = session.client.currentSessionId;
      if (id) liveEngineIds.add(id);
    }
    const { needsAttention } = splitPersistedLoops(loadPersistedLoops(this.context.workspaceState), liveEngineIds);
    return { schedules: collectLoopSchedules(this.sessions), needsAttention: toNeedsAttentionLoops(needsAttention) };
  }

  private async runLoopOnce(session: Session, sid: string, prompt: string): Promise<void> {
    const sched = session.loopSchedule;
    if (!sched) return;
    // Yield to any turn already active on this session instead of racing a second
    // prompt() on the one ACP session; loopTick still re-schedules, so we retry next interval.
    if (session.turnBusy) {
      this.post({ type: 'system', text: 'Loop: skipped this cycle — a turn was already in progress; will retry next interval.', sessionId: sid });
      return;
    }
    session.turnBusy = true;
    try {
      sched.runs += 1;
      this.post({ type: 'system', text: `Loop run #${sched.runs} — ${prompt}`, sessionId: sid });
      this.post({ type: 'busy', sessionId: sid });      // show in-flight for this run
      const boundary = agentBoundary(session.messageLog);
      try {
        const turn = await session.gate.turn(() => session.client.prompt(buildScheduledRunPrompt(prompt))); // /loop's first run goes at once: wait for the engine (engineGate.ts)
        if (!turn.sent) { this.post({ type: 'turnDone', stopReason: turn.why, sessionId: sid }); return; }
        session.estimatedTokens += 1;
        await this.pollControllerState(session, sid);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        this.recordLoopRun(sched, 'failed');
        this.post({ type: 'error', message: `Loop run failed: ${errMsg}`, sessionId: sid });
        this.post({ type: 'turnDone', stopReason: 'error', sessionId: sid });
        return;
      }
      this.recordLoopRun(sched, 'ok');
      this.post({ type: 'turnDone', stopReason: 'loop_run', sessionId: sid });
      // A run may declare the recurring task permanently complete -> stop the schedule.
      if (parseLoopDone(collectAgentTextSince(session.messageLog, boundary))) {
        this.stopLoopSchedule(session, sid, 'Loop complete — the agent reports the task is permanently done; schedule cleared.');
      }
    } finally {
      session.turnBusy = false;
    }
  }

  /** Stamp how a completed loop run ended. Only a run that really reached an end is
   *  recorded — the turnBusy SKIP path returns before this, because a cycle that
   *  never prompted is not a run. */
  private recordLoopRun(sched: NonNullable<Session['loopSchedule']>, outcome: LoopOutcome): void {
    sched.lastRunAt = Date.now();
    sched.lastOutcome = outcome;
  }

  private stopLoopSchedule(session: Session, sid: string, message: string): void {
    const sched = session.loopSchedule;
    if (!sched) return;
    sched.stopped = true;
    if (sched.timer) clearTimeout(sched.timer);
    session.loopSchedule = undefined;
    // The ONE choke point for clearing persistence too — /loop stop, the Loops-pane
    // cancel control, Stop, session close and a permanent-done run all funnel through
    // here, so persistence never diverges from the live timer.
    const engineId = session.client.currentSessionId;
    if (engineId) removePersistedLoop(this.context.workspaceState, engineId);
    if (message) this.post({ type: 'system', text: message, sessionId: sid });
  }

  /** Agent Manager board messages, routed to the fleet owner (kept out of the main switch). */
  private static readonly AM_MESSAGE_TYPES = new Set([
    'amRequestState', 'amVisible', 'amCreate', 'amStart', 'amStartAll', 'amCancel', 'amOpenChat', 'amOpenTerminal', 'amDelete',
    'amAddRepo', 'amRemoveRepo', 'amRepointRepo', 'amSetRepoDefault', 'amRenameRepo', 'amUpdateQueued', 'amSetAutoApprove',
    'amDiffFiles', 'amOpenFileDiff', 'amApply', 'amRaceFileDiffs', 'amCrossDiff',
    'amMapRepo', 'amCancelMap',
    'amTicketQuickAdd', 'amTicketOpen', 'amTicketLaunch', 'amTicketClose', 'amTicketSpec',
    'amRepoWorktrees', 'amMakePrimary', 'amWorktreeTerminal', 'amWorktreeChat',
  ]);

  private agentManager(): AgentManager {
    if (this.agentManagerInstance) return this.agentManagerInstance;
    const host: ManagerHost = {
      repoRoot: () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return root && fs.existsSync(path.join(root, '.git')) ? root : undefined;
      },
      knownRepos: () => loadKnownRepos(this.context.globalState),
      // The hub list is ALSO published to ~/.origami/repos.json so the engine's board_* tools can
      // find the repos.
      saveKnownRepos: (paths) => { saveKnownRepos(this.context.globalState, paths); syncRegistry(this.context.globalState, host.repoRoot(), paths, host.repoDisplayNames()); },
      pickRepoFolder: () => pickRepoFolder(),
      repoDisplayNames: () => this.context.globalState.get<Record<string, string>>('origami.agentManager.repoDisplayNames') ?? {},
      saveRepoDisplayNames: (names) => { void this.context.globalState.update('origami.agentManager.repoDisplayNames', names); syncRegistry(this.context.globalState, host.repoRoot(), host.knownRepos(), names); },
      autoApprove: () => loadAutoApprove(this.context.globalState),
      setAutoApprove: (on) => saveAutoApprove(this.context.globalState, on),
      createAgentSession: async (cwd, agentName) =>
        this.createSession(agentName, undefined, undefined, { cwd, kind: 'agent' }),
      promptSession: async (sessionId, text) => {
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error(`no session ${sessionId}`);
        // Echo the task into the agent chat's transcript + title so an "Open chat" later shows what
        // it was asked to do.
        this.post({ type: 'echoUser', text, sessionId });
        session.messageLog.push({ kind: 'user', text, timestamp: Date.now() });
        this.setProvisionalTitle(session, sessionId, text);
        session.turnBusy = true;
        try {
          const stopReason = await session.client.prompt(text);
          await this.pollControllerState(session, sessionId);
          this.post({ type: 'turnDone', stopReason, sessionId });
          return stopReason;
        } finally {
          session.turnBusy = false;
        }
      },
      cancelSession: async (sessionId) => {
        const session = this.sessions.get(sessionId);
        // Also resolve a FORWARDED-but-unanswered permission ask so Cancel unsticks the agent.
        if (session) { await session.client.cancel().catch(() => undefined); drainPermissions(session.pendingPermissions); DashboardPanel.syncTabIcon(this.context, sessionId, 0); this.pendingQuestionPermissions.delete(sessionId); this.agentManagerInstance?.setAgentQuestion(sessionId, null); }
      },
      closeSession: (sessionId) => this.closeSession(sessionId),
      sessionAlive: (sessionId) => this.sessions.has(sessionId),
      openChat: (sessionId) => { void DashboardPanel.openSessionInEditor(this.context, sessionId); },
      engineSessionId: (uiId) => this.sessions.get(uiId)?.client.currentSessionId ?? undefined,
      reopenAgentSession: async (cwd, engineId, agentName) =>
        this.createSession(agentName, undefined, engineId, { cwd, kind: 'agent' }),
      post: (msg) => {
        this.post(msg);
        // Mirror every board broadcast into the status-bar fleet aggregate.
        const anyMsg = msg as { type?: string; repos?: Parameters<typeof boardAggregate>[0] };
        if (anyMsg.type === 'amState') statusBarRef?.setAgents(aggregateText(boardAggregate(anyMsg.repos)));
      },
      openTerminal: (cwd, title) => {
        vscode.window.createTerminal({ cwd, name: title }).show();
      },
      // Raw per-session pin ONLY: the ACP setModel primitive scoped to this agent's
      // session. Deliberately NOT the chat 'setModel' handler — no lms load/unload, no
      // cross-session carry, no global write — so an agent can never evict the user's live chat.
      setSessionModel: async (sid, modelId) => {
        const s = this.sessions.get(sid);
        if (!s) throw new Error(`no session ${sid}`);
        await s.client.setModel(modelId);
      },
      // Typed agents: the session's live ACP mode options (harvested into the roster),
      // a validated per-session mode set (throws with the available ids), and the
      // persisted roster read/write. Only the ACP 'mode' config option is touched.
      // `current` is the session's mode at harvest time, so it IS the engine default —
      // flagged so the picker hides it.
      agentModes: (sid) => modesFromOption(this.sessions.get(sid)?.client.getModeOption()),
      // Pre-fill: modes of the first live session that has them, so a fresh window's picker isn't
      // empty; null if none yet.
      harvestAnySessionModes: () => {
        for (const s of this.sessions.values()) { const m = modesFromOption(s.client.getModeOption()); if (m) return m; }
        return null;
      },
      setSessionAgentMode: async (sid, modeId) => {
        const s = this.sessions.get(sid);
        if (!s) throw new Error(`no session ${sid}`);
        const ids = (s.client.getModeOption()?.options ?? []).map((o) => o.value);
        if (!ids.includes(modeId)) throw new Error(`agent type "${modeId}" not one of: ${ids.join(', ') || '(none)'}`);
        await s.client.setConfigOption('mode', modeId);
      },
      agentTypes: () => loadAgentTypes(this.context.globalState),
      saveAgentTypes: (types) => saveAgentTypes(this.context.globalState, types),
      archetypeMarker: () => ({ get: () => this.context.globalState.get<boolean>('origami.flock.archetypes.v4') === true, set: () => void this.context.globalState.update('origami.flock.archetypes.v4', true) }),
      // Apply-to-main: a native diff (readonly agent-base left vs the worktree file
      // right), a success toast, and opening conflicted files for the user to resolve.
      openFileDiff: (worktree, base, relPath, rightFsPath, title) => {
        void vscode.commands.executeCommand('vscode.diff', makeBaseUri(worktree, base, relPath), vscode.Uri.file(rightFsPath), title);
      },
      // Race compare: two REAL on-disk worktree files, so a plain vscode.diff of file URIs, no
      // content provider.
      openCrossDiff: (leftFsPath, rightFsPath, title) => {
        void vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(leftFsPath), vscode.Uri.file(rightFsPath), title);
      },
      info: (msg) => { void vscode.window.showInformationMessage(msg); },
      openConflicted: (absPaths) => {
        for (const p of absPaths) void vscode.window.showTextDocument(vscode.Uri.file(p), { preview: false });
      },
      // Folds board ticket ✎: the ticket markdown IS its full-brief editor.
      openFile: (p) => { void vscode.window.showTextDocument(vscode.Uri.file(p), { preview: false }); },
    };
    this.agentManagerInstance = new AgentManager(host);
    // Refresh the engine-readable repo registry once per board boot. A MERGE, not a
    // rewrite: board_register writes entries this window has never seen.
    syncRegistry(this.context.globalState, host.repoRoot(), host.knownRepos(), host.repoDisplayNames());
    return this.agentManagerInstance;
  }

  /** This chat's sub-agent-todo puller. t-qd2riw: the read is now the engine's
   *  bounded `subagent_todos` lookup, not the whole-transcript request the
   *  drawer's ↗ makes — a long child no longer costs one full-session read per
   *  todowrite signal. */
  private pullSubagentTodos(sessionId: string): (childSessionId: string) => void {
    const existing = this.subagentTodoPullers.get(sessionId);
    if (existing) return existing;
    const pull = makeSubagentTodoPuller({
      // t-qd2riw. Bounded engine lookup, not the whole child transcript.
      read: (child) => subagentTodosPayload(this.sessions.get(sessionId)?.client, child),
      post: (childSessionId, todos) => this.post({ type: 'subagentTodos', childSessionId, todos, sessionId }),
      log: (line) => console.log(line),
    });
    this.subagentTodoPullers.set(sessionId, pull);
    return pull;
  }

  /** t-j3qxbp — same pull-on-signal shape as pullSubagentTodos, so the
   *  changed-files pill can see a child's edits too. */
  private pullSubagentChanges(sessionId: string): (childSessionId: string) => void {
    const existing = this.subagentChangesPullers.get(sessionId);
    if (existing) return existing;
    const pull = makeSubagentChangesPuller({
      // t-ru0by6: bounded `subagent_changes` read, same shape as
      // pullSubagentTodos's `subagent_todos` read above — no more
      // whole-transcript pull per signal.
      read: (child) => subagentChangesPayload(this.sessions.get(sessionId)?.client, child),
      post: (childSessionId, files) => this.post({ type: 'subagentChanges', childSessionId, files, sessionId }),
      log: (line) => console.log(line),
    });
    this.subagentChangesPullers.set(sessionId, pull);
    return pull;
  }

  private async handleWebviewMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: string; sessionId?: string; [k: string]: unknown };
    const sid = m.sessionId as string | undefined;
    if (this.booted && !this.engineClient() && typeof m.type === 'string' && HOST_ENGINE_MESSAGE_TYPES.has(m.type)) await hostEngine.ensure(); // t-sh7cog: with no chat open, a user surface's engine read starts the window's host engine; no-op while a chat exists

    if (claudeCodeOwns(m)) { void handleClaudeCodeMessage({ post: (x) => this.post(x), cwd: this.cwd, folders: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath), read: () => this.context.workspaceState.get(CLAUDE_CODE_RESUME_KEY), write: (next) => void this.context.workspaceState.update(CLAUDE_CODE_RESUME_KEY, next), log: (l) => console.log(l), createCell: () => this.createSession(), redispatch: (x) => void this.handleWebviewMessage(x), slashSkills: () => vscode.workspace.getConfiguration('origami').get<boolean>('claudeCode.slashSkills') !== false, refreshModels: () => this.broadcastSessionModels(), replayLog: (sid) => this.sessions.get(sid)?.messageLog, engine: (sid) => this.sessions.get(sid), planUsage: nodePlanUsageDeps((l) => console.log(l)) }, m); return; } // a Claude Code passthrough BINDS one of our own cells (that is what gives it a tab) — claudeCodeManager.ts; refreshModels/replayLog let a bound cell reuse the panel's OWN model broadcast and reattach log; engine hands the transcript mirror that cell's ACP client + cwd (claudeCodeMirror.ts)
    if (typeof m.type === 'string' && DashboardPanel.AM_MESSAGE_TYPES.has(m.type)) {
      void this.agentManager().handle(m);
      return;
    }
    if (typeof m.type === 'string' && COLLAB_MESSAGE_TYPES.has(m.type)) {
      void handleCollabMessage(this.collabManagerHost(), m);
      return;
    }
    if (typeof m.type === 'string' && CHAT_SECTION_MESSAGE_TYPES.has(m.type)) {
      handleChatSectionMessage(this.chatSectionsManagerHost(), m, sid);
      return;
    }
    // Tools pane — catalog read, code-mode toggle, scaffold a user tool file. Everything lives in toolsPane.ts.
    if (typeof m.type === 'string' && TOOLS_PANE_MESSAGE_TYPES.has(m.type)) { void handleToolsPaneMessage({ ...this.engineArg(), post: (x) => this.post(x) }, m); return; }
    // MCP pane — list/add/remove/toggle/connect/auth. Everything lives in mcpPane.ts.
    if (typeof m.type === 'string' && MCP_PANE_MESSAGE_TYPES.has(m.type)) { void handleMcpPaneMessage({ ...this.engineArg(), post: (x) => this.post(x) }, m); return; }
    if (typeof m.type === 'string' && FLOCK_PANE_MESSAGE_TYPES.has(m.type)) { void handleFlockPaneMessage({ ...this.engineArg(), cwd: this.cwd, post: (x) => this.post(x), openChat: async (recall) => (recall ? openTabFor(this.sessions, recall) : undefined) ?? await this.createSession(undefined, undefined, recall), hostEngine: () => { const own = hostEngine.ownClient(); return own ? { client: own, pid: own.pid } : undefined; } /* t-vbj03h: the window's host engine can hold the lease too */, sessions:() => [...this.sessions.entries()].map(([id, sn]) => ({ id, label: sessionLabel(sn.title, sn.number ?? 0), engineId: engineSessionId(sn.client, id) ?? undefined, pid: sn.client.pid })), chat: (localId) => { const sn = this.sessions.get(localId); return sn ? { client: sn.client, engineId: engineSessionId(sn.client, localId) ?? undefined, pid: sn.client.pid } : undefined; } /* a workspace runs one engine PER CHAT, each its own OS pid (acpClient.ts's `pid` getter) — `pickFlockClient` (flockRoute.ts) matches flock-owner.json's holder pid against these so a flock read/write can be routed to the SIBLING CHAT that actually holds the links, not just the active one; a flock message is injected by the engine that OWNS the chat, never by whichever one the pane read (flockMailbox.ts) */ }, m); return; } if (typeof m.type === 'string' && REMOTE_PANE_MESSAGE_TYPES.has(m.type)) { void handleRemotePaneMessage({ post: (x) => this.post(x) }, m); return; } if (typeof m.type === 'string' && SIDE_QUESTS_MESSAGE_TYPES.has(m.type)) { void handleSideQuestMessage({ cwd: this.cwd, post: (x) => this.post(x), enabled: sideQuestsEnabled, save: saveSideQuestFile, createChat: () => this.createSession() }, m); return; } // FOUR panes, ONE line: side quests (t-f89g49) read a FOLDER (.origami/sidequests) and never the engine — sideQuestsPane.ts. The panel owns exactly one half of Start — making an EMPTY chat — because sideQuestsPane.ts then PREFILLS its composer rather than prompting it: a new chat has no model yet, and the owner is prompted for the chat's model AND its sub-agent model (ModelPicker.svelte + ModelPickerFollowUp.svelte) before the first turn goes out.
    if (typeof m.type === 'string' && HISTORY_MESSAGE_TYPES.has(m.type)) { void this.handleHistoryMessage(m); return; } // t-ucnp7t: older pages + whole-chat search (historyHost.ts)
    if (typeof m.type === 'string' && REPO_PICKER_MESSAGE_TYPES.has(m.type)) { void handleRepoPickerMessage({ cwd: this.cwd, post: (x) => this.post(x), sessions: () => [...this.sessions.entries()].map(([id, sn]) => ({ id, cwd: sn.cwd, hasTurns: sn.messageLog.length > 0 })), createChat: (cwd) => this.createSession(undefined, undefined, undefined, { cwd }), closeChat: (sessionId) => this.closeSession(sessionId) }, m); return; } // the chat pane's repo/branch pills (repoPicker.ts). It gets createSession, NEVER a write to `sn.cwd`: a session's directory is fixed at creation and the pills open a new chat instead.
    if (typeof m.type === 'string' && NEST_SIDEBAR_MESSAGE_TYPES.has(m.type)) { void handleNestSidebarMessage({ post: (x) => this.post(x), engine: () => hostEngine.nestEngine, open: async (id) => { await this.handleWebviewMessage({ type: 'recallSession', sessionId: id }); if (this.sessions.has(id)) await DashboardPanel.openSessionInEditor(this.context, id); } }, m); return; } /* t-t7lfho: recall alone leaves an already-open tab behind; the reveal brings the chat's pane forward */ /* t-s9k0q6 + t-sc093o: the sidebar's Nest view (nestSidebar.ts); the hub (nestHub.ts) reads the ENGINE through hostEngine.nestEngine (a chat's client, else the window's host engine, t-sh7cog) and opens a pulled chat by recallSession */ if (typeof m.type === 'string' && SUBAGENT_LIMIT_MESSAGE_TYPES.has(m.type)) { void handleSubagentLimitMessage({ post: (x) => this.post(x) }, m); return; } if (typeof m.type === 'string' && CACHE_WARMING_MESSAGE_TYPES.has(m.type)) { void handleCacheWarmingMessage({ post: (x) => this.post(x) }, m); return; } if (typeof m.type === 'string' && CHAT_BACKDROP_MESSAGE_TYPES.has(m.type)) { void handleChatBackdropMessage({ post: (x) => this.post(x) }, m); return; } /* t-s9jr6u: Settings' backdrop row, SETTINGS only (chatBackdropSetting.ts); the broadcast reply reaches every chat pane */ if (typeof m.type === 'string' && STORAGE_PANE_MESSAGE_TYPES.has(m.type)) { void handleStorageMessage({ ...this.engineArg(), post: (x) => this.post(x) }, m); return; } // FOUR panes, ONE line: the panel is at its cap. Insights' Storage card reads and prunes the ENGINE's session store through a chat's extMethod, else the host engine's (storagePane.ts), the same shape the tools and MCP panes take. // SAME reason: Insights' cache-warming switch reads SETTINGS only (cacheWarmingPane.ts), never the engine. // THREE panes, ONE line, same reason: Insights' sub-agent cap reads SETTINGS only (subagentLimitPane.ts), never the engine. // TWO panes, ONE line: the panel is at its cap and the ratchet never rises. Flock reads the ENGINE (flock.json + the front-desk config) via flockPane.ts; Remote reads SETTINGS + the activation-owned controller and never the engine, via remotePane.ts.
    if (typeof m.type === 'string' && WEBMCP_PANE_MESSAGE_TYPES.has(m.type)) { handleWebMcpPaneMessage({ post: (x) => this.post(x) }, m); return; } // Web MCP section — a FILE read/write, so no session needed. webmcpPane.ts.
    // Plugins pane — list/enable-disable/add-from-folder. Everything lives in pluginsPane.ts.
    // Artifacts pane — the engine owns the artifacts; this forwards, opens the
    // url artifact_open returns through the integrated browser (browserBridge ->
    // browserVsCode), reveals a local path with the OS file manager (round 3,
    // t-s9kc6o), and opens a fresh EMPTY chat for "Open chat about" the same way
    // sideQuestsPane.ts's Start does. artifactsPane.ts owns every refusal and the
    // badge count.
    if (typeof m.type === 'string' && ARTIFACTS_PANE_MESSAGE_TYPES.has(m.type)) { void handleArtifactsPaneMessage({ ...this.engineArg(), post: (x) => this.post(x), openUrl: async (url) => { await openArtifactUrl(url); }, revealPath: async (p) => { try { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p)); } catch (e) { vscode.window.showErrorMessage(`Could not reveal ${p}: ${e}`); } }, createChat: () => this.createSession() }, m); return; }
    if (typeof m.type === 'string' && PLUGINS_PANE_MESSAGE_TYPES.has(m.type)) { void handlePluginsPaneMessage({ ...this.engineArg(), post: (x) => this.post(x) }, m); return; }
    // Skills pane — the discovered-skills list. Everything lives in skillsPane.ts,
    // including WHICH session it asks: activeSession.ts, not the raw active id.
    if (typeof m.type === 'string' && SKILLS_PANE_MESSAGE_TYPES.has(m.type)) { void handleSkillsPaneMessage({ sessions: () => this.sessions, activeSessionId: () => this.activeSessionId, post: (x) => this.post(x), cwd: () => this.cwd, hostClient: () => hostEngine.current() }, m); return; }
    // Labyrinth model prices — workspaceState only; everything lives in labyrinthPrices.ts.
    if (typeof m.type === 'string' && LABYRINTH_PRICES_MESSAGE_TYPES.has(m.type)) { handleLabyrinthPricesMessage({ read: () => this.context.workspaceState.get(LABYRINTH_PRICES_KEY), write: (next) => void this.context.workspaceState.update(LABYRINTH_PRICES_KEY, next), post: (x) => this.post(x) }, m); return; }
    if (typeof m.type === 'string' && COLLABS_SECTION_MESSAGE_TYPES.has(m.type)) { handleCollabsSectionMessage({ post: (x) => this.post(x), workspaceState: () => this.context.workspaceState }, m); return; } // the sidebar's Collabs half — its dragged height AND its collapsed flag; collabsSection.ts
    if (typeof m.type === 'string' && CHAT_DENSITY_MESSAGE_TYPES.has(m.type)) { handleChatDensityMessage({ workspaceState: () => this.context.workspaceState }, m); return; } // t-qn0wj5 proposal 26 — chatDensity.ts
    if (typeof m.type === 'string' && SCHEDULE_TAB_MESSAGE_TYPES.has(m.type)) { handleScheduleTabMessage({ workspaceState: () => this.context.workspaceState }, m); return; } // t-ru1qsp — the Schedules view's last-picked tab; scheduleTab.ts
    if (typeof m.type === 'string' && MODEL_LIST_REFRESH_MESSAGE_TYPES.has(m.type)) { void this.refreshModelLists(); return; } // t-ttmo5w — the Connections Refresh button; modelListRefresh.ts
    if (typeof m.type === 'string' && WORKTREE_STATE_MESSAGE_TYPES.has(m.type)) { void handleWorktreeStateMessage({ post: (x) => this.post(x) }, m); return; } // t-ru1i84 — one throttled git read, two consumers; worktreeState.ts
    if (typeof m.type === 'string' && SESSION_DELETE_MESSAGE_TYPES.has(m.type)) { void handleSessionDeleteMessage({ ...this.engineArg(), openSessionIds: () => [...this.sessions.values()].map((x) => x.client?.currentSessionId ?? '').filter(Boolean), post: (x) => this.post(x) }, m); return; } // deleting a chat under a LIVE cell is the foot-gun; sessionDelete.ts owns every refusal
    // OAuth connections (ChatGPT / SuperGrok) — everything lives in providerAuthPane.ts.
    if (typeof m.type === 'string' && PROVIDER_AUTH_MESSAGE_TYPES.has(m.type)) { void handleProviderAuthMessage({ ...this.engineArg(), post: (x) => this.post(x), write: this.writeProviderConfig, openExternal: openExternalUrl, notifyReload: offerReload, refresh: (id) => { this.providerStatusCache.delete(id); void this.broadcastProviderStatus(true); } }, m); return; }
    // Subscription usage for an OAuth Lab fold. Read-only and lazy, so it takes
    // whichever session has a live engine rather than opening one.
    if (typeof m.type === 'string' && PROVIDER_USAGE_MESSAGE_TYPES.has(m.type)) { void handleProviderUsageMessage({ ...this.engineArg(), post: (x) => this.post(x) }, m); return; }
    if (typeof m.type === 'string' && GLIDEPATH_MESSAGE_TYPES.has(m.type)) { void handleGlidepathMessage(glidepathHost(this.context, () => this.engineArg(), (x) => this.post(x)), m); return; } // opening the Glidepath view is one of three sampling triggers; usageHistory.ts holds the 5-minute per-provider floor that keeps three triggers from being three reads
    // Connections "Claude (subscription, experimental)" card (t-tsw90t) — add
    // (disclosure + the ONE setting), disconnect, and its readiness, through
    // whichever engine can answer with no chat open (t-sh7cog); claudeSubscriptionCard.ts owns every reply.
    if (typeof m.type === 'string' && CLAUDE_SUBSCRIPTION_CARD_MESSAGE_TYPES.has(m.type)) { void handleClaudeSubscriptionCardMessage({ context: this.context, post: (x) => this.post(x), engineClient: async () => this.engineClient() }, m); return; }
    // Second opinion — one turn, reviewed by a model the user names. Grid-safe: the POSTING panel's session; secondOpinion.ts owns the protocol.
    // A posted id that does NOT resolve falls through to the error card rather than to the active chat — reviewing a DIFFERENT chat's turn would be worse than refusing. Same rule as `revertToMessage`.
    if (typeof m.type === 'string' && SECOND_OPINION_MESSAGE_TYPES.has(m.type)) { void handleSecondOpinionMessage({ session: (id) => (id ? this.sessions.get(id) : (this.getActiveSession() ?? undefined)), post: (x) => this.post(x) }, m); return; }
    if (typeof m.type === 'string' && FORK_CHAT_MESSAGE_TYPES.has(m.type)) { const src = sid ? this.sessions.get(sid) : undefined; if (sid && src) void src.gate.whenUp().then(() => forkChat(sid, this.forkHost())); return; } // the composer's Fork button; same grid rule as the line above: an id that does not resolve forks nothing. A fork needs the engine id: wait for it (engineGate.ts)
    if (typeof m.type === 'string' && TURN_MESSAGE_TYPES.has(m.type)) { routeTurnMessage(sid ? this.sessions.get(sid)?.gate : undefined, m, () => handleTurnMessage({ client: sid ? this.sessions.get(sid)?.client : null, sessionId: sid, session: sid ? this.sessions.get(sid) : undefined, post: (x) => this.post(x) }, m)); return; } // the RUNNING turn — background-shell stop + interject; turnMessages.ts
    // Open the Agent Manager board from any webview surface (composer's
    // Agents button, sidebar toolbar) — same path as the palette command.
    if (m.type === 'openAgentManager') {
      void DashboardPanel.openAgentManagerInEditor(this.context);
      return;
    }
    if (m.type === 'engineRetry') { if (sid) void this.sessions.get(sid)?.gate.retry(); return; } // Retry on a failed engine start's card (engineGate.ts)
    // Open a race group's Compare screen in its own editor tab - a UI/tab concern, not routed to
    // the manager.
    if (m.type === 'amOpenCompare') { void DashboardPanel.openRaceCompareInEditor(this.context, m.params as RaceCompareParams); return; }
    // Open a repo's architecture-map screen in its own editor tab - reads+validates map.json, then
    // hands off to mapTab.ts.
    if (m.type === 'amOpenMap') { void DashboardPanel.openRepoMapInEditor(this.context, String(m.root ?? '')); return; }
    // The sidebar reports its grid layout; grid tiles every session visibly (forward asks,
    // never auto-decide). Entering grid MOUNTS every session, so replay any buffered question.
    if (m.type === 'chatGridMode') { const wasGrid = this.sidebarGridMode; this.sidebarGridMode = m.grid === true; if (this.sidebarGridMode && !wasGrid) for (const s of this.sessions.values()) this.replayBufferedQuestionFor(s, (msg) => this.post(msg)); this.saveOpen(); return; }

    switch (m.type) {
      case 'send': {
        const text = ((m.text as string | undefined) ?? '').trim();
        const session = sid ? this.sessions.get(sid) : null;
        // /compose may arrive with no args (it opens an interview), so empty text is
        // allowed when a mode is set; every other send requires text.
        const hasMode = typeof m.mode === 'string' && (m.mode as string).length > 0;
        if ((!text && !hasMode) || !session) return;
        // Monthly spend cap: hard-block a CLOUD turn once spend hits the cap. Local
        // turns are free — never blocked. (Warn-at-80% is a webview banner.)
        if (this.budgetBlocksTurn(session)) { this.postBudgetBlock(sid ?? ''); this.post({ type: 'turnDone', stopReason: 'blocked', sessionId: sid }); return; }
        // Nudge a reload if origami-acp was rebuilt while this window kept the old
        // process — otherwise the user is testing stale code.
        this.maybeWarnStaleBinary(session);
        const rawImages = Array.isArray(m.images) ? m.images as Array<{ dataUrl: string; name: string }> : [];
        const imageDataUrls = rawImages.map(img => img.dataUrl).filter(Boolean);
        // Mode commands (/loop, /compose) arrive as a send with `text` =
        // the args; show the "/mode" prefix in the transcript so history reads right.
        const mode = typeof m.mode === 'string' ? m.mode : '';
        const echoText = mode ? `/${mode} ${text}`.trim() : text;
        // Echo BEFORE any probe: reprobeModel carries two 4s timeouts, and on a provider
        // that never answers an LM Studio-shaped probe it stalled every send's echo by ~8s.
        this.post({ type: 'echoUser', text: echoText, sessionId: sid, images: imageDataUrls.length > 0 ? imageDataUrls : undefined });
        session.messageLog.push({ kind: 'user', text: echoText, timestamp: Date.now() });
        // If we still don't think the model is loaded, try once more — LM Studio may have
        // started since. Fire-and-forget: it refreshes a status pill, never gates the prompt.
        if (!this.modelInfo.ok) void this.reprobeModel();
        // Name the chat from the first user message (slug now, engine title later).
        this.setProvisionalTitle(session, sid!, text);
        const images = this.parseImages(rawImages);
        // /loop — a time-interval SCHEDULER: re-run a prompt on a timer until stopped.
        if (mode === 'loop') {
          const cmd = parseLoopCommand(text);
          if (cmd.action === 'stop') {
            if (session.loopSchedule) this.stopLoopSchedule(session, sid!, 'Loop stopped.');
            else this.post({ type: 'system', text: 'No loop is active.', sessionId: sid });
            this.post({ type: 'turnDone', stopReason: 'idle', sessionId: sid });
            break;
          }
          if (cmd.action === 'usage') {
            this.post({ type: 'system', text: 'Usage: /loop <interval> <prompt> — re-runs on a timer, e.g. /loop 30m triage newly failing tests. /loop stop to cancel. Unsure? Try /compose.', sessionId: sid });
            this.post({ type: 'turnDone', stopReason: 'idle', sessionId: sid });
            break;
          }
          this.startLoopSchedule(session, sid!, cmd.intervalMs, cmd.prompt);
          break;
        }
        if (mode === 'compose') {
          session.turnBusy = true;
          try {
            const turn = await session.gate.turn(() => session.client.prompt(buildComposePrompt(text))); // waits for the engine, in order (engineGate.ts)
            if (!turn.sent) { this.post({ type: 'turnDone', stopReason: turn.why, sessionId: sid }); break; }
            const stopReason = turn.value;
            session.estimatedTokens++;
            await this.pollControllerState(session, sid!);
            this.post({ type: 'turnDone', stopReason, sessionId: sid });
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            this.post({ type: 'error', message: `Compose failed: ${errMsg}`, sessionId: sid });
            this.post({ type: 'turnDone', stopReason: 'error', sessionId: sid });
          } finally {
            session.turnBusy = false;
          }
          break;
        }
        session.turnBusy = true;
        try {
          // Sent before the engine is up: it waits here, in order (engineGate.ts).
          const turn = await session.gate.turn(() => session.client.prompt(text, images.length > 0 ? images : undefined));
          if (!turn.sent) { this.post({ type: 'turnDone', stopReason: turn.why, sessionId: sid }); break; }
          const stopReason = turn.value;
          session.estimatedTokens++;
          await this.pollControllerState(session, sid!);
          this.post({ type: 'turnDone', stopReason, sessionId: sid });
          void this.refreshEngineTitle(session, sid!);
          // A successful reply proves the model is reachable. Reprobe to pick up the real
          // model id; if the probe still fails, mark online anyway with the settings.toml
          // model name as the label.
          if (!this.modelInfo.ok) {
            await this.reprobeModel().catch(() => { /* ignore */ });
            if (!this.modelInfo.ok) {
              const settingsNow = readSettings();
              this.modelInfo = {
                ok: true,
                modelId: settingsNow.model || 'inference online',
                contextLength: this.contextWindow,
                state: 'inferred',
              };
              this.broadcastModelStatus();
            }
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          const errData = (e as any)?.data ? ` — ${JSON.stringify((e as any).data)}` : '';
          this.post({ type: 'error', message: `prompt failed: ${errMsg}${errData}`, sessionId: sid });
          this.post({ type: 'turnDone', stopReason: 'error', sessionId: sid });
        } finally {
          session.turnBusy = false;
        }
        break;
      }
      case 'permission': {
        const toolCallId = m.toolCallId as string | undefined;
        const optionId = (m.optionId as string | null | undefined) ?? null;
        // Free text from a question's "Other" option. Trimmed-empty is the same as absent:
        // an empty _meta.answerText would tell the engine the user answered with nothing.
        const rawAnswer = typeof m.answerText === 'string' ? m.answerText.trim() : '';
        const answerText = rawAnswer || undefined;
        // A BATCHED question reply: one entry per question the modal showed, in the order
        // it showed them. Only present when the ask carried more than one question — a
        // single ask still replies with optionId alone.
        const answers = questionAnswers(m.answers);
        const session = sid ? this.sessions.get(sid) : null;
        if (!toolCallId || !session) return;
        commitPersistablePermission(this.context.workspaceState, toolCallId, optionId); // Feature 1 — an allow_always reply persists its rule across engine restarts
        const entry = session.pendingPermissions.get(toolCallId);
        if (entry) {
          session.pendingPermissions.delete(toolCallId);
          DashboardPanel.syncTabIcon(this.context, session.id, session.pendingPermissions.size); // t-q6jxrs
          entry.respond(optionId, answerText, answers);
          this.post({
            type: 'permissionAudit',
            toolCallId,
            action: optionId ? 'approved' : 'denied',
            optionId: optionId ?? 'cancelled',
            timestamp: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
          });
        }
        // Answering a buffered question-permission clears its board chip + buffer (the run stays in
        // progress).
        if (sid && this.pendingQuestionPermissions.get(sid)?.toolCallId === toolCallId) { this.pendingQuestionPermissions.delete(sid); this.agentManagerInstance?.setAgentQuestion(sid, null); }
        break;
      }
      case 'planAction': {
        const session = sid ? this.sessions.get(sid) : null;
        if (!session?.client) return;
        const action = m.action as string | undefined;
        const feedback = m.feedback as string | undefined;
        const planId = m.planId as string | undefined;
        // select_alternative carries `altIndex` from the best-of-N tab bar. The Rust
        // handler reads `alt_index`.
        const rawAltIndex = m.altIndex;
        const altIndex = typeof rawAltIndex === 'number' ? rawAltIndex : undefined;
        // The ACP server's sessions map is keyed by the id IT minted; the dashboard's
        // `sid` is a local sequential identifier (`session-N`) that always misses that
        // lookup. engineSessionId.ts resolves it with NO fallback: no engine session yet
        // means say so, not send `sid`.
        const acpSessionId = engineSessionId(session.client, sid);
        if (!acpSessionId) { this.post({ type: 'error', message: 'plan_action failed: this chat has no live engine session yet.', sessionId: sid }); return; }
        const params: Record<string, unknown> = {
          action: action || '',
          feedback: feedback || '',
          plan_id: planId || '',
          session_id: acpSessionId,
        };
        if (altIndex !== undefined) {
          params.alt_index = altIndex;
        }
        // Plan advances via the normal `plan_action` verbs (approve / reject / refine /
        // select_alternative). On `approve` the origami-acp bridge seeds and drives
        // execution itself, so the client just fires the verb and lets the bridge's event
        // stream report progress.
        (async () => {
          try {
            await session.client!.extMethod('plan_action', params);
          } catch (e: unknown) {
            // JSON-RPC errors carry the precise failure reason in `data.reason`; the
            // protocol-level `.message` is always the generic "Invalid params" / "Internal
            // error" string. Pull data.reason out first so the chat says which guard tripped.
            const errAny = e as { message?: unknown; data?: { reason?: unknown } };
            const dataReason = typeof errAny?.data?.reason === 'string'
              ? errAny.data.reason
              : undefined;
            const baseMsg = e instanceof Error ? e.message : String(e);
            const errMsg = dataReason ? `${baseMsg}: ${dataReason}` : baseMsg;
            this.post({ type: 'error', message: `plan_action failed: ${errMsg}`, sessionId: sid });
          }
        })();
        break;
      }
      case 'cancel': {
        const session = sid ? this.sessions.get(sid) : null;
        if (!session) return;
        // Stop also clears an active /loop schedule (stop means stop, not just this run).
        if (session.loopSchedule) this.stopLoopSchedule(session, sid!, 'Loop schedule stopped.');
        session.gate.drop(); // a prompt still waiting for the engine is not sent after Stop
        session.client.cancel().catch(e => console.error('[origami] cancel failed', e));
        drainPermissions(session.pendingPermissions);
        DashboardPanel.syncTabIcon(this.context, session.id, 0); // t-q6jxrs — Stop drains every open ask
        // Stop unsticks + drops any buffered question-permission and its board chip.
        if (sid) { this.pendingQuestionPermissions.delete(sid); this.agentManagerInstance?.setAgentQuestion(sid, null); }
        break;
      }
      case 'compactContext': {
        // Click-the-gauge -> run the engine's existing `/compact` command
        // (detectSlashCommand -> session.summarize). The confirm already happened in the
        // branded in-webview ConfirmModal. Honest feedback: refresh the gauge after and
        // surface any failure — no fake "compacted" if the engine rejected it.
        const targetSid = (m.sessionId as string | undefined) ?? this.activeSessionId ?? undefined;
        const session = targetSid ? this.sessions.get(targetSid) : null;
        if (!session?.client) return;
        vscode.window.setStatusBarMessage('Origami: compacting context…', 5000);
        // Drop the inline "Compacting…" marker immediately, driven by the CLICK — so it
        // ALWAYS appears, even when the summary streams no text. Engine-tagged summary
        // chunks fill its carried-forward body; turnDone settles it to "Completed".
        this.post({ type: 'compactionStart', sessionId: targetSid });
        try {
          const turn = await session.gate.turn(() => session.client.prompt('/compact')); // waits for the engine, in order (engineGate.ts)
          if (!turn.sent) { this.post({ type: 'compactionEnd', ok: false, sessionId: targetSid }); break; }
          // Compaction actually finished — settle the inline marker to "Completed" NOW: the
          // manual /compact turn emits no normal turnDone. Also flags the gauge drop as
          // pending, since the reduction is lazy and lands on the next real turn.
          this.post({ type: 'compactionEnd', ok: true, sessionId: targetSid });
          vscode.window.setStatusBarMessage('Origami: context compacted', 3000);
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          this.post({ type: 'compactionEnd', ok: false, sessionId: targetSid });
          this.post({ type: 'error', message: `Compaction failed: ${errMsg}`, sessionId: targetSid });
        }
        break;
      }
      case 'newSession': {
        const requested = typeof m.agentName === 'string' ? m.agentName : undefined;
        await this.createSession(requested);
        break;
      }
      case 'openSkillFile': {
        // Skills pane Edit button — opens the skill's own SKILL.md in the real editor.
        // `location` is a webview message field, so treat it as untrusted: only ever act on
        // a path that actually ends in SKILL.md, the one file `list_skills` names here.
        const location = String(m.location || '').trim();
        if (!location || !location.toLowerCase().endsWith('skill.md')) break;
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(location));
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (e) {
          vscode.window.showErrorMessage(`Could not open ${location}: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }
      case 'listLoopSchedules': {
        // Loops pane — live /loop schedules across open chats, plus any
        // persisted loop whose session isn't back yet (loopSchedulesPayload).
        this.post({ type: 'loopSchedulesData', ...this.loopSchedulesPayload() });
        break;
      }
      case 'cancelLoopSchedule': {
        // Loops pane row cancel. `sid` is a LOCAL session id for a live row, stopped via
        // the same stopLoopSchedule path /loop stop uses. A needs-attention row has no
        // live session, so `sid` there is the persisted ENGINE session id instead; the two
        // id spaces never collide, so a plain lookup tells them apart. Re-broadcast fresh
        // data either way, so the row disappears without a Reload.
        const session = sid ? this.sessions.get(sid) : null;
        if (session?.loopSchedule) {
          this.stopLoopSchedule(session, sid!, 'Loop cancelled from the Loops pane.');
        } else if (sid) {
          removePersistedLoop(this.context.workspaceState, sid);
        }
        this.post({ type: 'loopSchedulesData', ...this.loopSchedulesPayload() });
        break;
      }
      case 'reopenLoopChat': {
        // Loops pane — bring back the chat of a loop that has none. Same two id spaces as
        // cancel above; agentManager/loopReopen.ts resolves which. Always re-broadcast:
        // the row moves between buckets either way, including on a failed recall.
        await this.reopenLoopChatFor(sid ?? '');
        this.post({ type: 'loopSchedulesData', ...this.loopSchedulesPayload() });
        break;
      }
      case 'setLoopPersistent': {
        // Loops pane toggle. Flips BOTH halves of the pair — the live schedule (which
        // closeSession reads) and the persisted record (which boot reads) — so the two
        // can never disagree about whether this loop survives its chat.
        const persistent = m.persistent === true;
        const session = sid ? this.sessions.get(sid) : null;
        if (session?.loopSchedule) {
          session.loopSchedule.persistent = persistent;
          this.persistLoopSchedule(session);
        } else if (sid) {
          // A needs-attention row has no live session; `sid` is the engine id.
          setPersistedLoopPersistence(this.context.workspaceState, sid, persistent);
        }
        this.post({ type: 'loopSchedulesData', ...this.loopSchedulesPayload() });
        break;
      }
      case 'requestRunSteps': {
        // Labyrinth pane — a PAST run's steps via `run_steps`. Read-only: the
        // engine projects stored messages, it never resumes the session.
        const sid = typeof m.sessionId === 'string' ? m.sessionId : '';
        const runCwd = typeof m.cwd === 'string' ? m.cwd : '';
        if (isClaudeRunId(sid)) { this.post({ type: 'runStepsData', ...(await claudeStepsPayload(sid, runCwd)) }); break; } // t-47bk8j: a `claude:` id is a transcript, never an engine session (claudeLabyrinth.ts)
        this.post({ type: 'runStepsData', ...(await runStepsPayload(this.engineClient(), sid, runCwd)) });
        break;
      }
      case 'requestRunStats': {
        // Labyrinth run index — per-run counts for the LISTED page, one call.
        // Deliberately not folded into `requestHistory`: each id costs the engine a whole
        // `session.messages` read, and the chat history dropdown waits on that wire too.
        this.post({ type: 'runStatsData', ...(await runStatsPayload(this.engineClient(),statIds(m.sessionIds), typeof m.cwd === 'string' ? m.cwd : '')) });
        break;
      }
      case 'requestCollabSteps': {
        // Labyrinth pane - a whole COLLAB as one map: every member's own run,
        // merged and lane-stamped per member. Read-only, like requestRunSteps.
        const collabId = typeof m.collabId === 'string' ? m.collabId : '';
        const runCwd = typeof m.cwd === 'string' ? m.cwd : '';
        this.post({ type: 'runStepsData', ...(await collabStepsPayload(this.engineClient(), collabId, runCwd)) });
        break;
      }
      case 'requestSubagentTranscript': {
        // Sub-agent drawer — a settled child's OWN transcript, drawn with the chat's
        // renderer instead of the flat stream log. Read-only, like requestRunSteps.
        const child = typeof m.sessionId === 'string' ? m.sessionId : '';
        const childCwd = typeof m.cwd === 'string' ? m.cwd : '';
        // t-krxap7. The HOST owns the page size, not the webview: one setting read
        // in one place, so a user who changes it gets the new size on the next open
        // without the panel carrying a stale copy. 0 (or a broken value) is the
        // whole-transcript read this method made before paging existed.
        const raw = vscode.workspace.getConfiguration().get<number>('origamicoder.subagents.transcriptPageSize');
        const pageSize = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
        const before = typeof m.before === 'string' ? m.before : '';
        this.post({
          type: 'subagentTranscriptData',
          ...(await subagentTranscriptPayload(this.engineClient(), child, childCwd, {
            limit: pageSize,
            ...(pageSize > 0 && before ? { before } : {}),
          })),
        });
        break;
      }
      case 'listInstructions': {
        // Instructions pane — everything feeding the system prompt, sizes only.
        this.post({ type: 'instructionsData', ...(await instructionsPayload(this.engineClient())) });
        break;
      }
      case 'openBasePrompt': {
        // Instructions pane — the pinned override rows. Editing one means editing a file that
        // usually does not exist yet, so this SEEDS it with the effective built-in text first. The
        // payload carries a KIND and no path, deliberately: the target is read from
        // `list_instructions` and re-checked against that kind's filename, so a compromised webview
        // cannot aim the write anywhere.
        const spec = OVERRIDE_PROMPTS[overrideKind(m.kind)];
        const client = this.engineClient();
        if (!client) {
          vscode.window.showErrorMessage(`Open a chat first — editing the ${spec.label} needs a live engine connection.`);
          break;
        }
        try {
          const base = (await client.listInstructions())?.[spec.field];
          if (!base?.path || path.basename(base.path) !== spec.file) {
            vscode.window.showErrorMessage(`This engine build does not expose an editable ${spec.label}.`);
            break;
          }
          const uri = vscode.Uri.file(base.path);
          // ABSENT: show the built-in and write NOTHING. Seeding here made every user an
          // overrider on their first click — the file froze at that day's built-in and from
          // then on silently outranked every later edit to the shipped prompt. An UNTITLED
          // buffer carrying the real path renders the text for editing, creates no file
          // until the user saves, and then saves to THAT path with no Save As prompt.
          const present = await vscode.workspace.fs.stat(uri).then(() => true, () => false);
          const doc = await vscode.workspace.openTextDocument(present ? uri : uri.with({ scheme: 'untitled' }));
          const editor = await vscode.window.showTextDocument(doc, { preview: false });
          // Empty-check: reopening a draft the user has already typed into must
          // not lay the built-in down a second time underneath their edits.
          if (!present && doc.getText().length === 0) {
            await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), base.text));
          }
        } catch (e) {
          vscode.window.showErrorMessage(
            `Could not open the ${spec.label}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        break;
      }
      case 'createInstructionFile': {
        // Instructions pane — the "+ New file" card, the one write that closes the inventory's
        // read-only gap. The target is computed HERE from `this.cwd`, never taken from the payload:
        // a compromised webview must not aim a write at a path of its choosing. AGENTS.md is the
        // only file this seeds. ABSENT: seed it with the SAME /firstfold template "Restore default"
        // uses, so the two cannot drift. PRESENT: open it untouched.
        const target = path.join(this.cwd, 'AGENTS.md');
        const uri = vscode.Uri.file(target);
        try {
          try {
            await vscode.workspace.fs.stat(uri);
          } catch {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(agentsMdTemplate(this.cwd), 'utf8'));
          }
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (e) {
          vscode.window.showErrorMessage(
            `Could not create AGENTS.md: ${e instanceof Error ? e.message : String(e)}`,
          );
          break;
        }
        // The new file feeds the prompt from now on, so refresh the inventory the way
        // the pane's own button would, rather than leaving a list that omits it.
        this.post({ type: 'instructionsData', ...(await instructionsPayload(this.engineClient())) });
        break;
      }
      case 'promptCapture': {
        // Instructions pane — what that SAME active chat last sent the model. Same session
        // pick as listInstructions, so the two can never describe different chats.
        const session = this.getActiveSession() ?? [...this.sessions.values()][0];
        this.post({ type: 'promptCaptureData', ...(await promptCapturePayload(session?.client)) });
        break;
      }
      case 'dismissSubagent': {
        // A drawer row retired — by the row's × or the failed-spawn dismiss (t-h8gv8w:
        // nothing else retires one; a finished row is history the drawer keeps). Ridden on the session log (t-fiszlv R9), which is what a
        // reopened chat is rebuilt from: webview state alone put every removed row back on
        // the next reload. The webview has already dropped it, so nothing is posted back.
        const dismissing = typeof m.sessionId === 'string' ? this.sessions.get(m.sessionId) : undefined;
        if (dismissing && typeof m.key === 'string') {
          noteSubagentDismissed(this.context.workspaceState, dismissing.client?.currentSessionId, m.key);
        }
        break;
      }
      case 'cacheStats': {
        // Insights pane — the cache-hit-ratio card. Same active-chat pick as above.
        const session = this.getActiveSession() ?? [...this.sessions.values()][0];
        this.post({ type: 'cacheStatsData', ...(await cacheStatsPayload(session?.client)) });
        break;
      }
      case 'restoreInstructionDefault': {
        // Instructions pane — the "Restore default" button. The webview carries ONLY a
        // `kind`, never a path: every target below is resolved HERE, from a trusted source,
        // so a compromised webview cannot aim this destructive write anywhere else.
        const kind =
          m.kind === 'base-prompt' || m.kind === 'agents-md' || m.kind === 'collab-agent-base'
            ? m.kind
            : null;
        if (!kind) break;
        const client = this.engineClient();
        if (kind !== 'agents-md') {
          // Every override prompt restores the same way: DELETE the user's
          // file and let the engine fall back to the built-in it ships.
          const spec = OVERRIDE_PROMPTS[kind];
          if (!client) {
            vscode.window.showErrorMessage(`Open a chat first — restoring the ${spec.label} needs a live engine connection.`);
            break;
          }
          let base;
          try {
            base = (await client.listInstructions())?.[spec.field];
          } catch (e) {
            vscode.window.showErrorMessage(`Could not read the ${spec.label}: ${e instanceof Error ? e.message : String(e)}`);
            break;
          }
          if (!base?.path || path.basename(base.path) !== spec.file) {
            vscode.window.showErrorMessage(`This engine build does not expose an editable ${spec.label}.`);
            break;
          }
          if (!base.overridden) break; // nothing to restore — a stale row, not a real request
          const choice = await vscode.window.showWarningMessage(
            `Restore the built-in ${spec.label}? This overwrites your custom text and cannot be undone.`,
            { modal: true },
            'Restore default',
          );
          if (choice !== 'Restore default') break;
          try {
            await vscode.workspace.fs.delete(vscode.Uri.file(base.path));
          } catch (e) {
            vscode.window.showErrorMessage(`Could not restore the ${spec.label}: ${e instanceof Error ? e.message : String(e)}`);
            break;
          }
        } else {
          // agents-md: the workspace's OWN AGENTS.md, computed from `this.cwd`
          // — never the path an entry in the webview's payload might carry.
          const target = path.join(this.cwd, 'AGENTS.md');
          const choice = await vscode.window.showWarningMessage(
            'Restore AGENTS.md to the /firstfold default? This overwrites your edits and cannot be undone.',
            { modal: true },
            'Restore default',
          );
          if (choice !== 'Restore default') break;
          try {
            await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(agentsMdTemplate(this.cwd), 'utf8'));
          } catch (e) {
            vscode.window.showErrorMessage(`Could not restore AGENTS.md: ${e instanceof Error ? e.message : String(e)}`);
            break;
          }
        }
        // Same refresh path listInstructions uses, so the badge/row updates
        // exactly as it would from the pane's own refresh button.
        this.post({ type: 'instructionsData', ...(await instructionsPayload(client)) });
        break;
      }
      // --- Crons view: scheduled runs that fire with VS Code CLOSED. All the logic
      // lives in dashboard/crons/*; these cases are wiring only. Every mutation reports
      // back through `cronOpResult` so the pane can show the refusal reason instead of
      // failing silently.
      case 'listCrons': {
        this.post({ type: 'cronsData', ...(await this.cronService().list()) });
        break;
      }
      case 'createCron':
      case 'updateCron':
      case 'setCronEnabled':
      case 'deleteCron':
      case 'runCronNow': {
        const svc = this.cronService();
        const id = typeof m.id === 'string' ? m.id : '';
        const draft = m.draft as { name: string; prompt: string; schedule: unknown; agent?: string; model?: string };
        let res;
        if (m.type === 'createCron') res = await svc.create(draft);
        else if (m.type === 'updateCron') res = await svc.update(id, draft);
        else if (m.type === 'setCronEnabled') res = await svc.setEnabled(id, m.enabled === true);
        else if (m.type === 'deleteCron') res = await svc.remove(id);
        else res = await svc.runNow(id);
        this.post({ type: 'cronOpResult', ...res });
        if (res.ok) this.post({ type: 'cronsData', ...(await svc.list()) });
        break;
      }
      case 'openCronLog': {
        const id = typeof m.id === 'string' ? m.id : '';
        if (!id) break;
        const logFile = cronLogPath(findWorkspacePath() ?? this.cwd, id);
        if (!fs.existsSync(logFile)) {
          vscode.window.showInformationMessage(`Origami: this cron has not written a log yet (${cronLogRelPath(id)}).`);
          break;
        }
        void vscode.window.showTextDocument(vscode.Uri.file(logFile), { preview: true });
        break;
      }
      case 'activeSessionChanged': {
        // The webview tells us which tab the user has focused. Mirror to local state and
        // persist so the next dashboard open can replay it. Validated against the session
        // map so a stale/garbled id can't poison workspaceState.
        const sid = typeof m.sessionId === 'string' ? m.sessionId : null;
        if (sid && this.sessions.has(sid)) {
          this.activeSessionId = sid;
          void this.context.workspaceState.update(DashboardPanel.ACTIVE_SESSION_KEY, sid); this.saveOpen(); // Feature 2 — persist the open-set (incl. active engine id) AND keep the single-active fallback (ACTIVE_SESSION_KEY) fresh for the engine-offline restore path.
          // Permission mode is per-session. Repaint the banner from the newly-focused
          // session's tracked mode so it follows the active tab.
          this.paintPermissionBanner();
          // Model is per-session (each chat holds its own). Re-broadcast the newly-focused
          // session's model + selectors, plus the per-session model map, so every visible
          // cell shows its own model.
          void this.broadcastModelOptions();
          this.broadcastConfigSelectors();
          this.broadcastSessionModels();
          // Window/vision are per-session too: re-probe the newly-focused session's ACTIVE
          // model provider-aware, so switching to a remote (vLLM/Spark) tab surfaces ITS
          // real context window, not the last-focused chat's or a stale boot-time 0.
          void this.refreshActiveModelInfo();
        }
        break;
      }

      case 'modelPanel.refresh': {
        // The ControlStrip ↻ reload — re-probe the loaded model + context and
        // re-broadcast honest status.
        await this.reprobeModel();
        // Best-effort VRAM pressure for the status bar, when a session exists.
        const anySession = this.sessions.values().next().value;
        if (anySession?.client) {
          try {
            const vr = await anySession.client.extMethod('get_vram_state', {}).catch(() => ({}));
            const vramGpu = ((vr as { gpus?: Array<{ vram_total_mb: number; vram_used_mb: number }> })?.gpus ?? [])[0];
            if (vramGpu && vramGpu.vram_total_mb > 0) statusBarRef?.setVram((vramGpu.vram_used_mb / vramGpu.vram_total_mb) * 100);
          } catch { /* best-effort */ }
        }
        break;
      }
      case 'modelPanel.unload': {
        // Eject a model (or all). Direct `lms unload` with an explicit
        // identifier / --all keeps it non-interactive.
        const identifier = typeof m.identifier === 'string' ? m.identifier : undefined;
        const sid = this.activeSessionId ?? '';
        const op = this.modelOps.begin(sid, `ejecting ${identifier ?? 'all models'} in ${this.sessions.get(sid)?.title || sid || 'this chat'}`);
        if (!op) { this.post({ type: 'system', text: this.modelOps.busyMessage(sid), sessionId: sid }); break; }
        try {
          const r = await runLms(identifier ? ['unload', identifier] : ['unload', '--all']);
          if (!r.ok) {
            const reason = (r.stderr || r.stdout || 'unknown').trim().slice(0, 300);
            this.post({ type: 'system', text: `Could not eject model — ${reason}`, sessionId: sid });
            this.post({ type: 'modelPanel.error', error: `unload failed: ${reason}` });
          } else {
            await this.reprobeModel();
            this.post({ type: 'system', text: identifier ? `Ejected ${identifier}.` : 'Ejected all models.', sessionId: sid });
            this.post({ type: 'modelPanel.actionDone' });
          }
        } finally {
          op.release();
        }
        break;
      }
      // Swap the ACTIVE model: unload everything, then load the target at the chosen
      // context via the `lms` CLI (the engine's set_active_model arm returns
      // {loaded:false, "serving not wired"}). Probes the REAL loaded state afterwards
      // so the context shown is honest, not what we requested.
      case 'modelPanel.swap': {
        let modelKey = typeof m.modelKey === 'string' ? m.modelKey : undefined;
        if (!modelKey) { this.post({ type: 'modelPanel.error', error: 'Missing modelKey' }); break; }
        // Accept both a bare LM Studio id and the dropdown's `<provider>/<id>` value —
        // `runLms load` wants the bare id. Only strip the known local-provider prefix.
        {
          const lp = detectLocalProvider();
          if (lp && modelKey.startsWith(lp.id + '/')) modelKey = modelKey.slice(lp.id.length + 1);
        }
        const sid = this.activeSessionId ?? '';
        const op = this.modelOps.begin(sid, `loading ${modelKey} in ${this.sessions.get(sid)?.title || sid || 'this chat'}`);
        if (!op) { this.post({ type: 'system', text: this.modelOps.busyMessage(sid), sessionId: sid }); break; }
        try {
          // The ctx is the user's ControlStrip input; a safe default if unset —
          // never the model's declared max.
          const ctx = typeof m.contextLength === 'number' && m.contextLength > 0 ? m.contextLength : DEFAULT_LOAD_CTX;
          this.post({ type: 'system', text: `Loading ${modelKey} at ${Math.round(ctx / 1024)}k ctx…`, sessionId: sid });
          await runLms(['unload', '--all']);
          const r = await runLms(['load', modelKey, '-c', String(ctx), '--gpu', 'max', '-y']);
          if (!r.ok) {
            const reason = (r.stderr || r.stdout || 'unknown').trim().slice(0, 300);
            this.post({ type: 'system', text: `Could not load ${modelKey} — ${reason}`, sessionId: sid });
            this.post({ type: 'modelPanel.error', error: `swap failed: ${reason}` });
            await this.reprobeModel(); // reflect the now-empty state honestly
          } else {
            // Persist as the default so new sessions agree.
            try {
              const lp = detectLocalProvider();
              if (lp) writeModelConfig({ providerId: lp.id, providerName: lp.name, modelId: modelKey, modelName: modelKey });
            } catch (e) { console.error('[origami] could not persist swapped model:', e); }
            await this.reprobeModel();
            const loadedCtx = this.modelInfo.contextLength;
            this.post({ type: 'system', text: `Loaded ${this.modelInfo.modelId || modelKey}${loadedCtx > 0 ? ` at ${Math.round(loadedCtx / 1024)}k ctx` : ''}.`, sessionId: sid });
            this.post({ type: 'modelPanel.actionDone' });
          }
        } finally {
          op.release();
        }
        break;
      }
      // t-qn0lpl — "Reveal shot" on the chat's browser strip. A frame is held in
      // the webview's heap and NOWHERE else (webview/dashboard/panes/browserFrames.ts
      // says why: a picture of a page as it was an hour ago, replayed as current, is
      // worse than no picture). So the bytes arrive here and the file is written on
      // demand, into this extension's own storage — never the workspace, which is the
      // user's repository and not a scratch folder.
      case 'revealBrowserFrame': {
        const dataUrl = String(m.imageDataUrl || '');
        const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        if (!dataUrl.startsWith('data:image/') || !b64) break;
        const dir = vscode.Uri.joinPath(this.context.globalStorageUri, 'browser-frames');
        const stamp = Number(m.ts) > 0 ? Number(m.ts) : Date.now();
        const file = vscode.Uri.joinPath(dir, `${String(m.action || 'frame').replace(/[^a-z0-9]/gi, '')}-${stamp}.png`);
        try {
          await vscode.workspace.fs.createDirectory(dir);
          await vscode.workspace.fs.writeFile(file, Buffer.from(b64, 'base64'));
          await vscode.commands.executeCommand('revealFileInOS', file);
        } catch (error) {
          vscode.window.showErrorMessage(`Could not save the browser frame: ${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }
      case 'revealInExplorer': {
        // t-qmzegs item 5 — a tool card's path answers "where is this?", and
        // the answer is the FOLDER. `revealFileInOS` is VS Code's own verb for
        // it (Explorer on Windows, Finder on macOS, the desktop's file manager
        // on Linux), so nothing here has to know which OS it is on.
        //
        // The path is resolved exactly as `openAbsoluteFile` below resolves
        // one, INCLUDING its escape guard: a card's path may be absolute (the
        // read-image rider is) or workspace-relative (a model's raw argument
        // often is), and a relative path that climbs out of the workspace must
        // not be able to point the OS at somewhere the workspace does not
        // reach. Refused outright from a phone (remoteRefusalsTable.ts) — there
        // is no explorer on the other end of a pocket.
        const fsPath = resolveCardPath(String(m.path || ''), findWorkspacePath());
        if (!fsPath) break;
        try {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(fsPath));
        } catch (e) {
          vscode.window.showErrorMessage(`Could not reveal ${fsPath}: ${e}`);
        }
        break;
      }
      case 'openAbsoluteFile': {
        const rawPath = String(m.path || '').trim();
        // Default to the real EDITOR, not the rendered markdown preview: opening a file
        // to READ/EDIT it is what a clicked tool-card path means, and
        // `markdown.showPreview` silently no-ops when invoked from a webview panel.
        // Preview is opt-in — only a caller that passes `preview:true` gets it.
        const preview = m.preview === true;
        if (!rawPath) break;
        // Agent-reported paths may be absolute (tool cards) or workspace-relative.
        // Resolve relatives against the workspace root with the same escape-guard as
        // openWorkspaceFile below; leave absolutes untouched.
        let fsPath = rawPath;
        if (!path.isAbsolute(rawPath)) {
          const wsPath = findWorkspacePath();
          if (!wsPath) {
            vscode.window.showErrorMessage(`Could not open ${rawPath}: no workspace folder to resolve it against.`);
            break;
          }
          const wsRoot = path.resolve(wsPath);
          fsPath = path.resolve(path.join(wsRoot, rawPath));
          if (!fsPath.startsWith(wsRoot + path.sep) && fsPath !== wsRoot) break;
        }
        // 1-based line -> 0-based Position. A valid line forces the text editor (never
        // the .md preview, which cannot reveal a line). Validate the FLOORED result so a
        // fractional value can't produce a negative Position.
        const rawLine = Number(m.line);
        const zeroBased = Math.floor(rawLine) - 1;
        const line = Number.isFinite(rawLine) && zeroBased >= 0 ? zeroBased : undefined;
        try {
          const uri = vscode.Uri.file(fsPath);
          if (preview && line === undefined && fsPath.toLowerCase().endsWith('.md')) {
            await vscode.commands.executeCommand('markdown.showPreview', uri);
          } else {
            const doc = await vscode.workspace.openTextDocument(uri);
            const opts: vscode.TextDocumentShowOptions = { preview: true, viewColumn: vscode.ViewColumn.Beside };
            if (line !== undefined) {
              const pos = new vscode.Position(line, 0);
              opts.selection = new vscode.Range(pos, pos);
            }
            await vscode.window.showTextDocument(doc, opts);
          }
        } catch (e) {
          vscode.window.showErrorMessage(`Could not open ${rawPath}: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }
      case 'openWorkspaceFile': {
        const rel = String(m.relPath || '').trim();
        const preview = m.preview !== false; // default to preview for .md
        if (!rel) break;
        const wsPath = findWorkspacePath();
        if (!wsPath) break;
        const wsRoot = path.resolve(wsPath);
        const target = path.resolve(path.join(wsRoot, rel));
        if (!target.startsWith(wsRoot + path.sep) && target !== wsRoot) break;
        try {
          const uri = vscode.Uri.file(target);
          if (preview && target.toLowerCase().endsWith('.md')) {
            await vscode.commands.executeCommand('markdown.showPreview', uri);
          } else {
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
          }
        } catch (e) {
          vscode.window.showErrorMessage(`Could not open ${rel}: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }
      case 'toggleMode': {
        // Webview header badge click. Re-uses the command-palette path so the QuickPick
        // surface and the dashboard click drive the same code.
        await vscode.commands.executeCommand('origami.toggleMode');
        break;
      }
      case 'themeChanged': {
        const themeId = String(m.theme ?? '');
        // Remember it as the shared active theme (persisted) so a newly-opened
        // chat panel adopts it on mount (see the requestSessions handshake).
        if (themeId) this.currentTheme = themeId;
        // The in-panel switch is driven PURELY by the webview setting data-theme + the --og-* vars
        // — that already happened in applyTheme() before this message arrived. This handler is ONLY
        // the OPTIONAL workbench colour-theme sync and must never touch the in-panel switch. The
        // palettes ship as contributed workbench themes; 'custom' maps to the JSON the ThemeEditor
        // Save rewrites.
        const workbenchThemes: Record<string, string> = {
          meadow: 'Origami Meadow',
          harbour: 'Origami Harbour',
          ember: 'Origami Ember',
          midnight: 'Origami Midnight',
          custom: 'Origami Custom',
        };
        const targetTheme = workbenchThemes[themeId];
        // No contributed workbench theme for this id: the in-panel switch already
        // applied. Re-broadcast so BOTH views agree on the active theme, then stop.
        if (!targetTheme) {
          this.broadcastTheme(themeId);
          break;
        }
        this.broadcastTheme(themeId);

        const cfg = vscode.workspace.getConfiguration();
        const current = cfg.get<string>('workbench.colorTheme');
        if (current === targetTheme) break;

        const pref = vscode.workspace
          .getConfiguration('origami')
          .get<string>('syncVsCodeTheme', 'ask');

        let apply = false;
        if (pref === 'always') {
          apply = true;
        } else if (pref === 'ask') {
          const choice = await vscode.window.showInformationMessage(
            `Dashboard is now "${themeId}". Switch VS Code theme to "${targetTheme}" to match?`,
            'Yes',
            'No',
            'Always',
            'Never',
          );
          if (choice === 'Yes' || choice === 'Always') apply = true;
          if (choice === 'Always') {
            await vscode.workspace
              .getConfiguration('origami')
              .update('syncVsCodeTheme', 'always', vscode.ConfigurationTarget.Global);
          } else if (choice === 'Never') {
            await vscode.workspace
              .getConfiguration('origami')
              .update('syncVsCodeTheme', 'never', vscode.ConfigurationTarget.Global);
          }
        }

        if (apply) {
          await cfg.update(
            'workbench.colorTheme',
            targetTheme,
            vscode.ConfigurationTarget.Global,
          );
        }
        break;
      }
      case 'saveWorkbenchTheme': {
        // ThemeEditor Save: rewrite the "Origami Custom" contributed theme from the
        // user's --og-* palette and apply it to the whole workbench.
        const palette = m.palette && typeof m.palette === 'object'
          ? (m.palette as Record<string, string>)
          : null;
        if (palette) await this.writeCustomWorkbenchTheme(palette);
        break;
      }
      case 'sendWithImages': {
        // Same as 'send' but images come from InputBar paste/drag. Read sessionId off the
        // payload (set by InputBar at paste time) so a tab switch between paste and send
        // doesn't move the message off its original session; falls back to the live
        // activeSessionId when the webview hasn't stamped one.
        const text = (m.text as string | undefined)?.trim();
        const payloadSid = typeof m.sessionId === 'string' ? m.sessionId : null;
        const targetSid = (payloadSid && this.sessions.has(payloadSid))
          ? payloadSid
          : this.activeSessionId;
        const session = targetSid ? this.sessions.get(targetSid) : null;
        if (!text || !session) return;
        if (this.budgetBlocksTurn(session)) { this.postBudgetBlock(targetSid ?? ''); return; }
        const sessionId = targetSid!;
        const rawImages = Array.isArray(m.images) ? m.images as Array<{ dataUrl: string; name: string }> : [];
        const imageDataUrls = rawImages.map(img => img.dataUrl).filter(Boolean);
        // Echo before the probe — same rule as 'send': the probe never gates
        // the prompt and stalled the echo up to 8s on non-LM-Studio providers.
        this.post({ type: 'echoUser', text, sessionId, images: imageDataUrls.length > 0 ? imageDataUrls : undefined });
        if (!this.modelInfo.ok) void this.reprobeModel();
        this.setProvisionalTitle(session, sessionId, text);
        const images = this.parseImages(rawImages);
        session.turnBusy = true;
        try {
          const turn = await session.gate.turn(() => session.client.prompt(text, images.length > 0 ? images : undefined)); // same wait as 'send' (engineGate.ts)
          if (!turn.sent) { this.post({ type: 'turnDone', stopReason: turn.why, sessionId }); break; }
          const stopReason = turn.value;
          session.estimatedTokens++;
          await this.pollControllerState(session, sessionId);
          this.post({ type: 'turnDone', stopReason, sessionId });
          void this.refreshEngineTitle(session, sessionId);
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          this.post({ type: 'error', message: `prompt failed: ${errMsg}`, sessionId });
          this.post({ type: 'turnDone', stopReason: 'error', sessionId });
        } finally {
          session.turnBusy = false;
        }
        break;
      }
      case 'imageError': {
        // Also surface the error in-chat so the user has a record after the toast
        // dismisses. ChatPane.svelte has a matching `case 'imageError'` that renders this
        // as a system message in the active session.
        const errMsg = typeof m.message === 'string' ? m.message : 'Image error';
        vscode.window.showWarningMessage(`Image: ${errMsg}`);
        this.post({
          type: 'imageError',
          message: errMsg,
          sessionId: this.activeSessionId ?? '',
        });
        break;
      }
      case 'switchModel': {
        // Native QuickPick — kept as the keybinding fallback (origami.switchModel).
        await DashboardPanel.switchModel(this.context);
        break;
      }
      case 'requestModels': {
        // Dropdown opened/mounted — re-poll the live LM Studio library + merge the configured list,
        // then broadcast. TWICE, and the ORDER is the point: known first, discovered second.
        // `provider_refresh` drops the engine's provider list so rebuilding it runs live discovery,
        // but that round trip in front of the broadcast made the picker's one-shot mount reads fire
        // into a void. Gated; never throws.
        await this.broadcastModelOptions(); // FIRST, always: what we ALREADY know, before any engine round trip.
        if (this.modelRefreshGate.shouldRefresh()) { await refreshEngineProviders(this.engineRefreshTargets()); await this.broadcastModelOptions(); this.broadcastModelStatus(); } // then again with what discovery found
        break;
      }
      case 'openConnections': { await vscode.commands.executeCommand('origami.chatView.focus'); this.post({ type: 'openProviderSetup' }); break; } // picker's no-connections row -> the sidebar's own Add-provider fold
      case 'requestProviderStatus': {
        // ControlStrip mounted / a provider was just connected — probe each
        // configured provider's liveness and broadcast the "Live" badges.
        await this.broadcastProviderStatus();
        break;
      }
      case 'requestSessionModels': {
        // ChatPane mounted — send each session's own model so every cell shows its own,
        // not the globally-loaded one. Its selectors go with it: the boot-time push runs
        // while the webview is still loading, so without this seed a late-mounting
        // composer held no effort options and hid its Effort button.
        this.broadcastSessionModels();
        refreshAllPlanUsage({ post: (x) => this.post(x), log: (l) => console.log(l), planUsage: nodePlanUsageDeps((l) => console.log(l)) }); // model bar opened: the passthrough pill's third lazy trigger (claudeCodeCell.ts)
        this.broadcastConfigSelectors();
        // Same seed, the other vocabulary: without it the `/` palette of a
        // late-mounting composer offers none of the workspace's skills.
        for (const msg of commandSeedMessages(this.sessions)) this.post(msg);
        break;
      }
      case 'requestSpend': {
        // Seed the month-to-date spend total + the budget (a fresh webview, before
        // any turn, for the budget banner + readout).
        const s = readSpend();
        this.post({ type: 'spendUpdate', month: s.month, total: s.total });
        this.post({ type: 'budgetUpdate', monthly: readBudget().monthly });
        break;
      }
      case 'requestBrowserAutoApprove': {
        // Composer mount + popover open — GLOBAL, not per-session; logic in
        // browserAutoApproveControl.ts.
        broadcastBrowserAutoApprove({ post: (msg) => this.post(msg) });
        break;
      }
      case 'setBrowserAutoApprove': {
        await setBrowserAutoApprove({ post: (msg) => this.post(msg) }, m.value === true);
        break;
      }
      case 'requestBrowserViewport': {
        // Settings-section mount — GLOBAL, not per-session; logic in
        // browserViewportControl.ts.
        broadcastBrowserViewport({ post: (msg) => this.post(msg) });
        break;
      }
      case 'setBrowserViewport': {
        await setBrowserViewport({ post: (msg) => this.post(msg) }, m.width, m.height);
        break;
      }
      case 'setBrowserReveal': {
        await setBrowserReveal({ post: (msg) => this.post(msg) }, m.value);
        return;
      }
      case 'setBrowserOpenBeside': {
        await setBrowserOpenBeside({ post: (msg) => this.post(msg) }, m.value === true);
        break;
      }
      case 'setBudget': {
        // The monthly OpenRouter spend cap (USD, null = no cap). Written to
        // ~/.origami/budget.json; the send path hard-blocks a cloud turn at 100%.
        const raw = m.monthly;
        const monthly = raw === null || raw === undefined || raw === '' ? null : Number(raw);
        const b = writeBudget(monthly);
        this.post({ type: 'budgetUpdate', monthly: b.monthly });
        this.post({
          type: 'system',
          text: b.monthly === null ? 'Monthly spend cap cleared.' : `Monthly spend cap set to $${b.monthly.toFixed(2)}.`,
          sessionId: sid ?? this.activeSessionId ?? '',
        });
        break;
      }
      case 'requestOpenRouterModels': {
        // The OpenRouter "view models" list (settings fold) + the chat picker's
        // OpenRouter tier. Fetch the live catalog with the STORED key from the global
        // origami.json (cached ~5 min) and broadcast `openRouterModels`. Empty (never an
        // error toast) when no key is configured or the fetch fails.
        const pid = String(m.providerId ?? 'openrouter');
        try {
          const block = readGlobalProviders()[pid];
          const apiKey = block?.options?.apiKey;
          const baseURL = block?.options?.baseURL || 'https://openrouter.ai/api/v1';
          if (!apiKey) { this.post({ type: 'openRouterModels', providerId: pid, models: [] }); break; }
          const now = Date.now();
          const cached = this.openRouterModelsCache;
          if (cached && cached.id === pid && now - cached.at < 300000) {
            this.post({ type: 'openRouterModels', providerId: pid, models: cached.models });
            break;
          }
          const models = await fetchOpenRouterModels(apiKey, baseURL);
          this.openRouterModelsCache = { id: pid, models, at: now };
          this.post({ type: 'openRouterModels', providerId: pid, models });
        } catch {
          this.post({ type: 'openRouterModels', providerId: pid, models: [] });
        }
        break;
      }
      case 'setSampling': {
        // Per-SESSION sampling override (temperature / top_p) for THIS chat, routed
        // through the engine's per-session setConfigOption (string-encoded; '' / 'auto'
        // clears). Applied live on the next message, independent per chat.
        const samplingSession = sid ? this.sessions.get(sid) : null;
        if (!samplingSession?.client) break;
        const enc = (v: unknown): string => {
          if (v === null || v === undefined || v === '') return '';
          const n = typeof v === 'number' ? v : parseFloat(String(v));
          return Number.isFinite(n) ? String(n) : '';
        };
        try {
          if (!(await samplingSession.gate.whenUp())) break; // engine not up: wait in order; gone: the gate showed the card (engineGate.ts)
          if ('temperature' in m) await samplingSession.client.setConfigOption('temperature', enc(m.temperature));
          if ('topP' in m) await samplingSession.client.setConfigOption('topP', enc(m.topP));
        } catch (e) {
          this.post({ type: 'system', text: `Could not set sampling — ${e instanceof Error ? e.message : e}`, sessionId: sid ?? '' });
        }
        break;
      }
      case 'requestFrequencyPenalty': {
        // Seed the sidebar control with the current global frequency-penalty
        // setting (null = using the engine's model-gated default, ~0.3 local).
        this.post({ type: 'frequencyPenaltyConfig', value: readAgentFrequencyPenalty() });
        break;
      }
      case 'setFrequencyPenalty': {
        // GLOBAL engine setting: the repetition (frequency) penalty. Written to
        // origami.json agent.build.frequency_penalty; the engine re-reads it per request,
        // so it applies live on the next message. Blank = clear -> the model-gated
        // default (~0.3 local, none for cloud); 0 = explicitly disable.
        const parse = (v: unknown): number | null => {
          if (v === null || v === undefined || v === '') return null;
          const n = typeof v === 'number' ? v : parseFloat(String(v));
          if (!Number.isFinite(n)) return null;
          return Math.min(2, Math.max(0, n));
        };
        try {
          const value = parse(m.value);
          writeAgentFrequencyPenalty(value);
          this.post({ type: 'frequencyPenaltyConfig', value });
          this.post({
            type: 'system',
            text: `Frequency penalty ${value === null ? 'reset to the model default' : `set to ${value}`} — applies on your next message.`,
            sessionId: sid ?? this.activeSessionId ?? '',
          });
        } catch (e) {
          vscode.window.showErrorMessage(`Origami: could not update frequency penalty — ${e instanceof Error ? e.message : e}`);
        }
        break;
      }
      case 'setModel': {
        // In-panel dropdown picked a model. One already in origami.json switches LIVE (ACP
        // setSessionConfigOption). One only in the live LM Studio library is ADDED to the
        // config and applied on reload — the engine reads config at spawn.
        const modelId = String(m.modelId ?? '');
        if (!modelId) break;
        // Target the POSTING cell's session (the chat-pane picker is per-chat), not
        // just whichever is globally active — falls back to the active session.
        const sid = String(m.sessionId ?? this.activeSessionId ?? '');
        const session = (sid && this.sessions.get(sid)) || this.getActiveSession();
        if (!session) {
          this.post({ type: 'system', text: 'No active session.', sessionId: '' });
          break;
        }
        if (!(await session.gate.whenUp())) break; // the engine's model list is empty until it is up (engineGate.ts)
        // Claude (subscription) while its Gate B says no: say why NOW, not at the first prompt (t-ty02bb).
        const refusal = isClaudeSubscriptionModel(modelId) ? claudeSubscriptionPickRefusal(modelId, await fetchClaudeSubscriptionReadiness(session.client)) : '';
        if (refusal) { this.post({ type: 'system', text: refusal, sessionId: sid }); break; }
        const configured = session.client.getModelOption()?.options ?? [];
        const isConfigured = configured.some(o => o.value === modelId);
        const local = detectLocalProvider();
        const slash = modelId.indexOf('/');
        const providerId = slash > 0 ? modelId.slice(0, slash) : (local?.id ?? 'lmstudio');
        const bareId = slash > 0 ? modelId.slice(slash + 1) : modelId;
        // Preserve the provider's existing display name — never clobber e.g.
        // "OpenRouter" with "LM Studio" when persisting one of its models. The local
        // provider's name is a valid fallback only when providerId IS the local
        // provider — never borrowed for some other unconfigured provider (t-u0rcmb).
        const providerName = resolveModelPickProviderName(providerId, readGlobalProviders()[providerId]?.name, local);
        // OpenRouter pricing (per-million USD) persisted with the model so the engine
        // computes real spend. undefined for local/free models — cost stays 0.
        const modelCost = providerId === 'openrouter' ? await this.openRouterCostFor(bareId) : undefined;

        // A model not yet in origami.json (a fresh LM Studio model, or an OpenRouter one
        // just picked from the live list) is WRITTEN FIRST so the engine's config.refresh
        // can pick it up — then it takes the SAME live path as a configured model.
        if (!isConfigured) {
          try {
            writeModelConfig({ providerId, providerName, modelId: bareId, modelName: bareId, cost: modelCost });
          } catch (e) {
            this.post({ type: 'error', message: `Couldn't add model: ${e instanceof Error ? e.message : String(e)}`, sessionId: sid });
            break;
          }
        }

        const op = this.modelOps.begin(sid, `switching ${session.title || sid || 'this chat'} to ${bareId}`);
        if (!op) { this.post({ type: 'system', text: this.modelOps.busyMessage(sid), sessionId: sid }); break; }
        try {
          // 1. Point the ENGINE at the selection FIRST (ACP setSessionConfigOption). It
          //    self-heals: a model just written to origami.json triggers a config-refresh +
          //    snapshot re-seed + retry, so it switches LIVE. Retargeting before any lms op
          //    also means a prompt mid-switch requests the NEW model. BOUNDED: on expiry we free
          //    the lock and SAY so; the call is never cancelled.
          const current = await withDeadline(session.client.setModel(modelId), MODEL_SWITCH_DEADLINE_MS, () => { op.release(); this.post({ type: 'system', text: `Model switch to ${bareId} is taking longer than ${Math.round(MODEL_SWITCH_DEADLINE_MS / 1000)} s (engine refresh); still waiting`, sessionId: sid }); });
          // 2. For a LOCAL (LM Studio) model, make it the SINGLE loaded model: eject
          //    the others (free VRAM) and load the selection at the right context.
          const isLocal = !!local && modelId.startsWith(local.id + '/');
          let loadOk = true;
          if (isLocal && local) {
            // Refresh the probe FIRST: the skip below is only as trustworthy as `modelInfo`,
            // and the user may have loaded something else in the LM Studio GUI since.
            await this.reprobeModel();
            // The picker's chosen context length wins; else inherit the real loaded
            // window; else a SAFE default — never the model's declared max (OOMs).
            const ctx = (typeof m.contextLength === 'number' && m.contextLength > 0)
              ? m.contextLength
              : (this.contextWindow > 0 ? this.contextWindow : DEFAULT_LOAD_CTX);
            // Re-picking what is ALREADY loaded, at the SAME window, must not evict and re-load
            // it (nor cascade that reload onto every other chat on this provider).
            if (!shouldReloadLocalModel({ requestedModelId: bareId, requestedContext: ctx, loaded: this.modelInfo })) {
              this.post({ type: 'system', text: `${bareId} is already loaded at ${Math.round(ctx / 1024)}k ctx — kept as is.`, sessionId: sid });
            } else {
              this.post({ type: 'system', text: `Loading ${bareId} at ${Math.round(ctx / 1024)}k ctx (ejecting others)…`, sessionId: sid });
              await runLms(['unload', '--all']);
              const r = await runLms(['load', bareId, '-c', String(ctx), '--gpu', 'max', '-y']);
              if (!r.ok) {
                loadOk = false;
                this.post({ type: 'system', text: `Could not load ${bareId} — ${(r.stderr || r.stdout || 'unknown').trim().slice(0, 200)}`, sessionId: sid });
                // The model isn't in the library (e.g. deleted in LM Studio) —
                // re-broadcast so it drops out of the picker instead of lingering.
                void this.broadcastModelOptions();
              }
            }
          }
          await this.reprobeModel();
          // Re-resolve the SWITCHED session's window + vision (provider-aware). Must target
          // `session` (the picker's chat), NOT the host-active session — otherwise a
          // solo/pop-out tab's pick refreshes some other chat and strands this one.
          await this.refreshModelInfoFor(session);
          // 3. On a real success: persist as the default so NEW sessions inherit it,
          //    confirm, and re-broadcast so the just-added model reads as configured. A
          //    failed local load must NOT report success nor persist an unloadable default.
          //    An engine-served model (isConfigured, from BEFORE this switch) persists only
          //    cfg.model — no provider block, no pinned models row (t-u0rcmb). Reusing the
          //    pre-switch `isConfigured` is deliberate: the !isConfigured branch above may have
          //    just written the block this switch needed, and re-checking now would always say
          //    "configured" and never persist a genuinely fresh model's block.
          if (loadOk) {
            try {
              persistModelPick({ providerId, providerName, modelId: bareId, modelName: bareId, cost: modelCost }, isConfigured);
            } catch (e) {
              console.error('[origami] could not persist model to config:', e);
            }
            this.post({ type: 'system', text: `Model set to ${current}.`, sessionId: sid });
            // LM Studio CARRIES: its GPU holds one model at a time, so picking a new LM
            // Studio model moves the OTHER chats THAT ARE ALSO ON LM STUDIO to it. A chat on
            // a DIFFERENT provider (a remote vLLM, OpenRouter, cloud) keeps its own model —
            // carrying it would wrongly yank it onto LM Studio.
            if (isLocal && local) {
              for (const [otherSid, otherSession] of this.sessions) {
                if (otherSid === sid || !otherSession.client || otherSession.gate.current !== 'ready') continue; // a chat still starting aligns itself (adoptLoadedModel)
                const otherCurrent = otherSession.client.getModelOption()?.current ?? '';
                if (!otherCurrent.startsWith(local.id + '/')) continue; // not on this local provider → leave it
                try { await otherSession.client.setModel(modelId); } catch { /* best-effort carry */ }
              }
            }
            void this.broadcastModelOptions();
            this.broadcastSessionModels();
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.post({ type: 'error', message: `Model switch failed: ${msg}`, sessionId: sid });
        } finally {
          op.release();
        }
        break;
      }
      case 'setSubagentModel': {
        // The picker's SUB-AGENT target: every sub-agent this chat spawns runs on this
        // model, ahead of the flock binding and the agent's own pin. Unlike `setModel`
        // this loads nothing and writes no config — a child's model is resolved by the
        // engine at spawn. Deliberately NOT the LM-Studio path: an eject+load here would
        // evict the model this very chat is talking to.
        const modelId = String(m.modelId ?? '');
        if (!modelId) break;
        const sid = String(m.sessionId ?? this.activeSessionId ?? '');
        const session = (sid && this.sessions.get(sid)) || this.getActiveSession();
        if (!session) {
          this.post({ type: 'system', text: 'No active session.', sessionId: '' });
          break;
        }
        // An optional context-length override rides the SAME configId value string as an
        // "@<positive integer>" suffix (the engine strips it before model resolution) —
        // bookkeeping only (the sub-agents' auto-compaction budget), never a load/eject.
        const ctxLen =
          typeof m.contextLength === 'number' && Number.isFinite(m.contextLength) && m.contextLength > 0
            ? Math.floor(m.contextLength)
            : undefined;
        const value = ctxLen ? `${modelId}@${ctxLen}` : modelId;
        try {
          if (!(await session.gate.whenUp())) break; // engine not up: wait; gone: the gate showed the card (engineGate.ts)
          await session.client.setConfigOption('subagentModel', value);
          session.subagentModel = modelId; // picker tooltip echo — broadcastSessionModels
          const ctxNote = ctxLen ? ` at ${Math.round(ctxLen / 1024)}k context` : '';
          this.post({ type: 'system', text: `Sub-agents in this chat will use ${modelId}${ctxNote}.`, sessionId: sid });
          this.broadcastSessionModels();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.post({ type: 'error', message: `Sub-agent model not set: ${msg}`, sessionId: sid });
        }
        break;
      }
      case 'setupProvider': {
        // Settings "Set up a different provider" — the in-panel progressive form posts a
        // ready ModelChoice; write/merge it into the GLOBAL origami.json and offer a
        // reload. Same writer as the QuickPick path (setupModel). The flow itself lives
        // in setupProvider.ts; this is the wiring.
        await setupProvider({
          sessionId: this.activeSessionId ?? '',
          msg: m,
          fetchImpl: fetch,
          fetchLocalModels: fetchLmStudioModels,
          // The server's OWN window for the model being saved, so a freshly connected
          // self-hosted provider reaches the engine with a real limit.context instead of
          // the 0 that disables auto-compaction. Same probe the gauge reads.
          fetchModelWindow: fetchModelWindowFor,
          fetchCatalog: fetchOpenRouterModels,
          cacheCatalog: (models) => { this.openRouterModelsCache = { id: 'openrouter', models, at: Date.now() }; },
          costFor: (id) => this.openRouterCostFor(id),
          write: this.writeProviderConfig,
          post: (msg) => this.post(msg),
          refresh: (id) => {
            this.providerStatusCache.delete(id);
            void this.broadcastProviderStatus(true);
            // The picker too: a just-connected catalog gateway (Zen/Go) brings
            // its whole /models list, and it should appear without a reload.
            void this.broadcastModelOptions();
          },
          notifyError: (message) => {
            // The transcript lines above target activeSessionId, which may be no open chat at
            // all while the user is in the CONFIG view — a failed connect then looked like
            // nothing happened. A host toast is visible from every surface.
            void vscode.window.showErrorMessage(`Origami: ${message}`);
          },
          notifyReload: (name, model) => {
            void vscode.window
              .showInformationMessage(
                `Origami: ${name} connected (${model}). Reload the window to switch to it.`,
                'Reload Window',
              )
              .then(c => { if (c === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow'); });
          },
        });
        break;
      }
      case 'requestPresetModels': {
        // The add form asking a key-only gateway what it serves, BEFORE a key exists — OpenCode Zen
        // answers GET /models with no Authorization. Not a phone-home: it fires only when a user
        // opens Add provider and clicks that preset, never on activation, a timer, or any chat
        // path.
        const pid = String(m.providerId ?? '');
        const preset = KEY_ONLY_PRESETS[pid];
        if (!preset?.keylessCatalog) break;
        const ids = await fetchCatalogIds(String(m.baseURL ?? preset.baseURL), fetch);
        this.post({ type: 'presetModels', providerId: pid, models: ids, defaultModel: pickDefaultModel(ids, preset.defaultModel) });
        break;
      }
      case 'renameProvider': {
        // Change ONLY a provider's pill label (block.name). The id (routing key) is
        // untouched, so no reload is needed — just re-broadcast status + model options.
        const sid = this.activeSessionId ?? '';
        const id = String(m.providerId ?? '').trim();
        const name = String(m.name ?? '').trim();
        if (!id || !name) break;
        try {
          const res = renameProviderConfig(id, name);
          if (!res.renamed) {
            this.post({ type: 'system', text: `Couldn't rename ${id} — not in your config.`, sessionId: sid });
            break;
          }
          this.providerStatusCache.delete(id);
          void this.broadcastProviderStatus(true);
          void this.broadcastModelOptions();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.post({ type: 'error', message: `Couldn't rename ${id}: ${msg}`, sessionId: sid });
        }
        break;
      }
      case 'removeProvider': {
        // Remove a configured provider from the GLOBAL origami.json (the reverse of
        // setupProvider). Repoints the active model if it pointed there. Backed up to
        // origami.json.bak.
        const sid = this.activeSessionId ?? '';
        const id = String(m.providerId ?? '').trim();
        if (!id) break;
        try {
          const res = removeProviderConfig(id);
          if (!res.removed) {
            this.post({ type: 'system', text: `${id} was not in your config — nothing to remove.`, sessionId: sid });
            break;
          }
          this.providerStatusCache.delete(id);
          void this.broadcastProviderStatus(true);
          void this.broadcastModelOptions();
          this.post({
            type: 'system',
            text: `Removed ${id}${res.model ? ` — active model is now ${res.model}` : ' — no model configured now'}. Reload the window to apply.`,
            sessionId: sid,
          });
          void vscode.window
            .showInformationMessage(`Origami: removed ${id}. Reload the window to apply.`, 'Reload Window')
            .then(c => { if (c === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow'); });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.post({ type: 'error', message: `Couldn't remove ${id}: ${msg}`, sessionId: sid });
        }
        break;
      }
      case 'setMode': {
        // The per-panel Plan toggle switches THIS session's mode (build ⇄ plan) with an
        // authoritative setConfigOption('mode', …); picking 'plan' enters the read-only plan
        // agent. configOptions refreshes, so re-broadcast the engine's real current value.
        const modeId = String(m.modeId ?? '');
        // Target the POSTING panel's session (falling back to the active one) — in a
        // grid the toggled panel may not be focused.
        const sid = String(m.sessionId ?? this.activeSessionId ?? '');
        const session = (sid && this.sessions.get(sid)) || this.getActiveSession();
        // The toggle is OPTIMISTIC in the webview. If the engine rejects or no-ops the switch,
        // snap the button back to the engine's REAL mode so it can never lie "Plan: on".
        const revertMode = () => {
          const real = session?.client.getModeOption()?.current;
          if (real) { this.post({ type: 'modeUpdate', mode: real, sessionId: sid }); statusBarRef?.setMode(real); this.applyPermissionMode(sid, real); }
        };
        if (!modeId || !session) { revertMode(); break; }
        try {
          if (!(await session.gate.whenUp())) { revertMode(); break; }
          await session.client.setConfigOption('mode', modeId);
          this.post({ type: 'modeUpdate', mode: modeId, sessionId: sid });
          statusBarRef?.setMode(modeId);
          this.applyPermissionMode(sid, modeId);
          this.broadcastConfigSelectors();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.post({ type: 'error', message: `Couldn't switch to ${modeId} mode: ${msg}`, sessionId: sid });
          revertMode();
        }
        break;
      }
      case 'setApproveMode': {
        // Per-panel scoped auto-approve preset (InputBar): 'default' | 'auto' | 'bypass'.
        // Authoritative ACP write via setConfigOption('permission', …); the engine turns it
        // into a session permission ruleset applied from the next message. Grid-safe.
        const mode = String(m.mode ?? 'default');
        // sid absent (legacy/global-scoped posts) falls back to the active session; sid PRESENT but unknown is a caller bug (a stale phone/sidebar target) — surface it instead of a silent break.
        const approveSession = sid ? this.sessions.get(sid) : this.getActiveSession();
        if (sid && !approveSession) { postApproveModeFailure((m) => this.post(m), sid, mode, `no such chat: ${sid}`); break; }
        if (!approveSession?.client) break;
        try {
          if (!(await approveSession.gate.whenUp())) break;
          await approveSession.client.setConfigOption('permission', mode);
          this.post({ type: 'approveUpdate', mode, sessionId: sid ?? '' });
          // The sticky mode banner only ever heard about agent-mode writes (plan/build) — a
          // phone's signed YOLO and this toggle's own bypass call left it silently stale.
          this.applyPermissionMode(sid ?? approveSession.id, mode);
          // BYPASS does not leave the outstanding asks on this session hanging: the engine
          // already re-answered them (Permission.refresh, fired by the SAME setConfigOption
          // write above). Drop the desk's own stale pending state to match — see
          // releaseBypassedPermissions for why NOT drainPermissions.
          if (mode === 'bypass' && approveSession.pendingPermissions.size > 0) { releaseBypassedPermissions(approveSession.pendingPermissions, (msg) => this.post(msg)); DashboardPanel.syncTabIcon(this.context, approveSession.id, 0); }
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          postApproveModeFailure((m) => this.post(m), sid, mode, err);
        }
        break;
      }
      case 'setVisionProfile': {
        // InputBar's eye button. Grid-safe: the posting panel's sid. Everything but this
        // wiring is in visionProfile.ts.
        const visionSession = sid ? this.sessions.get(sid) : this.getActiveSession();
        if (!visionSession?.client) break;
        const visionClient = visionSession.client;
        if (!(await visionSession.gate.whenUp())) break;
        await applyVisionProfile(
          { post: (msg) => this.post(msg), setConfigOption: (id, v) => visionClient.setConfigOption(id, v) },
          { profile: String(m.profile ?? ''), sessionId: sid ?? '' },
        );
        break;
      }
      case 'setVisionPin': {
        // The Vision triad (Auto / On / Profile) and the model picker's row chip. Pin
        // store, write order and the unpin reconcile all live in visionPin.ts; this is
        // the wiring plus the guard reset the reconcile needs. WHICH MODEL: no `modelId`
        // means "this chat's model", read off the POSTING panel's session (a pin in one
        // grid cell is not a pin in every cell). The picker's chip DOES send one.
        await applyVisionPin({
          store: this.context.globalState, localId: detectLocalProvider()?.id, writeVision: this.writeVision,
          current: String(m.modelId ?? '') || (sid ? this.sessions.get(sid) : this.getActiveSession())?.client?.getModelOption()?.current || detectModel() || '',
          reconcile: async () => { this.visionReconciled = false; const base = this.resolveEngineUrl() ?? readSettings().apiBase; if (base) await this.reconcileVisionCapabilities(base); },
          // BOTH surfaces repaint (`modelStatus` + `modelOptions`), or they disagree.
          refresh: () => { this.broadcastModelStatus(); void this.broadcastModelOptions(); },
          warn: (text) => this.post({ type: 'system', text, sessionId: sid ?? '' }),
        }, String(m.mode ?? ''));
        break;
      }
      case 'revertToMessage': {
        // "Rewind to here": deterministic rollback to before that assistant message's turn.
        // The engine restores files from its snapshot and marks that turn and everything
        // after for removal (finalised on the next prompt; reversible via undoRevert).
        const messageId = String(m.messageId ?? '');
        const revertSession = sid ? this.sessions.get(sid) : this.getActiveSession();
        if (!messageId || !revertSession?.client) break;
        try {
          if (!(await revertSession.gate.whenUp())) break; // a restored chat shows rows before its engine is up
          await revertSession.client.revert(messageId);
          this.post({ type: 'revertDone', ok: true, messageId, sessionId: sid ?? '' });
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          this.post({ type: 'revertDone', ok: false, messageId, sessionId: sid ?? '' });
          this.post({ type: 'system', text: `Couldn't rewind — ${err}`, sessionId: sid ?? '' });
        }
        break;
      }
      case 'undoRevert': {
        // Undo a staged rewind (before the next prompt finalises it): restores the
        // working tree to the pre-rewind snapshot and un-hides the dropped turns.
        const undoSession = sid ? this.sessions.get(sid) : this.getActiveSession();
        if (!undoSession?.client) break;
        try {
          if (!(await undoSession.gate.whenUp())) break;
          await undoSession.client.unrevert();
          this.post({ type: 'revertUndone', ok: true, sessionId: sid ?? '' });
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          this.post({ type: 'revertUndone', ok: false, sessionId: sid ?? '' });
          this.post({ type: 'system', text: `Couldn't undo the rewind — ${err}`, sessionId: sid ?? '' });
        }
        break;
      }
      case 'setCompactionThreshold': {
        // The compaction gauge's right-click menu picks a custom auto-compaction trigger.
        // Same authoritative ACP write the other per-panel config controls use; the
        // engine turns it into a per-session override (`compactionThreshold` configId).
        // Grid-safe: targets the posting panel's session, falling back to active.
        const value = String(m.value ?? '');
        const thresholdSession = sid ? this.sessions.get(sid) : this.getActiveSession();
        if (!thresholdSession?.client) break;
        const thresholdSid = sid || this.activeSessionId || '';
        try {
          if (!(await thresholdSession.gate.whenUp())) break;
          await thresholdSession.client.setConfigOption('compactionThreshold', value);
          this.post({ type: 'compactionThresholdUpdate', value, sessionId: thresholdSid });
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          this.post({ type: 'system', text: `Couldn't set the compaction threshold "${value}" — ${err}`, sessionId: thresholdSid });
        }
        break;
      }
      case 'setEffort': {
        // Per-panel reasoning control picked an effort variant — switch via the
        // config-option surface. Honest failure surfaced if invalid, never silent.
        // Grid-safe: the control is drawn in EVERY composer, so it must move the POSTING
        // panel's chat, not whichever one the window calls active.
        const value = String(m.effort ?? '');
        const effortSid = String(sid ?? this.activeSessionId ?? '');
        const session = (effortSid && this.sessions.get(effortSid)) || this.getActiveSession();
        if (!value || !session) break;
        try {
          if (!(await session.gate.whenUp())) break;
          await session.client.setConfigOption('effort', value);
          this.post({ type: 'reasoningUpdate', mode: value, sessionId: effortSid });
          this.broadcastConfigSelectors();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.post({ type: 'system', text: `Effort "${value}" isn't available for this model (${msg}).`, sessionId: effortSid });
        }
        break;
      }
      case 'openHistory': {
        await DashboardPanel.openHistory(this.context);
        break;
      }
      case 'requestSessions': {
        // The sidebar launcher's mount-time handshake. Reply with the live session list so a
        // launcher that became the PRIMARY webview (and missed the bootstrap `sessionCreated`
        // fan-out) still lists every open chat; only the launcher handles `sessionList`. ALSO the
        // one recovery path for a `requestPermission` posted before its listener was ready —
        // without `pendingAskIds` a session asked before mount shows a row with no way to know it
        // is waiting.
        const list = Array.from(this.sessions.values()).map(s => ({
          id: s.id,
          number: s.number,
          agentName: s.agentName,
          title: s.title,
          pendingAskIds: Array.from(s.pendingPermissions.keys()),
          runningChildIds: Array.from(s.runningChildren),
        }));
        this.post({ type: 'sessionList', sessions: list });
        // The Chats-list sections (Main + any user-created ones) ride the same handshake:
        // membership/collapse/name, read fresh so a second launcher never boots stale.
        this.post({ type: 'chatSections', state: loadChatSections(this.context.workspaceState) });
        // Sync the just-mounted view to the shared active theme — a new webview (a popped
        // editor-tab chat) boots on the meadow default and its own per-instance state, so
        // without this push it ignores the theme the rest of the panels are on.
        // `themeSync` applies without echoing back. Only when the theme is KNOWN, so we
        // never flip a view that legitimately restored its own persisted theme.
        const activeTheme = this.currentTheme;
        if (activeTheme) this.post({ type: 'themeSync', theme: activeTheme });
        break;
      }
      case 'requestWorkspaceData': {
        // Mount-time handshake for the Memory graph pane. It needs ONLY the wiki pages, so read the
        // resolved wiki folder directly — NOT readWorkspaceData, whose hardcoded `<ws>/wiki/pages`
        // is empty when the wiki lives in a subfolder. An explicit user Source pick is kept intact.
        if (this.wikiPathIsDefault || !this.wikiPath) {
          this.wikiPath = resolveDefaultWikiPages(this.cwd);
          this.wikiPathIsDefault = true;
        }
        this.doWikiRefresh();
        if (this.wikiPath) this.post({ type: 'wikiPath', path: this.wikiPath });
        break;
      }
      case 'requestHistory': {
        // In-webview history dropdown asked for the list. Query via the active session's
        // client, FALLING BACK to any open session's client so the history still lists
        // when no chat panel is focused (listSessions is workspace-scoped, not
        // session-specific). No chat: the window's host engine (t-sh7cog).
        const client = this.engineClient();
        let rows: Array<{ sessionId: string; cwd: string; title: string; updatedAt: string }> = [];
        if (client) {
          try {
            rows = await client.listSessions();
          } catch (e) {
            console.error('[origami] requestHistory listSessions failed', e);
          }
        }
        // Which of these runs are collab members. A failed collab read leaves rows
        // UNDECORATED (collabSessionMarks warns once) rather than breaking the index.
        const marks = await collabSessionMarks(client, this.cwd);
        // The open chat is MARKED, never dropped — historyRows.ts owns why.
        const items = historyRows(rows, client?.currentSessionId ?? null, marks);
        const claude = await scanClaudeHistoryReport({ folders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath) }); // t-463pb6: Claude Code's own transcripts join the list, scoped to the OPEN folders (claudeHistory.ts)
        this.post({ type: 'historyList', sessions: [...items, ...claude.rows], claudeScan: claude.scan }); // t-5nmtva: what was scanned travels with the rows, so an EMPTY list can say why
        break;
      }
      case 'recallSession': {
        // User picked a past chat in the dropdown — open it in a fresh tab
        // that loadSession-restores its transcript + model context.
        const id = typeof m.sessionId === 'string' ? m.sessionId : '';
        if (!id) break;
        // Already open? Focus that tab. The history list includes the chat you are
        // sitting in, so "recall" can name a session a tab is already bound to — and two
        // tabs on one engine session is the same chat drawn twice, not a second chat.
        const openTab = openTabFor(this.sessions, id);
        if (openTab) {
          this.activeSessionId = openTab;
          this.post({ type: 'restoreActiveSession', sessionId: openTab });
          break;
        }
        await this.createSession(undefined, undefined, id);
        break;
      }
      case 'popOutSession': {
        const id = typeof m.sessionId === 'string' && m.sessionId
          ? m.sessionId
          : (this.activeSessionId ?? '');
        if (id) await DashboardPanel.openSessionInEditor(this.context, id);
        break;
      }
      // The sidebar's workspace-wide roster count (webview/chat/ChatsList.svelte):
      // reveal the dashboard and tell the chat pane which chat to focus and
      // pull the drawer out on. A pure re-broadcast — the pane owns the drawer
      // state, so there is nothing for this side to decide.
      case 'openSubagentDrawer': {
        const id = typeof m.sessionId === 'string' ? m.sessionId : '';
        if (!id || !this.sessions.has(id)) break;
        this.panel.reveal();
        this.post({ type: 'openSubagentDrawer', sessionId: id });
        break;
      }
      // t-f89g49, the Side quests pull-out's twin of the case above, and the ONE
      // verb the phone has for it (`watch` tier in remoteVerbsTable.ts): reveal the
      // dashboard and tell the chat pane which chat to pull the drawer out on. A
      // pure re-broadcast — the pane owns the drawer state. Flag off = inert, so a
      // phone cannot reveal a surface this window does not have.
      case 'openSideQuestsDrawer': {
        const id = typeof m.sessionId === 'string' ? m.sessionId : '';
        if (!sideQuestsEnabled() || !id || !this.sessions.has(id)) break;
        this.panel.reveal();
        this.post({ type: 'openSideQuestsDrawer', sessionId: id });
        break;
      }
      case 'openMemoryFullscreen': {
        await DashboardPanel.openMemoryInEditor(this.context);
        break;
      }
      case 'setEngineUrl': {
        // In-panel CONNECT: persist the entered endpoint to the `origami.engineUrl`
        // setting, then RECONNECT — tear down the active session's AcpClient and create a
        // fresh one, spawned with ORIGAMI_API_BASE = the new URL (read at spawn). Status
        // stays honest: the post-respawn probe reports Online only if the engine answers.
        const url = typeof m.url === 'string' ? m.url.trim() : '';
        if (!url) {
          this.post({ type: 'system', text: 'Engine URL was empty — not changed.', sessionId: this.activeSessionId ?? '' });
          break;
        }
        try {
          await vscode.workspace
            .getConfiguration('origami')
            .update('engineUrl', url, vscode.ConfigurationTarget.Global);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.post({ type: 'error', message: `Could not save engine URL: ${msg}`, sessionId: this.activeSessionId ?? '' });
          break;
        }
        await this.reconnectActiveSession(url);
        break;
      }
      case 'slashCommand': {
        const command = String(m.command || '').trim();
        const args = String(m.args || '').trim();
        if (!command) break;
        await this.handleSlashCommand(command, args);
        break;
      }
      case 'closeSession': {
        if (sid) this.closeSession(sid);
        break;
      }
      case 'reorderSessions': {
        // Sidebar drag-to-reorder. The Chats list has no order field — the order IS this
        // map's insertion order, so applying a new order means rebuilding the map in
        // place. `readonly` keeps the SAME Map object, which matters: saveOpen and the
        // loop planners read it live. rankEntries owns the never-lose-a-session rule.
        const order = Array.isArray(m.order)
          ? (m.order as unknown[]).map((v) => String(v ?? ''))
          : [];
        const ranked = rankEntries(this.sessions, order);
        if (!ranked) break;
        this.sessions.clear();
        for (const [id, session] of ranked) this.sessions.set(id, session);
        this.saveOpen();
        // Echo the settled order back so a SECOND launcher surface doesn't sit on the old
        // order until it remounts — the same optimistic echo renameSession does.
        this.post({
          type: 'sessionList',
          sessions: ranked.map(([, s]) => ({ id: s.id, number: s.number, agentName: s.agentName, title: s.title, pendingAskIds: Array.from(s.pendingPermissions.keys()), runningChildIds: Array.from(s.runningChildren) })),
        });
        break;
      }
      case 'renameSession': {
        // Inline tab rename → authoritative ACP write via the config-option channel (configId
        // 'title'). The engine PATCH publishes session.updated, which echoes back as
        // 'sessionTitle'; we also post it optimistically so the label updates instantly.
        const title = String(m.title ?? '').trim();
        const session = sid ? this.sessions.get(sid) : undefined;
        if (!title || !session) break;
        try {
          if (!(await session.gate.whenUp())) break;
          await session.client.setConfigOption('title', title);
          this.post({ type: 'sessionTitle', title, sessionId: sid });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.post({ type: 'error', message: `Couldn't rename chat: ${msg}`, sessionId: sid });
        }
        break;
      }
      case 'exportSession': {
        // The webview sends the active session's message log; render to markdown and
        // prompt with a Save As dialog. The webview ships the log because the extension
        // host keeps no live mirror of every message, only the active turn's state.
        try {
          const agent = typeof m.agentName === 'string' ? m.agentName : 'agent';
          const messages = Array.isArray(m.messages) ? m.messages : [];
          const markdown = renderSessionMarkdown(agent, messages);
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
          const suggested = `origami-session-${agent}-${stamp}.md`;
          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(suggested),
            filters: { Markdown: ['md'] },
            saveLabel: 'Export session',
          });
          if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(markdown, 'utf8'));
            vscode.window.showInformationMessage(`Session exported to ${path.basename(uri.fsPath)}`);
          }
        } catch (err) {
          console.error('exportSession failed', err);
          vscode.window.showErrorMessage(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case 'exportLabyrinth': {
        // Labyrinth map export — the SAME shape as exportSession above: the webview owns
        // the content (only it sees the rendered SVG, the resolved theme and the steps
        // that were drawn), the host owns the dialog and the write. It arrives as a
        // self-contained HTML page (inline SVG with theme vars resolved, plus the step
        // ledger the picture drops), so this writes it verbatim. HTML rather than SVG
        // because the corridor minimap prints no labels.
        try {
          const html = typeof m.html === 'string' ? m.html : '';
          if (!html.trim()) {
            vscode.window.showErrorMessage('Nothing to export — no map is on screen.');
            break;
          }
          const mode = typeof m.mode === 'string' ? m.mode.replace(/[^a-z0-9-]/gi, '') || 'map' : 'map';
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
          const uri = await vscode.window.showSaveDialog({
            // NOT "origami-..." — a filename whose final segment STARTS with "origami" matches
            // Folio's file:// intercept regex, and Folio would hijack the report into its Studio.
            defaultUri: vscode.Uri.file(`insights-${mode}-${stamp}.html`),
            filters: { HTML: ['html'] },
            saveLabel: 'Export map',
          });
          if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(html, 'utf8'));
            vscode.window.showInformationMessage(`Labyrinth map exported to ${path.basename(uri.fsPath)}`);
          }
        } catch (err) {
          console.error('exportLabyrinth failed', err);
          vscode.window.showErrorMessage(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case 'requestLabyrinthColumns': {
        // Mount-time handshake — same shape as requestCollabsHeight above.
        const cols = this.context.workspaceState.get<LabyrinthColumns>(DashboardPanel.LABYRINTH_COLUMNS_KEY) ?? {};
        this.post({ type: 'labyrinthColumns', indexWidthPx: cols.indexWidthPx ?? null, inspectWidthPx: cols.inspectWidthPx ?? null, inspectCollapsed: cols.inspectCollapsed === true });
        break;
      }
      case 'resizeLabyrinthColumn': {
        const isIndex = m.column === 'index';
        const isInspect = m.column === 'inspect';
        if (!isIndex && !isInspect) break;
        const raw = m.widthPx;
        const widthPx = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : undefined;
        const cols = this.context.workspaceState.get<LabyrinthColumns>(DashboardPanel.LABYRINTH_COLUMNS_KEY) ?? {};
        // Collapsing carries NO width, and must not write one: the `raw > 0` guard above
        // coerces a collapsed 0 to undefined, which would ERASE the width the user dragged
        // to — so re-opening restores that width instead of the pane's default.
        const next: LabyrinthColumns = typeof m.collapsed === 'boolean'
          ? { ...cols, inspectCollapsed: m.collapsed }
          : isIndex ? { ...cols, indexWidthPx: widthPx } : { ...cols, inspectWidthPx: widthPx };
        void this.context.workspaceState.update(DashboardPanel.LABYRINTH_COLUMNS_KEY, next);
        this.post({ type: 'labyrinthColumns', indexWidthPx: next.indexWidthPx ?? null, inspectWidthPx: next.inspectWidthPx ?? null, inspectCollapsed: next.inspectCollapsed === true });
        break;
      }
      case 'exportCollab': {
        // A collab's stream as markdown — same split as the two cases above,
        // and the dialog + write live in collabExportFile.ts.
        await saveCollabMarkdown(typeof m.markdown === 'string' ? m.markdown : '', typeof m.title === 'string' ? m.title : '');
        break;
      }
      case 'archive.refresh': {
        // ArchivePane explicit re-list. Respect the includeArchived flag so the "Show
        // archived" toggle actually surfaces sessions/archived/ rows.
        const includeArchived = m.includeArchived === true;
        this.post({
          type: 'savedSessions',
          sessions: listSavedSessions({ includeArchived }),
        });
        break;
      }
      case 'archive.search': {
        // Full-transcript search across saved sessions. Caps at 50 hits, scanning both
        // active + archived dirs. An empty query falls back to a savedSessions broadcast.
        const query = typeof m.query === 'string' ? m.query : '';
        if (!query.trim()) {
          const includeArchived = m.includeArchived === true;
          this.post({
            type: 'savedSessions',
            sessions: listSavedSessions({ includeArchived }),
          });
        } else {
          this.post({
            type: 'searchResults',
            query,
            sessions: searchSavedSessions(query),
          });
        }
        break;
      }
      case 'archive.reactivate': {
        // Real transcript replay: read the saved JSON (from sessions/ or
        // sessions/archived/), hand the messageLog to createSession via
        // restoredFromMessages, and it posts `restoreMessages` + `restoreActiveSession`.
        const targetId = typeof m.sessionId === 'string' ? m.sessionId : null;
        const wantedAgent = typeof m.agentName === 'string' ? m.agentName : undefined;
        let restored: SavedSession | null = null;
        if (targetId) {
          for (const dir of [SESSIONS_DIR, path.join(SESSIONS_DIR, 'archived')]) {
            const file = path.join(dir, `${targetId}.json`);
            if (fs.existsSync(file)) {
              try {
                restored = JSON.parse(fs.readFileSync(file, 'utf-8')) as SavedSession;
                break;
              } catch (e) {
                console.error('[origami] archive.reactivate JSON parse failed:', e);
              }
            }
          }
        }
        if (restored) {
          await this.createSession(restored.agentName, restored.messages);
        } else {
          // No saved file (or unparsable) — fall back to a fresh chat with that agent.
          await this.createSession(wantedAgent);
        }
        break;
      }
      case 'archive.archive': {
        // Move <id>.json into archived/ so it falls out of the active list. Reversible.
        const targetId = typeof m.sessionId === 'string' ? m.sessionId : null;
        if (targetId) {
          try {
            const src = path.join(SESSIONS_DIR, `${targetId}.json`);
            const archivedDir = path.join(SESSIONS_DIR, 'archived');
            if (!fs.existsSync(archivedDir)) fs.mkdirSync(archivedDir, { recursive: true });
            const dest = path.join(archivedDir, `${targetId}.json`);
            if (fs.existsSync(src)) fs.renameSync(src, dest);
          } catch (e) {
            console.error('[origami] archive.archive failed:', e);
          }
          // Re-broadcast preserving whatever filter the webview last requested; the default
          // (no flag) returns the non-archived list.
          const includeArchived = m.includeArchived === true;
          this.post({
            type: 'savedSessions',
            sessions: listSavedSessions({ includeArchived }),
          });
        }
        break;
      }
      case 'archive.unarchive': {
        // Inverse of archive.archive: move sessions/archived/<id>.json back.
        const targetId = typeof m.sessionId === 'string' ? m.sessionId : null;
        if (targetId) {
          try {
            const src = path.join(SESSIONS_DIR, 'archived', `${targetId}.json`);
            const dest = path.join(SESSIONS_DIR, `${targetId}.json`);
            if (fs.existsSync(src)) {
              ensureSessionsDir();
              fs.renameSync(src, dest);
            }
          } catch (e) {
            console.error('[origami] archive.unarchive failed:', e);
          }
          const includeArchived = m.includeArchived === true;
          this.post({
            type: 'savedSessions',
            sessions: listSavedSessions({ includeArchived }),
          });
        }
        break;
      }
      case 'archive.delete': {
        // Permanent delete. No confirm here — the webview gates this behind a
        // click-twice UI. Also tries the archived/ dir so archived rows can be deleted.
        const targetId = typeof m.sessionId === 'string' ? m.sessionId : null;
        if (targetId) {
          try {
            for (const dir of [SESSIONS_DIR, path.join(SESSIONS_DIR, 'archived')]) {
              const file = path.join(dir, `${targetId}.json`);
              if (fs.existsSync(file)) fs.unlinkSync(file);
            }
          } catch (e) {
            console.error('[origami] archive.delete failed:', e);
          }
          const includeArchived = m.includeArchived === true;
          this.post({
            type: 'savedSessions',
            sessions: listSavedSessions({ includeArchived }),
          });
        }
        break;
      }
      case 'pickWikiFolder': {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Use this folder as Memory source',
          defaultUri: this.wikiPath ? vscode.Uri.file(this.wikiPath) : undefined,
        });
        if (!picked || picked.length === 0) break;
        const newPath = picked[0].fsPath;
        this.wikiPath = newPath;
        this.wikiPathIsDefault = path.resolve(newPath) === path.resolve(resolveDefaultWikiPages(this.cwd));
        this.rewireWikiWatcher();
        try {
          const relRoot = this.wikiPathIsDefault ? path.dirname(newPath) : undefined;
          const pages = readWikiPagesFromDir(newPath, relRoot);
          this.post({ type: 'wikiPath', path: newPath });
          this.post({ type: 'workspaceData', data: { wikiPages: pages } });
        } catch (e) {
          console.error('[origami] failed to read wiki pages from picked folder:', e);
          vscode.window.showErrorMessage(`Could not read memory folder: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }
      default:
        console.warn('[origami] unknown webview message:', msg);
    }
  }

  /**
   * Watch the workspace so any edit (a task added to BOARD.md, a new goal file, a
   * cron rewritten, a wiki page added) refreshes the dashboard. Debounced re-reads
   * coalesce bursts.
   */
  private setupWatchers(wsPath: string): void {
    this.disposeWorkspaceWatchers();
    const baseUri = vscode.Uri.file(wsPath);
    const patterns = [
      'BOARD.md',
      'Endeavors/goals/**/*.md',
      'Endeavors/projects/**/*.md',
      'Endeavors/_inbox/**/*.md',
      'Endeavors/_reports/**/*.md',
      // Legacy paths kept watching during the migration window, so a partially-migrated workspace
      // still triggers refreshes.
      'goals/**/*.md',
      'projects/**/*.md',
      'cron/jobs.json',
      'agents/*/profile/*.md',
      'agents/*/profile/*.toml',
    ];
    for (const p of patterns) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(baseUri, p));
      w.onDidCreate(() => this.scheduleWorkspaceRefresh());
      w.onDidChange(() => this.scheduleWorkspaceRefresh());
      w.onDidDelete(() => this.scheduleWorkspaceRefresh());
      this.workspaceWatchers.push(w);
    }

    // settings.toml lives in ~/.origami, outside the workspace
    const settingsDir = vscode.Uri.file(path.join(os.homedir(), '.origami'));
    const sw = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(settingsDir, 'settings.toml'));
    sw.onDidChange(() => this.scheduleWorkspaceRefresh());
    sw.onDidCreate(() => this.scheduleWorkspaceRefresh());
    this.workspaceWatchers.push(sw);

    this.rewireWikiWatcher();
  }

  private rewireWikiWatcher(): void {
    this.wikiWatcher?.dispose();
    this.wikiWatcher = null;
    if (!this.wikiPath) return;
    try {
      const dirUri = vscode.Uri.file(this.wikiPath);
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dirUri, '**/*.md'));
      w.onDidCreate(() => this.scheduleWikiRefresh());
      w.onDidChange(() => this.scheduleWikiRefresh());
      w.onDidDelete(() => this.scheduleWikiRefresh());
      this.wikiWatcher = w;
    } catch (e) {
      console.error('[origami] could not watch wiki path:', e);
    }
  }

  private scheduleWorkspaceRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.doWorkspaceRefresh(); }, 250);
  }

  private scheduleWikiRefresh(): void {
    if (this.wikiRefreshTimer) clearTimeout(this.wikiRefreshTimer);
    this.wikiRefreshTimer = setTimeout(() => { this.wikiRefreshTimer = null; this.doWikiRefresh(); }, 250);
  }

  private doWorkspaceRefresh(): void {
    const wsPath = findWorkspacePath();
    if (!wsPath) return;
    try {
      const data = readWorkspaceData(wsPath);
      // Drive the memory-graph pages from the resolved source (default OR a user-picked
      // folder), not readWorkspaceData's hardcoded `<ws>/wiki/pages`, which is empty when the wiki
      // lives in a subfolder.
      if (this.wikiPath) {
        const relRoot = this.wikiPathIsDefault ? path.dirname(this.wikiPath) : undefined;
        data.wikiPages = readWikiPagesFromDir(this.wikiPath, relRoot);
      } else {
        data.wikiPages = [];
      }
      this.post({ type: 'workspaceData', data });
    } catch (e) {
      console.error('[origami] refresh failed:', e);
    }
  }

  private doWikiRefresh(): void {
    if (!this.wikiPath) return;
    try {
      const relRoot = this.wikiPathIsDefault ? path.dirname(this.wikiPath) : undefined;
      const pages = readWikiPagesFromDir(this.wikiPath, relRoot);
      this.post({ type: 'workspaceData', data: { wikiPages: pages } });
    } catch (e) {
      console.error('[origami] wiki refresh failed:', e);
    }
  }

  private disposeWorkspaceWatchers(): void {
    for (const w of this.workspaceWatchers) w.dispose();
    this.workspaceWatchers = [];
    this.wikiWatcher?.dispose();
    this.wikiWatcher = null;
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
    if (this.wikiRefreshTimer) { clearTimeout(this.wikiRefreshTimer); this.wikiRefreshTimer = null; }
  }

  /** True while a kicked provider-liveness re-probe is running, so a broadcast storm cannot stack
   *  probes. */
  private providerProbeInFlight = false;

  /** THIS session's context window, but only if it was probed FOR the session's
   *  CURRENT model (the modelWindowFor tag) — else 0 (unknown). Every surface that
   *  stamps a window onto a per-session message MUST go through this; stamping the
   *  global LM Studio window onto a session is how a Spark chat wears "64k ctx". */
  private sessionValidWindow(session: Session): number {
    const cur = session.client?.getModelOption()?.current || detectModel() || '';
    return (session.modelWindow && session.modelWindowFor === cur) ? session.modelWindow : 0;
  }

  /** ONE session's honest status from ITS OWN model/provider: reachability from that provider's
   *  liveness (remote = providerStatusCache, loopback = the LM Studio probe), window/vision from
   *  the session's own probe, and provider identity so the webview phrases offline guidance for the
   *  RIGHT server. A remote provider NEVER falls back to LM Studio state; a session with no
   *  engine-reported model yet is judged by the CONFIGURED default's provider. */
  private sessionModelStatus(session: Session, ctx: {
    localId: string | undefined;
    providers: ReturnType<typeof readGlobalProviders>;
    staleRemote: Set<string>;
  }): {
    ok: boolean; modelName: string; contextWindow: number; reason: string | null;
    isVlm: boolean; visionState: VisionState; providerId: string; providerLabel: string; providerIsLocal: boolean;
  } {
    const { cur, bare, pid } = parseModelRef(session.client?.getModelOption()?.current || detectModel() || '');
    const isRemote = !!pid && pid !== ctx.localId;
    const prov = isRemote ? this.providerStatusCache.get(pid) : undefined;
    // Reachability, and whether ONE re-probe is worth kicking — the rule is
    // remoteLiveness.ts (a provider the global config does not list can never BE
    const { ok, probe } = remoteLiveness({ isRemote, known: !!ctx.providers[pid], row: prov, localOk: this.modelInfo.ok, now: Date.now() }); // probed: not offline, not queued).
    if (probe) ctx.staleRemote.add(pid);
    const reason = modelStatusReason({ ok, pid, isRemote, prov, providerCount: Object.keys(ctx.providers).length, localReason: this.modelInfo.reason ?? null });
    const providerLabel = pid ? (String(ctx.providers[pid]?.name ?? pid)) : 'LM Studio';
    // The cached window is only truth for the model it was probed FOR — after a model
    // switch it is a stale lie, so a mismatch reads as unknown until a re-probe.
    const windowValid = !!session.modelWindow && session.modelWindowFor === cur;
    return {
      ok,
      modelName: ok ? (bare || this.modelInfo.modelId) : '',
      contextWindow: isRemote ? (windowValid ? session.modelWindow! : 0) : (windowValid ? session.modelWindow! : this.modelInfo.contextLength),
      reason,
      isVlm: !!session.modelIsVlm,
      // Config + pin, NOT `isVlm`: for a local model isVlm is LM Studio's live
      // loaded-type, which says nothing about what the owner pinned.
      visionState: visionStateFor(this.context.globalState, splitModel(cur, ctx.localId), readModelVision),
      providerId: pid,
      providerLabel,
      providerIsLocal: !isRemote,
    };
  }

  private broadcastModelStatus(): void {
    // Bundle the active mode and per-mode default models alongside the model state so
    // the webview header can render "Mode: Game · Model: qwen3-32b" without having to
    // re-read settings.toml itself.
    const settings = readSettings();
    // The status surfaces read the ACTIVE session's model (the engine's real
    // per-session selection), NOT LM Studio's loaded model — otherwise a turn routed
    // to vLLM / OpenRouter still shows the local model and its window/vision.
    // `contextWindow` falls back to the LM Studio probe only until the active-model
    // probe lands. EVERY session then gets ITS OWN tagged status, computed from ITS
    // model's provider, so a popped-out solo tab or a background grid cell on a
    // remote provider shows its own reachability/window/vision instead of
    // stale-or-global state. `ctx` holds the per-broadcast constants (one config read
    // per tick, not per session) plus the collector for stale remote liveness.
    const ctx = {
      localId: detectLocalProvider()?.id,
      providers: readGlobalProviders(),
      staleRemote: new Set<string>(),
    };
    const active = this.getActiveSession();
    const activeStatus = active ? this.sessionModelStatus(active, ctx) : {
      ok: this.modelInfo.ok,
      modelName: this.modelInfo.ok ? this.modelInfo.modelId : '',
      contextWindow: this.modelInfo.contextLength,
      reason: this.modelInfo.reason ?? null,
      isVlm: false,
      visionState: 'auto-off' as VisionState,
      providerId: '',
      providerLabel: '',
      providerIsLocal: true,
    };
    this.post({
      type: 'modelStatus',
      sessionId: this.activeSessionId ?? '',
      ...activeStatus,
      state: this.modelInfo.state,
      // The model the LOCAL server actually has loaded right now ('' = none). A GLOBAL
      // fact, sent on every per-session post so the picker can offer "use what's loaded".
      loadedModelId: this.modelInfo.ok ? this.modelInfo.modelId : '',
      loadedContextLength: this.modelInfo.ok ? this.modelInfo.contextLength : 0,
      activeMode: settings.activeMode,
      defaultModelNormal: settings.defaultModelNormal,
      defaultModelGame: settings.defaultModelGame,
      // The endpoint origami-acp was spawned against, so the in-panel CONNECT control can
      // seed its input. Only the ACTIVE post carries it — per-session posts must not flap
      // config-view state.
      engineUrl: this.resolveEngineUrl() ?? settings.apiBase ?? '',
    });
    for (const [sid, s] of this.sessions) {
      if (sid === (this.activeSessionId ?? '') || !s.client) continue;
      this.post({
        type: 'modelStatus', sessionId: sid, ...this.sessionModelStatus(s, ctx), state: this.modelInfo.state,
        loadedModelId: this.modelInfo.ok ? this.modelInfo.modelId : '',
        loadedContextLength: this.modelInfo.ok ? this.modelInfo.contextLength : 0,
      });
    }
    if (activeStatus.ok) {
      statusBarRef?.setModel(activeStatus.modelName);
    }
    // Some session is on a remote provider whose liveness we don't freshly know — kick
    // ONE re-probe; its fresh `at` stamps stop this from re-kicking (no storm).
    if (ctx.staleRemote.size > 0 && !this.providerProbeInFlight) {
      this.providerProbeInFlight = true;
      void this.broadcastProviderStatus().finally(() => { this.providerProbeInFlight = false; });
    }
    // Ship the configured model list alongside status so the in-panel model
    // dropdown (ControlStrip) can render without a native QuickPick. Null
    // until the session's configOptions have arrived — then guarded out.
    void this.broadcastModelOptions();
    this.broadcastConfigSelectors();
  }

  /** Keyless-catalog gateway (Zen/Go) ENTITLED model ids — what THAT key can actually
   *  call, not the raw menu. Its two clocks (full sweep, catalog fingerprint) live in
   *  gatewayEntitledCache.ts; a landed step re-broadcasts the picker (no loop: a hit). */
  private readonly gatewayEntitled = new GatewayEntitledCache({
    fetch,
    sessionId: `origami-probe-${Math.random().toString(36).slice(2, 10)}`, // STABLE for the panel's life: one gateway session, not one per sweep
    onLanded: () => void this.broadcastModelOptions(),
  });
  /** t-ttmo5w: the Connections Refresh button (modelListRefresh.ts). Engines: every chat's, else the window's host engine. */
  private readonly refreshModelLists = createModelListRefresh({
    clearGateways: () => this.gatewayEntitled.clear(),
    gatewaysIdle: () => this.gatewayEntitled.idle(),
    engineTargets: () => { const chats = this.engineRefreshTargets(); const host = hostEngine.current(); return chats.length === 0 && host ? [{ client: host }] : chats; },
    broadcastModels: () => this.broadcastModelOptions(),
    broadcastProviderStatus: () => this.broadcastProviderStatus(true),
    post: (x) => this.post(x),
  });
  /**
   * Per-gateway "why is this tab short" facts for the picker's hint line: how many
   * catalog ids this key could not call, and how many of those were the `-free`
   * tier. COUNTS ONLY — the wording lives in the webview (pickerHint.ts).
   *
   * Read from the entitlement cache, so a gateway whose sweep has not landed yet
   * simply has no entry and draws no hint: a count is only honest once the sweep
   * that produced it finished.
   */
  private gatewayNotes(providers: Record<string, ConfiguredProvider>): Record<string, { hidden: number; hiddenFree: number; keyed: boolean }> {
    const out: Record<string, { hidden: number; hiddenFree: number; keyed: boolean }> = {};
    for (const [pid, block] of Object.entries(providers ?? {})) {
      if (!KEY_ONLY_PRESETS[pid]?.keylessCatalog) continue;
      const apiKey = block?.options?.apiKey ?? '';
      if (!apiKey) { out[pid] = { hidden: 0, hiddenFree: 0, keyed: false }; continue; }
      const hit = this.gatewayEntitled.get(block?.options?.baseURL ?? '', apiKey);
      if (!hit) continue;
      const entitled = new Set(hit.ids);
      const hidden = hit.catalog.filter((id) => !entitled.has(id));
      out[pid] = { hidden: hidden.length, hiddenFree: hidden.filter((id) => id.endsWith('-free')).length, keyed: true };
    }
    return out;
  }

  /** Broadcast the model list for the in-webview dropdown: the engine's configured
   *  models PLUS a live re-poll of the LM Studio library, so models added after
   *  origami.json was written still appear. Live models not yet in origami.json are
   *  flagged `configured:false`. Best-effort: a dead server yields the configured list. */
  private async broadcastModelOptions(): Promise<void> {
    const opt = this.getActiveSession()?.client.getModelOption();
    const current = opt?.current ?? '';
    const options: Array<{ value: string; name: string; configured: boolean }> =
      (opt?.options ?? []).map(o => ({ value: o.value, name: o.name, configured: true }));
    // No active session means the engine can't hand us its model list — seed the
    // configured catalog straight from origami.json so the board's model pickers
    // aren't silently empty. The live self-hosted re-poll below still refines it.
    if (!opt) {
      for (const [pid, block] of Object.entries(readGlobalProviders())) {
        for (const [mid, m] of Object.entries(block?.models ?? {})) {
          options.push({ value: `${pid}/${mid}`, name: m?.name ?? mid, configured: true });
        }
      }
    }
    // Live-poll EVERY pollable self-hosted server so the picker reflects what each
    // one ACTUALLY serves now, not the stale list the engine froze at spawn: served
    // ids are added, gone ones are pruned from the DISPLAY (never from the config),
    // and a server that doesn't answer keeps its configured list (liveModelMerge.ts).
    //
    // The fetcher dispatches on protocol: http → the node:http local probe; https →
    // the keyless-catalog gateway's ENTITLED set. Entitled, not the raw catalog: GET
    // /models answers the same ids for every key while the tier is enforced per
    // request. The sweep costs a probe per id, so it runs in the BACKGROUND on a
    // cache miss and re-broadcasts when it lands (gatewayEntitledCache.ts).
    const fetchServed = async (baseURL: string, apiKey?: string): Promise<string[]> =>
      /^https:\/\//i.test(baseURL) ? this.gatewayEntitled.served(baseURL, apiKey) : fetchLmStudioModels(baseURL, apiKey);
    const merged = await mergeLiveModels(options, readGlobalProviders(), fetchServed);
    const cliInfo = await claudeCli();
    const passthrough = claudeCodeModelRows(cliInfo);
    // Claude (subscription, experimental), t-tijdof: same opt-in gate as every
    // other ENGINE_FLAGS-backed setting. Readiness now comes from the engine's
    // own Gate B (t-tija5f) through one host call, cached briefly
    // (engineStatus.ts) — the local CLI-discovery guess (readiness.ts) is only
    // the fallback for when there is no active session to ask.
    const enabled = claudeSubscriptionEnabled();
    const readiness = !enabled ? undefined : this.getActiveSession()
      ? await fetchClaudeSubscriptionReadiness(this.getActiveSession()!.client)
      : readinessFromCli(cliInfo);
    const subscription = readiness ? claudeSubscriptionModelRows(true, readiness) : [];
    if (merged.length === 0 && !current && passthrough.length === 0 && subscription.length === 0) return; // the Labs "Claude Code" group is OFFERED, never configured (models.ts) — it needs no provider, so it survives the empty-catalogue early return
    // Per-row vision, so the picker says which models read a picture BEFORE one is
    // picked. AFTER the merge: only the final list has every row.
    const rows = visionStatesFor(this.context.globalState, merged, detectLocalProvider()?.id, readModelVision);
    // The engine's own claude-subscription rows are not pickable while its Gate B says no (t-ty02bb).
    const offered = readiness ? mergeClaudeSubscriptionRows([...rows, ...passthrough], subscription, readiness) : [...rows, ...passthrough];
    this.post({ type: 'modelOptions', current, options: offered, gatewayNotes: this.gatewayNotes(readGlobalProviders()) });
    // If a REMOTE single-model server had its model swapped, this session now points at
    // a model that is gone. Adopt the now-served one instead of silently mis-targeting.
    await this.maybeAdoptRemoteServedModel(current, merged);
  }

  /** Guards {@link maybeAdoptRemoteServedModel} against re-entrancy (its setModel
   *  round-trips through reprobe/broadcast, which can call back into it). */
  private syncingRemoteModel = false;

  /**
   * When a REMOTE self-hosted server serves exactly one model and the active
   * session's model is no longer that model (swapped server-side, so it was pruned
   * from the live options above), adopt the served one: write it to origami.json and
   * setModel (the engine self-heals via config.refresh — no window reload). Scoped
   * to REMOTE single-model servers; loopback LM Studio is managed via `lms`, and
   * many-model providers are left for the user to pick.
   */
  private async maybeAdoptRemoteServedModel(current: string, options: Array<{ value: string }>): Promise<void> {
    if (this.syncingRemoteModel || this.modelOps?.anyInFlight() || !current) return;
    const slash = current.indexOf('/');
    if (slash <= 0) return;
    const pid = current.slice(0, slash);
    const block = readGlobalProviders()[pid];
    const baseURL = block?.options?.baseURL;
    // Only a remote (non-loopback) OpenAI-compatible server — never OpenRouter, never a
    // keyless-catalog gateway, never a loopback LM Studio/Ollama (managed differently).
    if (!baseURL || /openrouter\.ai/.test(baseURL) || KEY_ONLY_PRESETS[pid]?.keylessCatalog || isLoopbackBaseUrl(baseURL)) return;
    const served = options.filter(o => o.value.startsWith(pid + '/')).map(o => o.value);
    if (served.includes(current)) return;      // still valid — nothing to do
    if (served.length !== 1) return;            // none or ambiguous — leave it to the user
    const target = served[0];
    const session = this.getActiveSession();
    if (!session) return;
    this.syncingRemoteModel = true;
    try {
      const bareId = target.slice(target.indexOf('/') + 1);
      writeModelConfig({ providerId: pid, providerName: block?.name ?? pid, modelId: bareId, modelName: bareId }, { automatic: true }); // background poll — no .bak slot
      await session.client.setModel(target); // engine self-heals (config.refresh) — no reload
      await this.reprobeModel().catch(() => { /* honest offline state on failure */ });
      await this.refreshActiveModelInfo().catch(() => { /* keep prior window on failure */ });
      this.broadcastSessionModels();
      this.post({
        type: 'system',
        text: `${block?.name ?? pid} now serves ${bareId} (its previous model is gone) — switched this chat to it.`,
        sessionId: this.activeSessionId ?? '',
      });
    } catch (e) {
      console.error('[origami] adopt remote served model failed:', e);
    } finally {
      this.syncingRemoteModel = false;
    }
  }

  /** Broadcast EACH session's OWN selected model, so every visible chat cell shows
   *  its own model instead of the single globally-loaded one. */
  private broadcastSessionModels(): void {
    const entries = [...this.sessions].map(([sid, s]) => [sid, { claudeCodeModel: claudeCodeModelOf(sid), current: s.client?.getModelOption()?.current, subagentModel: s.subagentModel }] as const);
    this.post({ type: 'sessionModels', ...buildSessionModelStatus(entries) });
  }

  /** Per-provider liveness cache — keyed by provider id, short TTL, so a badge
   *  refresh can't hammer OpenRouter's /key on every UI event. */
  private providerStatusCache = new Map<string, { live: boolean; reason?: string; at: number; flavor?: 'lmstudio' | 'ollama' | 'other' }>();

  // OpenRouter catalog cache — the full /models list keyed by provider id, short TTL
  // (~5 min) so a fold open doesn't re-fetch hundreds of models. Carries per-model pricing.
  private openRouterModelsCache: { id: string; models: OpenRouterModel[]; at: number } | null = null;
  /** OAuth-connected provider ids (oauth-cost) — kept fresh by broadcastProviderStatus. */
  private oauthProviderIds = new Set<string>();

  /** Pricing (per-million USD) for an OpenRouter model id, so a picked model can
   *  carry `cost` into origami.json and the engine computes real spend. Reads the
   *  cache, fetching once with the stored key if absent; undefined when free/unknown. */
  private async openRouterCostFor(modelId: string): Promise<{ input: number; output: number } | undefined> {
    try {
      let models = this.openRouterModelsCache?.models;
      if (!models || !models.some(m => m.id === modelId)) {
        const block = readGlobalProviders()['openrouter'];
        const apiKey = block?.options?.apiKey;
        const baseURL = block?.options?.baseURL || 'https://openrouter.ai/api/v1';
        if (!apiKey) return undefined;
        models = await fetchOpenRouterModels(apiKey, baseURL);
        this.openRouterModelsCache = { id: 'openrouter', models, at: Date.now() };
      }
      const m = models.find(x => x.id === modelId);
      return m?.cost && (m.cost.input > 0 || m.cost.output > 0) ? m.cost : undefined;
    } catch {
      return undefined;
    }
  }

  /** Whether the monthly cap should block THIS turn: only a paid CLOUD model
   *  (OpenRouter / cloud) incurs spend, so local turns are never blocked. */
  private budgetBlocksTurn(session: { client?: unknown }): boolean {
    const client = session.client as { getModelOption?: () => { current?: string } | undefined } | undefined;
    const cur = client?.getModelOption?.()?.current ?? '';
    return budgetBlocks(cur.split('/')[0], this.oauthProviderIds, isOverBudget());
  }

  /** Tell the webview a turn was refused by the cap (system message + fresh
   *  spend/budget so the banner reflects the block). */
  private postBudgetBlock(sid: string): void {
    const b = readBudget();
    const s = readSpend();
    this.post({
      type: 'system',
      text: `Monthly spend cap reached — $${s.total.toFixed(2)} of $${(b.monthly ?? 0).toFixed(2)}. Raise the cap in the OpenRouter settings, or switch to a local model, to continue.`,
      sessionId: sid,
    });
    this.post({ type: 'budgetUpdate', monthly: b.monthly });
    this.post({ type: 'spendUpdate', month: s.month, total: s.total });
  }

  /** Probe each CONFIGURED provider (from the global origami.json) for liveness and
   *  broadcast `providerStatus` for the ControlStrip's per-provider "Live" badges.
   *  OpenRouter = its stored key validates (/key); a local / OpenAI-compatible
   *  baseURL = a model is reachable; a cloud provider with a baked catalog = a key
   *  is present. Cached ~20s unless `force`. Best-effort — never throws. */
  private async broadcastProviderStatus(force = false): Promise<void> {
    // A `claude-subscription` block is only a persisted pick (writeModelConfig): the connection draws its own tile (t-ty02bb).
    const { [CLAUDE_SUBSCRIPTION_PROVIDER]: _pick, ...providers } = readGlobalProviders();
    const now = Date.now();
    const TTL = 20000;
    // The engine's primary local endpoint (drives ORIGAMI_API_BASE). Only its
    // pill edits the global engine URL; other locals are per-block base URLs.
    const primaryLocalId = detectLocalProvider()?.id;
    // `kind` is a pure UI concept (which form/fold to show + free-vs-paid), inferred
    // from the stored block so a CUSTOM-id pill (a renamed / 2nd local) still renders
    // correctly rather than falling back to a generic form.
    //
    // A SELF-HOSTED endpoint is 'local' WHATEVER its auth. "Has a key" is not a proxy
    // for "is a paid remote": putting LM Studio behind a key would flip its kind to
    // 'compat' and swap its whole settings fold for a bare "Re-key…". The honest
    // question is where the server runs, so selfHosted.ts answers it. Remote
    // behaviour is untouched: openrouter.ai is still forced 'compat'.
    const inferKind = (baseURL?: string, apiKey?: string): 'local' | 'compat' | 'cloud' =>
      /openrouter\.ai/.test(baseURL ?? '') ? 'compat'
        : isSelfHostedBaseUrl(baseURL) ? 'local'
          : baseURL ? (apiKey ? 'compat' : 'local')
            : 'cloud';
    // An OAuth block carries NEITHER a baseURL NOR an apiKey (the plugin injects the
    // bearer), so it is exactly the shape the "not configured" branch below rejects.
    // Ask the engine's auth store which blocks actually hold a credential, but only
    // when such a block exists. `undefined` = the store COULD NOT be asked (no engine
    // yet, or the call failed) — a different answer from "nobody signed in".
    const keyless = Object.values(providers).some(b => !b?.options?.baseURL && !b?.options?.apiKey);
    const oauthIds = keyless ? await readOauthIds(() => oauthConnectedIds(this.engineClient()), PROVIDER_PROBE_TIMEOUT_MS) : new Set<string>(); // BOUNDED: an unanswered store must not hold every probe open (oauthIdsRead.ts)
    // Spend/budget exclusion keeps its LAST KNOWN set through an unanswerable
    // beat — an engine hiccup must not start billing an OAuth provider's turns.
    if (oauthIds) this.oauthProviderIds = oauthIds;
    type StatusRow = { id: string; name: string; live: boolean; reason?: string; kind: 'local' | 'compat' | 'cloud'; baseURL?: string; primary: boolean; flavor?: 'lmstudio' | 'ollama' | 'other' };
    // Every provider probes AT THE SAME TIME (providerProbe.ts). A `for` loop
    // awaiting one network call per provider cost the SUM of every latency, and one
    // dead remote stalled the post for all of them. Wall time is now the slowest ONE.
    const out = await probeConcurrently(
      Object.entries(providers),
      async ([id, block]): Promise<StatusRow> => {
        const name = String(block?.name ?? id);
        const baseURL = block?.options?.baseURL;
        const apiKey = block?.options?.apiKey;
        const kind = inferKind(baseURL, apiKey);
        const primary = id === primaryLocalId;
        const cached = this.providerStatusCache.get(id);
        if (!force && cached && now - cached.at < TTL) {
          // Warm cache: no probe at all, so a fresh provider never waits on it.
          return { id, name, live: cached.live, reason: cached.reason, kind, baseURL, primary, flavor: cached.flavor ?? 'other' };
        }
        let live = false;
        let reason: string | undefined;
        // False only for a verdict that was never actually reached (the auth
        // store could not be asked) — caching that would serve a guess for 20s.
        let cacheable = true;
        // Which local server this is, so the picker offers only controls that work
        // against it (lms eject/context vs Ollama's own API vs honest display).
        let flavor: 'lmstudio' | 'ollama' | 'other' = 'other';
        try {
          if (id === 'openrouter' || /openrouter\.ai/.test(baseURL ?? '')) {
            const v = await openRouterKeyValid(apiKey ?? '', baseURL || 'https://openrouter.ai/api/v1');
            live = v.ok;
            reason = v.reason;
          } else if (KEY_ONLY_PRESETS[id]?.keylessCatalog && apiKey) {
            // A key-only HTTPS gateway (the OpenCode Zen family) needs its own branch:
            //  - the baseURL branch below probes through httpGetJson, which is node:http
            //    ONLY, and `http.get` THROWS on an https: URL.
            //  - liveness here means "the gateway answers its public catalog AND a key is
            //    configured". The KEY was proved at add/re-key time, which is user-initiated;
            //    re-proving it costs a POSTed completion, and running that on every 20s probe
            //    would be spend the user never asked for.
            const ids = await fetchCatalogIds(baseURL!, fetch);
            live = ids.length > 0;
            reason = live ? undefined : 'gateway unreachable';
          } else if (baseURL) {
            // A local / OpenAI-compatible endpoint is live when a model is reachable. The two
            // reads (a model list, and which server flavor this is) are independent, so they
            // run together — sequentially, a dead loopback paid httpGetJson's timeout TWICE.
            // Both probes carry the block's key when it has one; without it a key-protected
            // server 401s and reports "no model reachable" while it answers chat turns fine.
            const [ids, detected] = await Promise.all([fetchLmStudioModels(baseURL, apiKey), detectLocalFlavor(baseURL, apiKey)]);
            live = ids.length > 0;
            reason = live ? undefined : 'no model reachable';
            flavor = detected;
          } else if (apiKey) {
            // Cloud provider (OpenAI / xAI / Anthropic) with a models.dev-baked
            // catalog — a key is present; we don't spend a request validating it.
            live = true;
          } else if (oauthIds !== undefined && oauthIds.has(id)) {
            // Signed in over OAuth. Same class of proof as the key above — the credential
            // exists — and the same refusal to spend a request on it. An UNAUTHENTICATED
            // probe is not available: the block has no baseURL, and the provider's public
            // endpoint would answer 401 and be read as "down" while the model answers fine.
            live = true;
          } else if (oauthIds === undefined) {
            // The auth store COULD NOT BE ASKED — the boot-time probe runs before any chat
            // has spawned an engine. Absence of an answer is not absence of a credential:
            // caching "not configured" here put the alarm banner on every fresh ChatGPT chat
            // while the model answered fine. Skipping the cache means the next status tick
            // asks the real store instead of serving this guess for 20 seconds.
            reason = 'Checking provider…';
            cacheable = false;
          } else {
            reason = 'not configured';
          }
        } catch (e) {
          reason = e instanceof Error ? e.message : String(e);
        }
        if (cacheable) this.providerStatusCache.set(id, { live, reason, at: now, flavor });
        return { id, name, live, reason, kind, baseURL, primary, flavor };
      },
      // Only a probe that never SETTLES reaches this — every branch above resolves its own
      // errors into `reason`. Written not-live and deliberately NOT cached: a bound that
      // fired proves nothing, so the next open re-probes instead of serving a false "down".
      ([id, block], reason): StatusRow => ({
        id,
        name: String(block?.name ?? id),
        live: false,
        reason,
        kind: inferKind(block?.options?.baseURL, block?.options?.apiKey),
        baseURL: block?.options?.baseURL,
        primary: id === primaryLocalId,
        flavor: this.providerStatusCache.get(id)?.flavor ?? 'other',
      }),
      PROVIDER_PROBE_TIMEOUT_MS,
    );
    this.post({ type: 'providerStatus', providers: out });
    // Repaint the per-session model statuses from the FRESH cache — a remote chat's
    // ok/banner reads providerStatusCache, and without this a cache fill corrected the
    // pills but left every chat's stale banner in place until a focus switch.
    this.broadcastModelStatus();
  }

  /**
   * Align the engine's active model to whatever LM Studio actually has loaded. The
   * engine defaults a new session to config.model; when that is stale the engine
   * requests the wrong model on the first turn and LM Studio JIT-boots it. With the
   * deterministic single-model switch there is exactly one model loaded, so this
   * unambiguously adopts it: switch the engine to it LIVE (ACP) and persist so new
   * sessions stick. ACP-only — never lms-loads — and a no-op when nothing is loaded.
   */
  private async adoptLoadedModel(target?: Session): Promise<void> {
    if (!this.modelInfo.ok || !this.modelInfo.modelId) return; // nothing loaded → user picks
    const local = detectLocalProvider();
    if (!local) return;
    const fullId = `${local.id}/${this.modelInfo.modelId}`;
    // Defaults to the active session (the boot call); createSession passes its OWN
    // session, because a chat opened LATER never re-ran this and kept a stale model.
    const session = target ?? this.getActiveSession();
    if (!session) return;
    const opt = session.client.getModelOption();
    if (!opt || opt.current === fullId) return; // already aligned
    // Only adopt when the current default is ITSELF a local-provider model (or
    // unset). NEVER stomp a deliberately-chosen REMOTE provider back to LM Studio just
    // because a local model happens to be loaded — that silently hijacked the user's
    // picked provider on every boot.
    if (opt.current && !opt.current.startsWith(local.id + '/')) return;
    if (!opt.options.some(o => o.value === fullId)) return; // engine doesn't know it → leave as-is
    try {
      await session.client.setModel(fullId); // align engine to the loaded model (ACP only, no lms-load)
      // Persist ONLY when the default isn't already this model — otherwise every
      // restored chat rewrites an identical config (and its .bak) on boot.
      if (detectModel() !== fullId) {
        writeModelConfig({
          providerId: local.id,
          providerName: local.name,
          modelId: this.modelInfo.modelId,
          modelName: this.modelInfo.modelId,
        });
      }
      await this.broadcastModelOptions();
      this.broadcastModelStatus();
    } catch (e) {
      console.error('[origami] adoptLoadedModel failed:', e);
    }
  }

  /** Seed EVERY live chat's mode/effort/approve-mode selectors from its own ACP
   *  configOptions, so a resumed/reloaded chat reads engine truth. Per-session for
   *  the same reason broadcastModelStatus is: a solo/pop-out tab never posts
   *  `activeSessionChanged`, so an active-only push could never reach it. What each
   *  session is told (and what is withheld) lives in configSelectors.ts. */
  private broadcastConfigSelectors(): void {
    for (const msg of allConfigSelectorMessages(this.sessions)) this.post(msg);
  }

  private async reprobeModel(): Promise<void> {
    // Probe the SAME endpoint origami-acp was spawned against (origami.engineUrl
    // setting → ORIGAMI_API_BASE env → default). Fall back to settings.toml's api_base
    // only when no engine URL resolves, so the pill reflects the real target.
    const apiBase = this.resolveEngineUrl() ?? readSettings().apiBase;
    if (!apiBase) return;
    this.modelInfo = await fetchModelInfo(apiBase, undefined, primaryLocalApiKey());
    this.contextWindow = this.modelInfo.contextLength;
    // Hand the REAL window to the engine. Without this the probe stayed a UI-only fact
    // and the engine resolved limit.context = 0, disabling auto-compaction locally.
    const local = detectLocalProvider();
    if (local && this.modelInfo.ok && this.modelInfo.modelId && this.modelInfo.contextLength > 0) {
      this.writeContextLimit(local.id, this.modelInfo.modelId, this.modelInfo.contextLength, { onError: contextLimitWarner(m => this.post(m), this.activeSessionId ?? '', local.id, this.modelInfo.modelId) });
    }
    this.broadcastModelStatus();
  }

  /** Provider-aware probe target for the GIVEN session's model: resolve the base URL
   *  from that model's provider block so status/context reflect the real provider
   *  (vLLM's own endpoint), not the single fixed LM Studio engine URL.
   *
   *  `isLocal` is the ONE definition of "this session runs on the local server", the
   *  same rule sessionModelStatus uses: the model id's PROVIDER PREFIX equals
   *  detectLocalProvider()'s id — never inferred from "did we end up with a URL". */
  private resolveModelProbe(session: Session | undefined): { apiBase: string | undefined; providerId: string | null; modelId: string | null; apiKey?: string; isLocal: boolean } {
    const active = session?.client.getModelOption()?.current || detectModel() || '';
    const i = active.indexOf('/');
    const localId = detectLocalProvider()?.id;
    if (i > 0) {
      const providerId = active.slice(0, i);
      const modelId = active.slice(i + 1);
      // The key travels WITH the base URL: probing a key-protected server without it
      // returns 401, the window resolves to 0, and the session loses gauge + compaction.
      const block = readGlobalProviders()[providerId];
      const baseURL = block?.options?.baseURL;
      if (typeof baseURL === 'string' && baseURL) return { apiBase: baseURL, providerId, modelId, apiKey: block?.options?.apiKey, isLocal: providerId === localId };
      // A CLOUD provider block carries NO baseURL: a keyless OAuth connect writes
      // providerId/name/npm/models and nothing else, and the key-only presets carry no
      // URL either. Falling through to the engine URL below made LM STUDIO this
      // session's probe target, and refreshModelInfoFor then stamped LM Studio's loaded
      // window onto a grok chat, so compaction pressure read the wrong denominator.
      // There is nothing here to probe, so say so: no apiBase, not local.
      if (providerId !== localId) return { apiBase: undefined, providerId, modelId, apiKey: block?.options?.apiKey, isLocal: false };
    }
    return { apiBase: this.resolveEngineUrl() ?? readSettings().apiBase, providerId: null, modelId: null, apiKey: primaryLocalApiKey(), isLocal: true };
  }

  private async refreshActiveModelInfo(): Promise<void> {
    await this.refreshModelInfoFor(this.getActiveSession());
  }

  /** Resolve + cache the GIVEN session's context window + vision, provider-aware,
   *  stored ON THE SESSION so a side-by-side chat on another provider can't stamp
   *  its window onto this one, and WITHOUT disturbing `modelInfo`/`contextWindow`
   *  (the LM Studio probe stays the source for lms load/eject + adopt). Local reuses
   *  the LM Studio probe; a REMOTE provider takes its window from its OWN /v1/models
   *  (max_model_len) and NEVER borrows the local window on a miss — it stays unknown
   *  (0). When the session is the active one, mirror into the globals the status
   *  broadcast reads. The local/remote split is `p.isLocal` — the model id's provider
   *  prefix — NOT "p.providerId is null", which used to mean two different things. */
  private async refreshModelInfoFor(session: Session | undefined): Promise<void> {
    if (!session) return;
    const p = this.resolveModelProbe(session);
    // Tag the cache with the model it was probed FOR — a later model switch
    // makes this window a stale lie, and readers/recovery key off the tag.
    session.modelWindowFor = session.client?.getModelOption()?.current || detectModel() || '';
    if (p.isLocal) {
      session.modelWindow = this.modelInfo.contextLength;
      session.modelIsVlm = this.modelInfo.ok && this.modelInfo.type === 'vlm';
      // No write-back here: the local window belongs to whatever LM Studio has LOADED,
      // which is not necessarily this session's model id, so persisting it against
      // p.modelId would be a fabricated number. reprobeModel writes the honest pairing.
    } else {
      let win = 0;
      // OpenRouter is HTTPS-only and fetchModelInfo's probe is node:http, which THROWS
      // on an https: URL — caught inside httpGetJson and resolved as a failed probe, so
      // this branch silently gave contextLength 0 for every OpenRouter session.
      // fetchOpenRouterModels goes through the host's https-capable fetch, so route
      // OpenRouter through IT here for a real per-boot window off its `context_length`.
      //
      // UI TRUTH ONLY. `win` only ever reaches `session.modelWindow`, which feeds the
      // gauge/tooltip in InputBar.svelte — display, not policy. Auto-compaction is
      // decided ENGINE-side off `model.limit.context`. Unlike the generic remote path
      // below, OpenRouter's live number is NOT written back here — do not "unify" the
      // two without a separate, deliberately-reviewed engine-side change.
      const isOpenRouter = p.providerId === 'openrouter' || /openrouter\.ai/.test(p.apiBase ?? '');
      try {
        if (isOpenRouter) {
          const models = await fetchOpenRouterModels(p.apiKey ?? '', p.apiBase || 'https://openrouter.ai/api/v1');
          const match = p.modelId ? models.find(x => x.id === p.modelId) : models[0];
          win = match?.contextLength ?? 0;
          // This probe IS a liveness observation, same contract as the generic branch below,
          // so the banner reads fresh truth rather than waiting on the next status tick.
          if (p.providerId) {
            const prev = this.providerStatusCache.get(p.providerId);
            this.providerStatusCache.set(p.providerId, {
              live: models.length > 0,
              reason: models.length > 0 ? undefined : 'no models reachable',
              at: Date.now(),
              flavor: prev?.flavor ?? 'other',
            });
          }
        } else if (p.apiBase) {
          const info = await fetchModelInfo(p.apiBase, p.modelId ?? undefined, p.apiKey);
          win = info.contextLength;
          // Bridge the probe to the ENGINE for remote providers too (a vLLM's max_model_len is
          // as real as LM Studio's loaded window). Keyed to the model we asked ABOUT, and only
          // when the server answered for it. onlyWhenUnset: a remote reports its STATIC max and
          // this config already carries hand-set lower windows — fill the 0, never overrule.
          if (p.providerId && p.modelId && win > 0 && (!info.modelId || info.modelId === p.modelId)) {
            this.writeContextLimit(p.providerId, p.modelId, win, { onlyWhenUnset: true, onError: contextLimitWarner(m => this.post(m), session.id, p.providerId, p.modelId) });
          }
          // This probe IS a liveness observation — record it so a boot/focus window-probe of a
          // live Spark does not leave the chat saying "unreachable".
          if (p.providerId) {
            const prev = this.providerStatusCache.get(p.providerId);
            this.providerStatusCache.set(p.providerId, {
              live: info.ok,
              reason: info.ok ? undefined : (info.reason ?? 'no model reachable'),
              at: Date.now(),
              flavor: prev?.flavor ?? 'other',
            });
          }
        }
      } catch {
        // Unreachable ⇒ record that too (honest offline beats stale green).
        if (p.providerId) {
          const prev = this.providerStatusCache.get(p.providerId);
          this.providerStatusCache.set(p.providerId, { live: false, reason: 'Provider unreachable', at: Date.now(), flavor: prev?.flavor ?? 'other' });
        }
        /* window stays unknown (0) rather than borrowing the local one */
      }
      session.modelWindow = win; // no LM Studio fallback for a remote provider
      session.modelIsVlm = !!(p.providerId && p.modelId && readModelVision(p.providerId, p.modelId));
    }
    if (session.id === this.activeSessionId) {
      this.activeModelWindow = session.modelWindow ?? 0;
    }
    // ALWAYS broadcast — statuses are per-session, and a solo/pop-out tab's refresh
    // must repaint even when the host-active session is a different chat.
    this.broadcastModelStatus();
  }

  /**
   * Auto-detect vision support for local models and keep origami.json in sync. The
   * engine defaults every config-declared model to no-image-input because the
   * OpenAI-compatible API never reports modalities, so anything that knows better
   * must write the flag before the engine spawns. LM Studio and Ollama know; vLLM,
   * SGLang and every other OpenAI-compatible box expose NO capability surface, so
   * they are left exactly as configured — visionDetect.ts says why absent must never
   * mean false. Runs once per panel; only writes on an actual mismatch.
   */
  private async reconcileVisionCapabilities(apiBase: string): Promise<void> {
    if (this.visionReconciled) return;
    const local = detectLocalProvider();
    if (!local) { this.visionReconciled = true; return; }
    const configured = listConfiguredModels(local.id);
    let seen: VisionMap;
    try {
      seen = await detectVision({ apiBase, modelIds: configured }, fetchVisionProbe);
    } catch {
      return; // endpoint not ready yet — leave the flag unset so a later reprobe retries
    }
    if (seen.size === 0) return; // no capability surface (vLLM/SGLang) — nothing to detect; retry later
    this.visionReconciled = true;

    const changed: string[] = [];
    // visionWrites owns BOTH skips: a model the server did not answer for is UNKNOWN
    // (writing `false` blinds a hand-configured VLM), and a PINNED one is overruled on purpose.
    for (const { modelId, enabled } of visionWrites({ models: configured, seen, pinned: (id) => readVisionPin(this.context.globalState, local.id, id) !== undefined, current: (id) => readModelVision(local.id, id) })) {
      try {
        this.writeVision({ providerId: local.id, modelId, enabled });
        if (enabled) changed.push(modelId);
      } catch (e) {
        console.error('[origami] vision reconcile write failed:', e);
      }
    }
    if (changed.length > 0) {
      // Runs BEFORE the engine spawns (see initialize), so the engine reads
      // these caps at startup — no reload needed.
      console.log(`[origami] vision auto-enabled for: ${changed.join(', ')}`);
    }
  }

  private post(msg: object): void {
    // A collab tab BADGES when its room needs the user. Read off the payload every
    // surface already gets, so no second wire and no second poll: the rule is
    // collabAttention.ts, the panel write is collabTab.ts. Fires for a room whose tab
    // is SHUT too — setCollabTabWaiting is a no-op with no tab.
    const cs = msg as { type?: string; collabId?: string; sessionId?: string }; notifyOnPost(msg as Record<string, unknown>, this.sessions.get(cs.sessionId ?? '')?.agentName); noteTodoSnapshot(this.sessions, msg); nestHub.onLocalPost(cs); /* t-selspn: a new chat, retitle or turn edge sends the nest index within 2 s */
    if (cs.type === 'collabStateData' && typeof cs.collabId === 'string') {
      setCollabTabWaiting(cs.collabId, collabNeedsUser(msg as CollabAttentionState));
    }
    // Fan out every broadcast to the primary host AND any attached views (the config
    // + chat split), so both surfaces see the same modelStatus / contextUpdate /
    // theme / session events. A failed post to one view never blocks the others.
    //
    // t-tc2rlo #9: routed through deltaFanout, which (a) drops a per-session
    // message for a solo view pinned to a DIFFERENT session instead of sending it
    // to be ignored, and (b) coalesces a streaming delta burst (agentText and
    // friends — one message per model chunk) into one post per view per frame.
    const targets: vscode.Webview[] = [this.panel.webview, ...this.extraViews];
    for (const view of targets) {
      this.deltaFanout.route(view, msg as Record<string, unknown>, this.viewSolo.get(view), (routed) => {
        // Per VIEW, not once: a read-image card's `<img src>` is that webview's own
        // resource URI, or — on the desktop only, t-fdw2j2 — the host's own capped
        // copy of the bytes when the file sits outside every root. The phone gets
        // neither (plain webviewImageSrc, always undefined for it — no roots at
        // all) and takes its own thumbnail path in RemoteView.postMessage instead.
        // Every other message passes by identity.
        view.postMessage(stampToolImages(routed, (facts) => imageSrcFor(view, facts))).then(undefined, (err) => {
          console.error('[origami] postMessage failed', err);
        });
      });
    }
  }

  /**
   * Attach a second webview (the config OR chat view, whichever resolved after the
   * primary) to this host. The view receives every future `post()` broadcast and its
   * inbound messages route into the shared `handleWebviewMessage`. Its HTML is
   * rendered for the given bundle so it loads the right Svelte shell + theme sidecar
   * CSS. The attachment is torn down when the host disposes.
   */
  public attachView(host: WebviewHost, bundle: WebviewBundle, soloSessionId?: string, memory = false, board = false, raceCompare?: RaceCompareParams, repoMap?: RepoMapParams, collab?: CollabTabParams): void {
    host.webview.html = this.renderHtmlFor(bundle, host.webview, soloSessionId, memory, board, raceCompare, repoMap, collab);
    // Wiring (inbound sub + broadcast list + RE-ATTACH teardown of any previous wiring —
    // the doubled-send guard) lives in viewWiring.ts. Solo mapping set AFTER rewire.
    const teardown = rewireView(this.viewWiring, this.extraViews, this.viewSolo, host.webview, (m) => this.handleWebviewMessage(m));
    // Remember who this view speaks for, so its sticky banner can be painted
    // from THAT session rather than from whichever chat the sidebar has focused.
    if (soloSessionId) this.viewSolo.set(host.webview, soloSessionId);
    // If VS Code tears this attached view down (not the primary), drop it from the
    // broadcast list and release its wiring. The attached view does NOT own the
    // session lifecycle — only the primary host's dispose kills the ACP child.
    const disposeSub = host.onDidDispose(() => {
      teardown();
      this.deltaFanout.dispose(host.webview);
      disposeSub.dispose();
    });
    // Replay current global state so the freshly attached view is not blank until the
    // next event... but NOT to the phone: a per-session modelStatus is a rebroadcast
    // the remote pane never reads (remote/phoneView.ts denies it on the wire too).
    if (!isRemoteWebview(host.webview)) this.broadcastModelStatus();
    // The primary host bootstraps the first session via initialize()→createSession()
    // BEFORE the second view attaches, so that `sessionCreated` broadcast happened
    // before this webview's wire existed. Replay every existing session (creation,
    // restored scrollback, context gauge, active-session pointer) to THIS view only,
    // or the attached chat renders the bare "No session" stub.
    this.replaySessionsTo(host.webview);
  }

  /**
   * Replay the current session state to a single, freshly-attached webview (not a
   * broadcast). Mirrors the per-session messages createSession() posts at bootstrap,
   * scoped to one webview so the already-live primary view is not double-fed.
   */
  private replaySessionsTo(webview: vscode.Webview): void {
    if (this.sessions.size === 0) return;
    // The PHONE's replay is the same burst without the parts that cost bytes
    // and buy nothing on a 6-inch pane — the table is in replaySession.ts.
    const remote = isRemoteWebview(webview);
    const wsPath = findWorkspacePath();
    const post = (msg: object): void => this.postTo(webview, msg);
    for (const session of this.sessions.values()) {
      replaySessionTo(post, session, {
        // The COMPRESSED tail only for a phone that said it can open one.
        remote, compress: remote && remoteAcceptsZ(webview), wsPath, cwd: this.cwd,
        // What this phone says it still holds of THIS chat: the replay then
        // sends the rows it lacks instead of the whole tail (remoteDelta.ts).
        since: remote ? remoteCursor(webview, session.id) : undefined,
        contextWindow: this.sessionValidWindow(session),
        activity: this.sessionActivityFields(session),
        dismissedSubagents: readSubagentDismissed(this.context.workspaceState, session.client?.currentSessionId),
      });
      // Re-post a buffered question-PERMISSION to the newly mounted view (the user
      // answers it there, resolving the ORIGINAL stored respond); a dead turn drops it.
      this.replayBufferedQuestionFor(session, post);
    }
    // Point the attached view at the same active session the host holds,
    // so the chat opens focused on a real thread.
    if (this.activeSessionId && this.sessions.has(this.activeSessionId)) {
      this.postTo(webview, { type: 'restoreActiveSession', sessionId: this.activeSessionId });
    }
  }

  /** Surface `session`'s buffered question-permission on `poster` (turnBusy gate): POST
   * it and auto-open its plan_exit/dream preview while the turn lives; DROP + drain + clear chip on
   *  a dead turn. */
  private replayBufferedQuestionFor(session: Session, poster: (msg: object) => void): void {
    const qp = this.pendingQuestionPermissions.get(session.id);
    const qpAct = questionReplayAction(!!qp, session.turnBusy === true);
    if (qpAct === 'post') { poster({ type: 'requestPermission', toolCallId: qp!.toolCallId, title: qp!.title, kind: qp!.kind, sessionId: session.id, target: qp!.target, options: qp!.options }); openPermissionPreview(session, qp!.title); }
    else if (qpAct === 'drop') { this.pendingQuestionPermissions.delete(session.id); drainPermissions(session.pendingPermissions); DashboardPanel.syncTabIcon(this.context, session.id, 0); this.agentManagerInstance?.setAgentQuestion(session.id, null); }
  }

  /**
   * Post a single message to ONE webview (not the broadcast fan-out), so a
   * newly-attached view can be caught up without re-posting to the primary view.
   */
  private postTo(webview: vscode.Webview, msg: object): void {
    // Same stamp as the broadcast: this is the REPLAY road (restoreMessages), so a
    // reopened tab draws the read-image card the live turn drew.
    webview.postMessage(stampToolImages(msg, (facts) => imageSrcFor(webview, facts))).then(undefined, (err) => {
      console.error('[origami] postMessage(replay) failed', err);
    });
  }

  /**
   * Push the active in-panel theme id to every view so config + chat agree. Sent as
   * `themeSync` (NOT `themeChanged`) so the receiving shells set data-theme WITHOUT
   * echoing a `themeChanged` back — that would loop.
   */
  private broadcastTheme(themeId: string): void {
    if (!themeId) return;
    this.post({ type: 'themeSync', theme: themeId });
  }

  public dispose(): void {
    // SAFETY: if other live views remain attached (the popped-out editor chat tab
    // closed while the sidebar is still open), do NOT tear down the shared sessions —
    // the conversation continues on the surviving views. post() tolerates the
    // now-dead primary webview (it catches the throw).
    if (this.extraViews.length > 0) {
      return;
    }
    // Only clear the singleton if THIS instance is the registered full-panel dashboard —
    // a sidebar instance (createForHost) is not the singleton.
    if (DashboardPanel.current === this) {
      DashboardPanel.current = undefined;
    }
    this.disposeWorkspaceWatchers();
    // The host-side collab watch is one timer for the whole workspace, held in module
    // state so a second panel cannot double the traffic — so nothing but this stops it.
    stopCollabWatch();
    // Same shape: the side-quests folder watch is module state keyed by cwd and
    // posts into THIS panel. Left running it would keep posting into a dead
    // webview and the next panel would get no live updates (t-fisfs5 R4); the
    // next panel's first `requestSideQuests` starts a fresh one.
    stopSideQuestWatchers();
    this.agentManagerInstance?.dispose(); hostEngine.releaseChats(this); // t-sh7cog: the host engine itself goes with the WINDOW (hostEngineWindow.ts), not the panel
    for (const session of this.sessions.values()) {
      saveSession(session);
      session.client.dispose();
    }
    this.sessions.clear();
    this.deltaFanout.dispose(this.panel.webview);
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
    this.panel.dispose();
  }

  private renderHtml(): string {
    return this.renderHtmlFor(this.bundle, this.panel.webview);
  }

  /**
   * Render the boot HTML for an arbitrary bundle on a given webview — used both for
   * the primary host and for an attached second view, so each loads its own Svelte
   * shell + matching theme sidecar CSS while sharing one host.
   */
  private renderHtmlFor(bundle: WebviewBundle, webview: vscode.Webview, soloSessionId?: string, memory = false, board = false, raceCompare?: RaceCompareParams, repoMap?: RepoMapParams, collab?: CollabTabParams): string {
    // The chat shell (ChatView) speaks the identical protocol regardless of layout; the
    // `config`/`dashboard` branches below are vestigial (those surfaces were removed).
    const bundleName =
      bundle === 'config' ? 'config'
      : bundle === 'chat' ? 'chat'
      : 'dashboard';
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview', `${bundleName}.js`),
    );
    // Every Svelte entry imports shared/theme.css, so esbuild emits a sidecar
    // `<bundle>.css` carrying the four :root[data-theme] palettes. We MUST link it —
    // without it the --og-* vars are undefined and the panel falls through to the VS
    // Code workbench background, so a theme with no contributed workbench theme never
    // visibly switches.
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview', `${bundleName}.css`),
    );
    const nonce = getNonce();
    // Surface the installed extension version into the webview so the chat header can
    // show it — the user can then tell they are not on a stale extension host after
    // an update. Injected as a global so it is available before mount.
    const extVersion = String(
      (this.context.extension.packageJSON as { version?: unknown }).version ?? '',
    );

    // Sticky permission-mode banner, mirroring the TUI's, so the user can see when
    // plan mode is active. Auto and bypass mode surface through the InputBar's own
    // Access chip instead (permBannerCopy, t-dih1p7 / Phase C2) — this banner renders
    // nothing for them. The inline script listens for `permModeUpdate` postMessage
    // events so live changes update without a reload.
    // Seeded from the session THIS view speaks for — seeding from a panel-global
    // "last painted mode" made a chat popped out while another was in plan boot
    // showing plan, a banner it had never earned.
    const bannerMode = this.permBanner.modeForView(
      soloSessionId,
      this.activeSessionId,
      (soloSessionId ? this.sessions.get(soloSessionId) : this.getActiveSession())?.client.getModeOption()?.current,
    );
    const bannerInitial = permBannerCopy(bannerMode);
    return /* html */ `<!DOCTYPE html>
<html lang="en" data-theme="meadow">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src 'unsafe-inline' ${webview.cspSource};
             script-src 'nonce-${nonce}' ${webview.cspSource};
             font-src ${webview.cspSource};
             img-src data: ${webview.cspSource};" />
  <title>${bundle === 'config' ? 'Origami Setup' : bundle === 'dashboard' ? 'Origami Dashboard' : 'Origami Chat'}</title>
  ${cssUri ? `<link rel="stylesheet" href="${cssUri}" />` : ''}
  <style>
    /* The banner is a SIBLING above #app, and theme.css sizes #app at a flat
       100vh inside an overflow:hidden body. So every pixel the banner occupied
       pushed the same number of pixels of the app off the BOTTOM of the
       viewport, where the composer's action row lives — which is why a chat
       showing this banner had "lost its Chat commands" (0.3.24 UAT). Making the
       body the flex column and the app the flex CHILD means the banner takes its
       height out of the app's box instead of out of the visible window.
       Declared here, after the theme sidecar link, so it wins on equal
       specificity without touching the shared stylesheet. */
    body { display: flex; flex-direction: column; }
    #app { height: auto; flex: 1 1 auto; min-height: 0; }
    #permModeBanner {
      display: none;
      flex: 0 0 auto;
      padding: 4px 12px;
      font-family: var(--vscode-font-family);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.4px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    #permModeBanner[data-mode="plan"]      { display: block; background: #1e3a5f; color: #aed1ff; }
  </style>
</head>
<body>
  <div id="permModeBanner" data-mode="${bannerMode}">${bannerInitial}</div>
  <div id="app"></div>
  <script nonce="${nonce}">
    (function() {
      window.__ORIGAMI_VERSION__ = ${JSON.stringify(extVersion)};
      // When non-empty, this webview is a popped-out editor tab dedicated
      // to a SINGLE session — the chat shell renders only that session and
      // hides the multi-session tab chrome. Empty = the normal sidebar.
      window.__ORIGAMI_SOLO_SESSION__ = ${JSON.stringify(soloSessionId ?? '')};
      // When true, this webview is a full editor tab dedicated to the memory
      // graph — the chat shell renders only WikiSearchPane.
      window.__ORIGAMI_MEMORY__ = ${JSON.stringify(!!memory)};
      // When true, this webview is the Agent Manager board — the chat shell
      // renders only AgentManagerPane.
      window.__ORIGAMI_BOARD__ = ${JSON.stringify(!!board)};
      // A race-Compare editor tab: the chat shell renders only RaceCompareScreen, seeded with this race identity (S6d).
      window.__ORIGAMI_RACE_COMPARE__ = ${JSON.stringify(raceCompare ?? null)};
      // A repo-map editor tab: the chat shell renders only RepoMapScreen, seeded with the validated map (S15).
      window.__ORIGAMI_REPO_MAP__ = ${JSON.stringify(repoMap ?? null).replace(/</g, '\\u003c')};
      // A collab editor tab: the chat shell renders only CollabPane, seeded with the collab IDENTITY (M1) - the stream itself is polled, never injected.
      window.__ORIGAMI_COLLAB__ = ${JSON.stringify(collab ?? null).replace(/</g, '\\u003c')};
      // origamicoder.remote.enabled and origamicoder.flock.enabled, read once so the board can drop the Remote row (remote-hide lane) and the Flock row + sidebar Front Desk (flock-messenger lane) while either is off.
      window.__ORIGAMI_REMOTE_ENABLED__ = ${JSON.stringify(vscode.workspace.getConfiguration('origamicoder.remote').get<boolean>('enabled', false))}; window.__ORIGAMI_FLOCK_ENABLED__ = ${JSON.stringify(flockEnabled())};
      // origamicoder.chat.backdrop (t-qn0wj5, proposal 24): read once, same as the two lines above.
      window.__ORIGAMI_CHAT_BACKDROP__ = ${JSON.stringify(chatBackdropEnabled())};
      // Chat density (t-qn0wj5, proposal 26), read once from workspaceState; a change made
      // in the Insights pane applies on the next reload, the same as devEngineSource.
      window.__ORIGAMI_CHAT_DENSITY_COMPACT__ = ${JSON.stringify(chatDensityCompact({ workspaceState: () => this.context.workspaceState }))};
      // Schedules tab (t-ru1qsp), read once from workspaceState the same way: which of Crons/Loops the Schedules view reopens on.
      window.__ORIGAMI_SCHEDULE_TAB__ = ${JSON.stringify(scheduleTab({ workspaceState: () => this.context.workspaceState }))};
      const banner = document.getElementById('permModeBanner');
      window.addEventListener('message', (ev) => {
        const msg = ev.data || {};
        if (msg.type !== 'permModeUpdate') return;
        const mode = msg.mode || 'default';
        const text = msg.text || '';
        banner.setAttribute('data-mode', mode);
        banner.textContent = text;
      });
    })();
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /** Record a session's mode and repaint the sticky banner — the single write path
   *  for the banner, called from the engine's live `onModeChanged` stream and from
   *  every mode write the extension issues itself (slash commands, the InputBar
   *  toggle, the optimistic revert). No polling.
   *
   *  Repaints EVERY view, not just the focused one: a background chat's popped-out
   *  tab carries a banner for that chat, so its mode change has a surface to reach. */
  private applyPermissionMode(sessionId: string, modeId: string): void {
    this.permBanner.set(sessionId, modeId);
    this.paintPermissionBanner();
  }

  /** Repaint each view's banner from the mode of the session THAT view speaks for — its
   *  solo session for a popped-out tab, the focused one for the sidebar — falling back
   *  to that session's engine `mode` config-option while no mode event has fired. */
  private paintPermissionBanner(): void {
    this.postTo(this.panel.webview, this.permBannerMsg(undefined));
    for (const view of this.extraViews) this.postTo(view, this.permBannerMsg(this.viewSolo.get(view)));
  }

  /** One view's banner payload. `solo` empty/undefined = the sidebar. */
  private permBannerMsg(solo: string | undefined): object {
    const engineMode = (solo ? this.sessions.get(solo) : this.getActiveSession())?.client.getModeOption()?.current;
    const mode = this.permBanner.modeForView(solo, this.activeSessionId, engineMode);
    return { type: 'permModeUpdate', mode, text: permBannerCopy(mode) };
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

/**
 * Render a session's webview-side message log to a markdown transcript.
 * User-facing: the chat header's export button → `exportSession` → Save As.
 *
 * Shape per message: the webview's `ChatSession.messages` array. Each entry is
 * loosely type-checked because the webview ships its `Message` interface across
 * the wire and TypeScript enforces no runtime invariants. Unknown kinds fall
 * through to a generic blockquote so nothing is silently dropped.
 */
function renderSessionMarkdown(agent: string, messages: unknown[]): string {
  const lines: string[] = [];
  const stamp = new Date().toISOString();
  lines.push(`# Origami session — ${agent}`);
  lines.push(`*Exported ${stamp}*`);
  lines.push('');

  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as {
      kind?: string;
      label?: string;
      text?: string;
      toolName?: string;
      toolStatus?: string;
      toolResult?: string;
    };
    switch (m.kind) {
      case 'user':
        for (const ln of (m.text ?? '').split('\n')) {
          lines.push(`> ${ln}`);
        }
        lines.push('');
        break;
      case 'agent':
        if (m.text) {
          lines.push(m.text);
          lines.push('');
        }
        break;
      case 'system':
        lines.push(`*${m.text ?? ''}*`);
        lines.push('');
        break;
      case 'error':
        lines.push(`> [!ERROR] ${m.text ?? ''}`);
        lines.push('');
        break;
      case 'tool': {
        const name = m.toolName || m.label || 'tool';
        const status = m.toolStatus || 'completed';
        lines.push(`### Tool: ${name} (${status})`);
        if (m.toolResult) {
          // Wrap tool result in a fenced code block; trim to keep
          // the export readable on huge results (e.g. read_file).
          const body = m.toolResult.length > 4000
            ? m.toolResult.slice(0, 4000) + '\n…(truncated)'
            : m.toolResult;
          lines.push('```');
          lines.push(body);
          lines.push('```');
        }
        lines.push('');
        break;
      }
      default:
        // Unknown kind — emit as a quoted block so the transcript captures the content
        // without claiming structure that doesn't exist.
        if (m.text) {
          lines.push(`> ${m.text}`);
          lines.push('');
        }
    }
  }

  return lines.join('\n');
}
