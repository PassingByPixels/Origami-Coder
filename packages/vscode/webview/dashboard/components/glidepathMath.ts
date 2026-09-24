// glidepathMath — every number the Glidepath view draws, computed here and
// nowhere else. Pure: a function of a sample list and a clock, so a claim
// about the future can be pinned to a fixed set of readings in a test. Where
// the data doesn't support a number, the answer is `undefined` and the view
// says so — no default window length, no assumed reset day, no projection
// from a handful of readings minutes apart.
//
// The shapes are hand-mirrored from `src/dashboard/usageHistoryStore.ts`
// (tsconfig.webview.json pins rootDir to webview/, so this file can't import
// that one). They are the wire format of `glidepathData`.

export interface GlideSample {
  readonly t: number;
  readonly pct: number;
}
export interface GlideCycle {
  readonly resetsAt: number;
  readonly samples: readonly GlideSample[];
  /** Epoch millis this window opened, when the provider STATED it. */
  readonly startsAt?: number;
  /** How long this window is, when the provider STATED it. */
  readonly lengthMs?: number;
}
export interface GlideWindow extends GlideCycle {
  readonly previous?: GlideCycle;
}
export interface GlideProvider {
  readonly windows: Record<string, GlideWindow>;
}
export type GlideProviders = Record<string, GlideProvider>;

const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const WEEK = 7 * DAY;
export const MONTH = 30 * DAY;

/**
 * The fixed connection palette — not themed. These five hues are the one thing
 * in this view that doesn't come from `--og-*`: a line's colour is its
 * identity, so a chart line, its legend swatch and its mini card must agree.
 * The fifth hue cleared the normal-vision floor while staying in the
 * colour-blind floor band beside the blue, allowed here because every line
 * also carries a secondary encoding (end label, legend entry, named card).
 */
export const CONNECTION_COLOURS: Readonly<Record<string, string>> = {
  'claude-code': '#4ec9b0',
  'github-copilot': '#f48771',
  openai: '#dcdcaa',
  xai: '#569cd6',
  'opencode-go': '#d45fb0',
};

/** For a sixth and seventh connection this build does not name. Muted to match. */
export const EXTRA_COLOURS: readonly string[] = ['#b5cea8', '#9a7bd4'];

export function colourFor(providerId: string, index: number): string {
  return CONNECTION_COLOURS[providerId] ?? EXTRA_COLOURS[index % EXTRA_COLOURS.length]!;
}

export const CONNECTION_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude',
  'github-copilot': 'GitHub Copilot',
  openai: 'ChatGPT',
  xai: 'Grok',
  'opencode-go': 'OpenCode Go',
};

/** An id this build does not name is shown AS the id, never as "Unknown". */
export function connectionName(providerId: string): string {
  return CONNECTION_NAMES[providerId] ?? providerId;
}

/** Where a window's length came from — shown in the Data tab, verbatim. */
export type LengthSource = 'stated' | 'configured' | 'label' | 'measured';

export interface WindowLength {
  readonly ms: number;
  readonly source: LengthSource;
}

/** A user's `origamicoder.usage.windowLength.<providerId>` value, already read. */
export type LengthOverrides = Readonly<Record<string, string | number | undefined>>;

/**
 * How long one window is, in milliseconds, and where that answer came from.
 * Each rung is tried only when every rung above it answered nothing:
 *  1. The provider said so (`lengthMs` on the window record).
 *  2. The provider gave both ends (`resetsAt - startsAt`).
 *  3. The user said so (`origamicoder.usage.windowLength.<providerId>`).
 *  4. A length written in the label (e.g. "5-hour", "7d opus").
 *  5. The previous cycle: reset-to-reset, measured rather than assumed.
 * `undefined` when every rung fails — a lane with no length is not drawn on
 * the shared axis at all (see `unknownPeriod`), never guessed.
 */
