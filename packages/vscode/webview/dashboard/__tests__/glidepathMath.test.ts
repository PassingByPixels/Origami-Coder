// glidepathMath — the claims the view makes about the future.
//
// The failures worth catching are all of one kind: a confident number the
// readings do not support. A window whose length was GUESSED — the defect that
// drove this round, where a reset time with no period was assumed to be thirty
// days and drew a weekly window at 78% of a month. A trend drawn through two
// hours of readings. A badge that reports where a window is instead of where it
// lands.
//
// Every case below is a FIXED set of readings against a FIXED clock.

import { describe, expect, it } from 'vitest';
import {
  DAY,
  GUARD,
  HOUR,
  MONTH,
  WEEK,
  biggestDaySpike,
  colourFor,
  connectionLanes,
  connectionName,
  cardTail,
  elapsedDays,
  fractionOf,
  guardOf,
  insightsFor,
  labelLengthMs,
  laneOf,
  lengthLabelOf,
  nearestReset,
  overrideMs,
  pickWindowLabel,
  plottable,
  resampleHourly,
  slopePerHour,
  statusOf,
  valueAtFraction,
  windowLength,
  type GlideWindow,
} from '../components/glidepathMath';

const RESET = 1_787_000_000_000;
const START = RESET - WEEK;

/** A window with readings placed by day offset from a seven-day window's start. */
const weekly = (points: Array<[number, number]>, over: Partial<GlideWindow> = {}): GlideWindow => ({
  resetsAt: RESET,
  samples: points.map(([day, pct]) => ({ t: START + day * DAY, pct })),
  ...over,
});

/** Readings every half hour from `fromDay`, climbing by `step` each time. */
const dense = (fromDay: number, hours: number, from: number, step: number) => {
  const out: Array<{ t: number; pct: number }> = [];
  for (let i = 0; i <= hours * 2; i += 1) out.push({ t: START + fromDay * DAY + i * 0.5 * HOUR, pct: from + i * step });
  return out;
};

describe('windowLength — the ladder, rung by rung, in order', () => {
  const bare = { resetsAt: RESET, samples: [] };

  it('rung 1: the provider STATED a length, and it beats everything below it', () => {
    // The label says a week and the previous cycle measures a month; the stated
    // five hours still wins, because it is the only rung that is not inference.
    const win: GlideWindow = {
      resetsAt: RESET,
      samples: [],
      lengthMs: 5 * HOUR,
      previous: { resetsAt: RESET - MONTH, samples: [] },
    };
    expect(windowLength('openai', 'Weekly', win)).toEqual({ ms: 5 * HOUR, source: 'stated' });
  });

  it('rung 2: the provider gave BOTH ENDS — Grok’s currentPeriod, Copilot’s month', () => {
    // THE BUG THIS ROUND EXISTS FOR. Grok states start and end; before this the
    // parser read only `end`, the view had a reset with no period, assumed 30
    // days, and drew a weekly window at 78% of a month.
    const grok: GlideWindow = { resetsAt: RESET, samples: [], startsAt: RESET - WEEK };
    expect(windowLength('xai', 'Credits', grok)).toEqual({ ms: WEEK, source: 'stated' });
  });

  it('rung 3: the USER stated the cadence, for a provider that never does', () => {
    const win: GlideWindow = { resetsAt: RESET, samples: [], previous: { resetsAt: RESET - MONTH, samples: [] } };
    expect(windowLength('xai', 'Credits', win, { xai: 'weekly' })).toEqual({ ms: WEEK, source: 'configured' });
    expect(windowLength('xai', 'Credits', win, { xai: 14 })).toEqual({ ms: 14 * DAY, source: 'configured' });
    // It fills a gap; it never overrides a fact.
    const stated: GlideWindow = { ...win, lengthMs: WEEK };
    expect(windowLength('xai', 'Credits', stated, { xai: 'monthly' })!.source).toBe('stated');
  });

  it('rung 4: a length written into the label, in every form this build produces', () => {
    expect(windowLength('openai', '5-hour', bare)).toEqual({ ms: 5 * HOUR, source: 'label' });
    expect(windowLength('openai', '3-day', bare)).toEqual({ ms: 3 * DAY, source: 'label' });
    expect(windowLength('claude-code', '5h', bare)).toEqual({ ms: 5 * HOUR, source: 'label' });
    expect(windowLength('claude-code', '7d opus', bare)).toEqual({ ms: WEEK, source: 'label' });
    expect(windowLength('opencode-go', 'Weekly', bare)).toEqual({ ms: WEEK, source: 'label' });
    expect(windowLength('opencode-go', 'Monthly', bare)).toEqual({ ms: MONTH, source: 'label' });
  });

  it('rung 5: MEASURED reset-to-reset, and it is the LAST rung', () => {
    const win: GlideWindow = {
      resetsAt: RESET,
      samples: [{ t: START + DAY, pct: 10 }],
      previous: { resetsAt: RESET - MONTH, samples: [] },
    };
    expect(windowLength('xai', 'Credits', win)).toEqual({ ms: MONTH, source: 'measured' });
  });

  it('answers NOTHING rather than guessing — no first-sample rung, no Copilot 30 days', () => {
    // Both of these used to answer. The first-sample rung made a window sampled
    // for two hours look two hours long; the Copilot special case simply
    // asserted thirty days. A window with no evidence of a length now says so.
    const sampledOnly: GlideWindow = { resetsAt: RESET, samples: [{ t: RESET - 2 * DAY, pct: 10 }] };
    expect(windowLength('xai', 'Credits', sampledOnly)).toBeUndefined();
    expect(windowLength('github-copilot', 'Premium requests', bare)).toBeUndefined();
    expect(windowLength('xai', 'Credits', bare)).toBeUndefined();
  });

  it('ignores an override it cannot read, rather than treating it as zero', () => {
    expect(overrideMs('weekly')).toBe(WEEK);
    expect(overrideMs('Monthly')).toBe(MONTH);
    expect(overrideMs(21)).toBe(21 * DAY);
    expect(overrideMs('every other tuesday')).toBeUndefined();
    expect(overrideMs(0)).toBeUndefined();
    expect(overrideMs(-3)).toBeUndefined();
    expect(overrideMs(undefined)).toBeUndefined();
  });

  it('labelLengthMs is the label rung on its own, and says nothing about a quota name', () => {
    expect(labelLengthMs('Premium requests')).toBeUndefined();
    expect(labelLengthMs('Credits')).toBeUndefined();
    expect(labelLengthMs('Session')).toBe(5 * HOUR);
  });
});

