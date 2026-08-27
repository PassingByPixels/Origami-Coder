// /firstfold — first-run workspace wizard. Shell-only: turns a blank
// folder into an Origami workspace (scaffold + knowledge layout) and,
// in a later step, writes the model provider config for the user.
//
// The runner emits checklist steps through `FirstFoldEmit` so the chat
// renders a live, ticking checklist. Scaffolding is idempotent: existing
// files are skipped, never overwritten.

import * as path from 'node:path';
import * as fs from 'node:fs';
import { DEFAULT_SKILLS } from './defaultSkills';
import {
  globalConfigPath,
  readConfigObject,
  readConfigForWrite,
  saveConfig,
} from './globalConfig';

/** A checklist item shown live in the slide-in todo overlay during /firstfold. */
export interface FirstFoldTodo {
  id: number;
  content: string;
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface FirstFoldEmit {
  /** Open the overlay (host marks the session in-flight + clears old todos). */
  start(): void;
  /** Replace the live todo list — drives the slide-in overlay. */
  todos(list: FirstFoldTodo[]): void;
  /** Append a system narration line to the chat (the walk-through). */
  narrate(line: string): void;
  /** Close the overlay → leaves a collapsed summary; `summary` is the final line. */
  done(summary: string): void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Per-step pacing so the walk-through is followable, not an instant blur. */
const PACE_MS = 600;

/** Result of scanning the workspace for build tooling. */
interface ScanResult {
  type: string;
  /** Markdown bullet block for the AGENTS.md "Build & test" section. */
  buildSection: string;
  /** Short human summary for the checklist step detail. */
  detail: string;
}

/** Read package.json scripts + project marker files to infer build/test/lint/run. */
function scanWorkspace(cwd: string): ScanResult {
  const lines: string[] = [];
  const types: string[] = [];

  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    types.push('Node');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const pick = (...names: string[]) => names.find(n => scripts[n]);
      const build = pick('build', 'compile');
      const test = pick('test');
      const lint = pick('lint', 'typecheck');
      const run = pick('dev', 'start', 'serve');
      if (build) lines.push(`- **Build:** \`npm run ${build}\``);
      if (test) lines.push(`- **Test:** \`npm ${test === 'test' ? 'test' : 'run ' + test}\``);
      if (lint) lines.push(`- **Lint:** \`npm run ${lint}\``);
      if (run) lines.push(`- **Run:** \`npm run ${run}\``);
    } catch {
      // malformed package.json — leave the bullets empty, note the type
    }
  }
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    types.push('Rust');
    lines.push('- **Build:** `cargo build`', '- **Test:** `cargo test`', '- **Lint:** `cargo clippy`', '- **Run:** `cargo run`');
  }
  if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'requirements.txt'))) {
    types.push('Python');
    lines.push('- **Test:** `pytest`');
  }
  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    types.push('Go');
    lines.push('- **Build:** `go build ./...`', '- **Test:** `go test ./...`');
  }

  const type = types.length ? types.join(' + ') : 'unknown';
  const buildSection = lines.length
    ? lines.join('\n')
    : '_No build tooling detected yet — fill these in as the project takes shape._';
  const detail = types.length
    ? `${type} project — ${lines.length} command(s) detected`
    : 'No recognised build tooling — left placeholders in AGENTS.md';
  return { type, buildSection, detail };
}

/** OS-specific shell note, written for the machine the fold runs on. Windows:
 *  the engine's `bash` tool runs PowerShell, so Unix flags error — warn the
 *  model up front. macOS: zsh with the BSD userland, whose GNU-flag gaps are
 *  the classic trap for a model trained mostly on Linux transcripts. Linux
 *  needs no note — Unix syntax is the model's default assumption. */
function shellNote(): string {
  if (process.platform === 'win32') {
    return `## This machine

- The shell (the \`bash\` tool) is **PowerShell on Windows**. Use PowerShell syntax — \`New-Item -ItemType Directory\`, \`Get-ChildItem\`, \`Invoke-WebRequest\` — **not** Unix flags like \`mkdir -p\`, \`ls -la\`, or \`curl -s\`, which error here.

`;
  }
  if (process.platform === 'darwin') {
    return `## This machine

- The shell (the \`bash\` tool) is **zsh on macOS** with the **BSD userland**: \`sed -i\` needs an explicit suffix (\`sed -i ''\`), \`grep\`/\`date\`/\`stat\` lack GNU-only flags, and \`readlink -f\`/\`tac\` may be missing. Prefer plain POSIX forms; Homebrew tools live under \`/opt/homebrew/bin\`.

`;
  }
  return '';
}

/** The LOCKED gold-standard AGENTS.md (Passing signed off on this content).
 *  The "Before you start" section was added under t-ra4pm8: the scaffold taught
 *  the agent to WRITE the handoff and the wiki and never to READ them, so the
 *  loop the rest of this file pays for was only ever half-closed. The owner's
 *  direction to add it IS the sign-off for that section. Everything else here
 *  still needs a fresh one.
 *  The map line joined it for the same reason one level down: the cartographer
 *  writes .origami/map/map.json for agents to READ, and a scaffolded workspace
 *  that never mentions it leaves every session re-deriving the architecture the
 *  last run already wrote down. It sits last in the block because it orients you
 *  in the CODE, after the two lines that orient you in the session. */
