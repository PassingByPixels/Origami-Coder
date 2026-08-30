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
since 0.4.58 (2026-08-26). The store page with the full feature tour lives at
[`packages/vscode/README.md`](packages/vscode/README.md); the public landing repo is
[github.com/PassingByPixels/Origami-Coder](https://github.com/PassingByPixels/Origami-Coder).
The Marketplace VSIX is the only supported install for users — everything below is for
building from this source tree.

Origami Code is a heavily reworked fork of
[OpenCode](https://github.com/anomalyco/opencode). Upstream references that survive in
this repo (package names, docs links) are inherited history and do not point at this
project.

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
