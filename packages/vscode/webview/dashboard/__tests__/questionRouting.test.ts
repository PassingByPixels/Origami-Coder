// Agent Manager S7.1 — the pure discriminator + routing leaves (questionRouting.ts)
// that keep a background agent's QUESTION from being AUTO-ANSWERED. Every question
// (ask_user_question AND plan_exit) reaches the client as a standard
// requestPermission ask (the engine emits no origami/question); a real permission
// always carries an allow_always option, a question never does. Testing these pure
// asserts the decision (who gets buffered vs auto-decided) without a panel harness —
// the same pattern S5.2/S7 used (agentPermissions/attention). The RED-CHECK at the
// bottom pins the never-auto-answer property against the pre-S7.1 seam composition.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isQuestionShaped,
  shouldBufferQuestion,
  questionReplayAction,
} from '../../../src/dashboard/agentManager/questionRouting';
import { resolvePermission } from '../../../src/dashboard/agentManager/attention';
import { decideAgentPermission } from '../../../src/dashboard/agentManager/permScope';

// A model ask_user_question surfaced as a permission ask (acp/question.ts): one
// PermissionOption per choice, optionId = String(index), kind = index===0 ?
// 'allow_once' : 'reject_once', title = the question. NO allow_always anywhere.
const QUESTION_OPTIONS = [
  { optionId: '0', name: 'Rebuild from scratch', kind: 'allow_once' },
  { optionId: '1', name: 'Patch in place', kind: 'reject_once' },
];
// A single-choice question (still question-shaped — no allow_always).
const ONE_OPTION_QUESTION = [{ optionId: '0', name: 'Continue', kind: 'allow_once' }];
// The fixed real-permission triple (acp/permission.ts) — the ONLY shape carrying allow_always.
const REAL_PERMISSION = [
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

describe('isQuestionShaped — the allow_always-absence discriminator (both directions)', () => {
  it('is TRUE for a multi-choice question (no allow_always option)', () => {
    expect(isQuestionShaped(QUESTION_OPTIONS)).toBe(true);
  });
  it('is TRUE for a one-option question', () => {
    expect(isQuestionShaped(ONE_OPTION_QUESTION)).toBe(true);
  });
  it('is FALSE for the fixed real-permission triple (allow_always present)', () => {
    expect(isQuestionShaped(REAL_PERMISSION)).toBe(false);
  });
  it('is TRUE for an empty option list (degenerate, still not a real permission)', () => {
    expect(isQuestionShaped([])).toBe(true);
  });
});

describe('shouldBufferQuestion — only a background agent QUESTION with no view mounted buffers', () => {
  it('agent + unmounted + question -> BUFFER (never auto-answer)', () => {
    expect(shouldBufferQuestion('agent', false, QUESTION_OPTIONS)).toBe(true);
  });
  it('agent + MOUNTED + question -> false (forwards to the visible view instead)', () => {
    expect(shouldBufferQuestion('agent', true, QUESTION_OPTIONS)).toBe(false);
  });
  it('agent + unmounted + REAL permission -> false (keeps the S6e auto path)', () => {
    expect(shouldBufferQuestion('agent', false, REAL_PERMISSION)).toBe(false);
  });
  it('chat / unset kind + unmounted + question -> false (chat always forwards)', () => {
    expect(shouldBufferQuestion('chat', false, QUESTION_OPTIONS)).toBe(false);
    expect(shouldBufferQuestion(undefined, false, QUESTION_OPTIONS)).toBe(false);
  });
});

describe('questionReplayAction — the turnBusy replay gate on mount', () => {
  it('POSTS a buffered question while the turn is live', () => {
    expect(questionReplayAction(true, true)).toBe('post');
  });
  it('DROPS a buffered question whose turn already ended (caller drains its respond)', () => {
    expect(questionReplayAction(true, false)).toBe('drop');
  });
  it('is NONE when nothing is buffered (regardless of turn state)', () => {
    expect(questionReplayAction(false, true)).toBe('none');
    expect(questionReplayAction(false, false)).toBe('none');
  });
});

// RED-CHECK — the S7.1 incident modelled against the REAL pre-S7.1 seam composition
// (resolvePermission + decideAgentPermission, both imported, not re-implemented). The
// old seam AUTO-ANSWERED an agent question; the new guard diverts it before that path.
describe('never-auto-answer — pre-S7.1 seam vs S7.1 guard', () => {
  it('the pre-S7.1 composition WOULD auto-answer an agent question with choice #1 (the incident)', () => {
    // agent + toggle ON + unmounted: decideAgentPermission runs, sees no out-of-repo
    // path, and pickAllowOption returns the question's FIRST option — answering it.
    const old = resolvePermission(
      false, // unmounted
      () => decideAgentPermission('agent', true, '/repo', QUESTION_OPTIONS, undefined, {}, 'Rebuild or patch?'),
    );
    expect(old.action).toBe('auto-allow');
    expect((old as { optionId?: string }).optionId).toBe('0'); // <- the misfire this ticket fixes
  });
  it('S7.1 intercepts that exact case BEFORE the auto-decision (buffers, never answers)', () => {
    expect(shouldBufferQuestion('agent', false, QUESTION_OPTIONS)).toBe(true);
  });
  it('a REAL permission in the same state is UNTOUCHED — still auto-allowed in-repo', () => {
    expect(shouldBufferQuestion('agent', false, REAL_PERMISSION)).toBe(false);
    const d = resolvePermission(false, () => decideAgentPermission('agent', true, '/repo', REAL_PERMISSION, undefined, {}, 'edit'));
    expect(d.action).toBe('auto-allow');
    expect((d as { optionId?: string }).optionId).toBe('once');
  });
});

// The pure leaves above can't see DashboardPanel's onPermissionRequest/bufferAgentQuestion/
// replaySessionsTo GLUE — the 79-line diff that actually threads them. That closure needs a full
// extension host to instantiate, so (as sidebar-chat-view.test.ts does for the addSession/
// resolveSharedView glue) these guard the wiring at the SOURCE level. NOT echoes: each asserts an
// ORDERING or PRESENCE invariant a plausible bad refactor breaks, and each maps to a named regression
// (a reordered set / a dropped return / a wrong buffer arg / an unwired lifecycle edge).
describe('DashboardPanel S7.1 wiring — source guards for the untestable glue', () => {
  const src = readFileSync(
    join(__dirname, '..', '..', '..', 'src', 'dashboard', 'DashboardPanel.ts'),
    'utf-8',
  );

  it('stores respond BEFORE the buffer decision (a reorder would leave the buffered question with no respond to resolve)', () => {
    expect(src).toMatch(/pendingPermissions\.set\(toolCallId, respond\);[\s\S]*?shouldBufferQuestion\(session\.kind, mounted, options\)/);
  });

  it('the buffer guard runs BEFORE the S6e auto-decision and early-RETURNS (a dropped return lets a question be auto-answered too)', () => {
    expect(src).toMatch(/shouldBufferQuestion\(session\.kind, mounted, options\)[\s\S]*?return;[\s\S]*?resolvePermission\(mounted,/);
    expect(src).toMatch(/bufferAgentQuestion\([^)]*\);\s*return;/);
  });

  it('buffers with the ASK\'s real options/kind, not a wrong shape (a mis-passed arg would replay a garbled modal)', () => {
    expect(src).toMatch(/bufferAgentQuestion\(session, sessionId, toolCallId, title, kind, target, options\)/);
  });

  it('engine death (onClose AND onError) drops the buffer, drains the orphaned respond, and clears the chip', () => {
    expect(src).toMatch(/onClose: \(reason\) =>[^\n]*pendingQuestionPermissions\.delete\(sessionId\)[^\n]*drainPermissions\(session\.pendingPermissions\)[^\n]*setAgentQuestion\(sessionId, null\)/);
    expect(src).toMatch(/onError: \(message\) =>[^\n]*pendingQuestionPermissions\.delete\(sessionId\)[^\n]*drainPermissions\(session\.pendingPermissions\)[^\n]*setAgentQuestion\(sessionId, null\)/);
  });

  it('the replay POST branch re-posts the ask AND opens its plan_exit/dream preview (parity with the live-forward path)', () => {
    expect(src).toMatch(/qpAct === 'post'[^\n]*type: 'requestPermission'[^\n]*options: qp!\.options[^\n]*openPermissionPreview\(session, qp!\.title\)/);
  });

  it('entering sidebar grid mode replays each session\'s buffered question (else the grid cell looks live but shows no modal)', () => {
    expect(src).toMatch(/m\.type === 'chatGridMode'[^\n]*replayBufferedQuestionFor/);
  });
});