describe('the window length, as the legend and the cards say it', () => {
  it('a STATED length is given as days alone; a MEASURED one names its window', () => {
    expect(lengthLabelOf('7d', { ms: WEEK, source: 'stated' })).toBe('7 d');
    expect(lengthLabelOf('Premium requests', { ms: MONTH, source: 'stated' })).toBe('30 d');
    // "31 d" alone would read as a plan's stated period. It is not: it is the
    // gap between two of the provider's own resets.
    expect(lengthLabelOf('Credits', { ms: 31 * DAY, source: 'measured' })).toBe('31 d credits');
    expect(lengthLabelOf('5h', { ms: 5 * HOUR, source: 'label' })).toBe('5 h');
  });
});

describe('resampleHourly — the line describes the work, not the polling', () => {
  it('keeps ONE reading per clock hour, the last one in the hour', () => {
    const base = Math.floor(START / HOUR) * HOUR;
    const samples = [
      { t: base, pct: 0 },
      { t: base + HOUR + 60_000, pct: 5 },
      { t: base + HOUR + 120_000, pct: 6 },
      { t: base + HOUR + 180_000, pct: 7 },
      { t: base + 2 * HOUR, pct: 9 },
    ];
    // Three readings inside one minute drew a near-vertical zigzag that read as
    // a spike when it was only the sampler waking up. They collapse to the last
    // reading of their hour.
    expect(resampleHourly(samples).map((s) => s.pct)).toEqual([0, 7, 9]);
  });

  it('ALWAYS keeps the first and last raw readings — the ends are where the eye reads', () => {
    const base = Math.floor(START / HOUR) * HOUR;
    const samples = [
      { t: base + 5_000, pct: 1 },
      { t: base + 200_000, pct: 4 },
      { t: base + HOUR + 5_000, pct: 7 },
      { t: base + HOUR + 400_000, pct: 11 },
    ];
    const out = resampleHourly(samples);
    expect(out[0]!.t).toBe(samples[0]!.t);
    expect(out[out.length - 1]!.t).toBe(samples[3]!.t);
    // ...and never the same instant twice.
    expect(new Set(out.map((s) => s.t)).size).toBe(out.length);
  });

  it('sorts, and survives an empty list', () => {
    expect(resampleHourly([])).toEqual([]);
    const out = resampleHourly([{ t: 5 * HOUR, pct: 9 }, { t: 1 * HOUR, pct: 2 }]);
    expect(out.map((s) => s.pct)).toEqual([2, 9]);
  });
});

