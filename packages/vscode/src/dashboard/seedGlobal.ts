// seedGlobal.ts — once-per-version global seed sweep. /firstfold only seeds the default skill
// library into the WORKSPACE, so an unfolded or old workspace has none; this writes the same
// library once to the user's GLOBAL skill root (~/.origami/skills/) where the engine already scans.
// Touches only that subtree — no cwd, no workspace, no origami.json. The marker is a version string
// (not a boolean) so a release re-runs the sweep exactly once; a throw is logged and swallowed so a
// failed sweep retries next boot.
// Reconcile: absent -> write, unchanged -> skip, matches a prior shipped generation -> upgrade,
// anything else (user-modified) -> never touch.
// Every name here is also seeded by /firstfold into a workspace, so a folded workspace holds a
// duplicate pair. That's safe only while both copies stay byte-identical — GLOBAL_SEEDS reuses
// /firstfold's own values rather than transcribing them, and a future seed added as a copy would
// quietly break that property. On a name collision the engine's registry keeps whichever file's
// parse resolves last, which is not predictable.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_SKILLS } from './defaultSkills';
import { sampleSkillMd, wrapSkillMd } from './firstFold';
import { ARCHETYPES, globalAgentDir, isPristineArchetype } from './agentManager/archetypes';

/** Install-once marker, backed by globalState: carries the extension version that last completed a
 *  pass, so a release bump is the only thing that re-arms the sweep. */
export interface SeedVersionMarker {
  get(): string | undefined;
  set(version: string): void;
}

/** One seeded file; `file` is always relative to the global `.origami` root and uses `/`. */
export type GlobalSeed = { file: string; content: string };

/** The seeds as shipped now: v1 = /firstfold's whole skill library, in its order. Every payload is
 *  the SAME value /firstfold writes to a workspace, never a copy — byte-identity is what makes the
 *  duplicate-name collision above harmless. */
export const GLOBAL_SEEDS: GlobalSeed[] = [
  { file: 'skills/wrap/SKILL.md', content: wrapSkillMd() },
  { file: 'skills/example-skill/SKILL.md', content: sampleSkillMd() },
  ...Object.entries(DEFAULT_SKILLS).map(([name, content]) => ({
    file: `skills/${name}/SKILL.md`,
    content,
  })),
];

/** Every previously shipped generation of GLOBAL_SEEDS, oldest first. Release N+1 pushes release
 *  N's frozen array in here, and an entry once present is never edited. */
export const PRIOR_GENERATIONS: GlobalSeed[][] = [];

/** All prior payloads per file — a file byte-identical to any of them is a pristine older install,
 *  safe to overwrite. Built per call since the sweep runs at most once per version. */
function priorsByFile(generations: GlobalSeed[][]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const gen of generations) {
    for (const s of gen) {
      const list = out.get(s.file);
      if (list) list.push(s.content);
      else out.set(s.file, [s.content]);
    }
  }
  return out;
}

/** The engine's `~/.origami` (Global.Path.data), mirrored without importing effect.
 *  ORIGAMI_TEST_HOME/ORIGAMI_REPOS_HOME override it for tests; both unset in production. */
export function globalSeedRoot(): string {
  const home = process.env.ORIGAMI_TEST_HOME || process.env.ORIGAMI_REPOS_HOME || os.homedir();
  return path.join(home, '.origami');
}

/**
 * Seed the global assets for `version`, at most once per version.
 * Short-circuits on a matching marker; otherwise applies the reconcile above
 * to every seed and records the marker only after the whole pass succeeds.
 * Non-fatal: any error is logged and swallowed, leaving the marker unset so
 * the next boot retries.
 */
export function ensureGlobalSeeds(opts: {
  version: string;
  marker: SeedVersionMarker;
  dir?: string;
  priors?: GlobalSeed[][];
  log?: (msg: string) => void;
}): void {
  const log = opts.log ?? ((m) => console.warn(m));
  try {
    if (opts.marker.get() === opts.version) return;
    const root = opts.dir ?? globalSeedRoot();
    const prior = priorsByFile(opts.priors ?? PRIOR_GENERATIONS);
    for (const seed of GLOBAL_SEEDS) {
      const dest = path.join(root, ...seed.file.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) {
        fs.writeFileSync(dest, seed.content, 'utf8');
        continue;
      }
      const existing = fs.readFileSync(dest, 'utf8');
      if (existing === seed.content) continue; // already the shipped generation
      if ((prior.get(seed.file) ?? []).includes(existing)) {
        fs.writeFileSync(dest, seed.content, 'utf8'); // pristine older install
      }
    }
    opts.marker.set(opts.version);
  } catch (err) {
    log(`Origami global seed sweep skipped: ${String(err)}`);
  }
}

/**
 * The marker for the sweep below. A NAME, not a version: the pass exists to put ONE
 * change (t-f3a74m's default tool matrix) onto installs that already have the
 * archetype files, and it must run exactly once ever, not once per release.
 */
export const SUBAGENT_TOOLS_MARKER = 'subagent-tools-v1';

/**
 * Reconcile the six shipped archetype DEFINITIONS onto an existing install, once.
 *
 * `ensureArchetypes` (agentManager/archetypes.ts) already installs them, but its own
 * marker was recorded long ago on every install that has them, so a change to the
 * shipped payload alone reaches nobody. This is that marker bump, under a name of its
 * own so the two passes cannot cancel each other out.
 *
 * The reconcile policy is NOT restated here: `isPristineArchetype` is the same "did
 * the user edit this" test `ensureArchetypes` applies - byte-identical to the current
 * payload or to any generation we shipped before. A file that answers no is the
 * user's own and is left exactly as it is, matrix or no matrix.
 *
 * WRITES NOTHING TO origami.json. The matrix lives in the definition files; putting
 * any of it in the config would turn a default into an override the user never made,
 * and the ledger's "Reset to defaults" could then never get back to it.
 *
 * Non-fatal, like the sweep above: an error is logged and the marker left unset, so
 * the next boot retries.
 */
export function ensureSubagentToolDefaults(opts: {
  marker: SeedVersionMarker;
  dir?: string;
  log?: (msg: string) => void;
}): void {
  const log = opts.log ?? ((m) => console.warn(m));
  try {
    if (opts.marker.get() === SUBAGENT_TOOLS_MARKER) return;
    const dir = opts.dir ?? globalAgentDir();
    fs.mkdirSync(dir, { recursive: true });
    for (const archetype of ARCHETYPES) {
      const dest = path.join(dir, archetype.file);
      if (!fs.existsSync(dest)) {
        fs.writeFileSync(dest, archetype.content, 'utf8');
        continue;
      }
      const existing = fs.readFileSync(dest, 'utf8');
      if (existing === archetype.content) continue; // already carries the matrix
      if (isPristineArchetype(archetype.file, existing)) {
        fs.writeFileSync(dest, archetype.content, 'utf8');
      }
    }
    opts.marker.set(SUBAGENT_TOOLS_MARKER);
  } catch (err) {
    log(`Origami sub-agent tool defaults skipped: ${String(err)}`);
  }
}
