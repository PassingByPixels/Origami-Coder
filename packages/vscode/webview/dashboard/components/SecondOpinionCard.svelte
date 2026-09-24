<script lang="ts">
  // SECOND OPINION — one transcript row: another model's review of the turn
  // above it, with an action rail to hand the chat to it or dismiss it.
  // The body renders through MessageRow, the one place in this webview that
  // renders markdown, so no second renderer can drift from it.
  // "Hand chat to X" reuses the model picker's own `setModel` message, with
  // the model pre-chosen — there is no second switching path.
  //
  // Accept and dismiss are terminal and mutually exclusive. The resolution is
  // written onto the message (info.resolution, a deep $state proxy of the
  // pane's own row), so a re-render rebuilds the card already resolved. The
  // local `resolution` mirror exists because a plain (non-proxy) `info` — the
  // test harness, a replayed transcript — is not reactive to that write.
  //
  // Dismiss is local and reversible: it collapses to a stub that reopens, and
  // never touches the message list. Accept's stub only expands to re-read the
  // review; the decision is made, so no action rail comes back.
  import MessageRow from './MessageRow.svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { cardActions, formatElapsed } from './secondOpinionCard';
  import type { SecondOpinionInfo } from '../panes/chatMessage';

  interface Props {
    /** Which model, which stage, and the failure wording when it failed. */
    info: SecondOpinionInfo;
    /** The review itself. Empty until the answer lands. */
    text: string;
    /** The chat the hand-over would act on. */
    sessionId: string;
    /** History (a stored sub-agent transcript) kills the hand-over: it would
     *  change a live session's model. Dismiss stays; collapsing acts on nothing. */
    readOnly?: boolean;
  }
  let { info, text, sessionId, readOnly = false }: Props = $props();

  // Seeds from the message once per mount, on purpose (not a lost reactivity bug).
  // svelte-ignore state_referenced_locally
  let resolution = $state(info.resolution);
  /** The handed stub, clicked open to re-read the review. Session-local on
   *  purpose: the RESOLUTION persists, how far it is unfolded need not. */
  let reopened = $state(false);
  const vscode = getVsCodeApi();

  const title = $derived(`Second opinion — ${info.modelLabel}`);
  const actions = $derived(cardActions(info.state, resolution, readOnly));

  function resolve(next: SecondOpinionInfo['resolution']) {
    resolution = next;
    info.resolution = next; // onto the message — survives a re-render
  }

  function handOver() {
    vscode.postMessage({ type: 'setModel', modelId: info.modelId, sessionId });
    resolve('handed');
  }

  // The pending ticker — webview-local (the wire carries no start time), torn
  // down the moment the answer lands or the card unmounts.
  let seconds = $state(0);
  $effect(() => {
    if (info.state !== 'pending') return;
    const startedAt = Date.now();
    const tickId = setInterval(() => { seconds = Math.floor((Date.now() - startedAt) / 1000); }, 1000);
    return () => clearInterval(tickId);
  });
</script>

{#if resolution === 'dismissed'}
  <button class="so-stub" title="Show this second opinion again" onclick={() => resolve(undefined)}>
    {title} — dismissed
  </button>
{:else if resolution === 'handed' && !reopened}
  <button class="so-stub so-handed" title="Read the second opinion again (the chat already switched)" onclick={() => (reopened = true)}>
    Handed to {info.modelLabel} — second opinion
  </button>
{:else}
  <div class="so-card" class:failed={info.state === 'error'}>
    {#if resolution === 'handed'}
      <!-- Re-reading a resolved review: the header collapses it back, and no
           action rail exists in this branch at all — the decision is made. -->
      <button class="so-stub so-handed" title="Collapse this second opinion again" onclick={() => (reopened = false)}>
        Handed to {info.modelLabel} — second opinion
      </button>
    {/if}
    {#if info.state === 'ok'}
      <MessageRow kind="agent" label={title} {text} />
      {#if info.attribution}
        <!-- Attribution sits under the answer, not in the header: the reader needs
             it while weighing the content; above unread text it reads as boilerplate. -->
        <p class="so-sub">{info.attribution}</p>
      {/if}
    {:else}
      <div class="so-head">
        <span class="so-chip">{title}</span>
        {#if info.state === 'pending'}
          <span class="so-wait">is reviewing the last turn…</span>
          <span class="so-elapsed">{formatElapsed(seconds)}</span>
        {/if}
      </div>
      {#if info.state === 'pending'}
      <!-- Honest limits: this is one tool-less generation, not a sub-agent
           with checks. Say so before the answer lands, and if it cannot see diffs. -->
        <p class="so-sub">{info.attribution || 'single review pass, no tools'}</p>
      {/if}
      {#if info.state === 'error'}
        <p class="so-failed">{info.error || 'The review did not come back.'}</p>
      {/if}
    {/if}

    {#if actions.hand || actions.dismiss}
      <div class="so-actions">
        {#if actions.hand}
          <button class="so-hand" onclick={handOver} title="Run the rest of this chat on {info.modelLabel}">
            Hand chat to {info.modelLabel}
          </button>
        {/if}
        {#if actions.dismiss}
          <button class="so-dismiss" onclick={() => resolve('dismissed')} title="Collapse this card (it stays in the transcript)">
            Dismiss
          </button>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* An accent-edged block rather than another bubble: it has to read as a
     judgement ON the transcript, not as one more turn in it. */
  .so-card {
    margin: 8px 0 10px 0;
    padding: 6px 8px;
    border: 1px solid var(--og-border);
    border-left: 3px solid var(--og-accent);
    border-radius: 6px;
    background: var(--og-surface);
  }
  .so-card.failed { border-left-color: var(--og-error); }

  .so-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 11px;
  }
  .so-chip { color: var(--og-accent); font-weight: 600; }
  .so-wait { color: var(--og-text-muted); font-style: italic; }
  /* Monospace so the tick does not wobble the row width every second. */
  .so-elapsed { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--og-text-muted); }

  .so-sub {
    margin: 3px 0 0 0;
    font-size: 10px;
    color: var(--og-text-muted);
  }

  .so-failed {
    margin: 4px 0 0 0;
    font-size: 11px;
    color: var(--og-error-text);
  }

  .so-actions {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  .so-hand, .so-dismiss {
    font: inherit;
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
  }
  /* Only the hand-over is emphasised: it is the one control here that changes
     what the chat does next. */
  .so-hand { color: var(--og-text); border-color: var(--og-accent); }
  .so-hand:hover, .so-dismiss:hover { background: var(--og-btn-hover); color: var(--og-text); }
  .so-hand:focus-visible, .so-dismiss:focus-visible, .so-stub:focus-visible {
    outline: 1px solid var(--og-chat);
    outline-offset: 1px;
  }

  /* The collapsed forms (dismissed / handed). A button, not a div: clicking one
     brings the review back, so it must be reachable by keyboard like anything
     else that acts. */
  .so-stub {
    display: block;
    margin: 4px 0;
    padding: 2px 6px;
    font: inherit;
    font-size: 10px;
    text-align: left;
    color: var(--og-text-muted);
    background: transparent;
    border: 1px dashed var(--og-border);
    border-radius: 4px;
    cursor: pointer;
  }
  .so-stub:hover { color: var(--og-text-secondary); border-color: var(--og-accent); }
  /* The handed stub keeps the accent: it records a decision, not a shrug. */
  .so-handed { border-style: solid; border-left: 3px solid var(--og-accent); }
</style>
