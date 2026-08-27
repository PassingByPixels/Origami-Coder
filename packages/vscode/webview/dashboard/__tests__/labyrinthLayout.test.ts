// labyrinthLayout — the three map geometries as pure functions. These assert
// the DEFINING property of each mode against the requirement, not against the
// implementation's arithmetic: thread must march monotonically down one spine,
// corridor must genuinely reverse direction every row (a plain wrap that
// always runs left->right would pass a naive "4 per row" test), and flight
// must place markers in PROPORTION to their timestamps — with an honest,
// stated fallback when the run carries no usable timing at all.

import { describe, it, expect } from 'vitest';
import {
  threadLayout, corridorLayout, flightLayout, flightIsTimeBased,
  layoutFor, viewBoxFor, stepGlyph, formatDuration, formatClock, truncate,
  laneFor, laneOffset, isThreshold, threadLabel, flightDetail,
  THREAD_LABEL_X, THREAD_LABEL_CHARS, DETAIL_CHARS,
  type LayoutStep,
} from '../components/labyrinthLayout';

const step = (ordinal: number, over: Partial<LayoutStep> = {}): LayoutStep => ({
  ordinal,
  kind: 'tool',
  title: `step ${ordinal}`,
  ...over,
});
const many = (n: number, over: (i: number) => Partial<LayoutStep> = () => ({})): LayoutStep[] =>
  Array.from({ length: n }, (_, i) => step(i, over(i)));

describe('threadLayout — one spine, strictly downward', () => {
  it('marches monotonically down a single x, in run order', () => {
    const pts = threadLayout(many(12));
    expect(pts).toHaveLength(12);
    expect(new Set(pts.map((p) => p.x)).size).toBe(1);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]!.y).toBeGreaterThan(pts[i - 1]!.y);
    }
    expect(pts.map((p) => p.step.ordinal)).toEqual([...Array(12).keys()]);
  });

  it('handles 0 and 1 steps', () => {
    expect(threadLayout([])).toEqual([]);
    expect(threadLayout([step(0)])).toHaveLength(1);
  });
});

// Written against the geometry it OBSERVES (how many markers share row 0)
// rather than against a hard-coded column count, so corridor can be retuned
// for density — which is its job, as the compact mode — without these turning
// into arithmetic edits. The property under test is the reversal itself.
describe('corridorLayout — boustrophedon, not a plain wrap', () => {
  const rowsOf = (pts: ReturnType<typeof corridorLayout>) =>
    [...new Set(pts.map((p) => p.y))].sort((a, b) => a - b).map((y) => pts.filter((p) => p.y === y));
  const colsOf = (pts: ReturnType<typeof corridorLayout>) => pts.filter((p) => p.y === pts[0]!.y).length;

  it('EVERY even row ascends in x and every odd row DESCENDS — the reversal alternates', () => {
    const rows = rowsOf(corridorLayout(many(30)));
    expect(rows.length).toBeGreaterThan(2); // more than a one-off reversal
    rows.forEach((row, r) => {
      for (let i = 1; i < row.length; i++) {
        if (r % 2 === 0) expect(row[i]!.x).toBeGreaterThan(row[i - 1]!.x);
        else expect(row[i]!.x).toBeLessThan(row[i - 1]!.x);
      }
    });
  });

  it('the snake TURNS at every row end — it never jumps the full width', () => {
    const pts = corridorLayout(many(30));
    const cols = colsOf(pts);
    for (let turn = cols; turn < pts.length; turn += cols) {
      expect(pts[turn]!.x).toBe(pts[turn - 1]!.x);
      expect(pts[turn]!.y).toBeGreaterThan(pts[turn - 1]!.y);
    }
  });

  it('a partial final row still starts where the previous row ended', () => {
    // Corridor is now the MINIMAP: its grid is sized from the run, so the
    // column count has to be read off the very layout under test — a count
    // borrowed from a different run length lands this assertion mid-row.
    const pts = corridorLayout(many(41));
    const cols = colsOf(pts);
    expect(pts.length % cols).not.toBe(0); // ...and the final row really is partial
    expect(pts[cols]!.x).toBe(pts[cols - 1]!.x);
    expect(pts[cols]!.y).toBeGreaterThan(pts[cols - 1]!.y);
  });

  it('handles 0 and 1 steps', () => {
    expect(corridorLayout([])).toEqual([]);
    expect(corridorLayout([step(0)])).toHaveLength(1);
  });
});