export function windowLength(
  providerId: string,
  label: string,
  win: GlideWindow,
  overrides: LengthOverrides = {},
): WindowLength | undefined {
  const stated = positive(win.lengthMs);
  if (stated !== undefined) return { ms: stated, source: 'stated' };

  const fromEnds = positive(win.startsAt === undefined ? undefined : win.resetsAt - win.startsAt);
  if (fromEnds !== undefined) return { ms: fromEnds, source: 'stated' };

  const configured = overrideMs(overrides[providerId]);
  if (configured !== undefined) return { ms: configured, source: 'configured' };

  const fromLabel = labelLengthMs(label);
  if (fromLabel !== undefined) return { ms: fromLabel, source: 'label' };

  const measured = positive(win.previous ? win.resetsAt - win.previous.resetsAt : undefined);
  if (measured !== undefined) return { ms: measured, source: 'measured' };

  return undefined;
}

/** `"weekly"` / `"monthly"` / a number of days. Anything else is ignored. */
export function overrideMs(raw: string | number | undefined): number | undefined {
  if (typeof raw === 'number') return raw > 0 ? raw * DAY : undefined;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (/^weekly$/i.test(trimmed)) return WEEK;
  if (/^monthly$/i.test(trimmed)) return MONTH;
  const days = Number(trimmed);
  return Number.isFinite(days) && days > 0 ? days * DAY : undefined;
}

/** The rung that reads a length out of the label the engine wrote. */
export function labelLengthMs(label: string): number | undefined {
  const numeric =
    match(label, /^(\d+)\s*-\s*minute/i, MINUTE) ??
    match(label, /^(\d+)\s*-\s*hour/i, HOUR) ??
    match(label, /^(\d+)\s*-\s*day/i, DAY) ??
    match(label, /^(\d+)\s*h\b/i, HOUR) ??
    match(label, /^(\d+)\s*d\b/i, DAY);
  if (numeric !== undefined) return numeric;
  if (/week/i.test(label)) return WEEK;
  if (/month|billing/i.test(label)) return MONTH;
  if (/dail/i.test(label)) return DAY;
  if (/session/i.test(label)) return 5 * HOUR;
  return undefined;
}

function match(label: string, re: RegExp, unit: number): number | undefined {
  const m = re.exec(label);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n * unit : undefined;
}

function positive(v: number | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** The shortest window this view will put on the shared axis. A 5-hour lane
 *  carries ten readings at most and is spent again before the user next opens
 *  the pane — still sampled and stored, just not a glide path. */
export const MIN_WINDOW_MS = DAY;

/** One reading per clock hour, last one in the hour wins. The raw series is
 *  not drawn because a burst of readings inside one minute zigzags like a
 *  spike that is only the sampler waking up. First and last raw readings are
 *  always kept, since rounding those to an hour boundary would move them. */
export function resampleHourly(samples: readonly GlideSample[]): GlideSample[] {
  const sorted = samples.slice().sort((a, b) => a.t - b.t);
  if (sorted.length === 0) return [];
  const byHour = new Map<number, GlideSample>();
  for (const s of sorted) byHour.set(Math.floor(s.t / HOUR), s);
  const out = [...byHour.values()];
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (out[0]!.t !== first.t) out.unshift(first);
  if (out[out.length - 1]!.t !== last.t) out.push(last);
  let seen = -Infinity;
  return out.filter((p) => {
    if (p.t <= seen) return false;
    seen = p.t;
    return true;
  });
}

/** Least squares, in percentage points per hour — not last-minus-first, since
 *  two readings either side of one busy afternoon would set the rate for a
 *  whole week. A fit over every hourly point is the slope the readings as a
 *  whole support. */
/** How many hours a sorted reading list covers. One reading covers nothing. */
export function spanHours(points: readonly GlideSample[]): number {
  return points.length < 2 ? 0 : (points[points.length - 1]!.t - points[0]!.t) / HOUR;
}

export function slopePerHour(points: readonly GlideSample[]): number {
  const n = points.length;
  if (n < 2) return 0;
  let sumT = 0;
  let sumP = 0;
  for (const p of points) {
    sumT += p.t;
    sumP += p.pct;
  }
  const meanT = sumT / n;
  const meanP = sumP / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    const a = p.t - meanT;
    num += a * (p.pct - meanP);
    den += a * a;
  }
  if (den === 0) return 0;
  const r = (num / den) * HOUR;
  return Number.isFinite(r) ? r : 0;
}

