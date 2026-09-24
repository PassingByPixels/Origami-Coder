<script lang="ts">
  // The SECOND OPINION flyout — pick the model that reviews this turn.
  //
  // SELF-CONTAINED given `sessionId`, on ModelPicker.svelte's own precedent and
  // for the same reason: it subscribes to the SAME broadcasts the picker and the
  // sidebar consume (`modelOptions`, `sessionModels`, `providerStatus`), which
  // all fan out to this webview anyway. Threading the catalogue down from
  // ChatPane would have cost that pane — 2418 of a 2420-line cap — a prop chain
  // through InputBar and ChangesPill to deliver data already arriving here.
  //
  // In grid mode every cell mounts its own composer, so the listener lives in
  // onMount with a cleanup: closed cells must not leak dead listeners.
  //
  // SHAPE (0.4.67 UAT: the flat list was too long): tier headings — the SAME
  // sections the connections picker and ModelPicker use — over provider rows
  // that render COLLAPSED (name + model count; click expands). Expansion is
  // per-open on purpose: the menu mounts fresh each time, and a remembered
  // sprawl would put the long list right back. Typing in the filter bypasses
  // the tree entirely: a query names a MODEL, so the answer is ranked model
  // rows, flat.
  //
  // WHICH models it offers — and every decision above (tiering, collapse
  // counts, ranking) — is secondOpinionModels.ts, a pure leaf, including the
  // rule this menu exists to enforce: the chat's OWN model is not on the list.
  // That rule is asserted with nothing rendered, because "is the current model
  // absent" is a question a DOM query answers weakly (a row that failed to
  // render for an unrelated reason passes it too).
  import { onMount } from 'svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { reviewerModels } from './secondOpinionModels';

  interface Props {
    /** The chat this review is for. Picks that chat's current model out. */
    sessionId: string;
    /** A model was chosen — the row reports it up and closes itself. */
    onPick: (modelId: string, modelLabel: string) => void;
    onClose: () => void;
  }
  let { sessionId, onPick, onClose }: Props = $props();

  const vscode = getVsCodeApi();
  let modelOptions = $state<Array<{ value: string; name: string }>>([]);
  let modelBySession = $state<Record<string, string>>({});
  let providerStatus = $state<Array<{ id: string; baseURL?: string }>>([]);
  let filter = $state('');
  /** Which provider groups are open. Reassigned, never mutated — a plain
   *  record keeps the toggle a one-liner. */
  let expanded = $state<Record<string, boolean>>({});

  const current = $derived(modelBySession[sessionId] ?? '');
  const list = $derived(reviewerModels({ modelOptions, currentModel: current, filter, providerStatus }));

  onMount(() => {
    const onMsg = (event: MessageEvent) => {
      const msg = event.data || {};
      if (msg.type === 'modelOptions') modelOptions = Array.isArray(msg.options) ? msg.options : [];
      else if (msg.type === 'sessionModels') modelBySession = msg.models && typeof msg.models === 'object' ? msg.models : {};
      else if (msg.type === 'providerStatus') providerStatus = Array.isArray(msg.providers) ? msg.providers : [];
    };
    window.addEventListener('message', onMsg);
    // Pull fresh lists on open — the menu only ever mounts when it opens, so
    // this is the "on open" refresh ModelPicker.openMenu does explicitly.
    vscode.postMessage({ type: 'requestModels' });
    vscode.postMessage({ type: 'requestSessionModels' });
    vscode.postMessage({ type: 'requestProviderStatus' });
    return () => window.removeEventListener('message', onMsg);
  });
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<!-- Full-screen transparent catcher, the idiom ModelPicker's .mp-backdrop and
     ChangesPill's .cp-backdrop both use: any click outside closes the menu. -->
