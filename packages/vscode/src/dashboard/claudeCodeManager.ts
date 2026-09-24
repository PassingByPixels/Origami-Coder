// claudeCodeManager.ts — the SEAM between a Claude Code passthrough chat and
// the dashboard: a MESSAGE_TYPES set plus one handler, so DashboardPanel
// grows by a single dispatch line.
//
// A passthrough is a BOUND CELL — an ordinary engine session id — not a
// session of its own; see claudeCodeCell.ts for why.

import { claudeCodeValue, isClaudeCodeModel } from '../claudeCode/models';
import { imagePartOf, type ImagePart, type PassthroughMode } from '../claudeCode/protocol';
import { INTERRUPTED_TOOL_NOTE, settleOpenTools } from '../claudeCode/translator';
import {
  answerPermission, bindCell, boundCell, disposeAllCells, unbindCell,
  type BoundCell, type ClaudeCodeHost,
} from './claudeCodeCell';
import { detectCli as detect, detectReport, resetClaudeCliCache, statusPost } from './claudeCodeDetect';
import { CLI_MISSING, openClaudeHistoryChat } from './claudeHistory';
import { emit } from './claudeCodeLog';
import { __resetMirrorForTests } from './claudeCodeMirror';
// Supervision (the Access rail + the Plan button) lives with the asks it
// produces; the review with the digest it reads. Both re-exported below.
import { applyApproveMode, applyPlanMode } from './claudeCodePermissions';
import { reviewWithClaude } from './claudeCodeReview';

export { modeFromApprove, planModeOf } from './claudeCodePermissions';

export { PASSTHROUGH_KIND, claudeCodeKind, claudeCodeModelOf, isEngineEchoOnBoundCell, refreshAllPlanUsage, type ClaudeCodeHost, type PlanUsageHost } from './claudeCodeCell';

/** What the connection pill's "open a Claude Code chat" binds to, absent a pick. */
export const DEFAULT_CLAUDE_CODE_MODEL = claudeCodeValue('sonnet');

/** Where the resume map lives in workspaceState, keyed by CELL id (not cwd
 *  alone — see claudeCodeResume.ts). */
export const CLAUDE_CODE_RESUME_KEY = 'origami.claudeCode.resume';

/** The three types that are NOT addressed to an existing chat cell (t-463pb6:
 *  a History pick is a NEW cell seeded to resume an old CLI conversation). */
export const CLAUDE_CODE_MESSAGE_TYPES = new Set(['requestClaudeCodeStatus', 'newClaudeCodeSession', 'openClaudeHistory']);

/** What a BOUND cell intercepts here instead of at the engine — an intercept
 *  list, not an exclusion one: everything else must keep reaching the code
 *  that owns it, since the cell is a real engine chat now. */
const BOUND_TYPES = new Set([
  'send', 'cancel', 'permission', 'setApproveMode', 'closeSession', 'setModel',
    // sendWithImages and setMode used to reach the ENGINE session hiding under
    // the cell — acted on, not swallowed, which is worse: the CLI never saw
    // the attachment, and the composer's Plan button flipped the wrong agent.
  'sendWithImages', 'setMode',
  // Capability-gated OFF for this kind (passthroughCaps.ts). Named so a leaked
  // gate is SWALLOWED here rather than quietly acting on the engine session the
  // user cannot see — the one thing phase 1's catch-all was right about.
  'compactContext', 'revertToMessage', 'setSubagentModel', 'secondOpinion',
]);

/** Does this message belong to the passthrough feature: a picker pick, or one of the bound-cell
 *  types. */
export function claudeCodeOwns(m: { type?: unknown; sessionId?: unknown; modelId?: unknown }): boolean {
  const type = typeof m.type === 'string' ? m.type : '';
  if (CLAUDE_CODE_MESSAGE_TYPES.has(type)) return true;
  if (type === 'setModel' && isClaudeCodeModel(m.modelId)) return true;
    // A Claude reviewer on an ordinary engine chat is routed on the model id,
    // not the cell, since `boundCell` is empty for it.
  if (type === 'secondOpinion' && isClaudeCodeModel(m.modelId)) return true;
  return typeof m.sessionId === 'string' && !!boundCell(m.sessionId) && BOUND_TYPES.has(type);
}

/** Detection and diagnostics live in claudeCodeDetect.ts; re-exported here. */
export { claudeCli, claudeCliDiagnostics, probeClaudeCliInBackground, resetClaudeCliCache } from './claudeCodeDetect';