describe('flightLayout — positions by TIME when it honestly can', () => {
  it('spacing is proportional to the timestamps, not to the index', () => {
    // t = 0, 1000, 5000: the middle marker sits 20% along, not 50%.
    const pts = flightLayout([
      step(0, { startedAt: 1_000_000 }),
      step(1, { startedAt: 1_001_000 }),
      step(2, { startedAt: 1_005_000 }),
    ]);
    const span = pts[2]!.x - pts[0]!.x;
    expect(span).toBeGreaterThan(0);
    expect((pts[1]!.x - pts[0]!.x) / span).toBeCloseTo(0.2, 5);
  });

  it('all markers sit on one horizontal line', () => {
    const pts = flightLayout(many(6, (i) => ({ startedAt: 5_000 + i * 137 })));
    expect(new Set(pts.map((p) => p.y)).size).toBe(1);
  });

  it('falls back to EVEN spacing when a single step lacks a timestamp — mixing real and invented positions is worse than admitting we have no timing', () => {
    const steps = [
      step(0, { startedAt: 1_000_000 }),
      step(1),
      step(2, { startedAt: 1_005_000 }),
    ];
    expect(flightIsTimeBased(steps)).toBe(false);
    const pts = flightLayout(steps);
    expect((pts[1]!.x - pts[0]!.x) / (pts[2]!.x - pts[0]!.x)).toBeCloseTo(0.5, 5);
  });

  it('a run where NO step has a timestamp still renders, evenly spaced', () => {
    const pts = flightLayout(many(4));
    expect(pts).toHaveLength(4);
    const gaps = pts.slice(1).map((p, i) => p.x - pts[i]!.x);
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0]!, 5);
    expect(pts.every((p) => Number.isFinite(p.x))).toBe(true);
  });

  it('identical timestamps do not divide by zero — it degrades to even spacing', () => {
    const pts = flightLayout(many(3, () => ({ startedAt: 42 })));
    expect(flightIsTimeBased(many(3, () => ({ startedAt: 42 })))).toBe(false);
    expect(pts.every((p) => Number.isFinite(p.x))).toBe(true);
    expect(pts[0]!.x).toBeLessThan(pts[1]!.x);
  });

  it('handles 0 and 1 steps', () => {
    expect(flightLayout([])).toEqual([]);
    const one = flightLayout([step(0, { startedAt: 5 })]);
    expect(one).toHaveLength(1);
    expect(Number.isFinite(one[0]!.x)).toBe(true);
  });
});

describe('viewBoxFor — the READING views grow with the run; the minimap does not', () => {
  it('thread grows taller and flight wider, while corridor holds one fixed canvas', () => {
    expect(viewBoxFor('thread', 200).height).toBeGreaterThan(viewBoxFor('thread', 10).height);
    expect(viewBoxFor('flight', 200).width).toBeGreaterThan(viewBoxFor('flight', 2).width);
    // Corridor was rebuilt AS the minimap. A canvas that grew per row is
    // exactly what forced a long run to scroll and hid it from the reader; the
    // markers shrink now instead. See labyrinthMinimap.test.ts for the fit.
    expect(viewBoxFor('corridor', 400)).toEqual(viewBoxFor('corridor', 10));
  });

  it('an empty run still yields a positive box (nothing to divide by zero)', () => {
    for (const mode of ['thread', 'corridor', 'flight'] as const) {
      const box = viewBoxFor(mode, 0);
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
    }
  });

  it('every laid-out marker for a long run falls inside its own viewBox', () => {
    for (const mode of ['thread', 'corridor', 'flight'] as const) {
      const steps = many(97, (i) => ({ startedAt: 1_000 + i * i }));
      const box = viewBoxFor(mode, steps.length);
      for (const p of layoutFor(mode, steps)) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(box.width);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(box.height);
      }
    }
  });
});

