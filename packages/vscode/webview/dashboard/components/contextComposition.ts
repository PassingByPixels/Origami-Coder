// The context gauge's hover breakdown, as data. Pure, so the sums and the bar
// widths can be tested without a DOM — jsdom has no layout engine, so a test
// that asked the rendered bar how wide a segment is would assert nothing.
//
// MIRRORED from `src/acpClient.ts` (ContextComposition). A webview `.ts` file
// cannot import from `src/` at all — not even `import type` — because
// tsconfig.webview.json pins rootDir to `webview/`. `__tests__/contextComposition.test.ts`
// reads both files and fails when the two field lists drift apart.
export type ContextComposition = {
  systemPrompt: number;
  tools: number;
  conversation: number;
  estimated: true;
  method: string;
};

/** Grey for what the agent costs you, chat blue for what you put in, faint for
 *  what is left. The card maps these to --og-* vars; nothing here names a colour. */
export type PartKind = 'overhead' | 'content' | 'headroom';

export type BreakdownRow = {
  readonly id: string;
  readonly label: string;
  readonly tokens: number;
  readonly kind: PartKind;
  /** Share of the whole track, 0-100. */
  readonly pct: number;
};

/** A frame's composition, if it really is one. Keeps InputBar's handler to a line
 *  and keeps the "is this a breakdown" question in one place. */
export function asComposition(raw: unknown): ContextComposition | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  const ok = (key: string) => typeof c[key] === 'number' && Number.isFinite(c[key] as number) && (c[key] as number) >= 0;
  if (!ok('systemPrompt') || !ok('tools') || !ok('conversation')) return undefined;
  return {
    systemPrompt: c['systemPrompt'] as number,
    tools: c['tools'] as number,
    conversation: c['conversation'] as number,
    estimated: true,
    method: typeof c['method'] === 'string' ? (c['method'] as string) : '',
  };
}

/** What the engine's parts add up to — the card's header total, and the figure a
 *  reader checks the gauge against. */
export function usedOf(composition: ContextComposition): number {
  return composition.systemPrompt + composition.tools + composition.conversation;
}

/**
 * The card's rows, in the order they are drawn.
 *
 * The track is the WINDOW, so every width answers the same question ("how much of
 * the window is this?") and Headroom is what is left of it. With no known window
 * the used total is the track instead and there is no headroom row — an unknown
 * window has no honest remainder.
 *
 * "Conversation" carries the text of any attached file: the engine expands an
 * attachment into the message that reads it, so nothing downstream can separate
 * the two. The label says so rather than the card showing a guessed row.
 */
export function breakdownRows(composition: ContextComposition, contextWindow: number): BreakdownRow[] {
  const used = usedOf(composition);
  const track = contextWindow > used ? contextWindow : used;
  const pct = (tokens: number) => (track > 0 ? (tokens / track) * 100 : 0);
  const rows: BreakdownRow[] = [
    { id: 'systemPrompt', label: 'System prompt', tokens: composition.systemPrompt, kind: 'overhead', pct: pct(composition.systemPrompt) },
    { id: 'tools', label: 'Tools', tokens: composition.tools, kind: 'overhead', pct: pct(composition.tools) },
    { id: 'conversation', label: 'Conversation + files', tokens: composition.conversation, kind: 'content', pct: pct(composition.conversation) },
  ];
  if (contextWindow > used) {
    const headroom = contextWindow - used;
    rows.push({ id: 'headroom', label: 'Headroom', tokens: headroom, kind: 'headroom', pct: pct(headroom) });
  }
  return rows;
}

/** 1,234 — the card's numbers read as counts, not as the gauge's rounded "38k". */
export function fmtTokens(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
