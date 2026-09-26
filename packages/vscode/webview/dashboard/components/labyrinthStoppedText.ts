// labyrinthStoppedText.ts — t-w2txb2: the words for the `stopped` cache-loss cause ("changed while parked").
// The engine names it on the first request after an engine restart (a parked chat restored, a window
// reload) when the prompt prefix no longer matches the last one stored before the park. Split out of
// labyrinthCacheText.ts, which sits at its line cap; that file only formats, and so does this one.

const HALF_LABEL: Record<'system' | 'tools' | 'history', string> = {
  system: 'the system prompt',
  tools: 'the tool list',
  history: 'the earlier messages',
};

/** The halves a restore found changed, in plain words: "a and b". */
export function stoppedHalves(halves: readonly ('system' | 'tools' | 'history')[] | undefined): string | undefined {
  if (!halves || halves.length === 0) return undefined;
  const words = halves.map((half) => HALF_LABEL[half]);
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** `stopped`: the first request after an engine restart, against the last one
 *  stored before it. A system or tool change comes from an edit made while the
 *  engine was parked, so the sentence says where such edits come from. */
export function stoppedText(halves: readonly ('system' | 'tools' | 'history')[] | undefined): string {
  const what = stoppedHalves(halves) ?? 'the prompt prefix';
  const edited = halves?.some((half) => half !== 'history')
    ? ' (settings, instructions, skills, agents or MCP servers were edited)'
    : '';
  return `${what} changed while the engine was parked${edited} — the restored request could not reuse the cache`;
}
