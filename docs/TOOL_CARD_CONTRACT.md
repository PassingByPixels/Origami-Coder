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

## Read images

A `read` of an image file answers the MODEL with "Image read successfully" plus a
base64 attachment. The CARD never carries those bytes. Instead:

- The engine stamps `rawOutput.metadata.display = { type: "image", path, mime, bytes }`
  (`tool/read.ts`). `path` is absolute and normalised: `locations[0].path` is the
  model's raw argument and is often relative, so a webview cannot resolve it.
- The extension stamps a `readImage` rider onto the `toolResult` message, onto
  every `restoreMessages` tool result, and onto every `subagentTranscriptData`
  entry (t-j50p3r — a child's transcript is the same replay-log shape, so the
  sub-agent transcript view draws the same card), and DROPS the payload's base64
  `images` array for that card (`src/dashboard/toolImageStamp.ts`; the facts and
  the byte caps stay in `src/dashboard/toolImageCard.ts`). The stamp runs once per
  target webview, because the src belongs to that webview.
- `readImage.src` is `webview.asWebviewUri(Uri.file(path))`, present only when the
  file lies under one of that webview's `localResourceRoots`. The chat surfaces
  are created with three: the extension's `out/webview`, the workspace folders and
  the OS temp directory (`src/dashboard/toolImageUri.ts`). An image outside them
  keeps the placeholder — the roots are not widened per file.