// stepGlyph was three values (normal/decision/error) and could not tell a
// prompt from a reply from a tool — the "every step is an identical circle"
// complaint. Broadened to one tone per kind; the two properties its old tests
// pinned are carried over unchanged: a failure always outranks its kind, and a
// subagent is never confusable with an ordinary step.
describe('stepGlyph — one tone per kind, with failure outranking kind', () => {
  it('an error kind OR an error status reads as a failure', () => {
    expect(stepGlyph(step(0, { kind: 'error' }))).toBe('error');
    expect(stepGlyph(step(0, { status: 'error' }))).toBe('error');
  });
  it('a subagent spawn is its own tone, distinct from every ordinary step', () => {
    expect(stepGlyph(step(0, { kind: 'subagent' }))).toBe('subagent');
    for (const kind of ['prompt', 'reply', 'tool', 'thinking'] as const) {
      expect(stepGlyph(step(0, { kind }))).not.toBe('subagent');
    }
  });
  it('a failed subagent reads as a FAILURE, not as a routing point', () => {
    expect(stepGlyph(step(0, { kind: 'subagent', status: 'error' }))).toBe('error');
  });
  it('the four everyday kinds each get their OWN tone — no two collide', () => {
    const tones = (['prompt', 'reply', 'tool', 'thinking'] as const).map((kind) =>
      stepGlyph(step(0, { kind, status: 'completed' })),
    );
    expect(new Set(tones).size).toBe(4);
    expect(tones).toEqual(['prompt', 'reply', 'tool', 'thinking']);
  });
});

// THREADS ARE LANES (mockup 30-map.js:12-17): the thread a step belongs to
// decides its offset from the spine. These assert the requirement — a tool
// juts one way, a sub-agent the other, main stays on the line — rather than
// the arithmetic, so the pixel constants can move without rewriting them.
// DEPTH now outranks kind (see labyrinthBranches.test.ts for the branch model
// itself); what remains here is which SIDE each lane is on.
describe('lanes — at depth 0 a step’s kind decides which side of the spine it sits', () => {
  it('tool -> tools, subagent -> delegation, everything else -> main', () => {
    expect(laneFor(step(0, { kind: 'tool' }))).toBe('tools');
    expect(laneFor(step(0, { kind: 'subagent' }))).toBe('delegation');
    for (const kind of ['prompt', 'reply', 'thinking', 'error'] as const) {
      expect(laneFor(step(0, { kind }))).toBe('main');
    }
  });

  it('a tool sits RIGHT of a prompt and a subagent LEFT of it, on the same spine', () => {
    const pts = threadLayout([
      step(0, { kind: 'prompt' }),
      step(1, { kind: 'tool' }),
      step(2, { kind: 'subagent' }),
      step(3, { kind: 'reply' }),
    ]);
    const [prompt, tool, sub, reply] = pts as [typeof pts[0], typeof pts[0], typeof pts[0], typeof pts[0]];
    expect(tool.x).toBeGreaterThan(prompt.x);
    expect(sub.x).toBeLessThan(prompt.x);
    // ...and the two main-lane steps really do share the one spine.
    expect(reply.x).toBe(prompt.x);
    // The run still reads top-to-bottom in order — lanes move x, never y.
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.y).toBeGreaterThan(pts[i - 1]!.y);
  });

  it('laneOffset is signed: + for tools, - for delegation, 0 on main', () => {
    expect(laneOffset(step(0, { kind: 'tool' }))).toBeGreaterThan(0);
    expect(laneOffset(step(0, { kind: 'subagent' }))).toBeLessThan(0);
    expect(laneOffset(step(0, { kind: 'reply' }))).toBe(0);
  });

  it('a step with NO depth lays out exactly like depth 0 — the field is optional', () => {
    const bare = step(0, { kind: 'tool' });
    expect(bare.depth).toBeUndefined();
    expect(laneOffset(bare)).toBe(laneOffset(step(0, { kind: 'tool', depth: 0 })));
    // A whole run of depth-less steps still lays out (no NaN leaking into x).
    expect(threadLayout(many(6)).every((p) => Number.isFinite(p.x))).toBe(true);
  });

  it('when depth IS present it outranks kind — a delegated step is delegation, whatever it is', () => {
    // This is the round-2 defect in one assertion: a sub-agent's steps arrive
    // as ordinary kinds with depth, and kind-first lanes put them on the spine.
    for (const kind of ['prompt', 'reply', 'thinking', 'tool', 'error'] as const) {
      expect(laneFor(step(0, { kind, depth: 1 }))).toBe('delegation');
      expect(laneOffset(step(0, { kind, depth: 1 }))).toBeLessThan(0);
    }
  });

  it('a junk depth degrades to 0 rather than throwing a marker off the canvas', () => {
    const base = laneOffset(step(0, { kind: 'tool' }));
    for (const depth of [Number.NaN, Number.POSITIVE_INFINITY, -3]) {
      expect(laneOffset(step(0, { kind: 'tool', depth }))).toBe(base);
    }
    // A runaway nesting chain is clamped, not allowed to walk off the viewBox.
    const box = viewBoxFor('thread', 1);
    const pts = threadLayout([step(0, { kind: 'tool', depth: 99 }), step(1, { kind: 'subagent', depth: 99 })]);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(box.width);
    }
  });

  it('flight turns the same lanes into rows: tools above the baseline, delegation below', () => {
    const pts = flightLayout([
      step(0, { kind: 'reply', startedAt: 10 }),
      step(1, { kind: 'tool', startedAt: 20 }),
      step(2, { kind: 'subagent', startedAt: 30 }),
    ]);
    const [main, tool, sub] = pts as [typeof pts[0], typeof pts[0], typeof pts[0]];
    expect(tool.y).toBeLessThan(main.y);
    expect(sub.y).toBeGreaterThan(main.y);
    // x is still driven by time, not by lane.
    expect(tool.x).toBeGreaterThan(main.x);
  });
});

