// claudeCodeCell.ts — ONE chat cell while Claude Code is driving it: the
// child, the pending asks, and the two flips that start and end the binding.
//
// A passthrough binds a real engine session id (rather than minting its own),
// so it keeps its tab, transcript, replay and engine session across a flip —
// the engine session is never destroyed by a flip.

import { ClaudeCodeDriver, type SpawnChild } from '../claudeCode/driver';
import type { ClaudeCliInfo, DiscoveryResult } from '../claudeCode/discovery';
import {
  CRASHED_TOOL_NOTE, newTranslatorState, settleOpenTools, toolTitle, translate,
  type TranslatorState,
} from '../claudeCode/translator';
import { settleBackgroundAgents } from '../claudeCode/subagentClose';
import { exitMessage } from '../claudeCode/childFailure';
import { originClause } from '../claudeCode/sessionFacts';
import { claudeCodeAlias } from '../claudeCode/models';
import { PASSTHROUGH_KIND, boundCell, dropCell, registerCell, type BoundCell } from './claudeCodeCells';
import { refreshPlanUsage, type PlanUsageHost } from './claudeCodePill';
import { emit, resetMirror } from './claudeCodeLog';
import { postPermissionAsk } from './claudeCodePermissions';
import type { MirrorHost } from './claudeCodeMirror';
import { rememberResume, resumeIdFor, type ResumeIO } from './claudeCodeResume';
import type { SessionMessage } from './sessionLog';

// The permission round trip moved out at 256/235 — see claudeCodePermissions.ts
// for why the plan card made it a second job. Re-exported so the manager's
// import path is unchanged.
export { answerPermission } from './claudeCodePermissions';

// The REGISTRY — which cells are bound, and the shape of one — moved out at
// 333/235 in the adversarial round; claudeCodeCells.ts says why. Re-exported so
// every existing importer of this module still resolves.
export {
  PASSTHROUGH_KIND, boundCell, claudeCodeKind, claudeCodeModelOf, disposeAllCells,
  isEngineEchoOnBoundCell, type BoundCell,
} from './claudeCodeCells';

// The headroom badge's account read left at 256/235 — claudeCodePill.ts says
// why a network call is a second job. Re-exported for the same reason.
export { refreshAllPlanUsage, refreshPlanUsage, type PlanUsageHost } from './claudeCodePill';

export interface ClaudeCodeHost extends MirrorHost, ResumeIO, PlanUsageHost {
  post(msg: Record<string, unknown>): void;
  /** The workspace folder a new passthrough chat runs in. */
  cwd: string;
    /** Every open workspace folder — a History pick's folder is checked
     *  against this before anything spawns in it. */
  folders?(): readonly string[];
    /** Create an ordinary engine chat cell and return its session id — this
     *  is what gives a passthrough a surface. */
  createCell(): Promise<string>;
  /** Hand a message back to the panel's normal dispatch. Every caller unbinds
   *  FIRST, so `claudeCodeOwns` is already false and this cannot re-enter. */
  redispatch(m: Record<string, unknown>): void;
    /** `origami.claudeCode.slashSkills`. Absent means ON, the setting's own default. */
  slashSkills?(): boolean;
    /** Re-run the panel's `sessionModels` broadcast right after a bind lands,
     *  so the model picker's label doesn't lag. */
  refreshModels?(): void;
  /** This cell's REPLAY log — the same `Session.messageLog` a tab reattach is
   *  caught up from. `undefined` for a cell the panel has forgotten, which is
   *  not an error: a close races the child's last event. See claudeCodeLog.ts. */
  replayLog?(sessionId: string): SessionMessage[] | undefined;
    /** Test seams. Absent, detection goes through the real probe list and the
     *  driver spawns the real binary. */
  cli?(): Promise<ClaudeCliInfo | null>;
    /** The seam with the PROBE TRAIL attached, for the status message; overrides `cli`. */
  discovery?(): Promise<DiscoveryResult>;
  spawn?: SpawnChild;
  timeoutMs?: number;
}

/**
 * Bind (or re-point) one chat cell to a Claude Code child.
 *
 * Re-pointing parks the child and respawns it resumed on the next prompt,
 * since the CLI reads `--model` only at spawn.
 */
