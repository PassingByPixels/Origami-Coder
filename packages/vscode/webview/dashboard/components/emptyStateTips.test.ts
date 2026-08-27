// t-r7c757 — the rotating tip list's pure rules: the list itself, the
// wraparound advance, and the seed->start mapping. No Math.random here — a
// fixed seed must always reproduce the same start, which is what makes the
// component's mount-time randomness testable at all (mock Math.random once,
// then assert against these same pure functions).

import { describe, expect, it } from 'vitest';
import { EMPTY_STATE_TIPS, nextTipIndex, startTipIndex } from './emptyStateTips';

describe('EMPTY_STATE_TIPS', () => {
  it('is exactly the 11 owner-reviewed tips, verbatim, entry 0 the classic hint', () => {
    expect(EMPTY_STATE_TIPS).toEqual([
      'Ready — ask Tsuru to make a change. Type below to jump in.',
      'Run /wrap to close out a session — it writes the handoff and updates the wiki.',
      'Working with images on a text-only model? The Vision button lends it a pair of eyes.',
      'tool_search finds MCP tools by capability — ask for what you need, not a tool name.',
      'The sidebar is yours: + creates sections, drag chats between them.',
      'A blue dot on a tab — or a blue ring in the sidebar — means a chat is waiting on you.',
      "Sessions can message each other: ask for list_agents to see who's reachable.",
      'Pop a chat into its own editor tab to work side-by-side.',
      'Pick a sub-agent model on the model selector so heavy chats spawn light helpers.',
      'Right-click the compaction bar to set a lower auto-compact threshold.',
      'Plugins add skills and tools in one folder — origami agent-plugin add <dir>.',
    ]);
  });
});

describe('nextTipIndex', () => {
  it('advances one step forward', () => {
    expect(nextTipIndex(0)).toBe(1);
    expect(nextTipIndex(3)).toBe(4);
  });

  it('wraps the LAST tip back to the first, never past the end', () => {
    const last = EMPTY_STATE_TIPS.length - 1;
    expect(nextTipIndex(last)).toBe(0);
  });
});

describe('startTipIndex', () => {
  it('maps a seed of 0 to the first tip', () => {
    expect(startTipIndex(0)).toBe(0);
  });

  it('maps a seed just under 1 to the LAST tip, not off the end', () => {
    expect(startTipIndex(0.999999)).toBe(EMPTY_STATE_TIPS.length - 1);
  });

  it('maps a mid seed to the matching floor(seed * length) index', () => {
    // 11 tips: 0.5 * 11 = 5.5 -> floor 5.
    expect(startTipIndex(0.5)).toBe(5);
  });

  it('the SAME seed always reproduces the SAME start (deterministic, no hidden randomness)', () => {
    expect(startTipIndex(0.27)).toBe(startTipIndex(0.27));
  });
});