describe('slopePerHour — least squares, not last minus first', () => {
  it('fits every point, so one busy hour does not set the week’s rate', () => {
    const pts = [0, 1, 2, 3].map((h) => ({ t: START + h * HOUR, pct: h * 2 }));
    expect(slopePerHour(pts)).toBeCloseTo(2, 6);
  });

  it('a spike at the end moves the fit LESS than last-minus-first would', () => {
    const flatThenJump = [
      { t: START, pct: 0 },
      { t: START + HOUR, pct: 0 },
      { t: START + 2 * HOUR, pct: 0 },
      { t: START + 3 * HOUR, pct: 40 },
    ];
    const lastMinusFirst = 40 / 3;
    expect(slopePerHour(flatThenJump)).toBeLessThan(lastMinusFirst);
    expect(slopePerHour(flatThenJump)).toBeGreaterThan(0);
  });

  it('is zero for fewer than two points, and for readings all at one instant', () => {
    expect(slopePerHour([{ t: START, pct: 5 }])).toBe(0);
    expect(slopePerHour([{ t: START, pct: 5 }, { t: START, pct: 9 }])).toBe(0);
  });
});

describe('guardOf — two tiers, and nothing at all below the lower one', () => {
  it('says NOTHING under four hours of readings — the Grok case exactly', () => {
    // 14% used, two hours of readings, on a seven-day window. The old view drew
    // that as a line running out before the reset.
    expect(guardOf(0.5, 2, 5)).toEqual({
      ok: false,
      tier: 'none',
      why: 'only 2.0 h of readings (provisional at 4 h, firm at 24 h)',
    });
  });

  it('says nothing while the hourly fit has under three points to fit, however long the span', () => {
    expect(guardOf(0.5, 48, 2)).toEqual({ ok: false, tier: 'none', why: 'only 2 readings' });
  });

  it('projects PROVISIONALLY from four hours and three points, whatever share of the window has gone', () => {
    // 1% of the window elapsed. The share of the window is a FIRM condition
    // only: a slope measured over four hours is the same slope whether those
    // four hours are 1% of a month or 10% of a day.
    const g = guardOf(0.01, GUARD.PROVISIONAL_HOURS, GUARD.MIN_POINTS);
    expect(g.tier).toBe('provisional');
    expect(g.ok).toBe(true);
    expect(g.why).toBe('window only 1% elapsed (needs 10%)');
  });

  it('is still only provisional at 23 hours of readings, and names what is missing', () => {
    expect(guardOf(0.5, 23, 20)).toEqual({
      ok: true,
      tier: 'provisional',
      why: 'only 23.0 h of readings (needs 24 h)',
    });
  });

  it('FIRMS at the original three thresholds, inclusive at each floor', () => {
    expect(guardOf(GUARD.MIN_FRAC, GUARD.MIN_HOURS, GUARD.MIN_POINTS)).toEqual({
      ok: true,
      tier: 'firm',
      why: '',
    });
  });

  it('a tenth of a point under the provisional floor is still nothing', () => {
    expect(guardOf(0.5, GUARD.PROVISIONAL_HOURS - 0.1, 20).tier).toBe('none');
  });
});

describe('statusOf — where the window LANDS, not where it is', () => {
  it('AHEAD past 105: it runs out before the reset', () => {
    expect(statusOf(105.1)).toBe('AHEAD');
    expect(statusOf(400)).toBe('AHEAD');
  });

  it('TIGHT from 95 to 105 — the gap the old rule had', () => {
    // The old rule needed 90% ALREADY SPENT before it would say TIGHT, so a
    // window projected to finish at 99% was badged ON TRACK all week.
    expect(statusOf(99)).toBe('TIGHT');
    expect(statusOf(95)).toBe('TIGHT');
    expect(statusOf(105)).toBe('TIGHT');
  });

  it('BEHIND under 90, ON TRACK in between', () => {
    expect(statusOf(89.9)).toBe('BEHIND');
    expect(statusOf(0)).toBe('BEHIND');
    expect(statusOf(90)).toBe('ON TRACK');
    expect(statusOf(94.9)).toBe('ON TRACK');
  });
});

