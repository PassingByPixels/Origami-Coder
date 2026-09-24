// The default skill library seeded by /firstfold, keyed by skill name (also the directory name;
// must match the body's own `name:` frontmatter). Data only — firstFold.ts owns the writing and its
// idempotency.
//
// `wrap` and `example-skill` live in firstFold.ts instead, beside the HANDOFF.md stub /wrap edits.
// `slash: true` is set only on user-invoked skills; model-invoked ones load when relevant and are
// not in the / palette. CATEGORIES are lowercase (workflow, planning, testing, quality,
// engineering, productivity, reference).

const GRILL_ME = `---
name: grill-me
category: workflow
description: Interview the user until a plan is fully understood before committing to it. Use before any non-trivial task to prevent misalignment.
slash: true
---

# /grill-me — alignment before you build

The single highest-leverage habit: interview the user down every branch of the
design tree before committing to a plan. Prevents the #1 failure mode — the
agent building the wrong thing.

Run BEFORE any non-trivial task. Trivial jobs: use judgement and skip.

## How

- Ask one question at a time. Do not dump a wall of questions.
- Follow every branch to its end before moving on.
- Surface multiple readings of the request explicitly; do not silently pick one.
- Push back when a requirement looks wrong or there is a better way.
- Record what is decided as you go.
- Stop grilling when both you and the user are confident the plan is understood.

## Output

A short plan, or a restated understanding of the task, before touching code.
If the work is big enough to outlive the conversation, hand it to \`/to-spec\`.
`;

const TO_SPEC = `---
name: to-spec
category: planning
description: Turn the conversation into a spec (PRD) and publish it. Use after grilling, before breaking work into tickets.
slash: true
---

# /to-spec — turn the conversation into a spec

After a grilling session, write the agreed design down as a durable product
requirements document a fresh agent can act on with no memory of the chat.

## What the spec must state

- The problem and the goal.
- **What**, not **how** — interfaces and types over file paths and line numbers
  (those go stale).
- Concrete, testable acceptance criteria.
- Explicit out-of-scope.
- Open questions, if any remain.

## Publish

- Write it to \`.scratch/<feature-slug>/spec.md\` — the local markdown tracker
  \`/to-tickets\` reads and writes beside.
- Durable domain knowledge behind a decision belongs in the wiki
  (\`wiki/pages/<topic>.md\`, one line in \`wiki/index.md\`), not in the spec. The
  spec says what to build; the wiki says what the project knows.

## Rules

- No file paths or line numbers in the spec.
- Every acceptance criterion must be testable.
- State out-of-scope as clearly as in-scope.
`;

const TO_TICKETS = `---
name: to-tickets
category: planning
description: Break a spec or plan into independent tracer-bullet tickets with blocking edges. Use after to-spec, before implementing.
slash: true
---

# /to-tickets — break a spec into tickets

Split a spec into the smallest set of independent, agent-ready tickets that
trace a working path end to end (tracer bullets), with explicit blocking edges.

## How

- Each ticket must be independently implementable and verifiable.
- Order tickets so each adds a thin vertical slice of working behaviour.
- Record blocking edges between tickets — what must land first.
- Tickets produced here are already agent-ready. They are NOT triaged; \`triage\`
  is for work that arrived from outside.

## Ticket layout

\`\`\`
.scratch/<feature-slug>/
  spec.md
  issues/
    01-<slug>.md
    02-<slug>.md
\`\`\`

Each ticket opens with a \`Status:\` line and a \`Blocked by:\` line, then the agent
brief: interfaces and types, what not how, testable acceptance criteria, and
explicit out-of-scope.

## Rules

- One idea per ticket.
- No ticket depends on the implementation detail of another — only on its
  behaviour.
- Every ticket has a testable definition of done.
`;

