// sessionModelStatus.ts — pure builder for the `sessionModels` broadcast payload, extracted from
// DashboardPanel.broadcastSessionModels. Kept pure (no Session/AcpClient import) so it's testable
// without a real session.
export interface SessionModelEntry {
  /** A Claude Code passthrough cell's bound model — outranks the engine's own
   *  `current`, same precedence broadcastSessionModels always used. */
  claudeCodeModel: string | undefined;
  current: string | undefined;
  /** Session.subagentModel — the host's echo of the last `setSubagentModel`
   *  pick (the ACP wire never round-trips the override value back). */
  subagentModel: string | undefined;
}

export interface SessionModelStatus {
  models: Record<string, string>;
  subagentModels: Record<string, string>;
}

export function buildSessionModelStatus(
  entries: ReadonlyArray<readonly [string, SessionModelEntry]>,
): SessionModelStatus {
  const models: Record<string, string> = {};
  const subagentModels: Record<string, string> = {};
  for (const [sid, e] of entries) {
    const cur = e.claudeCodeModel ?? e.current;
    if (cur) models[sid] = cur;
    if (e.subagentModel) subagentModels[sid] = e.subagentModel;
  }
  return { models, subagentModels };
}