describe('laneOf — the guard decides whether there is anything to say', () => {
  const win = (samples: Array<{ t: number; pct: number }>, over: Partial<GlideWindow> = {}): GlideWindow => ({
    resetsAt: RESET,
    samples,
    lengthMs: WEEK,
    ...over,
  });

  it('a window with no known period is NOT on the axis, and says so', () => {
    const lane = laneOf('xai', 'Credits', { resetsAt: RESET, samples: [{ t: START + DAY, pct: 14 }] }, START + 2 * DAY, '#f');
    expect(lane.unknownPeriod).toBe(true);
    expect(lane.frac).toBeUndefined();
    expect(lane.projection).toBeUndefined();
    expect(lane.status).toBeUndefined();
    // The percentage is still real and is still shown.
    expect(lane.usedPct).toBe(14);
    expect(cardTail(lane)).toContain('period unknown');
    expect(plottable([lane])).toEqual([]);
  });

  it('two hours of readings on a week: a percentage, no forecast, and the reason', () => {
    const lane = laneOf('xai', 'Credits', win(dense(3, 2, 12, 0.5)), START + 3.1 * DAY, '#f');
    expect(lane.guard.ok).toBe(false);
    expect(lane.projection).toBeUndefined();
    expect(lane.status).toBeUndefined();
    expect(cardTail(lane)).toBe(
      'too early to project — only 2.0 h of readings (provisional at 4 h, firm at 24 h)',
    );
  });

  it('a full day of readings unlocks the projection and the badge', () => {
    // 40% by day 3.5 on a week, climbing evenly: the fit lands it past the cap.
    const lane = laneOf('openai', 'Weekly', win(dense(2.5, 24, 20, 0.4)), START + 3.5 * DAY, '#f');
    expect(lane.guard.ok).toBe(true);
    expect(lane.projection).toBeDefined();
    expect(lane.projection!.slopePerHour).toBeCloseTo(0.8, 3);
    expect(lane.status).toBe('AHEAD');
    expect(lane.projection!.exhaustFrac).toBeDefined();
  });

  it('a lane past its own reset projects nothing, however many readings it has', () => {
    // Dividing by an elapsed time longer than the window inverts the arithmetic:
    // a spent window would otherwise report a confident BEHIND.
    const lane = laneOf('openai', 'Weekly', win(dense(1, 48, 10, 0.4)), RESET + DAY, '#f');
    expect(lane.expired).toBe(true);
    expect(lane.guard.ok).toBe(false);
    expect(lane.status).toBeUndefined();
    expect(lane.daysToReset).toBe(0);
    expect(insightsFor([lane]).filter((i) => i.id.includes(':'))).toEqual([]);
  });

  it('the slope is clamped at zero: a falling reading is not a negative burn', () => {
    const lane = laneOf('openai', 'Weekly', win(dense(1, 48, 60, -0.2)), START + 3 * DAY, '#f');
    expect(lane.slopePerHour).toBe(0);
    expect(lane.projection!.atResetPct).toBeCloseTo(lane.usedPct, 6);
    expect(lane.projection!.exhaustFrac).toBeUndefined();
  });

  it('six hours of readings project PROVISIONALLY — a faded claim, not silence', () => {
    // The gap this round closed: the pane used to answer "TOO EARLY" for a whole
    // day, so a user who opened it on the morning of a new window got a
    // percentage and nothing about where it lands.
    const lane = laneOf('openai', 'Weekly', win(dense(2, 6, 20, 0.4)), START + 2.5 * DAY, '#f');
    expect(lane.guard.tier).toBe('provisional');
    expect(lane.projection!.basis).toBe('provisional');
    expect(lane.projection!.carried).toBeUndefined();
    expect(lane.status).toBeDefined();
    // The rate is this cycle's OWN fit: 0.4 points every half hour.
    expect(lane.projection!.slopePerHour).toBeCloseTo(0.8, 6);
    expect(cardTail(lane)).toBe('provisional (6.0 h of readings, firms at 24 h)');
  });

  it('thirty hours of readings FIRM the same projection up', () => {
    const lane = laneOf('openai', 'Weekly', win(dense(1, 30, 10, 0.4)), START + 2.5 * DAY, '#f');
    expect(lane.guard.tier).toBe('firm');
    expect(lane.projection!.basis).toBe('firm');
    expect(cardTail(lane)).not.toContain('provisional');
  });

  it('three hours of readings is still nothing at all', () => {
    const lane = laneOf('openai', 'Weekly', win(dense(2, 3, 20, 0.4)), START + 2.5 * DAY, '#f');
    expect(lane.guard.tier).toBe('none');
    expect(lane.projection).toBeUndefined();
    expect(lane.status).toBeUndefined();
  });

  describe('a window that has just reset', () => {
    // The previous cycle ran for 30 hours and climbed 2 points an hour. The new
    // one opened at START and has a single reading in it.
    const previous = {
      resetsAt: START,
      samples: Array.from({ length: 31 }, (_, i) => ({ t: START - 30 * HOUR + i * HOUR, pct: i * 2 })),
    };
    const fresh = (over: Partial<GlideWindow> = {}): GlideWindow => ({
      resetsAt: RESET,
      lengthMs: WEEK,
      samples: [{ t: START + 0.5 * HOUR, pct: 1 }],
      ...over,
    });

    it('carries the LAST window’s rate rather than going blank for a day', () => {
      const lane = laneOf('openai', 'Weekly', fresh({ previous }), START + DAY, '#f');
      expect(lane.guard.tier).toBe('provisional');
      expect(lane.projection!.carried).toBe(true);
      expect(lane.projection!.basis).toBe('provisional');
      expect(lane.projection!.slopePerHour).toBeCloseTo(slopePerHour(resampleHourly(previous.samples)), 6);
      expect(lane.projection!.slopePerHour).toBeCloseTo(2, 6);
      expect(cardTail(lane)).toBe('provisional — rate carried from the last window');
    });

    it('anchors the carried rate on THIS cycle’s reading, not the last one’s 60%', () => {
      const lane = laneOf('openai', 'Weekly', fresh({ previous }), START + DAY, '#f');
      // usedPct is the new cycle's own 1%, plus 2 points an hour for the 6 days
      // left. The old cycle ended at 60% and that number appears nowhere.
      expect(lane.usedPct).toBe(1);
      expect(lane.projection!.atResetPct).toBeCloseTo(1 + 2 * 144, 6);
    });

    it('carries nothing when there IS no previous window', () => {
      const lane = laneOf('openai', 'Weekly', fresh(), START + DAY, '#f');
      expect(lane.guard.tier).toBe('none');
      expect(lane.projection).toBeUndefined();
    });

    it('carries nothing when the previous window was itself too short', () => {
      const short = { resetsAt: START, samples: [{ t: START - 2 * HOUR, pct: 1 }, { t: START - HOUR, pct: 2 }, { t: START, pct: 3 }] };
      const lane = laneOf('openai', 'Weekly', fresh({ previous: short }), START + DAY, '#f');
      expect(lane.guard.tier).toBe('none');
      expect(lane.projection).toBeUndefined();
    });

    it('hands over to this cycle’s own rate the moment it reaches four hours', () => {
      // Four hours of its own readings climbing 0.2 points an hour, against a
      // carried 2. No blend: the new fit simply takes over.
      const own = Array.from({ length: 9 }, (_, i) => ({ t: START + i * 0.5 * HOUR, pct: 1 + i * 0.1 }));
      const lane = laneOf('openai', 'Weekly', fresh({ samples: own, previous }), START + DAY, '#f');
      expect(lane.projection!.carried).toBeUndefined();
      expect(lane.projection!.slopePerHour).toBeCloseTo(0.2, 6);
    });

    it('still projects nothing when the window it just entered has already reset', () => {
      const lane = laneOf('openai', 'Weekly', fresh({ previous }), RESET + HOUR, '#f');
      expect(lane.expired).toBe(true);
      expect(lane.projection).toBeUndefined();
      expect(cardTail(lane)).toContain('window has reset');
    });

    it('carries the rate on a length MEASURED from the previous cycle, with none stated', () => {
      // No stated length anywhere: the window is dated by the gap between the
      // two resets, which is exactly what a previous cycle is for.
      const lane = laneOf('xai', 'Credits', { resetsAt: RESET, samples: [{ t: START + 0.5 * HOUR, pct: 1 }], previous }, START + DAY, '#f');
      expect(lane.unknownPeriod).toBe(false);
      expect(lane.lengthSource).toBe('measured');
      expect(lane.projection!.carried).toBe(true);
    });

    it('still projects nothing when the period cannot be worked out at all', () => {
      // A previous cycle that claims a LATER reset than the current one dates
      // nothing, so there is no window to be a share of and no axis to draw on.
      // The rate is not carried onto a lane that has nowhere to put it.
      const backwards = { ...previous, resetsAt: RESET + DAY };
      const lane = laneOf('xai', 'Credits', { resetsAt: RESET, samples: [{ t: START, pct: 1 }], previous: backwards }, START + DAY, '#f');
      expect(lane.unknownPeriod).toBe(true);
      expect(lane.projection).toBeUndefined();
      expect(cardTail(lane)).toContain('period unknown');
    });
  });

  it('reports how stale the newest reading is, and how many reads there were', () => {
    const lane = laneOf('openai', 'Weekly', win(dense(1, 24, 5, 0.1)), START + 2.5 * DAY, '#f');
    expect(lane.reads).toBe(49);
    expect(lane.sampledAgoMs).toBeCloseTo(0.5 * DAY, -3);
  });
});

