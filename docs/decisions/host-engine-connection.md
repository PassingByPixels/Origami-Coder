# Host engine connection (t-sh7cog)

Status: accepted, 2026-09-23. Base: master fdf539dc75 (0.4.165).

## Problem

Host features read the engine through a CHAT's ACP client. With no chat open
there is no client, so:

- the Manager panes answer "Open a chat first";
- History lists nothing;
- the Labyrinth cannot read a run;
- on a mother base with no chat, the Nests tail and the index sync do not run
  (`nestHub.call` throws `NO_ENGINE`).

## Every host call site that goes through the active chat's client

Grep: `getActiveSession() ?? [...this.sessions.values()][0]` and relatives, on
fdf539dc75. Line numbers are for that commit.

| Site | File:line | Kind |
|---|---|---|
| Collabs: `collabClient`, `promptCaptureFor` | `src/dashboard/DashboardPanel.ts:573`, `:578` | Manager (Bots) + sidebar collabs |
| Glidepath sampler (timer) | `DashboardPanel.ts:1110` | background |
| Artifacts push refresh | `DashboardPanel.ts:1604` | chat handler, active chat only |
| Tools pane | `DashboardPanel.ts:2797` | Manager |
| MCP pane | `DashboardPanel.ts:2799` | Manager |
| Flock pane | `DashboardPanel.ts:2800` | Manager |
| Nest sidebar -> hub view engine | `DashboardPanel.ts:2802`, `src/dashboard/nestSidebar.ts:93` | Nests |
| Storage + Nest storage cards | `DashboardPanel.ts:2802` (storage route), `src/dashboard/nestStoragePane.ts:70` | Manager (Insights, Nests) |
| Artifacts pane | `DashboardPanel.ts:2811` | Manager |
| Plugins pane | `DashboardPanel.ts:2812` | Manager |
| Skills pane | `DashboardPanel.ts:2815` -> `src/dashboard/skillsPane.ts:46` | Manager |
| Session delete | `DashboardPanel.ts:2822` | History / Labyrinth |
| Provider auth | `DashboardPanel.ts:2824` | Manager (Settings) |
| Provider usage | `DashboardPanel.ts:2827` | chat surfaces (picker, control strip) |
| Glidepath request | `DashboardPanel.ts:2828` | Manager (Labyrinth) |
| `requestRunSteps` | `DashboardPanel.ts:3133` | Labyrinth |
| `requestRunStats` | `DashboardPanel.ts:3141` | Labyrinth |
| `requestCollabSteps` | `DashboardPanel.ts:3150` | Labyrinth |
| `requestSubagentTranscript` | `DashboardPanel.ts:3159` | sub-agent drawer |
| `listInstructions` | `DashboardPanel.ts:3178` | Manager (Insights) |
| `openBasePrompt` | `DashboardPanel.ts:3189` | Manager (Insights) |
| `createInstructionFile` refresh | `DashboardPanel.ts:3245` | Manager (Insights) |
| `promptCapture` | `DashboardPanel.ts:3252` | per chat (kept) |
| `cacheStats` | `DashboardPanel.ts:3269` | per chat (kept) |
| `restoreInstructionDefault` | `DashboardPanel.ts:3282` | Manager (Insights) |
| VRAM read on `modelPanel.refresh` | `DashboardPanel.ts:3404` | chat surface (kept) |
| `requestHistory` | `DashboardPanel.ts:4343` | History, Labyrinth run index |
| OAuth ids for provider status | `DashboardPanel.ts:5193` | background probe |
| Nest hub engine | `src/dashboard/nestHub.ts:96-97` (`NO_ENGINE`) | Nests |

Kept on the chat, on purpose: `promptCapture` and `cacheStats` read
`client.currentSessionId` (a question about ONE chat), and the second opinion,
Claude Code mirror and model-op paths act on one chat. A host connection has no
session, so for these it has no answer.

Not served by this change (named, not fixed): model lists (`requestModels`,
`harvestAnySessionModes`) come from a session's `configOptions`. The host
connection makes no session (see "Shape"), so a Manager model picker with no
chat still shows no models. Serving it would need `session/new`, which writes a
stored session and runs the provider catalog path.

## Shape chosen: one lazily spawned host client per window