/**
 * The projection guard. A trend drawn through two hours of readings on a
 * seven-day window is a rumour, not a forecast — but holding every badge back
 * for a full 24 hours taught a user who opened the pane on a new window's
 * first morning nothing. So the guard has two bars, and every number it lets
 * through is worded with the bar it cleared:
 *  - firm: at least 10% of the window elapsed, 24 h of readings, 3 hourly points.
 *  - provisional: at least 4 h of readings and 3 hourly points (window share
 *    is a firm-only condition — a slope over four hours is the same slope
 *    whether those hours are 1% of a month or 10% of a day).
 *  - none below that: the card says which condition failed and how long until
 *    the next bar.
 * A provisional number is drawn faded, badged `~`, and called provisional
 * everywhere — a claim the readings support less, never one they don't support at all.
 */
export const GUARD = { MIN_FRAC: 0.1, MIN_HOURS: 24, MIN_POINTS: 3, PROVISIONAL_HOURS: 4 } as const;

/** How much the readings behind a projection support it. */
export type GlideTier = 'firm' | 'provisional' | 'none';

export interface GlideGuard {
  /** `tier !== 'none'` — there is a projection. Kept so old readers still work. */
  readonly ok: boolean;
  readonly tier: GlideTier;
  /** Why this is not FIRM. Empty at the firm tier and nowhere else. */
  readonly why: string;
}

export function guardOf(frac: number, readingHours: number, hourlyCount: number): GlideGuard {
  // Points first: two readings a day apart span 24 hours and still can't be
  // fitted; "only 2 readings" names that fault, "24 h of readings" hides it.
  if (hourlyCount < GUARD.MIN_POINTS) {
    return { ok: false, tier: 'none', why: `only ${hourlyCount} readings` };
  }
  if (readingHours < GUARD.PROVISIONAL_HOURS) {
    return {
      ok: false,
      tier: 'none',
      why: `only ${readingHours.toFixed(1)} h of readings (provisional at ${GUARD.PROVISIONAL_HOURS} h, firm at ${GUARD.MIN_HOURS} h)`,
    };
  }
  if (frac < GUARD.MIN_FRAC) {
    return {
      ok: true,
      tier: 'provisional',
      why: `window only ${Math.round(frac * 100)}% elapsed (needs ${Math.round(GUARD.MIN_FRAC * 100)}%)`,
    };
  }
  if (readingHours < GUARD.MIN_HOURS) {
    return { ok: true, tier: 'provisional', why: `only ${readingHours.toFixed(1)} h of readings (needs ${GUARD.MIN_HOURS} h)` };
  }
  return { ok: true, tier: 'firm', why: '' };
}

export type GlideStatus = 'ON TRACK' | 'AHEAD' | 'BEHIND' | 'TIGHT';

/**
 * The badge, from the projection at the reset alone — answers "where does
 * this land", not "where is it now":
 *  - lands over 105          -> AHEAD  (runs out before the reset)
 *  - lands between 95 and 105 -> TIGHT (finishes the window with no margin)
 *  - lands under 90          -> BEHIND (capacity will go unused)
 *  - otherwise               -> ON TRACK
 * No badge at all while the guard is closed.
 */
export function statusOf(projectedAtReset: number): GlideStatus {
  if (projectedAtReset > 105) return 'AHEAD';
  if (projectedAtReset >= 95) return 'TIGHT';
  if (projectedAtReset < 90) return 'BEHIND';
  return 'ON TRACK';
}

export interface GlideProjection {
  readonly slopePerHour: number;
  readonly atResetPct: number;
  /** Where in the window the pace reaches 100%, 0-1. Absent when it never does. */
  readonly exhaustFrac?: number;
  readonly unusedPct: number;
  /** Which bar of the guard these numbers cleared. See `GUARD`. */
  readonly basis: 'firm' | 'provisional';
  /** The rate came from the previous cycle, not this one — a window that reset
   *  an hour ago holds one reading and has no slope of its own. Only the rate
   *  is carried; the anchor is always this cycle's own last percentage. */
  readonly carried?: boolean;
}

