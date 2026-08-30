<p align="center">
  <img src="packages/vscode/images/origami-coder-icon.png" width="128" alt="Origami Code" />
</p>
<h1 align="center">Origami Code</h1>
<p align="center"><b>The Best VS Code AI Harness</b></p>

<p align="center">
  <img src="https://vsmarketplacebadges.dev/version/OrigamiLabs.origamicoder.svg" alt="Marketplace version" />
  <img src="https://vsmarketplacebadges.dev/installs-short/OrigamiLabs.origamicoder.svg" alt="Installs" />
  <img src="https://img.shields.io/badge/license-Origami--Proprietary-orange" alt="License" />
</p>

<p align="center">
  🌐 <a href="https://origamilabs.nl">Website</a> •
  📖 <a href="https://origamilabs.nl/docs.html">Docs</a> •
  🧩 <a href="https://marketplace.visualstudio.com/items?itemName=OrigamiLabs.origamicoder">Marketplace</a>
</p>

---

This harness is built from the ground up on the following foundations:

| | |
|---|---|
| **VS Code First** | If you're into TUIs or Electron wrappers, it's not for you. |
| **Private & Local** | No ads, no telemetry, no trying to sell you a service. |
| **As simple as you need it as complex as you want it** | Open a chat and get building — but within the UI you have deep analytics and levers to make it yours. |

