// Defect B, second half — `listSessions` used to read ONE page and stop.
//
// The engine answers `session/list` with at most a page and a `nextCursor`,
// and the extension asked once. Below ~100 sessions nothing looked wrong; past
// it the older half of someone's chat history simply stopped existing in the
// run index, with no message and no gap. These drive the real
// `AcpClient.listSessions` against a fake connection that pages the way the
// engine does.
import { describe, expect, it, vi } from 'vitest';
import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';

function handlers(): AcpEventHandlers {
  return new Proxy({} as AcpEventHandlers, { get: () => vi.fn() });
}

interface Row { sessionId: string; cwd: string; title: string; updatedAt: string }

/** A fake agent that pages `rows` at `pageSize`, cursor = last row's index. */
function pagingConnection(rows: Row[], pageSize: number) {
  const listSessions = vi.fn(async (params: { cwd?: string; cursor?: string }) => {
    const start = params.cursor ? Number(params.cursor) : 0;
    const page = rows.slice(start, start + pageSize);
    const end = start + page.length;
    return { sessions: page, ...(end < rows.length ? { nextCursor: String(end) } : {}) };
  });
  return { listSessions };
}

function clientWith(connection: unknown, cwd = 'C:/ws') {
  const client = new AcpClient(handlers());
  (client as unknown as { connection: unknown }).connection = connection;
  (client as unknown as { cwd: string }).cwd = cwd;
  return client;
}

const makeRows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ sessionId: `ses_${i}`, cwd: 'C:/ws', title: `Chat ${i}`, updatedAt: `t${i}` }));

describe('AcpClient.listSessions — pages to exhaustion', () => {
  it('returns every session across many pages, not just the first', async () => {
    const rows = makeRows(250);
    const conn = pagingConnection(rows, 100);
    const got = await clientWith(conn).listSessions();

    expect(got).toHaveLength(250);
    expect(got.map(s => s.sessionId)).toEqual(rows.map(r => r.sessionId));
    expect(conn.listSessions).toHaveBeenCalledTimes(3);
  });

  it('stops after one call when the agent sends no cursor', async () => {
    const conn = pagingConnection(makeRows(40), 100);
    expect(await clientWith(conn).listSessions()).toHaveLength(40);
    expect(conn.listSessions).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates ids a page boundary re-sends', async () => {
    // The engine extends a page to the end of a same-timestamp tie group, so
    // the row(s) on the boundary can arrive twice. One row per session, still.
    const listSessions = vi.fn(async (p: { cursor?: string }) =>
      p.cursor
        ? { sessions: [{ sessionId: 'ses_1', cwd: 'C:/ws', title: 'B', updatedAt: 't' }, { sessionId: 'ses_2', cwd: 'C:/ws', title: 'C', updatedAt: 't' }] }
        : { sessions: [{ sessionId: 'ses_0', cwd: 'C:/ws', title: 'A', updatedAt: 't' }, { sessionId: 'ses_1', cwd: 'C:/ws', title: 'B', updatedAt: 't' }], nextCursor: '1' },
    );
    const got = await clientWith({ listSessions }).listSessions();
    expect(got.map(s => s.sessionId)).toEqual(['ses_0', 'ses_1', 'ses_2']);
  });

  it('does not hang when an agent repeats the same cursor forever', async () => {
    const listSessions = vi.fn(async () => ({
      sessions: [{ sessionId: 'ses_stuck', cwd: 'C:/ws', title: 'A', updatedAt: 't' }],
      nextCursor: 'same',
    }));
    const got = await clientWith({ listSessions }).listSessions();
    expect(got).toHaveLength(1);
    // Second page adds no new id, so it stops there rather than spinning.
    expect(listSessions.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('pages the unfiltered fallback too when the cwd-scoped query is empty', async () => {
    const listSessions = vi.fn(async (p: { cwd?: string; cursor?: string }) => {
      if (p.cwd) return { sessions: [] };
      const start = p.cursor ? Number(p.cursor) : 0;
      const rows = makeRows(150).slice(start, start + 100);
      const end = start + rows.length;
      return { sessions: rows, ...(end < 150 ? { nextCursor: String(end) } : {}) };
    });
    expect(await clientWith({ listSessions }).listSessions()).toHaveLength(150);
  });

  it('survives a malformed page without dropping the good rows', async () => {
    const listSessions = vi.fn(async () => ({ sessions: [{ sessionId: '' }, { sessionId: 'ses_ok', cwd: 'C:/ws', title: 'T', updatedAt: 'u' }] }));
    const got = await clientWith({ listSessions }).listSessions();
    expect(got.map(s => s.sessionId)).toEqual(['ses_ok']);
  });
});