const TRIAGE = `---
name: triage
category: workflow
description: Move incoming issues and requests through a triage state machine and produce an agent brief. Use for raw incoming work — bugs, feature requests, external patches.
slash: true
---

# /triage — route incoming work

Move **incoming raw** work (bug reports, feature requests, external patches —
things you did not create) through a state machine, and produce an agent brief
for anything an agent will pick up.

## Labels

- **Category**, exactly one: \`bug\` | \`enhancement\`
- **State**, exactly one: \`needs-triage\` -> \`needs-info\` | \`ready-for-agent\` |
  \`ready-for-human\` | \`wontfix\`

## Flow

1. Unlabelled work starts at \`needs-triage\`.
2. Decide: bug or enhancement, and is it fully specified?
3. Needs more from the reporter -> \`needs-info\`.
4. Fully specified and an agent can do it -> \`ready-for-agent\`, and write the
   agent brief.
5. Needs a person -> \`ready-for-human\`.
6. Rejected -> \`wontfix\`.

## The agent brief

A durable, behavioural spec written when work reaches \`ready-for-agent\`:
interfaces and types (never file paths or line numbers), what not how, testable
acceptance criteria, explicit out-of-scope. Record it as a ticket at
\`.scratch/<feature-slug>/issues/NN-<slug>.md\` with its \`Status:\` and
\`Blocked by:\` lines. This brief is what makes an unattended agent safe.

## Rejections are knowledge

For a rejected enhancement, record WHY in one file per concept under
\`.scratch/out-of-scope/<concept>.md\`, and check new requests against it so the
same argument is not had twice. Bugs and already-built requests never go there.

## Rules

- Only for raw incoming work. Tickets from \`to-tickets\` are already agent-ready.
- Every item carries exactly one category and exactly one state.
`;

const TDD = `---
name: tdd
category: testing
description: Red-green-refactor test-driven development. Use for feature work — write the failing test first, then make it pass.
---

# tdd — red-green-refactor

The disciplined feedback loop for feature work. Write the failing test first,
then make it pass, then refactor.

## The loop

1. **Red** — write a test that fails because the behaviour does not exist yet.
2. **Green** — write the least code that makes it pass.
3. **Refactor** — improve the code under the safety of the green test.
4. Repeat for the next behaviour.

## Rules

- Assert observable behaviour against the requirement, not a restatement of the
  implementation.
- A test must catch a real bug. If you cannot say which bug it would catch, do
  not write it.
- Do not write a mock that only checks "method X was called".
- Do not compute a fixture by running the code under test.
- Keep the loop tight: small steps, fast feedback.

## Definition of done

Tests green with evidence — what you ran and what it printed. "Compiles" and
"should work" are not done.
`;

const DIAGNOSING_BUGS = `---
name: diagnosing-bugs
category: testing
description: Disciplined debugging loop — reproduce, minimise, hypothesise, fix, regression-test. Use when something is broken.
---

# diagnosing-bugs — disciplined debugging

A careful, repeatable loop for finding and fixing bugs. Never guess and hope.

## The loop

1. **Reproduce** — get a reliable reproduction of the failure.
2. **Minimise** — strip it to the smallest case that still fails.
3. **Hypothesise** — state a cause you can test.
4. **Fix** — make the smallest change that removes that cause.
5. **Regression-test** — write the test that would have caught this bug, and
   confirm it passes.

## Rules

- Fix the cause, not the symptom. Check whether sibling inputs fail the same way.
- Write the regression test before or with the fix, never after the fact.
- Verify with evidence: what you ran and what it printed.
- If the reproduction cannot be made reliable, say so. Do not claim a fix.
`;

const CODE_REVIEW = `---
name: code-review
category: quality
description: Two-axis review — standards and spec — run as parallel sub-agents. Use to close out implemented work.
---

# code-review — two-axis review

Review implemented work on two independent axes, run as parallel sub-agents so
the two concerns cannot blur into one soft verdict.

## Axis 1 — standards

Does the code meet the project's standards? Style, structure, simplicity,
security, no dead code, no over-engineering. Run by a sub-agent given no
knowledge of the spec.

## Axis 2 — spec

Does the code do what the spec or the tickets asked? Behaviour against
requirements, acceptance criteria met, nothing missing. Run by another sub-agent
given only the spec.

## How

- Launch both sub-agents in parallel with disjoint briefs.
- Require concrete findings with file references — no vague "looks good".
- Fix or reject each finding, then re-verify.

## Rules

- The spec axis checks WHAT was asked; the standards axis checks HOW it was
  built. Keep them apart.
- A finding that is not actionable is not a finding.
`;

