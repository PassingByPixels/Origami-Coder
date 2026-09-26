# Elastic engine ext methods (t-w2qlop)

ACP ext methods that let the extension make an idle engine cheap. They are
part of option D of epic t-w1r73y. The engine answers them in
`packages/engine/src/acp/elastic.ts`; the logic is in
`packages/engine/src/elastic/`.

The extension may send each name with or without the leading `_` (the ACP SDK
does not strip it; `acp/agent.ts` does). The first three answer from process
state. None of them reads the session store, starts an instance or waits on a
turn.
An OS call that fails never fails the method: the error comes back in the
result.

## `_elastic_class`

Request: `{ class: "active" | "background" | "idle" }`. Any other value is
refused with JSON-RPC `-32602` and changes nothing.

Response: `{ class, priority, ecoqos, childrenSet?, deferred?, error? }`

| Field | Meaning |
|---|---|
| `class` | The requested class, echoed. |
| `priority` | The OS priority the process has now: `normal`, `below-normal`, `idle` (Windows), `background` (macOS `PRIO_DARWIN_BG`), or `unsupported`. Read back from the OS where it can be read. |
| `ecoqos` | `true` when Windows EcoQoS (power throttling, execution speed) is on now. |
| `deferred` | Present (`true`) when `idle` was asked while a turn runs. The OS stays at `background` (BELOW_NORMAL, no EcoQoS) until the last turn ends, then moves to `idle` by itself. |
| `error` | Present when an OS call failed. The engine keeps running. |

What each class does:

| Class | Windows | macOS | Other OS |
|---|---|---|---|
| `active` (the default) | NORMAL, EcoQoS left to the system | `PRIO_DARWIN_BG` cleared | nothing |
| `background` | BELOW_NORMAL, EcoQoS left to the system | `PRIO_DARWIN_BG` cleared | nothing |
| `idle` | IDLE + EcoQoS on | `PRIO_DARWIN_BG` set | nothing |

Every change is reversible without privilege. The priority follows the engine
to every descendant process (MCP and LSP servers, shells, git), found from the
OS process tree on each change: a child is lowered when the engine goes
hidden, and raised again when it is on screen, including a child that was
started while the engine was low (Windows gives such a child the parent's
class). EcoQoS stays on the engine only. The detached WebMCP browser and its
own processes are excluded from priority and trim. On macOS the same
`setpriority(PRIO_DARWIN_PROCESS, pid, ...)` call goes to each descendant,
because PRIO_DARWIN_BG is per process (untested on a Mac).

The response carries `childrenSet` (how many child processes got the class)
when the engine has children.

A process counts as a child only when the OS proves it (t-wdybz9). Windows
keeps a dead parent's pid in the process table and reuses pids, so an
unrelated process can name the engine's pid as its parent. An edge counts only
when the child was created after its parent, and each priority or trim call
re-checks the creation time on the handle it acts through; a pid that changed
owner since the walk is skipped.

When the class changes because a turn starts or ends (a session status write,
not this method), the engine's own priority moves at once and the child walk
runs 250 ms later (`ElasticIdle.CHILD_WALK_DELAY_MS`), once for a burst of
changes, at the last class. The walk is a full process snapshot (11-25 ms
measured on Windows). `_elastic_class` itself still sets the children in place
and counts them in `childrenSet`.

The class also sets the timer cadence. While the effective class is
`background` or `idle`, no periodic engine timer runs more often than every
20 s (`ElasticState.REST_MIN_MS`): the `flock.json` poll, the `flock.json`
fingerprint poll and the flock retry of an engine that does not hold the lease.
In `idle` the peer heartbeat slows from 20 s to 60 s. The hourly snapshot gc and
tool-output cleanup do not run while the engine rests. The flock lease holder
keeps its 5 s beat in every class.

While any session in the engine is busy (a turn or a sub-agent runs), a
requested `idle` is held at `background`: a busy hidden chat runs at
BELOW_NORMAL, never at IDLE + EcoQoS (measured in
`measure_cheap_checks.md`: BELOW_NORMAL protects the foreground under CPU
contention for about +6 % turn time; EcoQoS + IDLE costs a busy turn +15 %).
`active` and `background` are kept as asked.

## `_elastic_trim`