/** One window, with everything the view needs to draw and word it. */
export interface GlideLane {
  readonly providerId: string;
  readonly name: string;
  readonly label: string;
  readonly colour: string;
  readonly resetsAt: number;
  readonly samples: readonly GlideSample[];
  /** The samples the LINE is drawn from — one per clock hour. */
  readonly hourly: readonly GlideSample[];
  readonly usedPct: number;
  /** Absent when no rung of the length ladder answered. */
  readonly lengthMs?: number;
  readonly lengthSource?: LengthSource;
  /** "7 d", "30 d", "31 d credits" — how long this window is, as the view says it. */
  readonly lengthLabel?: string;
  readonly windowStart?: number;
  /** Share of the window elapsed, 0-1. Absent with no known length. */
  readonly frac?: number;
  readonly fairPct?: number;
  readonly daysToReset: number;
  readonly msToReset: number;
  /** The span the readings COVER, in hours — not the window's age. */
  readonly readingHours: number;
  readonly reads: number;
  readonly slopePerHour: number;
  readonly guard: GlideGuard;
  /** Absent while the guard is closed. Nothing is forecast from too little. */
  readonly projection?: GlideProjection;
  /** Absent while the guard is closed — see `statusOf`. */
  readonly status?: GlideStatus;
  /** How old the newest reading is, in ms. -1 when there is none. */
  readonly sampledAgoMs: number;
  /** No rung of the ladder answered: this lane is off the shared axis. */
  readonly unknownPeriod: boolean;
  /** The stored reading belongs to a window that has already rolled over. */
  readonly expired: boolean;
}

export function laneOf(
  providerId: string,
  label: string,
  win: GlideWindow,
  now: number,
  colour: string,
  overrides: LengthOverrides = {},
): GlideLane {
  const samples = win.samples.slice().sort((a, b) => a.t - b.t);
  const last = samples[samples.length - 1];
  const first = samples[0];
  const usedPct = last?.pct ?? 0;
  const len = windowLength(providerId, label, win, overrides);
  const hourly = resampleHourly(samples);
  const readingHours = first && last ? (last.t - first.t) / HOUR : 0;
  // Past its own reset: the stored percentage belongs to a window that has
  // already rolled over, and dividing by an elapsed time longer than the
  // window would invert a spent window into a confident "BEHIND".
  const expired = now >= win.resetsAt;
  const windowStart = len === undefined ? undefined : win.resetsAt - len.ms;
  const frac =
    windowStart === undefined || len === undefined
      ? undefined
      : clamp01((now - windowStart) / len.ms);
  const slope = Math.max(0, slopePerHour(hourly));
  const msToReset = win.resetsAt - now;

  const measured: GlideGuard =
    len === undefined || expired
      ? { ok: false, tier: 'none', why: len === undefined ? 'the window period is unknown' : 'the window has already reset' }
      : guardOf(frac ?? 0, readingHours, hourly.length);

  // The rate survives a reset; the anchor does not. A reset empties the sample
  // list, so the last cycle's rate stands in until this cycle has four hours
  // of its own, then hands over whole — no blend, since a blend would be a
  // third number nobody measured.
  const prevHourly = resampleHourly(win.previous?.samples ?? []);
  const carried =
    measured.tier === 'none' &&
    len !== undefined &&
    !expired &&
    readingHours < GUARD.PROVISIONAL_HOURS &&
    spanHours(prevHourly) >= GUARD.PROVISIONAL_HOURS &&
    prevHourly.length >= GUARD.MIN_POINTS;
  const guard: GlideGuard = carried
    ? { ok: true, tier: 'provisional', why: 'rate carried from the last window' }
    : measured;
  const rate = carried ? Math.max(0, slopePerHour(prevHourly)) : slope;

  let projection: GlideProjection | undefined;
  let status: GlideStatus | undefined;
  if (guard.ok && len !== undefined && frac !== undefined) {
    const atResetPct = Math.max(0, Math.min(999, usedPct + rate * (msToReset / HOUR)));
    let exhaustFrac: number | undefined;
    if (rate > 0 && usedPct < 100) {
      const hoursToFull = (100 - usedPct) / rate;
      const reached = frac + (hoursToFull * HOUR) / len.ms;
      if (reached <= 1) exhaustFrac = reached;
    }
    projection = {
      slopePerHour: rate,
      atResetPct,
      ...(exhaustFrac !== undefined ? { exhaustFrac } : {}),
      unusedPct: Math.max(0, 100 - atResetPct),
      basis: guard.tier === 'firm' ? 'firm' : 'provisional',
      ...(carried ? { carried: true } : {}),
    };
    status = statusOf(atResetPct);
  }

  return {
    providerId,
    name: connectionName(providerId),
    label,
    colour,
    resetsAt: win.resetsAt,
    samples,
    hourly,
    usedPct,
    ...(len !== undefined
      ? { lengthMs: len.ms, lengthSource: len.source, lengthLabel: lengthLabelOf(label, len) }
      : {}),
    ...(windowStart !== undefined ? { windowStart } : {}),
    ...(frac !== undefined ? { frac, fairPct: frac * 100 } : {}),
    daysToReset: Math.max(0, msToReset / DAY),
    msToReset,
    readingHours,
    reads: samples.length,
    slopePerHour: slope,
    guard,
    ...(projection !== undefined ? { projection } : {}),
    ...(status !== undefined ? { status } : {}),
    sampledAgoMs: last ? Math.max(0, now - last.t) : -1,
    unknownPeriod: len === undefined,
    expired,
  };
}