const WAYFINDER = `---
name: wayfinder
category: planning
description: Map a huge, foggy effort as investigation tickets that reveal the unknowns before any build starts. Use for large multi-session work.
---

# wayfinder — map a huge effort

For a large, foggy, multi-session effort: break it into a map of investigation
tickets that reveal the unknowns before committing to a build.

## How

1. Name the big questions and unknowns in the effort.
2. Turn each into a small investigation ticket: what to find out, and how you
   will know it is answered.
3. Order them so each answer unlocks the next question.
4. Record the blocking edges.
5. Work through them and let the answers reshape the map.

Keep the tickets in the same tracker the build will use —
\`.scratch/<feature-slug>/issues/NN-<slug>.md\`, each with \`Status:\` and
\`Blocked by:\`. Park findings worth keeping in \`wiki/pages/<topic>.md\`.

## When

- Huge, foggy, multi-session efforts only. Too heavy for ordinary work.
- Scope the effort with \`/grill-me\` first.

## Rules

- These tickets are for investigation, not implementation.
- A ticket is done when its question is answered with evidence.
- Let findings change the map. Do not force the original plan.
`;

const HANDOFF = `---
name: handoff
category: workflow
description: Cross a session boundary cleanly so a fresh agent can continue without re-deriving context. Use when stopping, or when handing work over.
slash: true
---

# /handoff — hand the work to a fresh session

This workspace already has \`/wrap\`, which writes the HANDOFF.md block and the
wiki depth in one pass. This skill is the when-and-what guide around it.

## When

- The conversation is too long or tangled to continue in place.
- You are about to stop and expect to resume later.
- Another agent will pick the work up.

## How

- Run \`/wrap\`. Do not hand-write the block — placement and the wiki standards
  are what make the log readable by the next session.
- The block must answer two things: what happened, and what is next.
- The depth (why, how, what you ruled out) goes in the wiki page \`/wrap\` links
  from, never in the one-line log.
- Name anything left unverified. A handoff that reads as finished when it is not
  costs the next session more than it saves.
`;

