// Paging for ACP `session/list`, split out of acpClient.ts so the loop and its two
// guards are assertable on their own. The agent answers with at most ONE page plus
// a `nextCursor`; asking once and stopping meant the older half of a workspace's
// chat history quietly stopped appearing. This asks until the agent says there is
// nothing left.

/** Round-trip ceiling. The engine holds up to 5000 root sessions per directory
 *  and pages them at 100, so this reaches the store's own ceiling with room to
 *  spare; it bounds a misbehaving cursor, it does not cap history. */
export const MAX_SESSION_PAGES = 100;

export type SessionRow = Record<string, unknown>;

/** The one call this needs from a connection — `AgentSideConnection.listSessions`. */
export type ListSessionsCall = (params: { cwd?: string; cursor?: string }) => Promise<unknown>;

const rowsOf = (resp: unknown): SessionRow[] =>
  Array.isArray((resp as { sessions?: unknown[] } | null)?.sessions)
    ? (resp as { sessions: SessionRow[] }).sessions
    : [];

/** Every session the agent will admit to, across as many pages as it takes. Two
 *  guards, because a cursor arrives from the other side of a wire: rows are
 *  de-duplicated by id (a page boundary may legitimately re-send the sessions
 *  sharing its timestamp, which is how the engine avoids splitting a tie group), and
 *  the loop stops the moment a page adds nothing new or repeats a cursor. */
export async function pageSessions(list: ListSessionsCall, params: { cwd?: string }): Promise<SessionRow[]> {
  const out: SessionRow[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_SESSION_PAGES; page++) {
    const resp = await list({ ...params, ...(cursor ? { cursor } : {}) });
    let added = 0;
    for (const row of rowsOf(resp)) {
      const id = String(row['sessionId'] ?? '');
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      out.push(row);
      added++;
    }
    const next = (resp as { nextCursor?: unknown } | null)?.nextCursor;
    if (typeof next !== 'string' || !next) break;
    if (added === 0 || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }
  return out;
}