describe('pickWindowLabel — the ONE window that represents a connection', () => {
  const w = (over: Partial<GlideWindow> = {}) => ({ resetsAt: RESET, samples: [], ...over });

  it('prefers weekly, then monthly, then the longest known length', () => {
    expect(pickWindowLabel('claude-code', { '5h': w(), '7d': w() })).toBe('7d');
    expect(pickWindowLabel('openai', { Monthly: w(), '7-day': w() })).toBe('7-day');
    expect(pickWindowLabel('opencode-go', { '5-hour': w(), Monthly: w() })).toBe('Monthly');
    const long = w({ lengthMs: 45 * DAY });
    expect(pickWindowLabel('xai', { Short: w({ lengthMs: 2 * DAY }), Long: long })).toBe('Long');
  });

  it('takes ONE weekly window per connection — Claude reports two', () => {
    // `planUsageParse.ts` writes "7d" for seven_day and "7d opus" for
    // seven_day_opus. Two lanes would be two lines of one colour under one name.
    expect(pickWindowLabel('claude-code', { '7d': w(), '7d opus': w() })).toBe('7d');
  });

  it('never a window shorter than a day WHEN a longer one exists', () => {
    expect(pickWindowLabel('openai', { '5-hour': w(), Weekly: w() })).toBe('Weekly');
  });

  it('still names a window when NONE has a usable length — the card is the point', () => {
    // "Grok, period unknown, 14% used, 5 d to reset" is a true and useful card.
    // Dropping the connection entirely would hide a real subscription.
    expect(pickWindowLabel('xai', { Credits: w(), 'On-demand': w() })).toBe('Credits');
    // ...and a short lane is not chosen to represent the plan when a plausible
    // plan-sized window is also reported with no length.
    expect(pickWindowLabel('openai', { '5-hour': w(), 'Premium requests': w() })).toBe('Premium requests');
    expect(pickWindowLabel('openai', {})).toBeUndefined();
  });
});

