// claudeCodeCells.ts — WHICH chat cells Claude Code is currently driving.
//
// A registry with four readers (tab gates, model picker, echo detection).
// Module-level by design: the panel is a singleton and a child outlives any
// one message handler, though every field of every entry is per-cell.

import type { ClaudeCodeDriver } from '../claudeCode/driver';
import type { TranslatorState } from '../claudeCode/translator';
import type { PassthroughMode, ToolPermissionAsk } from '../claudeCode/protocol';

/** Chat-cell kind. Engine chats send no kind at all, so `undefined` is the
 *  engine path and nothing existing has to change to keep working. */
export const PASSTHROUGH_KIND = 'claude';

export interface BoundCell {
  id: string;
  cwd: string;
  /** The `claude-code/<alias>` this cell is bound to — what the picker ticks. */
  model: string;
  driver: ClaudeCodeDriver;
  state: TranslatorState;
  /** requestId → the ask still on screen. The webview answers by toolCallId,
   *  and we use the CLI's request id AS the toolCallId, so this is a 1:1 map
   *  that also proves an answer was solicited. */
  asks: Map<string, ToolPermissionAsk>;
  /** Tools the user chose "always allow" for. SESSION-scoped and in memory:
   *  Phase 1 deliberately persists no permission rule. */
  alwaysAllow: Set<string>;
  mode: PassthroughMode;
  /** The mode to restore when a plan is APPROVED — the one the cell held when
   *  Plan was switched on. Undefined whenever plan mode is not active. Kept so
   *  approving a plan hands back exactly the supervision the user had, rather
   *  than a hardcoded default that could quietly widen or narrow it. */
  planReturnMode?: PassthroughMode;
  /** The chat has been named after a user line already. Set on the FIRST send,
   *  so a later message cannot rename a chat the user has been reading. */
  titled?: boolean;
  /** The bypass clamp has been explained in this chat already. The webview posts
   *  `setApproveMode: bypass` from the YOLO button on EVERY permission bar, so without this the
   *  same paragraph landed once per ask. */
  bypassNoticed?: boolean;
}

const cells = new Map<string, BoundCell>();

export function boundCell(sessionId: string): BoundCell | undefined {
  return cells.get(sessionId);
}

export function registerCell(cell: BoundCell): void {
  cells.set(cell.id, cell);
}

export function dropCell(sessionId: string): void {
  cells.delete(sessionId);
}

/** Every bound cell's id, as a snapshot — the caller may unbind while iterating. */
export function boundCellIds(): string[] {
  return [...cells.keys()];
}

/** The kind a cell currently carries — `replaySessionsTo` re-announces it, so a
 *  tab reopened over a bound cell comes back with its gates still applied. */
export function claudeCodeKind(sessionId: string): string | undefined {
  return cells.has(sessionId) ? PASSTHROUGH_KIND : undefined;
}

/** The model a bound cell runs, for `sessionModels` — without this the picker
 *  would tick the ENGINE's model on a cell the CLI is driving. */
export function claudeCodeModelOf(sessionId: string): string | undefined {
  return cells.get(sessionId)?.model;
}

/**
 * Is an ENGINE session update for this cell an ECHO of our own mirror?
 *
 * A bound cell copies each finished turn into its own engine session
 * (claudeCodeMirror.ts) via `Session.updateMessage`/`updatePart`, which
 * publish — so the mirrored write comes straight back out as an ACP update
 * and would draw the same card twice. A bound cell never runs an engine turn
 * directly, so suppressing its own engine updates is lossless; an unbound
 * cell is untouched.
 */
export function isEngineEchoOnBoundCell(sessionId: string): boolean {
  return cells.has(sessionId);
}

/** Kill every child. Called from the extension's deactivate — a passthrough
 *  child must never outlive the window that spawned it. */
export function disposeAllCells(): void {
  for (const c of cells.values()) c.driver.dispose();
  cells.clear();
}
