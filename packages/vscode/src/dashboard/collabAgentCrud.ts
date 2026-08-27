// Collabs M2 - collabAgentCrud.ts: create / edit / delete a collab agent by
// writing the same .md agent-definition file collabAgents.ts seeds.
//
// WHY THIS IS FILESYSTEM, NOT AN ENGINE METHOD. The `collab_agents` wire only
// carries slug/displayName/model, and this pane's editor needs persona,
// permission and steps too — so the list reads the DIRECTORY and shows what is
// really on disk. Liveness is no longer the reason: the engine re-scans defs on
// every collab-facing call (collab/acp.ts), so a saved def can JOIN the next
// collab immediately; only a DELETED def file lingers until the engine restarts.
//
// No `vscode` import: every path below is exercised against a real temp dir.
//
// The FILE FORMAT lives in collabAgentDef.ts and is re-exported below, so a
// caller still has one import for "collab agent defs" and this file is only
// ever about the directory.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { globalAgentDir } from './agentManager/archetypes';
import { parseAgentDef, serializeAgentDef, type CollabAgentDef } from './collabAgentDef';

export { parseAgentDef, serializeAgentDef, permissionBlockIn, type CollabAgentDef } from './collabAgentDef';

/**
 * The agent grammar. It is the FILENAME, so it has to survive being a path
 * segment on every platform: lowercase alphanumerics, `_` and `-`, first
 * character not punctuation, 64 max. Anything else is refused rather than
 * sanitised - silently rewriting the slug the user typed would mean the
 * @mention handle they were shown is not the one that works.
 */
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const fileFor = (dir: string, slug: string): string => path.join(dir, `${slug}.md`);

/**
 * Every collab-capable def on disk, slug-sorted.
 *
 * A directory that does not exist yet is an EMPTY list, not a failure - a fresh
 * install has no config dir until something writes one. An unreadable or
 * unparseable individual file is skipped rather than aborting the listing, so
 * one bad def cannot hide every good one.
 */
export function listCollabAgentDefs(dir = globalAgentDir()): CollabAgentDef[] {
  return listAgentDefs(dir).filter((def) => !def.visionProfile);
}

/**
 * Every VISION PROFILE on disk, slug-sorted (t-kgtr6c).
 *
 * A SEPARATE list rather than a flag on the collab one, because the two are
 * shown under different tabs and picked for different jobs. A profile leaking
 * into the collab roster would offer a describe-only agent as a collab
 * participant; a collab agent leaking into the profile list would offer to send
 * a picture to a model that cannot see it.
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
 * Write (create or overwrite) a def. Returns an error STRING on refusal rather
 * than throwing, so the host case stays a one-liner and every refusal reaches
 * the pane with a reason attached.
 *
 * A def that states NO preset INHERITS the one already on disk — block and step
 * budget included — and only a genuinely new file falls back to `worker`. That
 * is what stops a save widening an observer into a worker, or flattening a
 * hand-tuned block into a preset, when the caller simply had nothing to say
 * about permissions.
 *
 * `vision` obeys the SAME rule for the same reason: it decides whether real
 * image parts reach the agent, so an unstated one keeps the file's own value
 * rather than resetting a seeing agent to blind on an unrelated edit.
 *
 * `visionProfile` obeys it too, and is the sharpest case of the three: it
 * decides WHICH TAB the def lives under. An unstated one resetting to false
 * would silently move a vision profile into the collab roster on any save that
 * happened not to mention it — the def would vanish from the pane the user was
 * looking at and reappear somewhere it does not belong.
 */
export function writeCollabAgentDef(def: CollabAgentDef, dir = globalAgentDir()): string | null {
  if (!SLUG_RE.test(def.slug)) return `"${def.slug}" is not a valid agent name — use lowercase letters, digits, - and _.`;
  // ALL THREE inherit-when-unstated keys have to be listed here, not just the
  // two the rule started with: this decides whether the file on disk is read at
  // all, so a key missing from THIS line can never reach its own `?? prior`
  // branch below. A def that stated preset and vision but not `visionProfile`
  // took the `!needsPrior` short-circuit and was written verbatim — serialized
  // as `collab: true`, which moved the profile into the Collab tab.
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
        // The TOOL TICKS follow the same rule, and are the sharpest case after
        // `visionProfile`: an unstated set resetting to the preset block would
        // widen or narrow what the bot may DO on any save that happened not to
        // mention tools. `prior?.tools` is undefined for a blockless def, which
        // correctly leaves it blockless.
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
 * Delete a def.
 *
 * It REFUSES to delete a file that is not a collab agent, even when the slug is
 * well-formed: this is the one destructive path here, and the pane hands it a
 * slug from a list the user clicked. Re-reading the target first means a stale
 * list (or an archetype sharing a name) cannot turn a delete on the Collab
 * agents board into a delete of something else entirely.
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

// Archetype reference cards (architect/ask/debug/orchestrator/scout/
// cartographer — the same directory's non-collab defs) live in
// archetypeRefs.ts, kept out of this file so one import site still covers
// "everything the Collab agents board reads off this directory."
export { parseArchetypeRef, listArchetypeRefs, setArchetypeModel, type ArchetypeDefRef } from './archetypeRefs';