function agentsMd(projectName: string, buildSection: string): string {
  return `# ${projectName} — Origami workspace guide

> The agent reads this file first, every session. Keep it lean and current.

## How to work

- **Never satisfied.** A working result is the start, not the finish — name what's still weak and what's next.
- **Plan multi-step work with the todo list.** For anything beyond a step or two, call the todo tool *first* to lay the steps out, then tick each off as you finish it. Don't run a multi-part job as an unbroken wall of prose — the todo list keeps the work visible and stops sub-tasks slipping.
- **Delegate big or parallel work.** For a large multi-part job or a wide search, spin up sub-agents with the task tool — \`explore\` for read-only searching, \`general\` for multi-step work — and let them run in parallel instead of grinding through everything in one thread.
- **Push back.** If a request looks wrong, or there's a better way, say so and propose the alternative. Don't guess silently, and don't just agree to be agreeable.
- **Own mistakes flat.** When you get it wrong, say so plainly and fix it. No padding.
- **Be economical with words.** Short and direct. Skip filler and over-explaining.

## Coding discipline

- **Think before coding.** State your assumptions before you touch anything. If a request has more than one reading, surface them — don't silently pick one. Trivial jobs: use judgement; anything bigger, say the plan first. Caution over speed.
- **Simplicity first.** The least code that solves the problem. No speculative features, no abstractions for single-use code. The bar: would a senior engineer call this overcomplicated?
- **Surgical changes.** Touch only what the task needs. Match the surrounding style. Don't refactor adjacent code unasked. Prefer editing over rewriting — change the lines that need changing; don't regenerate a whole file from scratch.
- **Tests verify, not echo.** Assert observable behaviour against the requirement, not a restatement of the implementation. Red flags: a mock that only checks "method X was called", an assertion that mirrors the function body line-for-line, a fixture you computed by running the code under test. If you can't say what real bug a test would catch, don't write it.
- **Definition of done.** Done = verified with evidence (what you ran, what it output) and tests green. "Compiles" and "should work" are not done. Match the work to a check: "add validation" → failing tests for bad input first, then pass them; "fix a bug" → reproduce it in a test first, then fix; "refactor X" → tests green before AND after.

## Action safety

| Do without asking | Confirm first |
|---|---|
| Read, search, local edits in this workspace | Deletes outside the task scope, mass rewrites |
| Run tests, builds, linters, formatters | — |
| \`git status\` / \`diff\` / \`log\` / \`add\` / \`commit\` (when asked) | \`git push\` / \`push --force\` / \`reset --hard\`, history rewrites, branch deletes |
| Web reads (fetch, search) | Sending messages, posting, uploads to third-party services |

When unsure, ask. The cost of asking is low; undoing a bad push or a sent message is high.

## Before you start

- **Resuming work?** Read \`HANDOFF.md\` first — newest block at the top, directly below the marker. It says what happened last and what is next.
- **Picking up a task?** Search \`wiki/pages/\` for the topic before you re-derive anything. The depth behind every handoff block lives there, linked from the block's \`wiki:\` line. Re-deriving what is already written wastes the session.
- **Exploring the code?** If \`.origami/map/map.json\` exists, it is this repo's architecture map — read it before you go file by file.

## Session continuity — "update the handoff"

When the user says **"update the handoff"** — or "wrap up", "end session", "save where we are" — run **\`/wrap\`**. It does the whole close-out in one pass: adds the HANDOFF block at the file's marker, writes/updates the wiki page and its one-line index entry, then self-verifies. That keeps placement and the wiki standards consistent so you don't have to reconstruct them each time.

The rule \`/wrap\` enforces — and why it matters: a handoff is ALWAYS two writes, not one. (1) The terse block in HANDOFF.md (*what happened + what's next*). (2) The DEPTH in \`wiki/pages/<topic>.md\` (*the why and how* — design decisions, anything non-obvious), linked by \`wiki: [[page-name]]\`. **A handoff that skips the wiki is incomplete** — the next agent would get a one-liner and none of your reasoning.

When HANDOFF.md passes ~15 blocks, move the oldest into \`HANDOFF_archive.md\` and **flag it** — don't let it bloat (it eats the context window). The depth is safe in the wiki, linked from each block.

## Wiki

> All paths below are **relative to this workspace folder** (the project root). Write to \`wiki/index.md\`, never \`/wiki/index.md\` — a leading slash points at the filesystem root, not the workspace.

- One topic per page, in the workspace's \`wiki/pages/\` folder (e.g. \`wiki/pages/<topic>.md\`). Keep it flat — tags, not subfolders, do the categorising.
- Tag each page with a \`tags: [tag-one, tag-two]\` frontmatter block (2–4 lowercase, reusable tags) — this is how the memory graph clusters and weights pages, so reuse existing tags rather than coining new ones.
- Link related pages with \`[[page-name]]\` — the target's filename without \`.md\`. A link to a page that doesn't exist yet is fine; it marks something worth writing later.
- \`wiki/index.md\` (in this workspace) is the catalog — every page gets a one-line entry there.

## Layout

All of these live in this workspace folder (relative paths, no leading slash):

- \`projects/\` — active work, one folder per project
- \`scripts/\` — automation and helpers
- \`crons/\` — scheduled job definitions
- \`wiki/\` — knowledge base (see above)
- \`.origami/command/\` — your own slash commands (one \`.md\` each; frontmatter \`description\` + a prompt template)
- \`.origami/skills/<name>/SKILL.md\` — skills: reusable knowledge the agent loads on demand
- Plans are saved by Origami under \`.origami/plans/\`.

${shellNote()}## Build & test

${buildSection}
`;
}

/**
 * The same AGENTS.md text `runFirstFold` would seed, freshly scanned against
 * `cwd` — used by the Instructions pane's "Restore default" so a project
 * AGENTS.md restores to exactly the /firstfold default, never a second copy
 * of the template that could drift from this one.
 */
export function agentsMdTemplate(cwd: string): string {
  return agentsMd(path.basename(cwd) || 'workspace', scanWorkspace(cwd).buildSection);
}

/**
 * True when `cwd` has never been through /firstfold — no AGENTS.md at its
 * root yet. AGENTS.md is the first artefact a 'full' fold writes
 * (writeIfAbsent, above), so its absence is the cheapest honest signal that
 * nothing has been scaffolded. Callers must pass the SAME cwd `runFirstFold`
 * itself resolves (`findWorkspacePath() ?? extension cwd`) so this predicate
 * never disagrees with what a fold would actually create.
 */
export function needsFirstFold(cwd: string): boolean {
  return !fs.existsSync(path.join(cwd, 'AGENTS.md'));
}

/** Seeded wiki/index.md — explains the wiki concept (Passing asked for this primer). */
function wikiIndexMd(): string {
  return `# Wiki Index

The catalog for this workspace's knowledge base. All paths are relative to this workspace folder — write to \`wiki/pages/<topic>.md\`, never \`/wiki/pages/...\` (a leading slash means the filesystem root, not the workspace).

**How the wiki works**
- One topic per page, kept in this workspace's \`wiki/pages/\` folder.
- Link related pages with \`[[page-name]]\` — the target's filename without \`.md\`. Linking a page that doesn't exist yet is fine; it marks something worth writing later.
- This index lists every page with a one-line description. Add a line here whenever you create a page.

## Pages

_(none yet — add pages under \`wiki/pages/\` and list them here)_
`;
}

/** Terse, newest-first, append-only HANDOFF.md stub — built for a small local
 *  model + small context window: no curation, no "projects" taxonomy, no
 *  in-place edits; just append a short dated block and link depth to the wiki. */
