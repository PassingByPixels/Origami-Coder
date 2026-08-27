<script lang="ts">
  // The agent-def EDITOR, extracted from CollabAgentsPane.svelte (378/380, two
  // lines of slack) when the Agents board grew its Collab / Vision sub-nav
  // (t-kgtr6c — a third tab, SubAgents, shipped in round 2 and was removed in
  // round 3). The pane's job is now the tabs and the lists; the form is one job
  // and it is this file's.
  //
  // The extraction paid for itself immediately: the Vision tab needs the SAME
  // form — name, description, model, glyph, persona — so a vision profile is
  // edited by this component in `kind="vision"` rather than by a second,
  // drifting copy of it.
  //
  // What `kind` changes, and why each one:
  //  - the PERMISSION presets are hidden for a profile. A profile is only ever
  //    prompted with one image and one question; it has no workspace turn to
  //    have permissions in, and since round 4 the engine sends that prompt as a
  //    direct completion with NO tools on it (tool/vision-request.ts), so there
  //    is nothing a permission could allow or deny. Showing the Worker/Observer
  //    choice would offer a decision that changes nothing.
  //  - the VISION checkbox is hidden for a profile and its value forced on: a
  //    profile that cannot be shown pixels is the one def where the default
  //    would be silently useless.
  //  - the MODEL becomes required-in-practice, and the hint says so. An unpinned
  //    profile would run on the chat's own model — the blind one — and return a
  //    confident description of an image it never received.
  import AgentModelSelect from './AgentModelSelect.svelte';
  import BotContractFields from './BotContractFields.svelte';
  import CollabGlyphPicker from './CollabGlyphPicker.svelte';
  import { glyphKeys } from './archetypeGlyphs';
  import { modelHint } from './botContractView';
  import { personaSeed } from './collabPersonaSeed';
  import { visionPersonaSeed } from './visionPersonaSeed';
  import { presetOfTools } from '../../../src/dashboard/botTools';
  import type { CollabAgentDef } from '../../../src/dashboard/collabAgentCrud';

  interface ModelOpt { value: string; name: string }
  interface ProviderStat { id: string; name: string; live: boolean; flavor?: 'lmstudio' | 'ollama' | 'other' }

  let {
    draft = $bindable(),
    creating,
    kind = 'collab',
    modelOptions,
    providerStatus,
    toolCatalog = [],
    memoryFacts = 0,
    onSave,
    onCancel,
    onViewMemory,
    onClearMemory,
  }: {
    draft: CollabAgentDef;
    creating: boolean;
    kind?: 'collab' | 'vision';
    modelOptions: ModelOpt[];
    providerStatus: ProviderStat[];
    /** Live `list_tools` ids for the tool checklist; [] falls back to the
     *  shipped mirror, which writes exactly the same permission block. */
    toolCatalog?: string[];
    memoryFacts?: number;
    onSave: () => void;
    onCancel: () => void;
    onViewMemory?: () => void;
    onClearMemory?: () => void;
  } = $props();

  // DERIVED from the glyph table (W9). The literal it replaces had already lost
  // `scout` — drawn, shipped, offered by nothing — and W9 drew twenty-six more.
  const GLYPH_KEYS = glyphKeys();
  const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

  /** True once the user has typed in the persona box. While it is false the
   *  seed may be re-derived (the preset changed, the name changed); once it is
   *  true NOTHING may write that box again. */
  let personaTouched = $state(false);

  const slugBad = $derived(creating && !SLUG_RE.test(draft.slug));

  /**
   * Re-derive the persona seed. Guarded twice, and both guards are the feature:
   *  - `!creating`: an EXISTING def's body is the user's own text, whatever it
   *    says — including empty, which is a choice they already made. Seeding
   *    over it would rewrite a file they only opened to change a model.
   *  - `personaTouched`: once they have typed, the box is theirs.
   *
   * FOLLOWS THE NAME AND NOTHING ELSE since W9 (one seed, not one per preset).
   */
  function reseed() {
    if (!creating || personaTouched) return;
    // A PROFILE takes its own seed (t-kgtr6c round 3). Round 2 sent it through
    // the collab seed with `preset: 'observer'`, so every new profile was born
    // telling itself it was "a reviewer in this collab" — the opposite of the
    // one thing it is for.
    draft.persona = kind === 'vision' ? visionPersonaSeed(draft.slug) : personaSeed(draft.slug);
  }

  /** WHICH PRESET THE TICKS ARE — a READING of the tick set, not a second field
   *  that could disagree with it. Still computed because two things downstream
   *  need it: the step budget the serializer writes, and the persona seed. */
  const preset = $derived(draft.tools ? presetOfTools(draft.tools) : (draft.preset ?? 'worker'));

  // Ticking still drops the file's own `steps:`, so the budget the new set
  // implies applies again (the serializer resolves it from the preset a tick set
  // reads as). It no longer reseeds the persona: W9 left one seed, and it
  // follows the NAME. `lastPreset` is initialised from the def as OPENED so the
  // settle on mount is not read as a change — clearing `steps:` there would drop
  // a budget the file states, on an edit that never mentioned it.
  let lastPreset = $state(draft.tools ? presetOfTools(draft.tools) : (draft.preset ?? 'worker'));
  $effect(() => {
    draft.preset = preset;
    if (preset === lastPreset) return;
    lastPreset = preset;
    draft.steps = '';
  });

  // Seed at MOUNT: opening the create form IS the moment the offer is made, and
  // before the extraction this ran inside the pane's startNew(). The pane KEYS
  // this component on which def is open, so every fresh open is a fresh mount
  // and a fresh seed — deliberately not an $effect, which would also re-run on
  // an unrelated prop change and write over a body the user had already typed.
  if (creating) reseed();