describe('connectionLanes over a whole store', () => {
  const providers = {
    'claude-code': { windows: { '5h': weekly([[1, 20]], { lengthMs: 5 * HOUR }), '7d': weekly([[1, 10]], { lengthMs: WEEK }) } },
    'github-copilot': { windows: { 'Premium requests': weekly([[1, 40]], { startsAt: RESET - MONTH }) } },
    xai: { windows: { Credits: weekly([[1, 14]]) } },
  };

  it('one lane per connection, including the one with no period', () => {
    expect(connectionLanes(providers, START + 3.5 * DAY).map((l) => `${l.providerId}:${l.label}`))
      .toEqual(['claude-code:7d', 'github-copilot:Premium requests', 'xai:Credits']);
    expect(plottable(connectionLanes(providers, START + 3.5 * DAY)).map((l) => l.providerId))
      .toEqual(['claude-code', 'github-copilot']);
  });

  it('an override puts a periodless connection back on the axis', () => {
    const withOverride = connectionLanes(providers, START + 3.5 * DAY, { xai: 'weekly' });
    const grok = withOverride.find((l) => l.providerId === 'xai')!;
    expect(grok.unknownPeriod).toBe(false);
    expect(grok.lengthSource).toBe('configured');
    expect(plottable(withOverride)).toHaveLength(3);
  });

  it('a connection keeps ONE colour, and the fifth hue is the validated one', () => {
    expect(colourFor('claude-code', 0)).toBe('#4ec9b0');
    expect(colourFor('opencode-go', 4)).toBe('#d45fb0');
    expect(connectionName('some-new-provider')).toBe('some-new-provider');
  });

  it('nearestReset picks the lane the header strip counts down', () => {
    const lanes = connectionLanes(
      {
        openai: { windows: { Weekly: weekly([[1, 10]], { lengthMs: WEEK }) } },
        'claude-code': { windows: { '7d': { resetsAt: RESET - 2 * DAY, lengthMs: WEEK, samples: [{ t: START, pct: 5 }] } } },
      },
      START + 3.5 * DAY,
    );
    expect(nearestReset(lanes)!.providerId).toBe('claude-code');
    expect(nearestReset([])).toBeUndefined();
  });
});

