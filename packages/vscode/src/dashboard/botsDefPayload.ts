// botsDefPayload.ts - the Bots section's def-list reply builder and agent-dir
// resolution, extracted from botsManager.ts when the rail's Docs button pushed
// that dispatcher past its 200-line cap (the ratchet: the module comes out
// rather than the number going up). Pure reads over the host's config dir -
// no messages, no module state.
//
// The host parameter is STRUCTURAL ({ configDir?() }) rather than
// BotsManagerHost, so this module never imports its own consumer.

import * as path from 'node:path';
import { listCollabAgentDefs, listVisionAgentDefs } from './collabAgentCrud';
import { readBotMemory } from './botMemoryStore';
import { globalConfigDir } from './globalConfig';

type HostDirs = { configDir?(): string };

/** The directory `agent/*.md` lives in, for whichever config dir the host names. */
export const agentDirOf = (host: HostDirs): string => path.join(host.configDir?.() ?? globalConfigDir(), 'agent');

/**
 * BOTH def lists on every `collabAgentDefs` reply (t-kgtr6c): a reply carrying
 * only the collab list leaves the Vision tab showing the def it just deleted.
 *
 * `memoryFacts` is the one card fact that is NOT in the def file - whether a bot
 * has actually kept anything is a property of its store. It rides this reply,
 * keyed by slug and OMITTING a bot with an empty store, so the card can tell
 * "has remembered things" from "has a store configured but nothing in it"
 * without a second round trip per card.
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