export async function handleClaudeCodeMessage(host: ClaudeCodeHost, m: Record<string, unknown>): Promise<void> {
  const type = String(m.type ?? '');
  const sid = typeof m.sessionId === 'string' ? m.sessionId : '';
  if (type === 'requestClaudeCodeStatus') {
    // `refresh` = the user clicked an UNDETECTED pill. Drop the memo first, or
    // the retry re-reports the same stale "not found" and teaches nothing.
    if (m.refresh === true) resetClaudeCliCache();
    host.post(statusPost(await detectReport(host)));
    return;
  }
  if (type === 'newClaudeCodeSession') { await openPassthroughChat(host); return; }
  // A pick from the History popup: a new cell seeded to RESUME a CLI session the
  // user had before, in the folder it was made in. claudeHistory.ts owns both rules.
  if (type === 'openClaudeHistory') { await openClaudeHistoryChat(host, await detect(host), DEFAULT_CLAUDE_CODE_MODEL, m); return; }
  if (type === 'setModel') { await applyModelPick(host, sid, String(m.modelId ?? ''), m); return; }
    // `detect` (not host.cli), so the review uses the same memoised probe as
    // the rest of the feature. Only a Claude reviewer reaches here — any other
    // model came from a bound cell, where the control is capability-gated off.
  if (type === 'secondOpinion' && isClaudeCodeModel(m.modelId)) { await reviewWithClaude(host, await detect(host), sid, m); return; }
  const cell = boundCell(sid);
  if (!cell) return;
  switch (type) {
    case 'send':
    case 'sendWithImages': {
      const text = typeof m.text === 'string' ? m.text.trim() : '';
      if (!text) return;
      // Only `sendWithImages` carries attachments; `send` yields [] and emits
      // the byte-identical frame phase 1 emitted (protocol.userMessage).
      const raw = Array.isArray(m.images) ? m.images : [];
      const images = raw
        .map((i) => imagePartOf((i as { dataUrl?: unknown })?.dataUrl))
        .filter((p): p is ImagePart => p !== null);
            // The panel echoes the user's line for an engine send; this path is
            // intercepted before that, so it echoes its own or the transcript is a monologue.
      emit(host, sid, { type: 'echoUser', text, sessionId: sid, ...(raw.length ? { images: raw.map((i) => (i as { dataUrl?: string }).dataUrl) } : {}) });
      titleFromFirstLine(host, cell, text);
      host.post({ type: 'busy', sessionId: sid });
      cell.driver.prompt(text, images);
      return;
    }
    case 'setMode': return applyPlanMode(host, cell, String(m.modeId ?? 'build'));
    case 'cancel': {
      cell.driver.interrupt();
      // Interrupt kills the turn where it stands, so a card still running will
      // never get a result. Settled BEFORE `turnDone` (cellState.settleOpenTools).
      for (const post of settleOpenTools(cell.state, INTERRUPTED_TOOL_NOTE)) emit(host, sid, post);
      // Through `emit`: the mirror closes a turn on `turnDone`, and a cancelled
      // turn is still a turn the user can see and should find in History.
      emit(host, sid, { type: 'turnDone', stopReason: 'cancelled', sessionId: sid });
      return;
    }
    case 'permission': return answerPermission(host, cell, m);
    case 'setApproveMode': return applyApproveMode(host, cell, String(m.mode ?? 'default'));
    case 'closeSession': {
      // Release the binding, then let the CELL close itself the ordinary way —
      // it is a real engine chat, and only the panel can tear one down.
      unbindCell(host, cell, '');
      host.redispatch(m);
      return;
    }
    default:
      // A capability-gated control (rewind, compaction, sub-agent model, second
      // opinion) that reached here means the UI gate leaked. Swallow it rather
      // than let it act on the engine session hiding under this cell.
      host.log(`[claude-code] ignoring '${type}' — not supported on a passthrough chat`);
  }
}

/**
 * Name the chat after its first line, since this path is intercepted before
 * the panel's own titling code runs.
 *
 * Locally computed (no model call — a title isn't worth a turn on the user's
 * subscription), and WRITTEN THROUGH `renameSession` — the panel's own
 * authoritative rename path — rather than a bare post, so the sidebar, the
 * engine, and the History dropdown all pick it up. Applied once per cell.
 */
function titleFromFirstLine(host: ClaudeCodeHost, cell: BoundCell, text: string): void {
  if (cell.titled) return;
  cell.titled = true;
  const words = text.trim().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return;
  const title = words.slice(0, 4).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').slice(0, 40);
  host.post({ type: 'sessionTitle', sessionId: cell.id, title });
  host.redispatch({ type: 'renameSession', sessionId: cell.id, title });
}

/** The connection pill's "open a Claude Code chat": make an ordinary chat
 *  cell, then bind it — creating the cell is what opens the editor tab. */
async function openPassthroughChat(host: ClaudeCodeHost): Promise<void> {
  const cli = await detect(host);
  if (!cli) {
    host.post({ type: 'error', message: CLI_MISSING, sessionId: '' });
    return;
  }
  const id = await host.createCell();
  // The cell's own agent name stays whatever the roster gave it; the TITLE says
  // what it is running. Only ever set on a cell this feature just created — a
  // flip on an existing chat must not overwrite a title the user is reading.
  host.post({ type: 'sessionTitle', sessionId: id, title: 'Claude Code' });
  bindCell(host, cli, id, DEFAULT_CLAUDE_CODE_MODEL);
}

/** A pick from the picker. `claude-code/*` binds this cell; anything else parks
 *  a bound one and lets the message continue to the engine untouched. */
async function applyModelPick(host: ClaudeCodeHost, sid: string, modelId: string, m: Record<string, unknown>): Promise<void> {
  if (isClaudeCodeModel(modelId)) {
    const cli = await detect(host);
    if (!cli) { host.post({ type: 'error', message: 'Claude Code was not found. Install it, then reload the window.', sessionId: sid }); return; }
    bindCell(host, cli, sid, modelId);
    return;
  }
  const cell = boundCell(sid);
  if (!cell) return;
  unbindCell(host, cell, modelId);
  host.redispatch(m);
}

/** Kill every child. Called from the extension's deactivate — a passthrough
 *  child must never outlive the window that spawned it. */
export function disposeClaudeCodeSessions(): void {
  disposeAllCells();
}

/** Test seam: the module-level map is deliberate (see claudeCodeCell.ts), so a
 *  test needs a way back to a clean slate. */
export function __resetClaudeCodeForTests(): void {
  disposeAllCells();
  __resetMirrorForTests();
  resetClaudeCliCache();
}
