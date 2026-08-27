// modelBanner — the three things `ok: false` can mean, and the one the
// composer used to get wrong.
//
// A remote provider that has not been probed yet reports ok:false with the
// reason `Checking provider…`, and the same broadcast kicks the probe that
// settles it. Drawing "unreachable — check the server" for that is a lie a user
// acts on: they go and restart a Spark that was never down.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_PROBING, bannerState, probingText } from './modelBanner';

describe('modelBanner — which banner an ok:false status has earned', () => {
  it('an online model has no banner at all', () => {
    expect(bannerState(true, '', true)).toBe('ok');
    // ...even if a stale reason is still hanging around from before it came up.
    expect(bannerState(true, PROVIDER_PROBING, false)).toBe('ok');
  });

  it('the unprobed sentinel is PROBING, never unreachable', () => {
    expect(bannerState(false, PROVIDER_PROBING, false)).toBe('probing');
  });

  it('a CONFIRMED failed probe is still unreachable — the alarm is not softened', () => {
    // This is the regression the fix could easily introduce: silencing the real
    // failure along with the false one. A provider that answered "no" must keep
    // saying so.
    expect(bannerState(false, 'ECONNREFUSED 100.64.1.20:8000', false)).toBe('offline-remote');
    expect(bannerState(false, 'Provider unreachable', false)).toBe('offline-remote');
  });

  it('a local provider with no model is its own state, not the remote one', () => {
    expect(bannerState(false, 'no model loaded', true)).toBe('offline-local');
    // No status at all yet (boot, or an older host that sends no reason).
    expect(bannerState(false, '', true)).toBe('offline-local');
  });

  it('probing wins over the local/remote split for EITHER kind of provider', () => {
    // The sentinel is remote-only today. If a local probe ever reports it, "we
    // have not asked yet" still must not render as "it is down".
    expect(bannerState(false, PROVIDER_PROBING, true)).toBe('probing');
  });

  it('tolerates the whitespace a wire round trip can add', () => {
    expect(bannerState(false, ` ${PROVIDER_PROBING} `, false)).toBe('probing');
  });
});

describe('modelBanner — what the neutral state says', () => {
  it('names the provider being waited on', () => {
    expect(probingText('Spark')).toBe('Checking Spark…');
  });

  it('stays a whole sentence when the provider has no label yet', () => {
    // The status can arrive before the provider list does. "Checking …" with a
    // hole in it reads as a rendering bug, which is its own kind of alarm.
    expect(probingText('')).toBe('Checking the provider…');
    expect(probingText('   ')).toBe('Checking the provider…');
  });
});

describe('modelBanner — the mirrored sentinel cannot drift', () => {
  // PROVIDER_PROBING is a COPY: tsconfig.webview.json pins rootDir to webview/,
  // so this module cannot import the host's constant. A copy with no guard is a
  // fix that silently stops working the day someone rewords the host string —
  // and the symptom would be the exact bug this file exists to prevent, back
  // again, with all these tests still green.
  it('DashboardPanel still emits the literal this module matches on', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const panel = readFileSync(
      path.join(here, '..', '..', '..', 'src', 'dashboard', 'DashboardPanel.ts'), 'utf8',
    );
    expect(panel).toContain(`'${PROVIDER_PROBING}'`);
  });
});
