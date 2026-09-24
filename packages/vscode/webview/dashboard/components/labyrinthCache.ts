// What the prompt cache did, and where it was lost.
//
// A single hit-ratio percentage cannot say why the cache went cold at one
// point in the run. The ENGINE now records the cause on the step itself
// (0.4.160+, t-rylq3t) — this file reads that field first and prints it
// verbatim. Only for a step recorded before the field existed does it fall
// back to deriving a cause from the run's own numbers, and that fallback is
// labelled as the viewer's own guess, never presented as what the engine said.
//
// Two causes are derived, not guessed, on EITHER path: context compaction
// (read off the step's own `kind`), and a cache-blind provider that bills a
// prefill but reports cache read/write 0 on every call (which would otherwise
// read as a string of losses).

import { cacheBlindness, isCacheBlind, prefilled, providerOf } from './labyrinthCacheBlind';
import { finiteTime } from './labyrinthSpans';
import type { CacheCause, UsageStep } from './labyrinthUsage';

export { cacheBlindness, isCacheBlind } from './labyrinthCacheBlind';
export type { CacheBlindness } from './labyrinthCacheBlind';
// The one-sentence-per-cause formatter is its own file (labyrinthCacheText.ts):
// this file DERIVES a loss, that one only ever FORMATS one already derived.
export { lossReasonText, lossFactsText } from './labyrinthCacheText';

/** True when any step reported cache tokens; false means unmeasured, not cold. */
export function cacheIsMeasured(steps: readonly UsageStep[]): boolean {
  return steps.some((s) => s.tokens?.cache?.read !== undefined || s.tokens?.cache?.write !== undefined);
}

/** One user turn's cache picture. `ratio` is absent with no billed prefill. */
export interface CacheTurn {
  /** The prompt step's ordinal; -1 for work that ran before the first prompt. */
  ordinal: number;
  title: string;
  startedAt?: number;
  input: number;
  read: number;
  write: number;
  ratio?: number;
  /** Every billed step in this turn is cache-blind; the bar renders fresh-only. */
  blind?: true;
}

/** Cache read/write per user turn, in run order. A turn is a depth-0
 *  `prompt` plus everything until the next one, including spliced sub-agent steps. */
export function cacheTurns(steps: readonly UsageStep[]): CacheTurn[] {
  const blind = cacheBlindness(steps).models;
  const out: CacheTurn[] = [];
  /** Billed steps per turn, and how many of those nobody measured. */
  const billed: number[] = [];
  const dark: number[] = [];
  let open: CacheTurn | undefined;
  const start = (ordinal: number, title: string, startedAt: number | undefined): CacheTurn => {
    const turn: CacheTurn = { ordinal, title, input: 0, read: 0, write: 0, ...(startedAt === undefined ? {} : { startedAt }) };
    out.push(turn);
    billed.push(0);
    dark.push(0);
    return turn;
  };
  for (const step of steps) {
    if (step.kind === 'prompt' && (step.depth ?? 0) === 0) {
      open = start(step.ordinal, step.title, finiteTime(step.startedAt));
    }
    const t = step.tokens;
    if (!t) continue;
    if (!open) open = start(-1, 'Before the first prompt', finiteTime(step.startedAt));
    open.input += t.input;
    open.read += t.cache?.read ?? 0;
    open.write += t.cache?.write ?? 0;
    // `open` is always the LAST turn pushed, so the counters stay aligned.
    if (prefilled(step)) {
      billed[out.length - 1] += 1;
      if (isCacheBlind(step, blind)) dark[out.length - 1] += 1;
    }
  }
  out.forEach((turn, i) => {
    // A turn nobody measured has no ratio, so it renders as blind, not 0%.
    if (billed[i]! > 0 && billed[i] === dark[i]) {
      turn.blind = true;
      return;
    }
    const prefill = turn.input + turn.read;
    if (prefill > 0) turn.ratio = turn.read / prefill;
  });
  return out;
}

/** Why a LEGACY prefill (no engine-recorded `cache` field) was billed fresh.
 *  Each one is DERIVED from the run's own numbers, without a cache-window
 *  table: `idle`/`ttl` is not one of them any more — the window it needs lived
 *  in the client's own policy table, which is deleted (t-rylq3t): the engine
 *  is the one source of that fact now, and a run old enough to have no `cache`
 *  field predates the engine sending it too. */
export type CacheLossReason = 'cold' | 'model' | 'compaction';

/** Facts an ENGINE-recorded cause was derived from. Every member is present
 *  only when the engine measured it — never zeroed, never invented. */
export interface CacheLossFacts {
  idleMs?: number;
  ttlSeconds?: number;
  warmed?: boolean;
  divergence?: { message: number; role: string; source?: 'tool-aging' | 'reminder' | 'plugin' | 'unknown' };
}

