// Recall a user's "always allow" decisions across engine restarts: the engine's
// allow-always ruleset lives in memory and is wiped on every engine child, so this is the
// shell-side replay — capture the allow_always at the reply seam and pre-approve a matching
// later CHAT ask before the UI sees it. The engine forwards only the ask's
// title/rawInput/fixed option triple, never its patterns, so a recorded rule is keyed on the
// CONCRETE approved target and matched by LITERAL equality (never a match-time wildcard) —
// strictly narrower than the engine's own broadening, never broader than what was consented.
// Scoped per-workspace.

import type { Memento } from 'vscode';
import type { PermDecision } from './permScope';
import type { PermOption } from './permissions';
import { isQuestionShaped } from './questionRouting';

/** One recalled allow rule. `action` is always allow (we only ever store
 *  positive consent); a rule matches an ask by literal equality on BOTH fields. */
export interface PersistedRule { permission: string; pattern: string }

const RULES_KEY = 'origami.persistentPermissions';

/** The ground-truth target of a permission ask (path/dir/url/command) — what the bar shows
 *  and what a recalled rule is keyed on, kept in lockstep. */
export function permissionTarget(
  locations: ReadonlyArray<{ path?: string }> | undefined,
  rawInput: unknown,
): string | undefined {
  const loc = locations?.find((l) => !!l.path)?.path;
  if (loc) return loc;
  if (rawInput && typeof rawInput === 'object') {
    const r = rawInput as Record<string, unknown>;
    for (const key of ['filepath', 'path', 'file', 'parentDir', 'directory', 'url', 'command', 'pattern']) {
      const v = r[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
  }
  return undefined;
}

/** Fold a target/permission the way the engine folds a NON-wildcard token before
 *  comparison: backslashes to forward slashes, case-folded on win32. */
function foldToken(s: string, win: boolean): string {
  const n = s.replaceAll('\\', '/');
  return win ? n.toLowerCase() : n;
}

/** A recorded rule is keyed on the exact approved value; any '*'/'?' the user typed is
 *  LITERAL text — never a match-time wildcard, which would silently pre-approve a materially
 *  different command. Separator- and (win32) case-insensitive only, mirroring the engine's
 *  own token folding. */
export function targetMatches(input: string, pattern: string, win = process.platform === 'win32'): boolean {
  return foldToken(input, win) === foldToken(pattern, win);
}

/** Does any stored rule pre-approve this ask? Never returns/decides a denial. */
export function ruleMatches(
  askPermission: string,
  askTarget: string,
  rules: readonly PersistedRule[],
  win = process.platform === 'win32',
): boolean {
  if (!askTarget) return false;
  return rules.some((r) => targetMatches(askPermission, r.permission, win) && targetMatches(askTarget, r.pattern, win));
}

/** Append a rule unless an identical (permission, pattern) pair is already
 *  stored. Returns a NEW array (never mutates the input). */
export function addRule(rules: readonly PersistedRule[], permission: string, pattern: string): PersistedRule[] {
  if (rules.some((r) => r.permission === permission && r.pattern === pattern)) return [...rules];
  return [...rules, { permission, pattern }];
}

/** The optionId whose kind is allow_always, else null. The reply seam only
 *  carries the chosen optionId, so we resolve the "always" option id up front. */
export function alwaysOptionId(options: ReadonlyArray<PermOption>): string | null {
  const opt = options.find((o) => o.kind === 'allow_always');
  return opt ? opt.optionId : null;
}

/** The pure REPLAY decision for one incoming ask: auto-allow with allow_ONCE only (least
 *  privilege, never re-records), else null (forward to UI). Guards: chat ask only (not a
 *  board agent), never a question-shaped ask, empty target never matches, and a stored rule
 *  plus an allow_once option must both exist. */
export function replayDecision(
  kind: 'chat' | 'agent' | undefined,
  options: ReadonlyArray<PermOption>,
  permission: string,
  target: string,
  rules: readonly PersistedRule[],
  win = process.platform === 'win32',
): PermDecision | null {
  if (kind === 'agent') return null;
  if (isQuestionShaped(options)) return null;
  if (!ruleMatches(permission, target, rules, win)) return null;
  const once = options.find((o) => o.kind === 'allow_once');
  if (!once) return null;
  const detail = [permission, target].filter(Boolean).join(' — ');
  return { action: 'auto-allow', optionId: once.optionId, note: `⚙ auto-allowed (remembered): ${detail}` };
}

export function loadPersistentPermissions(memento: Memento): PersistedRule[] {
  const v = memento.get<PersistedRule[]>(RULES_KEY);
  return Array.isArray(v)
    ? v.filter((r) => r && typeof r.permission === 'string' && typeof r.pattern === 'string')
    : [];
}

export function savePersistentPermissions(memento: Memento, rules: readonly PersistedRule[]): void {
  void memento.update(RULES_KEY, [...rules]);
}

/** Clear every recalled rule (the `Origami: Reset saved permissions` command). */
export function resetPersistentPermissions(memento: Memento): void {
  void memento.update(RULES_KEY, []);
}

// Reply-seam glue: the ask forwards to the UI and the reply comes back later, keyed only by
// toolCallId, so stash what recording needs at forward time.
interface Pending { permission: string; pattern: string; alwaysId: string }
const pending = new Map<string, Pending>();

/** At forward time: remember a chat ask that could be persisted (a concrete target and an
 *  allow_always option); agent asks and target-less asks are skipped. */
export function notePersistablePermission(
  kind: 'chat' | 'agent' | undefined,
  toolCallId: string,
  permission: string,
  target: string | undefined,
  options: ReadonlyArray<PermOption>,
): void {
  if (kind === 'agent' || !target) return;
  const alwaysId = alwaysOptionId(options);
  if (!alwaysId) return;
  pending.set(toolCallId, { permission, pattern: target, alwaysId });
}

/** At reply time: if the user picked allow_always for a noted ask, persist its rule; always
 *  consumes the stash for this toolCallId. */
export function commitPersistablePermission(memento: Memento, toolCallId: string, chosenOptionId: string | null): boolean {
  const p = pending.get(toolCallId);
  pending.delete(toolCallId);
  if (!p || chosenOptionId !== p.alwaysId) return false;
  savePersistentPermissions(memento, addRule(loadPersistentPermissions(memento), p.permission, p.pattern));
  return true;
}
