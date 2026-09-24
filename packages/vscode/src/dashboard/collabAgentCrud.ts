// Collabs — collabAgentCrud.ts: create / edit / delete a collab agent by
// writing the same .md agent-definition file collabAgents.ts seeds.
//
// Filesystem, not an engine method: the `collab_agents` wire only carries
// slug/displayName/model, but this pane's editor also needs persona,
// permission and steps. The engine re-scans defs on every collab call, so a
// saved def joins immediately; only a deleted file lingers until restart.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { globalAgentDir } from './agentManager/archetypes';
import { parseAgentDef, serializeAgentDef, type CollabAgentDef } from './collabAgentDef';

export { parseAgentDef, serializeAgentDef, permissionBlockIn, type CollabAgentDef } from './collabAgentDef';

/**
 * The agent grammar. It is the FILENAME, so it must survive being a path
 * segment: lowercase alphanumerics, `_`/`-`, 64 max. Refused rather than
 * sanitised — rewriting the slug would break the @mention handle shown to the user.
 */
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const fileFor = (dir: string, slug: string): string => path.join(dir, `${slug}.md`);

/**
 * Every collab-capable def on disk, slug-sorted. A missing directory is an
 * empty list, not a failure. An unreadable or unparseable file is skipped
 * rather than aborting the listing.
 */
export function listCollabAgentDefs(dir = globalAgentDir()): CollabAgentDef[] {
  return listAgentDefs(dir).filter((def) => !def.visionProfile);
}

/**
 * Every VISION PROFILE on disk, slug-sorted — a SEPARATE list from the
 * collab one, since a profile leaking into the collab roster would offer a
 * describe-only agent as a participant, and vice versa.
 */
export function listVisionAgentDefs(dir = globalAgentDir()): CollabAgentDef[] {
  return listAgentDefs(dir).filter((def) => def.visionProfile === true);
}

/** Both kinds, unfiltered — the one directory walk the two lists share. */
function listAgentDefs(dir: string): CollabAgentDef[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: CollabAgentDef[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    try {
      const def = parseAgentDef(name.slice(0, -3), fs.readFileSync(path.join(dir, name), 'utf8'));
      if (def) out.push(def);
    } catch {
      /* unreadable file - skip it, never fail the whole listing */
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** One def by slug, or null when it is absent or is not a collab agent. */
export function readCollabAgentDef(slug: string, dir = globalAgentDir()): CollabAgentDef | null {
  if (!SLUG_RE.test(slug)) return null;
  try {
    return parseAgentDef(slug, fs.readFileSync(fileFor(dir, slug), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write (create or overwrite) a def. Returns an error string on refusal
 * rather than throwing.
 *
 * A def that states NO preset INHERITS the one already on disk — block and
 * step budget included — so a save that has nothing to say about
 * permissions can't widen an observer into a worker or flatten a hand-tuned
 * block. `vision` and `visionProfile` follow the same rule: an unstated
 * value keeps the file's own, since `visionProfile` decides which TAB the
 * def lives under.
 */
export function writeCollabAgentDef(def: CollabAgentDef, dir = globalAgentDir()): string | null {
  if (!SLUG_RE.test(def.slug)) return `"${def.slug}" is not a valid agent name — use lowercase letters, digits, - and _.`;
    // All three inherit-when-unstated keys must be listed here, not just two:
    // this decides whether the file is read at all, so a key missing from this
    // line can never reach its own fallback branch below.
  const needsPrior = def.preset === undefined || def.vision === undefined
    || def.visionProfile === undefined || def.tools === undefined;
  const prior = needsPrior ? readCollabAgentDef(def.slug, dir) : null;
  const resolved: CollabAgentDef = !needsPrior
    ? def
    : {
        ...def,
        ...(def.preset === undefined
          ? {
              preset: prior?.preset ?? 'worker',
              customPermission: prior?.customPermission ?? '',
              steps: prior?.steps ?? '',
            }
          : {}),
                // Tool ticks follow the same rule: an unstated set resetting to the
                // preset block would widen or narrow what the bot may do on any unrelated save.
        ...(def.tools === undefined ? { tools: prior?.tools } : {}),
        ...(def.vision === undefined ? { vision: prior?.vision ?? false } : {}),
        ...(def.visionProfile === undefined ? { visionProfile: prior?.visionProfile ?? false } : {}),
      };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fileFor(dir, def.slug), serializeAgentDef(resolved), 'utf8');
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Delete a def. Refuses to delete a file that is not a collab agent, even
 * with a well-formed slug — the target is re-read first, so a stale list
 * can't turn a board delete into a delete of something else.
 */
export function deleteCollabAgentDef(slug: string, dir = globalAgentDir()): string | null {
  if (!readCollabAgentDef(slug, dir)) return `No agent named "${slug}".`;
  try {
    fs.unlinkSync(fileFor(dir, slug));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// Archetype reference cards live in archetypeRefs.ts, kept out of this file
// so one import site still covers everything this directory holds.
export { parseArchetypeRef, listArchetypeRefs, setArchetypeModel, type ArchetypeDefRef } from './archetypeRefs';