<button class="so-backdrop" aria-label="Close second opinion menu" onclick={onClose}></button>
<div class="so-menu" role="dialog" aria-label="Pick a model for a second opinion">
  <p class="so-lede">Have another model review the last completed turn. It can read the work; it cannot change anything.</p>
  <input
    class="so-filter"
    type="text"
    bind:value={filter}
    placeholder="Filter models…"
    spellcheck="false"
    autocomplete="off"
    aria-label="Filter models"
  />
  <div class="so-list" role="listbox" aria-label="Reviewing model">
    {#if list.searching}
      {#each list.matches as model (model.value)}
        <button class="so-model" role="option" aria-selected="false" title={model.value} onclick={() => onPick(model.value, model.name)}>
          {model.name}
        </button>
      {:else}
        <p class="so-empty">No other model matches your filter.</p>
      {/each}
    {:else}
      {#each list.tiers as tierGroup (tierGroup.tier)}
        <div class="so-tier">{tierGroup.label}</div>
        {#each tierGroup.providers as group (group.provider)}
          <button
            class="so-provider"
            aria-expanded={!!expanded[group.provider]}
            title={expanded[group.provider] ? `Collapse ${group.provider}` : `Show ${group.provider}'s ${group.count} models`}
            onclick={() => (expanded = { ...expanded, [group.provider]: !expanded[group.provider] })}
          >
            <span class="so-caret" aria-hidden="true">{expanded[group.provider] ? '▾' : '▸'}</span>
            <span class="so-provider-name">{group.provider}</span>
            <span class="so-count">{group.count}</span>
          </button>
          {#if expanded[group.provider]}
            {#each group.models as model (model.value)}
              <button class="so-model" role="option" aria-selected="false" title={model.value} onclick={() => onPick(model.value, model.name)}>
                {model.name}
              </button>
            {/each}
            {#if group.count > group.models.length}
              <p class="so-hint">Showing {group.models.length} of {group.count} — filter to narrow.</p>
            {/if}
          {/if}
        {/each}
      {:else}
        <p class="so-empty">
          {#if current}No other model is configured — add one in the Origami sidebar.
          {:else}No models are configured yet — add one in the Origami sidebar.{/if}
        </p>
      {/each}
    {/if}
  </div>
  {#if list.total > list.shown}
    <span class="so-hint">Showing {list.shown} of {list.total} — filter to narrow.</span>
  {/if}
  {#if current}
    <span class="so-hint">This chat runs {current} — it is not on the list, because it cannot second-guess itself.</span>
  {/if}
</div>

<style>
  .so-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
    cursor: default;
  }
  /* ABOVE the row (the input box is below it, and a list dropping over the
     textarea would cover what the user is typing), right-aligned because the
     button that opens it sits at the right-hand end. Capped and scrolled: a
     configured catalogue runs to dozens and the composer must not grow with it. */
  .so-menu {
    position: absolute;
    bottom: calc(100% + 4px);
    right: 0;
    z-index: 41;
    width: 320px;
    max-width: 100%;
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 8px;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-radius: 8px;
    /* The composer's own drop shadow, verbatim from ModelPicker/ChangesPill. A
       shadow is opacity over whatever is behind it, not a themed surface, and
       there is no --og-* shadow var; a composer popover that alone had none
       would read as a bug. */
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
  }

  .so-lede { margin: 0; font-size: 10px; line-height: 1.35; color: var(--og-text-muted); }

  .so-filter {
    width: 100%;
    box-sizing: border-box;
    padding: 4px 7px;
    font-size: 11px;
    font-family: inherit;
    color: var(--og-text);
    background: var(--og-input-bg);
    border: 1px solid var(--og-input-border);
    border-radius: 5px;
    outline: none;
  }
  .so-filter:focus { border-color: var(--og-chat); }

  .so-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-height: 240px;
    overflow-y: auto;
  }
  .so-tier {
    padding: 4px 6px 1px 6px;
    font-size: 9.5px;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: var(--og-text-muted);
  }
  /* A provider header is a CONTROL now, not a label — it opens its group. */
  .so-provider {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    padding: 3px 6px;
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    text-align: left;
    color: var(--og-text-secondary);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 5px;
    cursor: pointer;
  }
  .so-provider:hover { background: var(--og-btn-bg); color: var(--og-text); }
  .so-provider[aria-expanded='true'] { color: var(--og-text); }
  .so-caret { flex-shrink: 0; font-size: 9px; color: var(--og-chat); }
  .so-provider-name { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .so-count {
    flex-shrink: 0;
    font-size: 9.5px;
    font-weight: 400;
    padding: 0 5px;
    border-radius: 6px;
    color: var(--og-text-muted);
    border: 1px solid var(--og-border);
  }
  .so-model {
    width: 100%;
    padding: 4px 6px 4px 18px; /* indented under its provider header */
    font: inherit;
    font-size: 11.5px;
    text-align: left;
    color: var(--og-text-secondary);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 5px;
    cursor: pointer;
    overflow-wrap: anywhere;
  }
  .so-model:hover { background: var(--og-btn-bg); color: var(--og-text); }
  .so-model:focus-visible, .so-provider:focus-visible { outline: 1px solid var(--og-chat); outline-offset: 1px; }

  .so-empty, .so-hint {
    margin: 0;
    padding: 4px 6px;
    font-size: 10px;
    line-height: 1.35;
    color: var(--og-text-muted);
  }
</style>
