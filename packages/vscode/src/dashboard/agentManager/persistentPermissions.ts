// persistentPermissions.ts — recall a user's "always allow" decisions across
// engine restarts. The engine keeps allow-always rules in an IN-MEMORY approved
// ruleset (packages/engine/src/permission/index.ts:36/156) that is WIPED on
// every engine child (new window / respawn). This is the SHELL-side replay:
// capture the user's allow_always at the reply seam and pre-approve a matching
// later CHAT ask before the UI ever sees it.
//
// Faithfulness bound: the engine forwards to the client ONLY the ask's title
// (= the permission), rawInput (= metadata) and the fixed option triple — NOT
// its `patterns`/`always` (acp/permission.ts:65-81). The engine broadens a
// shell `always` to `<prefix> *` (shell.ts:409); the client can't see that. So
// a recorded rule is keyed on the CONCRETE approved target (the bar's own text)
// and matched by LITERAL equality — any glob the user typed (`dist/*`) is
// literal text, never a match-time wildcard. STRICTLY NARROWER than the engine
// (a later DIFFERENT command always re-prompts) — never-broader-than-consented.
//
// Scope: per-WORKSPACE (a workspaceState Memento) so always-allow-X in one repo
// never silently applies in another. Pure matcher + memento glue; the thin
// DashboardPanel wiring only threads asks/replies through these.

import type { Memento } from 'vscode';
import type { PermDecision } from './permScope';
import type { PermOption } from './permissions';
import { isQuestionShaped } from './questionRouting';

/** One recalled allow rule. `action` is always allow (we only ever store
 *  positive consent); a rule matches an ask by literal equality on BOTH fields. */
export interface PersistedRule { permission: string; pattern: string }

const RULES_KEY = 'origami.persistentPermissions';

/** The ground-truth target of a permission ask (path / dir / url / command) — an
 *  ACP file location first, else the first path-ish rawInput key. This is what
 *  the permission bar shows AND what a recalled rule is keyed on, so both stay in
 *  lockstep. (Extracted verbatim from onPermissionRequest's inline derivation.) */
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

/** A recorded rule is keyed on a CONCRETE approved value (the exact command /
 *  path the permission bar showed), so it pre-approves a later ask ONLY when the
 *  ask's value is IDENTICAL. Any '*'/'?' the user typed is LITERAL text here —
 *  never a match-time wildcard, which would silently pre-approve a materially
 *  different command (`dist/*` -> `dist/ && curl … | bash`). Separator- and
 *  (win32) case-insensitive only, mirroring the engine's own token folding. */
export function targetMatches(input: string, pattern: string, win = process.platform === 'win32'): boolean {
  return foldToken(input, win) === foldToken(pattern, win);
}

/** Does any stored rule pre-approve this ask? The ask's (permission, target) is
 *  the concrete input; each rule's fields are the recorded literals it must
 *  equal. Never returns/decides a denial. */
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

/** The pure REPLAY decision for one incoming ask. Returns a PermDecision only to
 *  AUTO-ALLOW (with the allow_ONCE option — least privilege, never re-records),
 *  else null (forward to the UI). Guards, in order:
 *   - only a CHAT ask (kind !== 'agent'); board-agent asks keep their own path;
 *   - a QUESTION-shaped ask (no allow_always) is NEVER pre-approved;
 *   - an empty target never matches;
 *   - a stored rule must match; and an allow_once option must exist to answer with. */
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

// --- reply-seam glue: the ask forwards to the UI, the reply comes back later ---
// keyed only by toolCallId, so stash the little that recording needs at forward
// time and consume it at reply time.
interface Pending { permission: string; pattern: string; alwaysId: string }
const pending = new Map<string, Pending>();

/** At forward time: remember a CHAT ask that COULD be persisted (has a concrete
 *  target AND an allow_always option). Agent asks and target-less asks are
 *  skipped — nothing meaningful/safe to record. */
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

/** At reply time: if the user picked the allow_always option for a noted ask,
 *  persist its rule. Returns true iff a rule was recorded. Always consumes the
 *  stash for this toolCallId. */
export function commitPersistablePermission(memento: Memento, toolCallId: string, chosenOptionId: string | null): boolean {
  const p = pending.get(toolCallId);
  pending.delete(toolCallId);
  if (!p || chosenOptionId !== p.alwaysId) return false;
  savePersistentPermissions(memento, addRule(loadPersistentPermissions(memento), p.permission, p.pattern));
  return true;
}
