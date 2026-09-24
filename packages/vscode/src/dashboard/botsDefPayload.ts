// botsDefPayload.ts - the Bots section's def-list reply builder and agent-dir
// resolution. Pure reads over the host's config dir - no messages, no state.

import * as path from 'node:path';
import { listCollabAgentDefs, listVisionAgentDefs } from './collabAgentCrud';
import { readBotMemory } from './botMemoryStore';
import { globalConfigDir } from './globalConfig';

type HostDirs = { configDir?(): string };

/** The directory `agent/*.md` lives in, for whichever config dir the host names. */
export const agentDirOf = (host: HostDirs): string => path.join(host.configDir?.() ?? globalConfigDir(), 'agent');

/**
 * Both def lists on every `collabAgentDefs` reply, so a reply carrying only
 * the collab list can't leave another tab showing a def it just deleted.
 * `memoryFacts` rides along keyed by slug, omitting a bot with an empty store.
 */
export function agentDefPayload(host: HostDirs) {
  const configDir = host.configDir?.() ?? globalConfigDir();
  const dir = path.join(configDir, 'agent');
  const defs = listCollabAgentDefs(dir);
  const memoryFacts: Record<string, number> = {};
  for (const def of defs) {
    const facts = readBotMemory(configDir, def.slug).facts;
    if (facts > 0) memoryFacts[def.slug] = facts;
  }
  return { defs, visionDefs: listVisionAgentDefs(dir), memoryFacts };
}