/** How long this window is, in the words the legend and the cards use. */
export function lengthLabelOf(label: string, len: WindowLength): string {
  if (len.ms < DAY) return `${Math.round(len.ms / HOUR)} h`;
  const days = `${Math.round(len.ms / DAY)} d`;
  // A measured length names the window it was counted from, so "31 d" alone
  // doesn't read as a plan's stated period.
  return len.source === 'measured' ? `${days} ${label.toLowerCase()}` : days;
}

/**
 * Which window represents a connection: the weekly one, else the monthly one,
 * else the longest window whose length is known, never shorter than a day
 * (`MIN_WINDOW_MS`). One per connection: Claude's plan endpoint reports both
 * `seven_day` and `seven_day_opus`, which would otherwise draw as two lines of
 * the same colour under the same legend name. Weekly beats monthly (rather
 * than longest-wins) because a weekly window is the one a user can still act
 * on. A connection whose windows all lack a length still gets a lane — a true
 * card, just not drawn on the shared axis.
 */
export function pickWindowLabel(
  providerId: string,
  windows: Record<string, GlideWindow>,
  overrides: LengthOverrides = {},
): string | undefined {
  const all = Object.keys(windows);
  if (all.length === 0) return undefined;
  const sized = all
    .map((label) => ({ label, len: windowLength(providerId, label, windows[label]!, overrides) }))
    .filter((e): e is { label: string; len: WindowLength } => e.len !== undefined && e.len.ms >= MIN_WINDOW_MS);
  if (sized.length > 0) {
    return (
      sized.find((e) => e.len.ms === WEEK)?.label ??
      sized.find((e) => e.len.ms === MONTH)?.label ??
      sized.reduce((a, b) => (b.len.ms > a.len.ms ? b : a)).label
    );
  }
  // Nothing has a usable length: prefer a window not obviously a short lane,
  // so an unknown-period card is about the plan, not a 5-hour burst.
  return all.find((label) => (labelLengthMs(label) ?? Infinity) >= MIN_WINDOW_MS) ?? all[0];
}

/** One lane per connection, in provider order — one list for the chart, the
 *  cards, the Data tab and the insights, so the chart can't show a line the
 *  cards don't explain. */
export function connectionLanes(
  providers: GlideProviders,
  now: number,
  overrides: LengthOverrides = {},
): GlideLane[] {
  const out: GlideLane[] = [];
  Object.keys(providers).forEach((providerId, index) => {
    const windows = providers[providerId]?.windows ?? {};
    const label = pickWindowLabel(providerId, windows, overrides);
    if (label === undefined) return;
    out.push(laneOf(providerId, label, windows[label]!, now, colourFor(providerId, index), overrides));
  });
  return out;
}