- No `src` means the phone's case: the Remote shim has no resource roots. `readImage`
  arrives with no `src`, and `shapeForPhone` (`src/remote/phoneView.ts`) fills a
  `readImage.thumb` instead — a capped JPEG data URI, re-encoded off the FILE
  (`src/dashboard/readImageThumb.ts` reads it fresh, cached by path+mtime; never off
  the model's base64 copy) via the pure decode/downscale/re-encode path in
  `src/dashboard/imageThumb.ts` (`pngjs` + `jpeg-js`, pure JS, no native build).
  `ReadFileCard.svelte` draws `src ?? thumb`; the size-and-path placeholder shows
  only when neither could be made (GIF/WebP, or no JPEG quality step got under the
  cap). `toolImageCard.ts`'s `ReadImageCard.thumb` and `toolReadImage.ts`'s
  `ToolReadImage.thumb` carry the same field through the wire and the card.
- Non-image reads (text, directory) are untouched. The `browser` tool's
  screenshots ride the payload's `images` array unshaped for the desktop, but
  `shapeForPhone` thumbnails every entry the same way (`thumbnailDataUrl`,
  `src/dashboard/imageThumb.ts`) before it reaches a phone frame; an entry that
  cannot be thumbnailed is dropped from the array rather than sent full-size.
- Every phone-bound picture — read image or screenshot — is capped at
  `PHONE_IMAGE_BYTE_CAP` (40 KB, `src/dashboard/toolImageCard.ts`) on the ENCODED
  JPEG bytes, longest side 512 px, quality stepped 80 → 40 until it fits.

## Show image (t-mce92i)

The `show_image` engine tool (`packages/engine/src/tool/show-image.ts`) is the
same wire as a read image, pointed the other way: the model names a file the USER
should see. It emits the SAME `metadata.display = { type: "image", path, mime,
bytes }` block and one image attachment, and `acp/tool.ts` maps its name onto the
ACP kind `read`. So the dashboard's KIND_REGISTRY picks `ReadFileCard`, and the
host's `readImage` stamp (desktop `src`, phone `thumb`, no base64) applies
unchanged. `readImageFacts` therefore accepts the tool names `read` and
`show_image` and no other. The card title is the tool's `caption`, or the file
name. Refusals, each naming the file: outside the workspace AND outside the
user's home; missing; a directory; over 8 MB; bytes that are not PNG, JPEG, GIF
or WebP (magic bytes, never the extension).

## Stream-drop notices (t-q90gj9)

A dropped provider stream is an ENGINE notice, not agent prose. It used to be a
text part, so it arrived wearing the agent's name and several attempts ran
together in one bubble; taking that apart again means matching the wording, and
the wording is half provider prose (one real detail is `fetch failed
(ECONNRESET)`, brackets and all). There is no text matching on either side of
this seam.

- The engine writes a text part with `text: ""` and the notice on `metadata`
  under `origami_stream_drop` (`packages/engine/src/session/stream-drop.ts`,
  `NOTICE_KEY`). No delta is published for it: there is no prose to stream.
- `packages/engine/src/acp/event.ts` forwards it as an **empty**
  `agent_message_chunk` carrying the same key on `_meta` — from the live part
  update AND from the history replay, so a reopened chat shows the same row.
  A client that does not know the key renders nothing, which is the honest
  degrade.
- The notice is `{ kind, attempt, max, detail, terminal }`:

  | Field | Meaning |
  |---|---|
  | `kind` | `retrying` (another attempt follows) or `stopped` (the ladder is spent) |
  | `attempt` | 1-based, the attempt that just failed |
  | `max` | the family's whole budget (`SessionStreamDrop.limit()`, default 3) |
  | `detail` | the provider's own sentence, verbatim |
  | `terminal` | true only for `stopped` — the card that offers **Retry** |

- `recovered` is **not** a wire state. The engine cannot know at emit time; the
  client sets it when real prose lands on the open card, bounded by the next
  drop (`webview/dashboard/panes/streamDropNotice.ts`). The live pane and the
  reload-restore path share that rule, so a reload cannot disagree with what the
  user was looking at.
- Host reader: `packages/vscode/src/acpStreamDrop.ts` (`onStreamDrop`), a
  documented MIRROR of the engine's shape — the packages cannot resolve each
  other. The webview half is mirrored again for `rootDir`, guarded by
  `streamDropNotice.test.ts`, which reads both files.
- Both readers are fail-CLOSED: a half-written rider draws no card at all.
- Sessions stored before this change hold the old sentence as ordinary agent
  text and keep rendering as agent text. Nothing upgrades them.

## Paged sub-agent transcripts (t-krxap7)

`subagent_transcript` is the fork-owned ACP ext method behind the sub-agent
drawer's transcript view. It now reads a PAGE of the child's stored session
instead of always reading the whole run.

A **step** is one stored message — a user or assistant turn with its parts, as
the session database holds it. It is not one tool call and not one rendered row:
one message can project into several rows (prose, a thought, one card per tool
part). The source is the engine session database, through
`GET /session/{id}/message`, which is already indexed on
`(session_id, time_created, id)`.

### Request

| Field | Type | Meaning |
|---|---|---|
| `sessionId` | string, required | The CHILD's session id. |
| `cwd` | string, optional | Scopes the read, as before. |
| `limit` | number, optional | Read the newest `limit` messages. Omitted or `0` = the whole transcript, exactly as before. |
| `before` | string, optional | Opaque cursor from a previous answer's `cursor`. **Refused without a `limit`** — the store answers that pair with a 400, and silently dropping it would return the newest page to a request for an old one. |

### Response

The unpaged answer is unchanged. A paged answer adds two fields:

| Field | Type | Meaning |
|---|---|---|
| `hasMore` | boolean | Stored messages older than this page exist. |
| `cursor` | string, optional | The `before` value for the block preceding this page. Absent at the head. |

The engine asks the store for `limit + 1` rows. A reply longer than `limit`
is what proves an older block, at the cost of one row rather than a second
query. The extra row is the oldest one and is dropped; the cursor is taken from
the first row KEPT, because the `before` predicate selects rows strictly older
than the row it names. Cursoring on the dropped row would skip a message.

### The webview side

`origamicoder.subagents.transcriptPageSize` (default 50) is read by the
extension host, never by the webview, so one setting governs every panel.
`0` restores the whole-transcript read.

`webview/dashboard/components/subagentPaging.ts` holds the window rules: one
request in flight at a time, so the 'Load earlier steps' button and the
scroll-top `IntersectionObserver` cannot fetch the same block twice; and a reply
whose `before` is already in the window is DROPPED, so a block is never drawn
again. The reply echoes `before`, which is how the panel tells a newest-page
reply (rebuild) from an earlier block (prepend).

`running` is only meaningful on the newest page. An older block ends wherever
the page cut, which says nothing about whether the child is still out.

## Verification

Run from `packages/engine`:

```powershell
bun test test/tool/parameters.test.ts test/acp/tool.test.ts test/acp/event.test.ts test/tool/shell.test.ts test/tool/apply_patch.test.ts test/tool/read.test.ts test/acp/subagent-transcript.test.ts
bun run typecheck
```

Run from `packages/vscode`:

```powershell
npx vitest run webview/dashboard/components/subagentPaging.test.ts webview/dashboard/components/SubagentTranscriptView.test.ts webview/dashboard/panes/chatToolMsg.test.ts webview/dashboard/components/toolcards/bashCard.test.ts webview/dashboard/components/toolcards/readImageCard.test.ts webview/dashboard/__tests__/readImageWire.test.ts webview/dashboard/__tests__/imageThumb.test.ts
npm run typecheck
```

The architecture test currently has two unrelated failures: `src/dashboard/agentManager/tickets.ts` and `webview/dashboard/components/QuickAdd.svelte` exceed their existing caps.
