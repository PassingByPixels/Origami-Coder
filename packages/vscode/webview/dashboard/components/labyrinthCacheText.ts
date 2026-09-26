// ONE SENTENCE PER CACHE-LOSS CAUSE, and nothing else — extracted from
// labyrinthCache.ts (t-rylq3t) at its cap: that file DERIVES a `CacheLoss`,
// this one only ever FORMATS one already derived. Splitting the two keeps the
// derivation readable in one pass and keeps a wording tweak from ever risking
// the precedence or fallback logic next to it.
//
// Pure — no DOM.

import type { CacheLoss } from './labyrinthCache';
import { stoppedHalves, stoppedText } from './labyrinthStoppedText';

const LEGACY_PREFIX = 'Derived by the viewer (run recorded before 0.4.160): ';
/** A Claude Code transcript never carries an engine cause — the CLI is not the
 *  engine, so the sentence never claims a run "before 0.4.160" that never applies. */
const CLAUDE_TEXT = 'Claude Code session: the transcript records tokens but no cause';
/** This one request reported no cache measurement at all — never call that "unknown". */
const UNMEASURED_TEXT = 'unmeasured, this provider reports no cache tokens; never unknown';

/** `providerID/modelID` -> true when that provider is a local inference server,
 *  whose prefix cache lives in the process's own KV budget rather than a
 *  published window. Matches the engine's own no-window provider list
 *  (`session/cache-policy.ts`) for the ones a `provider` miss commonly means
 *  "the lane evicted it". */
function isLocalProvider(provider: string | undefined): boolean {
  if (!provider) return false;
  return /^(vllm|lmstudio|ollama|llamacpp|sglang|spark)/.test(provider);
}

function sourceLabel(source: 'tool-aging' | 'reminder' | 'plugin' | 'unknown' | undefined): string | undefined {
  if (source === 'tool-aging') return 'tool aging';
  if (source === 'reminder') return 'a reminder';
  if (source === 'plugin') return 'a plugin';
  return undefined;
}

/** The ENGINE-recorded cause, as one sentence. Never reads `reasons` — a loss
 *  with a `cause` was not derived here, it was read off the step. */
function engineCauseText(loss: CacheLoss): string {
  const f = loss.facts;
  switch (loss.cause!) {
    case 'cold': return 'first billed prefill of the run — nothing was cached yet';
    case 'model':
      return loss.from && loss.to
        ? `model changed, ${loss.from} to ${loss.to} — a cache entry does not carry across models`
        : 'the model changed since the previous request — a cache entry does not carry across models';
    case 'compaction':
      return 'the context was compacted just before this step — the summary is a new prefix, so none of the old one could be read back';
    case 'stopped': return stoppedText(f?.stopped);
    case 'system': return 'the system prompt changed';
    case 'tools': return 'the tool list changed';
    case 'history': {
      const d = f?.divergence;
      if (!d) return 'an already-sent message came back rewritten';
      const label = sourceLabel(d.source);
      return `message ${d.message} (${d.role}) was rewritten${label ? ` — ${label}` : ''}`;
    }
    case 'small': return 'prefill under the provider’s minimum cacheable size';
    case 'idle': {
      // Never claims a window the engine did not send — `idle` should not
      // reach the client without `ttlSeconds`, but the text stays honest if it does.
      if (f?.idleMs === undefined || f?.ttlSeconds === undefined) {
        return 'idle past the provider’s cache window before this step';
      }
      const mins = Math.round(f.idleMs / 60_000);
      const windowMins = Math.round(f.ttlSeconds / 60);
      return `idle ${mins}m before this step, past the provider’s ${windowMins}m window`;
    }
    case 'provider': {
      const base = 'the prefix was byte-identical and inside the window; the provider did not serve it';
      return isLocalProvider(loss.provider) ? `${base}; a local server evicted the prefix — check the lane’s KV budget` : base;
    }
  }
}

/** One line saying why, in the inspector. Never blank, never invented. Reads
 *  the ENGINE's own cause when the step carried one; a Claude Code row and an
 *  unmeasured row each get their own fixed sentence; only a genuine engine
 *  step recorded before 0.4.160 falls back to the three legacy rules, and
 *  that fallback says so — it is the viewer's own guess, not what the engine
 *  said, and never "unknown" for a row that was never measured at all. */
export function lossReasonText(loss: CacheLoss): string {
  if (loss.cause !== undefined) return engineCauseText(loss);
  if (loss.claude) return CLAUDE_TEXT;
  if (loss.unmeasured) return UNMEASURED_TEXT;

  const parts: string[] = [];
  for (const reason of loss.reasons) {
    if (reason === 'cold') parts.push('first billed prefill of the run — nothing was cached yet');
    if (reason === 'model') parts.push(`model changed, ${loss.from} to ${loss.to} — a cache entry does not carry across models`);
    if (reason === 'compaction') {
      parts.push('the context was compacted just before this step — the summary is a new prefix, so none of the old one could be read back');
    }
  }
  if (parts.length === 0) {
    return `${LEGACY_PREFIX}unknown — the run records no cause for this one. None of the causes this view can derive applies: not a cold start, not a model change, and not a context compaction.`;
  }
  return `${LEGACY_PREFIX}${parts.join('; ')}`;
}

/** The facts line under an engine-recorded cause — what changed while the
 *  engine was parked, idle gap, where an already-sent message diverged and
 *  why, and whether a warm request landed first. Undefined when the loss carries no `cause` (legacy path) or no facts. */
export function lossFactsText(loss: CacheLoss): string | undefined {
  const f = loss.facts;
  if (loss.cause === undefined || !f) return undefined;
  const parts: string[] = [];
  const stopped = stoppedHalves(f.stopped);
  if (stopped) parts.push(`changed while parked: ${stopped}`);
  if (f.idleMs !== undefined) parts.push(`idle ${Math.round(f.idleMs / 60_000)}m`);
  if (f.divergence) {
    const label = sourceLabel(f.divergence.source);
    parts.push(`message ${f.divergence.message} (${f.divergence.role}) diverged${label ? ` — ${label}` : ''}`);
  }
  if (f.warmed) parts.push('a warm request landed first');
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
