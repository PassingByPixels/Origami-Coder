// The rule these two functions carry: a turn that did NOT reach done must not
// read as though it did. Inline in ChatPane.svelte this could only be checked
// by driving a whole `origami/turnEnd` message through a rendered pane, which
// is why nothing checked it.
//
// The sharp case is the DEFAULT branch. A future engine adding a stop_reason
// this build has never seen must land on `unknown` — silently promoting it to
// `done` would show "Verified done" on a turn nobody verified, which is exactly
// the lie the arbiter-chip upgrade in ChatPane exists to correct.

import { describe, expect, it } from 'vitest';
import { verdictForStopReason, verdictLabel } from './turnVerdict';

describe('verdictForStopReason — only `success` is verified-done', () => {
  it('maps success to done', () => {
    expect(verdictForStopReason('success')).toEqual({ kind: 'done', reason: 'success' });
  });

  it('maps asked_user to parked — the turn stopped ON a question, it did not fail', () => {
    expect(verdictForStopReason('asked_user')).toEqual({ kind: 'parked', reason: 'asked_user' });
  });

  it.each([
    'error_max_turns',
    'error_max_budget',
    'error_no_progress',
    'error_during_execution',
    'park_infra',
  ])('maps %s to incomplete', (reason) => {
    expect(verdictForStopReason(reason)).toEqual({ kind: 'incomplete', reason });
  });

  // The defect class this whole module guards: a benign-looking default.
  it('leaves an UNRECOGNISED label unknown rather than promoting it', () => {
    expect(verdictForStopReason('error_some_future_taxonomy').kind).toBe('unknown');
    expect(verdictForStopReason('finished').kind).toBe('unknown');
  });

  it('leaves a missing label unknown, and keeps it empty rather than inventing one', () => {
    expect(verdictForStopReason('')).toEqual({ kind: 'unknown', reason: '' });
  });

  it('carries the raw wire label through verbatim on every branch', () => {
    for (const r of ['success', 'asked_user', 'park_infra', 'who_knows']) {
      expect(verdictForStopReason(r).reason).toBe(r);
    }
  });
});

describe('verdictLabel — what the transcript row says', () => {
  it('names the failure taxonomy for an incomplete turn, so the row is diagnosable', () => {
    expect(verdictLabel({ kind: 'incomplete', reason: 'error_max_budget' }))
      .toBe('Incomplete: error_max_budget');
  });

  it('says done only for done, and never names a reason there', () => {
    expect(verdictLabel({ kind: 'done', reason: 'success' })).toBe('Verified done');
  });

  it('says what a parked turn is waiting for', () => {
    expect(verdictLabel({ kind: 'parked', reason: 'asked_user' }))
      .toBe('Parked: awaiting your answer');
  });

  it('reports an unknown terminal as merely ENDED — never as done', () => {
    expect(verdictLabel({ kind: 'unknown', reason: 'weird_reason' })).toBe('Ended: weird_reason');
    expect(verdictLabel({ kind: 'unknown', reason: '' })).toBe('Ended');
  });
});