**Published** on the VS Marketplace as
[`OrigamiLabs.origamicoder`](https://marketplace.visualstudio.com/items?itemName=OrigamiLabs.origamicoder)
since 0.4.58 (2026-08-26). The Marketplace VSIX is the only supported install for users —
the build steps further down are for building from this source tree.

Origami Code is a heavily reworked fork of
[OpenCode](https://github.com/anomalyco/opencode). Upstream references that survive in
this repo (package names, docs links) are inherited history and do not point at this
project.

## Features

### Multiple Chats, Multiple Models, Full Control

- Every chat picks its own connection, model and sub-agent from a single dropdown.
- Local, self-hosted servers, providers and lab APIs all sit in the same list.
- Signed-in accounts show their credit use and reset timer under the composer.
- Closing a chat pane does not end the session -> the agent keeps working.

![Chat, model and usage controls](packages/vscode/images/chat-model-usage.png)

### Charts in the thread, and agents that talk to each other

- Have alot of data to review? Have your Model make a chart of it in chat
- Each session can see one another and send each other messages
- Great for handovers, sub contracting work to cheaper models and larger collaborations
- It picks the work up on its next turn. A model with no vision of its own can be handed a vision sub-agent.

![Native charts and agent-to-agent messaging](packages/vscode/images/charts-and-messaging.png)

### Nothing hidden, and a session that closes properly

- Every action and every thought stream is on the record (collapsed by default)
- Open when you want to audit a turn.
- The todo pane tracks the agent's plan as it moves.
- Tell it to wrap the session and it writes the handoff and the wiki depth, so the next session starts already knowing where you left off.

![Thought stream, todo pane and session wrap](packages/vscode/images/wrap-and-todos.png)

### A memory graph, not a second app

- Your workspace knowledge base drawn as a graph.
- Filter the nodes, hover to light up the links, click one to read the page inline with its tags and date.
- Nothing else to install and nothing to sync.

![The memory graph with a page open below it](packages/vscode/images/memory-graph.png)

### Folds — a board per repo, an agent per worktree

- Spec a ticket, launch an agent on it, and that agent works in its own isolated git worktree.
- Your working tree stays untouched
- You review the diff and apply it on your command, never before.
- Any local git repo can go on the board, and you switch checkouts and branches from the same screen.

![The Folds board with repo cards and ticket columns](packages/vscode/images/folds.png)

### Repo maps you can walk through

- Remap a repo and Origami draws it
- Components by kind, the pillars they belong to, and the flows that cross them -> pan, zoom, filter, click a box for its connections or a flow to trace it end to end.
- Key files come with a line of summary each. It is built for both readers: you, and the agent that needs to orient before it touches the code.

![Isometric repository map](packages/vscode/images/repo-map.png)

### Sub-agents you can actually watch

- Delegated work gets its own list —> running, done, errored
- See the model and the wall time for each one.
- Open any of them and read the full transcript with its findings, during the run or long after it finished.

![Sub-agent list and an opened sub-agent report](packages/vscode/images/sub-agents.png)

### Bots built to your spec

- Define your own bots -> a name, a model, a tool set, a memory setting and a step budget.
- Each one runs in three places —> its own chat, a collab room, or as a sub-agent
- And any of them can be marked as a vision agent for when you need a spare pair of eyes.

![The Bots pane with custom bot cards](packages/vscode/images/bots.png)

### Loops

- Start one from the composer with `/loop <interval> <prompt>` and it re-runs on that interval.
- Loops survive a window reload —> each re-arms itself when its chat reconnects, 
- Want to end a loop but come back later? mark it as persistent and it stays there dormant, waiting.

![The Loops pane with a live loop](packages/vscode/images/loops.png)

### Crons — scheduled runs with the editor closed

- A cron is a real OS scheduled task, it fires with VS Code closed, unlike a Loop.
- See every job and when it next runs, and pick the connection and model each one calls.
- Schedules live in .origami/crons.json, tracked in git (git is the undo.)

![The Crons pane with scheduled jobs and the per-cron model picker](packages/vscode/images/crons.png)

### A browser the agent can drive

- Fully ocmpatible with the integrated browser -- opens a URL or a local page, reads it and clicks through it
- Permissioned in case you dont want it
- Point it at your own dev server and the agent can check its own work.
- Every chat exports from the composer, so a session can be handed to anything.

![Integrated browser sharing a page with the agent](packages/vscode/images/browser.png)

### Insights — see what the model is actually fed

- Every file that gets prepended to your prompt, with its character count, its token estimate and its share of the total.
- Override the base prompt, restore the default, or add your own file.
- Cache hit ratio for the session and across the last hundred runs sits right underneath.

![The Insights pane showing instruction files and cache hit ratio](packages/vscode/images/insights-instructions.png)

### Insights — the assembled payload, part by part

- Expand the last turn and see exactly what left the engine: each assembled part with its size, which ones ride as a tail after the messages, the final system block, and every tool schema offered with the characters it spends.

![The Insights pane showing the assembled parts and tool schemas](packages/vscode/images/insights-payload.png)

### Labyrinth — where the tokens went

- Labyrinth indexes every run: tokens in and out, raw against real after cache, cache read against write, and spend split both by category and by delegated sub-run.
- Three views of the map, an inspector for any step, and the whole thing exports to HTML.

![The Labyrinth run index, spend summary and map](packages/vscode/images/labyrinth.png)

### Skills

- Skills are markdown files the agent loads when the task calls for one. -  Search the installed set, read what each does, and edit any of them in place without leaving the pane.

![The Skills pane with a skill open for editing](packages/vscode/images/skills.png)

### Tools, and the context they cost

- Every tool sits in one of three states: Loaded :  so its schema goes out with every request;  Deferred : so it costs one catalog line until the model searches for it; Off : Session never sees it, no context as if it never existed. 
- Scaffold a new tool from the built-in template, and turn on code mode to let the model reach several tools from one script.

![The Tools pane with per-tool loaded, deferred and off states](packages/vscode/images/tools.png)

### MCP servers from the UI

- Add a server from the pane and it is written to the config you choose and connected straight away, with no session restart.
- Disable, disconnect or remove it from the same card.

![The MCP pane with a connected server](packages/vscode/images/mcp.png)

### Plugins

- Plugins follow the open agent-plugins standard: 
- Point at a folder and a valid manifest brings its skills and its MCP servers along with it.
- A manifest that does not parse is refused with the parser's own message. 
- Toggle a plugin off without deleting it.

![The Plugins pane with an installed plugin](packages/vscode/images/plugins.png)

### Plays well with your other assistant

- Origami is a side panel and a set of editor tabs, not a takeover of your window.
- Claude Code can sit right next to it in the same workspace 
- Same files, same repo, your call which one gets the job.

![Origami and Claude Code side by side in one VS Code window](packages/vscode/images/side-by-side-claude.png)

## Getting started

1. Install Origami Code from the VS Code Marketplace.
2. Open it from the activity bar — the crane icon — and the panel docks on the right.
3. Add a connection. Pick a local or self-hosted server, a provider, or a lab account, then paste a key or sign in. Everything you have connected stays visible in one list, with usage and reset timers where the provider reports them.

   ![connections](packages/vscode/images/connections.png)

4. Run /firstfold in a new chat. It scans the workspace, writes an AGENTS.md your agent reads every session, creates the project folders, seeds a wiki index and starts a rolling HANDOFF.md — narrating each step as it goes.

   ![first-fold](packages/vscode/images/first-fold.png)

5. Start working. Chat as you are, or open the Folds board, add a repo and launch your first fold.

## Support the project

Origami Code is free, has no ads and sells you nothing. If it saves you time, you can throw something in the tin.

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-yellow)](https://buymeacoffee.com/passingbypixels)

---

## What this repo builds

Two artifacts. They build and deploy separately — a change to one does not require a
rebuild of the other.

| Artifact                   | Package             | Build command                          |
| -------------------------- | ------------------- | -------------------------------------- |
| Engine binary (`origami`)  | `packages/engine` | `bun run script/build.ts --single`     |
| VS Code extension (`.vsix`)| `packages/vscode`   | `npm run package`                      |

The engine provides the CLI and the terminal UI. The VS Code extension
(`origamicoder`) provides the dashboard and chat UI and runs the engine for
its sessions. The RELEASE artifact is the **merged platform VSIX**
(`scripts/package-merged.ps1`) — extension + engine + vendored ripgrep in one file;
a plain `npm run package` VSIX contains no engine.

## Build from source

Build the engine, then copy the binary onto your `PATH`. `~/.origami/bin` is the
conventional location and the one the uninstaller knows about:

```bash
bun install
cd packages/engine
bun run script/build.ts --single
# the binary lands in dist/<target>/bin/ — copy it to ~/.origami/bin
```

For the VS Code extension, build the `.vsix` in `packages/vscode` and install it from
the VS Code Extensions view (**Install from VSIX...**).

Self-upgrade is disabled in this fork by design: `origami upgrade` fails fast, so a
build from this repo is never replaced by an upstream package.

## Agents

Origami includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

## Licence

`LICENSE` is the **Origami-Proprietary** licence: free to use, personal or
commercial; no selling, no adapting-to-sell, no redistribution outside the official
channels. `LICENSE-UPSTREAM` preserves the MIT licence and copyright of OpenCode,
which this project is derived from; bundled components (ripgrep and others) keep
their own licences.

## Working on this repo

Read `docs/WORKING_ON_ORIGAMI_CODER.md` for the extension-vs-engine split, the build
and deploy steps, and the verification traps. Read `AGENTS.md` for the conventions
that keep future upstream merges cheap.
