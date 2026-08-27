// What a run SPENT — totalled per sub-agent branch, per agent, and for the run.
// Pure, like labyrinthLanes / labyrinthSpans / labyrinthCollide, so every rule
// below is testable with no DOM.
//
// Two things this must never do, both of which would be worse than showing
// nothing at all:
//
//  1. INVENT a number. A step whose message recorded no usage contributes
//     nothing and prints nothing — never a 0, which reads as "this turn was
//     free". A genuine 0 (a local model really does cost nothing) is kept.
//  2. Present a SHORT total as a complete one. `usageMissing` steps, a run the
//     engine truncated, and a delegated run that was never expanded each mean
//     the sum below is a FLOOR. Every one of them sets `approximate` and says
//     why, because a confident wrong number is the failure that matters here.
//
// Nothing is ever derived from text length. The only inputs are numbers the
// engine recorded.

import { branchModel, type BranchStep } from './labyrinthBranches';

/** The part of a step the usage rules read. `LayoutStep` satisfies it. */
export interface UsageStep extends BranchStep {
  title: string;
  agent?: string;
  /** `providerID/modelID`, as the engine recorded it on the owning message. */
  model?: string;
  childSessionId?: string;
  tokens?: { input: number; output: number; reasoning?: number; cache?: { read?: number; write?: number } };
  cost?: number;
  usageMissing?: true;
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
  /**
   * The headline count: input + output + reasoning + cache read. Not invented —
   * it is exactly how the engine composes its own `tokens.total` (checked
   * against all 1,198 stored messages that carry one). Cache WRITE is excluded
   * for the same reason the engine excludes it.
   */
  tokens?: number;
}

export interface BranchUsage {
  /** `BranchSpan.first` — the branch's unique render key. */
  first: number;
  /** The spawning step's title, for a label. */
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

/** A bucket with nothing in it yet. Exported for labyrinthCost.ts, which groups
 *  the SAME steps by model and must start from the same empty. */
export const emptyUsage = (): UsageTotal => ({ counted: 0, missing: 0, approximate: false });

/** `a + b` where an absent side stays absent — 0 + undefined must not become 0. */
function add(a: number | undefined, b: number | undefined): number | undefined {
  if (b === undefined) return a;
  return (a ?? 0) + b;
}

/**
 * Add one step into a bucket. THE single summation in the Labyrinth: exported
 * so labyrinthCost.ts's per-model split rides it rather than keeping a second
 * copy of the arithmetic, which is how two surfaces end up disagreeing about
 * what the same run cost.
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

/** Options a caller knows that the step list cannot say for itself. */
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
    // `host` is the branch whose AGENT produced the step, so a `task` call
    // lands on the thread that MADE it, not on the sub-agent it started.
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

  // A delegated run the caller never fetched contributes NOTHING, and its spawn
  // is the only trace of it. Counting the total as complete would silently drop
  // a whole sub-agent's spend.
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

/**
 * One step's usage as a single line. Returns undefined when the step recorded
 * none, so the caller renders NO row rather than an empty or zeroed one.
 */
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
