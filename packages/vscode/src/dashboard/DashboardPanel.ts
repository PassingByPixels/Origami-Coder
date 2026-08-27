// Dashboard webview panel — singleton. Hosts the Svelte dashboard.
// Manages multiple ACP chat sessions internally — each session is
// a tab within the chat pane, not a separate VS Code panel.

import * as vscode from 'vscode';
import { AcpClient, type AcpEventHandlers, resolveOrigamiBinary } from '../acpClient';
import { questionAnswers, type QuestionAnswer } from '../questionBatch';
import { execFile } from 'node:child_process';
import { findWorkspacePath, readSettings, readWorkspaceData, readWikiPagesFromDir, resolveDefaultWikiPages, readAgentArt, displayAgentName } from '../workspace/WorkspaceReader';
import type { StatusBarController } from '../statusBar/StatusBarController';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { runFirstFold, writeModelConfig, writeModelContextLimit, shouldReloadLocalModel, removeProviderConfig, renameProviderConfig, detectLocalProvider, isLoopbackBaseUrl, detectModel, listConfiguredModels, readModelVision, writeModelVision, readAgentFrequencyPenalty, writeAgentFrequencyPenalty, readGlobalProviders, agentsMdTemplate, needsFirstFold, type FirstFoldEmit, type ModelChoice } from './firstFold';
import { isSelfHostedBaseUrl } from './selfHosted';
// The self-hosted HTTP probes, extracted to localProbe.ts (DashboardPanel.ts was
// at 6335/6336). Each takes an optional apiKey — see that file's header.
import { fetchModelInfo, fetchModelWindowFor, fetchLmStudioModels, detectLocalFlavor, primaryLocalApiKey, type ModelInfo } from './localProbe';
import { contextLimitWarner } from './contextLimitWarning';
import { detectVision, fetchVisionProbe, type VisionMap } from './visionDetect';
import { applyVisionPin, readVisionPin, splitModel, visionStateFor, visionWrites, type VisionState } from './visionPin';
import { mergeLiveModels } from './liveModelMerge';
import { sweepEntitledModels } from './gatewayEntitlements';
import { probeConcurrently, PROVIDER_PROBE_TIMEOUT_MS } from './providerProbe';
import { setupProvider } from './setupProvider';
import { refreshingWriter, type RefreshTarget } from './providerRefresh';
import { KEY_ONLY_PRESETS, checkProviderKey, fetchCatalogIds, pickDefaultModel } from './keyOnlyPresets';
import { readSpend, accrueSessionSpend, readBudget, writeBudget, isOverBudget, budgetBlocks, accrueSessionSpendUnlessOAuth } from './spend';
import { PermissionBannerState } from './permissionBanner';
import { engineSpawnStaleNotice } from './engineStale';
import { agentBoundary, collectAgentTextSince, parseLoopCommand, buildScheduledRunPrompt, formatInterval, parseLoopDone, buildComposePrompt } from './chatCommands';
import { collectLoopSchedules, toNeedsAttentionLoops, type LoopOutcome, type LoopScheduleInfo, type NeedsAttentionLoop } from './loopSchedules';
import { runStepsPayload, instructionsPayload } from './boardData';
import { runStatsPayload, statIds } from './runStats';
import { subagentTranscriptPayload } from './subagentTranscript';
import { collabSessionMarks, collabStepsPayload } from './collabSteps';
import { historyRows, openTabFor } from './historyRows';
import { promptCapturePayload, promptCaptureForSession } from './promptCapture';
import { cacheStatsPayload } from './cacheStats';
import { peerLogEntry } from './peerMessages';
import { archiveLog, logSubagentDone, logToolCall, logToolResult, type SessionMessage } from './sessionLog';
import { ensureBrowserToolsConsent } from '../browserToolsConsent';
import { broadcastBrowserAutoApprove, setBrowserAutoApprove } from './browserAutoApproveControl';
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
import { SKILLS_PANE_MESSAGE_TYPES, handleSkillsPaneMessage } from './skillsPane';
import { liveActiveSessionId } from './activeSession';
import { configSelectorMessages, allConfigSelectorMessages } from './configSelectors';
import { startThenAnnounce } from './sessionAnnounce';
import { rewireView } from './viewWiring';
import { PLUGINS_PANE_MESSAGE_TYPES, handlePluginsPaneMessage } from './pluginsPane';
import { LABYRINTH_PRICES_MESSAGE_TYPES, LABYRINTH_PRICES_KEY, handleLabyrinthPricesMessage } from './labyrinthPrices';
import { MCP_PANE_MESSAGE_TYPES, handleMcpPaneMessage } from './mcpPane';
import { PROVIDER_AUTH_MESSAGE_TYPES, handleProviderAuthMessage, openExternalUrl, offerReload, oauthConnectedIds } from './providerAuthPane';
import { PROVIDER_USAGE_MESSAGE_TYPES, handleProviderUsageMessage } from './providerUsage';
import { validateMap } from './agentManager/mapSchema';
import { loadKnownRepos, saveKnownRepos, pickRepoFolder, loadAutoApprove, saveAutoApprove, loadAgentTypes, saveAgentTypes } from './agentManager/registry';
import { modesFromOption } from './agentManager/agentTypes';
import { syncRepoFile } from './agentManager/repoFile';
import { activityLine } from './agentManager/tickets';
import { decideAgentPermission } from './agentManager/permScope';
import { isSessionMounted, boardAggregate, aggregateText, questionPreview, resolvePermission, drainPermissions } from './agentManager/attention';
import { applyTabIcon, waitingTitleFor } from './tabIcon';
import { shouldBufferQuestion, questionReplayAction, type BufferedQuestionPerm } from './agentManager/questionRouting';
import { engineSessionId } from './engineSessionId';
import { openPermissionPreview } from './agentManager/permissionPreview'; import { permissionCommand } from './agentManager/permissionCommand'; import { TURN_MESSAGE_TYPES, handleTurnMessage } from './turnMessages'; import { postPeerName } from './peerNamePost'; // panel is at its cap; implementations stay in leaves
import { permissionTarget, replayDecision, notePersistablePermission, commitPersistablePermission, loadPersistentPermissions } from './agentManager/persistentPermissions';
import { loadOpenSet, saveOpenSet, restoreOpenSet, type OpenSetState } from './agentManager/sessionRestore';
import { rankEntries } from './agentManager/sessionOrder';
import { loadPersistedLoops, savePersistedLoop, removePersistedLoop, splitPersistedLoops, armRestoredLoops, isPersistent, setPersistedLoopPersistence, type PersistedLoop } from './agentManager/loopPersistence';
import { planLoopReopen, reopenLoopChat } from './agentManager/loopReopen';
import { loadChatSections, saveChatSections, pruneChatSections } from './chatSections';
import { CHAT_SECTION_MESSAGE_TYPES, handleChatSectionMessage, type ChatSectionsManagerHost } from './chatSectionsManager';
import { CronService } from './crons/cronService';
import { defaultBackend } from './crons/schedulerBackend';
import { cronLogPath, cronLogRelPath } from './crons/cronCommand';

/** Module-level ref so DashboardPanel can update the status bar. */
let statusBarRef: StatusBarController | undefined;

const SESSIONS_DIR = path.join(os.homedir(), '.origami', 'sessions');

/**
 * Read current profiling mode + VRAM headroom from settings.toml. Returns
 * safe defaults if the file doesn't exist yet. Matches the logic in
 * `Settings::effective_vram_headroom_mb()` on the Rust side.
 */
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
    // leave defaults
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
  // Only record a session that actually had a TURN — i.e. the user sent at
  // least one message. A freshly-opened chat accumulates non-user log entries
  // (a boot/agent line, tool markers) but no user message and no generated
  // title; without this guard every accidental "New chat" gets saved to
  // history as an empty "New session — <timestamp>" row.
  if (!session.messageLog.some((m) => m.kind === 'user')) return;
  // Recalled (engine-backed) sessions are owned by the engine's own store —
  // don't write a duplicate UI-cache copy each time they're recalled.
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

/**
 * Pillar 3 dashboard upgrade (2026-05-22) — case-insensitive
 * substring search across saved session transcripts. Returns the
 * same row shape as `listSavedSessions` plus an optional `snippet`
 * field showing the first matching message (~120 chars trimmed
 * around the hit). Caps at 50 hits to keep the scan snappy.
 *
 * Scans BOTH active and archived sessions because users searching
 * for older work will most often want archived hits surfaced. The
 * caller decides whether to render an "include archived" UI
 * affordance; the search ignores the toggle.
 */
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
        // Cheap matches first: agent name + id substring before
        // scanning the message log.
        const lowAgent = data.agentName.toLowerCase();
        const lowId = data.id.toLowerCase();
        let snippet: string | undefined;
        let matched = false;
        if (lowAgent.includes(q) || lowId.includes(q)) {
          matched = true;
        } else {
          // Scan messages — stop at the first hit per session so
          // the cap reflects "matching sessions", not "matching
          // messages".
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
    // V23 close (cozy-lantern): include sessions/archived/ so the
    // ArchivePane "Show archived" toggle has data to render. Caller
    // controls whether they're surfaced to the user.
    if (opts.includeArchived) {
      readDir(path.join(SESSIONS_DIR, 'archived'), true);
    }
    // Newest first; archived rows interleave by timestamp so a user
    // can spot recently-archived chats without scrolling past every
    // active one. ArchivePane decides the visual grouping.
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
  /** Working directory the engine child was spawned with (`--cwd`). The
   *  workspace root for ordinary chats; an isolated git worktree for Agent
   *  Manager sessions. Frozen at create time — it must match the running
   *  engine child, not whatever the workspace folders later become. */
  cwd: string;
  /** 'agent' = an Agent Manager worktree session: created programmatically,
   *  never steals focus and never auto-opens an editor tab. Unset/'chat' =
   *  an ordinary user chat (today's only caller). */
  kind?: 'chat' | 'agent';
  /** The bot glyph this chat was created AS — the creature its empty state opens under. */
  botGlyph?: string;
  client: AcpClient;
  /** `answers` carries a BATCHED question reply (one entry per question the
   *  modal showed); absent for a single ask and for every real permission. */
  pendingPermissions: Map<string, (optionId: string | null, answerText?: string, answers?: ReadonlyArray<QuestionAnswer>) => void>;
  estimatedTokens: number;
  messageLog: SessionMessage[];
  /** This session's OWN resolved context window + vision, provider-aware (a remote
   *  vLLM's max_model_len, or LM Studio's loaded window). Per-session so a chat on
   *  another provider running side by side never stamps its window onto this one.
   *  Undefined until first probed (focus / model-set / the poll recovery). */
  modelWindow?: number;
  /** The FULL model id (provider/model) `modelWindow` was probed FOR. A window
   *  belongs to a model, not a session — after a model switch the cached value
   *  is a stale lie (chat probed as LM Studio, switched to the Spark, kept 0 /
   *  the LM window forever). Readers must treat a mismatch as unknown and the
   *  poll recovery re-probes on it. */
  modelWindowFor?: string;
  modelIsVlm?: boolean;
  /** Active /loop scheduler for this session (a timer that re-runs a prompt on
   *  an interval). Cleared on /loop stop, Stop, the Loops-pane cancel control,
   *  session close, or a permanent-done run — stopLoopSchedule is the one
   *  choke point for all of those. Persisted (agentManager/loopPersistence.ts)
   *  so it survives a window reload: re-armed with `runs` preserved and its
   *  next tick scheduled a full interval out, never immediately.
   *  `persistent` opts the loop OUT of dying with its chat: on session close it
   *  is recalled headlessly instead of stopped (see recallLoopHeadless). It
   *  still stops dead when VS Code closes — that is a cron's job, not a loop's. */
  // nextRunAt is stamped at the ONE place a timer is armed (armLoopTimer) and
  // cleared the moment a run starts, so it can only ever describe a timer that
  // is really installed. lastRunAt/lastOutcome are live-only (a reload starts
  // them empty rather than guessing from the persisted run count).
  loopSchedule?: {
    timer?: ReturnType<typeof setTimeout>; intervalMs: number; prompt: string; runs: number;
    stopped: boolean; createdAt: number; persistent: boolean;
    nextRunAt?: number; lastRunAt?: number; lastOutcome?: LoopOutcome;
  };
  /** True while a turn is being awaited on this session (manual send, compose,
   *  or a scheduled loop run). A scheduled /loop run checks this
   *  and SKIPS its cycle rather than racing a second concurrent prompt() on the
   *  one ACP session (e.g. the user chats during the loop's interval gap). */
  turnBusy?: boolean;
  /** Cumulative real token spend for the cross-session Context tracker, accrued
   *  from each turn's prompt-response usage: prefill = input/prompt tokens, read
   *  = cache-read tokens, write = generated/output tokens. Live-only (resets on
   *  reload). Distinct from `estimatedTokens` (a turn counter) and from cost. */
  // `write` here is OUTPUT tokens (generated). `cacheWrite` is a SEPARATE
  // number — prompt-cache tokens written this turn — never coalesce the two.
  tokenUsage?: { prefill: number; read: number; write: number; cacheWrite: number };
  /** When set, this UI session was created by RECALLING an engine session
   *  (loadSession). The engine owns the canonical transcript, so we do NOT
   *  also persist a homegrown UI-cache JSON for it — otherwise recalling the
   *  same chat K times writes K duplicate archive files. */
  loadedFromEngineId?: string;
  /** Display task name (tab + sidebar + editor-tab). Starts as a slug of the
   *  first user message, then upgrades to the engine's generated title. */
  title?: string;
  /** True once the engine's generated title has been adopted (stops the
   *  best-effort listSessions re-query). */
  engineTitleResolved?: boolean;
  /** Bounded re-query attempts for the engine title (caps the polling). */
  titleAttempts?: number;
  /** Absolute path of the most recent plan file the agent wrote (a *.md under
   *  a plans/ dir). Opened in preview when the plan_exit approval modal shows
   *  so the user can read the plan before accepting/denying. */
  lastPlanPath?: string;
  /** Absolute path of the most recent dream candidate the agent wrote
   *  (`.../memory.candidate.md`). When the native `dream` tool's review
   *  question fires, this opens a vscode.diff of the live memory.md vs the
   *  candidate so the user reviews the reorganisation before adopting.
   *  Sibling of `lastPlanPath`. */
  lastDreamCandidatePath?: string;
}


/** Safe default context (tokens) to load a model at when there's no real loaded
 *  window to inherit — small enough to fit any model on a consumer GPU. The user
 *  raises it via the ControlStrip context input + Apply. NEVER load at a model's
 *  declared max (e.g. 262144) — that OOMs. */
const DEFAULT_LOAD_CTX = 32768;

/** Resolve the `lms` CLI (LM Studio's model-management tool). LM Studio exposes
 *  NO REST load/unload endpoint — the CLI (or the GUI) is the only way to load a
 *  model at a chosen context, unload it, or list the library. Prefer the known
 *  install path, fall back to PATH. */
function lmsBinary(): string {
  const home = os.homedir();
  const win = path.join(home, '.lmstudio', 'bin', 'lms.exe');
  const nix = path.join(home, '.lmstudio', 'bin', 'lms');
  if (os.platform() === 'win32' && fs.existsSync(win)) return win;
  if (fs.existsSync(nix)) return nix;
  return os.platform() === 'win32' ? 'lms.exe' : 'lms';
}

/** Run an `lms` subcommand, capturing stdout/stderr. `-y` / explicit ids keep
 *  every call non-interactive (a bare `lms load`/`unload` would prompt and hang
 *  a spawned process). Load can take tens of seconds, hence the long timeout. */
