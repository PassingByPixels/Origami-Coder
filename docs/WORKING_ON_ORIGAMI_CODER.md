# Working on Origami Coder — a guide for agents

This is the document I wish had existed before the 0.3.56 incident. It is written
as a lesson rather than a rulebook, because most of the rules here only make sense
once you understand what goes wrong without them.

Read `AGENTS.md` first — it covers code style. This covers everything else: which
artifact you are actually changing, how to ship it, and how this repository checks
your work.

---

## Part 1 — A case study: how version 0.3.56 broke the editor

Let us start with what actually happened, because every rule below comes from it.

An agent was asked to upgrade the repo-map feature. It did a genuinely good piece
of design work: it replaced the old free-form "layers" with five fixed pillars,
added section grouping, a per-node `status` for diff-tracking, and a matching
static HTML renderer. That work was sound. We kept nearly all of it.

Then it shipped, and the editor lost features that had been working the day before.
Charts stopped rendering. The browser tool's repairs vanished. Here is the chain:

1. It did its work in the **wrong checkout**. `C:\Repos\Origami Coder\origami-coder`
   sits on branch `stage-5`, whose real version is **0.2.179** — over a hundred
   versions stale. The current work lives in a *worktree*,
   `origami-coder.wt\v2-rebase`.
2. It **hand-edited the version** in `package.json` to `0.3.56`. Nothing validated
   that number. A stale branch now claimed to be the newest build in the tree.
3. It **packaged and installed from that stale branch**. The resulting VSIX
   contained none of the previous day's work — verified afterwards by grepping the
   installed bundle for `chartBlock`, `renderChartBlock` and `browserResult`: zero
   hits, on all three.
4. Because the version number was *higher*, VS Code preferred it. The user's editor
   silently regressed, and the version number said it had been upgraded.

Notice that no single step was reckless. Each was a small, locally reasonable
action. The damage came from the fact that **nothing in the pipeline checks that
the thing you built is the thing you meant to build.** That is what the rest of
this document is for.

A second, quieter failure sat inside the same work: `mapSchema.ts` **did not
compile**. It called `.includes()` on a value typed as `unknown`. The unit tests
were all green, because tests run through a transpiler that strips types without
checking them. `npm run typecheck` had never been run. Remember that: in this
repository, a green test suite does not mean the code compiles.

---

## Part 2 — The single most important idea: two artifacts, not one

Almost every deployment mistake here comes from not knowing which of two separate
programs you have just changed. Learn this before anything else.

Origami Coder ships as **two independently deployed artifacts**:

| | The **extension** | The **engine** |
|---|---|---|
| Source | `packages/vscode/` | `packages/engine/` |
| What it is | The VS Code UI — panes, cards, webviews, the dashboard | The agent runtime — tools, sessions, prompts, model calls |
| Built by | `npm run build` then `vsce package` | `bun run script/build.ts --single` |
| Deployed as | a `.vsix` you install | a compiled binary at `~/.origami/bin/origami.exe` |
| Picked up by | reloading the VS Code window | starting a new session |

The shell and edit card wire contract is documented in `docs/TOOL_CARD_CONTRACT.md`.

**They do not travel together.** Rebuilding one does nothing for the other. This is
the question to ask before every deploy:

> Which package did my change land in?

- Changed something under `packages/vscode/`? Rebuild and reinstall **the extension**.
- Changed something under `packages/engine/`? Rebuild **the engine**.
- Changed both? Do both, or you will ship a half-fix and spend an hour confused.

During the 0.3.55 salvage this distinction mattered concretely. The map-v2 work
touched only `packages/vscode/`, so the engine binary was correctly left alone —
and that was not merely tidiness. The *previous* engine binary lacked
`normalizeToolInput` entirely, so a well-meaning "roll everything back to
yesterday" would have destroyed working tool-argument repair while trying to fix
an unrelated UI problem. Always ask what each artifact actually contains before you
replace it.

### Verifying an engine binary

The binary is a compiled snapshot, but you can still check what went into it:

```bash
grep -a "normalizeToolInput" ~/.origami/bin/origami.exe   # present or absent
```

If a symbol you just wrote is not in there, your change did not ship. This takes
five seconds and has repeatedly saved hours.

