<script lang="ts">
  // ONE model row in the picker's tier-2 list: the tick, the provider/name
  // label, the quant chip, the "already loaded" chip — and the VISION chip.
  //
  // EXTRACTED, not written in place. ModelPicker.svelte sat at 608 of its 610
  // cap, and the vision chip needs markup, a second click target and a block of
  // its own CSS. The row is the honest seam: the menu is a container (which
  // provider, which target, which filter) and the row is a rendering of one
  // model, and only the second of those grew. The row's whole styling came with
  // it — a chip whose colours lived in a different file from its markup is the
  // arrangement that produced `var(--og-green, #4caf50)` elsewhere in this
  // codebase.
  //
  // TWO CLICK TARGETS, NOT ONE. The chip is a sibling of the select button, not
  // a child of it: a button inside a button is invalid HTML, and the two mean
  // genuinely different things — one switches this chat's model, the other
  // changes a fact about a model the user may have no intention of switching to.
  // `.mp-row` carries the hover and current-model border so they still read as a
  // single row. The chip stops the click from propagating anyway, because the
  // wrapper is where a future "click anywhere on the row" would land.
  //
  // A LEAF: it posts nothing. ModelPicker owns the wire (it holds `sessionId`),
  // exactly as it already does for the context-length prompt beside this.

  import { parseModelId } from './modelLabel';

  let { value, name, current = false, loaded = false, visionState = '', onSelect, onVision }: {
    value: string;
    name: string;
    /** This chat's currently selected model. */
    current?: boolean;
    /** Already held by the server — picking it costs no reload. */
    loaded?: boolean;
    /** `auto-on` | `auto-off` | `on` | `off`, from the host's per-row read
     *  (visionPin.ts's VisionState). '' = an older host that does not send one,
     *  which draws no chip rather than a wrong one. */
    visionState?: string;
    onSelect: (value: string) => void;
    /** Toggle the vision PIN for this row's model: On <-> Auto. */
    onVision: (value: string) => void;
  } = $props();

  const lbl = $derived(parseModelId(value, name));
  const sees = $derived(visionState === 'on' || visionState === 'auto-on');
  const pinned = $derived(visionState === 'on' || visionState === 'off');
  const chipTitle = $derived(
    // The SOURCE is the whole point of the chip: "this model sees" and "you told
    // me this model sees" are different claims, and only one of them survives
    // the next detection pass.
    (sees
      ? pinned ? 'Vision: on — pinned by you. ' : 'Vision: on — engine-detected. '
      : pinned ? 'Vision: off — pinned by you. ' : 'Vision: off — nothing detected. ') +
      (visionState === 'on'
        ? 'Click to hand it back to Auto.'
        : 'Click to pin this model as able to read images. Applies from your next message.'),
  );

  function vision(e: MouseEvent) {
    // The row selects a model; the chip does not. Without this, every chip click
    // would also switch this chat's model to the row it was on.
    e.stopPropagation();
    onVision(value);
  }
</script>

<div class="mp-row" class:current role="presentation">
  <button
    class="mp-model"
    role="option"
    aria-selected={current}
    onclick={() => onSelect(value)}
    title={value}
  >
    <span class="mp-check" aria-hidden="true">{current ? '✓' : ''}</span>
    <span class="mp-model-label">
      {#if lbl.provider}<span class="mp-model-provider">{lbl.provider}</span>{/if}
      <span class="mp-model-name">{lbl.name}</span>
    </span>
    <!-- These two stay INSIDE the select button: they are labels, not controls,
         and a click on either should still pick the model. Only the vision chip
         below leaves, because it is the one that does something else. -->
    {#if loaded}<span class="mp-model-loaded" title="Already loaded on the server — picking it shows the window it is loaded at; keeping that window costs no reload">current</span>{/if}
    {#if lbl.quant}<span class="mp-model-quant">{lbl.quant}</span>{/if}
  </button>
  {#if visionState}
    <button class="mp-vision" class:sees class:pinned onclick={vision} title={chipTitle}>
      {sees ? 'vision' : 'no vision'}
    </button>
  {/if}
</div>

<style>
  .mp-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 0 6px 0 0;
    border: 1px solid transparent;
    border-radius: 5px;
    transition: background 0.12s ease;
  }
  .mp-row:hover { background: var(--og-btn-bg); }
  .mp-row:hover .mp-model { color: var(--og-text); }
  .mp-row.current { border-color: var(--og-chat); }
  .mp-row.current .mp-model { color: var(--og-text); }
  .mp-model {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1 1 auto;
    min-width: 0;
    padding: 5px 0 5px 6px;
    font-size: 12px;
    text-align: left;
    background: transparent;
    color: var(--og-text-secondary);
    border: none;
    cursor: pointer;
    font-family: inherit;
    transition: color 0.12s ease;
  }
  .mp-check { width: 11px; flex-shrink: 0; color: var(--og-chat); }
  /* Tweak 4 — structured label: muted provider subtitle over a strong name,
     with a quant chip pinned to the right when the id actually carries one. */
  .mp-model-label {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .mp-model-provider {
    font-size: 9.5px;
    letter-spacing: 0.02em;
    color: var(--og-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mp-model-name {
    font-weight: 600;
    overflow-wrap: anywhere;
    word-break: break-word;
    min-width: 0;
  }
  .mp-model-loaded { /* already held by the server; picking it costs no reload */ flex: 0 0 auto; align-self: center; font-size: 9px; padding: 1px 5px; border-radius: 3px; color: var(--og-success); border: 1px solid color-mix(in srgb, var(--og-success) 40%, transparent); }
  .mp-model-quant {
    flex: 0 0 auto;
    align-self: center;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 9px;
    letter-spacing: 0.03em;
    padding: 1px 5px;
    border-radius: 3px;
    color: var(--og-chat);
    background: color-mix(in srgb, var(--og-chat) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--og-chat) 40%, transparent);
  }
  /* The crane tone one capability already reads in — the agent card's own
     vision chip and the composer's armed Vision button both use it, so "this
     one sees" looks the same wherever it is said. A model that does NOT see
     stays muted: the chip is still there (it is the click target that turns
     vision on) but it must not compete with the model name for attention. */
  .mp-vision {
    flex: 0 0 auto;
    align-self: center;
    font-family: inherit;
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 3px;
    cursor: pointer;
    white-space: nowrap; /* "no vision" is two words and must not wrap the chip */
    color: var(--og-text-muted);
    background: transparent;
    border: 1px dashed var(--og-border);
  }
  .mp-vision:hover { color: var(--og-text); border-color: var(--og-chat); }
  .mp-vision.sees { color: var(--og-crane); border-color: var(--og-crane); }
  /* PINNED is a different fact from DETECTED — the owner decided it and the next
     detection pass is forbidden to change it — so it is drawn solid rather than
     dashed. Colour alone would have to carry it otherwise, and it is already
     carrying "does this model see". */
  .mp-vision.pinned { border-style: solid; }
  .mp-vision.pinned.sees { background: color-mix(in srgb, var(--og-crane) 14%, transparent); }
</style>