function handoffStub(projectName: string, dateStr: string): string {
  return `# HANDOFF — ${projectName}

> Newest first, one block per chunk of work. This file is read at the start of
> every session, so terse beats complete — but write as much as the work needs.
> **Depth does not go here:** how something works, why a decision was made, full
> findings → a \`wiki/pages/<topic>.md\` page, linked from the block's \`wiki:\` line.
> HANDOFF = what happened + what's next; the wiki holds the depth. Don't skip it.
>
> To write a block, run **\`/wrap\`** — it places the block below the marker, writes
> the wiki page + index entry, and self-verifies. Never edit old blocks or this
> header by hand. Past ~15 blocks, move the oldest into \`HANDOFF_archive.md\`.
>
> Template:
> ## YYYY-MM-DD · <topic — a feature, a bug, a question, a note>
> done: <what changed or what you found>
> next: <the very next step — or "—">
> wiki: [[page-name]]   (the wiki page where you put the depth — omit if none)

<!-- HANDOFF:NEW-BLOCKS-BELOW · /wrap inserts here, newest first. Nothing goes above this line. -->

## ${dateStr} · setup
done: folded this workspace with /firstfold (AGENTS.md, wiki/, projects/ scripts/ crons/).
next: start your first task.
wiki: [[index]]
`;
}

/** Sample custom command — teaches the format by example. The engine discovers
 *  `.origami/command/**\/*.md`; frontmatter `description` + body = the prompt
 *  template ($ARGUMENTS is replaced with whatever follows the slash command). */
function sampleCommandMd(): string {
  return `---
description: Summarise recent git changes (example — edit or delete me)
---

Summarise what changed in the last $ARGUMENTS commits. Group the changes by area
and call out anything that looks risky or unfinished.
`;
}

/** Sample skill — teaches the format by example. The engine discovers
 *  `.origami/skills/<name>/SKILL.md`; frontmatter `name` + `description`, body =
 *  knowledge loaded on demand. `slash: true` also exposes it as a /command. */
function sampleSkillMd(): string {
  return `---
name: example-skill
category: reference
description: An example skill — replace with real knowledge for this project.
---

# Example skill

Skills give the agent reusable, on-demand knowledge — it loads this file when the
skill is relevant. Put project-specific knowledge here: conventions, gotchas, a
checklist for a recurring task. Keep it focused — one skill, one topic.

Discovered automatically from \`.origami/skills/<name>/SKILL.md\`. Add \`slash: true\`
to the frontmatter to also expose it as a /slash-command.
`;
}

/** The /wrap command — the workspace's session-close skill: HANDOFF block + wiki
 *  distil in one pass. Placement is deterministic (insert below the HANDOFF
 *  anchor marker via edit, so it can't cut into the header), and the wiki side
 *  is standardised (mandatory [[links]] + index entry) so the graph stays usable.
 *  This is why firstFold also seeds the marker into the HANDOFF stub. The wiki
 *  step also reframes the wiki itself: it is the agent's persistent memory, not
 *  an end-of-session filing chore, and it nudges the full markdown toolbox
 *  (diagrams, images, structure) over plain prose blocks where that says more. */
function wrapSkillMd(): string {
  return `---
name: wrap
category: workflow
description: End of session — add a HANDOFF block and distil the session's depth into the wiki, the agent's persistent memory, in one pass. Use when the user asks to update the handoff, distil to the wiki, wrap up, or close out a session.
slash: true
---

# /wrap — close out the session

One command, two linked jobs: a HANDOFF block (what happened + what's next) and
the wiki depth behind it, cross-linked so the knowledge graph stays usable. Do
BOTH — they're a pair, not a choice.

Work in this order.

## 1 · Decide what's worth recording

Look back over the session and pick out each distinct chunk of work worth a block
(usually one; occasionally two if you did genuinely separate things). Skip trivia.
If nothing of substance happened, say so and stop — don't manufacture a block.

## 2 · HANDOFF.md — the log

- Read \`HANDOFF.md\`.
- Write your block. **Length is yours to judge** — a single line for a small fix,
  a short paragraph for a real chunk. Terse beats complete, but never drop
  something the next session will need.
- **Placement is fixed — it is NOT "the top of the file":** insert the block on the
  line DIRECTLY BELOW the marker line containing \`HANDOFF:NEW-BLOCKS-BELOW\`, using
  the \`edit\` tool. Newest sits just under the marker and pushes older blocks down.
  Never touch the header, the marker line, or any existing block.
- Shape — keep these four anchors, expand the prose as the work needs:
  \`\`\`
  ## <YYYY-MM-DD> · <topic>
  done: <what changed / what you found>
  next: <the very next step, or —>
  wiki: [[<page-name>]]    (the page from step 3; omit ONLY if there's truly no depth)
  \`\`\`

## 3 · Wiki — the depth (standards are NOT optional)

**The wiki is the agent's memory, not an end-of-session chore.** A future session
starts cold and knows only what these pages hold — nothing you reasoned
through, tried, or ruled out crosses into the next context except through
here. Under-recording is memory loss, not economy: write each page as if it
is the only thing that will survive, because for the next session it is.

If there's any depth behind the block — how it works, why a call was made,
findings, gotchas — write or update a wiki page. These rules are what turn the
pages into a navigable graph instead of a pile. Follow them exactly:

- **One topic per page** at \`wiki/pages/<page-name>.md\` (kebab-case; \`<page-name>\`
  is the filename without \`.md\`). If the topic already has a page, UPDATE it —
  don't create a near-duplicate.
- **Tag every page.** At the very top, before the \`#\` title, add a frontmatter
  block with 2–4 lowercase, REUSABLE tags — a \`---\` line, a \`tags: [tag-one, tag-two]\`
  line, then a closing \`---\`. Tags are how the graph clusters and weights pages,
  so REUSE tags that already appear on other pages (a shared tag pulls them into
  one cluster) rather than coining a unique tag per page; prefer broad recurring
  themes (\`story\`, \`bugfix\`, \`prompts\`, \`architecture\`) over narrow labels. Flat
  \`wiki/pages/\` + tags does the categorising — don't create subfolders.
- **Every page links out.** Include a \`## Links\` section with at least one
  \`[[other-page]]\` to a related page. This is the single most important rule —
  no outbound links means no graph. Linking a page that doesn't exist yet is fine;
  it flags one worth writing later.
- **Structure, in this exact order:**
  \`\`\`
  ---
  tags: [tag-one, tag-two]
  ---
  # <Title>

  <one-paragraph, plain-language summary of what this is>

  ## Detail
  <the actual depth — how / why / findings / gotchas>

  ## Links
  - [[related-page]] — why it's related
  \`\`\`
- **Index bookkeeping:** if the page is NEW, add exactly one line to
  \`wiki/index.md\` under its \`## Pages\` heading:
  \`- [[<page-name>]] - <one-line description>\`
  Leave every other entry as-is — don't reorder or rewrite the list.

### Write with the whole toolbox

Markdown renders in full in the wiki and its preview. Plain prose is the
default, not the only option — and it's often not the clearest one. Reach past
it when it earns its place:

- **Mermaid diagrams** for flows, architectures, state machines, sequences —
  fence the block with \`mermaid\` and it renders as a real diagram. One fence
  away, and it often says in a glance what three paragraphs would fumble.
- **Screenshots and images** (\`![caption](relative-path.png)\`) when a picture
  carries more detail than the words would — a UI state, a graph, an error
  dialog. Save the image beside the page it belongs to.
- **Tables** for enumerable facts, **task lists** (\`- [ ]\`) for open items,
  **fenced code blocks with a language tag** for anything runnable,
  **\`<details>\`** blocks to fold a long dump so the page stays scannable, and
  **blockquote callouts** (\`> \`) for warnings and gotchas.
- The test: would a diagram or picture make this page say more? If yes, and
  it's cheap, add it. This is a nudge, not a mandate — plain prose is still
  the right call when prose genuinely is the clearest form.

### Optional — what a skill taught you

Only when it applies: if this session used one of the workspace's skills and you
learned an adaptation or hit a gotcha the skill itself doesn't cover (a step that
doesn't fit this project, a tool that behaves differently here), distil that into
a wiki page tagged \`skills\` and link it from the block's \`wiki:\` line. Write the
lesson, not a summary of the skill — the skill file is already on disk. Nothing
learned about a skill this session? Skip this; don't manufacture one.

## 4 · Verify, then report (do not skip)

- Re-read \`HANDOFF.md\`: your block is directly below the marker, the header and
  marker are intact, and older blocks are untouched.
- Re-read \`wiki/index.md\`: your new page has exactly one entry (skip if you only
  updated an existing page).
- Confirm the page opens with a \`tags:\` frontmatter block (2–4 reusable tags).
- Grep the new/updated wiki page for \`[[\` — confirm it has at least one outbound
  link.

Report what you wrote and what you checked. If a check fails, fix it before you stop.
`;
}

