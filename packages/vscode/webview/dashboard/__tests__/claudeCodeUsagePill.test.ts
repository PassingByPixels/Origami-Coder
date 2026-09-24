// claudeCodeUsagePill.test.ts — the plan-headroom readout, and the two mirrors
// it has to keep agreeing with.
//
// The pill is a three-way agreement and every leg can drift on its own:
//   1. the WIRE      → `rate_limit_event.resetsAt` is in SECONDS; the pill is
//                      in millis. Off by 1000 and the countdown reads 20,000
//                      days, which is exactly the kind of bug a "looks fine"
//                      screenshot of a warm cache never shows.
//   2. the MIRROR    → webview/…/passthroughUsagePill.ts is a hand copy of
//                      src/claudeCode/usagePill.ts, because a webview .ts may
//                      not import from src/ at all (TS6059).
//   3. the HOUSE     → the span wording is providerUsage.usageLine's, so a
//                      Claude plan and an OpenAI subscription read the same in
//                      the same slot.
// Legs 2 and 3 are checked by READING BOTH FILES, per the house rule that every
// mirror needs a drift guard (WORKING_ON_ORIGAMI_CODER Part 5).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseLine } from '../../../src/claudeCode/protocol';
import { rateLimitPillOf, usagePillText } from '../../../src/claudeCode/usagePill';
import { usageLine } from '../../../src/dashboard/providerUsage';
import { usagePillText as mirrored } from '../components/passthroughUsagePill';
// windowsTooltipText has no host copy — see usagePill.ts's comment by
// `rateLimitPillOf`: nothing on the host renders the tooltip, so only the
// webview owns the formatter, in its own leaf (usageWindowsTooltip.ts).
import { windowsTooltipText } from '../components/usageWindowsTooltip';
import { DENY_RATE_LIMIT_EVENT, PROBE_RATE_LIMIT_EVENT, RUN1_RATE_LIMIT_EVENT } from './claudeCodeFixtures';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The captured reset instant, in millis. 1788195600 is the `resetsAt` all
 *  three real transcripts carry. */
const RESET_MS = 1788195600 * 1000;

describe('the pill, off the real wire', () => {
  it('reads seconds from the CLI and reports millis', () => {
    const pill = rateLimitPillOf(parseLine(RUN1_RATE_LIMIT_EVENT)!);
    // The unit conversion is the whole assertion: `resetsAt` on the wire is
    // 1788195600, and a pill that passed it through unscaled would put the
    // reset in January 1970 and render "resetting now" forever.
    expect(pill).toMatchObject({ pct: 80, window: '7d', resetsAt: RESET_MS, status: 'allowed_warning' });
  });

  it('carries each captured utilization through as a whole percent', () => {
    const pcts = [RUN1_RATE_LIMIT_EVENT, DENY_RATE_LIMIT_EVENT, PROBE_RATE_LIMIT_EVENT]
      .map((line) => rateLimitPillOf(parseLine(line)!)?.pct);
    // 0.8 / 0.87 / 0.9 on the wire — 87 proves it rounds rather than truncates
    // to 80 and rather than printing 87.00000000000001.
    expect(pcts).toEqual([80, 87, 90]);
  });

  it('writes the composer text the owner asked for', () => {
    const pill = rateLimitPillOf(parseLine(PROBE_RATE_LIMIT_EVENT)!)!;
    // Three days and four hours before the captured reset.
    const now = RESET_MS - ((3 * 86400) + (4 * 3600)) * 1000;
    expect(usagePillText(pill.pct, pill.resetsAt, now)).toBe('90% used · resets in 3d 4h');
  });

  it('says nothing at all when the CLI reported no percentage', () => {
    // An empty slot is honest; "resets in 3d" with no number to qualify is not.
    expect(usagePillText(-1, RESET_MS, RESET_MS - 1000)).toBe('');
  });

  it('does not count backwards past a reset that already happened', () => {
    expect(usagePillText(90, RESET_MS, RESET_MS + 60_000)).toBe('90% used · resetting now');
  });

  it('drops to hours and then minutes as the window closes', () => {
    expect(usagePillText(90, RESET_MS, RESET_MS - (2 * 3600 + 30 * 60) * 1000)).toBe('90% used · resets in 2h 30m');
    expect(usagePillText(90, RESET_MS, RESET_MS - 45 * 60 * 1000)).toBe('90% used · resets in 45m');
  });

  it('keeps the window name in the tooltip, where "which limit" is asked', () => {
    const pill = rateLimitPillOf(parseLine(RUN1_RATE_LIMIT_EVENT)!)!;
    // It left the pill text in phase 2; losing it entirely would make a
    // seven-day and a five-hour warning indistinguishable.
    expect(pill.title).toContain('your 7d limit used');
    expect(pill.title).toContain('no per-turn charge');
  });

  it('carries the ONE window a live event named, for the tooltip', () => {
    const pill = rateLimitPillOf(parseLine(RUN1_RATE_LIMIT_EVENT)!)!;
    // A rate_limit_event only ever names the lane that fired — there is no
    // ladder to read the rest of the account's windows off.
    expect(pill.windows).toEqual([{ label: '7d', pct: 80, resetsAt: RESET_MS }]);
  });
});

