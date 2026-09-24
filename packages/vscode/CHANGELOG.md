# Origami Code — Changelog

Newest first. Each `##` heading is one built version. The "What's new" pop-up shows
only for a public release: a version listed in `src/dashboard/publicReleases.ts`.
It shows once, as one summary of everything since the last version the user saw:
the curated `whats-new/<version>.md` when it exists, else the sections here since the
previous public release, merged by their `###` headings. Dev builds show nothing.

## 0.4.175

### Nests and Artifacts

- A "?" beside the Artifacts and Nests titles explains, with a diagram, how each works between your desks.
- The Artifacts pane calls this computer "this desk", and "mother base" only the desk that is the Nests mother base. The empty state says only the list travels, with Nests on.
- Nests Storage no longer freezes the engine while it measures (52 s on a 15 GB store before; now small steps, under 0.1 s each). Sizes fill in as they come, and a call that gets no answer shows an error with Retry.
- Storage shows the size of your artifacts (in KB when small) and Apply removes the files of old artifact versions by the artifacts window. The newest version of each artifact always stays.

### Other

- Claude Code: Origami uses the newest Claude Code on the computer, also the one inside the VS Code Claude Code extension. The Claude Code chat mode and the Claude (subscription) connection use the same copy, and the card names it.
- Flock no longer says it runs in another window when this window holds it; when another window does, the message names its engine process.
- Board: Edit path for a repo whose folder moved; a repo removed outside the window stays removed; the ✕ on a missing repo asks first.

## 0.4.174

### Chats

- A message sent while a chat's engine is still starting now waits and goes out once the engine is up, in order. A second message waits behind it. Engine states show in the warning card with Retry, not as red errors.
- Fork is a button next to second opinion. Forking sends nothing to the original chat. `/btw` is gone from the command list; typing it still forks.
- The "Jump to the newest message" button hides whenever you are at the bottom, and following a reply no longer stops by itself.
- Find: next and previous reach every match, including ones in closed cards and thoughts.
- File paths with spaces link as one path.
- Reopening a chat shows a large crane with "Loading chat history…".

### Sub-agents

- A restarted sub-agent no longer stays on RUNNING, and Stop always settles it.
- A sub-agent that stops with its own todo list open gets one nudge to carry on.
- Restarted sub-agents keep the prompt cache: older tool output is trimmed in batches of 18, so far fewer tokens are sent uncached (prompts are slightly larger).

### Other

- Screenshots of 4 MB and more are accepted.
- Artifacts: the pane says when the engine does not answer, shows last-change times, and names desks ("mother base", or "another desk (…)") instead of raw ids.
- Warm tooltips on the newer controls.
- "What's new" now shows only for public releases, as one summary.

## 0.4.173

### Big chats open fast

- A chat now reopens with its newest messages first. "Loading chat history…" shows at once, and older messages load when you scroll up (or press "Load earlier messages"). The message you are reading does not jump.
- Sub-agent transcripts open at the newest reply, and load older messages only when you scroll up.
- The sub-agent drawer lists every sub-agent of the chat at once, including ones that started long ago.
- Find has two modes: LOADED (fast, what is on screen) and ALL (the whole chat). ALL jumps to a hit in an old part of the chat.
- Export and Undo load the older part of the chat first when they need it; export shows its progress.

### Faster inside a session

- The engine no longer reads a whole chat or a whole sub-agent transcript at every step. Pauses at the end of a reply and during compaction in very long chats drop from several seconds to about 0.1-0.2 seconds.
- Sub-agent token, cost and step counts come from saved totals. Step counts of older sub-agents are filled in the background after the first start.
- What is sent to the model has not changed, so the prompt cache works as before.

## 0.4.172

### Models

- Picking a model now saves only which model is your default. Origami no longer copies the provider and its model list into your settings file, so new models from a provider show without an old copy hiding them.
- A provider without its own settings entry is no longer given another provider's name (for example "LM Studio").
- Turning image input on for a model of a provider without its own entry now saves only that one setting.
- A one-time clean-up removes the old Claude (subscription) entry that earlier versions saved by mistake. A backup of your settings file is kept, and an entry you edited by hand is left alone.

## 0.4.171

### Connections