</script>

<div class="ca-form">
  <label class="ca-field">
    <span class="ca-label">Name</span>
    <!-- Written by hand rather than with bind:value so the seed re-derives
         from the value THIS event carries. With a bind plus a second
         listener the order of the two decides whether the seed sees the new
         name or the previous one, and a seed that lags the box by one
         keystroke is the kind of bug nobody reports, they just retype. -->
    <input class="ca-input" value={draft.slug} disabled={!creating}
      oninput={(ev) => { draft.slug = ev.currentTarget.value; reseed(); }}
      placeholder={kind === 'vision' ? 'vision-…' : 'collab-…'} aria-label="Agent name" />
  </label>
  <div class="ca-hint" class:bad={slugBad}>
    {slugBad
      ? 'Lowercase letters, digits, - and _ only; must start with a letter or digit.'
      : creating
        ? 'This is the filename and the @mention handle. It cannot be changed later.'
        : 'The name is fixed — delete and recreate to rename.'}
  </div>

  <label class="ca-field">
    <span class="ca-label">Description</span>
    <input class="ca-input" bind:value={draft.description} required aria-label="Description" placeholder="What this agent is for — the model reads this to decide when to use it" />
  </label>

  <div class="ca-field">
    <span class="ca-label">Model</span>
    <AgentModelSelect
      options={modelOptions}
      providerStatus={providerStatus}
      value={draft.model}
      onchange={(v) => (draft.model = v)}
      placeholder={kind === 'vision' ? 'Pick a model that can see' : 'No pinned model'}
      compact={true}
    />
  </div>
  <!-- The WORDS live in botContractView.ts beside `modelWarning`, which says the
       same thing on the card: one module for both, so they cannot drift. -->
  <div class="ca-hint" class:bad={kind === 'vision' && !draft.model}>{modelHint(kind, draft.model)}</div>

  <!-- PERMISSIONS (the tool checklist) and MEMORY. Its own component because
       this form was at 264 of its 280 cap; and because the two belong together:
       they are what turns a definition into a character that is ready to work.
       HIDDEN for a vision profile, which takes no turn at all: it is prompted
       with one image and one question through a direct completion with NO tools
       on it (tool/vision-request.ts), so every control here would offer a
       decision that changes nothing. -->
  {#if kind === 'collab'}
    <BotContractFields bind:bot={draft.bot} bind:tools={draft.tools} {preset}
      handTuned={!draft.tools && !!draft.customPermission}
      {toolCatalog} {memoryFacts} {onViewMemory} {onClearMemory} />
  {/if}

  <div class="ca-field">
    <span class="ca-label">Glyph</span>
    <CollabGlyphPicker value={draft.glyph} keys={GLYPH_KEYS}
      letter={(draft.slug.replace(/^(collab|vision)-/, '')[0] ?? '?').toUpperCase()}
      onchange={(g) => (draft.glyph = g)} />
  </div>

  {#if kind === 'collab'}
    <div class="ca-field">
      <span class="ca-label">Vision</span>
      <label class="ca-check">
        <input type="checkbox" checked={!!draft.vision} onchange={(ev) => (draft.vision = ev.currentTarget.checked)} />
        <span>Vision capable</span>
      </label>
    </div>
    <div class="ca-hint">
      {draft.vision
        ? 'Images posted to the room reach this agent as real picture data. Only tick it for a model that can actually see.'
        : 'Off: an image reaches this agent as a note saying one was attached, never the picture itself.'}
    </div>
  {/if}

  <label class="ca-field col">
    <span class="ca-label">Persona</span>
    <textarea class="ca-text" rows="8" bind:value={draft.persona}
      oninput={() => (personaTouched = true)} aria-label="Persona"></textarea>
  </label>
  <div class="ca-hint">
    {kind === 'vision'
      ? 'The whole instruction this profile runs on. It is shown one image and one question and answers once; every request already tells it to describe what it sees rather than judge it, so this box only has to add what you want on top.'
      : creating && !personaTouched
        ? 'A starting point, not a rule — edit it freely. Until you do, it follows the name above.'
        : 'Just the role. This bot may run alone in a chat, in a room, or as another agent’s sub-agent, and the persona is the one thing that travels to all three — so keep room protocol out of it; the runner injects that at turn time.'}
  </div>

  <div class="ca-actions">
    <button class="ca-btn primary" onclick={onSave} disabled={slugBad || !draft.slug || !draft.description.trim()}>Save</button>
    <button class="ca-btn" onclick={onCancel}>Cancel</button>
  </div>
</div>

<style>
  .ca-form {
    margin: 0 12px 10px;
    padding: 10px;
    border: 1px solid var(--og-border);
    border-radius: 6px;
    background: var(--og-surface);
  }
  .ca-field { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
  .ca-field.col { align-items: flex-start; }
  .ca-label {
    flex: 0 0 82px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--og-text-muted);
  }
  .ca-input, .ca-text {
    flex: 1 1 auto;
    min-width: 0;
    font: inherit;
    font-size: 12px;
    color: var(--og-text);
    background: var(--og-btn-bg);
    border: 1px solid var(--og-border);
    border-radius: 4px;
    padding: 5px 8px;
    outline: none;
  }
  .ca-input:focus, .ca-text:focus { border-color: var(--og-accent); }
  .ca-input:disabled { opacity: 0.6; }
  .ca-text { resize: vertical; line-height: 1.5; }
  .ca-hint {
    padding: 2px 0 6px 90px;
    font-size: 10px;
    line-height: 1.5;
    color: var(--og-text-muted);
  }
  .ca-hint.bad { color: var(--og-error-text); }

  .ca-btn {
    font-size: 11px;
    padding: 4px 9px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
  }
  .ca-btn:hover { border-color: var(--og-chat); color: var(--og-text); }
  .ca-btn.primary { color: var(--og-text); border-color: var(--og-chat); }
  .ca-btn.picked { color: var(--og-text); border-color: var(--og-accent); background: color-mix(in srgb, var(--og-accent) 18%, transparent); }
  .ca-btn:disabled { opacity: 0.45; cursor: default; border-color: var(--og-border); }

  /* The Worker/Observer row moved into BotContractFields.svelte with the rest
     of the permissions section, and `.ca-glyphs` went with it. The glyph
     BUTTONS live in CollabGlyphPicker.svelte with their own markup. */
  .ca-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--og-text); cursor: pointer; }

  .ca-actions { display: flex; gap: 6px; padding-top: 6px; }
</style>