describe('the multi-window tooltip', () => {
  const DAY = 86_400_000;

  it('lists every window, tightest and all, as one line each', () => {
    const now = Date.UTC(2026, 8, 14, 17, 0, 0); // 2026-09-14T17:00Z
    const text = windowsTooltipText(
      [
        { label: '5h', pct: 73, resetsAt: now + 2 * 3_600_000 },
        { label: '7d', pct: 98, resetsAt: now + 6 * DAY },
        { label: '30d', pct: 100, resetsAt: now + 17 * DAY },
      ],
      now,
    );
    expect(text.split('\n')).toEqual([
      expect.stringContaining('5h · 73% · resets'),
      expect.stringContaining('7d · 98% · resets'),
      expect.stringContaining('30d · 100% · resets'),
    ]);
  });

  it('says a bare time for a reset later today, a weekday for the next six days, and a date beyond that', () => {
    const now = Date.UTC(2026, 8, 14, 17, 0, 0);
    const [today, thisWeek, further] = windowsTooltipText(
      [
        { label: 'today', pct: 1, resetsAt: now + 3_600_000 },
        { label: 'week', pct: 1, resetsAt: now + 3 * DAY },
        { label: 'later', pct: 1, resetsAt: now + 17 * DAY },
      ],
      now,
    ).split('\n');
    expect(today).toMatch(/^today · 1% · resets \d{2}:\d{2}$/);
    expect(thisWeek).toMatch(/^week · 1% · resets [A-Za-z]{3} \d{2}:\d{2}$/);
    expect(further).toMatch(/^later · 1% · resets \d{1,2} [A-Za-z]{3}$/);
  });

  it('says "unknown" for a window with no future reset', () => {
    expect(windowsTooltipText([{ label: 'beta', pct: 0, resetsAt: 0 }], Date.now())).toBe('beta · 0% · resets unknown');
  });
});

describe('the mirrors', () => {
  it('agrees with the webview copy on every case above', () => {
    const cases: Array<[number, number, number]> = [
      [90, RESET_MS, RESET_MS - (3 * 86400 + 4 * 3600) * 1000],
      [80, RESET_MS, RESET_MS - (2 * 3600 + 30 * 60) * 1000],
      [87, RESET_MS, RESET_MS - 45 * 60 * 1000],
      [90, RESET_MS, RESET_MS + 60_000],
      [-1, RESET_MS, RESET_MS - 1000],
      [50, 0, Date.now()],
    ];
    for (const [pct, resets, now] of cases) {
      expect(mirrored(pct, resets, now)).toBe(usagePillText(pct, resets, now));
    }
  });

  it('keeps the two copies textually identical in the part that matters', () => {
    // A case-by-case check can only catch drift in cases somebody thought of.
    // This reads the function BODY out of both files, so a fifth branch added
    // to one of them fails here even though no test covers that branch yet.
    const bodyOf = (rel: string, fnDecl: string) => {
      const src = readFileSync(path.join(pkgRoot, rel), 'utf8');
      const at = src.indexOf(fnDecl);
      expect(at, `${fnDecl} not found in ${rel}`).toBeGreaterThan(-1);
      // To the function's own closing brace at column 0 — not to end of file,
      // which would compare usagePill.ts's `rateLimitPillOf` against nothing.
      const end = src.indexOf('\n}', at);
      expect(end, `${fnDecl} is unterminated in ${rel}`).toBeGreaterThan(at);
      return src.slice(at, end + 2).replace(/\s+/g, ' ').trim();
    };
    expect(bodyOf('webview/dashboard/components/passthroughUsagePill.ts', 'export function usagePillText'))
      .toBe(bodyOf('src/claudeCode/usagePill.ts', 'export function usagePillText'));
  });

  it('writes the span exactly as the OAuth providers write theirs', () => {
    // The house wording lives in providerUsage.usageLine. If someone changes
    // the ladder there (say d+h+m), this fails and the pill is updated with it,
    // rather than the two slots quietly diverging in the same bar.
    const cases = [
      [(3 * 86400 + 4 * 3600) * 1000, '3d 4h'],
      [(2 * 3600 + 30 * 60) * 1000, '2h 30m'],
      [45 * 60 * 1000, '45m'],
    ] as const;
    for (const [ahead, span] of cases) {
      const now = RESET_MS - ahead;
      const house = usageLine({ label: '7-day', usedPercent: 90, resetsAt: RESET_MS }, now);
      expect(house).toBe(`7-day: 90% used, resets in ${span}`);
      expect(usagePillText(90, RESET_MS, now)).toBe(`90% used · resets in ${span}`);
    }
  });
});