describe('fractionOf — the normalised axis every line shares', () => {
  const weekLane = laneOf('openai', 'Weekly', weekly([[0, 0], [2, 20]], { lengthMs: WEEK }), START + 2 * DAY, '#f');
  const monthLane = laneOf(
    'github-copilot',
    'Premium requests',
    { resetsAt: START + MONTH, startsAt: START, samples: [{ t: START, pct: 0 }, { t: START + 15 * DAY, pct: 40 }] },
    START + 15 * DAY,
    '#f',
  );

  it('a week and a month both run 0 to 1, so both end at the SAME reset', () => {
    expect(fractionOf(weekLane, weekLane.resetsAt)).toBe(1);
    expect(fractionOf(monthLane, monthLane.resetsAt)).toBe(1);
    expect(fractionOf(weekLane, START + 3.5 * DAY)).toBeCloseTo(0.5, 6);
    expect(fractionOf(monthLane, START + 15 * DAY)).toBeCloseTo(0.5, 6);
  });

  it('the WORDS still count in the window’s own days', () => {
    expect(elapsedDays(weekLane, START + 3.5 * DAY)).toBeCloseTo(3.5, 6);
    expect(elapsedDays(monthLane, START + 15 * DAY)).toBeCloseTo(15, 6);
  });

  it('clamps, and answers 0 for a lane with no length', () => {
    expect(fractionOf(weekLane, weekLane.resetsAt + 5 * DAY)).toBe(1);
    expect(fractionOf(weekLane, START - DAY)).toBe(0);
    const noLength = laneOf('xai', 'Credits', { resetsAt: RESET, samples: [] }, START, '#f');
    expect(fractionOf(noLength, RESET)).toBe(0);
  });
});

describe('valueAtFraction — the crosshair says "no reading" where there was none', () => {
  const lane = laneOf(
    'openai',
    'Weekly',
    { resetsAt: RESET, lengthMs: WEEK, samples: [{ t: START + 2 * DAY, pct: 20 }, { t: START + 4 * DAY, pct: 40 }] },
    START + 4 * DAY,
    '#f',
  );

  it('interpolates inside the measured span', () => {
    expect(valueAtFraction(lane, 3 / 7)).toBeCloseTo(30, 6);
    expect(valueAtFraction(lane, 2 / 7)).toBeCloseTo(20, 6);
  });

  it('answers NOTHING outside it, rather than extending the last value flat', () => {
    // Extending it would draw a week nobody sampled as a week that was measured.
    expect(valueAtFraction(lane, 0.1)).toBeUndefined();
    expect(valueAtFraction(lane, 0.9)).toBeUndefined();
    const noPeriod = laneOf('xai', 'Credits', { resetsAt: RESET, samples: [{ t: START, pct: 5 }] }, START, '#f');
    expect(valueAtFraction(noPeriod, 0.5)).toBeUndefined();
  });
});