export interface CacheLoss {
  /** The step whose prefill was fresh — where the marker goes on the axis. */
  ordinal: number;
  index: number;
  startedAt?: number;
  /** Fresh input tokens this cost. */
  input: number;
  /** Present when the ENGINE recorded the cause (0.4.160+, `step.cache.cause`).
   *  When set, `reasons` is empty and unused — the cause is read, not derived. */
  cause?: CacheCause;
  /** Alongside an engine `cause`: the facts it was derived from. */
  facts?: CacheLossFacts;
  /** The provider half of the step's model, for the `provider` cause's local-lane note. */
  provider?: string;
  /** LEGACY derivation (see `CacheLossReason`) — populated only when the step
   *  carries no engine-recorded `cache` field. Every reason the data supports
   *  is collected, not ranked. Empty on an engine-recorded loss. */
  reasons: CacheLossReason[];
  /** This is a Claude Code transcript run — the CLI never attaches an engine
   *  cause, so the four-rule guess never runs for it either; `reasons` stays
   *  empty and unused, same as on an engine-recorded loss. */
  claude?: true;
  /** This step's own `tokens.cache` is absent — the provider reported no
   *  cache measurement for this request, as distinct from a measured miss
   *  (`cache.read` present and 0). `reasons` stays empty: a guess needs a
   *  number to guess from, and this one has none. */
  unmeasured?: true;
  /** The model that stopped and the one that started, on a legacy `model` loss,
   *  or on an engine `model` loss where the previous step's model is known. */
  from?: string;
  to?: string;
}

/** Where the cache was lost: a billed prefill that read nothing from cache
 *  in a run where the provider does report cache tokens. `step.cache.cause`
 *  is read when present (engine-recorded, 0.4.160+); the four legacy rules run
 *  only for a step with no `cache` field at all, and only for an ENGINE run —
 *  `claudeRun` true (a Claude Code transcript, which never carries an engine
 *  cause) skips the guess outright rather than mistake "the CLI didn't send
 *  one" for "this run predates the field". */
export function cacheLosses(steps: readonly UsageStep[], claudeRun = false): CacheLoss[] {
  if (!cacheIsMeasured(steps)) return [];
  const blind = cacheBlindness(steps).models;
  const out: CacheLoss[] = [];
  let previous: number | undefined;
  /** A compaction seen since the last prefill that was accounted for — legacy path only. */
  let compacted = false;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.kind === 'compaction') { compacted = true; continue; }
    if (!prefilled(step)) continue;
    // A blind provider's turn stays excluded, so idle measurement stays clean.
    if (isCacheBlind(step, blind)) continue;

    const startedAt = finiteTime(step.startedAt);

    // ENGINE-RECORDED: `cache` is written on every measured step, hit or miss —
    // a cause means a miss; no cause on a measured step means a hit.
    if (step.cache) {
      if (step.cache.cause === undefined) { previous = i; compacted = false; continue; }
      const before = previous !== undefined ? steps[previous] : undefined;
      const loss: CacheLoss = {
        ordinal: step.ordinal, index: i, input: step.tokens!.input,
        cause: step.cache.cause,
        reasons: [],
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(step.model ? { provider: providerOf(step.model) } : {}),
        ...(before?.model && step.model && before.model !== step.model ? { from: before.model, to: step.model } : {}),
      };
      const facts: CacheLossFacts = {
        ...(step.cache.idleMs === undefined ? {} : { idleMs: step.cache.idleMs }),
        ...(step.cache.ttlSeconds === undefined ? {} : { ttlSeconds: step.cache.ttlSeconds }),
        ...(step.cache.warmed === undefined ? {} : { warmed: step.cache.warmed }),
        ...(step.cache.divergence === undefined ? {} : {
          divergence: {
            message: step.cache.divergence.message, role: step.cache.divergence.role,
            ...(step.cache.divergence.source === undefined ? {} : { source: step.cache.divergence.source }),
          },
        }),
      };
      if (Object.keys(facts).length > 0) loss.facts = facts;
      out.push(loss);
      previous = i; compacted = false;
      continue;
    }

    // LEGACY / CLAUDE CODE: no engine-recorded `cache` block. `noMeasurement`
    // is the step's OWN `tokens.cache` being absent — this one request reported
    // no cache data at all, as opposed to a measured `read: 0` — and it can
    // happen on an otherwise-reporting model, so it is checked per step, not
    // via the run-wide `cacheBlindness` (which only excuses a model that NEVER
    // once reports).
    const noMeasurement = step.tokens?.cache === undefined;
    const read = step.tokens?.cache?.read ?? 0;
    if (!noMeasurement && read > 0) { previous = i; compacted = false; continue; }

    const reasons: CacheLossReason[] = [];
    const loss: CacheLoss = {
      ordinal: step.ordinal, index: i, input: step.tokens!.input, reasons,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(claudeRun ? { claude: true } : noMeasurement ? { unmeasured: true } : {}),
    };
    // Neither a Claude Code row nor an unmeasured one has a number to guess
    // from, so the four-rule derivation runs only for a genuine engine miss.
    if (!claudeRun && !noMeasurement) {
      // Consumed by the first loss only, so one compaction is never blamed twice.
      if (compacted) { reasons.push('compaction'); compacted = false; }
      if (previous === undefined) reasons.push('cold');
      else {
        const before = steps[previous]!;
        if (before.model && step.model && before.model !== step.model) {
          reasons.push('model');
          loss.from = before.model;
          loss.to = step.model;
        }
      }
    }
    out.push(loss);
    previous = i;
  }
  return out;
}