function runLms(args: string[], timeoutMs = 240000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(lmsBinary(), args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}


/** OpenRouter is HTTPS, and the httpGetJson helper above is node:http only, so
 *  these two use the extension host's global fetch (Node 18+). Both are
 *  best-effort with a short timeout so a slow/dead network can never hang the UI. */

/** Validate an OpenRouter API key — GET <base>/key, the truthful "OpenRouter
 *  Live" signal (reachable AND the user's key works), not a mere ping. The probe
 *  itself now lives in keyOnlyPresets.ts alongside every other preset's, so no
 *  provider's key can be checked against another provider's endpoint; this stays
 *  as the named call site the pill probe reads. */
function openRouterKeyValid(
  apiKey: string,
  baseURL = 'https://openrouter.ai/api/v1',
): Promise<{ ok: boolean; reason?: string; label?: string; freeTier?: boolean }> {
  return checkProviderKey({ presetId: 'openrouter', apiKey, baseURL, fetchImpl: fetch });
}

/** Fetch OpenRouter's model catalog (GET <base>/models). `free` = both prompt
 *  and completion prices are 0 (":free"/$0 models) — used to default a free-tier
 *  key to a usable model and to populate the in-chat picker. `contextLength` is
 *  OpenRouter's own `context_length` for the model (undefined when the entry
 *  carries none) — refreshModelInfoFor below reads it to give an OpenRouter
 *  session's gauge a REAL live window instead of the build-frozen catalog
 *  fallback, since fetchModelInfo's node:http probe (localProbe.ts) can never
 *  reach an https: endpoint like openrouter.ai. Best-effort: [] on any failure. */
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
        // OpenRouter prices are USD PER TOKEN; the engine's model.cost is USD per
        // MILLION tokens (session.ts divides by 1e6), so scale up.
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

/**
 * Minimal structural host the DashboardPanel needs from whatever VS Code
 * surface owns the webview. Both a full-panel `vscode.WebviewPanel` and a
 * sidebar `vscode.WebviewView` (wrapped by the sidebar ChatViewProvider)
 * expose exactly these members, so the same session/message-bus machinery
 * drives the chat in either surface without duplicating the loop.
 *
 *   - `webview`        — the real wire (postMessage / onDidReceiveMessage /
 *                        asWebviewUri / cspSource). All chat work flows here.
 *   - `onDidDispose`   — teardown hook so ACP children are killed + sessions
 *                        saved when the surface goes away.
 *   - `reveal`         — bring the surface forward (panel: focus the column;
 *                        view: noop — VS Code owns sidebar focus).
 *   - `dispose`        — release the surface (panel: close it; view: noop —
 *                        a WebviewView is owned by VS Code, not us).
 */
/** What the Labyrinth pane persists about its columns (t-q41pe0). `collapsed`
 *  is a FLAG and not a width of 0, so hiding the inspector keeps the width the
 *  user dragged to instead of erasing it. */
interface LabyrinthColumns { indexWidthPx?: number; inspectWidthPx?: number; inspectCollapsed?: boolean }

export interface WebviewHost {
  readonly webview: vscode.Webview;
  onDidDispose(listener: () => void, thisArgs?: unknown, disposables?: vscode.Disposable[]): vscode.Disposable;
  reveal(): void;
  dispose(): void;
}

/**
 * Which webview bundle a DashboardPanel instance renders. All bundles
 * speak the IDENTICAL host↔webview protocol and are driven by the same
 * session machinery — only the layout differs:
 *   - `dashboard` → out/webview/dashboard.js (App.svelte, full multi-pane
 *      console — REMOVED; no longer built or reachable).
 *   - `config`    → the old left-activity-bar SETUP surface (ConfigView) —
 *      REMOVED; no longer built or reachable. Settings now live in the chat
 *      sidebar (ControlStrip + theme switcher in SidebarLauncher).
 *   - `chat`      → out/webview/chat.js (ChatView.svelte, the chat thread
 *      + composer + new-chat tabs with a minimal honest status badge).
 *
 * The old combined `sidebar` bundle (Sidebar.svelte) was split into
 * config + chat and removed.
 *
 * Every live bundle emits a sidecar `<bundle>.css` (its Svelte entry
 * imports shared/theme.css, which esbuild extracts) carrying the four
 * `:root[data-theme]` palettes; renderHtml links it so the in-panel
 * --og-* vars are defined and data-theme switching repaints independent
 * of the VS Code workbench theme.
 */
export type WebviewBundle = 'dashboard' | 'config' | 'chat';

/**
 * The shipped prompts the Instructions pane can seed, edit and restore.
 *
 * The webview only ever names a KIND. Each kind is resolved here against the
 * engine's own `list_instructions` reply and re-checked against `file` before
 * anything is written or deleted, so a compromised webview cannot aim either
 * write at a path of its choosing. `field` is where the engine carries that
 * prompt's effective text and override path.
 *
 * M4.1 dropped `collab-manual` — the room manual is part of the one collab
 * base prompt now, and `list_instructions` has no field left to resolve it
 * against (see acpExtTypes' OverrideSource).
 */
const OVERRIDE_PROMPTS = {
  'base-prompt': { field: 'basePrompt', file: 'base-prompt.md', label: 'base prompt' },
  'collab-agent-base': { field: 'collabAgentBase', file: 'collab-agent-base.md', label: 'collab base prompt' },
} as const;
type OverridePromptKind = keyof typeof OVERRIDE_PROMPTS;
const overrideKind = (value: unknown): OverridePromptKind =>
  value === 'collab-agent-base' ? value : 'base-prompt';

export class DashboardPanel {
  public static current: DashboardPanel | undefined;

  /** Editor-area chat tabs popped out PER SESSION (each scoped to one
   *  session via the injected `__ORIGAMI_SOLO_SESSION__` global), keyed by
   *  sessionId. Lets each chat live in its OWN movable/draggable editor
   *  tab, distinct from the others — instead of all sharing the sidebar.
   *  A second pop-out of the same session reveals its existing tab. */
  private static sessionPanels = new Map<string, vscode.WebviewPanel>();

  /** Blue-dot the popped-out editor tab's TITLE while pendingAskCount > 0
   *  (session.pendingPermissions, see onPermissionRequest), strip it at 0.
   *  The tab ICON is never touched at runtime — see tabIcon.ts for the saga.
   *  No-op with no solo tab — a sidebar-only chat's waiting signal is the
   *  sidebar ring instead (t-q6jxrs). */
  private static syncTabIcon(_context: vscode.ExtensionContext, sessionId: string, pendingAskCount: number): void {
    const panel = DashboardPanel.sessionPanels.get(sessionId);
    if (!panel) return;
    panel.title = waitingTitleFor(panel.title, pendingAskCount);
  }

  /** The single full-screen memory-graph editor tab (injected
   *  `__ORIGAMI_MEMORY__` global). Reopening reveals the existing tab. */
  private static memoryPanel: vscode.WebviewPanel | undefined;

  /** The single Agent Manager board editor tab (injected `__ORIGAMI_BOARD__`
   *  global). Reopening reveals the existing tab. */
  private static agentBoardPanel: vscode.WebviewPanel | undefined;

  /** Lazy fleet owner behind the Agent Manager board (agentManager/manager.ts).
   *  Created on first board message; reaches back only via ManagerHost. */
  private agentManagerInstance: AgentManager | undefined;


  /** S7.1 — an agent QUESTION arrives as a requestPermission ask (no origami/question emitter); with no
   *  view mounted, buffer it here (respond stays in pendingPermissions) and replay on mount, never auto-answer. */
  private readonly pendingQuestionPermissions = new Map<string, BufferedQuestionPerm>();

  /** Per-session in-flight guard so two near-simultaneous pop-outs of the
   *  same session (title button + tab button) don't spawn duplicate tabs
   *  across the `await` window. */
  private static openingSessions = new Set<string>();

  /** Wire the status bar controller so agent/model switches update it. */
  public static setStatusBar(sb: StatusBarController): void {
    statusBarRef = sb;
  }

  private readonly panel: WebviewHost;
  /**
   * NOTE 4 — shared-host multi-view broadcast. The single DashboardPanel
   * owns the ACP session machinery; the config view and the chat view are
   * two webviews onto the SAME host. `panel` is the primary (owns
   * lifecycle/dispose); `extraViews` are additional webviews that receive
   * every outbound `post()` broadcast (modelStatus / contextUpdate /
   * themeChanged / permModeUpdate) AND route their inbound control/chat
   * messages into the same `handleWebviewMessage`. This keeps config
   * status and chat status in agreement and lets the chat run turns
   * against the model the config selected, with no duplicated session
   * loop. Inbound routing is direction-agnostic: both wires call the same
   * handler, so a `send` from chat and a `switchModel` from config land in
   * the same place.
   */
  private readonly extraViews: vscode.Webview[] = [];
  private readonly sessions = new Map<string, Session>();
  private readonly disposables: vscode.Disposable[] = [];
  private activeSessionId: string | null = null;
  /** S7 — the SIDEBAR chat's last-reported grid layout (grid tiles EVERY session visibly). */
  private sidebarGridMode = false;

  /** The wider context collabManager.ts's dispatcher needs — same shape
   *  agentManager() builds ManagerHost from. Built fresh per dispatch (the
   *  dispatcher itself holds no state, unlike AgentManager's runtime maps),
   *  so there is no instance field to keep in step. */
  private collabManagerHost(): CollabManagerHost {
    return {
      post: (msg) => this.post(msg),
      cwd: () => this.cwd,
      // Collabs are WORKSPACE-scoped (keyed by cwd), not session-scoped, so
      // any live client answers for them — same active-then-any resolution
      // the board leaves already use.
      collabClient: () => (this.getActiveSession() ?? [...this.sessions.values()][0])?.client,
      collabOrder: () => this.context.workspaceState.get<string[]>(COLLAB_ORDER_KEY) ?? [],
      saveCollabOrder: (order) => void this.context.workspaceState.update(COLLAB_ORDER_KEY, order),
      openCollab: (id, title) => DashboardPanel.openCollabInEditor(this.context, { id, title }),
      promptCaptureFor: (sessionId) => {
        const session = this.getActiveSession() ?? [...this.sessions.values()][0];
        return promptCaptureForSession(session?.client, sessionId);
      },
      startBotSession: (slug, displayName, glyph) => startBotSession({ create: (n, agent) => this.createSession(n, undefined, undefined, { engineAgent: agent, botGlyph: glyph }), clientOf: (sid) => this.sessions.get(sid)?.client }, slug, displayName),
    };
  }

  /** Same convention as collabManagerHost() above, for chatSectionsManager.ts
   *  (t-kgserq v2, extracted out of this file's own switch at its cap). */
  private chatSectionsManagerHost(): ChatSectionsManagerHost {
    return {
      post: (msg) => this.post(msg),
      workspaceState: () => this.context.workspaceState,
    };
  }

  /**
   * S7 V10 (bright-muffin) — id remembered across dashboard close/reopen
   * via `context.workspaceState`. Read on initialize, replayed to the
   * webview after each createSession (whichever new session matches the
   * stored id flips activeSessionId). Cleared once a real chat picks
   * up. Pairs with `restoreActiveSession` in ChatPane.svelte.
   */
  private static readonly ACTIVE_SESSION_KEY = 'origami.activeSessionId';
  /** t-kgserq — the sidebar's draggable Chats/Collabs divider: the Collabs
   *  half's dragged height in px, or absent for the default 50/50 split. */
  private static readonly COLLABS_HEIGHT_KEY = 'origami.collabsSectionHeight';
  /** t-q41pe0 — the Labyrinth pane's two resizable columns (run index left,
   *  inspector right): each column's dragged width in px, or absent for its
   *  default. Same shape as COLLABS_HEIGHT_KEY above; a separate key because
   *  the two features share no data. */
  private static readonly LABYRINTH_COLUMNS_KEY = 'origami.labyrinthColumnWidths';
  private pendingRestoreSessionId: string | null = null;
  private restoring = false; // Feature 2 — suppress open-set saves while the boot session connects + the restore loop runs (interleaved activeSessionChanged echoes would persist a premature empty/partial set).

  /**
   * Cron + ambient activity stream output channel.
   *
   * Created lazily the first time the bridge pushes an
   * `origami/feedMessage`. Each `BusMessage` becomes one timestamped
   * line in the channel — Passing can open `View > Output > Origami
   * Activity` to see a live feed of what's running in the background.
   *
   * The webview also receives the same payload via `feedMessage`
   * so the plain Activity feed pane can render structured rows
   * without needing another wire.
   */
  private static activityChannel: vscode.OutputChannel | undefined;

  /**
   * Format and append one `BusMessage` to the Origami Activity output
   * channel. Best-effort — never throws even on malformed payloads.
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
   * Render a one-line human summary of a `BusMessage` for the
   * activity channel. Variants the user cares about most (cron job
   * events, model load/unload, ambient turns) get explicit
   * formatting; the rest fall through to a JSON-tail. Unbranded —
   * matches the dashboard ActivityFeed's flat coder-first style.
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
    // Cron job start/complete + anything else: decode a job_name if one
    // is present (possibly nested under a `kind` envelope), else show the
    // bus kind + a short JSON tail. No per-agent decoding.
    const kind = payload['kind'];
    const jobName = payload['job_name'];
    if (kind === 'job_started') return `[cron] job started: ${jobName ?? '?'}`;
    if (kind === 'job_completed') return `[cron] job completed: ${jobName ?? '?'}`;
    if (typeof jobName === 'string') return `[${busKind}] ${jobName}`;
    return `[${busKind}] ${JSON.stringify(payload).slice(0, 200)}`;
  }

  /**
   * Reveal the primary Origami surface — the crane chat view (now in the
   * secondary side bar). The full-panel "dashboard" webview was removed and
   * the combined sidebar was split into config + chat; the shared
   * DashboardPanel host (registered as `DashboardPanel.current` by
   * resolveSharedView) drives both. If the host has already resolved we
   * reveal the chat; otherwise we focus the chat view, which lazily
   * resolves the WebviewViewProvider (and creates the first session via
   * `initialize()`).
   */
  public static async createOrShow(_context: vscode.ExtensionContext): Promise<void> {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      // Also focus the sidebar chat view. If the primary host died (e.g. the
      // sidebar was closed while a chat was popped out into its own editor
      // tab), `.current` still points at the instance but its primary webview
      // is a corpse, so `reveal()` above hit a dead wire. Focusing the view id
      // re-resolves the ChatViewProvider, which re-attaches via
      // resolveSharedView → attachView + replaySessionsTo, so the reopened
      // sidebar shows every live session. Harmless when the primary is alive
      // (focus just reveals the already-resolved view).
      await vscode.commands.executeCommand('origami.chatView.focus');
      return;
    }
    // Not resolved yet — focus the Origami CHAT view so VS Code
    // instantiates the ChatViewProvider (which calls resolveSharedView →
    // registers .current and bootstraps a session). Focusing the view id is
    // order-independent and works wherever the user has docked it (the
    // secondary side bar by default).
    await vscode.commands.executeCommand('origami.chatView.focus');
  }

  /**
   * Pop the chat out into a MOVABLE editor-area tab (draggable across
   * editor groups, splittable, floatable to a new window). The
   * `WebviewHost` abstraction was built for exactly this — a real
   * `WebviewPanel` backs `reveal`/`dispose`/`onDidDispose` (unlike the
   * sidebar view's no-op stubs).
   *
   * SAFETY: we ensure the sidebar host exists FIRST (createOrShow), so the
   * editor tab attaches as a SECONDARY mirror via `resolveSharedView` →
   * `attachView` (its `onDidDispose` only splices it out of `extraViews`).
   * It must never be the PRIMARY host, whose `dispose()` tears down every
   * session's ACP child. If the sidebar somehow isn't up yet, the editor
   * tab legitimately becomes the primary (there are no other sessions to
   * lose), which is also safe.
   */
  public static async openInEditor(context: vscode.ExtensionContext): Promise<void> {
    // Pop the ACTIVE chat out into its own movable editor tab.
    if (!DashboardPanel.current) {
      // Sidebar not up yet — bring it up first so there's an active session
      // to pop out, then pop it.
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

  /**
   * Pop ONE session out into its own movable editor-area tab, scoped to
   * that single session via the injected `__ORIGAMI_SOLO_SESSION__` global.
   * Multiple sessions can be popped out at once — each is a distinct,
   * natively draggable/splittable/floatable editor tab. Re-popping a
   * session reveals its existing tab.
   *
   * SAFETY: the sidebar host stays PRIMARY (owns the ACP sessions); every
   * popped tab attaches as a SECONDARY mirror via `attachView`, whose
   * onDidDispose only splices it out of `extraViews` — closing a popped tab
   * NEVER disposes the session (the primary's `dispose()` is additionally
   * guarded to refuse teardown while any extraViews remain).
   */
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
      // Ensure the sidebar is PRIMARY and `.current` is registered before
      // we attach the popped tab as a secondary mirror. createForHost sets
      // `.current` synchronously (before its slow initialize), so the poll
      // settles fast.
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
      // Guard against a stale id (the session was closed between the click
      // and here): a solo tab for a non-existent session would render a
      // permanent "No session" stub that never self-heals. Bail BEFORE
      // creating the panel.
      const session = host.sessions.get(sessionId);
      if (!session) {
        vscode.window.showInformationMessage('Origami: that chat is no longer open.');
        return;
      }
      // Tab label stays compact — just "Tsuru #N" — to save tab-strip space.
      // The descriptive task title shows in the sidebar session list (which is
      // where you link to chats), not on the editor tab.
      const title = `${session.agentName} #${session.number}`;

      const panel = vscode.window.createWebviewPanel(
        'origami.chatPanel',
        title,
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')],
        },
      );
      // Brand the editor tab with the Origami crane, once — never changed at
      // runtime (see tabIcon.ts). The waiting signal is the title's blue dot.
      applyTabIcon(panel, (name) => vscode.Uri.joinPath(context.extensionUri, 'media', name));
      panel.title = waitingTitleFor(panel.title, session.pendingPermissions.size);
      DashboardPanel.sessionPanels.set(sessionId, panel);
      panel.onDidDispose(() => {
        if (DashboardPanel.sessionPanels.get(sessionId) !== panel) return;
        DashboardPanel.sessionPanels.delete(sessionId);
        // S7 — closing this popped view unanswered would hang a FORWARDED ask; if no surface remains, cancel it.
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

      // Attach as a SECONDARY mirror scoped to this one session.
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
   * memory=true, so ChatView renders only WikiSearchPane). Reuses the chat
   * bundle + the shared broadcast host — the pane only needs workspaceData /
   * wikiPath, which the host already fans out and answers on the pane's
   * requestWorkspaceData handshake. Reopening reveals the existing tab.
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
   * Open the Agent Manager board in its own editor tab (a secondary view
   * flagged board=true, so ChatView renders only AgentManagerPane). Same
   * shared-host pattern as the memory graph; the board speaks the `am*`
   * message family, answered by the AgentManager fleet owner.
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
      // Just "Folds" — the board is a heavily-used tab and an editor tab's width
      // is the scarce resource. The "Origami — <view>" branding still reads in
      // the webview's own brand bar (ChatView.svelte), which is not width-bound
      // and follows the ACTIVE view rather than freezing on Folds.
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
      // The webview iframe dies without running the pane's onMount cleanup, so
      // its amVisible:false never arrives - demote the poll cadence host-side
      // or a closed board leaves 5s git polling running for the window's life.
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

  /** Open a race group's Compare screen in its own editor tab (S6d): ensure the shared host, then hand off to compareTab.ts (createWebviewPanel + one-tab-per-group dedupe). */
  public static async openRaceCompareInEditor(context: vscode.ExtensionContext, params: RaceCompareParams): Promise<void> {
    if (!DashboardPanel.current) {
      await DashboardPanel.createOrShow(context);
      for (let i = 0; i < 30 && !DashboardPanel.current; i++) await new Promise<void>((r) => setTimeout(r, 100));
    }
    if (DashboardPanel.current) openRaceCompareTab(context, DashboardPanel.current, params);
  }

  /** Open a repo's architecture-map screen in its own editor tab (S15): read +
   *  validate .origami/map/map.json, ensure the shared host, then hand off to
   *  mapTab.ts (createWebviewPanel + one-tab-per-repo dedupe). */
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

  /** Open a collab's stream screen in its own editor tab (M1): ensure the
   *  shared host, then hand off to collabTab.ts (createWebviewPanel +
   *  one-tab-per-collab dedupe). Same shape as the two tabs above. */
  public static async openCollabInEditor(context: vscode.ExtensionContext, params: CollabTabParams): Promise<void> {
    if (!params.id) return;
    if (!DashboardPanel.current) {
      await DashboardPanel.createOrShow(context);
      for (let i = 0; i < 30 && !DashboardPanel.current; i++) await new Promise<void>((r) => setTimeout(r, 100));
    }
    if (DashboardPanel.current) openCollabTab(context, DashboardPanel.current, params);
  }

  /**
   * Construct a DashboardPanel bound to an arbitrary webview host (used by
   * the sidebar ChatViewProvider, which owns a `vscode.WebviewView`).
   * Runs the `initialize()` bootstrap — real workspace data, model probe,
   * and a real ACP session. The side panel is the single live surface, so
   * the instance is registered as `DashboardPanel.current`; the command
   * methods (switch model, new session, etc.) act on it. `dispose()`
   * clears the singleton only when it is this instance.
   */
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

  /**
   * NOTE 4 — resolve a view into the SHARED host. The config view and the
   * chat view both call this; whichever resolves FIRST becomes the primary
   * (creates the DashboardPanel + bootstraps the ACP session), and the
   * second ATTACHES to it (receives broadcasts + routes inbound messages
   * to the same handler). VS Code can resolve the two providers in either
   * order, so order-independence matters: the chat view runs turns and the
   * config view drives global engine/model/context/theme — both land in
   * the same session machinery regardless of which created the host.
   *
   * Returns the live DashboardPanel (the singleton) so callers can hold a
   * reference if needed.
   */
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

  /**
   * Add a new session tab from outside (Ctrl+Shift+N).
   */
  public static async addSession(context: vscode.ExtensionContext): Promise<void> {
    if (!DashboardPanel.current) {
      await DashboardPanel.createOrShow(context);
      return; // createOrShow already creates the first session
    }
    await DashboardPanel.current.createSession();
  }

  /**
   * Switch model via QuickPick. The selectable set comes from the ACP
   * session's `configOptions` (the providers/models configured in
   * origami.json) — NOT the dead `list_models` ext-method. The change is
   * applied with the real ACP `setSessionConfigOption(configId='model')`,
   * which the server validates against the configured providers.
   */
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
      // Real ACP write. The server throws InvalidModel if the id isn't a
      // configured provider/model — caught below, surfaced honestly (no
      // fake "Switched" over a no-op).
      const current = await session.client.setModel(pick.modelValue);
      self.post({ type: 'system', text: `Model set to ${current}.`, sessionId: sid });
      // Reflect the new selection in the status pill (the configured id is
      // the honest label of what the session will prompt with).
      self.modelInfo = { ...self.modelInfo, ok: true, modelId: current, state: 'loaded' };
      // Provider-aware window + vision for the new selection (broadcasts itself).
      await self.refreshActiveModelInfo();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Origami model switch failed: ${msg}`);
    }
  }

  /**
   * Recall a prior chat. Opens the IN-WEBVIEW history dropdown (a searchable
   * list rendered in the chat header), replacing the old native QuickPick +
   * "no past sessions" toast — which left stale notifications behind and was
   * coupled to which tab happened to be active. The webview then requests the
   * session list (`requestHistory` → `historyList`) and recalls a pick
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
   * Phase 8 of the 2026-04-26 collapse — toggle the active mode between
   * Normal and Game. Dispatches `/ram-game` / `/ram-normal` through the
   * usual slash channel, which goes through Phase 5's transactional
   * `mode_switch` helper (validates the target's default model, loads
   * it, and only then persists). Replaces the old `applyCombo`
   * affordance — combos are gone in the collapse.
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

  /**
   * Run any slash command from outside the dashboard.
   */
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
  }

  private get cwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  /**
   * Resolve the inference engine endpoint passed to the spawned
   * origami-acp as ORIGAMI_API_BASE. Resolution order, highest first:
   *   1. the `origami.engineUrl` VS Code SETTING (if the user set it);
   *   2. the existing `ORIGAMI_API_BASE` env var (honours an owner's
   *      `setx` so the current setup keeps working);
   *   3. the setting's declared default (localhost LM Studio).
   *
   * Returns `undefined` only in the (impossible-in-practice) case that
   * the setting has no default and no env is set — in which case
   * AcpClient.start leaves the child env untouched and the bridge's own
   * built-in default applies. We treat a setting that equals the
   * package.json default but was never explicitly written as still
   * authoritative (VS Code returns the default for unset keys); the env
   * override only wins when the user has NOT customised the setting.
   */
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
   *  provider-aware (vLLM's own /v1/models max_model_len; vision from the model's
   *  origami.json caps). Kept separate from `modelInfo`/`contextWindow` (which
   *  stay the LM Studio probe, load-bearing for lms load/eject + adopt) so the
   *  gauge / 'N ctx' / Vision reflect the active provider, not LM Studio. */
  private activeModelWindow = 0;
  /** The active in-panel theme, shared across every webview (sidebar + popped
   *  editor-tab chats). Per-webview state does NOT carry into a freshly-created
   *  webview, so a new chat panel would boot on the meadow default; the host
   *  holds the shared value (persisted in globalState) and pushes it to each
   *  view on its mount handshake so a new panel inherits the current theme. */
  private _currentTheme: string | null = null;
  /** The shared theme if KNOWN — a user cycle this session (themeChanged) or a
   *  prior choice persisted in globalState. `null` = unknown, in which case we
   *  do NOT push, so a view keeps its own persisted theme (no first-load flip). */
  private get currentTheme(): string | null {
    if (this._currentTheme === null) {
      const saved = this.context.globalState.get<string>('origami.theme');
      // Remap legacy ids the CSS no longer defines so we never push a dead theme.
      if (saved) {
        this._currentTheme =
          saved === 'quiet' ? 'ember' : saved === 'lilac' || saved === 'dark' ? 'meadow' : saved;
      } else {
        // No stored id yet (never cycled since this shipped). Infer from the
        // workbench colour theme the switch already set — persistent in
        // settings, so a new panel inherits the theme without a cycle. Only
        // maps to a real Origami theme; a non-Origami workbench theme → null.
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
  /** True while an lms load/unload/swap is running — guards against overlapping
   *  model operations stacking into a load storm (a click while one is in flight
   *  is dropped, not queued). */
  private modelOpInFlight = false;
  /** Guards the one-time vision-capability reconcile (auto-detect vlm models)
   *  so it runs once per panel lifetime, not on every reprobe. */
  private visionReconciled = false;
  private workspaceWatchers: vscode.Disposable[] = [];
  private wikiWatcher: vscode.Disposable | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private wikiRefreshTimer: NodeJS.Timeout | null = null;
  /** Phase C2 of the plan-mode SOTA pass (2026-05-07) — per-session mode
   *  tracking for the sticky banner in the webview shell (which shows a warning
   *  whenever the FOCUSED session is in anything other than `'default'`). There
   *  is no poll: it follows the live `onModeChanged` stream and the mode writes
   *  the extension itself issues, via `applyPermissionMode`. */
  private readonly permBanner = new PermissionBannerState();
  /** Which SINGLE session an attached view is dedicated to (a popped-out chat
   *  tab), for the views that have one. The banner is per-webview DOM, so
   *  painting it correctly needs to know who each view speaks for — a solo tab
   *  never posts `activeSessionChanged`, so the focused-session answer is wrong
   *  for it. Entries are dropped with the view in `attachView`'s dispose. */
  private readonly viewSolo = new Map<vscode.Webview, string>();
  /** Per-webview teardown for attachView wiring — the doubled-send guard
   *  lives in viewWiring.ts (rewireView). */
  private readonly viewWiring = new Map<vscode.Webview, () => void>();

  private async initialize(): Promise<void> {
    // Collabs M1 — write the seed collab agent defs BEFORE the engine child
    // spawns below, because the engine reads {agent,agents}/**/*.md at startup:
    // installing them later would leave `collab_agents` empty until a window
    // reload. Deliberately NOT alongside ensureArchetypes (manager.ts), which
    // only runs when the Agents board is first opened — a collab must be
    // creatable from the sidebar without ever visiting that board.
    // Write-if-absent + install-once marker; non-fatal (see ensureCollabAgents).
    ensureCollabAgents({
      marker: {
        // v4: the shipped seeds are now UNPINNED — no model pinned to a
        // provider a fresh machine may not have. The marker bump lets fresh
        // templates land on a fresh install (write-if-absent still protects
        // any user-edited file; an existing v3 install keeps its pinned
        // crane/heron until the user deletes them, at which point the pane's
        // legacy-seed note — collabAgentsLegacy.ts's COLLAB_AGENTS_V3 —
        // recognises the old pair and offers exactly that).
        get: () => this.context.globalState.get<boolean>('origami.collab.agents.v4') === true,
        set: () => void this.context.globalState.update('origami.collab.agents.v4', true),
      },
    });
    // Once-ever "auto-approve the browser tool?" prompt (never blocks the rest
    // of initialize on the user's answer — see browserToolsConsent.ts).
    void ensureBrowserToolsConsent(this.context);
    // t-kgsupy round 3 (owner direction): the install-time YOLO-mode write
    // that used to run here is GONE — see browserToolsConsent.ts's SUPERSEDED
    // note. That choice now lives in the composer's explicit "Browser: Ask /
    // Bypass" control (`requestBrowserAutoApprove` / `setBrowserAutoApprove`
    // cases below), reached on the user's own terms, not at activation.
    // S7 V10 — read the persisted active-session id before any session
    // gets created. The id replays into the webview after createSession
    // when (and if) a session with the matching id ever exists.
    this.pendingRestoreSessionId =
      this.context.workspaceState.get<string>(DashboardPanel.ACTIVE_SESSION_KEY) ?? null;
    // Feature 2 — read the persisted OPEN-SET up front (before any write) for reopen after connect.
    const persistedOpen: OpenSetState | null = loadOpenSet(this.context.workspaceState);

    // Send workspace data
    const wsPath = findWorkspacePath();
    if (wsPath) {
      try {
        const data = readWorkspaceData(wsPath);
        // The memory graph sources the OPEN workspace's wiki (this.cwd →
        // <workspace>/wiki/pages), NOT the settings.toml workspace_path used for
        // the board data above — that can be stale (points at a prior workspace)
        // until the engine connects. Drive the bootstrap wikiPages from it so
        // the graph populates with no manual "Source…" pick.
        this.wikiPath = resolveDefaultWikiPages(this.cwd);
        this.wikiPathIsDefault = true;
        data.wikiPages = readWikiPagesFromDir(this.wikiPath, path.dirname(this.wikiPath));
        this.post({ type: 'workspaceData', data });
        this.post({ type: 'wikiPath', path: this.wikiPath });
      } catch (e) {
        console.error('[origami] failed to read workspace data:', e);
      }
      this.setupWatchers(wsPath);
      // Send saved sessions list
      this.post({ type: 'savedSessions', sessions: listSavedSessions() });
    }

    // Probe the inference engine — only report a model once we've
    // actually seen one loaded. Probe the SAME endpoint origami-acp is
    // spawned against (resolveEngineUrl: setting → env → default), so the
    // status pill matches the real connection. Fall back to
    // settings.toml's api_base only when no engine URL resolves.
    const apiBase = this.resolveEngineUrl() ?? readSettings().apiBase;
    if (apiBase) {
      this.modelInfo = await fetchModelInfo(apiBase, undefined, primaryLocalApiKey());
      this.contextWindow = this.modelInfo.contextLength;
      // Sync vlm image-input caps into origami.json BEFORE the engine spawns, so
      // it reads correct capabilities at startup. The engine reads model caps
      // only at spawn, so doing this first means a later text→vision switch
      // forwards images live — no window reload.
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
    }) && boot) this.closeSession(boot.id); this.restoring = false; this.saveOpen();
    // Re-arm persisted /loop schedules now that the restored chats' sessions
    // are live (rearmPersistedLoops needs `this.sessions` in its final,
    // post-restore state — see loopPersistence.ts).
    this.rearmPersistedLoops();

    // Adopt whatever LM Studio actually has loaded as the active model, so the
    // engine doesn't request a stale config.model on the first turn and JIT-boot
    // it. ACP-only (no lms load); no-op when nothing is loaded (user picks).
    await this.adoptLoadedModel();
    // Seed provider liveness at BOOT. providerStatusCache is what a remote
    // session's ok/banner reads (sessionModelStatus); its only other writers are
    // sidebar/picker interactions, so without this a Spark-default workspace
    // boots to "unreachable — check the server" against a live server and stays
    // wrong until the user happens to open the picker. broadcastProviderStatus
    // repaints per-session statuses itself when the probes land.
    void this.broadcastProviderStatus();
    // Resolve the ACTIVE model's real window + vision (provider-aware), so a
    // vLLM/remote default shows its own context/gauge, not LM Studio's.
    await this.refreshActiveModelInfo();

    // Phase C2 of the plan-mode SOTA pass (2026-05-07) — paint the sticky-mode
    // banner once the first session is up, from the engine's own `mode`
    // config-option. From here on the banner follows mode events + writes.
    this.paintPermissionBanner();
  }

  private async createSession(
    requestedAgent?: string,
    restoredFromMessages?: SessionMessage[],
    loadSessionId?: string,
    opts?: { cwd?: string; kind?: 'chat' | 'agent'; engineAgent?: string; botGlyph?: string },
  ): Promise<string> {
    sessionCounter++;
    const settings = readSettings();
    // V1 is single-agent. The displayed agent name on a fresh session is
    // an explicit `requestedAgent`, else resolved from `settings.activeAgent`
    // in `~/.origami/settings.toml`, else the brand default "Tsuru" (the
    // crane — Origami's agent identity). This is a DISPLAY label: it is never
    // round-tripped to the engine, so the tabs / status bar / "Connected" line
    // all read Tsuru without a wire dependency. (Real agent selection is the
    // ACP `mode` config-option, driven per-session by the Folds board.)
    //
    // `displayAgentName` maps any internal value (including the `coder`
    // archetype body the settings.toml may still carry) THROUGH the fixed
    // roster to its user-visible label, so NOTHING the user sees reads
    // "coder" even if the bridge / settings internals do.
    const agentName = requestedAgent
      ? displayAgentName(requestedAgent)
      : displayAgentName(settings.activeAgent);
    const sessionNum = sessionCounter;

    const sessionId = `session-${sessionNum}`;
    // V23 close (cozy-lantern): pre-seed the messageLog with the
    // restored archive transcript so the next saveSession round-trip
    // doesn't drop the history. ACP itself starts fresh — there's no
    // LLM-context replay path yet — but the UI side restores the
    // visible scrollback so the user can continue the conversation.
    const session: Session = {
      id: sessionId,
      number: sessionNum,
      agentName,
      cwd: opts?.cwd ?? this.cwd,
      kind: opts?.kind, botGlyph: opts?.botGlyph,
      client: null as any, // set below
      pendingPermissions: new Map(),
      estimatedTokens: 0,
      messageLog: restoredFromMessages ? [...restoredFromMessages] : [],
      loadedFromEngineId: loadSessionId,
    };

    const handlers: AcpEventHandlers = {
      onAgentMessageChunk: (text, messageId) => {
        // `messageId` = the engine's assistant-message id; the webview stamps it
        // on the agent bubble so a "rewind to here" control has a revert anchor.
        this.post({ type: 'agentText', text, messageId, sessionId });
        // Append to or extend last agent message in log
        const last = session.messageLog[session.messageLog.length - 1];
        if (last && last.kind === 'agent') {
          last.text += text;
        } else {
          session.messageLog.push({ kind: 'agent', text, timestamp: Date.now() });
        }
      },
      onAgentImageChunk: (data, mimeType) =>
        this.post({ type: 'agentImage', data, mimeType, sessionId }),
      // Streamed reasoning/thinking (`agent_thought_chunk`). The engine already
      // forwards it over ACP; without this wire it was silently dropped. Post it
      // to the webview, which renders a collapsed "thought process" block.
      onAgentThoughtChunk: (text) => {
        this.post({ type: 'agentThought', text, sessionId });
        // Folds board: a background agent's reasoning is the only signal it emits
        // between tool calls — its TAIL (the newest words) is the live activity line.
        this.agentManagerInstance?.foldActivity(sessionId, activityLine(text, 'tail'));
      },
      // Streamed /compact summary, tagged `_meta.origami_compaction` by the
      // engine. Rendered as a collapsed "Compaction Completed" marker with the
      // carried-forward summary behind a dropdown — NOT dumped into the chat.
      onCompactionChunk: (text) =>
        this.post({ type: 'compactionChunk', text, sessionId }),
      // A sub-agent's live output, keyed by the child session so the webview can
      // stream it under the task card that spawned it. NOT appended to
      // `messageLog`: it's transient progress, and a 10-agent fan-out would
      // otherwise bloat every recalled transcript with the children's raw work.
      onSubagentChunk: ({ childSessionId, text }) =>
        this.post({ type: 'subagentChunk', childSessionId, text, sessionId }),
      // A BACKGROUND sub-agent finished. The launcher card went `completed` back
      // when the child was SPAWNED, so this marker is the only thing that can
      // retire it from the drawer's roster. It IS logged — the child's own
      // result turn carries its output but not this fact, and a card restored
      // without it is a dead sub-agent shown as running for the rest of time.
      onSubagentDone: ({ taskSessionId, state, endedAt }) => {
        const session = this.sessions.get(sessionId);
        if (session) logSubagentDone(session.messageLog, taskSessionId, state, endedAt);
        this.post({ type: 'subagentDone', taskSessionId, state, endedAt, sessionId });
      },
      // Replayed USER turns from a loadSession history recall — echo them
      // into the transcript so a recalled conversation shows both sides.
      // (Live sends are echoed by the 'send' handler; this fires only on
      // history replay, which the donor dropped entirely.)
      // `replay: true` tells the sidebar ring this is history catching up,
      // not a turn starting — without it every restored chat's ring spun
      // amber forever, because no turnDone ever follows a replayed turn.
      onUserMessageChunk: (text) => {
        this.post({ type: 'echoUser', text, sessionId, replay: true });
        // ALSO log it: a recalled chat opens its editor tab AFTER start()
        // (auto-open), so the live echoUser above is lost — the tab is
        // restored from `messageLog` via restoreMessages. Without logging
        // the user side here, recall showed only the agent's half. Append
        // to the last user entry to keep multi-chunk turns intact.
        const last = session.messageLog[session.messageLog.length - 1];
        if (last && last.kind === 'user') {
          last.text += text;
        } else {
          session.messageLog.push({ kind: 'user', text, timestamp: Date.now() });
        }
      },
      // A handoff from ANOTHER agent session — why it is its own message type
      // and why the archive keeps it as `system` is in peerMessages.ts.
      onPeerMessage: (peer) => {
        this.post({ type: 'peerMessage', ...peer, sessionId });
        session.messageLog.push(peerLogEntry(peer));
      },
      onAvailableCommands: (commands) =>
        this.post({ type: 'availableCommands', commands, sessionId }),
      // Authoritative token/context usage from the engine. Forward to the
      // session's strips so ControlStrip + composer render a live meter.
      onUsageUpdate: (args) => {
        // Accrue this turn's real token breakdown into the session's running
        // totals for the cross-session Context tracker (prefill / read / write).
        // Cumulative across turns = total tokens spent (input is re-read every
        // turn, exactly as billed) — the honest "spend" figure, not a turn count.
        const s = this.sessions.get(sessionId);
        if (s) {
          const acc = s.tokenUsage ?? (s.tokenUsage = { prefill: 0, read: 0, write: 0, cacheWrite: 0 });
          acc.prefill += args.promptTokens ?? 0;
          acc.read += args.cacheReadTokens ?? 0;
          acc.write += args.outputTokens ?? 0;
          acc.cacheWrite += args.cacheWriteTokens ?? 0;
        }
        this.post({
          type: 'usageUpdate', used: args.used, size: args.size, cost: args.cost, sessionId,
          ...(args.subagents ? { subagents: args.subagents } : {}),
          prefill: s?.tokenUsage?.prefill ?? 0,
          read: s?.tokenUsage?.read ?? 0,
          write: s?.tokenUsage?.write ?? 0,
          cacheWrite: s?.tokenUsage?.cacheWrite ?? 0,
        });
        // Accrue this session's cost into the month ledger (local AND an OAuth-
        // connected provider are both 0/no-op — oauth-cost) and broadcast it.
        if (args.cost && typeof args.cost.amount === 'number') {
          const pid = ((s?.client as { getModelOption?: () => { current?: string } } | undefined)?.getModelOption?.()?.current ?? '').split('/')[0];
          const sp = accrueSessionSpendUnlessOAuth(sessionId, args.cost.amount, pid, this.oauthProviderIds);
          this.post({ type: 'spendUpdate', month: sp.month, total: sp.total });
        }
      },
      // Last-turn tokens/sec (real output tokens / turn wall-clock), computed at
      // the source in acpClient from the prompt-response usage.
      onTurnStats: (args) =>
        this.post({ type: 'turnStats', tokensPerSec: args.tokensPerSec, sessionId }),
      // The engine pushes the generated title (G2). Adopt it once it's a real
      // (non-placeholder) name — this is authoritative, so it supersedes the
      // provisional slug and ends the listSessions re-query polling.
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
        this.post({ type: 'toolCall', ...args, sessionId });
        // Log the WHOLE payload, not just a title (sessionLog.ts): a recalled
        // chat's tab opens AFTER start(), so the post above is lost and the tab
        // is rebuilt from messageLog — a title-only entry can only come back as
        // a plain text row, which is the reload defect.
        const title = logToolCall(session.messageLog, args as unknown as Record<string, unknown>);
        this.agentManagerInstance?.foldActivity(sessionId, title); // Folds board: this fold's live "doing now"
      },
      onToolCallUpdate: (args) => {
        this.post({ type: 'toolResult', toolCallId: args.toolCallId, status: args.status, content: args.contentText ?? '', diff: args.diff, title: args.title, path: args.path, toolName: args.toolName, taskSessionId: args.taskSessionId, taskBackground: args.taskBackground, taskModel: args.taskModel, rawInput: args.rawInput, rawOutputMeta: args.rawOutputMeta, images: args.images, sessionId });
        logToolResult(session.messageLog, args as unknown as Record<string, unknown>); // merge onto the logged card, for the restore
        if (args.title) this.agentManagerInstance?.foldActivity(sessionId, args.title); // a long tool refines its title mid-run
        // Remember the plan file the agent just wrote so the plan_exit
        // approval modal can open it in preview (see onPermissionRequest).
        if (args.path && /[\\/]plans[\\/][^\\/]+\.md$/i.test(args.path)) {
          session.lastPlanPath = args.path;
        }
        // Remember the dream candidate the agent wrote so the native `dream`
        // tool's review question can open a live-vs-candidate diff (see
        // onPermissionRequest). Sibling of the plan-path hook above.
        if (args.path && /[\\/]memory\.candidate\.md$/i.test(args.path)) {
          session.lastDreamCandidatePath = args.path;
        }
      },
      onPermissionRequest: ({ toolCallId, title, kind, options, questions, respond, rawInput, locations }) => {
        session.pendingPermissions.set(toolCallId, respond);
        // t-q6jxrs — ask ADDED: tint the popped-out tab waiting, ahead of
        // every branch below (including one that resolves the SAME tick).
        DashboardPanel.syncTabIcon(this.context, sessionId, session.pendingPermissions.size);
        // Surface the ground-truth target (path / dir / url / command) so the
        // user approves with context instead of a bare title. Prefer an ACP
        // file location; else pull a path-ish key off the tool's rawInput. We do
        // NOT surface any agent-authored "reason" — a local model rationalises,
        // and a plausible-but-wrong justification would launder a bad approval.
        const target: string | undefined = permissionTarget(locations, rawInput);
        // S5.2/S6e — a BACKGROUND agent session with no webview: auto-approve ON ALLOWS
        // in-repo asks, DENIES out-of-repo ones (the build-in-Temp fix), each noted;
        // chat / toggle-OFF / no option -> forward. S7 — but a MOUNTED agent view
        // (reopened Done chat / solo tab) means the user is present: FORWARD to its
        // permission UI instead of auto-answering (closes the S5.2 reopened-chat minor).
        const mounted = isSessionMounted(sessionId, this.activeSessionId, DashboardPanel.sessionPanels, this.sidebarGridMode);
        // S7.1 — a background agent's QUESTION (requestPermission with NO allow_always; acp/question.ts) must never be auto-answered: with no view mounted, buffer for replay, never the S6e auto-decision.
        if (shouldBufferQuestion(session.kind, mounted, options)) { this.bufferAgentQuestion(session, sessionId, toolCallId, title, kind, target, options); return; }
        // Feature 1 — a persisted allow_always (recalled across engine restarts) pre-approves a matching CHAT ask with allow_once BEFORE the UI sees it; never a question, never a deny. Falls through to the agent repo-scoped path.
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
          // The whole batch, when the engine sent one. The modal renders it as
          // "Question 1 of N"; omitted, the webview falls back to title+options.
          ...(questions ? { questions: questions.map((q) => ({ title: q.title, options: q.options.map((o) => ({ ...o })) })) } : {}),
        });
        notePersistablePermission(session.kind, toolCallId, title, target, options); // Feature 1 — remember this ask so an allow_always reply persists (agent/target-less self-skip)
        // plan_exit / dream-review previews ride the forwarded ask (permissionPreview.ts,
        // extracted verbatim to hold this file at its line cap).
        openPermissionPreview(session, title);
        // Emit audit entry for the activity feed
        this.post({
          type: 'permissionAudit',
          toolCallId, title, kind,
          action: 'requested',
          timestamp: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        });
      },
      // Slice A v3b — server pushed an assessment update for an
      // open permission modal. Forward to whichever session owns
      // this toolCallId so its webview can refresh the title in
      // place. Stale ids (user already approved/denied) drop.
      onAssessmentUpdate: ({ toolCallId, text }) => {
        if (session.pendingPermissions.has(toolCallId)) {
          this.post({ type: 'assessmentUpdate', toolCallId, text, sessionId });
        }
      },
      // Engine-driven mode switch (plan_exit -> build). The ACP session's mode
      // already changed server-side, so just reflect it: re-point the panel's
      // mode indicator + selector + status bar at the engine's real value (no
      // setConfigOption — that's the outbound user-initiated path).
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
      // First-class `origami/turnEnd` — forward the real `stop_reason`
      // so ChatPane can anchor an honest per-turn TERMINAL verdict at
      // the end of the turn (verified-done / incomplete:<reason> /
      // parked). The stop_reason was previously discarded in acpClient.
      onTurnEnd: (args) =>
        this.post({ type: 'turnVerdict', stopReason: args.stopReason, sessionId }),
      onPlanReady: (args) => {
        this.post({ type: 'planReady', ...args, sessionId });
        // Auto-open the plan file in a side editor for markdown preview.
        if (args.filePath) {
          const uri = vscode.Uri.file(args.filePath);
          vscode.commands.executeCommand('markdown.showPreview', uri).then(
            () => {},
            () => vscode.window.showTextDocument(uri, { preview: true }),
          );
        }
      },
      // Phase 6.6 — best-of-N critic verdict. Alternatives panel in
      // PlanPanel.svelte renders the scored tabs.
      onBestOfNComplete: (args) =>
        this.post({ type: 'bestOfNComplete', ...args, sessionId }),
      // Phase 6.5 — task decomposition landed. ChatPane renders the
      // `TaskShapeCard` component beside TodoStrip when this arrives.
      // (Webview consumer landed in the 2026-05-22 Pillar 1 upgrade,
      // closing the prior drop-on-floor wire.)
      onTaskShape: (args) =>
        this.post({ type: 'taskShape', ...args, sessionId }),
      // Live TodoWrite snapshot mirroring the harness-owned tracker.
      // ChatPane renders `<TodoStrip>` at the top of the chat; this
      // forwarder hands off the typed payload unchanged.
      onTodoUpdate: (args) =>
        this.post({ type: 'todoUpdate', ...args, sessionId }),
      // First-class `origami/arbiterDecision` — the SINGLE per-turn
      // arbiter verdict (Done | Continue | AskUser). M1 followable
      // surface: ChatPane renders exactly one decision chip per turn.
      onArbiterDecision: (args) =>
        this.post({ type: 'arbiterDecision', ...args, sessionId }),
      // Cron + ambient observability. The bridge pushes every
      // workspace `BusMessage` here (cron job ticks, model load/unload,
      // etc.) via the first-class `origami/feedMessage` notification.
      // Route to:
      //   1. The "Origami Activity" VS Code output channel so the
      //      user sees an immediate scrolling feed without needing
      //      a Svelte panel.
      //   2. The webview as `feedMessage` so a plain (unbranded)
      //      sidebar widget can render structured cards.
      onFeedMessage: ({ busKind, payload }) => {
        DashboardPanel.appendActivityLine(busKind, payload);
        this.post({ type: 'feedMessage', busKind, payload, sessionId });
      },
      // The MCP sign-in URL, forwarded to the pane as its own message. NOT
      // opened here: the engine already opened a browser, and the pane offers
      // this as the "it did not open" link the user clicks themselves.
      onMcpAuthUrl: ({ name, url }) => this.post({ type: 'mcpAuthUrl', name, url }),
      // S7.1 — engine death: drop a buffered question, drain its orphaned respond (never hang the engine), clear the board chip.
      onClose: (reason) => { this.post({ type: 'closed', reason, sessionId }); if (this.pendingQuestionPermissions.has(sessionId)) { this.pendingQuestionPermissions.delete(sessionId); drainPermissions(session.pendingPermissions); DashboardPanel.syncTabIcon(this.context, sessionId, 0); this.agentManagerInstance?.setAgentQuestion(sessionId, null); } },
      onError: (message) => { this.post({ type: 'error', message, sessionId }); if (this.pendingQuestionPermissions.has(sessionId)) { this.pendingQuestionPermissions.delete(sessionId); drainPermissions(session.pendingPermissions); DashboardPanel.syncTabIcon(this.context, sessionId, 0); this.agentManagerInstance?.setAgentQuestion(sessionId, null); } },
    };

    session.client = new AcpClient(handlers);
    this.sessions.set(sessionId, session);
    // An Agent Manager session runs in the background: it never steals the
    // active-session focus from whatever chat the user is in.
    if (session.kind !== 'agent') this.activeSessionId = sessionId;

    // S8 V16 — load the agent's banner ASCII art so ChatPane can
    // render it above the first message of a fresh session. Missing
    // file → null → ChatPane skips the banner.
    const wsPathForArt = findWorkspacePath();
    const agentArt = wsPathForArt ? readAgentArt(wsPathForArt, agentName) : null;

    // Tell webview a new session was created. modelName is omitted here —
    // the webview learns it from the separate `modelStatus` probe so the
    // UI never shows a name until LM Studio has confirmed one is loaded.
    // The three posts that MAKE the surface are ONE closure, because a chat
    // created as a bot has to hold all three until the engine has accepted the
    // agent — see sessionAnnounce.ts for the flash this stops (W8-L1 UAT).
    const announce = () => {
      this.post({
        type: 'sessionCreated',
        sessionId,
        sessionNumber: sessionNum,
        agentName,
        agentArt,
        needsSetup: needsFirstFold(wsPathForArt ?? this.cwd), botGlyph: session.botGlyph,
      });
      // Seed the new chat's OWN tagged model status (per-session statuses are
      // the only ones a non-active pane honours) and its context gauge, so the
      // Health table seeds the row at create time.
      this.broadcastModelStatus();
      this.post({
        type: 'contextUpdate',
        sessionId,
        tokensUsed: 0,
        // THIS session's own (tag-valid) window — never the global LM Studio
        // one, which stamped "64k ctx" onto a fresh Spark chat at boot.
        contextWindow: this.sessionValidWindow(session),
        lastActivityAt: null,
        messageCount: 0,
      });
    };

    // V23 close (cozy-lantern): if we're rehydrating from an archive,
    // push the saved messageLog to the webview so ChatPane can render
    // the prior scrollback. ChatPane consumes this via a new
    // `restoreMessages` handler that fans out into addMessage().
    // Also auto-flag this session as the active one so the user lands
    // straight in their restored chat.
    if (restoredFromMessages && restoredFromMessages.length > 0) {
      this.post({
        type: 'restoreMessages',
        sessionId,
        messages: restoredFromMessages,
      });
      this.post({ type: 'restoreActiveSession', sessionId });
    }

    // S7 V10 — if the persisted active-session id matches this freshly
    // created session, replay restore so the webview activates it
    // instead of the most-recent. Useful after `addSession` rebuilds a
    // chat the user had focused before reload (post V23 archive UI
    // landing). One-shot — clear once consumed.
    if (this.pendingRestoreSessionId === sessionId) {
      this.post({ type: 'restoreActiveSession', sessionId });
      this.pendingRestoreSessionId = null;
    }

    // Connect ACP. Pass the resolved engine endpoint so the spawned
    // origami-acp gets ORIGAMI_API_BASE = the setting (else the existing
    // env, else the default). Read at spawn — a later change requires a
    // respawn (see `setEngineUrl`).
    await startThenAnnounce({
      // A chat created AS a bot is PROVISIONAL: the engine may legitimately
      // refuse the definition, and that refusal belongs in the Bots pane, not
      // in a chat panel that opens and vanishes (W8-L1 UAT).
      provisional: !!opts?.engineAgent,
      announce,
      start: async () => {
        try {
          // `loadSessionId` (history recall) makes start() call loadSession
          // instead of newSession — the server replays the transcript back as
          // sessionUpdate events into the handlers above.
          const acpSessionId = await session.client.start(session.cwd, this.resolveEngineUrl(), loadSessionId, session.kind === 'agent', opts?.engineAgent); postPeerName(session.client.peerName, sessionId, m => this.post(m)); // "which chat is this" for send_message/list_agents
          // The engine seeds a NEW session from config.model. When that's stale (LM
          // Studio holds a different model) this chat would request a model the GPU
          // doesn't have and JIT-boot it on the first turn. Align it now — ACP only,
          // never an lms load, and self-guarded against stomping a remote provider.
          await this.adoptLoadedModel(session);
          // Now the engine has reported the session's REAL model (configOptions are
          // empty until start() resolves), re-stamp its per-session status — the
          // pre-start seed judged it by the configured default, which is close but
          // can't see an engine-side override.
          this.broadcastModelStatus();
          this.post({
            type: 'system',
            text: loadSessionId
              ? `Recalled session ${acpSessionId}. Continue the conversation below.`
              : `Connected. Session ${acpSessionId}. Type a message and press Enter.`,
            sessionId,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.post({ type: 'error', message: `Could not start origami-acp: ${msg}`, sessionId });
          // An AGENT session with no engine is useless and invisible (its chat is
          // headless): unregister it and reject so the Agent Manager's create
          // fails with the REAL spawn error instead of a later prompt() throw
          // against a session that never started.
          if (session.kind === 'agent' || opts?.engineAgent) {
            session.client.dispose();
            this.sessions.delete(sessionId);
            // The active id may be THIS session — it was set at registration, before
            // the engine was up. This path is NOT closeSession, so nothing else moves
            // it off a session that no longer exists; leaving it there is the corpse
            // every activeSessionId reader then resolves (W8-L1: the Skills pane said
            // "Open a chat first" with two chats open). See activeSession.ts.
            this.activeSessionId = liveActiveSessionId(this.sessions, this.activeSessionId);
            this.post({ type: 'sessionClosed', sessionId });
            throw new Error(`engine failed to start: ${msg}`);
          }
        }
      },
    });

    // Surface model: each chat lives in its OWN movable editor tab. Auto-open
    // (or reveal) this session's tab so creating/recalling a chat pops it
    // straight out; the sidebar stays the launcher + settings. Not awaited —
    // openSessionInEditor self-guards (dedupe + bounded `.current` poll) and
    // must not block session bootstrap. Agent Manager sessions stay headless:
    // the board is their surface, a tab opens only on an explicit "open chat".
    if (session.kind !== 'agent') { void DashboardPanel.openSessionInEditor(this.context, sessionId); this.saveOpen(); } // Feature 2 — persist a chat once its engine id lands (suppressed while restoring; the boot/reopened chats are flushed by initialize).
    return sessionId;
  }

  /** S7.1 — buffer an unanswered agent question (respond already in pendingPermissions), flag the board row + toast once; replaySessionsTo re-posts it on mount. */
  private bufferAgentQuestion(session: Session, sessionId: string, toolCallId: string, title: string, kind: string, target: string | undefined, options: ReadonlyArray<{ optionId: string; name: string; kind: string }>): void {
    this.pendingQuestionPermissions.set(sessionId, { toolCallId, title, kind, target, options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })) });
    const preview = questionPreview(title);
    this.agentManagerInstance?.setAgentQuestion(sessionId, preview);
    void vscode.window.showWarningMessage(`Agent ${session.agentName} needs you: ${preview}`, 'Open chat')
      .then((pick) => { if (pick) void DashboardPanel.openSessionInEditor(this.context, sessionId); });
  }

  private closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.permBanner.forget(sessionId); // a closed session's mode must not leak onto the banner
    this.pendingQuestionPermissions.delete(sessionId); // S7.1 — drop any buffered question-permission with the session
    // Clear any active /loop scheduler timer so it can't fire into a dead
    // session. A PERSISTENT loop is the exception: closing its chat must not
    // end it, so its timer is dropped here (this session is going away) and the
    // loop is re-armed on a fresh headless session against the SAME engine
    // session — the persisted record is deliberately left intact so the recall
    // has something to recall, and so a failed recall degrades to "needs
    // attention" rather than silently losing the schedule.
    // stopLoopSchedule remains the ONE path that STOPS a loop; this branch does
    // not stop one, it moves it.
    // The engine id must be read BEFORE dispose() below takes the client with it.
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
    // If this chat was popped out into its own editor tab, close that tab
    // too — a solo tab for a dead session would just render "No session".
    const popped = DashboardPanel.sessionPanels.get(sessionId);
    if (popped) popped.dispose();
    saveSession(session);
    session.client.dispose();
    this.sessions.delete(sessionId);
    this.post({ type: 'sessionClosed', sessionId });
    // t-kgserq — drop the closed chat's section membership too, or the
    // persisted map grows a dead id every close. pruneChatSections returns
    // the SAME object when nothing changed, so the reference check below is
    // deliberate — it must run against ONE load, not a second fresh read.
    const loadedSections = loadChatSections(this.context.workspaceState);
    const prunedSections = pruneChatSections(loadedSections, new Set(this.sessions.keys()));
    if (prunedSections !== loadedSections) {
      saveChatSections(this.context.workspaceState, prunedSections);
      this.post({ type: 'chatSections', state: prunedSections });
    }

    // Switch to another session if the active one was closed — the same rule the
    // failed-start tear-down applies (activeSession.ts owns it now).
    this.activeSessionId = liveActiveSessionId(this.sessions, this.activeSessionId);
    // ...and repaint, or the closed chat's banner outlives it. `forget` above
    // only clears the TRACKED mode; the banner div itself keeps whatever it was
    // last told, so closing a plan chat left every surviving view still wearing
    // the plan warning — "Im somehow stuck in plan mode as i closed the plan
    // mode chat panel" (0.3.24 UAT).
    this.paintPermissionBanner();
    this.saveOpen();
    // Now that the old session is fully gone, bring the persistent loop back on
    // a headless one. Deliberately AFTER dispose: two live clients on the same
    // engine session would race each other's prompts.
    if (persistentLoop) {
      void this.recallLoopHeadless(persistentLoop).then(() => {
        this.post({ type: 'loopSchedulesData', ...this.loopSchedulesPayload() });
      });
    }
  }

  // Feature 2 — persist the open-set (chat engine ids in tab order + active + grid) on any change; logic in sessionRestore.ts.
  private saveOpen(): void { if (this.restoring) return; saveOpenSet(this.context.workspaceState, this.sessions, this.activeSessionId, this.sidebarGridMode); }

  /**
   * Reconnect to a (possibly changed) inference engine. The env that
   * carries ORIGAMI_API_BASE is read by origami-acp ONCE at spawn, so a
   * genuine endpoint change requires respawning the binary — there is no
   * live-mutation path. We therefore:
   *   1. tear down the active session's AcpClient (kills the old child),
   *   2. create a fresh session (createSession resolves the engine URL
   *      again — now the just-saved setting — and spawns a NEW child
   *      with ORIGAMI_API_BASE = that URL), and
   *   3. re-probe the engine so the status pill reflects the REAL new
   *      connection (Online only if the new endpoint actually answers).
   *
   * `newUrl` is informational — it's surfaced in the chat so the user
   * sees what we reconnected to; the authoritative value comes from the
   * setting via resolveEngineUrl() inside createSession.
   */
  private async reconnectActiveSession(newUrl: string): Promise<void> {
    const sid = this.activeSessionId;
    this.post({ type: 'system', text: `Reconnecting to ${newUrl}…`, sessionId: sid ?? '' });

    // Tear down the current session (dispose kills the child process so
    // the old ORIGAMI_API_BASE binary is gone before we respawn).
    if (sid) {
      this.closeSession(sid);
    }

    // Spawn a fresh session — createSession reads resolveEngineUrl() and
    // passes it as ORIGAMI_API_BASE to the new origami-acp child.
    await this.createSession();

    // Honest status: re-probe the new endpoint. broadcastModelStatus
    // (inside reprobeModel) reports ok ONLY if the engine answered with a
    // loaded model — a dead endpoint leaves the pill Offline with the
    // real reason, never faked green.
    this.modelInfo = { ok: false, modelId: '', contextLength: 0, state: 'unknown' };
    this.broadcastModelStatus();
    await this.reprobeModel().catch(() => { /* leaves modelInfo Offline */ });
  }

  /**
   * G3 — rewrite the "Origami Custom" contributed theme JSON from the user's
   * `--og-*` palette and apply it to the whole VS Code workbench. The custom
   * theme is webview-only by nature, so unlike the fixed palettes we generate
   * its workbench JSON on demand. Written into the INSTALLED extension dir, so
   * a version bump resets it to the shipped default — it regenerates from the
   * ThemeEditor's saved palette on the next Save. Never touches
   * workbench.colorCustomizations (banned); the only mechanism is a contributed
   * theme file the user can opt into.
   */
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
      // Syntax colours stay on the stable Origami palette — the editor edits
      // UI chrome, not token colours.
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

    // VS Code caches a theme by name, so editing the file in place doesn't
    // re-apply. Toggle off-and-back when it's already active; otherwise just
    // select it. (No colorCustomizations — banned.)
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

  /**
   * V2 close (cozy-lantern): "last activity" + "message count" derived
   * from the persisted messageLog. Both columns the bright-muffin plan
   * called for. Returns `{ lastActivityAt: null, messageCount: 0 }`
   * when the session has no messages yet so the contextUpdate payload
   * shape is stable on every site.
   */
  private sessionActivityFields(session: Session): { lastActivityAt: number | null; messageCount: number } {
    const log = session.messageLog;
    if (log.length === 0) return { lastActivityAt: null, messageCount: 0 };
    return { lastActivityAt: log[log.length - 1].timestamp, messageCount: log.length };
  }

  /**
   * Post this session's local turn count + resolved context window after a turn.
   *
   * The REAL token occupancy comes from the engine's `usage_update` frames
   * (`onUsageUpdate` → the `usageUpdate` broadcast), which `contextStats.fold`
   * merges on top of this payload. This poll is the other half of that merge:
   * the turn counter + the probed window, and the ONLY gauge source between
   * session start and the first `usage_update` of the first turn.
   *
   * It used to lead with a `get_controller_state` ext-method call. The engine
   * implements no ext-methods, so that call could only ever throw into the
   * catch-all fallback below — a guaranteed-failing round-trip per turn whose
   * "success" branch was unreachable. Removed; this is that fallback, which is
   * what actually ran all along.
   */
  private async pollControllerState(session: Session, sessionId: string): Promise<void> {
    // Gauge denominator = THIS session's own resolved window (a remote vLLM's real
    // max_model_len, or LM Studio's loaded window) — never the global/active one,
    // so a Spark turn polled while an LM Studio chat is focused shows Spark's window,
    // not the local model's. Tag-valid only (see sessionValidWindow) — a switched
    // chat's stale window reads as unknown (0) until a focus/model-set re-probe.
    this.post({
      type: 'contextUpdate',
      sessionId,
      turns: session.estimatedTokens,
      contextWindow: this.sessionValidWindow(session),
      ...this.sessionActivityFields(session),
    });
  }

  private getActiveSession(): Session | undefined {
    if (!this.activeSessionId) return undefined;
    return this.sessions.get(this.activeSessionId);
  }

  /** Every engine to tell that provider config changed — EVERY live chat, not
   *  just the active one: each holds its own AcpClient and its own caches, and
   *  an Agent-Manager chat runs in its own worktree cwd. Empty before the first
   *  chat opens, and that is not a failure: the write is on disk and the next
   *  engine start reads it. */
  private engineRefreshTargets(): RefreshTarget[] {
    return [...this.sessions.values()]
      .filter((session) => !!session.client)
      .map((session) => ({ client: session.client, ...(session.cwd ? { cwd: session.cwd } : {}) }));
  }

  /** writeModelConfig + "tell the running engines". EVERY provider-auth write
   *  goes through this, so the connect form, the Re-key form and the OAuth
   *  completion all take effect without a window reload (providerRefresh.ts). */
  private readonly writeProviderConfig = refreshingWriter(writeModelConfig, () => this.engineRefreshTargets());

  /** Crons view backing service, built per request so it always reads the
   *  CURRENT workspace and binary (both can change under a long-lived panel).
   *  defaultBackend picks the real schtasks backend on Windows and an honest
   *  refusal everywhere else. */
  private cronService(): CronService {
    return new CronService({
      repoRoot: findWorkspacePath() ?? this.cwd,
      backend: defaultBackend(),
      resolveBinary: resolveOrigamiBinary,
    });
  }

  // ─── Session task naming (Slice 8) ──────────────────────────────────
  /** A short 1-4 word task slug from the user's first message — the immediate
   *  provisional tab name until the engine's generated title lands. */
  private static slugTitle(text: string): string {
    const words = text.trim().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (words.length === 0) return '';
    return words.slice(0, 4).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').slice(0, 40);
  }

  /** True for the engine's placeholder titles ("New session - <ISO>" /
   *  "Child session - <ISO>") — mirrors the engine's isDefaultTitle. */
  private static isDefaultEngineTitle(title: string): boolean {
    return /^(New|Child) session - /.test(title.trim());
  }

  /** Broadcast the session's title to the webview (sidebar list shows it). The
   *  editor TAB stays "Tsuru #N" — we don't fold the title into panel.title, to
   *  keep the tab strip compact. */
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

  /** After a turn, adopt the engine's generated title once it lands (best-
   *  effort, shell-only listSessions re-query, capped at a few tries since the
   *  engine titles asynchronously and some local models never title at all). */
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
      /* best-effort — naming is non-critical */
    }
  }

  /** Commands that switch the permission mode. 'deep-plan' is an engine agent
   *  like 'plan', so `/deep-plan` rides the same setSessionMode path rather than
   *  being sent to the model as a prompt — which is what an unlisted slash command
   *  would silently become. */
  private static readonly MODE_COMMANDS = new Set(['plan', 'deep-plan', 'default', 'auto', 'bypass']);

  /** Commands that change reasoning mode. */
  private static readonly REASONING_COMMANDS = new Set(['think', 'quick', 'normal']);

  private async handleSlashCommand(command: string, args: string): Promise<void> {
    const sid = this.activeSessionId;
    if (!sid) {
      this.post({ type: 'system', text: 'No active session.', sessionId: '' });
      return;
    }
    const session = this.sessions.get(sid);
    if (!session) return;

    // Shell-only intercept: /firstfold scaffolds the workspace and (batch b)
    // writes the model config — it never reaches the engine. Echo the command
    // so the transcript reads naturally, then run the wizard.
    if (command === 'firstfold') {
      this.post({ type: 'echoUser', text: `/firstfold${args ? ' ' + args : ''}`, sessionId: sid });
      await this.runFirstFold(sid, args);
      return;
    }

    // Shell-only intercept: /spend prints the running cost — this chat + the
    // month-to-date total across all chats. Never reaches the engine.
    if (command === 'spend') {
      this.post({ type: 'echoUser', text: '/spend', sessionId: sid });
      // No terminal event followed this shell-only path before — the sidebar
      // ring had nothing to settle it on. Post turnDone on both outcomes,
      // mirroring the generic slash-command path above.
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

    // Permission-mode toggles (plan / default / auto / bypass) are an ACP
    // session-mode switch — NOT a prompt command. Route to setSessionMode.
    if (DashboardPanel.MODE_COMMANDS.has(command)) {
      try {
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

    // Reasoning level maps to the model's `effort` (a model variant) via the
    // config-option surface — model-specific, so surface the engine's honest
    // error if this model has no matching variant rather than swallowing it.
    if (DashboardPanel.REASONING_COMMANDS.has(command)) {
      try {
        await session.client.setConfigOption('effort', command);
        this.post({ type: 'reasoningUpdate', mode: command, sessionId: sid });
        statusBarRef?.setReasoning(command);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.post({ type: 'system', text: `Reasoning effort "${command}" isn't available for this model (${msg}).`, sessionId: sid });
        // Revert the composer's optimistic toggle back to normal.
        this.post({ type: 'reasoningUpdate', mode: 'normal', sessionId: sid });
      }
      return;
    }

    // Everything else is an engine command (init / review / customize-origami /
    // config / MCP / skill). Route it through the normal prompt path: the
    // engine's detectSlashCommand dispatches a known leading-`/` command to
    // session.command (TUI parity). Replaces the never-implemented ACP
    // `_invoke_command` ext-method that produced "Method not found".
    const text = `/${command}${args ? ' ' + args : ''}`;
    this.post({ type: 'echoUser', text, sessionId: sid });
    try {
      const stopReason = await session.client.prompt(text);
      session.estimatedTokens++;
      await this.pollControllerState(session, sid);
      this.post({ type: 'turnDone', stopReason, sessionId: sid });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.post({ type: 'error', message: `/${command} failed: ${msg}`, sessionId: sid });
      this.post({ type: 'turnDone', stopReason: 'error', sessionId: sid });
    }
  }

  /** Drive /firstfold: scaffold the workspace + connect a model, streaming
   *  checklist steps into the chat as a live card. `/firstfold model` runs only
   *  the model-connect step (force re-setup). */
  private async runFirstFold(sid: string, args: string): Promise<void> {
    const cwd = findWorkspacePath() ?? this.cwd;
    const mode: 'full' | 'model' = args.trim().toLowerCase() === 'model' ? 'model' : 'full';
    // firstfold drives the SAME live todo overlay as a tool turn: firstfoldStart
    // marks the session in-flight (overlay shows) + clears old todos; `todos`
    // reuses the todoUpdate channel; `narrate` posts system lines (the
    // walk-through); firstfoldDone leaves the collapsed summary + ends in-flight.
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
      // The engine reads config AND scans the workspace's .origami/{command,
      // skills} ONCE at spawn. So both a freshly-written model AND the newly-
      // seeded /wrap skill + sample command/skill only take effect after a
      // respawn — until then /wrap et al. aren't in the / palette. A window
      // reload is the cleanest way to apply them; offer it, don't force it.
      // A FULL fold always seeds commands/skills, so it always needs the
      // reload (even when the model was already configured — the case that
      // otherwise left /wrap invisible); a model-only run needs it iff the
      // model changed.
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

  /** Ask whether to reconfigure an already-configured model (full /firstfold).
   *  Returns true to reconfigure, false (or cancel) to keep the current one. */
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

  /** Interactive provider picker for /firstfold's model-connect step. Returns
   *  the chosen provider config, or null if the user cancels at any prompt. */
  private async connectModelInteractive(): Promise<ModelChoice | null> {
    const providers = [
      { label: 'LM Studio', description: 'Local — runs on your own GPU (recommended)', id: 'lmstudio' },
      { label: 'OpenAI (API)', description: 'Cloud — needs an API key', id: 'openai' },
      { label: 'Grok (API)', description: 'Cloud — needs an API key', id: 'xai' },
      { label: 'Anthropic (API)', description: 'Cloud — needs an API key', id: 'anthropic' },
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
      anthropic: { name: 'Anthropic', model: 'claude-sonnet-4-5' },
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

  /** Parse raw image data URLs into typed { mimeType, data } pairs. */
  private parseImages(rawImages: Array<{ dataUrl: string; name: string }>): Array<{ mimeType: string; data: string }> {
    return rawImages
      .map(img => {
        const match = img.dataUrl?.match(/^data:(image\/[^;]+);base64,(.+)$/);
        return match ? { mimeType: match[1], data: match[2] } : null;
      })
      .filter((x): x is { mimeType: string; data: string } => x !== null);
  }

  /** One-time-per-window nudge: if origami-acp was rebuilt while this window
   * kept the old process alive, the user is testing stale code. Offer a
   * reload (a window reload respawns the fresh binary). Reset naturally
   * because a reload tears down + recreates the panel. */
  private staleBinaryWarned = false;
  private maybeWarnStaleBinary(session: Session): void {
    if (this.staleBinaryWarned) return;
    // The message now names the version the session's engine reported at the
    // ACP handshake, because "a newer build is on disk" alone left the user
    // unable to tell a stale window from a fix that never worked — which is
    // exactly the confusion that cost a UAT round.
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

  /**
   * Loop mode (/loop): a time-interval SCHEDULER (Claude-faithful). Re-runs a
   * prompt on a timer until the user stops it or a run reports the task is
   * permanently done (LOOP-DONE). NOT a convergence loop.
   * Kicks off the first run now, then re-schedules itself after each run finishes.
   * (A REARMED loop after a reload does NOT go through here — see
   * rearmPersistedLoops, which schedules the next tick directly so a loop
   * never fires instantly just because its interval elapsed while closed.)
   */
  private startLoopSchedule(session: Session, sid: string, intervalMs: number, prompt: string): void {
    if (session.loopSchedule) this.stopLoopSchedule(session, sid, '');
    // Plain by default — a new loop dies with its chat, which is the behaviour
    // Passing signed off on. Persistence is opted into from the Loops pane.
    session.loopSchedule = { intervalMs, prompt, runs: 0, stopped: false, createdAt: Date.now(), persistent: false };
    this.persistLoopSchedule(session);
    this.post({ type: 'system', text: `Loop scheduled — re-running every ${formatInterval(intervalMs)}. Run /loop stop to cancel.`, sessionId: sid });
    void this.loopTick(session, sid);
  }

  /**
   * THE one place a loop's next tick is armed, so "when does this fire next?"
   * is answered by the installed timer rather than recomputed from createdAt
   * (which drifts by the duration of every run that has happened since).
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
    // Nothing is armed while a run is in flight: the next tick is measured from
    // when THIS one finishes, so any time held here would be one the scheduler
    // is not keeping. The pane renders the gap as "a run is in progress".
    sched.nextRunAt = undefined;
    await this.runLoopOnce(session, sid, sched.prompt);
    const after = session.loopSchedule;               // may have been cleared mid-run
    if (!after || after.stopped) return;
    this.armLoopTimer(session, sid);
    this.persistLoopSchedule(session);                 // keep the persisted `runs` current
  }

  /** Upsert this session's active loop into persisted storage, keyed by its
   *  ENGINE session id, so a window reload can re-arm it. No-op if the
   *  session hasn't connected yet or has no active loop. */
  private persistLoopSchedule(session: Session): void {
    const sched = session.loopSchedule;
    const engineId = session.client.currentSessionId;
    if (!sched || !engineId) return;
    savePersistedLoop(this.context.workspaceState, {
      sessionId: engineId, intervalMs: sched.intervalMs, prompt: sched.prompt, runs: sched.runs, createdAt: sched.createdAt,
      persistent: sched.persistent,
    });
  }

  /**
   * Boot: re-arm persisted /loop schedules once sessionRestore.ts has
   * reopened the surviving chats — `this.sessions` reflects the final
   * restored set the moment this runs. A persisted loop whose session came
   * back gets its schedule reinstalled with the SAME accumulated `runs`
   * count, and its next tick a FULL interval out (never fired immediately
   * just because the interval elapsed while the window was closed). A loop
   * whose session did NOT come back is left exactly as persisted — never
   * dropped, never re-pointed at a different chat — so the Loops pane can
   * surface it and the user can cancel it explicitly.
   */
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
        // Schedule the NEXT tick only — never run the prompt now, or a reload
        // would fire a burst of missed runs just because the interval elapsed
        // while the window was closed.
        this.armLoopTimer(session, localId);
        this.post({ type: 'system', text: `Loop re-armed after reload — re-running every ${formatInterval(loop.intervalMs)}, next run in ${formatInterval(loop.intervalMs)}.`, sessionId: localId });
      },
    });
    // Persistent loops whose chat did NOT come back are pulled back up on their
    // own, headlessly — that is the whole point of the flag. Sequential, not
    // Promise.all: each recall spawns an engine child, and a fan-out of those at
    // boot is how you turn a window reload into a thundering herd.
    void (async () => {
      for (const loop of recall) await this.recallLoopHeadless(loop);
      if (recall.length > 0) this.post({ type: 'loopSchedulesData', ...this.loopSchedulesPayload() });
    })();
  }

  /**
   * Pull a persistent loop back up with NO chat open: recall its engine session
   * as a headless (`kind: 'agent'`) local session — the same recall path a
   * reopened chat uses, minus the editor tab — and arm the timer on it.
   *
   * This is what makes `persistent` real rather than decorative. It works
   * because a session's engine child and its webview are already independent
   * here: background agent sessions have run headless from the start, and
   * `post()` fans out to the primary host, so a loop with no chat mounted still
   * has somewhere to report.
   *
   * A recall that FAILS (the engine session was deleted on disk, the child
   * won't spawn) leaves the persisted record exactly as it was, so the loop
   * reappears in the pane as needing attention rather than vanishing silently.
   */
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
   * agentManager/loopReopen.ts, which owns every decision and the ORDER they
   * happen in (detach before open, so one engine session never has two clients
   * and the loop is never double-armed).
   */
  private async reopenLoopChatFor(rowId: string): Promise<void> {
    const plan = planLoopReopen(rowId, this.sessions, loadPersistedLoops(this.context.workspaceState));
    await reopenLoopChat(plan, {
      detach: (localId) => this.detachLoopSession(localId),
      openChat: async (engineId) => {
        const localId = await this.createSession(undefined, undefined, engineId);
        const session = this.sessions.get(localId);
        // The engine id is the proof the recall LANDED: createSession swallows a
        // failed start() for a chat session (it posts an error and returns the
        // id anyway), so the returned id alone would happily arm a timer on a
        // client with no session behind it.
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

  /** Move a loop OFF its session without STOPPING it: drop the armed timer and
   *  the live schedule first, so closeSession finds nothing to recall and
   *  stopLoopSchedule — the one path that clears persistence — is never entered.
   *  The persisted record is what the reopened chat re-arms from. */
  private detachLoopSession(localId: string): void {
    const session = this.sessions.get(localId);
    if (session?.loopSchedule) {
      if (session.loopSchedule.timer) clearTimeout(session.loopSchedule.timer);
      session.loopSchedule = undefined;
    }
    this.closeSession(localId);
  }

  /** Live /loop schedules + any persisted loop whose session isn't back yet —
   *  the payload behind loopSchedulesData (listLoopSchedules, and the
   *  re-broadcast after a Loops-pane cancel mutates state). */
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
    // Yield to any turn already active on this session (e.g. a manual send during
    // the loop's interval gap) instead of racing a second concurrent prompt() on
    // the one ACP session. loopTick still re-schedules, so we retry next interval.
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
        await session.client.prompt(buildScheduledRunPrompt(prompt));
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

  /** Stamp how a completed loop run ended. Only a run that really reached an
   *  end is recorded — the turnBusy SKIP path returns before this, because a
   *  cycle that never prompted is not a run and must not be shown as one. */
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
    // The ONE choke point for clearing persistence too — /loop stop, the
    // Loops-pane cancel control, Stop, session close, and a permanent-done
    // run all funnel through here, so persistence never diverges from the
    // live timer (a stray record would resurrect on the next reload).
    const engineId = session.client.currentSessionId;
    if (engineId) removePersistedLoop(this.context.workspaceState, engineId);
    if (message) this.post({ type: 'system', text: message, sessionId: sid });
  }

  /** Agent Manager board messages, routed to the fleet owner (kept out of the
   *  main switch so the monolith only grows this one dispatch). */
  private static readonly AM_MESSAGE_TYPES = new Set([
    'amRequestState', 'amVisible', 'amCreate', 'amStart', 'amStartAll', 'amCancel', 'amOpenChat', 'amOpenTerminal', 'amDelete',
    'amAddRepo', 'amRemoveRepo', 'amSetRepoDefault', 'amRenameRepo', 'amUpdateQueued', 'amSetAutoApprove',
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
      // The hub list is ALSO published to ~/.origami/repos.json so the engine's
      // board_* tools (and anything outside this window) can find the repos.
      saveKnownRepos: (paths) => { saveKnownRepos(this.context.globalState, paths); syncRepoFile(host.repoRoot(), paths, undefined, host.repoDisplayNames()); },
      pickRepoFolder: () => pickRepoFolder(),
      repoDisplayNames: () => this.context.globalState.get<Record<string, string>>('origami.agentManager.repoDisplayNames') ?? {},
      saveRepoDisplayNames: (names) => { void this.context.globalState.update('origami.agentManager.repoDisplayNames', names); syncRepoFile(host.repoRoot(), host.knownRepos(), undefined, names); },
      autoApprove: () => loadAutoApprove(this.context.globalState),
      setAutoApprove: (on) => saveAutoApprove(this.context.globalState, on),
      createAgentSession: async (cwd, agentName) =>
        this.createSession(agentName, undefined, undefined, { cwd, kind: 'agent' }),
      promptSession: async (sessionId, text) => {
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error(`no session ${sessionId}`);
        // Echo the task into the agent chat's transcript + title so an
        // "Open chat" later shows what the agent was asked to do.
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
        // S7 — also resolve a FORWARDED-but-unanswered permission ask so Cancel unsticks the agent.
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
        // S7 — mirror every board broadcast into the status-bar fleet aggregate.
        const anyMsg = msg as { type?: string; repos?: Parameters<typeof boardAggregate>[0] };
        if (anyMsg.type === 'amState') statusBarRef?.setAgents(aggregateText(boardAggregate(anyMsg.repos)));
      },
      openTerminal: (cwd, title) => {
        vscode.window.createTerminal({ cwd, name: title }).show();
      },
      // Raw per-session pin ONLY: the ACP setModel primitive scoped to this
      // agent's session. Deliberately NOT the chat 'setModel' handler — no lms
      // load/unload, no cross-session carry, no global-default write — so a
      // background agent's model can never evict or retarget the user's live chat.
      setSessionModel: async (sid, modelId) => {
        const s = this.sessions.get(sid);
        if (!s) throw new Error(`no session ${sid}`);
        await s.client.setModel(modelId);
      },
      // S6a typed agents: the session's live ACP mode options (harvested into
      // the roster), a validated per-session mode set (throws with the available
      // ids), and the persisted roster read/write (globalState, same pattern as
      // knownRepos / autoApprove). Only the ACP 'mode' config option is touched.
      // `current` is the session's mode at harvest time (read before any
      // setConfigOption), so it IS the engine default — flagged so the picker
      // hides the true default. Mapping shared with the S6c pre-fill (agentTypes.ts).
      agentModes: (sid) => modesFromOption(this.sessions.get(sid)?.client.getModeOption()),
      // S6c pre-fill: modes of the first live session that has them (the user's
      // open chat counts) so a fresh window's picker isn't empty; null if none yet.
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
      // S4 Apply-to-main (restamps this file's line budget 6210 -> <=6240, minimal):
      // a native diff (readonly agent-base left vs the worktree file right), a
      // success toast, and opening conflicted files for the user to resolve.
      openFileDiff: (worktree, base, relPath, rightFsPath, title) => {
        void vscode.commands.executeCommand('vscode.diff', makeBaseUri(worktree, base, relPath), vscode.Uri.file(rightFsPath), title);
      },
      // S6c race compare: two REAL on-disk worktree files (sibling A vs B) — both
      // exist even mid-run, so a plain vscode.diff of file URIs, no content provider.
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
    // Refresh the engine-readable repo registry once per board boot. A MERGE
    // now, not a rewrite: board_register writes entries this window has never
    // seen, and the manager adopts them onto the known list on its first request.
    syncRepoFile(host.repoRoot(), host.knownRepos(), undefined, host.repoDisplayNames());
    return this.agentManagerInstance;
  }

  private async handleWebviewMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: string; sessionId?: string; [k: string]: unknown };
    const sid = m.sessionId as string | undefined;

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
    if (typeof m.type === 'string' && TOOLS_PANE_MESSAGE_TYPES.has(m.type)) { const s = this.getActiveSession() ?? [...this.sessions.values()][0]; void handleToolsPaneMessage({ ...(s?.client ? { client: s.client } : {}), post: (x) => this.post(x) }, m); return; }
    // MCP pane — list/add/remove/toggle/connect/auth. Everything lives in mcpPane.ts.
    if (typeof m.type === 'string' && MCP_PANE_MESSAGE_TYPES.has(m.type)) { const s = this.getActiveSession() ?? [...this.sessions.values()][0]; void handleMcpPaneMessage({ ...(s?.client ? { client: s.client } : {}), post: (x) => this.post(x) }, m); return; }
    // Plugins pane — list/enable-disable/add-from-folder. Everything lives in pluginsPane.ts.
    if (typeof m.type === 'string' && PLUGINS_PANE_MESSAGE_TYPES.has(m.type)) { const s = this.getActiveSession() ?? [...this.sessions.values()][0]; void handlePluginsPaneMessage({ ...(s?.client ? { client: s.client } : {}), post: (x) => this.post(x) }, m); return; }
    // Skills pane — the discovered-skills list. Everything lives in skillsPane.ts,
    // including WHICH session it asks: activeSession.ts, not the raw active id.
    if (typeof m.type === 'string' && SKILLS_PANE_MESSAGE_TYPES.has(m.type)) { void handleSkillsPaneMessage({ sessions: () => this.sessions, activeSessionId: () => this.activeSessionId, post: (x) => this.post(x) }, m); return; }
    // Labyrinth model prices — workspaceState only; everything lives in labyrinthPrices.ts.
    if (typeof m.type === 'string' && LABYRINTH_PRICES_MESSAGE_TYPES.has(m.type)) { handleLabyrinthPricesMessage({ read: () => this.context.workspaceState.get(LABYRINTH_PRICES_KEY), write: (next) => void this.context.workspaceState.update(LABYRINTH_PRICES_KEY, next), post: (x) => this.post(x) }, m); return; }
    // OAuth connections (ChatGPT / SuperGrok) — everything lives in providerAuthPane.ts.
    if (typeof m.type === 'string' && PROVIDER_AUTH_MESSAGE_TYPES.has(m.type)) { const s = this.getActiveSession() ?? [...this.sessions.values()][0]; void handleProviderAuthMessage({ ...(s?.client ? { client: s.client } : {}), post: (x) => this.post(x), write: this.writeProviderConfig, openExternal: openExternalUrl, notifyReload: offerReload, refresh: (id) => { this.providerStatusCache.delete(id); void this.broadcastProviderStatus(true); } }, m); return; }
    // Subscription usage for an OAuth Lab fold. Read-only and lazy, so it takes
    // whichever session has a live engine rather than opening one.
    if (typeof m.type === 'string' && PROVIDER_USAGE_MESSAGE_TYPES.has(m.type)) { const s = this.getActiveSession() ?? [...this.sessions.values()][0]; void handleProviderUsageMessage({ ...(s?.client ? { client: s.client } : {}), post: (x) => this.post(x) }, m); return; }
    if (typeof m.type === 'string' && TURN_MESSAGE_TYPES.has(m.type)) { handleTurnMessage({ client: sid ? this.sessions.get(sid)?.client : null, sessionId: sid, post: (x) => this.post(x) }, m); return; } // the RUNNING turn — background-shell stop + interject; turnMessages.ts
    // Open the Agent Manager board from any webview surface (composer's
    // Agents button, sidebar toolbar) — same path as the palette command.
    if (m.type === 'openAgentManager') {
      void DashboardPanel.openAgentManagerInEditor(this.context);
      return;
    }
    // Open a race group's Compare screen in its own editor tab (S6d) - a UI/tab concern, not routed to the manager.
    if (m.type === 'amOpenCompare') { void DashboardPanel.openRaceCompareInEditor(this.context, m.params as RaceCompareParams); return; }
    // Open a repo's architecture-map screen in its own editor tab (S15) - reads+validates map.json, then hands off to mapTab.ts.
    if (m.type === 'amOpenMap') { void DashboardPanel.openRepoMapInEditor(this.context, String(m.root ?? '')); return; }
    // S7 — sidebar reports its grid layout; grid tiles every session visibly (forward asks, not auto-decide).
    // S7.1 — entering grid MOUNTS every session (isSessionMounted -> true), so replay any question buffered
    // while unmounted (else the grid cell looks live but shows no modal, its respond parked until Stop).
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
        // Nudge a reload if origami-acp was rebuilt while this window kept the
        // old process — otherwise the user tests stale code (the recurring
        // "I fixed it / no you didn't" trap).
        this.maybeWarnStaleBinary(session);
        // Extract images from the message (base64 data URLs from paste/drag)
        const rawImages = Array.isArray(m.images) ? m.images as Array<{ dataUrl: string; name: string }> : [];
        const imageDataUrls = rawImages.map(img => img.dataUrl).filter(Boolean);
        // Mode commands (/loop, /compose) arrive as a send with `text` =
        // the args; show the "/mode" prefix in the transcript so history reads right.
        const mode = typeof m.mode === 'string' ? m.mode : '';
        const echoText = mode ? `/${mode} ${text}`.trim() : text;
        // Echo BEFORE any probe: reprobeModel carries two 4s timeouts, and on a
        // provider that never answers an LM Studio-shaped probe (modelInfo.ok
        // stays false) it stalled every send's echo by up to 8s (W8 UAT).
        this.post({ type: 'echoUser', text: echoText, sessionId: sid, images: imageDataUrls.length > 0 ? imageDataUrls : undefined });
        session.messageLog.push({ kind: 'user', text: echoText, timestamp: Date.now() });
        // If we still don't think the model is loaded, try once more — user may
        // have started LM Studio after the webview opened. Fire-and-forget: it
        // only refreshes a status pill and never gates the prompt.
        if (!this.modelInfo.ok) void this.reprobeModel();
        // Name the chat from the first user message (slug now, engine title later).
        this.setProvisionalTitle(session, sid!, text);
        const images = this.parseImages(rawImages);
        // /loop — a time-interval SCHEDULER: re-run a prompt on a timer until
        // stopped (Claude-faithful; NOT a convergence loop).
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
          // start: kicks off the first run now (which posts its own turnDone).
          this.startLoopSchedule(session, sid!, cmd.intervalMs, cmd.prompt);
          break;
        }
        // /compose — one guided coach turn that helps shape a /loop.
        if (mode === 'compose') {
          session.turnBusy = true;
          try {
            const stopReason = await session.client.prompt(buildComposePrompt(text));
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
          const stopReason = await session.client.prompt(text, images.length > 0 ? images : undefined);
          // Poll controller state for real token counts
          session.estimatedTokens++;
          await this.pollControllerState(session, sid!);
          this.post({ type: 'turnDone', stopReason, sessionId: sid });
          void this.refreshEngineTitle(session, sid!);
          // A successful reply proves the model is reachable. Reprobe to
          // pick up the real model id; if the probe still fails (ACP went
          // through a different route), mark online anyway with the
          // settings.toml model name as the label.
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
        // M4.4 — free text from a question's "Other" option. Trimmed-empty is
        // the same as absent: an empty _meta.answerText would tell the engine
        // the user answered with nothing, which is not what happened.
        const rawAnswer = typeof m.answerText === 'string' ? m.answerText.trim() : '';
        const answerText = rawAnswer || undefined;
        // A BATCHED question reply: one entry per question the modal showed,
        // in the order it showed them. Only present when the ask carried more
        // than one question — a single ask still replies with optionId alone,
        // exactly as it always has.
        const answers = questionAnswers(m.answers);
        const session = sid ? this.sessions.get(sid) : null;
        if (!toolCallId || !session) return;
        commitPersistablePermission(this.context.workspaceState, toolCallId, optionId); // Feature 1 — an allow_always reply persists its rule across engine restarts
        const respond = session.pendingPermissions.get(toolCallId);
        if (respond) {
          session.pendingPermissions.delete(toolCallId);
          DashboardPanel.syncTabIcon(this.context, session.id, session.pendingPermissions.size); // t-q6jxrs
          respond(optionId, answerText, answers);
          // Emit audit entry for the activity feed
          this.post({
            type: 'permissionAudit',
            toolCallId,
            action: optionId ? 'approved' : 'denied',
            optionId: optionId ?? 'cancelled',
            timestamp: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
          });
        }
        // S7.1 — answering a buffered question-permission clears its board chip + buffer (the run stays in progress).
        if (sid && this.pendingQuestionPermissions.get(sid)?.toolCallId === toolCallId) { this.pendingQuestionPermissions.delete(sid); this.agentManagerInstance?.setAgentQuestion(sid, null); }
        break;
      }
      case 'planAction': {
        const session = sid ? this.sessions.get(sid) : null;
        if (!session?.client) return;
        const action = m.action as string | undefined;
        const feedback = m.feedback as string | undefined;
        const planId = m.planId as string | undefined;
        // Phase 6.6 Wave D — select_alternative carries `altIndex` from
        // the best-of-N tab bar. Rust handler reads `alt_index`.
        const rawAltIndex = m.altIndex;
        const altIndex = typeof rawAltIndex === 'number' ? rawAltIndex : undefined;
        // The ACP server's sessions map is keyed by the id IT minted; the
        // dashboard's `sid` is a local sequential identifier (`session-N`)
        // that always misses that lookup, and sending it IS the live
        // "session not found: session-3" failure. engineSessionId.ts resolves it
        // with NO fallback: no engine session yet means say so, not send `sid`.
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
        // Plan advances via the normal `plan_action` verbs
        // (approve / reject / refine / select_alternative). The donor's
        // "Begin execution" resume hack — re-prompting the model with a
        // synthetic cue to drain a `pending_plan_execution` directive —
        // is GONE: on `approve` the origami-acp bridge seeds + drives
        // execution itself (T5/U2), so the client just fires the verb
        // and lets the bridge's event stream report progress.
        (async () => {
          try {
            await session.client!.extMethod('plan_action', params);
          } catch (e: unknown) {
            // JSON-RPC errors carry the precise failure reason in
            // `data.reason`. The protocol-level `.message` is always the
            // generic "Invalid params" / "Internal error" string —
            // useless on its own. Pull the data.reason out first so the
            // chat surface tells Passing exactly which guard tripped.
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
        session.client.cancel().catch(e => console.error('[origami] cancel failed', e));
        drainPermissions(session.pendingPermissions);
        DashboardPanel.syncTabIcon(this.context, session.id, 0); // t-q6jxrs — Stop drains every open ask
        // S7.1 — Stop unsticks + drops any buffered question-permission and its board chip.
        if (sid) { this.pendingQuestionPermissions.delete(sid); this.agentManagerInstance?.setAgentQuestion(sid, null); }
        break;
      }
      case 'compactContext': {
        // Click-the-gauge -> run the engine's existing `/compact` command
        // (detectSlashCommand -> session.summarize). The confirm already
        // happened in the branded in-webview ConfirmModal, so no native dialog
        // here. Honest feedback: refresh the gauge after, surface any failure.
        // No fake "compacted" if the engine rejected it.
        const targetSid = (m.sessionId as string | undefined) ?? this.activeSessionId ?? undefined;
        const session = targetSid ? this.sessions.get(targetSid) : null;
        if (!session?.client) return;
        vscode.window.setStatusBarMessage('Origami: compacting context…', 5000);
        // Drop the inline "Compacting…" marker in the transcript immediately,
        // driven by the CLICK — so it ALWAYS appears, even when the summary
        // streams no text (e.g. a tiny session). Engine-tagged summary chunks
        // fill its carried-forward body; turnDone settles it to "Completed".
        this.post({ type: 'compactionStart', sessionId: targetSid });
        try {
          await session.client.prompt('/compact');
          // Compaction actually finished (the prompt resolved) — settle the
          // inline marker to "Completed" NOW. The manual /compact turn emits no
          // normal turnDone, so without this the marker stayed "Compacting…"
          // until the next real turn ended. Also flags the gauge drop as pending:
          // the reduction is lazy, so the ring holds here and drops to the true
          // footprint on the next real turn.
          this.post({ type: 'compactionEnd', ok: true, sessionId: targetSid });
          vscode.window.setStatusBarMessage('Origami: context compacted', 3000);
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          // Clear the live marker (it didn't complete) and surface the failure.
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
        // Skills pane Edit button — opens the skill's own SKILL.md in the real
        // editor. `location` is a webview message field, so this process must
        // treat it as untrusted: only ever act on a path that actually ends in
        // SKILL.md, the one file `list_skills` names here.
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
        // Loops pane row cancel. `sid` (m.sessionId) is a LOCAL session id for
        // a live row — resolved to a real session and stopped via the exact
        // same stopLoopSchedule path /loop stop uses. A needs-attention row
        // has no live session, so `sid` there is the persisted ENGINE session
        // id instead — the two id spaces never collide, so a plain lookup
        // tells them apart. Either way, re-broadcast fresh data so the row
        // disappears without the user needing to hit Reload.
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
        // Loops pane — bring back the chat of a loop that has none. Same two id
        // spaces as cancel above; the plan (agentManager/loopReopen.ts) resolves
        // which. Always re-broadcast: the row moves between buckets either way,
        // including when the recall failed and it lands in needs-attention.
        await this.reopenLoopChatFor(sid ?? '');
        this.post({ type: 'loopSchedulesData', ...this.loopSchedulesPayload() });
        break;
      }
      case 'setLoopPersistent': {
        // Loops pane toggle. Flips BOTH halves of the pair — the live schedule
        // (which closeSession reads to decide whether to recall) and the
        // persisted record (which boot reads for the same decision) — so the
        // two can never disagree about whether this loop survives its chat.
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
        const session = this.getActiveSession() ?? [...this.sessions.values()][0];
        this.post({ type: 'runStepsData', ...(await runStepsPayload(session?.client, sid, runCwd)) });
        break;
      }
      case 'requestRunStats': {
        // Labyrinth run index — per-run counts for the LISTED page, one call.
        // Deliberately not folded into `requestHistory`: each id costs the
        // engine a whole `session.messages` read, and the chat history dropdown
        // waits on that wire too. Everything else lives in runStats.ts.
        const session = this.getActiveSession() ?? [...this.sessions.values()][0];
        this.post({ type: 'runStatsData', ...(await runStatsPayload(session?.client, statIds(m.sessionIds), typeof m.cwd === 'string' ? m.cwd : '')) });
        break;
      }
      case 'requestCollabSteps': {
        // Labyrinth pane - a whole COLLAB as one map: every member's own run,
        // merged and lane-stamped per member. Read-only, like requestRunSteps.
        const collabId = typeof m.collabId === 'string' ? m.collabId : '';
        const runCwd = typeof m.cwd === 'string' ? m.cwd : '';
        const session = this.getActiveSession() ?? [...this.sessions.values()][0];
        this.post({ type: 'runStepsData', ...(await collabStepsPayload(session?.client, collabId, runCwd)) });
        break;
      }
      case 'requestSubagentTranscript': {
        // Sub-agent drawer — a settled child's OWN transcript, drawn with the
        // chat's renderer instead of the flat stream log. Read-only, exactly
        // like requestRunSteps: the engine projects stored messages.
        const child = typeof m.sessionId === 'string' ? m.sessionId : '';
        const childCwd = typeof m.cwd === 'string' ? m.cwd : '';
        const session = this.getActiveSession() ?? [...this.sessions.values()][0];
        this.post({ type: 'subagentTranscriptData', ...(await subagentTranscriptPayload(session?.client, child, childCwd)) });
        break;
      }
      case 'listInstructions': {
        // Instructions pane — everything feeding the system prompt, sizes only.
        const session = this.getActiveSession() ?? [...this.sessions.values()][0];
        this.post({ type: 'instructionsData', ...(await instructionsPayload(session?.client)) });
        break;
      }
      case 'openBasePrompt': {
        // Instructions pane — the pinned override rows (the base prompt and
        // the collab base prompt). Editing one means editing a file that
        // usually does not exist yet, so this case SEEDS it with the effective
        // built-in text before opening it.
        //
        // The payload carries a KIND and no path, deliberately: the target is
        // read from the engine's own `list_instructions` reply and re-checked
        // against that kind's filename, so a compromised webview cannot aim
        // this write at an arbitrary path. It is the only write this pane can
        // trigger.
        const spec = OVERRIDE_PROMPTS[overrideKind(m.kind)];
        const session = this.getActiveSession() ?? [...this.sessions.values()][0];
        if (!session?.client) {
          vscode.window.showErrorMessage(`Open a chat first — editing the ${spec.label} needs a live engine connection.`);
          break;
        }
        try {
          const base = (await session.client.listInstructions())?.[spec.field];
          if (!base?.path || path.basename(base.path) !== spec.file) {
            vscode.window.showErrorMessage(`This engine build does not expose an editable ${spec.label}.`);
            break;
          }
          const uri = vscode.Uri.file(base.path);
          // ABSENT: show the built-in and write NOTHING. Seeding here made every
          // user an overrider on their first click — the file froze at that
          // day's built-in and from then on silently outranked every later edit
          // to the shipped prompt. Opening a prompt to READ it must not change
          // which prompt is sent. An UNTITLED buffer carrying the real path
          // renders the text for editing, creates no file until the user saves,
          // and then saves to THAT path with no Save As prompt.
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
        // Instructions pane — the "+ New file" card. The inventory could read
        // every file feeding the prompt and add none of them; this is the one
        // write that closes that.
        //
        // The target is computed HERE from `this.cwd`, never taken from the
        // payload — the same rule openBasePrompt follows, for the same reason:
        // a compromised webview must not be able to aim a write at a path of
        // its choosing. AGENTS.md is the only file this seeds.
        //
        // ABSENT: seed it with the SAME /firstfold template "Restore default"
        // restores to, so a workspace prompt created here and one created by
        // /firstfold cannot drift apart. PRESENT: open it untouched — this is
        // an affordance for making the file, never for overwriting it.
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
        // The new file feeds the prompt from now on, so the inventory behind
        // the card is already out of date — refresh it the way the pane's own
        // button would, rather than leaving a list that omits what just landed.
        const session = this.getActiveSession() ?? [...this.sessions.values()][0];
        this.post({ type: 'instructionsData', ...(await instructionsPayload(session?.client)) });
        break;
      }
      case 'promptCapture': {
        // Instructions pane — what that SAME active chat last sent the model.
        // Same session pick as listInstructions above, so the inventory and the
        // capture below it can never describe two different chats.
        const session = this.getActiveSession() ?? [...this.sessions.values()][0];
        this.post({ type: 'promptCaptureData', ...(await promptCapturePayload(session?.client)) });
        break;
      }
      case 'cacheStats': {
        // Insights pane — the cache-hit-ratio card (t-kgtw47). Same active-chat
        // pick as the two cases above.
        const session = this.getActiveSession() ?? [...this.sessions.values()][0];
        this.post({ type: 'cacheStatsData', ...(await cacheStatsPayload(session?.client)) });
        break;
      }
      case 'restoreInstructionDefault': {
        // Instructions pane — the "Restore default" button. The webview
        // carries ONLY a `kind`, never a path: every target below is
        // resolved HERE, from a trusted source, so a compromised webview
        // cannot aim this destructive write anywhere else.
        const kind =
          m.kind === 'base-prompt' || m.kind === 'agents-md' || m.kind === 'collab-agent-base'
            ? m.kind
            : null;
        if (!kind) break;
        const session = this.getActiveSession() ?? [...this.sessions.values()][0];
        if (kind !== 'agents-md') {
          // Every override prompt restores the same way: DELETE the user's
          // file and let the engine fall back to the built-in it ships.
          const spec = OVERRIDE_PROMPTS[kind];
          if (!session?.client) {
            vscode.window.showErrorMessage(`Open a chat first — restoring the ${spec.label} needs a live engine connection.`);
            break;
          }
          let base;
          try {
            base = (await session.client.listInstructions())?.[spec.field];
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
        this.post({ type: 'instructionsData', ...(await instructionsPayload(session?.client)) });
        break;
      }
      // --- Crons view: scheduled runs that fire with VS Code CLOSED. All the
      // logic lives in dashboard/crons/*; these cases are wiring only. Every
      // mutation reports back through `cronOpResult` so the pane can show the
      // refusal reason (an untranslatable schedule, an unusable prompt, a
      // scheduler that said no) instead of failing silently.
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
        // S7 V10 — webview tells us which tab the user has focused.
        // Mirror to local state and persist so the next dashboard
        // open can replay it. Validated against the session map so a
        // stale/garbled id can't poison workspaceState.
        const sid = typeof m.sessionId === 'string' ? m.sessionId : null;
        if (sid && this.sessions.has(sid)) {
          this.activeSessionId = sid;
          void this.context.workspaceState.update(DashboardPanel.ACTIVE_SESSION_KEY, sid); this.saveOpen(); // Feature 2 — persist the open-set (incl. active engine id) AND keep the single-active fallback (ACTIVE_SESSION_KEY) fresh for the engine-offline restore path.
          // F7 severance (S4): permission mode is per-session now. Repaint the
          // banner from the newly-focused session's tracked mode so it follows
          // the active tab rather than whatever the last-focused chat had.
          this.paintPermissionBanner();
          // Model is per-session (each chat holds its own). Re-broadcast the
          // newly-focused session's model + selectors so the picker shows THIS
          // chat's model, not whatever the last-focused chat had. Plus the
          // per-session model map so every visible cell shows its own model.
          void this.broadcastModelOptions();
          this.broadcastConfigSelectors();
          this.broadcastSessionModels();
          // Window/vision are per-session too: re-probe the newly-focused
          // session's ACTIVE model provider-aware, so switching to a remote
          // (vLLM/Spark) tab surfaces ITS real context window instead of the
          // last-focused chat's (or a stale boot-time 0 → "window unknown").
          void this.refreshActiveModelInfo();
        }
        break;
      }

      // ── Phase M3 rectification — ModelPanel wiring ─────────────────────
      case 'modelPanel.refresh': {
        // The ControlStrip ↻ reload — re-probe the loaded model + context and
        // re-broadcast honest status. (The full Model Manager pane isn't mounted;
        // this keeps the reachable status read-out fresh.)
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
        if (this.modelOpInFlight) { this.post({ type: 'system', text: 'A model operation is already running — ignored.', sessionId: sid }); break; }
        this.modelOpInFlight = true;
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
          this.modelOpInFlight = false;
        }
        break;
      }
      // Swap the ACTIVE model: unload everything, then load the target at the
      // chosen context — immediately, via the `lms` CLI (the engine's
      // set_active_model arm returns {loaded:false, "serving not wired"}, which
      // is why the old Apply button did nothing). Probes the REAL loaded state
      // afterwards so the context shown is honest, not what we requested.
      case 'modelPanel.swap': {
        let modelKey = typeof m.modelKey === 'string' ? m.modelKey : undefined;
        if (!modelKey) { this.post({ type: 'modelPanel.error', error: 'Missing modelKey' }); break; }
        // Accept both a bare LM Studio id and the dropdown's provider-qualified
        // `<provider>/<id>` value — `runLms load` wants the bare id. Only strip the
        // known local-provider prefix (LM Studio ids can themselves contain '/').
        {
          const lp = detectLocalProvider();
          if (lp && modelKey.startsWith(lp.id + '/')) modelKey = modelKey.slice(lp.id.length + 1);
        }
        const sid = this.activeSessionId ?? '';
        if (this.modelOpInFlight) { this.post({ type: 'system', text: 'A model operation is already running — ignored.', sessionId: sid }); break; }
        this.modelOpInFlight = true;
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
          this.modelOpInFlight = false;
        }
        break;
      }
      case 'openAbsoluteFile': {
        const rawPath = String(m.path || '').trim();
        // Default to the real EDITOR, not the rendered markdown preview. Opening
        // a file to READ/EDIT it is what a clicked tool-card path means ("pull up
        // the file"), and `markdown.showPreview` silently no-ops when invoked from
        // a webview panel (no active text editor to anchor to). Preview is now
        // opt-in: only a caller that passes `preview:true` (e.g. CronPane) gets it.
        const preview = m.preview === true;
        if (!rawPath) break;
        // Agent-reported paths may be absolute (tool cards) or workspace-
        // relative (prose like "packages/engine/src/agent/agent.ts"). Resolve
        // relatives against the workspace root with the same escape-guard as
        // openWorkspaceFile below; leave absolutes untouched (back-compat).
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
        // 1-based line -> 0-based Position. A valid line forces the text editor
        // (never the .md preview, which cannot reveal a line). Validate the
        // FLOORED result so a fractional value (e.g. 0.5) can't produce a
        // negative Position that vscode.Position would reject.
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
        // Phase 8 of the 2026-04-26 collapse — webview header badge
        // click. Re-uses the command-palette path so the QuickPick
        // surface and the dashboard click drive the same code.
        await vscode.commands.executeCommand('origami.toggleMode');
        break;
      }
      case 'themeChanged': {
        const themeId = String(m.theme ?? '');
        // Remember it as the shared active theme (persisted) so a newly-opened
        // chat panel adopts it on mount (see the requestSessions handshake).
        if (themeId) this.currentTheme = themeId;
        // THEME FIX (NOTE A): the in-panel switch is driven PURELY by the
        // webview setting data-theme + the --og-* vars (theme.css) — that
        // already happened in applyTheme() before this message arrived, and
        // it never depends on a workbench theme existing. This handler is
        // ONLY the OPTIONAL workbench colour-theme sync, and it must never
        // touch the in-panel switch.
        //
        // The Origami palettes ship as contributed workbench colour themes
        // (package.json contributes.themes: Origami Meadow / Harbour / Ember /
        // Midnight / Custom) so the workbench can follow the in-panel theme.
        // 'custom' maps
        // to the "Origami Custom" theme JSON, which the ThemeEditor Save
        // rewrites from the user's palette (case 'saveWorkbenchTheme'). The
        // in-panel data-theme switch drives the --og-* palette independently
        // (NOTE A); this is purely the optional workbench sync on top.
        const workbenchThemes: Record<string, string> = {
          meadow: 'Origami Meadow',
          harbour: 'Origami Harbour',
          ember: 'Origami Ember',
          midnight: 'Origami Midnight',
          custom: 'Origami Custom',
        };
        const targetTheme = workbenchThemes[themeId];
        // No contributed workbench theme for this id: the in-panel switch
        // already applied; nothing to sync. Re-broadcast so BOTH views
        // agree on the active theme, then stop.
        if (!targetTheme) {
          this.broadcastTheme(themeId);
          break;
        }
        // Keep the config + chat views in sync on the active theme too.
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
        // G3 — ThemeEditor Save: rewrite the "Origami Custom" contributed theme
        // from the user's --og-* palette and apply it to the whole workbench.
        const palette = m.palette && typeof m.palette === 'object'
          ? (m.palette as Record<string, string>)
          : null;
        if (palette) await this.writeCustomWorkbenchTheme(palette);
        break;
      }
      case 'sendWithImages': {
        // Same as 'send' but images come from InputBar paste/drag.
        // S7 V1 (bright-muffin) — read sessionId off the payload (set
        // by InputBar at paste time) so a tab switch between paste and
        // send doesn't move the message off its original session.
        // Falls back to live activeSessionId when the webview hasn't
        // stamped one (older builds, dragdrop with no paste lock).
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
          const stopReason = await session.client.prompt(text, images.length > 0 ? images : undefined);
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
        // Phase 1 dashboard upgrade (2026-05-22) — also surface the
        // error in-chat so the user has a record after the toast
        // dismisses. Previously only the toast fired and the failure
        // dropped from session history. Webview's ChatPane.svelte has
        // a matching `case 'imageError'` that renders this as a
        // system message in the active session.
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
        // Dropdown opened/mounted — re-poll the live LM Studio library + merge
        // the configured list, then broadcast.
        await this.broadcastModelOptions();
        break;
      }
      case 'requestProviderStatus': {
        // ControlStrip mounted / a provider was just connected — probe each
        // configured provider's liveness and broadcast the "Live" badges.
        await this.broadcastProviderStatus();
        break;
      }
      case 'requestSessionModels': {
        // ChatPane mounted — send each session's own model so every cell shows
        // its own model, not the globally-loaded one. Its selectors go with it:
        // the boot-time push runs while the webview is still loading, so without
        // this seed a composer that mounted after it held no effort options and
        // hid its Effort button until some unrelated event pushed again.
        this.broadcastSessionModels();
        this.broadcastConfigSelectors();
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
        // Composer mount + popover open (t-kgsupy round 3) — GLOBAL, not
        // per-session; logic in browserAutoApproveControl.ts.
        broadcastBrowserAutoApprove({ post: (msg) => this.post(msg) });
        break;
      }
      case 'setBrowserAutoApprove': {
        await setBrowserAutoApprove({ post: (msg) => this.post(msg) }, m.value === true);
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
        // OpenRouter tier. Fetch the live catalog with the STORED key from the
        // global origami.json (cached ~5 min) and broadcast `openRouterModels`.
        // Empty (never an error toast) when no key is configured or the fetch
        // fails — the list just shows its empty state.
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
        // through the engine's per-session setConfigOption (string-encoded; '' /
        // 'auto' clears). Applied live on the next message — no reload, and
        // independent per chat. Replaces the old global origami.json write.
        const samplingSession = sid ? this.sessions.get(sid) : null;
        if (!samplingSession?.client) break;
        const enc = (v: unknown): string => {
          if (v === null || v === undefined || v === '') return '';
          const n = typeof v === 'number' ? v : parseFloat(String(v));
          return Number.isFinite(n) ? String(n) : '';
        };
        try {
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
        // origami.json agent.build.frequency_penalty; the engine re-reads it per
        // request, so it applies live on the next message — no reload. Blank = clear
        // -> fall back to the model-gated default (~0.3 local, none for cloud).
        // 0 = explicitly disable.
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
        // In-panel dropdown picked a model. A model already in origami.json
        // switches LIVE (ACP setSessionConfigOption). A model that's only in the
        // live LM Studio library (not yet in origami.json) is ADDED to the
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
        const configured = session.client.getModelOption()?.options ?? [];
        const isConfigured = configured.some(o => o.value === modelId);
        const local = detectLocalProvider();
        const slash = modelId.indexOf('/');
        const providerId = slash > 0 ? modelId.slice(0, slash) : (local?.id ?? 'lmstudio');
        const bareId = slash > 0 ? modelId.slice(slash + 1) : modelId;
        // Preserve the provider's existing display name — never clobber e.g.
        // "OpenRouter" with "LM Studio" when persisting one of its models.
        const providerName = readGlobalProviders()[providerId]?.name ?? local?.name ?? providerId;
        // OpenRouter pricing (per-million USD) persisted with the model so the
        // engine computes real spend (models.dev is empty at runtime). undefined
        // for local/free models — cost stays 0, exactly as before.
        const modelCost = providerId === 'openrouter' ? await this.openRouterCostFor(bareId) : undefined;

        // A model not yet in origami.json (a fresh LM Studio model, or an
        // OpenRouter model just picked from the live list) is WRITTEN FIRST so the
        // engine's config.refresh (setModel's self-heal) can pick it up — then it
        // takes the SAME live path as a configured model. No reload wall.
        if (!isConfigured) {
          try {
            writeModelConfig({ providerId, providerName, modelId: bareId, modelName: bareId, cost: modelCost });
          } catch (e) {
            this.post({ type: 'error', message: `Couldn't add model: ${e instanceof Error ? e.message : String(e)}`, sessionId: sid });
            break;
          }
        }

        if (this.modelOpInFlight) { this.post({ type: 'system', text: 'A model operation is already running — ignored.', sessionId: sid }); break; }
        this.modelOpInFlight = true;
        try {
          // 1. Point the ENGINE at the selection FIRST (ACP setSessionConfigOption).
          //    It self-heals: a model only just written to origami.json (absent from
          //    the frozen session snapshot) triggers an engine config-refresh +
          //    snapshot re-seed + retry, so it switches LIVE with no window reload.
          //    Retargeting before any lms op also means a prompt mid-switch requests
          //    the NEW model, never the outgoing one (no load-storm).
          const current = await session.client.setModel(modelId);
          // 2. For a LOCAL (LM Studio) model, make it the SINGLE loaded model: eject
          //    the others (free VRAM) and load the selection at the right context.
          const isLocal = !!local && modelId.startsWith(local.id + '/');
          let loadOk = true;
          if (isLocal && local) {
            // Refresh the probe FIRST: the skip below is only as trustworthy as
            // `modelInfo`, and the user may have loaded something else in the LM
            // Studio GUI since we last looked. One loopback GET buys a decision
            // that can't silently no-op a real switch.
            await this.reprobeModel();
            // The picker's chosen context length wins; else inherit the real loaded
            // window; else a SAFE default — never the model's declared max (OOMs).
            const ctx = (typeof m.contextLength === 'number' && m.contextLength > 0)
              ? m.contextLength
              : (this.contextWindow > 0 ? this.contextWindow : DEFAULT_LOAD_CTX);
            // Re-picking what is ALREADY loaded, at the SAME window, must not
            // evict and re-load it (and must not cascade that reload onto every
            // other chat on this provider). Session state below still runs.
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
          // Re-resolve the SWITCHED session's window + vision for the new selection
          // (provider-aware). Must target `session` (the picker's chat), NOT the
          // host-active session — a solo/pop-out tab's pick otherwise refreshes some
          // other chat and strands this one's window on the previous model's value.
          await this.refreshModelInfoFor(session);
          // 3. On a real success: persist as the default so NEW sessions inherit it,
          //    confirm, and re-broadcast so the just-added model reads as configured.
          //    A failed local load must NOT report success nor persist an unloadable
          //    model as the default.
          if (loadOk) {
            try {
              writeModelConfig({ providerId, providerName, modelId: bareId, modelName: bareId, cost: modelCost });
            } catch (e) {
              console.error('[origami] could not persist model to config:', e);
            }
            this.post({ type: 'system', text: `Model set to ${current}.`, sessionId: sid });
            // LM Studio CARRIES: its GPU holds one model at a time, so picking a new
            // LM Studio model moves the OTHER chats THAT ARE ALSO ON LM STUDIO to it
            // (they'd otherwise request a model the GPU no longer holds). A chat on a
            // DIFFERENT provider — a remote vLLM (the Spark), OpenRouter, cloud — keeps
            // its own model; carrying it would wrongly yank it onto LM Studio.
            if (isLocal && local) {
              for (const [otherSid, otherSession] of this.sessions) {
                if (otherSid === sid || !otherSession.client) continue;
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
          this.modelOpInFlight = false;
        }
        break;
      }
      case 'setSubagentModel': {
        // The picker's SUB-AGENT target: every sub-agent this chat spawns runs on
        // this model, ahead of the flock binding and the agent's own pin. Unlike
        // `setModel` this loads nothing and writes no config — a child's model is
        // resolved by the engine at spawn time, so pointing the session at it is
        // the whole operation. It is deliberately NOT the LM-Studio path: an
        // eject+load here would evict the model this very chat is talking to.
        const modelId = String(m.modelId ?? '');
        if (!modelId) break;
        const sid = String(m.sessionId ?? this.activeSessionId ?? '');
        const session = (sid && this.sessions.get(sid)) || this.getActiveSession();
        if (!session) {
          this.post({ type: 'system', text: 'No active session.', sessionId: '' });
          break;
        }
        // t-lmqe0g: an optional context-length override rides the SAME configId
        // value string as an "@<positive integer>" suffix (engine acp/service.ts
        // strips it before model resolution) — it is bookkeeping only (the
        // sub-agents' own auto-compaction budget), never a load/eject.
        const ctxLen =
          typeof m.contextLength === 'number' && Number.isFinite(m.contextLength) && m.contextLength > 0
            ? Math.floor(m.contextLength)
            : undefined;
        const value = ctxLen ? `${modelId}@${ctxLen}` : modelId;
        try {
          await session.client.setConfigOption('subagentModel', value);
          const ctxNote = ctxLen ? ` at ${Math.round(ctxLen / 1024)}k context` : '';
          this.post({ type: 'system', text: `Sub-agents in this chat will use ${modelId}${ctxNote}.`, sessionId: sid });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.post({ type: 'error', message: `Sub-agent model not set: ${msg}`, sessionId: sid });
        }
        break;
      }
      case 'setupProvider': {
        // Settings "Set up a different provider" — the in-panel progressive form
        // (ControlStrip) posts a ready ModelChoice; write/merge it into the GLOBAL
        // origami.json and offer a reload. Same writer as the QuickPick path
        // (setupModel), just sourced from the webview instead of native prompts.
        // The flow itself lives in the setupProvider.ts leaf (per-preset key
        // validation, model defaulting, the local auto-pick); this is the wiring.
        await setupProvider({
          sessionId: this.activeSessionId ?? '',
          msg: m,
          fetchImpl: fetch,
          fetchLocalModels: fetchLmStudioModels,
          // The server's OWN window for the model being saved, so a freshly
          // connected self-hosted provider reaches the engine with a real
          // limit.context instead of the 0 that disables auto-compaction. Same
          // probe (and the same field precedence) the gauge reads.
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
            // The transcript lines above target activeSessionId, which may be no
            // open chat at all while the user is in the CONFIG view — a failed
            // connect then looked like NOTHING HAPPENED (owner-hit, 2026-08-21).
            // A host toast is visible from every surface.
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
        // The add form asking a key-only gateway what it serves, BEFORE a key
        // exists — OpenCode Zen answers GET /models with no Authorization at all.
        //
        // This is not a phone-home. It fires only when a user has opened Add
        // provider and clicked that preset; nothing calls it on activation, on a
        // timer, or on any chat path. Its whole purpose is to replace a guessed
        // model id with the ones the gateway really offers.
        const pid = String(m.providerId ?? '');
        const preset = KEY_ONLY_PRESETS[pid];
        if (!preset?.keylessCatalog) break;
        const ids = await fetchCatalogIds(String(m.baseURL ?? preset.baseURL), fetch);
        this.post({ type: 'presetModels', providerId: pid, models: ids, defaultModel: pickDefaultModel(ids, preset.defaultModel) });
        break;
      }
      case 'renameProvider': {
        // Change ONLY a provider's pill label (block.name). The id (routing key)
        // is untouched, so no reload/respawn is needed — just re-broadcast the
        // status + model options so the new name shows everywhere immediately.
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
        // Remove a configured provider from the GLOBAL origami.json (the reverse
        // of setupProvider). Repoints the active model if it pointed there, then
        // refreshes the badges + picker. Backed up to origami.json.bak.
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
        // The per-panel Plan toggle (InputBar) switches THIS session's mode
        // (build ⇄ plan). Authoritative ACP write via setConfigOption('mode', …):
        // picking 'plan' enters the read-only plan agent. configOptions refreshes,
        // so re-broadcast to keep the panel on the engine's real current value.
        const modeId = String(m.modeId ?? '');
        // Target the POSTING panel's session (fall back to the active one) instead
        // of blindly the active session — in a grid the toggled panel may not be
        // focused.
        const sid = String(m.sessionId ?? this.activeSessionId ?? '');
        const session = (sid && this.sessions.get(sid)) || this.getActiveSession();
        // The toggle is OPTIMISTIC in the webview. If the engine rejects or no-ops
        // the switch, snap the button back to the engine's REAL mode so it can never
        // lie "Plan: on" while the session runs build.
        const revertMode = () => {
          const real = session?.client.getModeOption()?.current;
          if (real) { this.post({ type: 'modeUpdate', mode: real, sessionId: sid }); statusBarRef?.setMode(real); this.applyPermissionMode(sid, real); }
        };
        if (!modeId || !session) { revertMode(); break; }
        try {
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
        // Per-panel scoped auto-approve preset (InputBar): 'default' | 'auto' |
        // 'bypass'. Authoritative ACP write via setConfigOption('permission', …);
        // the engine turns it into a session permission ruleset applied from the
        // next message. Grid-safe: targets the posting panel's session (sid).
        const mode = String(m.mode ?? 'default');
        const approveSession = sid ? this.sessions.get(sid) : this.getActiveSession();
        if (!approveSession?.client) break;
        try {
          await approveSession.client.setConfigOption('permission', mode);
          this.post({ type: 'approveUpdate', mode, sessionId: sid ?? '' });
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          this.post({ type: 'system', text: `Couldn't set approve mode "${mode}" — ${err}`, sessionId: sid ?? '' });
        }
        break;
      }
      case 'setVisionProfile': {
        // t-kgtr6c — InputBar's eye button. Grid-safe: the posting panel's sid.
        // Everything but this wiring is in visionProfile.ts.
        const visionSession = sid ? this.sessions.get(sid) : this.getActiveSession();
        if (!visionSession?.client) break;
        const visionClient = visionSession.client;
        await applyVisionProfile(
          { post: (msg) => this.post(msg), setConfigOption: (id, v) => visionClient.setConfigOption(id, v) },
          { profile: String(m.profile ?? ''), sessionId: sid ?? '' },
        );
        break;
      }
      case 'setVisionPin': {
        // The composer's Vision tri-state (Auto / On / Off). Grid-safe: the model is read off
        // the POSTING panel's session. Pin store, write order and the unpin reconcile all
        // live in visionPin.ts — this is the wiring, and the guard reset the reconcile needs.
        await applyVisionPin({
          store: this.context.globalState, localId: detectLocalProvider()?.id, writeVision: writeModelVision,
          current: (sid ? this.sessions.get(sid) : this.getActiveSession())?.client?.getModelOption()?.current || detectModel() || '',
          reconcile: async () => { this.visionReconciled = false; const base = this.resolveEngineUrl() ?? readSettings().apiBase; if (base) await this.reconcileVisionCapabilities(base); },
          refresh: () => this.broadcastModelStatus(), warn: (text) => this.post({ type: 'system', text, sessionId: sid ?? '' }),
        }, String(m.mode ?? ''));
        break;
      }
      case 'revertToMessage': {
        // "Rewind to here": deterministic rollback to before the given assistant
        // message's turn. The engine restores files from its snapshot and marks
        // that turn + everything after for removal (finalised on the next prompt;
        // reversible via undoRevert until then). Grid-safe: posting panel's sid.
        const messageId = String(m.messageId ?? '');
        const revertSession = sid ? this.sessions.get(sid) : this.getActiveSession();
        if (!messageId || !revertSession?.client) break;
        try {
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
        // t-kgsdsw — the compaction gauge's right-click menu picks a custom
        // auto-compaction trigger. Same authoritative ACP write the other
        // per-panel config controls use (setEffort/setApproveMode above);
        // the engine turns it into a per-session override on the session row
        // (see acp/service.ts's `compactionThreshold` configId). Grid-safe:
        // targets the posting panel's session (sid), falling back to active.
        const value = String(m.value ?? '');
        const thresholdSession = sid ? this.sessions.get(sid) : this.getActiveSession();
        if (!thresholdSession?.client) break;
        const thresholdSid = sid || this.activeSessionId || '';
        try {
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
        // config-option surface. Honest failure surfaced if invalid (never silent).
        // Grid-safe, like setMode/setModel above: the control is drawn in EVERY
        // composer now, so it must move the POSTING panel's chat and not whichever
        // one the window happens to call active.
        const value = String(m.effort ?? '');
        const effortSid = String(sid ?? this.activeSessionId ?? '');
        const session = (effortSid && this.sessions.get(effortSid)) || this.getActiveSession();
        if (!value || !session) break;
        try {
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
        // The sidebar launcher's mount-time handshake. Reply with the live
        // session list so a launcher that became the PRIMARY webview (and so
        // missed the bootstrap `sessionCreated` fan-out) still lists every
        // open chat. Broadcast is fine — only the launcher handles
        // `sessionList`; ChatPane ignores it.
        //
        // t-q41knp: this is ALSO the one recovery path for a `requestPermission`
        // posted before the launcher's listener was ready — the same "missed
        // the bootstrap fan-out" race this handshake already exists to patch,
        // just for an open ask instead of a session's existence. Without
        // `pendingAskIds` a session created (and immediately asked) before
        // mount would show a session-list row with no way to ever know it is
        // waiting on the user: the ring silently drops the ask forever.
        const list = Array.from(this.sessions.values()).map(s => ({
          id: s.id,
          number: s.number,
          agentName: s.agentName,
          title: s.title,
          pendingAskIds: Array.from(s.pendingPermissions.keys()),
        }));
        this.post({ type: 'sessionList', sessions: list });
        // t-kgserq — the Chats-list sections (Main + any user-created ones,
        // t-r43glr) ride the same handshake: membership/collapse/name, read
        // fresh so a second launcher surface never boots stale.
        this.post({ type: 'chatSections', state: loadChatSections(this.context.workspaceState) });
        // Sync the just-mounted view to the shared active theme — a new webview
        // (a popped editor-tab chat) boots on the meadow default and its own
        // per-instance state, so without this push it ignores the theme the
        // rest of the panels are on. `themeSync` applies without echoing back.
        // Only when the theme is KNOWN (see currentTheme) so we never flip a
        // view that legitimately restored its own persisted theme.
        const activeTheme = this.currentTheme;
        if (activeTheme) this.post({ type: 'themeSync', theme: activeTheme });
        break;
      }
      case 'requestCollabsHeight': {
        // The Chats/Collabs divider's mount-time handshake (t-kgserq) — a
        // SEPARATE tiny wire from chatSections above: the divider's dragged
        // height is a sidebar-shell concern, not a chat-grouping one, and the
        // two features have no reason to share a persisted shape.
        this.post({ type: 'collabsHeight', heightPx: this.context.workspaceState.get<number>(DashboardPanel.COLLABS_HEIGHT_KEY) ?? null });
        break;
      }
      case 'resizeCollabsSection': {
        const raw = m.heightPx;
        const heightPx = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
        void this.context.workspaceState.update(DashboardPanel.COLLABS_HEIGHT_KEY, heightPx ?? undefined);
        this.post({ type: 'collabsHeight', heightPx });
        break;
      }
      case 'requestWorkspaceData': {
        // Mount-time handshake for the Memory graph pane (sidebar section AND
        // the full-screen tab). The pane needs ONLY the wiki pages, so read the
        // resolved wiki folder directly (doWikiRefresh) — NOT readWorkspaceData,
        // whose hardcoded `<ws>/wiki/pages` is empty when the wiki lives in a
        // subfolder, which left the graph blank until a manual Source pick.
        // Re-resolve from the open folder (this.cwd) so a fresh/late-mounting
        // pane always gets the current workspace's wiki without a pick; keep an
        // explicit user Source pick intact.
        if (this.wikiPathIsDefault || !this.wikiPath) {
          this.wikiPath = resolveDefaultWikiPages(this.cwd);
          this.wikiPathIsDefault = true;
        }
        this.doWikiRefresh();
        if (this.wikiPath) this.post({ type: 'wikiPath', path: this.wikiPath });
        break;
      }
      case 'requestHistory': {
        // In-webview history dropdown asked for the list. Query via the active
        // session's client, FALLING BACK to any open session's client so the
        // history still lists when no chat panel is the focused/active one
        // (listSessions is workspace-scoped, not session-specific — before this
        // the dropdown was empty unless a chat panel happened to be active).
        const session = this.getActiveSession() ?? [...this.sessions.values()][0];
        let rows: Array<{ sessionId: string; cwd: string; title: string; updatedAt: string }> = [];
        if (session?.client) {
          try {
            rows = await session.client.listSessions();
          } catch (e) {
            console.error('[origami] requestHistory listSessions failed', e);
          }
        }
        // Which of these runs are collab members. A failed collab read leaves
        // rows UNDECORATED (collabSessionMarks warns once) rather than breaking
        // the index.
        const marks = await collabSessionMarks(session?.client, this.cwd);
        // The open chat is MARKED, never dropped — historyRows.ts owns why.
        const items = historyRows(rows, session?.client?.currentSessionId ?? null, marks);
        this.post({ type: 'historyList', sessions: items });
        break;
      }
      case 'recallSession': {
        // User picked a past chat in the dropdown — open it in a fresh tab
        // that loadSession-restores its transcript + model context.
        const id = typeof m.sessionId === 'string' ? m.sessionId : '';
        if (!id) break;
        // Already open? Focus that tab. The history list now includes the chat
        // you are sitting in (hiding it was the defect), so "recall" can name a
        // session a tab is already bound to — and two tabs on one engine
        // session is not a second chat, it is the same chat drawn twice.
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
        // Pop a specific chat out into its own movable editor tab.
        const id = typeof m.sessionId === 'string' && m.sessionId
          ? m.sessionId
          : (this.activeSessionId ?? '');
        if (id) await DashboardPanel.openSessionInEditor(this.context, id);
        break;
      }
      case 'openMemoryFullscreen': {
        // Pop the memory graph out into its own full editor tab.
        await DashboardPanel.openMemoryInEditor(this.context);
        break;
      }
      case 'setEngineUrl': {
        // In-panel CONNECT: persist the entered endpoint to the
        // `origami.engineUrl` setting, then RECONNECT — tear down the
        // active session's AcpClient and create a fresh one. The new
        // child is spawned with ORIGAMI_API_BASE = the new URL (read at
        // spawn, see AcpClient.start), so the connection genuinely
        // re-points. Status stays honest: the post-respawn model probe
        // reports Online only if the new engine actually answers.
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
        // Sidebar drag-to-reorder. The Chats list has no order field — the order
        // IS this map's insertion order (requestSessions projects it, and the
        // open-set persistence reads it as "tab order"), so applying a new order
        // means rebuilding the map in place. `readonly` keeps the same Map
        // object, which matters: saveOpen and the loop planners read it live.
        // rankEntries owns the never-lose-a-session rule for a stale order.
        const order = Array.isArray(m.order)
          ? (m.order as unknown[]).map((v) => String(v ?? ''))
          : [];
        const ranked = rankEntries(this.sessions, order);
        if (!ranked) break;
        this.sessions.clear();
        for (const [id, session] of ranked) this.sessions.set(id, session);
        this.saveOpen();
        // Echo the settled order back so a SECOND launcher surface (the config
        // view and the secondary side bar share this host) doesn't sit on the
        // old order until it remounts — the same optimistic echo renameSession
        // does. The launcher's sessionList handler keeps each row's ring state.
        this.post({
          type: 'sessionList',
          sessions: ranked.map(([, s]) => ({ id: s.id, number: s.number, agentName: s.agentName, title: s.title, pendingAskIds: Array.from(s.pendingPermissions.keys()) })),
        });
        break;
      }
      case 'renameSession': {
        // Inline tab rename → authoritative ACP write via the config-option
        // channel (configId 'title'). The engine PATCH publishes session.updated,
        // which echoes back as 'sessionTitle'; we also post it optimistically so
        // the label updates instantly.
        const title = String(m.title ?? '').trim();
        const session = sid ? this.sessions.get(sid) : undefined;
        if (!title || !session) break;
        try {
          await session.client.setConfigOption('title', title);
          this.post({ type: 'sessionTitle', title, sessionId: sid });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.post({ type: 'error', message: `Couldn't rename chat: ${msg}`, sessionId: sid });
        }
        break;
      }
      case 'exportSession': {
        // Pillar 3 dashboard upgrade (2026-05-22) — webview sent the
        // active session's message log; render to markdown and prompt
        // the user with a Save As dialog. The webview ships the
        // log array because the extension host doesn't keep a live
        // mirror of every message (only the active turn's state).
        // Keeps the export logic in one place (here) even though
        // the source-of-truth lives webview-side.
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
        // Labyrinth map export (owner's UAT) — the SAME shape as exportSession
        // above: the webview owns the content (only it can see the rendered
        // SVG, the resolved theme and the steps that were drawn), the host owns
        // the dialog and the write. It arrives as a self-contained HTML page —
        // inline SVG with theme vars resolved to concrete values, plus the step
        // ledger the picture drops (labyrinthHtml.ts) — so this writes it
        // verbatim. HTML rather than SVG because the corridor minimap prints no
        // labels: as a picture alone it is a grid of anonymous circles.
        try {
          const html = typeof m.html === 'string' ? m.html : '';
          if (!html.trim()) {
            vscode.window.showErrorMessage('Nothing to export — no map is on screen.');
            break;
          }
          const mode = typeof m.mode === 'string' ? m.mode.replace(/[^a-z0-9-]/gi, '') || 'map' : 'map';
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
          const uri = await vscode.window.showSaveDialog({
            // NOT "origami-..." — a filename whose final segment STARTS with
            // "origami" matches Folio's file:// intercept regex, and Folio
            // would hijack the plain report into its Studio as "not a deck".
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
        // t-q41pe0 mount-time handshake — same shape as requestCollabsHeight above.
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
        // Collapsing carries NO width, and must not write one: the `raw > 0`
        // guard above coerces a collapsed 0 to undefined, which would ERASE the
        // width the user dragged to — so re-opening restores that width instead
        // of snapping back to the pane's default.
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
        // V23 — ArchivePane explicit re-list. cozy-lantern: respect
        // the includeArchived flag so the "Show archived" toggle
        // actually surfaces sessions/archived/ rows.
        const includeArchived = m.includeArchived === true;
        this.post({
          type: 'savedSessions',
          sessions: listSavedSessions({ includeArchived }),
        });
        break;
      }
      case 'archive.search': {
        // Pillar 3 dashboard upgrade (2026-05-22) — full-transcript
        // search across saved sessions. Caps at 50 hits scanning
        // both active + archived dirs. Empty query falls back to a
        // savedSessions broadcast so the regular list returns.
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
        // V23 close (cozy-lantern): real transcript replay. Read the
        // saved JSON file (from sessions/ or sessions/archived/),
        // hand the messageLog to createSession via restoredFromMessages,
        // and createSession posts `restoreMessages` + `restoreActiveSession`
        // so ChatPane rebuilds the prior scrollback.
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
          // No saved file (or unparsable) — fall back to fresh chat
          // with the requested agent, same as before.
          await this.createSession(wantedAgent);
        }
        break;
      }
      case 'archive.archive': {
        // V23 — move <id>.json into archived/ so it falls out of the
        // active list. Reversible via archive.unarchive.
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
          // Re-broadcast preserving whatever filter the webview last
          // requested. Default (no flag) returns the non-archived
          // list — ArchivePane re-issues archive.refresh with its
          // current toggle state on the next render anyway.
          const includeArchived = m.includeArchived === true;
          this.post({
            type: 'savedSessions',
            sessions: listSavedSessions({ includeArchived }),
          });
        }
        break;
      }
      case 'archive.unarchive': {
        // V23 close (cozy-lantern): inverse of archive.archive.
        // Move sessions/archived/<id>.json back into sessions/<id>.json.
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
        // V23 — permanent delete. No confirm here; the webview is
        // expected to gate this behind a click-twice / confirm UI.
        // cozy-lantern: also tries the archived/ dir so user can
        // delete archived rows too.
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
   * Watch the workspace for changes so any edit (task added to BOARD.md, new
   * goal file, cron job rewritten, agent profile edited, wiki page added)
   * automatically refreshes the dashboard. Uses debounced re-reads to coalesce
   * bursts.
   */
  private setupWatchers(wsPath: string): void {
    this.disposeWorkspaceWatchers();
    const baseUri = vscode.Uri.file(wsPath);
    const patterns = [
      'BOARD.md',
      // Endeavors PM overhaul — new operational tree.
      'Endeavors/goals/**/*.md',
      'Endeavors/projects/**/*.md',
      'Endeavors/_inbox/**/*.md',
      'Endeavors/_reports/**/*.md',
      // Legacy paths kept watching during the migration window so a
      // partially-migrated workspace still triggers refreshes.
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
      // Drive the memory-graph pages from the resolved source (default OR a
      // user-picked custom folder) rather than readWorkspaceData's hardcoded
      // `<ws>/wiki/pages`, which is empty when the wiki lives in a subfolder.
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

  /** True while a kicked provider-liveness re-probe is running, so a broadcast
   *  storm can't stack probes (each probe ends by repainting statuses). */
  private providerProbeInFlight = false;

  /** THIS session's context window, but only if it was probed FOR the session's
   *  CURRENT model (the modelWindowFor tag) — else 0 (unknown). Every surface
   *  that stamps a window onto a per-session message MUST go through this;
   *  stamping the global LM Studio `this.contextWindow` onto a session is how a
   *  Spark chat ends up wearing "64k ctx" at boot. */
  private sessionValidWindow(session: Session): number {
    const cur = session.client?.getModelOption()?.current || detectModel() || '';
    return (session.modelWindow && session.modelWindowFor === cur) ? session.modelWindow : 0;
  }

  /** ONE session's honest status, computed from ITS OWN model/provider:
   *  reachability from the provider's own liveness (remote = providerStatusCache,
   *  loopback = the rich LM Studio probe), window/vision from the session's
   *  provider-aware probe (0.2.139), provider identity so the webview can phrase
   *  offline guidance for the RIGHT server ("start LM Studio" vs "check the
   *  Spark"). A remote provider NEVER falls back to LM Studio state. A session
   *  whose engine hasn't reported a model yet (pre-start seed) is judged by the
   *  CONFIGURED default model's provider (detectModel), not assumed loopback.
   *  `ctx` carries the per-broadcast constants (one fs read per tick, not per
   *  session) + collects remote providers whose cache entry is missing/stale so
   *  the caller can kick ONE re-probe. */
  private sessionModelStatus(session: Session, ctx: {
    localId: string | undefined;
    providers: ReturnType<typeof readGlobalProviders>;
    staleRemote: Set<string>;
  }): {
    ok: boolean; modelName: string; contextWindow: number; reason: string | null;
    isVlm: boolean; visionState: VisionState; providerId: string; providerLabel: string; providerIsLocal: boolean;
  } {
    const cur = session.client?.getModelOption()?.current || detectModel() || '';
    const slash = cur.indexOf('/');
    const bare = slash > 0 ? cur.slice(slash + 1) : cur;
    const pid = slash > 0 ? cur.slice(0, slash) : '';
    const isRemote = !!pid && pid !== ctx.localId;
    const prov = isRemote ? this.providerStatusCache.get(pid) : undefined;
    // Missing or stale (>30s — beyond broadcastProviderStatus's own 20s TTL, so
    // a kicked probe actually re-probes) ⇒ ask the caller to refresh liveness.
    if (isRemote && (!prov || Date.now() - prov.at > 30000)) ctx.staleRemote.add(pid);
    const ok = isRemote ? !!prov?.live : this.modelInfo.ok;
    const reason = isRemote
      ? (ok ? null : (prov ? (prov.reason ?? 'Provider unreachable') : 'Checking provider…'))
      : (this.modelInfo.reason ?? null);
    const providerLabel = pid ? (String(ctx.providers[pid]?.name ?? pid)) : 'LM Studio';
    // The cached window is only truth for the model it was probed FOR — after a
    // model switch it's a stale lie (0 or the previous provider's window), so a
    // mismatch reads as unknown until the recovery/focus probe re-stamps it.
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
    // Phase 8 of the 2026-04-26 collapse — bundle the active mode and
    // per-mode default models alongside the model state so the
    // webview header can render "Mode: Game · Model: qwen3-32b"
    // without having to re-read settings.toml itself.
    const settings = readSettings();
    // The status surfaces read the ACTIVE session's model (the engine's real
    // per-session selection), NOT LM Studio's loaded model — otherwise a turn
    // routed to vLLM / OpenRouter still shows the local model + its window/vision
    // (the "it used LM Studio" perception). Model name, context window and vision
    // all come from the active model (window/vision via refreshActiveModelInfo,
    // provider-aware). `contextWindow` falls back to the LM Studio probe only
    // until the active-model probe lands.
    // EVERY session gets ITS OWN tagged status, computed from ITS model's
    // provider — never the single global LM Studio probe. A popped-out solo tab
    // or a background grid cell on a remote provider (the Spark) must show its
    // own reachability/window/vision; before this loop only the ACTIVE session
    // was ever broadcast, so every other pane sat on stale-or-global state (the
    // "Spark chat wearing LM Studio's offline banner" bug).
    // Per-broadcast constants: one config/local-provider read per tick (NOT per
    // session), plus the collector for remote providers with missing/stale
    // liveness so we can kick a single re-probe below.
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
      // The model the LOCAL server actually has loaded right now ('' = none).
      // A GLOBAL fact (LM Studio serves one at a time), sent on every per-session
      // post so the picker can offer "use what's loaded" without a reload.
      loadedModelId: this.modelInfo.ok ? this.modelInfo.modelId : '',
      loadedContextLength: this.modelInfo.ok ? this.modelInfo.contextLength : 0,
      activeMode: settings.activeMode,
      defaultModelNormal: settings.defaultModelNormal,
      defaultModelGame: settings.defaultModelGame,
      // The endpoint origami-acp was spawned against — so the in-panel
      // CONNECT control can seed its input with the current value. Only the
      // ACTIVE post carries it (ControlStrip seeds from it; per-session posts
      // must not flap config-view state).
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
    // Some session is on a remote provider whose liveness we don't (freshly)
    // know — kick ONE re-probe; broadcastProviderStatus repaints statuses when
    // it lands, and its fresh `at` stamps stop this from re-kicking (no storm).
    if (ctx.staleRemote.size > 0 && !this.providerProbeInFlight) {
      this.providerProbeInFlight = true;
      void this.broadcastProviderStatus().finally(() => { this.providerProbeInFlight = false; });
    }
    // Ship the configured model list alongside status so the in-panel model
    // dropdown (ControlStrip) can render without a native QuickPick. Null
    // until the session's configOptions have arrived — then guarded out.
    void this.broadcastModelOptions();
    // Seed the mode + effort selectors from the same configOptions snapshot.
    this.broadcastConfigSelectors();
  }

  /** Keyless-catalog gateway (Zen/Go) ENTITLED model ids, keyed by
   *  `baseURL + key` — what THAT key can actually call
   *  (gatewayEntitlements.ts), not the raw menu. Six-hour TTL (the sweep
   *  probes every catalog id, so it must stay rare), filled only by a
   *  non-empty answer so a failed sweep retries on the next miss instead of
   *  caching "no models". */
  private gatewayEntitledCache = new Map<string, { ids: string[]; at: number }>();
  /** Cache keys whose entitlement sweep is running — one sweep per key. */
  private gatewaySweepInFlight = new Set<string>();

  /** Broadcast the model list for the in-webview dropdown: the engine's
   *  configured models PLUS a live re-poll of the LM Studio library, so models
   *  added to LM Studio after origami.json was written still appear. Live models
   *  not yet in origami.json are flagged `configured:false` (picking one writes
   *  it to origami.json + reloads). Best-effort: a dead server just yields the
   *  configured list. */
  private async broadcastModelOptions(): Promise<void> {
    const opt = this.getActiveSession()?.client.getModelOption();
    const current = opt?.current ?? '';
    const options: Array<{ value: string; name: string; configured: boolean }> =
      (opt?.options ?? []).map(o => ({ value: o.value, name: o.name, configured: true }));
    // No active session (e.g. the last chat was closed while the Agent Manager
    // board stayed open) means the engine can't hand us its model list — seed the
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
    // and a server that doesn't answer keeps its configured list. See
    // liveModelMerge.ts for the per-provider isolation this used to lack.
    //
    // The fetcher dispatches on protocol: http → the node:http local probe;
    // https → the keyless-catalog gateway's ENTITLED set (only the Zen/Go
    // presets are offered as https — pollableProviders gates on the preset id).
    // Entitled, not the raw catalog: GET /models answers the same 64 ids for
    // every key while the tier is enforced per request, so the raw menu would
    // put 55 dead rows in a Go key's picker (gatewayEntitlements.ts). The sweep
    // costs a probe per id, so it runs in the BACKGROUND on a cache miss — this
    // broadcast returns the configured (or stale) view at once, and the sweep
    // re-broadcasts when it lands. Cache fills only on a non-empty answer, so
    // a failed sweep retries on the next miss.
    const fetchServed = async (baseURL: string, apiKey?: string): Promise<string[]> => {
      if (!/^https:\/\//i.test(baseURL)) return fetchLmStudioModels(baseURL, apiKey);
      // Keyed by URL AND key: entitlements belong to the KEY, so a Re-key must
      // sweep fresh immediately (not after the TTL), and Zen + Go blocks that
      // share one baseURL with different keys must never see each other's set.
      const cacheKey = `${baseURL}\n${apiKey ?? ''}`;
      const hit = this.gatewayEntitledCache.get(cacheKey);
      if (hit && Date.now() - hit.at < 21_600_000) return hit.ids;
      if (!this.gatewaySweepInFlight.has(cacheKey)) {
        this.gatewaySweepInFlight.add(cacheKey);
        void (async () => {
          try {
            const catalog = await fetchCatalogIds(baseURL, fetch, apiKey);
            const ids = catalog.length > 0 ? await sweepEntitledModels(baseURL, apiKey ?? '', catalog, fetch) : [];
            if (ids.length > 0) {
              this.gatewayEntitledCache.set(cacheKey, { ids, at: Date.now() });
              void this.broadcastModelOptions(); // cache hit now — no loop
            }
          } finally {
            this.gatewaySweepInFlight.delete(cacheKey);
          }
        })();
      }
      return hit?.ids ?? [];
    };
    const merged = await mergeLiveModels(options, readGlobalProviders(), fetchServed);
    if (merged.length === 0 && !current) return;
    this.post({ type: 'modelOptions', current, options: merged });
    // If a REMOTE single-model server (e.g. the Spark) had its model swapped, this
    // session is now pointing at a model that's gone (requests would 404). Adopt the
    // now-served one so Coder "just picks it up" instead of silently mis-targeting.
    await this.maybeAdoptRemoteServedModel(current, merged);
  }

  /** Guards {@link maybeAdoptRemoteServedModel} against re-entrancy (its setModel
   *  round-trips through reprobe/broadcast, which can call back into it). */
  private syncingRemoteModel = false;

  /**
   * When a REMOTE self-hosted server serves exactly one model and the active
   * session's model is no longer that model (swapped server-side, so it was pruned
   * from the live options above), adopt the served one: write it to origami.json
   * and setModel (the engine self-heals via config.refresh — no window reload).
   * Scoped to REMOTE single-model servers (vLLM). Loopback LM Studio is managed via
   * `lms` (adoptLoadedModel); a loopback Ollama / OpenRouter serve many models with
   * no single "served" model, so they're left for the user to pick.
   */
  private async maybeAdoptRemoteServedModel(current: string, options: Array<{ value: string }>): Promise<void> {
    if (this.syncingRemoteModel || this.modelOpInFlight || !current) return;
    const slash = current.indexOf('/');
    if (slash <= 0) return;
    const pid = current.slice(0, slash);
    const block = readGlobalProviders()[pid];
    const baseURL = block?.options?.baseURL;
    // Only a remote (non-loopback) OpenAI-compatible server — never OpenRouter,
    // never a keyless-catalog gateway (Zen/Go: a 60-model cloud catalog, not a
    // single-model box — now pollable, so it reaches here), and never a loopback
    // LM Studio/Ollama (managed differently, or multi-model).
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

  /** Broadcast EACH session's OWN selected model, so every visible chat cell can
   *  show its own model instead of the single globally-loaded one. Model is
   *  per-session in the engine (session.setModel); this surfaces that per cell. */
  private broadcastSessionModels(): void {
    const models: Record<string, string> = {};
    for (const [sid, session] of this.sessions) {
      const cur = session.client?.getModelOption()?.current;
      if (cur) models[sid] = cur;
    }
    this.post({ type: 'sessionModels', models });
  }

  /** Per-provider liveness cache — keyed by provider id, short TTL, so a badge
   *  refresh can't hammer OpenRouter's /key on every UI event. */
  private providerStatusCache = new Map<string, { live: boolean; reason?: string; at: number; flavor?: 'lmstudio' | 'ollama' | 'other' }>();

  /** OpenRouter catalog cache — the full /models list keyed by provider id, so the
   *  settings "view models" list + the chat picker's OpenRouter tier don't re-fetch
   *  343 models on every fold open. Short TTL (~5 min). Carries per-model pricing. */
  private openRouterModelsCache: { id: string; models: OpenRouterModel[]; at: number } | null = null;
  /** OAuth-connected provider ids (oauth-cost) — kept fresh by broadcastProviderStatus. */
  private oauthProviderIds = new Set<string>();

  /** Pricing (per-million USD) for an OpenRouter model id, so a picked/persisted
   *  model can carry `cost` into origami.json and the engine computes real spend.
   *  Reads the cache; fetches the catalog once with the stored key if absent.
   *  Returns undefined for a free/unknown model (cost stays 0). */
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

  /** Probe each CONFIGURED provider (from the global origami.json) for liveness
   *  and broadcast `providerStatus`, so the ControlStrip can render per-provider
   *  "Live" badges. OpenRouter = its stored key validates (/key). A local /
   *  OpenAI-compatible baseURL = a model is reachable. A cloud provider with a
   *  baked catalog = a key is present (not spent validating here). Cached ~20s
   *  unless `force`. Best-effort — a probe failure just shows that provider
   *  as not live, never throws. */
  private async broadcastProviderStatus(force = false): Promise<void> {
    const providers = readGlobalProviders();
    const now = Date.now();
    const TTL = 20000;
    // The engine's primary local endpoint (drives ORIGAMI_API_BASE). Only its
    // pill edits the global engine URL; other locals are per-block base URLs.
    const primaryLocalId = detectLocalProvider()?.id;
    // `kind` is a pure UI concept (which form/fold to show + free-vs-paid),
    // inferred from the stored block so a CUSTOM-id pill (a renamed / 2nd local)
    // still renders correctly rather than falling back to a generic form.
    //
    // A SELF-HOSTED endpoint is 'local' WHATEVER its auth. Before optional keys
    // existed, "has a key" was a serviceable proxy for "is a paid remote", so
    // this read `apiKey ? 'compat' : 'local'`. It no longer is: putting LM Studio
    // behind a key would have flipped its kind to 'compat' and swapped its whole
    // settings fold (ControlStrip renders Engine endpoint + model list + rep
    // penalty only for kind 'local') for a bare "Re-key…" — losing three working
    // controls as a side effect of adding auth. The honest question is where the
    // server runs, so selfHosted.ts answers it; the key is no longer consulted
    // for anything self-hosted. Remote behaviour is untouched: openrouter.ai is
    // still forced 'compat', and a remote compat/cloud block still reads its key.
    const inferKind = (baseURL?: string, apiKey?: string): 'local' | 'compat' | 'cloud' =>
      /openrouter\.ai/.test(baseURL ?? '') ? 'compat'
        : isSelfHostedBaseUrl(baseURL) ? 'local'
          : baseURL ? (apiKey ? 'compat' : 'local')
            : 'cloud';
    // An OAuth block carries NEITHER a baseURL NOR an apiKey (oauthConnections.ts
    // writes neither — the plugin injects the bearer), so it is exactly the shape
    // the "not configured" branch below was built to reject. Ask the engine's auth
    // store which of them actually hold a credential, but only when such a block
    // exists — no keyless block, no ACP round-trip on the 20s status tick.
    const keyless = Object.values(providers).some(b => !b?.options?.baseURL && !b?.options?.apiKey);
    const oauthIds = this.oauthProviderIds = keyless ? await oauthConnectedIds(this.getActiveSession()?.client ?? [...this.sessions.values()][0]?.client) : new Set<string>();
    type StatusRow = { id: string; name: string; live: boolean; reason?: string; kind: 'local' | 'compat' | 'cloud'; baseURL?: string; primary: boolean; flavor?: 'lmstudio' | 'ollama' | 'other' };
    // Every provider probes AT THE SAME TIME (providerProbe.ts). This was a `for`
    // loop awaiting one real network call per provider, so opening the picker cost
    // the SUM of every latency and one dead remote stalled the post for all of
    // them. Wall time is now the slowest ONE, bounded.
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
        // Which local server this is, so the picker offers only controls that work
        // against it (lms eject/context vs Ollama's own API vs honest display).
        let flavor: 'lmstudio' | 'ollama' | 'other' = 'other';
        try {
          if (id === 'openrouter' || /openrouter\.ai/.test(baseURL ?? '')) {
            const v = await openRouterKeyValid(apiKey ?? '', baseURL || 'https://openrouter.ai/api/v1');
            live = v.ok;
            reason = v.reason;
          } else if (KEY_ONLY_PRESETS[id]?.keylessCatalog && apiKey) {
            // A key-only HTTPS gateway (the OpenCode Zen family). Two reasons this
            // needs its own branch rather than falling into the baseURL one below:
            //
            //  - That branch probes through httpGetJson, which is node:http ONLY.
            //    `http.get` THROWS on an https: URL, so a saved Zen block reported
            //    `Protocol "https:" not supported` forever and its pill never lit.
            //  - Liveness here means "the gateway answers its public catalog AND a
            //    key is configured". The KEY was proved at add/re-key time, which
            //    is user-initiated; re-proving it costs a POSTed completion, and
            //    running that on every 20s status probe would be both spend the
            //    user never asked for and an automatic outbound call this codebase
            //    does not make.
            const ids = await fetchCatalogIds(baseURL!, fetch);
            live = ids.length > 0;
            reason = live ? undefined : 'gateway unreachable';
          } else if (baseURL) {
            // A local / OpenAI-compatible endpoint is live when a model is reachable.
            // The two reads are independent (a model list, and which server flavor
            // this is), so they run together: sequentially, a dead loopback server
            // paid httpGetJson's timeout TWICE over before this branch returned.
            // Both probes carry the block's key when it has one. Without it a
            // key-protected server 401s here and reports "no model reachable"
            // forever, while the very same endpoint answers chat turns fine.
            const [ids, detected] = await Promise.all([fetchLmStudioModels(baseURL, apiKey), detectLocalFlavor(baseURL, apiKey)]);
            live = ids.length > 0;
            reason = live ? undefined : 'no model reachable';
            flavor = detected;
          } else if (apiKey) {
            // Cloud provider (OpenAI / xAI / Anthropic) with a models.dev-baked
            // catalog — a key is present; we don't spend a request validating it.
            live = true;
          } else if (oauthIds.has(id)) {
            // Signed in over OAuth. Same class of proof as the key above — the
            // credential exists — and the same refusal to spend a request on it.
            // An UNAUTHENTICATED probe is not available here in any case: the block
            // has no baseURL to probe, and the provider's public endpoint would
            // answer 401 and be read as "down" while the model answers fine.
            live = true;
          } else {
            reason = 'not configured';
          }
        } catch (e) {
          reason = e instanceof Error ? e.message : String(e);
        }
        this.providerStatusCache.set(id, { live, reason, at: now, flavor });
        return { id, name, live, reason, kind, baseURL, primary, flavor };
      },
      // Only a probe that never SETTLES reaches this — every branch above already
      // resolves its own errors into `reason`. Written not-live and deliberately
      // NOT cached: a bound that fired proves nothing about the provider, so the
      // next open re-probes instead of serving a false "down" for 20 seconds.
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
    // Repaint the per-session model statuses from the FRESH cache — a remote
    // chat's ok/banner reads providerStatusCache, and without this a cache fill
    // (boot seed, picker open) corrected the pills but left every chat's stale
    // "unreachable"/green banner in place until an incidental focus switch.
    this.broadcastModelStatus();
  }

  /**
   * Align the engine's active model to whatever LM Studio actually has loaded.
   * The engine defaults a new session to config.model; when that's stale (e.g.
   * config.model = a vlm but the loaded model is the 30B coder) the engine
   * requests the wrong model on the first turn and LM Studio JIT-boots it. With
   * the deterministic single-model switch (eject others + load selection) there
   * is exactly one model loaded, so this unambiguously adopts it: switch the
   * engine to it LIVE (ACP) and persist so new sessions stick. ACP-only — never
   * lms-loads — and does nothing when nothing is loaded (user picks; no
   * auto-load).
   */
  private async adoptLoadedModel(target?: Session): Promise<void> {
    if (!this.modelInfo.ok || !this.modelInfo.modelId) return; // nothing loaded → user picks
    const local = detectLocalProvider();
    if (!local) return;
    const fullId = `${local.id}/${this.modelInfo.modelId}`;
    // Defaults to the active session (the boot call); createSession passes its
    // OWN session, because a chat opened LATER never re-ran this and so kept
    // requesting a stale config.model that LM Studio no longer holds.
    const session = target ?? this.getActiveSession();
    if (!session) return;
    const opt = session.client.getModelOption();
    if (!opt || opt.current === fullId) return; // already aligned
    // Only adopt when the current default is ITSELF a local-provider model (or
    // unset). NEVER stomp a deliberately-chosen REMOTE provider (vllm/…,
    // openrouter/…, a cloud model) back to LM Studio just because a local model
    // happens to be loaded — that silently hijacked the user's picked provider on
    // every boot (the "it used LM Studio not vLLM" bug).
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
   *  configOptions — so a resumed/reloaded chat reads engine truth. Per-session,
   *  for the same reason `broadcastModelStatus` is: a solo/pop-out tab never
   *  posts `activeSessionChanged`, so an active-only push could never reach it
   *  and its Effort button stayed hidden over a model with real variants. What
   *  each session is told (and what is withheld) lives in configSelectors.ts. */
  private broadcastConfigSelectors(): void {
    for (const msg of allConfigSelectorMessages(this.sessions)) this.post(msg);
  }

  private async reprobeModel(): Promise<void> {
    // Probe the SAME endpoint origami-acp was spawned against: the
    // resolved engine URL (origami.engineUrl setting → ORIGAMI_API_BASE
    // env → default). Fall back to settings.toml's api_base only when no
    // engine URL resolves, so the status pill reflects the real
    // connection target rather than a stale settings.toml value.
    const apiBase = this.resolveEngineUrl() ?? readSettings().apiBase;
    if (!apiBase) return;
    this.modelInfo = await fetchModelInfo(apiBase, undefined, primaryLocalApiKey());
    this.contextWindow = this.modelInfo.contextLength;
    // Hand the REAL window to the engine (see writeModelContextLimit). Without
    // this the probe stayed a UI-only fact and the engine kept resolving
    // limit.context = 0 ⇒ auto-compaction disabled for every local model.
    const local = detectLocalProvider();
    if (local && this.modelInfo.ok && this.modelInfo.modelId && this.modelInfo.contextLength > 0) {
      writeModelContextLimit(local.id, this.modelInfo.modelId, this.modelInfo.contextLength, { onError: contextLimitWarner(m => this.post(m), this.activeSessionId ?? '', local.id, this.modelInfo.modelId) });
    }
    this.broadcastModelStatus();
  }

  /** Provider-aware probe target for the GIVEN session's model: resolve the base
   *  URL from that model's provider block so status/context reflect the real
   *  provider (vLLM's own endpoint), not the single fixed LM Studio engine URL. */
  private resolveModelProbe(session: Session | undefined): { apiBase: string | undefined; providerId: string | null; modelId: string | null; apiKey?: string } {
    const active = session?.client.getModelOption()?.current || detectModel() || '';
    const i = active.indexOf('/');
    if (i > 0) {
      const providerId = active.slice(0, i);
      const modelId = active.slice(i + 1);
      // The key travels WITH the base URL: probing a key-protected server without
      // it returns 401, the window resolves to 0, and the session loses both its
      // context gauge and auto-compaction while the model itself answers fine.
      const block = readGlobalProviders()[providerId];
      const baseURL = block?.options?.baseURL;
      if (typeof baseURL === 'string' && baseURL) return { apiBase: baseURL, providerId, modelId, apiKey: block?.options?.apiKey };
    }
    return { apiBase: this.resolveEngineUrl() ?? readSettings().apiBase, providerId: null, modelId: null, apiKey: primaryLocalApiKey() };
  }

  private async refreshActiveModelInfo(): Promise<void> {
    await this.refreshModelInfoFor(this.getActiveSession());
  }

  /** Resolve + cache the GIVEN session's context window + vision, provider-aware,
   *  stored ON THE SESSION (not a global) so a side-by-side chat on another provider
   *  can't stamp its window onto this one. WITHOUT disturbing `modelInfo`/`contextWindow`
   *  (the LM Studio probe stays the source for lms load/eject + adopt). Local/loopback
   *  reuses the LM Studio probe; a REMOTE provider (vLLM/OpenRouter) takes its window
   *  from its OWN /v1/models (max_model_len) and NEVER borrows the local window on a
   *  miss (that was the cross-contamination) — it stays unknown (0) instead. When the
   *  session is the active one, mirror into the globals the status broadcast reads and
   *  re-broadcast so the gauge / 'N ctx' / Vision reflect the focused chat. */
  private async refreshModelInfoFor(session: Session | undefined): Promise<void> {
    if (!session) return;
    const p = this.resolveModelProbe(session);
    // Tag the cache with the model it was probed FOR — a later model switch
    // makes this window a stale lie, and readers/recovery key off the tag.
    session.modelWindowFor = session.client?.getModelOption()?.current || detectModel() || '';
    const localId = detectLocalProvider()?.id;
    if (!p.providerId || p.providerId === localId) {
      session.modelWindow = this.modelInfo.contextLength;
      session.modelIsVlm = this.modelInfo.ok && this.modelInfo.type === 'vlm';
      // No write-back here: the local window belongs to whatever LM Studio has
      // LOADED, which is not necessarily this session's model id — persisting it
      // against p.modelId would be a fabricated number. reprobeModel writes the
      // loaded model's own window, which is the only honest local pairing.
    } else {
      let win = 0;
      // OpenRouter is HTTPS-only (`https://openrouter.ai/api/v1`); fetchModelInfo's
      // probe is node:http (localProbe.ts's httpGetJson) and THROWS synchronously
      // on an https: URL. That throw is caught INSIDE httpGetJson and resolved as
      // a failed probe rather than surfacing here — so this branch silently gave
      // contextLength 0 for every OpenRouter session, forever (the gauge/tooltip
      // then fell back to the catalog number). fetchOpenRouterModels already goes
      // through the extension host's fetch (https-capable — see openRouterCostFor
      // above), so route OpenRouter through IT here instead, for a real per-boot
      // window off its own `context_length`.
      //
      // UI TRUTH ONLY. `win` only ever reaches `session.modelWindow`, which feeds
      // the gauge/tooltip in InputBar.svelte — display, not policy. Auto-compaction
      // is decided ENGINE-side off `model.limit.context` (session/overflow.ts's
      // usable()/isOverflow()), sourced from the models.dev snapshot baked into the
      // engine at build time. Unlike the generic remote path below (which
      // deliberately bridges a probed window into writeModelContextLimit so a
      // self-hosted server's real ceiling reaches the engine), OpenRouter's live
      // number is NOT written back here — do not "unify" the two without a
      // separate, deliberately-reviewed engine-side change.
      const isOpenRouter = p.providerId === 'openrouter' || /openrouter\.ai/.test(p.apiBase ?? '');
      try {
        if (isOpenRouter) {
          const models = await fetchOpenRouterModels(p.apiKey ?? '', p.apiBase || 'https://openrouter.ai/api/v1');
          const match = p.modelId ? models.find(x => x.id === p.modelId) : models[0];
          win = match?.contextLength ?? 0;
          // Liveness observation, same contract as the generic branch below: a
          // successful catalog fetch means the gateway answered, so the banner
          // reads fresh truth rather than waiting on the next 20s status tick.
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
          // Bridge the probe to the ENGINE for remote providers too (a vLLM's
          // max_model_len is just as real as LM Studio's loaded window). Keyed to
          // the model we asked ABOUT, and only when the server answered for it.
          // onlyWhenUnset: a remote server reports its STATIC max, and this config
          // already carries hand-set (deliberately lower) windows for vLLM models.
          // Fill the 0 that breaks compaction; never overrule a chosen number.
          if (p.providerId && p.modelId && win > 0 && (!info.modelId || info.modelId === p.modelId)) {
            writeModelContextLimit(p.providerId, p.modelId, win, { onlyWhenUnset: true, onError: contextLimitWarner(m => this.post(m), session.id, p.providerId, p.modelId) });
          }
          // This probe IS a liveness observation — record it so the banner reads
          // fresh truth (a boot/focus window-probe of a live Spark must not leave
          // the chat saying "unreachable" until some later provider re-probe).
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
    // ALWAYS broadcast — statuses are per-session now, and a solo/pop-out tab's
    // refresh must repaint even when the host-active session is a different chat
    // (the mirror above is active-only; the broadcast is for everyone).
    this.broadcastModelStatus();
  }

  /**
   * Auto-detect vision support for local models and keep origami.json in sync.
   * The engine defaults every config-declared model to no-image-input because
   * the OpenAI-compatible API never reports modalities, so anything that knows
   * better must write the flag before the engine spawns. Which servers know:
   * LM Studio (`/api/v0/models` tags each model `vlm` vs `llm`) and Ollama
   * (`/api/show` returns a `capabilities` array). vLLM, SGLang and every other
   * OpenAI-compatible box expose NO capability surface, so they are left exactly
   * as configured — see visionDetect.ts for why absent must never mean false.
   * Runs once per panel; only writes on an actual mismatch. Best-effort: a dead
   * endpoint or a server with nothing to say simply no-ops and retries later.
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
    // visionWrites owns BOTH skips: a model the server did not answer for is
    // UNKNOWN (writing `false` blinds a hand-configured VLM), and a PINNED one is
    // overruled on purpose — else a pin would last until the next panel opened.
    for (const { modelId, enabled } of visionWrites({ models: configured, seen, pinned: (id) => readVisionPin(this.context.globalState, local.id, id) !== undefined, current: (id) => readModelVision(local.id, id) })) {
      try {
        writeModelVision({ providerId: local.id, modelId, enabled });
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
    // F12/1.13 - a collab tab BADGES when its room needs the user. Read off the
    // payload every surface already gets, so no second wire and no second poll:
    // the rule is collabAttention.ts, the panel write is collabTab.ts. Fires for
    // a room whose tab is SHUT too, because collabWatch's host poll comes
    // through here as well - and setCollabTabWaiting is a no-op with no tab.
    const cs = msg as { type?: string; collabId?: string };
    if (cs.type === 'collabStateData' && typeof cs.collabId === 'string') {
      setCollabTabWaiting(cs.collabId, collabNeedsUser(msg as CollabAttentionState));
    }
    // NOTE 4 — fan out every broadcast to the primary host AND any
    // attached views (the config + chat split), so both surfaces see the
    // same modelStatus / contextUpdate / theme / session events and never
    // disagree. A failed post to one view never blocks the others.
    const targets: vscode.Webview[] = [this.panel.webview, ...this.extraViews];
    for (const view of targets) {
      view.postMessage(msg).then(undefined, (err) => {
        console.error('[origami] postMessage failed', err);
      });
    }
  }

  /**
   * NOTE 4 — attach a second webview (the config OR chat view, whichever
   * resolved after the primary) to this host. The view receives every
   * future `post()` broadcast and its inbound messages route into the
   * shared `handleWebviewMessage`. Its HTML is rendered for the given
   * bundle so it loads the right Svelte shell + the theme sidecar CSS.
   * The attachment is torn down when the host disposes (the view's own
   * onDidDispose is owned by VS Code).
   */
  public attachView(host: WebviewHost, bundle: WebviewBundle, soloSessionId?: string, memory = false, board = false, raceCompare?: RaceCompareParams, repoMap?: RepoMapParams, collab?: CollabTabParams): void {
    host.webview.html = this.renderHtmlFor(bundle, host.webview, soloSessionId, memory, board, raceCompare, repoMap, collab);
    // Wiring (inbound sub + broadcast list + RE-ATTACH teardown of any previous
    // wiring for this same webview — the doubled-send guard) lives in
    // viewWiring.ts. Solo mapping set AFTER rewire, which clears the old one.
    const teardown = rewireView(this.viewWiring, this.extraViews, this.viewSolo, host.webview, (m) => this.handleWebviewMessage(m));
    // Remember who this view speaks for, so its sticky banner can be painted
    // from THAT session rather than from whichever chat the sidebar has focused.
    if (soloSessionId) this.viewSolo.set(host.webview, soloSessionId);
    // If VS Code tears this attached view down (not the primary), drop it
    // from the broadcast list so we stop posting to a dead wire, and
    // release this view's wiring. The attached view does NOT own the
    // session lifecycle — only the primary host's dispose kills the ACP
    // child (and only when no other view remains, see dispose()).
    const disposeSub = host.onDidDispose(() => {
      teardown();
      disposeSub.dispose();
    });
    // Replay current global state so the freshly attached view is not
    // blank until the next event: model/connection status + the active
    // theme.
    this.broadcastModelStatus();
    // #4 REGRESSION FIX — the primary host bootstraps the first session
    // via initialize()→createSession() BEFORE the second view attaches.
    // That `sessionCreated` broadcast happened before this webview's wire
    // existed, so without a replay the attached chat view has zero
    // sessions and renders the bare "No session" stub instead of the
    // ChatPane + empty-state. Replay every existing session (creation,
    // restored scrollback, context gauge, active-session pointer) to THIS
    // view only, so an opened chat always lands on a live session.
    this.replaySessionsTo(host.webview);
  }

  /**
   * #4 REGRESSION FIX — replay the current session state to a single,
   * freshly-attached webview (not a broadcast). Mirrors the per-session
   * messages createSession() posts at bootstrap so a view that attached
   * AFTER the session was created sees the ChatPane + empty-state rather
   * than the "No session" stub. Scoped to one webview so the already-live
   * primary view is not double-fed.
   */
  private replaySessionsTo(webview: vscode.Webview): void {
    if (this.sessions.size === 0) return;
    const wsPathForArt = findWorkspacePath();
    for (const session of this.sessions.values()) {
      const agentArt = wsPathForArt
        ? readAgentArt(wsPathForArt, session.agentName)
        : null;
      this.postTo(webview, {
        type: 'sessionCreated',
        sessionId: session.id,
        sessionNumber: session.number,
        agentName: session.agentName,
        // A reopened chat learns its stored name during loadSession (the engine
        // replays `session_info_update`), which is BEFORE this view attached —
        // without carrying it here the row/tab renders the agent name alone.
        title: session.title,
        agentArt,
        needsSetup: needsFirstFold(wsPathForArt ?? this.cwd), botGlyph: session.botGlyph,
      }); postPeerName(session.client.peerName, session.id, m => this.postTo(webview, m)); // reattach replay
      // Restore visible scrollback for sessions that already have history
      // (e.g. an archive rehydrate that happened on the primary view).
      if (session.messageLog.length > 0) {
        this.postTo(webview, {
          type: 'restoreMessages',
          sessionId: session.id,
          messages: session.messageLog,
        });
      }
      // Seed the context gauge so it isn't blank until the next turn — with THIS
      // session's own (tag-valid) window, never the global LM Studio one.
      this.postTo(webview, {
        type: 'contextUpdate',
        sessionId: session.id,
        tokensUsed: 0,
        contextWindow: this.sessionValidWindow(session),
        ...this.sessionActivityFields(session),
      });
      // The composer's Effort / Session-Mode / Approve controls hold ONLY what
      // the host last pushed, and the push that ran while this view was still
      // loading never reached it — so a chat that attached late showed no Effort
      // button over a model with real variants. Seeded here, per session, like
      // the context gauge above it.
      for (const msg of configSelectorMessages(session.id, session.client)) this.postTo(webview, msg);
      // S7.1 — re-post a buffered question-PERMISSION to the newly mounted view (the user answers it
      // there, resolving the ORIGINAL stored respond); a dead turn drops it and drains the respond.
      this.replayBufferedQuestionFor(session, (msg) => this.postTo(webview, msg));
    }
    // Point the attached view at the same active session the host holds,
    // so the chat opens focused on a real thread.
    if (this.activeSessionId && this.sessions.has(this.activeSessionId)) {
      this.postTo(webview, {
        type: 'restoreActiveSession',
        sessionId: this.activeSessionId,
      });
    }
  }

  /** S7.1 — surface `session`'s buffered question-permission on `poster` (turnBusy gate): POST it AND
   *  auto-open its plan_exit/dream preview (buffered-then-replayed must match the live-forward context)
   *  while the turn lives; DROP + drain + clear chip on a dead turn. Shared by replaySessionsTo + grid. */
  private replayBufferedQuestionFor(session: Session, poster: (msg: object) => void): void {
    const qp = this.pendingQuestionPermissions.get(session.id);
    const qpAct = questionReplayAction(!!qp, session.turnBusy === true);
    if (qpAct === 'post') { poster({ type: 'requestPermission', toolCallId: qp!.toolCallId, title: qp!.title, kind: qp!.kind, sessionId: session.id, target: qp!.target, options: qp!.options }); openPermissionPreview(session, qp!.title); }
    else if (qpAct === 'drop') { this.pendingQuestionPermissions.delete(session.id); drainPermissions(session.pendingPermissions); DashboardPanel.syncTabIcon(this.context, session.id, 0); this.agentManagerInstance?.setAgentQuestion(session.id, null); }
  }

  /**
   * Post a single message to ONE webview (not the broadcast fan-out).
   * Used by replaySessionsTo so a newly-attached view can be caught up
   * without re-posting to the already-live primary view.
   */
  private postTo(webview: vscode.Webview, msg: object): void {
    webview.postMessage(msg).then(undefined, (err) => {
      console.error('[origami] postMessage(replay) failed', err);
    });
  }

  /**
   * Push the active in-panel theme id to every view so config + chat
   * agree. Sent as `themeSync` (NOT `themeChanged`) so the receiving
   * shells set data-theme WITHOUT echoing a `themeChanged` back — that
   * would loop. This is the cross-view sync the workbench theme used to
   * (incompletely) provide; it works for all four themes.
   */
  private broadcastTheme(themeId: string): void {
    if (!themeId) return;
    this.post({ type: 'themeSync', theme: themeId });
  }

  public dispose(): void {
    // SAFETY: if other live views remain attached (e.g. the popped-out
    // editor chat tab closed while the sidebar is still open), do NOT tear
    // down the shared sessions — the conversation continues on the
    // surviving view(s). This makes "closing the editor tab kills every
    // session" impossible regardless of which surface became primary.
    // post() tolerates the now-dead primary webview (it catches the throw).
    if (this.extraViews.length > 0) {
      return;
    }
    // Only clear the singleton if THIS instance is the registered
    // full-panel dashboard. A sidebar instance (created via
    // createForHost) is not the singleton, so it must not clear it.
    if (DashboardPanel.current === this) {
      DashboardPanel.current = undefined;
    }
    this.disposeWorkspaceWatchers();
    // The host-side collab watch is one timer for the whole workspace, held in
    // module state so a second panel cannot double the traffic — which also
    // means nothing but this stops it.
    stopCollabWatch();
    this.agentManagerInstance?.dispose();
    for (const session of this.sessions.values()) {
      saveSession(session);
      session.client.dispose();
    }
    this.sessions.clear();
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
   * Render the boot HTML for an arbitrary bundle on a given webview. Used
   * both for the primary host (renderHtml) and for an attached second view
   * (attachView), so config + chat each load their own Svelte shell + the
   * matching theme sidecar CSS while sharing one host.
   */
  private renderHtmlFor(bundle: WebviewBundle, webview: vscode.Webview, soloSessionId?: string, memory = false, board = false, raceCompare?: RaceCompareParams, repoMap?: RepoMapParams, collab?: CollabTabParams): string {
    // The chat shell (ChatView) speaks the identical protocol regardless of
    // layout; the `config`/`dashboard` branches below are vestigial (those
    // surfaces were removed and are no longer built).
    const bundleName =
      bundle === 'config' ? 'config'
      : bundle === 'chat' ? 'chat'
      : 'dashboard';
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview', `${bundleName}.js`),
    );
    // THEME FIX (NOTE A): every Svelte entry imports shared/theme.css, so
    // esbuild emits a sidecar `<bundle>.css` that carries the four
    // :root[data-theme] palettes. We MUST link it — without it the --og-*
    // vars are undefined and the panel falls through to the VS Code
    // workbench background, so Midnight/Lilac (which have no contributed
    // workbench theme) never visibly switch. Linking the sidecar makes
    // data-theme repaint all four themes independent of the workbench.
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview', `${bundleName}.css`),
    );
    const nonce = getNonce();
    // Surface the installed extension version into the webview so the chat
    // header can show it — lets the user validate they're not running a
    // stale extension host after an update (a new window can keep the old
    // one alive). Injected as a global so it's available before mount.
    const extVersion = String(
      (this.context.extension.packageJSON as { version?: unknown }).version ?? '',
    );

    // Phase C2 of the plan-mode SOTA pass (2026-05-07) — sticky
    // permission-mode banner. Mirrors the TUI's top-of-screen banner
    // so the user can see at a glance when plan / auto / bypass
    // mode is active. The inline script listens for `permModeUpdate`
    // postMessage events so live changes (after a /default slash
    // command) update without a full webview reload.
    //
    // Seeded from the session THIS view speaks for. It used to be seeded from
    // the panel-global "last painted mode", which meant a chat popped out while
    // another was in plan booted showing plan — a fresh chat with zero turns
    // wearing a sticky banner it had never earned (0.3.24 UAT).
    const bannerMode = this.permBanner.modeForView(
      soloSessionId,
      this.activeSessionId,
      (soloSessionId ? this.sessions.get(soloSessionId) : this.getActiveSession())?.client.getModeOption()?.current,
    );
    const bannerInitial = this.renderPermBannerHtml(bannerMode);
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
    #permModeBanner[data-mode="auto"]      { display: block; background: #5f4a1e; color: #ffd98a; }
    #permModeBanner[data-mode="bypass"]    { display: block; background: #5f1e1e; color: #ffb0b0; }
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

  /** Phase C2 — banner copy. Empty string for default (CSS hides). */
  private renderPermBannerHtml(mode: string): string {
    switch (mode) {
      case 'plan':
        return '🟦 PLAN MODE — sticky. Every turn enters plan-mode. Type /default to exit.';
      case 'auto':
        return '⚡ AUTO MODE — auto-approving tool calls. Type /default to exit.';
      case 'bypass':
        return '⚠ BYPASS — all permission checks suspended. Type /default to exit.';
      default:
        return '';
    }
  }

  /** Phase C2 — record a session's mode and repaint the sticky banner. The
   *  single write path for the banner: it is called from the engine's live
   *  `onModeChanged` stream and from every mode write the extension issues
   *  itself (slash /plan /default /auto /bypass, the InputBar toggle, the
   *  optimistic revert). No polling — the old `get_permission_mode` ext-method
   *  was never implemented by the engine, so the poll only ever silently kept a
   *  stale mode.
   *
   *  Repaints EVERY view, not just the focused one: a background chat's own
   *  popped-out tab carries a banner for that chat, so its mode change has a
   *  surface to reach even while the sidebar is looking at something else. */
  private applyPermissionMode(sessionId: string, modeId: string): void {
    this.permBanner.set(sessionId, modeId);
    this.paintPermissionBanner();
  }

  /** Repaint each view's banner from the mode of the session THAT view speaks
   *  for — its solo session for a popped-out chat tab, the focused one for the
   *  sidebar — falling back to that session's own engine `mode` config-option
   *  while no mode event has fired for it yet (session bootstrap). */
  private paintPermissionBanner(): void {
    this.postTo(this.panel.webview, this.permBannerMsg(undefined));
    for (const view of this.extraViews) this.postTo(view, this.permBannerMsg(this.viewSolo.get(view)));
  }

  /** One view's banner payload. `solo` empty/undefined = the sidebar. */
  private permBannerMsg(solo: string | undefined): object {
    const engineMode = (solo ? this.sessions.get(solo) : this.getActiveSession())?.client.getModeOption()?.current;
    const mode = this.permBanner.modeForView(solo, this.activeSessionId, engineMode);
    return { type: 'permModeUpdate', mode, text: this.renderPermBannerHtml(mode) };
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
 * Pillar 3 dashboard upgrade (2026-05-22) — render a session's
 * webview-side message log to a markdown transcript. User-facing:
 * triggered by the chat header's export button → `exportSession`
 * webview message → Save As dialog.
 *
 * Shape per message: the webview's `ChatSession.messages` array. We
 * loosely type-check each entry because the webview ships its
 * `Message` interface across the wire and TypeScript doesn't enforce
 * runtime invariants. Unknown kinds fall through to a generic
 * blockquote so nothing is silently dropped.
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
        // Quote user messages so they pop in a markdown reader.
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
        // Unknown kind — emit as a quoted block so the transcript
        // still captures the content without claiming structure
        // that doesn't exist.
        if (m.text) {
          lines.push(`> ${m.text}`);
          lines.push('');
        }
    }
  }

  return lines.join('\n');
}