describe('insightsFor — measurements, ordered by severity, no advice', () => {
  const openWin = (samples: Array<{ t: number; pct: number }>): GlideWindow => ({ resetsAt: RESET, lengthMs: WEEK, samples });

  it('names a periodless connection ONCE, as a row', () => {
    const lane = laneOf('xai', 'Credits', { resetsAt: RESET, samples: [{ t: START, pct: 14 }] }, START + DAY, '#f');
    const [row] = insightsFor([lane]);
    expect(row!.id).toBe('unknown-period');
    expect(row!.text).toContain('origamicoder.usage.windowLength');
  });

  it('names the connections the guard is holding, and which condition failed', () => {
    const lane = laneOf('openai', 'Weekly', openWin(dense(3, 2, 12, 0.5)), START + 3.1 * DAY, '#f');
    const [row] = insightsFor([lane]);
    expect(row!.id).toBe('guard');
    expect(row!.text).toContain('only 2.0 h of readings');
  });

  it('names the connections projecting PROVISIONALLY, apart from the blocked ones', () => {
    const soft = laneOf('openai', 'Weekly', openWin(dense(2, 6, 20, 0.4)), START + 2.5 * DAY, '#f');
    const row = insightsFor([soft]).find((i) => i.id === 'provisional');
    expect(row!.title).toBe('Provisional projection on 1 of 1 connections');
    expect(row!.text).toContain('ChatGPT');
    expect(insightsFor([soft]).some((i) => i.id === 'guard')).toBe(false);
  });

  it('states the spike, the exhaustion and the pace once the guard opens', () => {
    // 3.5 days of half-hourly readings climbing 0.7 points an hour: 61% used
    // against a fair 50%, and the fit reaches the cap before the reset.
    const lane = laneOf('openai', 'Weekly', openWin(dense(0, 84, 2, 0.35)), START + 3.5 * DAY, '#f');
    const kinds = insightsFor([lane]).map((i) => i.id.split(':')[0]);
    expect(kinds).toContain('spike');
    expect(kinds).toContain('exhaust');
    expect(kinds).toContain('pace');
    expect(kinds).not.toContain('unused');
    // Each thing is said once.
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('warns about a front-loaded burn, in the window’s own days', () => {
    // 52% spent by day 1.75 of 7 — more than half the week inside its first
    // quarter.
    const lane = laneOf('openai', 'Weekly', openWin(dense(0, 42, 2, 0.6)), START + 3.5 * DAY, '#f');
    const front = insightsFor([lane]).find((i) => i.id.startsWith('front'));
    expect(front!.text).toBe('52% of this window was already spent by day 1.8 of 7, against a fair share of 25%.');
  });

  it('orders by severity, worst first', () => {
    const rows = insightsFor([
      laneOf('openai', 'Weekly', openWin(dense(0, 84, 2, 0.35)), START + 3.5 * DAY, '#f'),
      laneOf('claude-code', '7d', openWin(dense(0, 84, 1, 0.05)), START + 3.5 * DAY, '#0f0'),
    ]);
    const rank = { bad: 0, warn: 1, info: 2, ok: 3 } as const;
    const ranks = rows.map((r) => rank[r.tone]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('every sentence is a measurement — none of them tells the user what to do', () => {
    const rows = insightsFor([laneOf('openai', 'Weekly', openWin(dense(0, 84, 2, 0.35)), START + 3.5 * DAY, '#f')]);
    expect(rows.length).toBeGreaterThan(2);
    // Advice goes stale with the next price or plan change and would then be
    // confidently wrong. MUTATION PROOF: add "switch to" copy and this reds.
    for (const r of rows) {
      expect(`${r.title} ${r.text}`.toLowerCase()).not.toMatch(/should|try |switch|consider|instead of|recommend/);
    }
  });
});

describe('biggestDaySpike', () => {
  it('measures a rise over a WHOLE DAY, not the gap between two readings', () => {
    // Half-hourly readings climbing 8pt each. No single step is notable; the day
    // they add up to is.
    const half = (i: number, pct: number) => ({ t: START + i * 1_800_000, pct });
    const climb = [half(0, 0), half(1, 8), half(2, 16), half(3, 24), half(4, 32)];
    expect(biggestDaySpike(climb)).toEqual({ delta: 32, at: climb[4]!.t });
    const spread = [{ t: START, pct: 0 }, { t: START + 2 * DAY, pct: 60 }, { t: START + 2.5 * DAY, pct: 70 }];
    expect(biggestDaySpike(spread)).toEqual({ delta: 10, at: spread[2]!.t });
  });

  it('a flat series reports zero, and one reading spans nothing', () => {
    expect(biggestDaySpike([{ t: 1, pct: 5 }, { t: 2, pct: 5 }])).toEqual({ delta: 0, at: 2 });
    expect(biggestDaySpike([{ t: 1, pct: 5 }])).toBeUndefined();
  });
});