/** Write a file only if absent. Returns 'done' (written) or 'skip' (existed). */
function writeIfAbsent(filePath: string, content: string): 'done' | 'skip' {
  if (fs.existsSync(filePath)) return 'skip';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return 'done';
}

/** Create a folder (with a .gitkeep) if missing. Returns whether it was created. */
function ensureFolder(dir: string): boolean {
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  const keep = path.join(dir, '.gitkeep');
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, '', 'utf8');
  return !existed;
}

/** Coerce an unknown JSON value to a plain object (empty if it isn't one). */
function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Read the engine's resolved model id (global config), if any. */
export function detectModel(): string | null {
  try {
    const cfg = readConfigObject(globalConfigPath()) as { model?: string } | null;
    return cfg && typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model.trim() : null;
  } catch {
    return null;
  }
}

/** True when a base URL points at THIS machine (loopback). "Local" = an endpoint
 *  the `lms` CLI can actually control — i.e. LM Studio on localhost. A remote
 *  endpoint (vLLM on the tailnet, a LAN LM Studio, OpenRouter) is reachable but
 *  NOT lms-manageable from here, so it must never be treated as the local one. */
export function isLoopbackBaseUrl(u: unknown): boolean {
  if (typeof u !== 'string' || !u) return false;
  try {
    const host = new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/** Find the local OpenAI-compatible provider (LM Studio) in the global config —
 *  its id + display name. Lets live-polled models be tagged + written to the
 *  right provider block. Null if none is configured.
 *
 *  The LOOPBACK check is load-bearing: vLLM / OpenRouter are ALSO
 *  `openai-compatible`, so keying only on `npm` would misclassify whichever
 *  remote provider sorts FIRST in the config as "local" — and then fire
 *  `lms unload/load` against it (evicting LM Studio's model + a doomed load of an
 *  id LM Studio doesn't have). Only a loopback endpoint is lms-manageable. */
export function detectLocalProvider(): { id: string; name: string } | null {
  try {
    const cfg = readConfigObject(globalConfigPath()) as {
      provider?: Record<string, { npm?: unknown; name?: unknown; options?: { baseURL?: unknown } }>;
    } | null;
    if (!cfg) return null;
    const providers = cfg.provider ?? {};
    for (const [id, block] of Object.entries(providers)) {
      if (typeof block?.npm === 'string' && block.npm.includes('openai-compatible')
          && isLoopbackBaseUrl(block?.options?.baseURL)) {
        return { id, name: typeof block.name === 'string' ? block.name : id };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** A model provider chosen by the user in the interactive connect step. */
export interface ModelChoice {
  providerId: string;   // 'lmstudio' | 'openai' | 'xai' | 'anthropic'
  providerName: string; // display name
  npm?: string;         // sdk package — only for custom/local providers (LM Studio)
  baseURL?: string;     // endpoint — only for custom/local providers
  apiKey?: string;      // for hosted providers
  /** EXPLICIT intent to remove a stored key — set ONLY by the Re-key form's
   *  blank submit (ControlStrip -> setupProvider.ts). It is a separate field
   *  BECAUSE intent-to-clear cannot be inferred from `apiKey` being absent:
   *  absence is what every key-unrelated caller passes (see writeModelConfig). */
  clearApiKey?: boolean;
  modelId: string;
  modelName: string;
  /** Optional pricing (USD per MILLION tokens) written into the model's config
   *  block so the engine computes real cost — `provider.ts` maps `model.cost`
   *  from config. Needed for OpenRouter, whose pricing isn't in the (empty at
   *  runtime) models.dev catalog; omit for free/local models. */
  cost?: { input: number; output: number };
  /** The context window the SERVER ITSELF reported for `modelId` at connect time
   *  (vLLM's `max_model_len` and friends, via fetchModelInfo). Baked into the
   *  block's `limit.context` by writeModelConfig below, so a freshly-connected
   *  self-hosted provider starts life with a REAL window instead of the 0 that
   *  disables auto-compaction outright. 0/absent = the server published none, and
   *  the entry is written exactly as it was before this field existed. */
  servedContext?: number;
  /** Extra models to declare in the same block, with their full config fields
   *  (limit / capabilities / modalities). An OAuth connection needs this: the
   *  provider's whole catalog has to exist in config before the engine can
   *  resolve any of it (models.dev is empty in this fork), and `modelId` alone
   *  would declare exactly one. Merged per model, so a hand-edited override
   *  survives a re-connect. */
  catalog?: Record<string, Record<string, unknown>>;
}

/** The host's interactive provider picker. Returns null if the user cancels. */
export type ConnectModelFn = () => Promise<ModelChoice | null>;

/**
 * Merge a chosen provider into the GLOBAL origami.json and set it as the
 * default model. Machine-wide (where the working config already lives) so a
 * fresh machine is set up once for every workspace. Backs up any existing
 * config and never overwrites unrelated keys. Throws on a corrupt config
 * rather than clobbering it. Returns the written path + the `provider/model` id.
 *
 * `automatic` marks a write NOT caused by a user action — today only
 * maybeAdoptRemoteServedModel's background poll. Such a write takes no backup:
 * the `.bak` chain is the user's rollback point for what the USER did, and a
 * background writer consuming a slot is how a hand-edit gone wrong used to
 * become unrecoverable (connections review finding 8).
 */
export function writeModelConfig(choice: ModelChoice, opts: { automatic?: boolean } = {}): { path: string; model: string } {
  const cfgPath = globalConfigPath();
  const loaded = readConfigForWrite(cfgPath);
  const cfg: Record<string, unknown> = loaded?.cfg ?? {};
  const providers = asObj(cfg.provider);
  const block = asObj(providers[choice.providerId]);
  block.name = choice.providerName;
  if (choice.npm) block.npm = choice.npm;
  const options = asObj(block.options);
  if (choice.baseURL) options.baseURL = choice.baseURL;
  // A truthy key writes/replaces it. Removing one takes the EXPLICIT
  // `clearApiKey` — Re-key's "leave blank to remove the key" contract, carried
  // as its own field.
  //
  // 0.4.28 inferred the clear from `apiKey` simply being ABSENT, and that was
  // the wrong signal: absence is what every caller with no business knowing a
  // key already passes — the chat-pane model pin, the lms swap,
  // adoptLoadedModel, the background maybeAdoptRemoteServedModel, OAuth
  // completion (keyless BY DESIGN) and firstFold's LM Studio branch. Pinning a
  // model on OpenRouter therefore deleted its key, and the next prompt went out
  // with no Authorization header at all. Intent is now stated, never guessed.
  if (choice.apiKey) options.apiKey = choice.apiKey;
  else if (choice.clearApiKey) delete options.apiKey;
  block.options = options;
  const models = asObj(block.models);
  // Merge, don't clobber: preserve any per-model capability overrides
  // (e.g. the vision `attachment`/`modalities` set via writeModelVision)
  // when a model is re-selected.
  models[choice.modelId] = {
    ...asObj(models[choice.modelId]),
    name: choice.modelName,
    // Pricing (per-million USD) so the engine computes real cost; only written
    // when supplied (OpenRouter). Preserve an existing cost when not re-supplied.
    ...(choice.cost ? { cost: { input: choice.cost.input, output: choice.cost.output } } : {}),
  };
  // The rest of a multi-model connection's catalog (OAuth providers), merged
  // the same way so per-model overrides survive.
  for (const [id, fields] of Object.entries(choice.catalog ?? {})) {
    models[id] = { ...asObj(models[id]), ...fields };
  }
  block.models = models;
  providers[choice.providerId] = block;
  cfg.provider = providers;

  const model = `${choice.providerId}/${choice.modelId}`;
  cfg.model = model;
  saveConfig(cfgPath, cfg, opts.automatic ? null : loaded);
  // …and, when the server told us its window, bake it in the same breath. Through
  // writeModelContextLimit rather than inline above, so the SHAPE rule ({context,
  // output} — a bare context invalidates the whole config) and the "never overrule
  // a hand-set window" rule have exactly one implementation. onlyWhenUnset because
  // a re-connect must not stomp a limit the user deliberately lowered. It runs
  // AFTER the save, since it refuses to write into a provider block that does not
  // exist yet, and it is a no-op for every caller that reports no window.
  if (choice.servedContext) {
    writeModelContextLimit(choice.providerId, choice.modelId, choice.servedContext, { onlyWhenUnset: true });
  }
  return { path: cfgPath, model };
}

/**
 * Persist a PROBED context window onto an existing model's config block, so the
 * ENGINE stops resolving `limit.context` to 0 for local models.
 *
 * Why this exists: the extension probes the real window accurately (LM Studio's
 * `loaded_context_length`, vLLM's `max_model_len`) but only ever used it for its
 * own UI. `provider.ts` resolves `model.limit?.context ?? existingModel?.limit
 * ?.context ?? 0` — and nothing wrote that field — so every local model came out
 * 0, which disables auto-compaction outright (`session/overflow.ts` isOverflow()
 * hard-returns false at context 0) and suppresses the usage event that feeds the
 * gauge. This is the bridge between the two systems.
 *
 * SHAPE: the config schema (`@origami/core/v1/config/provider` Model.limit) makes
 * `output` REQUIRED alongside `context` — a bare `{ context }` fails the strict
 * `decodeUnknownExit` in config/parse.ts and invalidates the WHOLE config. So we
 * preserve any existing `output` and otherwise write 0, which is exactly what the
 * engine already defaults to for these models and which `maxOutputTokens` treats
 * as "unset" (`Math.min(0, max) || max`). Only `limit` changes.
 *
 * Deliberately NARROW vs writeModelConfig: it never touches `cfg.model` (a probe
 * must not re-point the default model), never creates a provider block, and only
 * ever writes a genuinely probed positive window. Read + write happen with no
 * await between them, so a concurrent chat's engine can't interleave a lost
 * update. Best-effort: any missing/corrupt config is a no-op, never a throw.
 *
 * `onlyWhenUnset` — for a REMOTE server, whose reported window is a static server
 * maximum the user may have deliberately capped LOWER in config (a smaller window
 * = compact earlier). There we only FILL A HOLE. For a local LM Studio model the
 * loaded window genuinely changes with every `lms load -c`, so the probe is
 * authoritative and overwrites.
 *
 * NO BACKUP, deliberately. Both call sites are automatic — reprobeModel() and
 * refreshModelInfoFor() in DashboardPanel.ts, neither triggered by the user.
 * Rotating the `.bak` chain here would spend the user's rollback slots on
 * background probes, which is exactly how a bad hand-edit became unrecoverable
 * (connections review finding 8).
 *
 * Returns true only when the file was actually rewritten. A FAILURE is no
 * longer silent: it warns with the path and the reason, and calls `onError`, so
 * the caller can tell the user that auto-compaction is off for this model
 * (finding 9). The legitimate no-ops below stay quiet.
 */
export function writeModelContextLimit(
  providerId: string,
  modelId: string,
  context: number,
  opts: { onlyWhenUnset?: boolean; onError?: (message: string) => void } = {},
): boolean {
  if (!providerId || !modelId) return false;
  if (!Number.isFinite(context) || context <= 0) return false; // never persist a guess/placeholder
  const cfgPath = globalConfigPath();
  try {
    const loaded = readConfigForWrite(cfgPath);
    if (!loaded) return false;
    const cfg = loaded.cfg;
    const providers = asObj(cfg.provider);
    if (!(providerId in providers)) return false; // don't invent a provider we never configured
    const block = asObj(providers[providerId]);
    const models = asObj(block.models);
    const model = asObj(models[modelId]);
    const prevLimit = asObj(model.limit);
    if (prevLimit.context === context) return false; // already right — no churn, no .bak rewrite
    // Never stomp a deliberately hand-set window for a server whose number is a
    // static maximum; only fill the 0/absent case this whole fix exists for.
    if (opts.onlyWhenUnset && typeof prevLimit.context === 'number' && prevLimit.context > 0) return false;
    const output = typeof prevLimit.output === 'number' && Number.isFinite(prevLimit.output) ? prevLimit.output : 0;
    // Merge: keep name/cost/attachment/modalities and any sibling limit fields.
    models[modelId] = { ...model, limit: { ...prevLimit, context, output } };
    block.models = models;
    providers[providerId] = block;
    cfg.provider = providers;
    saveConfig(cfgPath, cfg);
    return true;
  } catch (e) {
    // A corrupt/unreadable/commented config is not worth THROWING a probe over,
    // but it is worth saying out loud: the consequence is auto-compaction off.
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[origami] could not persist the probed context window for ${providerId}/${modelId} to ${cfgPath}: ${message}`);
    opts.onError?.(message);
    return false;
  }
}

/**
 * Does picking this local model actually require an `lms unload --all` + `load`?
 *
 * Only when something would genuinely CHANGE. Re-picking the model that is
 * already loaded, at the context it is already loaded at, used to evict and
 * re-load it anyway — tens of seconds of dead GPU, and (because LM Studio serves
 * one model at a time) the switch then carries every OTHER chat on that provider
 * onto the "new" model, cascading the pointless reload across the window.
 *
 * Skip requires ALL of: the server reports a model genuinely loaded, it is the
 * requested id, and its window equals the requested one. An unknown window on
 * either side (0) is NOT a match — we reload rather than assume.
 */
export function shouldReloadLocalModel(input: {
  requestedModelId: string;
  requestedContext: number;
  loaded: { ok: boolean; modelId: string; contextLength: number };
}): boolean {
  const { requestedModelId, requestedContext, loaded } = input;
  if (!loaded.ok || !loaded.modelId) return true;
  if (loaded.modelId !== requestedModelId) return true;
  if (!(requestedContext > 0) || loaded.contextLength !== requestedContext) return true;
  return false;
}

/** First `provider/model` id found across the given provider blocks, or null. */
function firstConfiguredModel(providers: Record<string, unknown>): string | null {
  for (const [pid, block] of Object.entries(providers)) {
    const models = asObj(asObj(block).models);
    const first = Object.keys(models)[0];
    if (first) return `${pid}/${first}`;
  }
  return null;
}

/** Remove a provider block from the GLOBAL origami.json (the reverse of
 *  writeModelConfig). If the active `model` pointed at the removed provider it is
 *  repointed to another configured model, or cleared when none remain. Backs the
 *  file up first. Returns the new active model (null = none left) and whether a
 *  block was actually removed. No-op (removed:false) if the provider isn't
 *  present. Throws on a corrupt config rather than clobbering it. */
export function removeProviderConfig(providerId: string): { path: string; model: string | null; removed: boolean } {
  const cfgPath = globalConfigPath();
  const loaded = readConfigForWrite(cfgPath);
  if (!loaded) return { path: cfgPath, model: null, removed: false };
  const cfg = loaded.cfg;
  const providers = asObj(cfg.provider);
  if (!(providerId in providers)) {
    return { path: cfgPath, model: typeof cfg.model === 'string' ? cfg.model : null, removed: false };
  }
  delete providers[providerId];
  cfg.provider = providers;
  let model = typeof cfg.model === 'string' ? cfg.model : null;
  if (model && model.startsWith(providerId + '/')) {
    const next = firstConfiguredModel(providers);
    if (next) { cfg.model = next; model = next; }
    else { delete cfg.model; model = null; }
  }
  saveConfig(cfgPath, cfg, loaded);
  return { path: cfgPath, model, removed: true };
}

/** Rename a configured provider — change ONLY its display name (`block.name`),
 *  the pill label. The provider id (the routing key) is left untouched, so
 *  models keep resolving. Backs the file up first. No-op if absent or the name
 *  is blank. Throws on a corrupt config rather than clobbering it. */
export function renameProviderConfig(providerId: string, name: string): { path: string; renamed: boolean } {
  const cfgPath = globalConfigPath();
  const trimmed = name.trim();
  if (!trimmed) return { path: cfgPath, renamed: false };
  const loaded = readConfigForWrite(cfgPath);
  if (!loaded) return { path: cfgPath, renamed: false };
  const cfg = loaded.cfg;
  const providers = asObj(cfg.provider);
  if (!(providerId in providers)) return { path: cfgPath, renamed: false };
  const block = asObj(providers[providerId]);
  block.name = trimmed;
  providers[providerId] = block;
  cfg.provider = providers;
  saveConfig(cfgPath, cfg, loaded);
  return { path: cfgPath, renamed: true };
}

/** Provider block as it appears in the GLOBAL origami.json. `max_concurrent` is
 *  read by the engine (a per-provider request cap); it has no UI (a server's cap
 *  isn't discoverable and vLLM queues excess itself), so it's a config-only knob. */
export interface ConfiguredProvider {
  name?: string;
  npm?: string;
  options?: { baseURL?: string; apiKey?: string; max_concurrent?: number };
  models?: Record<string, { name?: string }>;
}

/** Read the provider blocks from the GLOBAL origami.json (the same file
 *  writeModelConfig writes). Returns `{}` when the file is absent or corrupt so a
 *  caller can probe per-provider liveness without duplicating the path/parse
 *  logic. Read-only — never writes. */
export function readGlobalProviders(): Record<string, ConfiguredProvider> {
  try {
    const cfg = readConfigObject(globalConfigPath());
    const prov = cfg?.provider;
    return prov && typeof prov === 'object' ? (prov as Record<string, ConfiguredProvider>) : {};
  } catch {
    return {};
  }
}

/** Read the per-agent frequency-penalty override from the global config (default
 *  "build" — the chat agent). null = unset (the engine's model-gated default
 *  applies: ~0.3 for local models, none for cloud). */
export function readAgentFrequencyPenalty(agentName = 'build'): number | null {
  try {
    const cfg = readConfigObject(globalConfigPath());
    if (!cfg) return null;
    const agent = asObj(asObj(cfg.agent)[agentName]);
    const v = agent.frequency_penalty;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Write (or clear) the per-agent frequency-penalty in the GLOBAL origami.json.
 *  null = remove the key (unset → the engine's model-gated default applies again).
 *  The engine re-reads it per request (Config.getLiveAgentSampling), so a change
 *  applies on the next message — no respawn. Touches ONLY frequency_penalty.
 *  Returns the written path. */
export function writeAgentFrequencyPenalty(value: number | null, agentName = 'build'): { path: string } {
  const cfgPath = globalConfigPath();
  const loaded = readConfigForWrite(cfgPath);
  const cfg: Record<string, unknown> = loaded?.cfg ?? {};

  const agents = asObj(cfg.agent);
  const agent = asObj(agents[agentName]);
  if (value === null) delete agent.frequency_penalty;
  else agent.frequency_penalty = value;
  if (Object.keys(agent).length === 0) delete agents[agentName];
  else agents[agentName] = agent;
  if (Object.keys(agents).length === 0) delete cfg.agent;
  else cfg.agent = agents;

  saveConfig(cfgPath, cfg, loaded);
  return { path: cfgPath };
}

/** Split a `provider/model` id into its parts. The provider is everything
 *  before the FIRST slash; model ids themselves may contain slashes
 *  (e.g. `lmstudio/qwen/qwen3-coder-30b` → `lmstudio` + `qwen/qwen3-coder-30b`).
 *  Null if the ref isn't a well-formed `provider/model`. */
export function splitModelRef(ref: string): { providerId: string; modelId: string } | null {
  const i = ref.indexOf('/');
  if (i <= 0 || i >= ref.length - 1) return null;
  return { providerId: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

/** List the model ids configured under a provider block in the global config. */
export function listConfiguredModels(providerId: string): string[] {
  try {
    const cfg = readConfigObject(globalConfigPath());
    if (!cfg) return [];
    return Object.keys(asObj(asObj(asObj(cfg.provider)[providerId]).models));
  } catch {
    return [];
  }
}

/** Read whether image (vision) input is enabled for a model in the global
 *  config — i.e. its `modalities.input` includes "image". */
export function readModelVision(providerId: string, modelId: string): boolean {
  try {
    const cfg = readConfigObject(globalConfigPath());
    if (!cfg) return false;
    const model = asObj(asObj(asObj(asObj(cfg.provider)[providerId]).models)[modelId]);
    const input = asObj(model.modalities).input;
    return Array.isArray(input) && input.includes('image');
  } catch {
    return false;
  }
}

/** Toggle image-input (vision) capability for a model in the GLOBAL origami.json.
 *  Sets/removes `attachment` + `modalities.input:["text","image"]` on the model
 *  entry. "text" MUST stay in the list: the engine derives text-input support
 *  from `modalities.input.includes("text")`, so `["image"]` alone would disable
 *  text. The engine reads capabilities at startup, so the caller must respawn
 *  (window reload) for the change to take effect. Returns the written path. */
export function writeModelVision(input: { providerId: string; modelId: string; enabled: boolean }): { path: string } {
  const cfgPath = globalConfigPath();
  const loaded = readConfigForWrite(cfgPath);
  const cfg: Record<string, unknown> = loaded?.cfg ?? {};

  const providers = asObj(cfg.provider);
  const block = asObj(providers[input.providerId]);
  const models = asObj(block.models);
  const model = asObj(models[input.modelId]);
  if (input.enabled) {
    model.attachment = true;
    const modalities = asObj(model.modalities);
    modalities.input = ['text', 'image'];
    model.modalities = modalities;
  } else {
    delete model.attachment;
    delete model.modalities;
  }
  models[input.modelId] = model;
  block.models = models;
  providers[input.providerId] = block;
  cfg.provider = providers;
  saveConfig(cfgPath, cfg, loaded);
  return { path: cfgPath };
}

export interface FirstFoldResult {
  /** Set when a model config was newly written (caller should respawn to apply). */
  modelWritten: { model: string; path: string } | null;
}

export interface FirstFoldOpts {
  /** 'full' = scaffold + model; 'model' = just the model-connect step. */
  mode: 'full' | 'model';
  /** Host-provided interactive provider picker (uses VS Code QuickPick/InputBox). */
  connectModel: ConnectModelFn;
  /** Host-provided yes/no ask used in 'full' mode when a model already exists —
   *  returns true to reconfigure, false to keep the current one. */
  confirmReconfigure: (existing: string) => Promise<boolean>;
}

/** One walk-through step: a todo line + the work it performs. `run` narrates
 *  what it's doing and returns void; the model step sets `modelWritten`. */
interface StepDef {
  content: string;
  activeForm: string;
  run: () => Promise<void> | void;
}

/**
 * Run /firstfold as a paced, narrated walk-through that drives the live todo
 * overlay (the same slide-in used for tool work). In 'full' mode it scans the
 * workspace, scaffolds the Origami layout idempotently, then connects a model;
 * in 'model' mode only the model-connect step runs.
 */
export async function runFirstFold(cwd: string, emit: FirstFoldEmit, opts: FirstFoldOpts): Promise<FirstFoldResult> {
  emit.start();
  const full = opts.mode === 'full';
  const projectName = path.basename(cwd) || 'workspace';
  const dateStr = new Date().toISOString().slice(0, 10);
  // Holder (not a bare `let`) so the model step's closure can assign it without
  // tripping TS's "captured + reassigned in a nested function" flow narrowing.
  const result: FirstFoldResult = { modelWritten: null };
  let scan: ScanResult | null = null;

  // --- the model-connect step (shared by both modes) -----------------------
  const modelStep: StepDef = {
    content: 'Connect a model',
    activeForm: 'Connecting a model',
    run: async () => {
      const existing = detectModel();
      if (full && existing) {
        emit.narrate(`A model is already configured (\`${existing}\`).`);
        const redo = await opts.confirmReconfigure(existing);
        if (!redo) { emit.narrate(`Keeping \`${existing}\`.`); return; }
      }
      emit.narrate('Pick a provider — I\'ll write its config into your global origami.json.');
      const choice = await opts.connectModel();
      if (!choice) { emit.narrate(existing ? `Cancelled — kept \`${existing}\`.` : 'Cancelled — no model set.'); return; }
      const written = writeModelConfig(choice);
      result.modelWritten = written;
      emit.narrate(`Wrote \`${written.model}\` to your global origami.json — reload the window to use it.`);
    },
  };

  const steps: StepDef[] = full ? [
    {
      content: 'Scan the workspace',
      activeForm: 'Scanning the workspace',
      run: () => {
        emit.narrate('Looking for build tooling — package.json, Cargo.toml, pyproject, go.mod…');
        scan = scanWorkspace(cwd);
        emit.narrate(`→ ${scan.detail}.`);
      },
    },
    {
      content: 'Write AGENTS.md',
      activeForm: 'Writing AGENTS.md',
      run: () => {
        emit.narrate('Writing AGENTS.md — the guide the agent reads first every session.');
        const r = writeIfAbsent(path.join(cwd, 'AGENTS.md'), agentsMd(projectName, scan?.buildSection ?? ''));
        emit.narrate(r === 'skip' ? '→ AGENTS.md already exists — left it untouched.' : '→ Created AGENTS.md (how-to-work, coding discipline, action safety, wiki primer).');
      },
    },
    {
      content: 'Create projects/ scripts/ crons/',
      activeForm: 'Creating the workspace folders',
      run: () => {
        emit.narrate('Creating the workspace folders.');
        const created = ['projects', 'scripts', 'crons'].filter(d => ensureFolder(path.join(cwd, d)));
        emit.narrate(created.length ? `→ Created ${created.join(', ')}.` : '→ All present already.');
      },
    },
    {
      content: 'Seed the wiki',
      activeForm: 'Seeding the wiki',
      run: () => {
        emit.narrate('Seeding wiki/ with an index primer (one topic per page, [[links]], workspace-relative paths).');
        ensureFolder(path.join(cwd, 'wiki', 'pages'));
        const r = writeIfAbsent(path.join(cwd, 'wiki', 'index.md'), wikiIndexMd());
        emit.narrate(r === 'skip' ? '→ wiki/index.md already exists.' : '→ Created wiki/index.md.');
      },
    },
    {
      content: 'Create HANDOFF.md',
      activeForm: 'Creating HANDOFF.md',
      run: () => {
        emit.narrate('Creating HANDOFF.md — the rolling session log.');
        const r = writeIfAbsent(path.join(cwd, 'HANDOFF.md'), handoffStub(projectName, dateStr));
        emit.narrate(r === 'skip' ? '→ HANDOFF.md already exists — left it untouched.' : '→ Created HANDOFF.md.');
      },
    },
    {
      content: 'Seed commands & skills',
      activeForm: 'Seeding commands & skills',
      run: () => {
        emit.narrate('Seeding .origami/ with the default skill library (/wrap, grilling, spec + tickets, TDD, review…) and an example command — the engine auto-discovers them.');
        ensureFolder(path.join(cwd, '.origami', 'command'));
        // wrap + example-skill live here (beside the HANDOFF stub /wrap edits);
        // the rest are data in defaultSkills.ts. One loop, so a new default skill
        // is an entry in that map and nothing else. writeIfAbsent keeps a re-run
        // harmless: an edited skill is the user's, never ours to restore.
        const library: Record<string, string> = { wrap: wrapSkillMd(), 'example-skill': sampleSkillMd(), ...DEFAULT_SKILLS };
        const seeded: string[] = [];
        for (const [name, body] of Object.entries(library)) {
          if (writeIfAbsent(path.join(cwd, '.origami', 'skills', name, 'SKILL.md'), body) === 'done') seeded.push(name);
        }
        const c = writeIfAbsent(path.join(cwd, '.origami', 'command', 'example.md'), sampleCommandMd());
        const skillCount = seeded.length === 1 ? '1 skill' : `${seeded.length} skills`;
        const made = [seeded.length ? skillCount : '', c === 'done' ? 'an example command' : ''].filter(Boolean);
        emit.narrate(made.length ? `→ Created ${made.join(' + ')} — they show up in the / palette.` : '→ Commands & skills already present.');
      },
    },
    modelStep,
  ] : [modelStep];

  // Build the live todo list (all pending) + show it.
  const todos: FirstFoldTodo[] = steps.map((s, i) => ({ id: i, content: s.content, activeForm: s.activeForm, status: 'pending' }));
  emit.todos(todos.map(t => ({ ...t })));
  emit.narrate(full
    ? `Folding **${projectName}** into an Origami workspace — here's each step as I go.`
    : 'Setting up your model.');

  for (let i = 0; i < steps.length; i++) {
    todos[i].status = 'in_progress';
    emit.todos(todos.map(t => ({ ...t })));
    await sleep(250);
    try {
      await steps[i].run();
    } catch (e) {
      emit.narrate(`⚠ ${steps[i].content} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    todos[i].status = 'completed';
    emit.todos(todos.map(t => ({ ...t })));
    await sleep(PACE_MS);
  }

  const model = result.modelWritten?.model ?? detectModel();
  emit.done(full
    ? (model ? `Workspace folded — AGENTS.md, wiki, and folders are ready; model \`${model}\`.`
             : 'Workspace folded — AGENTS.md, wiki, and folders are ready. Set up a model with `/firstfold model`.')
    : (model ? `Model set to \`${model}\`.` : 'Model unchanged.'));
  return result;
}
