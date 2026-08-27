# Tool card contract

This document is the CURRENT tool-card wire contract between the engine and the
extension — in force since extension 0.4.8, updated as the contract changes. The
two artifacts deploy independently; this file is what keeps their seam from
drifting.

## Stable titles

- Shell calls require a model-written `explanation` of 1–120 characters.
- The engine resolves the shell family. It sends `PowerShell`, `cmd`, or `Bash` as `rawInput.shellDisplay` on running updates.
- The collapsed shell title is `<shell family>: <explanation>`.
- The expanded IN block keeps the exact command.
- Completed updates must not replace a clean title with a command, file path, pattern, or raw tool result.
- Edit and `apply_patch` cards use the `Edit: <title>` prefix.
- Read, grep, glob, task, browser, chart, write, and other cards keep their initial clean title.

## Shell telemetry

Shell result metadata can contain:

- `state`: `foreground`, `background`, or `promoted`;
- `startedAt`;
- `lastOutputAt`;
- `jobId` for detached work;
- `exit`, `output`, `outputPath`, and `truncated`.

Detached output continues through the EventV2 `origami.shell.telemetry` event after the model-facing tool call settles. The dashboard merges these updates into the original card. Foreground work uses the turn Cancel path. Background and promoted work use targeted `shell_stop`; the engine verifies that the job belongs to the requesting session.

## Edit diffs

The engine sends ACP `{ type: "diff" }` content for ordinary edit calls. A single-file `apply_patch` result also sends a structured before/after diff from its result metadata. The dashboard renders it in the existing EditCard before/after view.

Multi-file `apply_patch` results do not select one file silently. They keep the summary fallback until the dashboard supports multiple structured diffs on one card.

## Verification

Run from `packages/engine`:

```powershell
bun test test/tool/parameters.test.ts test/acp/tool.test.ts test/acp/event.test.ts test/tool/shell.test.ts test/tool/apply_patch.test.ts
bun run typecheck
```

Run from `packages/vscode`:

```powershell
npx vitest run webview/dashboard/panes/chatToolMsg.test.ts webview/dashboard/components/toolcards/bashCard.test.ts
npm run typecheck
```

The architecture test currently has two unrelated failures: `src/dashboard/agentManager/tickets.ts` and `webview/dashboard/components/QuickAdd.svelte` exceed their existing caps.