### Engine source mode

There is a setting, `origami.devEngineSource`. If it points at
`packages/engine`, sessions spawn the engine **from source** and your edits go
live on a window reload with no rebuild. If it is empty or invalid, the compiled
binary is used and **a reload will not pick up source edits**. Check which mode you
are in before concluding your change "didn't work" — the extension's output channel
logs which one spawned.

---

## Part 3 — Branches and worktrees: know where you are standing

This repository is a **fork** of OpenCode, and it uses git worktrees. Both facts
can bite you.

```
C:\Repos\Origami Coder\origami-coder          <- branch stage-5, STALE (v0.2.179)
C:\Repos\Origami Coder\origami-coder.wt\...   <- the worktrees, where work happens
```

Before you touch a single file:

```bash
git rev-parse --abbrev-ref HEAD    # which branch?
git log --oneline -3               # does the recent history look like the work I was told about?
```

If the task description mentions files or features you cannot find, **you are
probably in the wrong checkout**. Do not start creating them. Stop and look for a
worktree. This exact mistake was made twice in one session by two different agents,
and both times the tell was the same: the files named in the brief did not exist.

### Remotes: push to the mirror, never upstream

```
gitea    -> the private mirror. This is where our work goes.
upstream -> https://github.com/anomalyco/opencode  — the UPSTREAM PROJECT WE FORKED.
```

There is no `origin` remote. `upstream` is not ours: it is fetch-only (its push URL
is set to `no_push`) because pushing to it would send our private work to somebody
else's open-source repository. Always name the remote explicitly:

```bash
git push gitea <branch>      # correct
git push                     # depends on the branch's tracking ref — name gitea instead
```

---

## Part 4 — The architecture ratchet, and why you must not just raise it

`packages/vscode/webview/dashboard/__tests__/architecture.test.ts` holds a `CAPS`
table: a maximum line count for many files. A test fails when a file grows past its
cap.

Students almost always misread this mechanism, so let me be direct about its
purpose. **The cap is not a style preference. It is a design tripwire.** When a file
hits its cap, that is the codebase telling you the file has taken on more than one
job and wants to be split. The correct response is to extract a module.

The tempting response is to change the number. That takes ten seconds, makes the
test green, and destroys the entire value of the mechanism — because the next agent
inherits a bigger file and an even weaker signal.

In the incident, three caps were raised at once (370→395, 160→195, 250→265) to fit
new code, with no extraction attempted.

### The honest rule

> **Extract first. Raise only if extraction has already happened and the file is
> still over — and then say so in a comment, in the table, where the next person
> will read it.**

Both halves matter. During the salvage, the pillar list, the section grouping and
the fit-to-width maths were pulled out of `RepoMapScreen.svelte` into a pure leaf,
`components/repoMapPillars.ts`. The pane was *still* 15 lines over, because the
feature genuinely added function. That cap was then raised to 265 — the same number
the original agent used — with a comment explaining that extraction came first and
that squeezing out the remaining lines would mean compressing unrelated CSS rules
purely to move a number.

That is the distinction to internalise. Raising a cap after extracting is
engineering judgement. Raising it instead of extracting is gaming a metric. The
diff can look identical; the reasoning is what differs, which is exactly why the
comment is mandatory.

An extraction is also usually a gift, not a chore. `repoMapPillars.ts` became a
pure function module, so it could be tested without a DOM — and those tests caught
a real class of bug ("a node with no `section` must still appear in its column")
that no screenshot would ever have shown.

---

## Part 5 — Mirrors and drift guards

`tsconfig.webview.json` pins `rootDir` to `webview/`. A practical consequence
follows: **webview code cannot import a runtime value from `src/`.** Type-only
imports are fine (they vanish at compile time); values are not.

One caveat, learned the hard way in the isometric-map work: the "type-only imports
are fine" rule holds only for `.svelte` files, which tsc never puts in the program.
A `.ts` file under `webview/` trips **TS6059 on ANY import from `src/`, including
`import type`** — the file itself enters the program, and rootDir applies to it.
If a webview `.ts` leaf needs a type the host owns, re-declare it locally with a
comment saying where it mirrors from.