// optimize-code adapts saurabhkumar8112/cyclomatic-complexity-skill (Apache-2.0). This version
// stages the work for a whole repository rather than one function: a Stage 0 pins a green baseline
// from the project's own gates, a batch cap in Stage 2 keeps a complexity diff reviewable, and
// Stage 4 re-runs the gates before reporting. The project's configured threshold still wins, and
// complexity must move into well-named functions, never vanish into cleverness.
const OPTIMIZE_CODE = `---
name: optimize-code
category: quality
description: Reduce cyclomatic complexity across a codebase in reviewable batches — baseline the project's gates, measure complexity per function, refactor the worst hotspots, re-verify green, report before and after. Use when asked to optimize, clean up, simplify, or de-spaghetti a repository.
slash: true
---

# /optimize-code — measure, refactor, prove

Six stages, in order. Do not skip one. Do not start Stage 3 until Stage 0 is
green. Behaviour-preserving changes only.

## Stage 0 — Baseline

1. Confirm the working tree is clean (\`git status --short\` prints nothing). If it
   is dirty, stop and ask — a refactor mixed with unrelated edits is unreviewable.
2. Find the project's OWN gates. Read the package manifest, the build config and
   any CI workflow for the real commands — typecheck, test, lint, build. Do not
   invent commands.
3. Run every gate and record the exact output.

> **House rule.** Refactoring starts from green and every batch ends green.

A gate that is already red before you touch anything ends the run — say which
one, quote the output, and stop. A project with no tests does not end the run,
but say so plainly, refactor conservatively, and carry the risk into the report.

## Stage 1 — Measure

Cyclomatic complexity = decision points + 1. Decision points are \`if\`, \`else if\`,
each \`case\`, every loop, \`catch\`, the ternary, and each \`&&\` or \`||\` inside a
condition.

Use a real tool wherever one exists. Never estimate when you can measure.

| Language | Command |
|---|---|
| Python | \`radon cc -s -a <path>\` |
| JS / TS | the eslint \`complexity\` rule |
| Go | \`gocyclo <path>\` |
| Mixed / other | \`lizard <path>\` |

No tool available — count the decision points by hand, per function, and show the
count next to the function so a reader can check it.

**The project's own threshold wins.** If an eslint config, a radon or flake8
setting, a sonar profile or similar already declares a complexity limit, that
number is the bar. Only when the project declares none, use these defaults.

- 1-5 — fine, leave it alone
- 6-10 — watch, refactor only if you are in the file anyway
- 11-15 — refactor now
- 16+ — split, no debate

Record two secondary signals, but never refactor on them alone — they choose
between equal-scoring hotspots. File-length outliers (files far longer than the
median for that language) and obvious duplication (the same block in three or
more places).

## Stage 2 — Prioritise

Rank every measured function by score, worst first, and PUBLISH the table before
you edit anything.

\`\`\`
| Function | Location | Score | Technique |
|---|---|---|---|
| parseOrder | src/order.ts:88 | 24 | guard clauses + extract |
\`\`\`

Then cut it to a batch of at most five hotspots. A large repository is cleaned in
batches, not in one pass — a forty-file complexity diff cannot be reviewed, and
one bad extraction inside it poisons the rest. Name the hotspots you are
deferring to the next batch, so nothing looks finished that is not.

## Stage 3 — Refactor

One function at a time, in this order of preference.

1. **Guard clauses.** Invert the condition, return early, delete a nesting level.
2. **Extract function.** Every extracted piece gets a name that says WHAT it does,
   not how. The name is the documentation.
3. **Lookup table.** A map keyed by the value replaces an if-else or switch chain.
4. **Named predicates.** \`if (isEligibleForRefund(order))\` beats four clauses of
   boolean soup.
5. **Flatten nesting.** Extract the loop body, and \`continue\` instead of wrapping
   the rest of the loop in an \`if\`.

Rules that are not negotiable.

- **Never game the metric.** Complexity must MOVE into well-named functions, not
  disappear into cleverness. A dense one-liner hiding six branches is worse than
  the honest if-chain it replaced. Never silence a lint rule, raise a configured
  threshold, or add an inline disable comment to make a number go down.
- **Match the surrounding style.** Same naming, same file layout, same error
  handling as the code you are editing.
- **Stay inside the hotspot.** Do not rename a public API, change an exported
  signature, retype adjacent code or tidy a neighbour. If the fix genuinely needs
  a signature change, ask first.
- **One responsibility per function.** If the new name needs an "and", split again.
- Keep each hotspot a separate commit or a separate staged change, so a bad one
  can be dropped without losing the batch.

## Stage 4 — Verify

For every batch, in this order.

1. Re-run the Stage 0 gates. All green, with the output.
2. Re-measure the batch's functions with the SAME tool and the SAME command as
   Stage 1. A different command is a different number.
3. Build the per-function before and after table.

A gate that went red IS the result — report it red, with its output, and fix or
revert before you move on. Never report a batch whose gates you did not re-run.

## Stage 5 — Report

\`\`\`
## Complexity report

| Function | Location | Before | After |
|---|---|---|---|
| parseOrder | src/order.ts:88 | 24 | 5 |

Extracted: validateHeader, resolveDiscount, isEligibleForRefund
Gates: verified by running <command>, output was <counts>
Not touched: <function> — <why>
Next batch: <the next hotspots by score>
\`\`\`

- State what you VERIFIED and how — "verified by running X, output was Y". If
  something is unverified, write "untested — would confirm by Z". Never write
  "should work".
- Name what you deliberately did NOT touch and why (no tests around it, public
  API, generated file, out of scope). A skipped hotspot with a reason is
  information; a silently skipped one is a hole.
- Numbers and diffs do the talking. Keep the prose short.

---

Adapted from \`saurabhkumar8112/cyclomatic-complexity-skill\` (Apache-2.0).
`;