Request: `{}`.

Response: `{ trimmed, reason?, workingSetBefore?, workingSetAfter?, childrenTrimmed? }`

On Windows the engine calls `K32EmptyWorkingSet` on itself, then on every
descendant process (MCP and LSP servers and their own children, found with a
Toolhelp process snapshot). The processes and all in-memory state stay; pages
come back on the next touch. The sizes are the engine's resident set in bytes
before and after. `childrenTrimmed` counts the child processes trimmed; one
that cannot be opened is skipped.

`trimmed: false` with a `reason`:

| `reason` | Meaning |
|---|---|
| `turn-running` | A turn runs. Refused. |
| `subagent-running` | A sub-agent runs. Refused. |
| `turn-ended-recently` | The last turn ended less than 2 min ago. The turn's deferred GC would pull the pages back (measured: 290 MB back within 20 s of a trim made 30 s after a turn). The extension's own delay should be longer; 5 min is the measured safe start. |
| `warm-due` | A prompt-cache warm fires within 30 s. The warm pulls the window back in, so the trim would be wasted. |
| `unsupported-platform` | macOS or another OS. Nothing is done. |
| other text | An OS call failed. |

## `_elastic_idle_report`

Request: `{}`.

Response: `{ parkable, reasons, lastRequestAt?, warmDueAt?, cacheColdAt?, cacheUntimed? }`

This is the single answer to "is it safe to stop this engine now". The D3 stop
logic builds on it. `parkable` is `true` only when `reasons` is empty.

| Reason | Source |
|---|---|
| `turn-running` | A session has a busy or retry status, or a busy runner, and is not a running sub-agent. |
| `subagent-running` | A background job whose type is an agent runs (its id is the child session id). |
| `background-job` | A background shell job runs. |
| `permission-pending` | A permission ask waits for an answer. |
| `question-pending` | A question waits for an answer. |
| `task-result-pending` | A finished sub-agent result waits to be written into its parent. |
| `flock-lease` | This engine holds the flock lease and the relay sockets. |
| `nest-lease` | This engine holds a Nests run lease. |
| `collab-run` | A collab has a drain or a turn in flight. |
| `warm-pending` | A prompt-cache warm is armed. |

Reasons are always listed in the order above. A state that cannot be read counts
as a reason, never as idle.

`lastRequestAt` is the epoch ms of the last real provider request the engine
sent. `warmDueAt` is the epoch ms at which the earliest armed warm fires.

`cacheColdAt` and `cacheUntimed` (t-w2txb2) are the park guard's cache facts.
`cacheColdAt` is the epoch ms after which no prefix this process wrote or warmed
can still be in the provider's cache: for each session, the later of its last
real request and its last accepted warm, plus the LONGEST life its provider
publishes (Anthropic 5 min, or 1 h on the opt-in form; OpenAI up to 24 h on the
extended-retention families, 30 min on gpt-5.6+, up to 1 h on the rest).
`cacheUntimed: true` means some session used a provider that publishes no
window (local servers, DeepSeek, OpenRouter, Google, xAI, Copilot, Zen/Go), so
no time makes a stop cache-neutral. Both are absent when no real request went
out from this process. Since t-z6ytkw (0.4.183) the extension parks an engine
when `parkable` is true and `origamicoder.elastic.parkAfterMinutes` of quiet
have passed (an untimed engine: `parkUntimedAfterMinutes`), whatever
`cacheColdAt` says: a park keeps request bytes identical, so it does not break
the provider cache. `cacheColdAt` now only times wake-to-warm (warmWake.ts),
which runs only while `origamicoder.cacheWarming.enabled` is true (off by
default since 0.4.184).

## `_elastic_park` (t-w2txb2, two-phase since t-wdybz9)

Request: `{ hostPid?: number, allow?: string[] }`. `hostPid` is the extension
host process id; it defaults to the engine's parent process. A value that is
not a positive whole number is refused with JSON-RPC `-32602`. `allow` names
idle-report reasons the caller accepts losing; only `"warm-pending"` is
honoured (a finished Folds agent parks at completion with a cache warm armed),
any other value is ignored.

Response: `{ parked: true, sessionIds: string[] }` or
`{ parked: false, reasons: string[] }`.

