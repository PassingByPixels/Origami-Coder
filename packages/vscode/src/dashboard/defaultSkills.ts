// The default skill library seeded by /firstfold — the SKILL.md bodies keyed by
// skill name. Data only: firstFold.ts owns the writing (and its idempotency),
// so a new skill is one entry here and nothing else.
//
// `wrap` and `example-skill` are deliberately NOT here. Both predate this module
// and live in firstFold.ts beside the HANDOFF.md stub whose marker /wrap writes
// into — splitting that pair across two files would let the skill and the file
// it edits drift apart.
//
// Two rules the bodies encode, so a fresh workspace has one answer to each:
//   - Feature tracking is LOCAL MARKDOWN under `.scratch/<feature-slug>/` —
//     `spec.md` plus `issues/NN-<slug>.md`, each ticket opening with `Status:`
//     and `Blocked by:`. No external tracker is assumed to exist.
//   - Durable domain knowledge goes to the WIKI (`wiki/pages/<topic>.md`,
//     catalogued in `wiki/index.md`) — the same place /wrap distils into.
//
// `slash: true` is set ONLY on the user-invoked skills (grill-me, to-spec,
// to-tickets, triage, handoff, optimize-code). The model-invoked ones (tdd,
// diagnosing-bugs, code-review, wayfinder) are loaded when they are relevant, and
// putting them in the / palette would advertise a command whose answer is "I
// already do this".

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

// optimize-code is an ADAPTATION of saurabhkumar8112/cyclomatic-complexity-skill
// (Apache-2.0), which the body credits. Upstream is a single-pass "measure then
// refactor" instruction; this one is staged, because the target here is a whole
// repository rather than the function in front of you. Three things the stages
// add: a Stage 0 that pins a GREEN baseline from the project's own gates (a
// behaviour-preserving refactor is only meaningful against a known-green start),
// a batch cap in Stage 2 (a 40-file complexity diff is unreviewable, and one bad
// extraction poisons the whole of it), and a Stage 4 that re-runs those same
// gates before anything is reported. Upstream's two load-bearing rules — the
// project's own configured threshold wins, and complexity must MOVE into
// well-named functions rather than vanish into cleverness — are kept verbatim in
// spirit and reinforced with this workspace's own honest-verification wording.
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

/**
 * Default skills seeded into `.origami/skills/<name>/SKILL.md` on /firstfold,
 * keyed by skill name. The key is also the directory name, and must match the
 * body's own `name:` frontmatter — the engine keys its registry off the
 * frontmatter, so a mismatch seeds a skill that answers to a different name
 * than the folder it sits in.
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
};