- Claude (subscription, experimental) is now a connection button like the others. Click it to open or close its card.
- The card checks the Claude Code program at once and shows the real reason when it is not ready (for example "version too old", with the fix). Refresh checks it again, for example after `claude update`.
- While Claude (subscription) is not ready, its models are not offered in the picker, and a pick tells you why. A prompt no longer fails with an internal "requires a base URL" error.

### Sub-agents

- A sub-agent transcript opened from a chat in its own tab no longer stays on "Loading transcript…". If an answer does not come in 20 s, the panel says so and you can try again.

## 0.4.170

### Connections

- Claude (subscription, experimental) is now in **+ Add connection**, beside Claude (API key). It shows the same notice first. A card then shows if the Claude Code program is ready and the fix if it is not. Open a new chat to use it.
- New **Refresh** button beside Connections: it reloads the model lists of all your providers, so a new model shows without a VS Code reload. The lists also check for new models every 5 minutes, and the engine reloads its model list when it is older than 60 minutes.

### Nests

- A window can no longer write into a chat that another desk owns. Handing a chat back stops its turn first, then moves it, so the turn ends cleanly as "cancelled".

## 0.4.169

### Claude

- New, experimental: use your Claude subscription as a normal model in Origami, with Origami's own tools, sub-agents and Nests. It is off by default. Turn on "Claude (subscription, experimental)" in the settings; it needs the Claude Code program on this computer, signed in, version 2.1.263 or later. Read the notice before you turn it on: Anthropic bills this at the Agent SDK rate and its terms limit third-party use of subscription logins.
- The model picker shows why the subscription group is not ready (program missing, not signed in, or too old) with the fix in one line.

### Engine

- A provider, tool server or other start that fails now tries again after a short pause (2 s, doubling to 60 s) instead of staying failed until a restart.
- A permission or question prompt no longer hangs when its handler fails; the prompt is answered and the reason is shown.
- Goal mode stops at a hard usage limit and says when it can resume. A provider error with code 5xx is retried.
- The engine log rotates at 10 MB (5 files kept). A chatty tool server no longer blocks. A failed read no longer wipes a settings file.
- Less work per streamed event: shell output is written at most every 250 ms, streamed text is sent to open windows in batches, and only one engine per repo runs the hourly git clean-up.

### Nests

- A chat that is busy in another window or engine is forked, not taken, and a release stops the turn wherever it runs. With Nests off, a turn does no Nests work.

## 0.4.168

### Engine

- Faster turns: each step takes one file snapshot instead of three, about 60% less wait per step.
- Undo is safer: a snapshot no longer comes out empty when a file disappears or another engine holds the git lock, and undo never deletes a file that was there before the turn.
- The session store grows much more slowly: the change summary is written once per turn with short diffs, not the whole file at every step.
- A local model near the end of its context window no longer loops on the same error: the reply size fits the space left, and compaction itself fits.
- A stopped or timed-out start (a model switch, a provider or tool server) no longer leaves the folder broken until a restart.
- Several windows starting at once no longer crash the engine while it sets up the store, and a Nests export cannot lose or repeat history during compaction.

### Nests

- A desk that you remove and invite again joins every desk in the nest. A later removal still wins.

## 0.4.167

### Nests

- Continue here opens the chat, switches the sidebar to Here and selects it.
- The desk that gave a chat away shows "Continued on <desk> at <time>" in the chat at once, with View and Take back here. The message box and the Retry and Rewind actions are blocked there, so no prompt fails as read only.
- Take back here uses the same hand-over in the other direction. A chat can move between desks many times and stays one chat.
- A desk keeps one desk id when it leaves and joins a nest again, so its own chats stay its own. Desks that left the nest no longer show in the Nest tab.

## 0.4.166

### Nests

- Joining a nest is safer. An invite key is for one desk only and does not contain the nest key. The inviting desk shows the new desk's name and a 6-digit code, and you click Accept before the nest key is sent. Keys made by 0.4.165 no longer work: update every desk, then invite again.
- A Security card in the Nests view explains how a nest is kept safe and links the guide to run your own relay.
- The Nest tab no longer lists blank "New session" chats. It uses the same rule as History on the desk that owns the chat.
- Artifacts travel in the nest. The Artifacts pane lists the artifacts of your other desks with a desk chip; Open fetches the files.
- The Agent Manager, History and the Nests sync now work with no chat open.

### Chat

- A "Retrying" card turns to "Recovered" when the model continues with reasoning or a tool call, not only with text.

