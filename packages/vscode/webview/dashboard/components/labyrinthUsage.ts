// What a run SPENT: totals per sub-agent branch, per agent, and for the run.
// Pure, like labyrinthLanes / labyrinthSpans / labyrinthCollide: every rule
// below is testable with no DOM.
//
// Never invent a number: a step with no recorded usage contributes nothing
// and prints nothing, never a 0 (which would read as a free turn). A real
// 0 is kept. Never present a short total as complete: `usageMissing` steps,
// truncation, and unexpanded delegated runs make the sum a floor only —
// each sets `approximate` and says why. Nothing is derived from text length.

import { branchModel, type BranchStep } from './labyrinthBranches';

/** Why a step read nothing from the provider's prefix cache, as the ENGINE
 *  recorded it — mirrors `RunStepCacheCause` in `src/acpExtTypes.ts` (declared
 *  here rather than imported: tsconfig.webview.json pins rootDir to `webview/`).
 *  Absent on a run recorded before 0.4.160, and on a cache-blind provider. */
export type CacheCause =
  | 'cold'
  | 'model'
  | 'compaction'
  | 'idle'
  | 'system'
  | 'tools'
  | 'history'
  | 'provider'
  | 'small';

/** Mirrors `RunStepCache` — see the field-by-field comments there. */
export interface CacheFacts {
  cause?: CacheCause;
  preserved?: boolean;
  divergence?: { message: number; role: string; offset: number; source?: 'tool-aging' | 'reminder' | 'plugin' | 'unknown' };
  idleMs?: number;
  ttlSeconds?: number;
  warmed?: boolean;
}

/** The part of a step the usage rules read. `LayoutStep` satisfies it. */
export interface UsageStep extends BranchStep {
  title: string;
  agent?: string;
  model?: string;
  childSessionId?: string;
  tokens?: { input: number; output: number; reasoning?: number; cache?: { read?: number; write?: number } };
  cost?: number;
  usageMissing?: true;
  /** ENGINE-recorded cache facts for this step (0.4.160+). Absent means the
   *  engine measured none — a legacy run, or a cache-blind provider. */
  cache?: CacheFacts;
}

export interface UsageTotal {
  /** Steps that contributed recorded usage. 0 = there is nothing to show. */
  counted: number;
  /** Steps whose message recorded NO usage — each one an undercount. */
  missing: number;
  /** True when this total is a floor rather than the real spend. */
  approximate: boolean;
  /** Absent when NO contributing step carried the field — never zeroed. */
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  /** The headline count: input + output + reasoning + cache read. This
   *  matches exactly how the engine composes its own `tokens.total`.
   *  Cache WRITE is excluded, for the same reason the engine excludes it. */
  tokens?: number;
}

export interface BranchUsage {
  first: number;
  title: string;
  total: UsageTotal;
}

export interface AgentUsage {
  agent: string;
  total: UsageTotal;
}

export interface UsageBreakdown {
  run: UsageTotal;
  /** The trunk's own spend — its own turns, and the `task` calls it made. */
  main: UsageTotal;
  /** One per delegated stretch; `main` plus these partition `run` exactly. */
  branches: BranchUsage[];
  /** Biggest spender first. Steps with no `agent` bucket under `unknown`. */
  agents: AgentUsage[];
  /** Why `run.approximate` is true, in words. Empty when the total is complete. */
  caveats: string[];
}

/** A bucket with nothing in it. labyrinthCost.ts starts from the same empty bucket. */
export const emptyUsage = (): UsageTotal => ({ counted: 0, missing: 0, approximate: false });

/** `a + b` where an absent side stays absent — 0 + undefined must not become 0. */
function add(a: number | undefined, b: number | undefined): number | undefined {
  if (b === undefined) return a;
  return (a ?? 0) + b;
}

/**
 * Adds one step into a bucket. The single summation in the Labyrinth:
 * labyrinthCost.ts's per-model split reuses it rather than keeping a
 * second copy, which is how two surfaces would end up disagreeing.
 */