// ---------------------------------------------------------------------------
// The `engineering` + `productivity` half of the library covers what the first ten skills miss:
// where to begin, the build step between tickets and review, and standing habits (design
// vocabulary, merge conflicts, teaching, authoring skills). ask-tsuru is the front door and names
// every other skill, so its routing list must be kept in step with this map.
// ---------------------------------------------------------------------------

const ASK_TSURU = `---
name: ask-tsuru
category: engineering
description: The routing front door — read the situation and pick the right skill or flow. Use when it is not obvious which skill fits.
slash: true
---

# /ask-tsuru — pick the right flow

You do not remember every skill, so ask. This maps a situation to the right
flow. It is what turns the skill library from a pile into a self-guiding system.

## The main flow (idea to ship)

\`/grill-with-docs\` -> \`/to-spec\` -> \`/to-tickets\` -> \`/implement\` (which drives
\`tdd\` internally, then closes with \`code-review\`).

## Route by situation

- **Incoming bugs and requests** -> \`/triage\`
- **Something is broken** -> \`diagnosing-bugs\`
- **A huge, foggy effort** -> \`/wayfinder\`
- **Codebase health** -> \`/improve-codebase-architecture\`
- **A repository heavy with complexity** -> \`/optimize-code\`
- **A merge or rebase in conflict** -> \`resolving-merge-conflicts\`
- **The vocabulary underneath** -> \`domain-modeling\`, \`codebase-design\`
- **Crossing a session boundary** -> \`/handoff\`, which runs \`/wrap\`
- **Standalone** -> \`/grill-me\`, \`/prototype\`, \`/research\`, \`/teach\`,
  \`writing-great-skills\`

## Rules

- Read the situation first, then route. Do not default to one flow.
- If no skill clearly fits, start with \`/grill-me\` to clarify the task.
- When the user wants a work backlog, route through the tracker pipeline:
  \`/setup\` -> \`/triage\` -> \`/to-spec\` -> \`/to-tickets\` -> \`/implement\`.
`;

const GRILLING = `---
name: grilling
category: productivity
description: The reusable interview loop behind grill-me and grill-with-docs. Model-invoked — it drives the one-question-at-a-time session.
---

# grilling — the reusable interview loop

The shared engine behind \`/grill-me\` (alignment only) and \`/grill-with-docs\`
(alignment plus shared language). Model-invoked: do not call it directly unless
you are the grill loop.

## The loop

1. Ask ONE question at a time.
2. Wait for the answer.
3. Branch: if the answer opens sub-questions, follow them to the end first.
4. Loop until the design tree is fully understood.
5. Optionally capture what was learned (\`/grill-with-docs\` is that variant).

## Rules

- Never ask two questions at once.
- Never move to the next branch while the current one is still ambiguous.
- Prefer concrete, testable statements over abstract agreement.
- Stop as soon as the picture is complete. Do not over-grill.
`;

const GRILL_WITH_DOCS = `---
name: grill-with-docs
category: engineering
description: A grilling session that also builds the project's shared language — wiki glossary and decision records. Use before starting work on a feature.
slash: true
---

# /grill-with-docs — align AND build shared language

The \`grilling\` loop, plus capture of the project's vocabulary and hard
decisions as you go. The result is that later conversations use one word where
they used twenty.

## How

1. Run the interview loop from \`grilling\`.
2. As terms resolve into a settled meaning, record them.
3. As hard decisions are made, record them as decision records.
4. The wiki is the store: \`wiki/pages/<topic>.md\` for the glossary and the
   decision pages, tagged and cross-linked, with one line per new page in
   \`wiki/index.md\`.
5. Use the settled vocabulary in all later output — ticket titles, test names,
   refactor proposals. Do not drift to synonyms.

## Rules

- Record lazily: only when a term or a decision actually resolves. Do not write
  pages speculatively.
- If an existing page contradicts a new decision, surface the conflict rather
  than silently overriding it.
- Done when the design tree is understood AND the vocabulary is captured.
`;