## 0.4.165

### Nests

- Desks gossip the roster: a desk that joins through one desk becomes known to every other, so all desks in the nest link to each other. Removals and the mother base mark travel the same way.

## 0.4.164

### Nests

- The mother base tails every running and open chat in the nest, so a chat can be continued or forked from it while the desk that wrote it is closed. Pulls come from the online desk with the newest copy.
- A new chat, a retitle or a turn reaches the other desks within two seconds instead of on the 30-second tick.
- The Nests view shows what each desk has tailed and how far behind it is; the rail item shows a dot while a tail runs.

## 0.4.163

### Nests (off by default)

- Nests joins your desks through the relay so a chat started on one continues on another. It is OFF until you turn it on in the Agent Manager: nothing dials the relay before that.
- Agent Manager: a Nests rail item with the switch, your desks (named by hostname, one marked as the mother base, Add a desk by QR or pasted key), Storage per desk with a Keep window per class, and Config.
- Sidebar: when Nests is on and another desk is present, a Here | Nest control. Nest is one flat list of the other desks' chats, running first, then History, with search. Continue here takes a chat over when its desk is idle or offline, and forks it when a turn is running there. A plain click opens it read only.
- Engine: the nest index, session export and import over the relay's bulk lane, take-over, fork, release and reconcile, and a read-only guard on every write into a chat another desk owns.

### Settings

- A Settings rail item above Docs holds the settings that are not insights: chat row density, sub-agent time limit, browser viewport and reveal, cache warming, and the dot-grid backdrop. Insights keeps only insights.

### Artifacts

- Pane actions per row: Open, Open chat about, Rename, Delete with a 4-second Undo. Versions collapse after a pick. Show in Explorer reveals the file.

## 0.4.162

### Fixed

- The context gauge's breakdown card now receives its data. The live engine never attached the composition to the usage update, so every build since 0.4.158 showed the plain tooltip on hover.

## 0.4.161

### Artifacts

- A publish shows an artifact card in the chat (title, version, Open). The first version of a new artifact opens itself in the integrated browser once; later versions only update the badge.
- The publish tool describes what a page can and cannot do in the sandbox, the size cap, and that versions are immutable.
- The base prompt says when to publish an artifact and when to answer in chat.

### Labyrinth

- Cache-loss rows say the right thing for their kind: Claude Code sessions record no cause, unmeasured steps say so, and only older engine runs show the viewer's derivation.

## 0.4.160

### Cache analytics and warming

- Labyrinth names the cause of every cache miss. The engine records it at the step where the prompt prefix changed: cold start, model change, compaction, system or tool change, rewritten history, idle past the provider window, prefill too small, or a provider-side miss on an identical prefix. Older runs say "derived by the viewer".
- A cache dot beside Vision on the composer shows warm, cold or unmeasured for the current chat, driven by the engine, not a timer.
- OpenAI models are kept warm inside their published windows, with extended retention where the API offers it. OpenCode Go and Zen publish no window and are not warmed.
- The OpenCode Go model tab lists every model the gateway serves. The entitlement probe now sends the session header the Go base requires; a pruned tab says why rows are hidden.

### Artifacts

- Agents can publish artifacts: `artifact_publish`, `artifact_list`, `artifact_get` and `artifact_diff`. Every version is kept; a publish on a stale base is refused and both versions survive.
- An Artifacts item in the sidebar dock lists artifacts, versions and conflicts, and opens a page in the integrated browser. Pages are served on the local loopback only, in a sandboxed origin.

### Device group (first step of cloud sessions)

- Desks pair into a device group with a QR or a pasted key. Each desk sees which group devices are online, and one can be marked as the mother base. Nothing syncs yet; this is the pairing and presence layer.

### Storage

- The engine can compact the session journal to one record per part; a compacted journal replays to the same tables. Streaming tool output is journalled at most every five seconds instead of on every delta. A confirmed VACUUM exists in the engine; the Insights buttons come in a later release.
- Relay: a bulk lane for session transfers, budget-counted, with sessions taking precedence over remote control when the daily budget runs low.

## 0.4.159

### Performance

- A new chat starts faster. The engine's agents, skills and plugins snapshot is cached across processes; session start fell from about 960 ms to about 150 ms with nine providers. What loads is identical with and without the cache.
- The sub-agent changed-files pill reads a bounded engine query instead of the whole child transcript.
- Process-wide caches no longer memoise an interrupted load. Images read by a polled child transcript are not re-read on every poll.