export function accumulateUsage(into: UsageTotal, step: UsageStep): void {
  if (step.usageMissing) into.missing++;
  const t = step.tokens;
  if (t === undefined && step.cost === undefined) return;
  into.counted++;
  into.cost = add(into.cost, step.cost);
  if (!t) return;
  into.input = add(into.input, t.input);
  into.output = add(into.output, t.output);
  into.reasoning = add(into.reasoning, t.reasoning);
  into.cacheRead = add(into.cacheRead, t.cache?.read);
  into.cacheWrite = add(into.cacheWrite, t.cache?.write);
  into.tokens = (into.tokens ?? 0) + t.input + t.output + (t.reasoning ?? 0) + (t.cache?.read ?? 0);
}

export interface UsageContext {
  /** The engine capped the list, so steps past the cap are missing outright. */
  truncated?: boolean;
}

export function usageBreakdown(steps: readonly UsageStep[], ctx: UsageContext = {}): UsageBreakdown {
  const model = branchModel(steps);
  const run = emptyUsage();
  const main = emptyUsage();
  const byBranch = new Map<number, UsageTotal>();
  const byAgent = new Map<string, UsageTotal>();

  steps.forEach((step, i) => {
    accumulateUsage(run, step);
    // `host` is the branch whose agent produced the step, not the sub-agent it started.
    const host = model.host[i] ?? -1;
    if (host < 0) accumulateUsage(main, step);
    else {
      const total = byBranch.get(host) ?? emptyUsage();
      accumulateUsage(total, step);
      byBranch.set(host, total);
    }
    const key = step.agent || 'unknown';
    const agent = byAgent.get(key) ?? emptyUsage();
    accumulateUsage(agent, step);
    byAgent.set(key, agent);
  });

  // A delegated run the caller never fetched contributes nothing, and its
  // spawn is the only trace of it — so a "complete" total would drop it.
  const unexpanded = model.spans.filter(
    (s) => steps[s.first]?.childSessionId && !steps.some((_, i) => model.host[i] === s.first),
  ).length;

  const caveats: string[] = [];
  if (ctx.truncated) caveats.push('the run is truncated — steps past the engine cap are not counted');
  if (run.missing > 0) {
    caveats.push(`${run.missing} step${run.missing === 1 ? '' : 's'} recorded no usage`);
  }
  if (unexpanded > 0) {
    caveats.push(`${unexpanded} delegated run${unexpanded === 1 ? ' was' : 's were'} not expanded`);
  }
  const short = caveats.length > 0;
  for (const total of [run, main, ...byBranch.values(), ...byAgent.values()]) {
    total.approximate = total.missing > 0;
  }
  // Truncation and unexpanded branches are RUN-level facts: they say the list
  // itself is short, which no per-bucket count can see.
  run.approximate = run.approximate || short;

  const branches: BranchUsage[] = model.spans
    .filter((s) => byBranch.has(s.first))
    .map((s) => ({ first: s.first, title: steps[s.first]?.title ?? '', total: byBranch.get(s.first)! }));

  const agents: AgentUsage[] = [...byAgent.entries()]
    .filter(([, total]) => total.counted > 0 || total.missing > 0)
    .map(([agent, total]) => ({ agent, total }))
    .sort((a, b) => (b.total.tokens ?? 0) - (a.total.tokens ?? 0) || a.agent.localeCompare(b.agent));

  return { run, main, branches, agents, caveats };
}

/** 1234 -> "1,234"; 1_250_000 -> "1.25M". Exact below 10k, where exact is readable. */
export function formatTokenCount(n: number | undefined): string | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  if (Math.abs(n) < 10_000) return n.toLocaleString();
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** A cost we can print. A genuine 0 stays "$0"; an absent cost stays absent. */
export function formatCost(n: number | undefined): string | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  if (n === 0) return '$0';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** One step's usage as a line; undefined when the step recorded none, so
 * the caller renders no row instead of an empty or zeroed one. */
export function stepUsageText(step: UsageStep): string | undefined {
  const t = step.tokens;
  const cost = formatCost(step.cost);
  if (!t) return cost;
  const parts = [`${t.input.toLocaleString()} in`, `${t.output.toLocaleString()} out`];
  if (t.reasoning !== undefined) parts.push(`${t.reasoning.toLocaleString()} reasoning`);
  if (t.cache?.read !== undefined) parts.push(`${t.cache.read.toLocaleString()} cache read`);
  if (t.cache?.write !== undefined) parts.push(`${t.cache.write.toLocaleString()} cache write`);
  if (cost) parts.push(cost);
  return parts.join(' · ');
}