const IMPLEMENT = `---
name: implement
category: engineering
description: Build from a spec or a ticket set, driving tdd internally and closing with code-review. Use to implement work that is already agreed.
slash: true
---

# /implement — build from a spec

The workhorse pipeline: take an agreed spec or ticket set and turn it into
working, reviewed code.

## How

1. Read the spec — \`.scratch/<feature-slug>/spec.md\`, or the wiki page.
2. Work ticket by ticket, in blocking order (the \`Blocked by:\` lines).
3. Drive each ticket with \`tdd\`: the failing test first, then make it pass.
4. Use the project's shared vocabulary from the wiki.
5. Close with \`code-review\` — standards and spec, as parallel sub-agents.
6. Fix the findings, then re-verify.

## Rules

- Build against the spec, not from memory of the conversation.
- Follow each ticket's brief exactly: interfaces and types over file paths.
- Definition of done: tests green with evidence, and review findings resolved.
`;

const PROTOTYPE = `---
name: prototype
category: engineering
description: Build a throwaway prototype to answer one design question. Use when a decision needs evidence before you commit to it.
slash: true
---

# /prototype — answer a design question

Build a throwaway prototype whose only purpose is to answer a specific design
question. It is disposable. Do not let it become production code.

## How

1. State the exact question the prototype must answer.
2. Build the smallest thing that answers it.
3. Capture the answer with evidence — what you ran, what it printed.
4. Discard the prototype, or extract only the proven parts into real code.

## Rules

- The prototype is a means to an answer, not a deliverable.
- Do not polish, test or harden it beyond what the question needs.
- Never let a prototype silently become the shipped implementation.
`;

const RESEARCH = `---
name: research
category: engineering
description: Investigate a question against primary sources and capture the result as cited Markdown. Use when an answer must carry evidence.
slash: true
---

# /research — investigate against primary sources

Answer a question by investigating primary sources, and capture the result as
cited Markdown another agent or the user can trust.

## How

1. State the question precisely.
2. Find primary sources — the original docs, specs, code or vendor material —
   not secondary summaries.
3. Read them, and extract the part that answers the question.
4. Capture the result as cited Markdown, every claim tied to its source. A
   finding worth keeping goes to \`wiki/pages/<topic>.md\`.
5. Note what could not be verified, explicitly.

## Rules

- Prefer primary sources over summaries and hearsay.
- Cite every claim. Do not assert without a source.
- Separate verified fact from inference.
- If two sources disagree, surface the conflict rather than picking one.
`;

const TEACH = `---
name: teach
category: productivity
description: Teach the user a skill over several sessions, one step at a time. Use when the user wants to learn something, not to have it done for them.
slash: true
---

# /teach — teach the user over sessions

Teach a skill across several sessions so the user retains it, instead of doing
it for them once.

## How

- Pick ONE concept per session. Do not overload.
- Explain the why, then the how, with a small worked example.
- Give the user a chance to do it before showing the answer.
- Check understanding, and correct gently.
- Plan the next session's topic before stopping.
- Keep a short record of what has been taught — a wiki page — so the sessions
  chain instead of repeating.

## Rules

- Do not take the task over. The user must do the work to learn.
- Match the pace to the user. Slow down on confusion.
`;