So when the webview needs a constant the extension host also owns, the house
pattern is to **mirror** it — declare it in both places. You will see this with
`modelBanner.ts`, `permissionOptions.ts`, and now the five pillars.

Mirroring is a deliberate trade, and it comes with an obligation:

> **Every mirror needs a test that reads BOTH files and asserts they still agree.**

Without that guard, someone renames a pillar in the schema, validation accepts the
new name, the UI keeps rendering the old one, and the map displays headings that no
longer match what was validated. Nothing fails. Everyone is happy until a user
notices.

`repoMapPillars.test.ts` is the worked example: it parses the `PILLARS` array out
of both files and compares them. It was proven to work by deliberately renaming a
pillar and watching the test go red.

---

## Part 6 — Verification: what green does and does not mean

This is the heart of it. In this repository, **the test suite is the weakest form
of evidence you have.** Three separate waves shipped real defects behind a fully
green suite. Understand each of these blind spots:

**1. Tests do not typecheck.** Vitest strips types without checking them. Code that
cannot compile can have a passing suite. You must run:

```bash
npm run typecheck      # tsc -p tsconfig.json && tsc -p tsconfig.webview.json
```

**2. jsdom has no layout engine.** `vitest.config.mts` does not set `css: true`, so
**no `<style>` element ever reaches the test DOM**. `getComputedStyle(el).maxHeight`
returns `''`, not `'200px'`. Any test claiming to verify sizing, cropping,
overflow or position by computed style is asserting nothing while looking rigorous.
A chart being clipped inside a 200px scroll box passed fourteen card tests. If a
change is visual, say plainly that it needs a human eye.

**3. A test written against your own assumptions proves only that you are
self-consistent.** The browser tool once passed 38/38 while being structurally
incapable of working, because every fixture used invented tool names instead of the
ones VS Code actually publishes. When you are integrating with something external —
VS Code's API, a shipped bundle, a third-party package — **derive your fixtures
from that external thing**, and say in the test where they came from.

**4. Engine tests flake under parallel load.** `bun test` output goes to *stderr*
(never redirect it away, or you lose the pass/fail counts), and the engine suite
mangles temp paths under Git-Bash. Run it via PowerShell, alone, not concurrently
with a vitest run. A phantom `external-directory` failure was traced to exactly
this.

### The technique that actually works

Before you claim a test protects something, **break the code on purpose and watch
the test fail.** Then restore it and watch it pass.

```bash
# disable the guard, run, observe RED
# restore the guard, run, observe GREEN
```

This is not ceremony. In this repo it has repeatedly exposed tests that could never
fail: a `new URL(...)` that vite rewrote so the suite silently collected **zero**
tests; an assertion querying a collapsed element where `null?.classList` returned
`undefined` and passed. Both looked like careful work.

If you cannot make your test fail, you have not written a test.

---

## Part 7 — Theme tokens

Do not invent CSS variable names. Colours come from `webview/shared/theme.css`, and
the defined tokens include:

```
--og-accent  --og-accent-2  --og-bg      --og-border   --og-chat
--og-error   --og-success   --og-warning --og-surface  --og-text  ...
```

There is **no** `--og-green`, `--og-yellow` or `--og-red`. The map's status badges
used all three. Because they were written as `var(--og-green, #4caf50)`, the
fallback silently took over and every badge ignored the user's theme on all four
palettes — invisible in tests, invisible in a screenshot of the theme you happen to
be using.

If you use a token, verify it exists, and prefer a test that fails when it does not.

---

## Part 8 — The deploy ritual

Follow this in order. Do not skip the verification step; it is the one that would
have caught 0.3.56.

```bash
# 0. Confirm where you are
git rev-parse --abbrev-ref HEAD
git log --oneline -3

# 1. Gates BEFORE building
npm run typecheck                  # both tsconfigs — tests do not do this for you
npx vitest run                     # the vscode suite

# 2. Version — one deliberate bump in packages/vscode/package.json

# 3. Build and package
npm run build
npx vsce package --no-dependencies
```

