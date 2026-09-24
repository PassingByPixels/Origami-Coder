// WHICH list a `todowrite` frame carries, and what shape its rows are.
//
// Two sources, in preference order, because ONE frame of the lifecycle does not
// carry the structured payload: the COMPLETED frame's title is the tool's own
// summary ("3 todos") and its list arrives as JSON inside a text content block.
// Whether the frame IS a todowrite stays in acpClient.ts — that question also needs
// the remembered toolCallId, which is client state, not a shaping rule.

/** One row of the live task strip, as the handlers declare it. */
export interface TodoRow {
  id: number;
  content: string;
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Nesting level as the model sent it — 0 for a top-level task. Carried RAW: a
   *  jump or an over-deep value is clamped once, by the strip, against the whole
   *  list (todoTree.ts). Clamping here too would let the two rules disagree. */
  depth: number;
}

/** The frame fields this rule reads, declared structurally. */
export interface TodoWriteUpdate {
  rawInput?: { todos?: unknown } | null;
  content?: unknown;
}

/** The list this frame carries, or null when it carries none (a status-only
 *  frame is still a todowrite — it just has nothing new to show). */
export function todosFromUpdate(upd: TodoWriteUpdate): TodoRow[] | null {
  let raw: unknown[] | null = Array.isArray(upd.rawInput?.todos) ? (upd.rawInput!.todos as unknown[]) : null;
  if (!raw && Array.isArray(upd.content)) {
    for (const entry of upd.content) {
      const e = entry as { type?: string; content?: { type?: string; text?: string } };
      if (e?.type === 'content' && e.content?.type === 'text' && typeof e.content.text === 'string') {
        try {
          const parsed = JSON.parse(e.content.text);
          if (Array.isArray(parsed)) {
            raw = parsed;
            break;
          }
        } catch {
          // not JSON — ignore
        }
      }
    }
  }
  if (!raw) return null;
  return raw.map((item, i) => {
    const t = item as { content?: unknown; activeForm?: unknown; status?: unknown; depth?: unknown };
    const rawStatus = String(t?.status ?? 'pending');
    const status: TodoRow['status'] =
      rawStatus === 'in_progress' || rawStatus === 'completed' ? rawStatus : 'pending';
    // Anything that is not a real number (absent, a string, NaN, Infinity) is a flat
    // row — never a dropped row.
    const rawDepth = t?.depth;
    return {
      id: i,
      content: String(t?.content ?? ''),
      activeForm: String(t?.activeForm ?? t?.content ?? ''),
      status,
      depth: typeof rawDepth === 'number' && Number.isFinite(rawDepth) ? rawDepth : 0,
    };
  });
}