export function bindCell(host: ClaudeCodeHost, cli: ClaudeCliInfo, id: string, modelValue: string): void {
  if (!id) return;
  const alias = claudeCodeAlias(modelValue);
  const already = boundCell(id);
  if (already) {
    already.model = modelValue;
    already.driver.applySettings({ model: alias });
    announceBinding(host, id, modelValue);
    return;
  }
  const cwd = host.cwd;
  // THIS cell's parked conversation, or nothing. claudeCodeResume.ts has the rules.
  const resumeSessionId = resumeIdFor(host, id, cwd);
  // The handlers resolve the cell through the map rather than closing over it,
  // so there is no half-built record and no cast: the driver exists before the
  // cell does, and every callback fires later than both.
  const live = () => boundCell(id);
  const driver = new ClaudeCodeDriver(
    {
      binary: cli.binary, cwd, mode: 'supervised',
      ...(alias ? { model: alias } : {}),
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(host.spawn ? { spawn: host.spawn } : {}),
    },
    {
      onEvent: (ev) => {
        const s = live();
        if (!s) return;
        let turnEnded = false;
        for (const post of translate(ev, s.state)) {
          if (post.type === 'turnDone') turnEnded = true;
          emit(host, id, post);
        }
        const adopted = s.state.providerSessionId;
        if (adopted) rememberResume(host, id, cwd, adopted);
        // A turn just moved the plan's headroom. One of the two lazy triggers.
        if (turnEnded) refreshPlanUsage(host, id);
      },
      onPermissionAsk: (ask) => { const s = live(); if (s) postPermissionAsk(host, s, ask); },
      // The CHILD retired an ask (its own timeout, a turn torn down under it). The bar on screen
      // can no longer be answered by anyone, so the chat is TOLD rather than left with a control
      // that silently does nothing - the defect this whole path exists to avoid.
      onPermissionCancel: (requestId) => {
        const s = live();
        const ask = s?.asks.get(requestId);
        s?.asks.delete(requestId);
        emit(host, id, {
          type: 'system', sessionId: id,
          text: `Claude Code withdrew its permission request${ask ? ` for ${toolTitle(ask.toolName, ask.input)}` : ''} before it was answered. Answering it now will do nothing; send the request again if you still want it.`,
        });
      },
      onExit: (reason, expected, info) => {
        if (expected) return;
        const s = live();
        // Every ask that died with the child: keeping them would let a later click record an
        // approval no tool ever received.
        if (s && info) for (const requestId of info.pendingAsks) s.asks.delete(requestId);
        const message = info ? exitMessage(info) : reason;
        // A RESUMED turn is still running, so the row is news rather than a failure - but the
        // cards below are settled either way. The dead child's tool_use ids die with it: a resumed
        // child answers NEW ones, so a card left open here would spin to the end of the session.
        const resumed = info?.recovery === 'resumed';
        emit(host, id, resumed
          ? { type: 'system', sessionId: id, text: message }
          : { type: 'error', message, sessionId: id });
        // A child that died mid-tool leaves its cards open. Settle them BEFORE
        // the turn closes, so a crash is a row that says what happened rather
        // than a spinner nothing will ever stop.
        if (s) for (const post of settleOpenTools(s.state, CRASHED_TOOL_NOTE)) emit(host, id, post);
                // BACKGROUND agents are settled here and nowhere else on this path:
                // the child that would report their completion is gone.
        if (s) for (const post of settleBackgroundAgents(s.state, Date.now())) emit(host, id, post);
        // Through `emit`: the mirror CLOSES a turn on `turnDone`, so a child
        // that died mid-answer still copies what it managed to say. NOT on a resumed exit - that
        // turn is still running, and closing it would strand the answer now on its way.
        if (!resumed) emit(host, id, { type: 'turnDone', stopReason: 'error', sessionId: id });
      },
      onLog: (line) => host.log(line),
    },
  );
  registerCell({
    id, cwd, model: modelValue, driver,
    state: newTranslatorState(id, {
      slashSkills: host.slashSkills?.() !== false,
            // No system post here: it used to duplicate the settings line and
            // couldn't name the model before the child had spoken. sessionFacts.connectedLine
            // carries it now.
      origin: originClause(!!resumeSessionId, cwd),
    }),
    asks: new Map(), alwaysAllow: new Set(), mode: 'supervised',
  });
  announceBinding(host, id, modelValue);
}

/** Hand the cell back to its engine session. The child is killed but its CLI
 *  session id stays in the resume map, so re-binding continues the same
 *  conversation — parked, not discarded. */
export function unbindCell(host: ClaudeCodeHost, cell: BoundCell, nextModel: string): void {
  cell.driver.dispose();
  dropCell(cell.id);
  resetMirror(cell.id); // the next engine turn owns this session; no half-turn is inherited
  host.post({ type: 'sessionKind', sessionId: cell.id, kind: '' });
    // Both passthrough-only readouts are retracted here, not left to decay,
    // so a stale badge or command list doesn't survive the hand-back.
  host.post({ type: 'passthroughMeter', sessionId: cell.id, subscription: false, pillPct: -1, pillResetsAt: 0, pillWindow: '', pillTitle: '', windows: [] });
  host.post({ type: 'passthroughCommands', sessionId: cell.id, commands: [] });
  emit(host, cell.id, { type: 'system', sessionId: cell.id, text: dividerText('', nextModel) });
  // The cell is out of the map now, so this broadcast reports the ENGINE's own
  // model again — the mirror of the bind above, and the reason the picker does
  // not sit on "sonnet" after a hand-back.
  host.refreshModels?.();
}

/** The flip's two posts: the cell's KIND (so the capability gates follow it) and
 *  the divider that says, in the transcript, which harness the next turn runs on. */
function announceBinding(host: ClaudeCodeHost, id: string, modelValue: string): void {
  host.post({ type: 'sessionKind', sessionId: id, kind: PASSTHROUGH_KIND });
    // The picker's label: re-running refreshModels here IS the optimistic
    // update, corrected later by `system/init`'s resolved id if they differ.
  host.refreshModels?.();
  emit(host, id, { type: 'system', sessionId: id, text: dividerText(modelValue, '') });
    // The pill's first lazy trigger, here rather than only in bindCell's
    // fresh-cell branch, so a re-point refreshes it too.
  refreshPlanUsage(host, id);
}

/** The transcript's divider line. Exported for the test that reads it, and
 *  because the wording IS the feature here — the user's only in-chat signal
 *  that the next turn runs somewhere else. */
export function dividerText(bound: string, returned: string): string {
  return bound
    ? `Claude Code passthrough — ${bound}`
    : `Back on the Origami engine${returned ? ` — ${returned}` : ''}. Your Claude Code session is parked, not closed.`;
}