/** The lanes that can be placed on the shared axis at all. */
export function plottable(lanes: readonly GlideLane[]): GlideLane[] {
  return lanes.filter((l) => !l.unknownPeriod && l.hourly.length > 0 && l.windowStart !== undefined);
}

/**
 * Where a moment sits on the shared axis: 0 at this window's own start, 1 at
 * its own reset. This is the whole point of the view — the axis is the
 * fraction of a window elapsed, so Copilot's month and Claude's week are the
 * same width on screen and both end at the same reset line, so the eye can
 * compare the one thing comparable between a week and a month: the slope.
 */
export function fractionOf(lane: GlideLane, t: number): number {
  if (lane.windowStart === undefined || lane.lengthMs === undefined || lane.lengthMs <= 0) return 0;
  return clamp01((t - lane.windowStart) / lane.lengthMs);
}

/** How long the whole window is, in days — the "of Y" in "day X of Y". */
export function windowDaysOf(lane: GlideLane): number {
  return lane.lengthMs === undefined ? 0 : lane.lengthMs / DAY;
}

/** Where a moment sits in DAYS of this window — for the words, not the geometry. */
export function elapsedDays(lane: GlideLane, t: number): number {
  return fractionOf(lane, t) * windowDaysOf(lane);
}

/** "7", "30", "31.5" — the window's length as the sentences spell it. */
export function windowDaysLabel(lane: GlideLane): string {
  const d = windowDaysOf(lane);
  return Number.isInteger(d) ? String(d) : d.toFixed(1);
}

/** The lane whose reset comes first — the one the header strip counts down. */
export function nearestReset(lanes: readonly GlideLane[]): GlideLane | undefined {
  return lanes.reduce<GlideLane | undefined>((a, b) => (a === undefined || b.resetsAt < a.resetsAt ? b : a), undefined);
}

export type InsightTone = 'ok' | 'warn' | 'bad' | 'info';

export interface GlideInsight {
  readonly id: string;
  readonly tone: InsightTone;
  readonly title: string;
  /** The connection the sentence is about, as the view labels it. */
  readonly source: string;
  readonly text: string;
}

