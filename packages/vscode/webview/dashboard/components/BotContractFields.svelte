<script lang="ts">
  // The PERMISSIONS + MEMORY half of the agent-def editor, extracted from
  // CollabAgentForm.svelte at birth (264 of its 280-line cap). The form keeps
  // identity (name, description, model, glyph, persona); this owns what the bot
  // may DO and what it carries between sessions.
  //
  // W6 OWNER RULINGS REBUILT THIS FILE. What it used to show — an Engine
  // default / Strict / Standard / Open tier row, a Worker/Observer block row
  // under it, a Skills allowlist and a model-preference chain — is gone. In its
  // place: A CHECKBOX PER TOOL, and nothing else.
  //
  //   "Nobody cares what skills a bot has, only what tools."
  //
  // WHY THAT IS ALSO THE HONEST SHAPE. The tier and the block were two controls
  // for one question, stacked in precedence order, and the answer to "what may
  // this bot do" was the composition of them — readable only by knowing which
  // beat which. The ticks ARE the block, and the block is what the engine reads
  // (Permission.disabled removes a denied tool from the map the model is
  // handed), so there is now one control and it says exactly what happens.
  //
  // W9 TOOK THE LAST TWO BUTTONS. Worker and Observer survived W6 as PRE-TICK
  // shortcuts, and they were the last thing on this pane that answered "what may
  // this bot do" with a name instead of with the list. A new bot is now born
  // with EVERY gate ticked (`allToolKeys`) and the user unticks — one direction,
  // one control, and the starting state is the one the checklist can actually
  // draw. The only button left is the hand-tuned block's escape hatch below,
  // which is not a preset: it does exactly what a new bot does.
  //
  // ONE CHECKBOX PER GATE, NOT PER TOOL ID. `edit`, `write` and `apply_patch`
  // share a single permission key, so three boxes would offer two decisions
  // that do not exist. botTools.ts collapses them and this lists what it
  // returns, naming every tool a box governs.
  //
  // THE LIST IS LIVE WHEN THERE IS AN ENGINE TO ASK. `toolCatalog` is the ids
  // from the Tools pane's own `list_tools` wire — so a user-file or plugin tool
  // is tickable the moment the engine reports it — and the shipped mirror is
  // the fallback when no chat is open to read one through.
  //
  // THEMED (architecture.test.ts's THEMED_FILES): which preset is picked and
  // which tools are ticked are carried by border and fill alone, so a literal
  // here is a permission choice that goes invisible in whichever of the five
  // themes it clashes with.
  //
  // W7-L2: the GRID scrolls on its own (`.bc-picks-scroll`), the presets and
  // the summary line above it never do. The catalog is engine-reported and
  // only grows, so a flat inline block would eventually push the persona box
  // off the pane — Passing flagged it before that day arrived.
  import { toolsSummary, type BotContract } from './botContractView';
  import { allToolKeys, gatesFor, TOOL_IDS, type ToolGate } from '../../../src/dashboard/botTools';
  import type { CollabPreset } from '../../../src/dashboard/agentManager/collabPresets';

  interface Props {
    bot: BotContract;
    /** The ticked permission keys. `undefined` = this def has no permission
     *  block at all; picking a preset is what gives it one. */
    tools: string[] | undefined;
    /** Which preset the tick set currently IS — a READING of the ticks, not a
     *  control. It is here only so the summary line can name a set that happens
     *  to be one; nothing on this pane sets it. */
    preset: CollabPreset | undefined;
    /** True when the def carries a permission block no tick set can describe —
     *  one that scopes a tool to a pattern. Its ticks are `undefined`, and
     *  saying "no block" about it would be a lie in the dangerous direction. */
    handTuned?: boolean;
    /** Live tool ids from the engine (`list_tools`). Empty falls back to the
     *  shipped mirror, which still writes exactly the same block. */
    toolCatalog?: string[];
    /** Facts already in this bot's store, so the memory row can offer to show
     *  or wipe something that exists rather than an empty affordance. */
    memoryFacts?: number;
    onViewMemory?: () => void;
    onClearMemory?: () => void;
  }
  let {
    bot = $bindable(),
    tools = $bindable(),
    preset,
    handTuned = false,
    toolCatalog = [],
    memoryFacts = 0,
    onViewMemory,
    onClearMemory,
  }: Props = $props();

  /** The rows. Live ids when the engine answered, the shipped mirror otherwise,
   *  plus any key this def already ticks that neither list knows — a line the
   *  user wrote by hand is theirs, and a row is how they can untick it again. */
  const gates = $derived.by<ToolGate[]>(() => {
    const known = gatesFor(toolCatalog.length > 0 ? toolCatalog : TOOL_IDS);
    const extra = (tools ?? []).filter((key) => !known.some((g) => g.key === key));
    return [...known, ...extra.map((key) => ({ key, tools: [] }))];
  });
  const live = $derived(toolCatalog.length > 0);
  const summary = $derived(toolsSummary({ tools }, preset ?? ''));

  /** The hand-tuned block's ONE way out: start from what a new bot starts from.
   *  Deliberately the same call `blank()` makes, so "replace it" and "make a new
   *  one" cannot mean two different starting sets. */
  function useTickList() {
    tools = allToolKeys(toolCatalog);
  }
  function toggle(key: string) {
    const have = tools ?? [];
    tools = have.includes(key) ? have.filter((k) => k !== key) : [...have, key];
  }

  /** Assign through a fresh object: the parent binds `draft.bot`, and mutating
   *  in place would not re-run its own derivations. */
  function set(patch: Partial<BotContract>) {
    bot = { ...bot, ...patch };
  }
  /** Remove a key outright — "the file says nothing", which is NOT the same as
   *  any value the key could hold. */
  function clear(key: keyof BotContract) {
    const next = { ...bot };
    delete next[key];
    bot = next;
  }

  // `memory: true` is the engine's own default, so ON is stored as SILENCE
  // rather than as the word `true` — the serializer would drop it anyway, and
  // storing it would make an untouched def look edited.
  const memoryOn = $derived(bot.memory !== false);
  function setMemory(on: boolean) {
    if (on) clear('memory');
    else set({ memory: false });
  }