const SETUP = `---
name: setup
category: engineering
description: One-time per-repository setup for the work backlog — where issues live, and where the shared language is written. Use once, when adopting the pipeline.
slash: true
---

# /setup — configure the work pipeline

One-time per-repository setup that answers where issues live and where the
shared language is written. Run it once, when you want a real backlog.

## Step 1 — choose the tracker

Ask where issues live.

| Tracker | Back end | Tooling |
|---|---|---|
| Local markdown | files under \`.scratch/\` | none |
| GitHub | GitHub Issues | \`gh\` CLI |
| GitLab | GitLab Issues | \`glab\` CLI |
| Other | freeform prose | whatever the user names |

**Local markdown is the default**, and it is what every other skill in this
library assumes. It gives a solo user the whole pipeline out of \`.md\` files,
with nothing to install and no account to hold:

\`\`\`
.scratch/<feature-slug>/
  spec.md
  issues/
    01-<slug>.md
    02-<slug>.md
\`\`\`

Choose another tracker only if the user asks for one.

## Step 2 — write the choice down

Record it in \`.scratch/pipeline.md\`, so the next agent reads the decision
instead of guessing at it:

- the tracker, and the command used to reach it;
- the triage labels — the real label strings behind \`bug\`, \`enhancement\`, and
  the states \`triage\` uses;
- where the shared language lives.

## Step 3 — shared language

The wiki is the store: \`wiki/pages/<topic>.md\`, catalogued in
\`wiki/index.md\`. Read the relevant pages before exploring, use their
vocabulary, and surface any conflict against them.

## Output

\`.scratch/pipeline.md\`, plus a note in AGENTS.md pointing agents at the skill
library and the wiki.
`;

const DOMAIN_MODELING = `---
name: domain-modeling
category: engineering
description: Build and sharpen the project's domain model, keeping the wiki glossary and the decision records current. Use when terms or decisions need settling.
---

# domain-modeling — build the domain model

The vocabulary underneath the code. Capture the project's shared language and
its hard decisions, so every session stays concise and consistent.

## How

- As a term settles into a stable meaning, record it in the wiki glossary —
  \`wiki/pages/<topic>.md\`, tagged and cross-linked.
- As a hard decision is made, record it as a decision record beside it.
- Add one line per new page to \`wiki/index.md\`.
- Use the settled vocabulary in all output. Do not drift to synonyms.
- If a decision contradicts an existing page, surface the conflict explicitly.

## When

- Lazily, when a term or a decision actually resolves. Never speculatively.
- On demand, when the domain model is fuzzy or drifting.

## Rules

- One topic per page, and reuse the existing tags.
- Every page links out to a related page.
`;

const CODEBASE_DESIGN = `---
name: codebase-design
category: engineering
description: The vocabulary and the discipline for designing deep modules. Use when designing new code or reviewing existing structure.
---

# codebase-design — design deep modules

The discipline behind good structure. The goal is modules with a DEEP interface
— a small, stable entry point hiding a lot of implementation — rather than
shallow ones that leak their internals to every caller.

## Principles

- **Deep modules** — hide complexity behind a simple, stable interface.
- **Information hiding** — keep the implementation private.
- **Small interfaces** — expose the least surface that works.
- **Cohesion** — each module does one thing.
- **No speculative generality** — the least code that solves the problem.

## How to use

- Apply it when designing a new module, or when reviewing whether an existing
  one has gone shallow.
- Name the module's single responsibility before writing it. If the name needs
  an "and", it is two modules.
- Push complexity DOWN into the module, never out to its callers.

## Rules

- A senior engineer must not be able to call the result overcomplicated.
- Prefer editing to rewriting. Change only what the task needs.
`;

const IMPROVE_CODEBASE_ARCHITECTURE = `---
name: improve-codebase-architecture
category: engineering
description: Scan the codebase for deepening opportunities, report them ranked, then grill the user on what to act on. Use periodically to slow software entropy.
slash: true
---

# /improve-codebase-architecture — the periodic deepening scan

A periodic scan that finds where the codebase has gone shallow, tangled or
drifting, reports what it found, and grills the user on what to do about it.

## How

1. Scan for deepening opportunities: shallow modules, duplicated logic, leaked
   internals, dead code, a missing abstraction.
2. Rank them by impact against effort, and PUBLISH the ranked list before
   touching anything.
3. Run the \`grilling\` loop over the findings to decide what to act on.
4. Do not act unasked. Present, then discuss.

## Rules

- Every finding is specific: the file, the concrete symptom, the shape you
  propose instead. A finding that is not actionable is not a finding.
- Do not refactor adjacent code unasked.
- This is a periodic health check, not an every-task default.
`;

