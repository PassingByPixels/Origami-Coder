// Which ACP call a freshly-initialized connection uses to get a session, and what it
// hands back. The three ways: fork — the Fork button, clone an existing session (messages,
// parts, todo list) into a NEW engine session, leaving the parent running; load —
// history recall by id; new — a fresh session, optionally created AS an agent.

import { historyFromResponse, type HistoryWindow } from './acpHistory';

/** The subset of the ACP connection this module calls. Deliberately narrow: a
 *  test supplies three spies and nothing else, and a widening of the SDK type
 *  cannot silently change what a fork is allowed to do. */
export interface SessionConnection {
  unstable_forkSession(params: { sessionId: string; cwd: string; mcpServers: never[] }): Promise<unknown>;
  loadSession(params: { sessionId: string; cwd: string; mcpServers: never[] }): Promise<unknown>;
  newSession(params: { cwd: string; mcpServers: never[]; _meta?: { agent: string } }): Promise<unknown>;
}

export interface EstablishInput {
  cwd: string;
  /** History recall — reopen this engine session id. */
  loadSessionId?: string;
  /** Fork — fork this engine session id into a new one. Takes precedence:
   *  a fork is never also a load, and the caller passes one or the other. */
  forkFromSessionId?: string;
  /** The agent def a NEW session is created as (`_meta.agent`). Ignored by the
   *  fork and load paths: both inherit the stored session's own agent. */
  agent?: string;
}

export interface EstablishedSession {
  sessionId: string;
  configOptions: Array<Record<string, unknown>>;
  /** Which branch ran — the word the caller logs. */
  how: 'forked' | 'loaded' | 'created';
  /** t-ucnp7t: the page a lazy restore replayed (`_meta.origami_history`). Absent on an old
   *  engine, which replayed the whole chat, and on a new session, which has no history. */
  history?: HistoryWindow;
}

/** Read `configOptions` off any of the three responses. Absent/null both mean
 *  "the agent offered none", which is an empty list, never a crash. */
function options(resp: unknown): Array<Record<string, unknown>> {
  return ((resp as { configOptions?: unknown[] } | null)?.configOptions ?? []) as Array<Record<string, unknown>>;
}

/** `{ history }` when the response carries a window, else nothing, so an old engine's result is
 *  exactly what it was. */
function withHistory(resp: unknown): { history?: HistoryWindow } {
  const history = historyFromResponse(resp);
  return history ? { history } : {};
}

/** Ask the engine for this chat's session. */
export async function establishSession(
  connection: SessionConnection,
  input: EstablishInput,
): Promise<EstablishedSession> {
  if (input.forkFromSessionId) {
    // `unstable_forkSession` is an UNSTABLE ACP method: the engine clones the source
    // session's messages, parts and todo list into a new row, then replays the fork's
    // WHOLE transcript back as `sessionUpdate` events. It does NOT copy the source's
    // permission preset, so a fork opens on ask-first.
    const forkResp = await connection.unstable_forkSession({
      sessionId: input.forkFromSessionId,
      cwd: input.cwd,
      mcpServers: [],
    });
    // The FORK's id, not the source's — reading back the source would point the new
    // tab's prompts at the chat the user forked away from.
    const sessionId = String((forkResp as { sessionId?: unknown }).sessionId ?? '');
    if (!sessionId) throw new Error('fork returned no sessionId');
    return { sessionId, configOptions: options(forkResp), how: 'forked', ...withHistory(forkResp) };
  }

  if (input.loadSessionId) {
    // History recall: load an existing engine session. The server restores context AND
    // replays the full transcript back as `sessionUpdate` events, which land in the
    // normal handlers so the webview re-renders the conversation.
    const loadResp = await connection.loadSession({
      sessionId: input.loadSessionId,
      cwd: input.cwd,
      mcpServers: [],
    });
    return { sessionId: input.loadSessionId, configOptions: options(loadResp), how: 'loaded', ...withHistory(loadResp) };
  }

  // `_meta.agent` = the agent this session is created AS (engine acp/service.ts
  // `requestedAgent`): it seeds the engine session row AND `modeId`, so the FIRST
  // turn speaks as that def — pointing `mode` at it afterwards was one turn late.
  const sessionResp = await connection.newSession({
    cwd: input.cwd,
    mcpServers: [],
    ...(input.agent ? { _meta: { agent: input.agent } } : {}),
  });
  return {
    sessionId: String((sessionResp as { sessionId?: unknown }).sessionId ?? ''),
    configOptions: options(sessionResp),
    how: 'created',
  };
}
