// botSessionStart.ts - what "start a session as this bot" actually does.
//
// A BOT SESSION is an ordinary chat whose agent is one definition. The engine
// has no `session.kind` and needs none (packages/engine/test/collab/
// bot-session.test.ts): everything that makes it a bot session follows from the
// agent alone - the definition's permission tier and skills allowlist (applied
// in the agent registry, so every run mode gets them), its own memory (keyed to
// the definition file) and its model preference.
//
// ONE STEP, and it happens at CREATE time. The chat is created AS the bot: the
// slug rides ACP `session/new`'s `_meta.agent` (engine acp/service.ts
// `requestedAgent`), which seeds the engine session row AND the session's
// `modeId` - the one field a turn resolves identity from. This replaced a
// create-then-`setConfigOption('mode')` pair, which left a window where the
// session existed as `build`: its FIRST turn was built from default.txt and the
// ungated tool set, so the chat opened correctly titled and answered "I'm
// Origami ... No specialized persona loaded" (W7-L1, live UAT). Persona, bot
// memory and the definition's tool denies all key off that one identity, so
// they arrive together or not at all - there is no second persona channel.
//
// ITS OWN FILE because DashboardPanel.ts owns session creation and sits AT its
// architecture cap - what stays there is one line handing this the two closures
// it needs. Structural dependencies, not an AcpClient import, so the failure
// paths below are exercised without an extension host.

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
 * THROWS rather than returning a flag, and the caller (botsManager.ts) turns
 * that into the pane's `botSessionResult.error`.
 *
 * A refusal from the engine propagates UNTOUCHED: `session/new` resolves the
 * agent before it creates anything, and its message already names what kind of
 * thing is missing (an agent DEFINITION, not a model - the W8-L1 wording fix)
 * and which definitions it did load, bot defs included. Rewrapping it would
 * throw both away. The remaining cause is a definition file the engine cannot
 * see at all: a DELETED-and-recreated one still needs a window reload, which is
 * the one caveat the Bots view states up front.
 *
 * `deps.create` must not put a chat on screen before the engine has accepted
 * the agent - see sessionAnnounce.ts. A refusal is reported in the Bots pane,
 * from the message this throws, and nowhere else.
 *
 * The check after creation reads the ENGINE's answer, not what we asked for:
 * `mode.current` is the live `session.modeId`. An engine too old to read
 * `_meta.agent` brings the chat up as its default and is caught here, rather
 * than handing the user a chat that looks right and answers wrong.
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