### Chat and composer

- A small send glyph appears left of Stop while a turn runs, so a mouse click can send an interjection.
- Closing a chat shows an Undo toast for four seconds before the close is committed.
- The context breakdown card has a pin. Pinned, it stays open until Esc or a click outside.
- The breakdown card shows a trend line of the last twenty readings.
- The branch pill shows the worktree state: changes, ahead, behind.

### Sub-agents and browser

- The sub-agent drawer opens itself on the first running child and respects a manual collapse.
- Sub-agent rows and map cards show an estimated cost from catalogue prices.
- The browser film strip keeps the newest frame fully in view. The caption names the viewport and the shown size when they differ.

### Sidebar, manager and theme

- Crons and Loops are one rail item, Schedules, with the two as tabs inside.
- Repo cards show the worktree state.
- Ember's main surfaces are darker, with inks retuned for contrast.
- The todo tab strip shows its scrollbar at rest when tabs overflow.
- The sidebar header is shorter: the Connections label sits on the brand row.

## 0.4.158

- The running arc on tool cards spins about the track's centre; it no longer wobbles below it.

## 0.4.157

- A warm tooltip no longer stays on screen after its control hides. Moving the pointer away, scrolling, or the control losing its box closes it.

## 0.4.156

- The changed-files popover sits inside the composer's border, anchored like the context card.
- The repo and branch pills size to their names; an ellipsis only past 180 px.
- Agent Manager: the checkouts panel shows three rows and scrolls; the repo carousel rows no longer stretch apart.

## 0.4.155

- Chat prose uses the full pane width again; the 80-character reading measure is gone.
- The changelog popup scrolls.
- The Labyrinth inspector is a right-hand sidebar again, not a bottom band, so reply text reads without scrolling.

## 0.4.154

### Chat transcript

- Agent turns have no surface; user turns carry a tint and a left rail.
- Timestamps sit inline after the label and show on hover. Prose is capped at a reading measure; cards and diffs keep the full width.
- A run of tool calls in one turn draws as one stepped strip with drawn ticks. A tool card that shows only its header draws as a compact strip.
- The thinking row carries a live line that settles when the text lands. The pinned first post is a soft fade, not a box.
- Read-image cards open at the image's own size, capped at the pane. The path on any card reveals the file in the OS explorer; the line range on a read or edit card opens the file in the editor at that line.

### Composer

- Layout: files, turns and the context gauge sit top-right on the model bar. The repo and branch pills share a row with the second-opinion and focus controls. Export is on the mode row. Plan, Approve, Vision and the slash button stay separate.
- One send control. It becomes Stop while a turn runs, and Stop needs a 600 ms hold. Enter still sends an interjection while running.
- The gauge percentage counts to its new value. Dragging a file over the composer shows "Drop to attach".
- The context breakdown card lines up with the composer's right edge.

### Sidebar

- Chat rows show a status dot (running, asking, idle) and an unread count. The chat number moved to the tooltip.
- The connection tile of the model in use carries the accent border.
- The dock marks the open surface. Section headers have a rotating chevron, a count pill and a plus that shows on hover.
- Swipe-to-delete is gone; the x is the delete control. The dock pages as a carousel when the sidebar is narrow.

### Agent Manager

- The left rail expands on hover to full names.
- Board cards carry a status-coloured top edge in every column.
- The repo carousel uses fixed cards in two rows, without the branch line.

### Pull-outs

- Todo panel: tabs scroll when they overflow, dot rows, depth hairline, progress bar, no strike-through.
- Sub-agents: two-line rows with state dots and the last activity quoted. Running rows show the correct elapsed time.
- Browser: action chip, right-to-left URL, fixed thumbnails, a "frame n of m · W x H px" caption, and a Reveal shot control.

### Theme and motion

- Ember: lighter composer surface and error-token gauge ink.
- A chat editor tab shows a 24 px header strip; the logo stays in the sidebar.
- A quiet dot-grid backdrop behind the chat pane (setting `origamicoder.chat.backdrop`, off under reduced motion).
- Send spark, spring checkbox and a fuse toast, all with reduced-motion branches.
- Density switch (comfortable or compact) in Insights.

## 0.4.153