const RESOLVING_MERGE_CONFLICTS = `---
name: resolving-merge-conflicts
category: engineering
description: Resolve in-progress merge or rebase hunks by intent, never by aborting. Use when a merge or a rebase stops on conflicts.
---

# resolving-merge-conflicts — resolve by intent

Resolve in-progress merge or rebase conflicts by understanding the intent of
both sides. Never abort as a way out.

## How

1. Read each conflicting hunk in context, from BOTH sides.
2. Determine what each side was trying to do.
3. Combine the intents where both are wanted. Pick one side only where they
   genuinely contradict.
4. Keep the resolution minimal and correct. It is not a rewrite.
5. Finish the merge or the rebase, then verify: build and tests green.

## Rules

- Understand before editing. Never guess which side to keep.
- If you cannot determine an intent, surface it instead of guessing.
- Never \`--abort\` to dodge the work.
- Verify after resolving. A resolved conflict that does not build is not done.
`;

const WRITING_GREAT_SKILLS = `---
name: writing-great-skills
category: productivity
description: The reference for writing and editing skills. Use when creating, reviewing or maintaining a skill in this library.
---

# writing-great-skills — the reference for authoring skills

The library in \`.origami/skills/\` is where a workspace keeps what it knows.
This is the reference for writing entries that stay useful and predictable.

## Structure

- One skill, one topic. If it does two unrelated things, split it.
- The file is \`.origami/skills/<name>/SKILL.md\`, and the folder name must
  match the \`name:\` in the frontmatter — the registry keys off the frontmatter,
  so a mismatch makes the skill answer to a name nobody can find it under.
- Frontmatter:

\`\`\`
---
name: <kebab-case, same as the folder>
category: <workflow|planning|engineering|testing|quality|productivity>
description: <what it does, and when to use it>
slash: true
---
\`\`\`

- \`category\` is what the skills UI groups by. Reuse an established value rather
  than coining a new one.
- \`slash: true\` marks a skill a USER invokes. Leave it off a skill the agent
  loads for itself — advertising it as a command promises something a user
  cannot usefully type.
- Every frontmatter value is a plain scalar. A bare colon inside one makes the
  whole block unparseable, and the skill then disappears with only a warning.
- Write in Simplified Technical English: short sentences, one meaning per word,
  no metaphors.

## The quality bar

- A clear trigger: when should this be loaded?
- Concrete steps, not vague advice.
- The least content that solves the problem. No padding.
- Predictable vocabulary. Reuse terms instead of inventing synonyms.

## Review

- Does the description make the trigger obvious?
- Would a fresh agent follow it exactly as written?
- Can it be shortened without losing meaning?
`;

/**
 * Default skills seeded into `.origami/skills/<name>/SKILL.md` on /firstfold, keyed by skill name —
 *  the key is also the directory name and must match the body's own `name:` frontmatter.
 * ORDER IS PART OF THE CONTRACT: GLOBAL_SEEDS (seedGlobal.ts) maps over these entries, so a new
 *  skill goes on the end.
 */
export const DEFAULT_SKILLS: Record<string, string> = {
  'grill-me': GRILL_ME,
  'to-spec': TO_SPEC,
  'to-tickets': TO_TICKETS,
  triage: TRIAGE,
  tdd: TDD,
  'diagnosing-bugs': DIAGNOSING_BUGS,
  'code-review': CODE_REVIEW,
  wayfinder: WAYFINDER,
  handoff: HANDOFF,
  'optimize-code': OPTIMIZE_CODE,
  'ask-tsuru': ASK_TSURU,
  grilling: GRILLING,
  'grill-with-docs': GRILL_WITH_DOCS,
  implement: IMPLEMENT,
  prototype: PROTOTYPE,
  research: RESEARCH,
  teach: TEACH,
  setup: SETUP,
  'domain-modeling': DOMAIN_MODELING,
  'codebase-design': CODEBASE_DESIGN,
  'improve-codebase-architecture': IMPROVE_CODEBASE_ARCHITECTURE,
  'resolving-merge-conflicts': RESOLVING_MERGE_CONFLICTS,
  'writing-great-skills': WRITING_GREAT_SKILLS,
};