This is the atomic last check before the extension stops an engine. The engine
reads `_elastic_idle_report` at call time. When `parkable` is false (after
`allow`) it writes nothing and answers `parked: false` with the reasons. The
extension closes the engine's stdin only after `parked: true`.

When the engine is parkable it:

1. Enters PARKING, in the same tick as the idle check (no await between). From
   here on a `prompt_async` for one of the parked sessions is kept in that
   session's mailbox (below) and answered 204; it starts no turn. A
   `prompt_async` for any other session is refused (400).
2. Writes a STAND-IN for every session it publishes in its peer entry:
   `<agentsDir>/parked/<sessionId>.json` =
   `{ version: 1, parked: true, name, cwd, kind, sessionId, hostPid, parkedAt }`
   (tmp + rename).
3. Removes its live peer entry (`<agentsDir>/<pid>.json`) and stops its
   heartbeat. From this point a peer finds only the stand-in.

A call while the engine is already parked answers the same `sessionIds` and
writes nothing. If a stand-in cannot be written, the engine undoes the park
(as `_elastic_unpark` does: no stand-in stays, the entry stays live) and the
call fails. Park and unpark calls run one at a time, in arrival order.

## `_elastic_unpark` (t-wdybz9)

Request: `{}`. Response: `{ unparked: true, delivered: number }`.

The extension calls it when it keeps an engine up after `_elastic_park` (work
arrived during the park, or the park call failed or timed out). The engine:

1. registers its peer entry again (the same name and address) and waits until
   it is on disk,
2. deletes the stand-ins of its sessions,
3. leaves PARKING,
4. admits each session's mailbox in order through its own `prompt_async` route,
   the same step as a restore (below), with the late second pass.

`delivered` counts the bodies admitted in step 4. Idempotent: on an engine
that is not parked it only admits mail that is waiting (usually none). It does
not fail; a body that fails to admit stays for the next reader.

An engine that is not registered (a background engine without the
`ORIGAMI_AGENT_PEERS` opt-in) writes nothing and answers `sessionIds: []`.

`<agentsDir>` is `~/.origami/agents` (it follows `ORIGAMI_TEST_HOME`). The two
folder names are exported from `packages/engine/src/origami/agent-broker.ts` as
`PARKED_DIR = "parked"` and `MAILBOX_DIR = "mailbox"`, so the extension can
mirror them with a drift-guard test.

### Delivery to a parked chat

Every peer sender uses the same rule: `send_message` (`tool/agents.ts`), a Flock
reply (`flock/deliver.ts`) and a sub-agent question
(`session/subagent-question.ts`, through `session/agent-post.ts` `send`).

- A live engine that holds the address always wins.
- When the only match is a stand-in, the sender writes the exact `prompt_async`
  body to `<agentsDir>/mailbox/<sessionId>/<epochms>-<messageId>.json`
  (tmp + rename; the tmp name does not end in `.json`) and reports the message
  delivered. `send_message` tells the sender that the chat was stopped to save
  memory and starts again to read the message.
- After the write the sender looks again (t-wdybz9). When neither a stand-in
  nor a live engine answers for the chat any more (it was closed while
  parked), the body is taken back and the send is refused.
- A POST that the engine does not accept tries the stand-in next (t-wdybz9):
  the engine can park and exit between the sender's read of its entry and the
  POST. `send_message` gives back its duplicate claim on a failed POST, so a
  retry of a message that never arrived is not refused as "already went".
- `list_agents` lists stopped chats in their own block, with the reply address
  `name#sessionId` and `status=stopped`.
- A stand-in is not aged out by any clock. It is valid while its `hostPid`
  process runs. A reader deletes a stand-in whose host is gone.

### Restore

On `session/resume` and `session/load` of session X, after X is registered, the
engine:

1. waits for its own peer entry write to finish, so the live entry is on disk,
2. deletes stand-in X,
3. admits each body in `mailbox/X/` in file-name order through its own
   `prompt_async` route (the same duplicate-peer check a live POST meets), and
   deletes each file only after it was admitted. A body that fails to admit
   stays for the next load and is logged to stderr (`[peer] mailbox ...`),
4. reads `mailbox/X/` again 5 s later, for a sender that read the stand-in just
   before step 2.

