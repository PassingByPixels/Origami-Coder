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
// to-tickets, triage, handoff). The model-invoked ones (tdd, diagnosing-bugs,
// code-review, wayfinder) are loaded when they are relevant, and putting them in
// the / palette would advertise a command whose answer is "I already do this".

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
};