// The mockup's `thresholds` thread (50-surfaces.js:389) — boundary events only.
// This engine emits no permission/redaction step, so a threshold here is
// exactly a failure; the test pins that it is neither wider (title sniffing)
// nor narrower (missing the status-only case) than the data supports.
describe('isThreshold — boundary events, and nothing invented', () => {
  it('true for an errored step, false for a plain completed one', () => {
    expect(isThreshold(step(0, { kind: 'error' }))).toBe(true);
    expect(isThreshold(step(0, { kind: 'tool', status: 'error' }))).toBe(true);
    expect(isThreshold(step(0, { kind: 'tool', status: 'completed' }))).toBe(false);
  });

  it('a step is not a threshold merely for SAYING "permission" — the engine emits no such step', () => {
    expect(isThreshold(step(0, { kind: 'tool', tool: 'bash', title: 'permission requested for rm' }))).toBe(false);
  });

  it('a step with no status at all is not a threshold (absent is not failed)', () => {
    const bare = step(0, { kind: 'reply' });
    expect(bare.status).toBeUndefined();
    expect(isThreshold(bare)).toBe(false);
  });
});

describe('formatters — an absent value never prints as a zero', () => {
  it('formatDuration returns undefined for missing/invalid input, never "0ms"', () => {
    expect(formatDuration(undefined)).toBeUndefined();
    expect(formatDuration(Number.NaN)).toBeUndefined();
    expect(formatDuration(-5)).toBeUndefined();
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });

  it('formatClock returns undefined for a missing timestamp and HH:MM:SS otherwise', () => {
    expect(formatClock(undefined)).toBeUndefined();
    expect(formatClock(Number.NaN)).toBeUndefined();
    const t = new Date(2026, 6, 28, 9, 5, 3).getTime();
    expect(formatClock(t)).toBe('09:05:03');
  });

  it('truncate only shortens what actually overflows', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
});

// The map ran out of its panel: the thread row's label was assembled as
// `kind: tool — <title truncated to 36>`, so only the TITLE was capped. A long
// MCP tool id then pushed the line straight past the viewBox, where the SVG
// viewport cut it mid-word with no ellipsis to admit it had.
describe('threadLabel — the whole line is budgeted, not just the title', () => {
  it('a huge tool name cannot push the line past its budget', () => {
    const monster = {
      kind: 'tool',
      tool: 'mcp__blender__generate_hyper3d_model_via_images',
      title: 'generate a hyper3d model from the four reference images',
    };
    const label = threadLabel(monster, THREAD_LABEL_CHARS);
    expect(label.length).toBeLessThanOrEqual(THREAD_LABEL_CHARS);
    expect(label.endsWith('…')).toBe(true);
    // The old rule capped the title alone; that line was 90+ characters.
    expect(`${monster.kind}: ${monster.tool} — ${truncate(monster.title, 36)}`.length)
      .toBeGreaterThan(THREAD_LABEL_CHARS);
  });

  it('the budget really fits the column — label start + its width stays inside the viewBox', () => {
    const width = viewBoxFor('thread', 10).width;
    // 8.4px/char is the over-estimate the budget is derived from; a label that
    // fits at that advance fits at any real monospace advance.
    expect(THREAD_LABEL_X + THREAD_LABEL_CHARS * 8.4).toBeLessThanOrEqual(width);
    expect(THREAD_LABEL_CHARS).toBeGreaterThan(20); // ...and still worth reading
  });

  it('a short line is left alone — no gratuitous ellipsis', () => {
    expect(threadLabel({ kind: 'reply', title: 'done' }, THREAD_LABEL_CHARS)).toBe('reply — done');
  });
});

// The three modes were doing one job in three shapes. Thread reads, corridor
// packs, flight details — these pin the difference so a retune cannot quietly
// collapse them back into each other.
describe('the three modes have three distinct jobs', () => {
  it('corridor is the COMPACT one: far more steps per unit height than thread', () => {
    const n = 48;
    expect(viewBoxFor('corridor', n).height * 3).toBeLessThan(viewBoxFor('thread', n).height);
  });

  it('flight is the DETAIL one: it is the roomiest per step and gets a taller canvas', () => {
    const per = (m: 'thread' | 'corridor' | 'flight') =>
      (viewBoxFor(m, 12).width * viewBoxFor(m, 12).height) / 12;
    expect(per('flight')).toBeGreaterThan(per('thread'));
    expect(per('flight')).toBeGreaterThan(per('corridor'));
    // This used to compare the two canvases' raw heights at ONE step, which
    // corridor's raise to 620 (owner's UAT — it was leaving the panel's lower
    // half empty) inverted. That comparison was never the distinction anyway:
    // room per step is, and the assertions above carry it. What separates the
    // two SHAPES is that flight's box grows for the run it is drawing — wider
    // per step, taller per lane — and corridor's is fixed forever, which is
    // what makes it the one view that shows a whole run at once.
    expect(viewBoxFor('flight', 40).width).toBeGreaterThan(viewBoxFor('flight', 4).width);
    expect(viewBoxFor('flight', 4, 3).height).toBeGreaterThan(viewBoxFor('flight', 4).height);
    expect(viewBoxFor('corridor', 400)).toEqual(viewBoxFor('corridor', 4));
  });

  it('flightDetail lists only the rows a step actually HAS', () => {
    const bare = flightDetail({ kind: 'thinking' });
    expect(bare).toEqual(['thinking']);
    const full = flightDetail({
      kind: 'tool', tool: 'read', status: 'completed', durationMs: 1500,
      tokens: { input: 120, output: 40 }, agent: 'build', model: 'lmstudio/qwen3',
    });
    expect(full).toContain('tool · read');
    expect(full).toContain('completed');
    expect(full).toContain('1.5s');
    expect(full).toContain('120/40 tok');
    expect(full).toContain('build'); // the agent outranks the model
    expect(full.join(' ')).not.toContain('undefined');
    expect(full.every((row) => row.length <= DETAIL_CHARS)).toBe(true);
  });

  it('flightDetail never fabricates a zero for an absent measurement', () => {
    const rows = flightDetail({ kind: 'reply', durationMs: undefined, tokens: undefined });
    expect(rows.join(' ')).not.toMatch(/\b0\b/);
    expect(rows).toEqual(['reply']);
  });
});
