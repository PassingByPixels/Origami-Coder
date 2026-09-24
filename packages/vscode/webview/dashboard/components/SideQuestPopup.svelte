<script lang="ts">
  // One side quest, read in full (t-f89g49) — SubagentMap.svelte's overlay
  // idiom: a scrim over the chat cell, Escape closes from anywhere, and it is
  // NON-BLOCKING in the sense that matters here — nothing in the engine, the
  // session or the turn is waiting on it. Closing it costs the owner nothing and
  // the quest stays exactly where it was.
  //
  // The reading order is the owner's triage order: what it is (title), why it is
  // worth a chat (summary), why the agent raised it (rationale, muted, because it
  // is the raiser's opinion and not a fact), and only then the brief itself,
  // behind a fold — instructions are for the agent that will do the work, not for
  // the person deciding whether it should be done.
  //
  // THE THREE ACTIONS ARE DESKTOP-ONLY. `phoneOnly` renders the row as a plain
  // sentence instead: the desk refuses all three for a phone by name
  // (remoteVerbsTable.ts), and three buttons that post a message the gate drops
  // would look like a bug at the far end.
  import type { SideQuest } from '../panes/sideQuestProps';

  interface Props {
    quest: SideQuest;
    /** True on the phone mount, where Start / Export / Dismiss are refused. */
    phoneOnly?: boolean;
    onStart: () => void;
    onExport: () => void;
    onDismiss: () => void;
    onClose: () => void;
  }
  let { quest, phoneOnly = false, onStart, onExport, onDismiss, onClose }: Props = $props();

  // Instructions shut by default — see the header. Local state: the popup is
  // built fresh every time a row is clicked, so there is nothing to remember.
  let showInstructions = $state(false);

  // Escape closes, from anywhere in the window, on SubagentMap.svelte's own
  // reasoning: the overlay covers the chat cell, so the key has nowhere else
  // useful to go while it is up.
  $effect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

<div class="sqp-scrim" role="dialog" aria-modal="false" aria-label="Suggested side quest {quest.id}">
  <div class="sqp-panel">
    <div class="sqp-head">
      <span class="sqp-head-text">Suggested side quest · {quest.id}</span>
      <button class="sqp-close" title="Close (Esc)" aria-label="Close this side quest" onclick={onClose}>&times;</button>
    </div>
    <div class="sqp-body">
      <h3 class="sqp-title">{quest.title}</h3>
      {#if quest.summary}<p class="sqp-summary">{quest.summary}</p>{/if}
      {#if quest.rationale}<p class="sqp-rationale">{quest.rationale}</p>{/if}
      <button class="sqp-fold" aria-expanded={showInstructions} onclick={() => (showInstructions = !showInstructions)}>
        <span aria-hidden="true">{showInstructions ? '▾' : '▸'}</span> Instructions
      </button>
      {#if showInstructions}<pre class="sqp-instructions">{quest.instructions}</pre>{/if}
    </div>
    <div class="sqp-actions">
      {#if phoneOnly}
        <span class="sqp-phone-note">Start, Export and Dismiss are available at the desk only.</span>
      {:else}
        <button class="sqp-btn sqp-primary" onclick={onStart}>Start in a new session</button>
        <button class="sqp-btn" onclick={onExport}>Export</button>
        <button class="sqp-btn" onclick={onDismiss}>Dismiss</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .sqp-scrim {
    position: absolute; inset: 0; z-index: 14;
    display: flex; align-items: center; justify-content: center;
    /* Literal rgba, on SubagentMap.svelte's precedent: no --og-* scrim var. */
    background: rgba(0, 0, 0, 0.55);
  }
  /* 94% of the cell, so the panel still fits a 390px phone mount with the
     16px gutter the remote page keeps. */
  .sqp-panel {
    display: flex; flex-direction: column; min-height: 0;
    width: min(440px, 94%); max-height: 88%;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-radius: 8px;
    box-shadow: 0 10px 34px rgba(0, 0, 0, 0.5);
  }
  .sqp-head { display: flex; align-items: baseline; gap: 8px; flex: 0 0 auto; padding: 8px 10px; border-bottom: 1px solid var(--og-border); }
  .sqp-head-text { flex: 1 1 auto; font-size: 10px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--og-text-muted); }
  .sqp-close { flex: 0 0 auto; background: none; border: none; color: var(--og-text-muted); cursor: pointer; font-size: 15px; line-height: 1; padding: 0 3px; border-radius: 3px; font-family: inherit; }
  .sqp-close:hover { color: var(--og-text); background: var(--og-btn-bg); }

  .sqp-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 9px 10px; }
  .sqp-title { margin: 0 0 6px; font-size: 12.5px; font-weight: 600; color: var(--og-text); }
  .sqp-summary { margin: 0 0 6px; font-size: 11px; line-height: 1.45; color: var(--og-text-secondary); }
  .sqp-rationale { margin: 0 0 8px; font-size: 10px; line-height: 1.45; color: var(--og-text-muted); }
  .sqp-fold {
    display: inline-flex; align-items: center; gap: 4px;
    background: transparent; border: none; padding: 0;
    color: var(--og-text-secondary); cursor: pointer; font-family: inherit; font-size: 10px;
  }
  .sqp-fold:hover { color: var(--og-text); }
  /* `pre`, not a paragraph: the brief is what a fresh agent is handed verbatim,
     so its own line breaks are part of it. It wraps rather than scrolling
     sideways — a horizontal scrollbar at 390px hides the end of every line. */
  .sqp-instructions {
    margin: 6px 0 0;
    padding: 7px 8px;
    font-size: 10px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--og-text);
    background: var(--og-input-bg);
    border: 1px solid var(--og-border);
    border-radius: 5px;
  }

  .sqp-actions { display: flex; flex-wrap: wrap; gap: 5px; flex: 0 0 auto; padding: 8px 10px; border-top: 1px solid var(--og-border); }
  .sqp-btn {
    padding: 4px 9px;
    font-size: 10px;
    font-family: inherit;
    color: var(--og-text-secondary);
    background: var(--og-input-bg);
    border: 1px solid var(--og-border);
    border-radius: 4px;
    cursor: pointer;
  }
  .sqp-btn:hover { color: var(--og-text); border-color: var(--og-accent); }
  .sqp-primary { color: var(--og-text); border-color: var(--og-accent); }
  .sqp-phone-note { font-size: 9.5px; color: var(--og-text-muted); }
</style>