### Sidebar

- The connection cards, the dock and the add button are back at the size of the elements they replaced. Five cards fit at the default sidebar width, and the Claude Code card sits inside the carousel.
- Collabs stays out of the sidebar until you pick it in the dock.
- The dock has no divider. Order: New chat, History, Manager, Memory graph, Front Desk, Collabs, Artifacts. The hover glow stays inside the pill.

### Chat pane

- The transcript is no longer wrapped in a card. The 0.4.151 flat layout is back.
- Streaming text flows: the newest few words carry the accent colour and the text behind them is already white.
- The repo picker works. Choosing another repo starts a new chat in it.
- Typing a slash command in the middle of a message opens the command list. Only a leading command runs on Enter.
- The thinking row shows the brain pill only.

### Model picker

- Providers show their real marks: Anthropic, OpenAI, Google Gemini, Meta, Mistral, xAI, DeepSeek, Qwen, OpenRouter, GitHub Copilot, LM Studio and Ollama.

### Engine

- The changelog popup renders plain markdown with group headings.
- Browser tool use is bypassed by default. The Access popover has one row, Actions.
- The sub-agent todo tab reads the child's latest list through a bounded engine query instead of the whole transcript.
- `origami run` prints the structured stream-drop notice as one line, in plain and JSON output.
- A cancelled catalog or config load no longer poisons the process-wide cache. This was the cause of the provider_refresh test flake and of a rare "All fibers interrupted" error after an interrupted turn.

## 0.4.152

### Chat pane

- The chat pane no longer jumps while a reply streams. A scroll anchor keeps your place
  and a pill shows how many new lines wait below.
- The first user post of a session stays pinned at the top of the transcript. Click it to
  expand it.
- Pictures in the transcript open in a lighthouse view: the image enlarges and sharpens on
  select. Read-image cards open the file in the editor.
- The context gauge has a fuse button for compaction. Click it once, then cancel within the
  timer if you did not mean it. The large compaction popup is gone.
- A stream drop is now a structured notice in the transcript, not a silent stop. The engine
  reports what dropped and why.
- The context breakdown card shows where the tokens go, by field, from the engine.
- Slash commands work from the first word of the prompt only.
- The collapsed todo drawer no longer swallows wheel scroll over the chat.
- Elapsed time shows as a prefix on running tool cards. Tokens-per-second is gone.
- Live session titles persist. A one-off rewrite repairs old sessions that lost their title.

### Repo and branch picker

- Pick the repo and branch for a chat from pills above the prompt. The picker reads the
  worktrees and branches the engine sees.

### Sub-agents

- A sub-agent can ask a question. The ask goes to the main agent through the inter-agent
  messaging, tagged as a sub-agent question, with no timeout.
- The sub-agent view has the same scroll anchor, pin and image handling as the main chat.
- Sub-agent transcripts page in blocks of 50. Long runs no longer load in one read.
- Sub-agents load with a floor so the drawer does not flash empty.
- Stop one sub-agent from its row. The child and its descendants abort; siblings run on.
- Sub-agent transcripts show pictures the child read, have their own focus eye and lightbox,
  and the changed-files pill counts the child's edits.
- A task_parallel card stacks its children as rows. Replayed sub-agent rows no longer show 0/0.

### Sidebar, board and dock

- The sidebar is the carousel and the dock only. Settings cards moved to Insights.
- Artifacts sits in the dock with an `Artifacts (pending)` tooltip.
- Warm tooltips on the dock and the board rail.
- Board cards have spotlight hover.

### Browser

- The agent browser opens beside the chat and does not steal focus. Set when it reveals
  with `origami.browser.reveal` (never, first, always).
- The browser viewport defaults to 1920x1080 so screenshots do not depend on the tab size.
  Change it in dashboard Settings.

### Engine and insights

- Prompt cache warming ships on. It refreshes at 80% of the cache TTL. Switch it off in
  Insights or with `ORIGAMI_DISABLE_CACHE_WARM`.
- The provider catalog is cached, so a new chat starts without a per-provider round trip.
- Storage stats and a prune action for the session store live in Insights. The prune keeps
  user images.
- The `show_image` tool lets the agent put a picture in the transcript.

## 0.4.151

- Added a changelog popup. After an update, Origami now shows what changed for the
  new version in a themed panel, once. It will not show again for the same version.
