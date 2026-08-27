// Agent Manager S5.2 — the pure auto-approve decision + allow-option picker that
// keeps a BACKGROUND agent's permission ask from hanging on a surface nobody can
// answer. The DashboardPanel handler is thin wiring over these; testing them
// pure asserts the decision (who gets auto-allowed) and the picked option (which
// consent the engine receives) without a full panel/host harness.

import { describe, it, expect } from 'vitest';
import {
  decidePermission,
  pickAllowOption,
  autoApproveNote,
  type PermOption,
} from '../../../src/dashboard/agentManager/permissions';

// A realistic engine permission-option set (packages/engine/src/acp/permission.ts:
// allow_once / allow_always / reject_once) — the very shape that arrives at
// onPermissionRequest for the proven external_directory ask.
const ENGINE_OPTIONS: PermOption[] = [
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

describe('S5.2 auto-approve decision', () => {
  // q1 — a background agent session with the toggle ON is auto-allowed, and the
  // option handed back to the engine is the allow-once (the same positive consent
  // the webview's approve path selects), NOT a reject and NOT null.
  it('q1 agent + ON -> auto-allow answered with the allow-once option', () => {
    expect(decidePermission('agent', true)).toBe('auto-allow');
    const picked = pickAllowOption(ENGINE_OPTIONS);
    expect(picked).toBe('once');
    // and the option picked is a genuinely permissive one, never a reject
    expect(ENGINE_OPTIONS.find((o) => o.optionId === picked)!.kind.startsWith('reject')).toBe(false);
  });

  // q2 — toggle OFF: even an agent session is forwarded unchanged (may hang; the
  // user's explicit choice), so the handler must NOT intercept.
  it('q2 agent + OFF -> forward (no interception)', () => {
    expect(decidePermission('agent', false)).toBe('forward');
  });

  // q3 — a chat session is NEVER auto-approved regardless of the setting: the
  // user is present to answer, and silently consenting on their behalf is wrong.
  it('q3 chat session -> forward whether the setting is ON or OFF', () => {
    expect(decidePermission('chat', true)).toBe('forward');
    expect(decidePermission('chat', false)).toBe('forward');
    expect(decidePermission(undefined, true)).toBe('forward'); // unset kind == a chat
  });

  it('picks allow_always when no allow_once is offered', () => {
    expect(pickAllowOption([
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ])).toBe('always');
  });

  it('returns null when the request carries no permissive option (caller forwards)', () => {
    expect(pickAllowOption([
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      { optionId: 'never', name: 'Never', kind: 'reject_always' },
    ])).toBeNull();
  });

  it('note carries the tool title + target so Chat shows what was consented to', () => {
    expect(autoApproveNote('read_file — /repo/parent/secret.txt'))
      .toBe('⚙ auto-approved permission: read_file — /repo/parent/secret.txt');
    expect(autoApproveNote('  ')).toBe('⚙ auto-approved permission');
  });
});