const pt = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(0)}pt`;
const pct0 = (n: number) => `${Math.round(n)}%`;

/** "3.2 days", "5.0 hours", "18 minutes" — the largest unit that is not a decimal blur. */
export function formatSpan(ms: number): string {
  const abs = Math.max(0, ms);
  if (abs >= DAY) return `${(abs / DAY).toFixed(1)} days`;
  if (abs >= HOUR) return `${(abs / HOUR).toFixed(1)} hours`;
  return `${Math.round(abs / MINUTE)} minutes`;
}

/** Days to reset, always to one decimal — "0.4 d" says more than "0 d". */
export function formatDays(days: number): string {
  return `${Math.max(0, days).toFixed(1)} d`;
}

/** "12 min ago" / "3.1 h ago" / "never" — how stale a card's number is. */
export function formatAgo(ms: number): string {
  if (ms < 0) return 'never sampled';
  if (ms < HOUR) return `sampled ${Math.max(0, Math.round(ms / MINUTE))} min ago`;
  if (ms < DAY) return `sampled ${(ms / HOUR).toFixed(1)} h ago`;
  return `sampled ${(ms / DAY).toFixed(1)} d ago`;
}

/** The one extra fact a card states under its numbers, or nothing. */
export function cardTail(lane: GlideLane): string {
  if (lane.unknownPeriod) return 'period unknown — no provider stated one, and no second reset has been seen yet';
  if (lane.expired) return 'window has reset — waiting for a fresh reading';
  if (!lane.guard.ok) return `too early to project — ${lane.guard.why}`;
  const p = lane.projection!;
  // A provisional card says so instead of saying where it lands: the landing
  // number is on the chart already, and this line has room for one fact.
  if (p.carried) return 'provisional — rate carried from the last window';
  if (p.basis === 'provisional') {
    return `provisional (${lane.readingHours.toFixed(1)} h of readings, firms at ${GUARD.MIN_HOURS} h)`;
  }
  if (p.exhaustFrac !== undefined) return `empties at ${Math.round(p.exhaustFrac * 100)}% of the window`;
  return `projected ${pct0(p.atResetPct)} at reset · ${pct0(p.unusedPct)} unused`;
}

/** The deterministic insights, ordered by severity. Every one is a
 *  measurement, never advice — "you spent 61% of the window in its first
 *  quarter" stays true regardless of next month's plan; an instruction would
 *  go stale within a week. */
export function insightsFor(lanes: readonly GlideLane[]): GlideInsight[] {
  const unknown: GlideInsight[] = [];
  const blocked: GlideInsight[] = [];
  const front: GlideInsight[] = [];
  const spikes: GlideInsight[] = [];
  const exhaust: GlideInsight[] = [];
  const unused: GlideInsight[] = [];
  const pace: GlideInsight[] = [];

  // A lane with no period is named ONCE, as a row, rather than left to be
  // noticed as a missing line.
  const noPeriod = lanes.filter((l) => l.unknownPeriod);
  if (noPeriod.length > 0) {
    unknown.push({
      id: 'unknown-period',
      tone: 'warn',
      title: 'Window period unknown',
      source: noPeriod.map((l) => l.name).join(', '),
      text: `${noPeriod.length === 1 ? 'This connection reports' : 'These connections report'} a reset time and no period, so ${noPeriod.length === 1 ? 'it is' : 'they are'} kept off the shared axis rather than drawn against a guessed length. Set origamicoder.usage.windowLength to state the cadence, or wait for a second reset to be observed.`,
    });
  }

  const held = lanes.filter((l) => !l.unknownPeriod && !l.expired && !l.guard.ok);
  if (held.length > 0) {
    blocked.push({
      id: 'guard',
      tone: 'info',
      title: `Projection paused on ${held.length} of ${lanes.length} connections`,
      source: 'sampler',
      text: `A trend needs ${GUARD.MIN_HOURS} h of readings and ${Math.round(GUARD.MIN_FRAC * 100)}% of the window behind it. Blocked: ${held.map((l) => `${l.name} (${l.guard.why})`).join('; ')}.`,
    });
  }

  const soft = lanes.filter((l) => l.projection?.basis === 'provisional');
  if (soft.length > 0) {
    blocked.push({
      id: 'provisional',
      tone: 'info',
      title: `Provisional projection on ${soft.length} of ${lanes.length} connections`,
      source: 'sampler',
      text: `These rates sit under the firm bar and can still move: ${soft.map((l) => `${l.name} (${l.guard.why})`).join('; ')}. Each firms at ${GUARD.MIN_HOURS} h of readings with ${Math.round(GUARD.MIN_FRAC * 100)}% of the window behind it.`,
    });
  }

  for (const lane of lanes) {
    if (!lane.guard.ok || lane.lengthMs === undefined || lane.windowStart === undefined) continue;
    const key = `${lane.providerId}:${lane.label}`;
    const source = lane.name;
    const ofY = windowDaysLabel(lane);

    // 1. Front load — more than half the window's quota inside its first quarter.
    const quarterEnd = lane.windowStart + lane.lengthMs / 4;
    const inQuarter = lastPctAtOrBefore(lane.samples, quarterEnd);
    if (inQuarter !== undefined && inQuarter > 50) {
      front.push({
        id: `front:${key}`,
        tone: 'bad',
        title: 'Front-loaded burn',
        source,
        text: `${pct0(inQuarter)} of this window was already spent by day ${(windowDaysOf(lane) / 4).toFixed(1)} of ${ofY}, against a fair share of 25%.`,
      });
    }

    // 2. One spike per connection, and only a notable one: ten points is the
    // floor, since most steps are the ordinary sawtooth of half-hourly sampling.
    const spike = biggestDaySpike(lane.samples);
    if (spike && spike.delta >= SPIKE_FLOOR_PT) {
      spikes.push({
        id: `spike:${key}`,
        tone: spike.delta >= 25 ? 'bad' : 'warn',
        title: 'Biggest single-day spike',
        source,
        text: `${pt(spike.delta)} inside one day, ending on day ${elapsedDays(lane, spike.at).toFixed(1)} of ${ofY}.`,
      });
    }

    // 3 and 4 are the two halves of one question and are mutually exclusive.
    const p = lane.projection!;
    if (p.exhaustFrac !== undefined) {
      exhaust.push({
        id: `exhaust:${key}`,
        tone: 'bad',
        title: 'Projected exhaustion',
        source,
        text: `At ${p.slopePerHour.toFixed(2)} points per hour the window empties on day ${(p.exhaustFrac * windowDaysOf(lane)).toFixed(1)} of ${ofY} — ${formatSpan((1 - p.exhaustFrac) * lane.lengthMs)} before the reset.`,
      });
    } else {
      unused.push({
        id: `unused:${key}`,
        tone: 'info',
        title: 'Unused capacity at reset',
        source,
        text: `About ${pct0(p.unusedPct)} of this window is projected to go unused if the pace holds.`,
      });
    }

    // 5. Pace against the even burn, at this moment.
    if (lane.fairPct !== undefined) {
      const delta = lane.usedPct - lane.fairPct;
      pace.push({
        id: `pace:${key}`,
        tone: delta > 5 ? 'warn' : delta < -5 ? 'info' : 'ok',
        title: 'Pace against fair pace',
        source,
        text: `${pct0(lane.usedPct)} used against a fair pace of ${pct0(lane.fairPct)} — ${pt(delta)}.`,
      });
    }
  }

  // Ordered by severity, not category: the panel is read top-down. Sort is
  // stable, so within one tone the category order above survives.
  return [...unknown, ...blocked, ...front, ...spikes, ...exhaust, ...unused, ...pace].sort(
    (a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone],
  );
}

/** Points inside one day below which a "spike" is just sampling noise. */
export const SPIKE_FLOOR_PT = 10;

const TONE_RANK: Readonly<Record<InsightTone, number>> = { bad: 0, warn: 1, info: 2, ok: 3 };

/** The last percentage recorded at or before `t`, or nothing if none was. */
export function lastPctAtOrBefore(samples: readonly GlideSample[], t: number): number | undefined {
  let found: number | undefined;
  for (const s of samples) {
    if (s.t <= t) found = s.pct;
    else break;
  }
  return found;
}

/** The largest rise inside any 24-hour span, and when that span ended. A day,
 *  not a step: the largest step between two neighbouring readings measures the
 *  sampling interval, not the day's work. */
export function biggestDaySpike(
  samples: readonly GlideSample[],
): { delta: number; at: number } | undefined {
  if (samples.length < 2) return undefined;
  let best: { delta: number; at: number } | undefined;
  for (let j = 1; j < samples.length; j += 1) {
    const end = samples[j]!;
    let lowest = end.pct;
    for (let i = j - 1; i >= 0 && end.t - samples[i]!.t <= DAY; i -= 1) {
      lowest = Math.min(lowest, samples[i]!.pct);
    }
    const delta = end.pct - lowest;
    if (!best || delta > best.delta) best = { delta, at: end.t };
  }
  return best;
}

/** The value a connection had at a given point of its window, interpolated.
 *  `undefined` outside the measured span: the crosshair must say "no reading"
 *  rather than extend the last value flat across a week nobody sampled. */
export function valueAtFraction(lane: GlideLane, frac: number): number | undefined {
  const pts = lane.hourly;
  if (pts.length === 0 || lane.windowStart === undefined || lane.lengthMs === undefined) return undefined;
  const at = (p: GlideSample) => (p.t - lane.windowStart!) / lane.lengthMs!;
  const f0 = at(pts[0]!);
  const f1 = at(pts[pts.length - 1]!);
  if (frac < f0 || frac > f1) return undefined;
  for (let i = 1; i < pts.length; i += 1) {
    const a = at(pts[i - 1]!);
    const b = at(pts[i]!);
    if (frac <= b) {
      const k = b === a ? 0 : (frac - a) / (b - a);
      return pts[i - 1]!.pct + k * (pts[i]!.pct - pts[i - 1]!.pct);
    }
  }
  return pts[pts.length - 1]!.pct;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
