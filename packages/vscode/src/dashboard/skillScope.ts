// skillScope.ts — classifies each `list_skills` entry as `local` (found inside
// the open project) or `global` (user-level: available from any workspace),
// and names the directories actually walked for each scope, for the Skills
// pane's Local/Global selector (t-7vslix).
//
// Roots confirmed this session from the engine source, not assumed from the
// ticket: packages/engine/src/skill/index.ts (`CLAUDE_EXTERNAL_DIR = ".claude"`,
// `AGENTS_EXTERNAL_DIR = ".agents"`, pattern `skills/**/SKILL.md`, global scan
// rooted at `global.home`) and packages/engine/src/config/paths.ts
// (`ConfigPaths.directories` — project `.origami` dirs walked up to the
// worktree, PLUS `~/.origami` — scanned with `{skill,skills}/**/SKILL.md`).
// `~/.claude/skills` alone (the ticket's original claim) is real but not the
// only global root: `~/.origami/skills` and `~/.agents/skills` are too.
//
// NOT named in the empty state: `Global.Path.config` (XDG config, e.g.
// `~/.config/origami` or `%APPDATA%\origami` — packages/core/src/global.ts).
// It is a real fourth root `config.directories()` also scans, but no user-facing
// doc in this codebase tells anyone to put a skill there, so naming it would add
// noise without a directory a user would recognise or have populated.

import * as path from 'path';

export type SkillScope = 'local' | 'global';

/** True when `location` resolves inside `root`'s own subtree. A prefix test on
 *  the raw strings would let `C:\ws-old\...` pass for a skill under the
 *  unrelated sibling `C:\ws`; `path.relative` only returns a bare relative
 *  path (no leading `..`) for a genuine descendant, and is case-insensitive
 *  on win32 the same way the filesystem it is describing is. */
function isInside(root: string, location: string): boolean {
  const rel = path.relative(root, location);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** `local` only when the skill resolves inside the OPEN project (`cwd` — the
 *  workspace folder, `DashboardPanel.cwd`'s own fallback to `process.cwd()`).
 *  Never "not under home": a `skills.paths` config entry can point anywhere,
 *  so home-containment is not the test the engine itself applies — project
 *  containment is. Everything else — `~/.claude`, `~/.agents`, `~/.origami`,
 *  the pulled-URL cache, an out-of-project configured path — is `global`. */
export function classifyScope(location: string, cwd: string): SkillScope {
  return isInside(cwd, location) ? 'local' : 'global';
}

/** The directories `list_skills` scans for each scope, for the empty state.
 *  `.origami`'s pattern also matches a singular `skill/` dir (`{skill,skills}`);
 *  `skills` is shown because it is the spelling this workspace's own convention
 *  and AGENTS.md use. */
export function scanRoots(cwd: string, home: string): { local: string[]; global: string[] } {
  const named = (root: string) => [
    path.join(root, '.origami', 'skills'),
    path.join(root, '.claude', 'skills'),
    path.join(root, '.agents', 'skills'),
  ];
  return { local: named(cwd), global: named(home) };
}