**Why `--no-dependencies` is not optional:** after an engine build runs
`bun install`, `npm ls --production --parseable` starts returning the workspace
root. `vsce` then tries to pull the entire monorepo into the VSIX and dies on
files like `../../.dockerignore`. The shipped extension is fully esbuild-bundled
and contains no `node_modules` at all, so excluding them is correct as well as
necessary. The `package` script in `package.json` now carries the flag itself
(`vsce package --no-dependencies`), so `npm run package` is safe; if you invoke
`vsce` directly, pass the flag yourself. Note that `npx vsce` misresolves in this
monorepo — call `.\node_modules\.bin\vsce`.

```bash
# 4. Install
code --install-extension <path>.vsix --force

# 5. VERIFY THE ARTIFACT — never skip this
```

**Engine changed too?** Build it (`bun run script/build.ts --single` in `packages/engine`),
then rotate with `scripts\deploy-engine.ps1` — it smoke-tests the built binary, renames the
deployed one aside as `origami.exe.prev-<version>` (never deletes), copies the new one in, and
smoke-tests the result. The script is allowlisted by name for agent sessions; keep it
single-purpose or the allowlist loses its meaning.

Grep the *installed* bundle for a symbol you know your change added, and for a
symbol from previous work that must still be there:

```bash
EXT=~/.vscode/extensions/origamilabs.origamicoder-<version>
grep -rl "mySymbolFromThisChange" "$EXT/out" "$EXT/webview"
grep -rl "aSymbolFromLastRelease" "$EXT/out" "$EXT/webview"
```

Both must be present. This single step is what turns "the version number went up"
into "the code I meant to ship is on disk". It takes seconds and it is precisely
the check that 0.3.56 lacked.

Finally, confirm exactly one version is registered:

```bash
# extensions.json should list your version, once
```

If an old folder lingers in `~/.vscode/extensions`, VS Code may prefer the higher
version number. Uninstall the extension fully and reinstall the one you want,
rather than leaving two on disk.

---

## Part 9 — Safety and working with others

**Do not hand-edit gates to make your work fit.** Caps, schema validators, test
fixtures and version numbers are the things that tell everyone else the truth about
your change. Editing them to accommodate yourself removes the signal for the next
person. If a gate genuinely needs to move, move it deliberately and write down why,
next to the change.

**Preserve, do not destroy.** When you must undo someone else's work, `git stash`
it with a descriptive message, or branch it. During the revert of 0.3.56, both
agents' uncommitted work was stashed with named messages and the bad extension
folder was *moved* to a quarantine directory rather than deleted — which mattered,
because no `.vsix` of that build existed anywhere and the folder was the only copy.
Reverting should be reversible.

**Leave real data alone.** `.origami/tickets/` and `.origami/agent-manager.json`
are user data, not build output. Untracked does not mean disposable. The same goes —
harder — for the user's live config and credentials outside the repo:
`~/.config/origami/origami.json` and `~/.local/share/origami/` (auth.json, session
DBs). A test that can resolve those paths is a defect even while it passes; the
2026-08-15 fixture leak corrupted the real provider config from a green test run.
The vitest setup guard (`realConfigGuard.ts`) exists to make that impossible — do
not weaken it, and never point a writer at a real path "just for one test".

**One writer per file.** If you find files changing under you, or an edit is
rejected with "File has been modified since read", **stop and report it**. Do not
race. In one session, two incarnations of the same agent edited the same files
about fifty seconds apart; the only reason it cost minutes instead of a corrupted
diff is that the agent halted on the evidence instead of retrying.

**Say what you verified, and how.** "Should work" is not a status. Prefer:

> *verified by running X, output was Y*

and when you did not verify something, say that too, and say what would settle it.
The most useful sentence in the whole salvage was an agent writing plainly that
"nobody has seen an uncropped chart render" — because it told the reviewer exactly
where the risk still lived.

---

## The short version

1. Know which checkout and branch you are in. Verify before you edit.
2. Know whether you changed the **extension** or the **engine**, and deploy that one.
3. Extract before you raise a cap; if you raise one anyway, write down why.
4. Mirrors need drift guards.
5. Run `typecheck` — the tests do not do it for you.
6. Break your own test on purpose to prove it can fail.
7. Package with `--no-dependencies`, then **grep the installed bundle**.
8. Push to `gitea`, never to `origin`.
9. Stash rather than destroy; halt rather than race.
10. Report what you verified and how — and what you did not.
