// botSessionStart.ts - what "start a session as this bot" does.
//
// A bot session is an ordinary chat whose agent is one definition — no
// separate `session.kind` exists. Identity is set once, at CREATE time: the
// slug rides ACP `session/new`'s `_meta.agent`, seeding both the session row
// and its `modeId` in one step, so persona, memory and tool denies always
// arrive together rather than through a separate, racy mode-set call.

/** The slice of an ACP client this needs. Structural, and satisfied by
 *  acpClient.ts's real `getModeOption`. */
export interface BotSessionClient {
  getModeOption(): { current: string; options: Array<{ value: string; name: string }> } | null | undefined;
}

export interface BotSessionDeps {
  /** Create a CHAT session titled `displayName` and created engine-side AS
   *  `agent`, resolving once its ACP client is up, and answer with its local
   *  session id. Rejects when the engine refuses that agent. */
  create(displayName: string, agent: string): Promise<string>;
  /** That session's client, or undefined when it did not survive creation. */
  clientOf(sessionId: string): BotSessionClient | undefined;
}

/**
 * Open a chat running as `slug`, titled `displayName`.
 *
 * Throws rather than returning a flag; the caller turns that into the pane's
 * error. A refusal from the engine propagates untouched — its message already
 * names what's missing. `deps.create` must not put a chat on screen before
 * the engine has accepted the agent. The post-creation check reads the
 * engine's own `mode.current`, catching an engine too old to honor `_meta.agent`.
 */
export async function startBotSession(deps: BotSessionDeps, slug: string, displayName: string): Promise<void> {
  const sessionId = await deps.create(displayName, slug);
  const client = deps.clientOf(sessionId);
  if (!client) throw new Error(`The chat for "${slug}" did not start, so it could not be run as that bot.`);
  const mode = client.getModeOption();
  if (mode?.current === slug) return;
  const ids = (mode?.options ?? []).map((o) => o.value);
  throw new Error(
    `The chat did not start as "${slug}" - the engine brought it up as "${mode?.current || '(unknown)'}". `
    + `It offers: ${ids.join(', ') || '(none)'}. `
    + 'A newly created bot is usable at once; a deleted-and-recreated one needs a window reload.',
  );
}
