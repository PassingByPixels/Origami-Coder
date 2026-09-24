// changelogGate.test.ts — the pure "show What's new or not" decision
// (src/dashboard/changelogGate.ts, t-obg1yz, t-v5r1fd). Plain strings, no fakes.

import { describe, expect, it } from 'vitest';
import { compareVersions, previewRange, whatsNewRange } from '../../../src/dashboard/changelogGate';

const PUBLIC = ['0.4.151', '0.4.155', '0.4.174'];

describe('whatsNewRange', () => {
  it('a dev build (not in the public list) shows nothing, whatever the marker says', () => {
    expect(whatsNewRange('0.4.155', '0.4.173', PUBLIC)).toBeUndefined();
    expect(whatsNewRange(undefined, '0.4.160', PUBLIC)).toBeUndefined();
  });

  it('a public release covers everything since the last version the user saw', () => {
    expect(whatsNewRange('0.4.155', '0.4.174', PUBLIC)).toEqual({ from: '0.4.155', to: '0.4.174' });
    // A user who skipped a public release still counts from what they last saw.
    expect(whatsNewRange('0.4.151', '0.4.174', PUBLIC)).toEqual({ from: '0.4.151', to: '0.4.174' });
  });

  it('the owner box, last on a dev build, counts from that dev build', () => {
    expect(whatsNewRange('0.4.173', '0.4.174', PUBLIC)).toEqual({ from: '0.4.173', to: '0.4.174' });
  });

  it('a fresh install counts from the previous public release (this release only)', () => {
    expect(whatsNewRange(undefined, '0.4.174', PUBLIC)).toEqual({ from: '0.4.155', to: '0.4.174' });
    expect(whatsNewRange(undefined, '0.4.151', PUBLIC)).toEqual({ from: undefined, to: '0.4.151' });
  });

  it('shows nothing once seen, or after a rollback to an older version', () => {
    expect(whatsNewRange('0.4.174', '0.4.174', PUBLIC)).toBeUndefined();
    expect(whatsNewRange('0.4.174', '0.4.155', PUBLIC)).toBeUndefined();
  });
});

describe('previewRange', () => {
  it('shows a pending dev version from the last public release', () => {
    expect(previewRange('0.4.173', ['0.4.155'])).toEqual({ from: '0.4.155', to: '0.4.173' });
  });
});

describe('compareVersions', () => {
  it('compares numerically per part, not as text', () => {
    expect(compareVersions('0.4.5', '0.4.155')).toBeLessThan(0);
    expect(compareVersions('0.4.174', '0.4.155')).toBeGreaterThan(0);
    expect(compareVersions('0.5.0', '0.4.999')).toBeGreaterThan(0);
    expect(compareVersions('0.4.155', '0.4.155')).toBe(0);
  });
});