</script>

<div class="bc-field">
  <span class="bc-label">Permissions</span>
  <div class="bc-row">
    <!-- The ONLY button left, and only where the checklist cannot be drawn at
         all. It is not a preset: it writes the same all-ticked set a brand-new
         bot is born with, which the user then unticks. -->
    {#if handTuned && !tools}
      <button class="bc-btn" onclick={useTickList}>Replace with a tick list</button>
    {/if}
    <span class="bc-count">{summary.text}</span>
  </div>
</div>
<div class="bc-hint">
  {tools
    ? 'The boxes below are this bot’s tools exactly as they stand. Untick anything it must not have.'
    : handTuned
      ? 'This file has a hand-tuned permission block — one that scopes a tool to particular commands, which no tick can say. It is kept exactly as written; replacing it with a tick list DISCARDS it.'
      : 'This def carries no permission block, so the engine offers it every tool. Tick the tools you want to write one.'}
</div>

<!-- NO CHECKLIST over a hand-tuned block. Every box would draw unticked, which
     would say the bot has no tools while the file grants it several — and one
     click would silently replace a block the hint has just promised to keep.
     The button above is the explicit way out, and it is the only one offered. -->
{#if !handTuned || tools}
<div class="bc-field">
  <span class="bc-label bc-sub">Tools</span>
  <span class="bc-note">{live ? 'read from the running engine' : 'no chat open — this build’s own list'}</span>
</div>
<!-- The tick GRID scrolls on its own; the preset buttons and the summary line
     above it never do — see the ".bc-picks-scroll" rule below for why. -->
<div class="bc-picks-scroll">
  <div class="bc-picks">
    {#each gates as g (g.key)}
      <label class="bc-tool" class:picked={(tools ?? []).includes(g.key)}
        title={g.tools.length > 1
          ? `One switch for ${g.tools.join(', ')} — the engine gates all of them on "${g.key}".`
          : g.tools.length === 0
            ? `"${g.key}" is allowed by this file but is not a tool this build knows. Untick it to drop the line.`
            : g.key}>
        <input type="checkbox" checked={(tools ?? []).includes(g.key)} onchange={() => toggle(g.key)} />
        <span>{g.key}{#if g.tools.length > 1}<span class="bc-also">+{g.tools.length - 1}</span>{/if}</span>
      </label>
    {/each}
  </div>
</div>
<div class="bc-hint">
  Ticked is what the bot gets. An unticked tool is not withheld until it asks — it never reaches the model at all, so a
  bot cannot work around it. Anything this build has not heard of stays closed.
</div>
{/if}

<div class="bc-field">
  <span class="bc-label">Memory</span>
  <div class="bc-row">
    <label class="bc-check">
      <input type="checkbox" checked={memoryOn} onchange={(ev) => setMemory(ev.currentTarget.checked)} />
      <span>Keeps its own memory</span>
    </label>
    {#if memoryFacts > 0}
      {#if onViewMemory}<button class="bc-btn" onclick={onViewMemory}>View {memoryFacts}</button>{/if}
      {#if onClearMemory}<button class="bc-btn danger" onclick={onClearMemory}>Clear</button>{/if}
    {/if}
  </div>
</div>
<div class="bc-hint">
  This is the bot's OWN store — the facts its <code>remember</code> tool writes, kept beside the definition and injected
  at the top of its turns. It is not the transcript: every chat this bot takes is saved in history like any other chat,
  toggle or no toggle.
  {memoryOn
    ? memoryFacts > 0
      ? `${memoryFacts} fact${memoryFacts === 1 ? '' : 's'} kept so far, newest first.`
      : 'Nothing kept yet.'
    : 'Off: the store is not read, and anything already in it stays on disk untouched.'}
</div>

<style>
  /* Deliberately the SAME metrics as CollabAgentForm.svelte's own `.ca-field` /
     `.ca-label` / `.ca-hint`: this component is mounted inside that form, and a
     second set of paddings would read as a different form pasted into the
     first. Named `bc-*` only so the two files' scoped styles cannot fight. */
  .bc-field { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
  .bc-label {
    flex: 0 0 82px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--og-text-muted);
  }
  /* The checklist under the two preset buttons: indented and quieter, so the
     stack reads as one decision with its detail rather than two rival choices. */
  .bc-sub { padding-left: 10px; opacity: 0.8; }
  .bc-row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  /* Which set this IS, beside the buttons that set it — so an adjusted preset
     says so where the adjustment was made, not only on the card. */
  .bc-count { font-size: 10px; color: var(--og-text-muted); font-style: italic; }
  .bc-note { font-size: 10px; color: var(--og-text-muted); }
  .bc-hint {
    padding: 2px 0 6px 90px;
    font-size: 10px;
    line-height: 1.5;
    color: var(--og-text-muted);
  }
  .bc-btn {
    font-size: 11px;
    padding: 4px 9px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
  }
  .bc-btn:hover { border-color: var(--og-chat); color: var(--og-text); }
  /* `.picked` went with the Worker/Observer buttons (W9): no button on this
     pane carries a chosen state any more — the ticks do. */
  .bc-btn.danger { color: var(--og-error-text); border-color: var(--og-error); }
  /* The scroll box, not the grid, carries the indent and the size limit: the
     grid itself stays a plain flex-wrap so its own rows never have to know
     they are inside a scroller. Sensible for ~5-6 rows of pills before the
     bar earns its keep — the catalog is engine-reported and only grows, and a
     flat inline block would otherwise push the persona box off the pane. */
  .bc-picks-scroll { max-height: 130px; overflow-y: auto; padding: 2px 4px 4px 90px; }
  /* The tool checklist. A dense wrap rather than one row per tool: the
     question here is "which of these are on", which a wrapped grid answers at
     a glance. */
  .bc-picks { display: flex; flex-wrap: wrap; gap: 3px 4px; }
  .bc-tool {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    padding: 2px 7px 2px 5px;
    background: transparent;
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 8px;
    cursor: pointer;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .bc-tool.picked { color: var(--og-text); border-color: var(--og-accent); background: color-mix(in srgb, var(--og-accent) 18%, transparent); }
  .bc-tool input { margin: 0; }
  .bc-also { margin-left: 3px; opacity: 0.6; }
  .bc-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--og-text); cursor: pointer; }
</style>