A reader CLAIMS a body before it admits it, by creating `<body>.claim` with an
exclusive create (t-wdybz9). Two readers at once (the late pass, an unpark, a
restore) admit it once. The body is deleted before its claim, so a body whose
delete failed keeps its claim and is never admitted again, in this process or
the next.

### Disposal (t-wdybz9)

Every engine start runs a sweep of `<agentsDir>/mailbox`:

- A body for a session that no stand-in (with a live host) and no live peer
  entry answers for is deleted once it is older than 7 days
  (`AgentMailbox.MAIL_TTL_MS`). That is a chat closed while it was parked, or
  one whose window never opened again. Until then a `session/load` of that
  chat (a window that opens again) still admits it.
- A claim older than 10 min (`CLAIM_STALE_MS`) belongs to a reader that died,
  or to a body admitted but not deleted: the claim and its body are deleted,
  never admitted again (at most once).
- A tmp file older than 1 h is deleted.

The sender of a body deleted by the sweep was told "delivered" when it was
kept; nothing tells it otherwise.

The extension's part: watch `<agentsDir>/mailbox` recursively and restore the
chat whose engine session id names the sub-folder; delete
`<agentsDir>/parked/<id>.json` when a chat is closed while parked (also after
a park call that was still in flight when the chat closed); call
`_elastic_unpark` when it keeps an engine up after `_elastic_park`.

## `_elastic_spare` (t-w2u2ki)

Request: `{}`. Response: `{ spare, adopted }`.

The VS Code shell starts one engine per window ahead of time with
`ORIGAMI_SPARE=1` (a warm spare), so the next new chat does not wait for a
process start. While it waits, the spare boots no instance, starts no MCP
server, writes no peer heartbeat and runs no Flock service
(`packages/engine/src/elastic/spare.ts`). `initialize` still reports the peer
name it will register under.

The first `session/new`, `session/load`, `session/resume` or `session/fork`
adopts the spare: the engine drops every instance and the global config cache
(a `session/list` probe may have booted one), then starts the peer broker and
the Flock service, then answers the call. The chat reads the disk as an engine
started at that moment would.

Adoption has a time limit (t-wdybz9): the session call waits at most 5 s
(`ElasticSpare.ADOPT_LIMIT_MS`), and the instance disposal alone at most 4.5 s,
so a finalizer that never ends (a plugin, an LSP server) neither keeps the chat
from opening nor keeps the peer broker and Flock from starting.

| Field | Meaning |
|---|---|
| `spare` | `true` while the engine waits as a spare. An engine started without the variable, or an older engine, never says `true`. |
| `adopted` | `true` once a session call adopted the spare. |

## `_elastic_adopt` (t-y4x518)

Request: `{}`. Response: `{ adopted }`, sent when the adoption has ended (or
reached its time limit).

`WarmSpare.take()` sends it (after `_elastic_class active` when the spare waits
lowered) before it hands the spare to the new chat, so the adoption starts
before any call of the chat. The adoption first lifts a spare that waits at the
`idle` class back to `active`, in the same step (also when the adoption starts
at a session call). Every call that arrives while the adoption runs, except the
`_elastic_*` methods, waits for it: the chat's first calls boot its instance
once, after the pre-adoption instances and the global config cache are gone.
`adopted` is `false` on an engine that was never a spare. An older engine
answers -32601 and adopts at the first session call, as before.

## `_elastic_warm` (t-z6ytkw)

Request: `{ sessionId }`. Response: `{ warmed: true, cacheRead? }` or `{ warmed: false, reason }`.

`_elastic_park` now also answers `warms: [{ sessionId, dueAt }]` when a cache warm
was armed: the engine wrote that warm's stream input to
`<state>/park-warm/<session>.json` (engine `elastic/park-warm.ts`). The extension
wakes the parked chat in the background shortly before `dueAt`
(`vscode/src/elastic/warmWake.ts`) and sends `_elastic_warm`. The engine reads
and deletes the file and sends the same warm the live engine would have sent
(same `LLM.stream`, same trailing message; test `park-warm-bytes.test.ts`). It
refuses when no warm was handed over, when cache warming is off, or when it
already sent a real request for the session. Then the extension parks the chat
again.
