// subagentThinking.ts — a sub-agent's LIVE THOUGHT: what it has streamed since
// its last prose or tool line, and how that prints on a 240px row (t-gvz8t0).
//
// The measured case this exists for: two `general` children each spent their
// ENTIRE first step reasoning — 123 s / 5,449 tokens and 159 s / 7,318 tokens —
// before their first tool call. The engine forwarded a child's prose only, so
// the drawer row showed NOTHING for those two minutes, and the owner read the
// silence as a failure.
//
// A SEPARATE field from `taskStream`, never merged into it: that string is the
// row's activity tail AND the transcript card's reply text, so thought appended
// there is thought presented as the child's answer. Kept per run of thought,
// not per session: the row answers "what is it thinking about NOW", and a
// thought that ended is a thought the transcript view holds.
//
// Pure and DOM-free like every leaf in this family, so the boundaries that
// actually bite (a first delta, an exact engine count arriving mid-thought, a
// thought of pure whitespace) are checked without a render.

import { elapsedText } from './subagentFormat';
import { compactCount, type SubagentTokens } from './subagentTokens';

/** One run of a child's reasoning — from its first delta to the prose or tool
 *  line that ends it. */
export interface SubagentThinking {
  /** The thought so far, newest at the end, capped at THINKING_CAP. */
  text: string;
  /** Characters streamed in this run, counted BEFORE the cap. The estimate is
   *  derived from it, so it must not shrink when the head of `text` is dropped. */
  chars: number;
  /** Epoch ms of the FIRST delta of this run. */
  startedAt: number;
  /** The child's cumulative reasoning count (engine rider) when this run began,
   *  so a later exact total can be turned into THIS thought's share. */
  baseReasoning: number;
}

/** Characters of thought kept. The row prints one line of it and the transcript
 *  view holds the whole thing off the child's stored session, so this is a tail
 *  buffer, not a log — a 7k-token thought is ~28k characters. */
export const THINKING_CAP = 4000;

/** The estimator's divisor, stated once. Four characters per token is the rough
 *  English ratio every provider's own counter beats; the row LABELS a figure
 *  from it with a tilde so nobody reads it as measured. */
export const CHARS_PER_TOKEN = 4;

/**
 * Fold one reasoning delta into the run. `base` is the child's cumulative
 * reasoning total right now, and is recorded only when the run STARTS — taking
 * it on every delta would move the baseline under a figure already printed.
 */
export function appendThinking(
  prev: SubagentThinking | undefined,
  delta: string,
  now: number,
  base = 0,
): SubagentThinking {
  const text = `${prev?.text ?? ''}${delta}`;
  return {
    text: text.length > THINKING_CAP ? text.slice(text.length - THINKING_CAP) : text,
    chars: (prev?.chars ?? 0) + delta.length,
    startedAt: prev?.startedAt ?? now,
    baseReasoning: prev?.baseReasoning ?? base,
  };
}

/**
 * How many tokens this run of thought is, and whether anyone MEASURED it.
 *
 * The engine's reasoning count is a SESSION total that only moves at
 * step-finish, so `reasoning - baseReasoning` is this run's exact share — when
 * one has landed since the run began. During the two-minute first step that
 * started this ticket none ever has, so the honest answer there is the
 * character estimate, flagged as an estimate.
 */
export function thinkingTokens(
  t: SubagentThinking,
  tokens?: SubagentTokens,
): { count: number; estimated: boolean } {
  const total = tokens?.reasoning;
  if (typeof total === 'number' && Number.isFinite(total) && total > t.baseReasoning) {
    return { count: total - t.baseReasoning, estimated: false };
  }
  return { count: Math.round(t.chars / CHARS_PER_TOKEN), estimated: true };
}

/** The row's heartbeat: `thinking · ~5.4k tokens · 2m 05s`. A tilde marks an
 *  ESTIMATED count. The age is dropped rather than printed as `0s` when the run
 *  has no honest age yet, exactly as the row's own age does. */
export function thinkingNote(t: SubagentThinking | undefined, now: number, tokens?: SubagentTokens): string {
  if (!t) return '';
  const { count, estimated } = thinkingTokens(t, tokens);
  const parts = ['thinking'];
  if (count > 0) parts.push(`${estimated ? '~' : ''}${compactCount(count)} tokens`);
  const age = elapsedText(now - t.startedAt);
  if (age) parts.push(age);
  return parts.join(' · ');
}

/** The last non-empty line of the thought — what it is weighing right NOW, which
 *  is the one line that turns a count into something a reader can act on. */
export function thinkingLine(t: SubagentThinking | undefined): string {
  if (!t) return '';
  const lines = t.text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  return lines[lines.length - 1] ?? '';
}

/**
 * Both halves a drawer row and a map card print, in one call so the two
 * surfaces cannot disagree about when a child counts as thinking.
 *
 * `settled` forces both blank: the run ENDED, whatever the last thought left on
 * the card says, and the prose line that would have cleared it may never have
 * come (a child that dies mid-thought sends no prose at all).
 */
export function thinkingRow(
  m: { taskThinking?: SubagentThinking; taskTokens?: SubagentTokens },
  now: number,
  settled: boolean,
): { thinking: string; thought: string } {
  if (settled) return { thinking: '', thought: '' };
  return { thinking: thinkingNote(m.taskThinking, now, m.taskTokens), thought: thinkingLine(m.taskThinking) };
}
