<script lang="ts">
  // The collab's standing objective, EDITABLE IN PLACE. Extracted from
  // CollabControls.svelte at X2 so report 1.5's click target could land: the
  // objective was read-only there, with `/objective <text>` in the composer as
  // its only writer, and an UNSET objective drew no row at all — so the state
  // that most needed the control had none.
  //
  // Enter commits, Escape cancels — the same two keys the New-collab title and
  // the chat rename use, so there is one text-entry idiom in this product.
  //
  // A BLANK edit closes the editor and sends NOTHING, mirroring
  // CollabCreateForm's "an empty title CLOSES the form": an empty objective and
  // no objective are the same absence, and `/objective` refuses a blank
  // argument anyway (collabSlash.ts).
  //
  // The draft is seeded from the prop at OPEN and is thrown away on cancel, so
  // an abandoned edit cannot come back the next time the editor opens. Nothing
  // is spliced in on commit either — the engine owns the value and the pane's
  // next poll paints it, so a refused change cannot leave new text on screen.
  interface Props {
    objective?: string | null;
    /** An archived room takes no more writes, so it gets no editor. */
    archived: boolean;
    onSetObjective: (text: string) => void;
  }
  let { objective = null, archived, onSetObjective }: Props = $props();

  let editing = $state(false);
  let draft = $state('');

  function open() {
    draft = objective ?? '';
    editing = true;
  }
  function commit() {
    const text = draft.trim();
    editing = false;
    if (text) onSetObjective(text);
  }
  function key(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); editing = false; }
  }
  function focusOnMount(node: HTMLInputElement) { node.focus(); node.select(); }
</script>

<div class="objective-row">
  <span class="objective-label">Objective</span>
  {#if editing}
    <input
      class="objective-input"
      bind:value={draft}
      use:focusOnMount
      onkeydown={key}
      onblur={commit}
      placeholder="What this room is for"
      aria-label="Collab objective" />
  {:else}
    {#if objective}
      <span class="objective-text">{objective}</span>
    {:else}
      <span class="objective-none">none set</span>
    {/if}
    {#if !archived}
      <button
        class="objective-edit"
        onclick={open}
        title="Set the collab's standing objective"
        aria-label={objective ? 'Edit the objective' : 'Set an objective'}
      >{objective ? 'Edit' : 'Set'}</button>
    {/if}
  {/if}
</div>

<style>
  .objective-row {
    display: flex;
    align-items: baseline;
    gap: 7px;
    padding: 4px 12px;
    border-bottom: 1px solid var(--og-border);
    flex-shrink: 0;
    font-size: 11px;
  }
  .objective-label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--og-text-muted);
    flex: 0 0 auto;
  }
  .objective-text { color: var(--og-text-secondary); overflow-wrap: anywhere; }
  .objective-none { color: var(--og-text-muted); font-style: italic; }
  .objective-edit {
    margin-left: auto;
    flex: 0 0 auto;
    font-size: 9px;
    padding: 1px 7px;
    border-radius: 999px;
    border: 1px solid var(--og-border);
    background: transparent;
    color: var(--og-text-muted);
    cursor: pointer;
    font-family: inherit;
  }
  .objective-edit:hover { border-color: var(--og-accent); color: var(--og-accent); }
  .objective-input {
    flex: 1 1 auto;
    min-width: 0;
    font: inherit;
    font-size: 11px;
    color: var(--og-text);
    background: var(--og-btn-bg);
    border: 1px solid var(--og-accent);
    border-radius: 4px;
    padding: 2px 8px;
    outline: none;
  }
</style>