`src/dashboard/hostEngine.ts` (pure) + `src/dashboard/hostEngineWindow.ts`
(the window singleton, the real `AcpClient`).

- Resolution: a chat's client first (the active chat, else any chat), else the
  window's host client. When a chat exists, every host feature does exactly
  what it did before: no second process.
- The host client uses the SAME spawn path as a chat: `AcpClient.start()` is
  split into `connect(cwd, headless)` (spawn + ACP `initialize`) and the
  session step. The host client calls `connect` only. It makes no
  `session/new`, so it writes no stored session, runs no provider catalog
  build, and does not show in History. It is spawned headless
  (`ORIGAMI_AGENT_KIND=background`), so peer discovery leaves it out.
- Two entry points, and only two, may start it:
  1. an engine-reading request from a user surface (the Manager panes,
     History, Labyrinth, Insights, collabs, skills, storage, provider sign-in),
     after the panel has booted, when no chat exists;
  2. the Nests hub, through an adapter engine whose `extMethod` resolves the
     client first. The hub calls the engine only when Nests is on and the desk
     has a device id, so the adapter never starts an engine with Nests off.
- Background timers (glidepath sampler, collab watch, provider probe) only
  use a client that already runs. They never start one.
- The hub gets a window-level view at activation (engine = the adapter), so
  the tail and the index sync run on a mother base with no panel and no chat.
  The sidebar still attaches its own view (post, open) as before.
- Lifetime: one spawn at a time (a shared in-flight promise). A host engine
  that exits is dropped and the next request spawns a new one. Window close:
  the singleton is in `context.subscriptions`; `dispose()` calls
  `AcpClient.dispose()`, which is `shutdownEngine` - the same stdin-EOF then
  kill path a chat engine takes.

### Why not a shared engine process for chats and host

A shared process changes how every chat talks to the engine (one connection,
many sessions, cross-chat event routing, one crash takes all chats). That is
the open "shared engine process" design item and a much larger change. The
ticket needs only a connection that exists with no chat. The per-window client
reuses the spawn path, costs nothing while a chat exists, and leaves chats
unchanged.

## Boot cost, measured

Method: `scratchpad/measure_host_engine.mjs` (lane scratchpad, not committed).
Node spawns the deployed engine `~/.origami/bin/origami.exe`
(`0.0.0-master-202609222302`) with `acp --cwd <tmp>`, isolated `HOME`,
`USERPROFILE`, `XDG_*`, `ORIGAMI_TEST_HOME`, inline config (no live store is
read or written). It talks ACP with `@agentclientprotocol/sdk` 0.21.0. One
warm-up chat run primes the t-qdc718 snapshot cache, then 3 host runs and 3
chat runs alternate. Working set read 10 s after the last call with
`Get-Process`.

| | run 1 | run 2 | run 3 |
|---|---|---|---|
| host: spawn -> `initialize` answered | 1020 ms | 1137 ms | 1083 ms |
| host: `listSessions` | 49 ms | 19 ms | 20 ms |
| host: `_nest_index` (enabled) | 11 ms | 22 ms | 24 ms |
| host: `_storage_stats` | 9 ms | 13 ms | 14 ms |
| host: idle working set | 402 MB | 404 MB | 406 MB |
| chat: spawn -> `initialize` | 1014 ms | 1030 ms | 1176 ms |
| chat: `session/new` | 73 ms | 81 ms | 100 ms |
| chat: idle working set | 465 MB | 465 MB | 461 MB |
| exit after stdin EOF (both) | 54-66 ms | | |

Reading: the cost is the process boot floor (about 1.0-1.1 s, once per
window, only when no chat exists) and about 400 MB of memory while it runs.
Ext methods and `listSessions` answer on a connection with no session in
10-50 ms. `session/new` adds about 70-100 ms and about 60 MB, which the host
connection does not pay.

## Follow-ups (not in this change)

- A host engine that started while no chat existed stays until the window
  closes, also after a chat opens (about 400 MB idle). Retiring it when a
  chat appears needs in-flight calls to drain first.
- Model lists with no chat (see above).
- A host engine can take the Flock owner lease like any engine
  (`flock-owner.json`); the Flock pane then routes through the host client.
