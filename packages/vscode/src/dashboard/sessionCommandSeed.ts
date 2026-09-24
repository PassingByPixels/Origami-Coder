// The `/` palette's vocabulary, re-seeded for a composer that mounted late.
// The engine pushes a session's command list ONCE (available_commands_update at session/new and
// session/load); DashboardPanel forwarded it but kept no copy. A composer that mounted after that
// push — a restored chat, a popped-out tab, a reload — fell back to InputBar's nine baseline
// commands and no skills at all. This caches the one-shot push and re-sends it when a pane reports
// it has mounted, the same fix requestSessionModels already uses for the model.

/** One entry of an engine command list, as `acpClient` narrows the ACP payload. */
export interface SeededCommand {
  name: string;
  description: string;
}

/** The per-session state this needs: the cached list, or nothing yet. */
export interface CommandSeedSource {
  availableCommands?: readonly SeededCommand[];
}

export interface CommandSeedMessage {
  type: 'availableCommands';
  commands: readonly SeededCommand[];
  sessionId: string;
}

/** The `availableCommands` posts that re-seed every session holding a cached list. A session the
 *  engine hasn't answered for yet is skipped, not posted empty — an empty replacement would swap
 *  the composer's fallback vocabulary for nothing. */
export function commandSeedMessages(
  sessions: Iterable<readonly [string, CommandSeedSource]>,
): CommandSeedMessage[] {
  const out: CommandSeedMessage[] = [];
  for (const [sessionId, session] of sessions) {
    const commands = session.availableCommands;
    if (commands && commands.length > 0) out.push({ type: 'availableCommands', commands, sessionId });
  }
  return out;
}
