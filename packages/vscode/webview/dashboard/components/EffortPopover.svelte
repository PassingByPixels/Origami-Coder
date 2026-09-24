<script lang="ts">
  // EffortPopover.svelte — the composer's reasoning-effort trigger + notch-rail
  // popover, extracted VERBATIM out of InputBar.svelte (which needed the room
  // back for the composer file-drop feature) — the same move ApprovePopover
  // and VisionProfileMenu made before it.
  //
  // State stays in the caller: `effortCurrent`/`effortOpen` are read by other
  // InputBar logic (the MODE badge above the composer) too, so lifting either
  // down here would leave two owners of one truth. This component draws the
  // trigger and the popover and reports clicks; it decides nothing itself.
  interface Opt { value: string; name: string }
  let { options, current, active, open, onToggle, onSelect, onClose }: {
    options: Opt[];
    current: string;
    active: boolean;
    open: boolean;
    onToggle: () => void;
    onSelect: (value: string) => void;
    onClose: () => void;
  } = $props();
</script>

{#if options.length > 0}
  <div class="effort-wrap">
    <button class="mode-btn" class:active={active} onclick={onToggle}
      title="Reasoning effort — click to set level">Effort</button>
    {#if open}
      <button class="effort-backdrop" aria-label="Close effort selector" onclick={onClose}></button>
      <div class="effort-pop" onclick={(e) => e.stopPropagation()}>
        <div class="effort-track">
          <div class="effort-rail-row">
            {#each options as opt, i (opt.value)}
              <button class="effort-notch" class:active={opt.value === current} onclick={() => onSelect(opt.value)} title={opt.name}>
                <span class="effort-dot"></span>
              </button>
              {#if i < options.length - 1}<span class="effort-rail"></span>{/if}
            {/each}
          </div>
          <div class="effort-label-row">
            {#each options as opt (opt.value)}
              <span class="effort-label" class:active={opt.value === current}>{opt.name}</span>
            {/each}
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Duplicated from InputBar's `.mode-btn` (the ModeControl.svelte precedent):
     Svelte scopes styles to the component that writes the markup, so the
     trigger has to carry its own copy to sit level with its neighbours. */
  .mode-btn {
    padding: 2px 8px;
    font-size: 10px;
    background: var(--og-surface);
    color: var(--og-text-muted);
    border: 1px solid var(--og-border);
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
  }
  .mode-btn:hover { color: var(--og-text-secondary); background: var(--og-btn-bg); }
  .mode-btn.active { background: var(--og-accent); color: white; border-color: var(--og-accent); }

  .effort-wrap { position: relative; display: inline-flex; }
  .effort-backdrop {
    position: fixed; inset: 0; z-index: 19;
    background: transparent; border: none; padding: 0; margin: 0; cursor: default;
  }
  .effort-pop {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    z-index: 20;
    padding: 10px 14px;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
  }
  .effort-track {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .effort-rail-row {
    display: flex;
    align-items: center;
  }
  .effort-notch {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    background: none;
    border: none;
    cursor: pointer;
    font-family: inherit;
  }
  .effort-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--og-border);
    transition: background 0.15s, transform 0.15s;
    flex-shrink: 0;
  }
  .effort-notch:hover .effort-dot {
    background: var(--og-text-muted);
    transform: scale(1.3);
  }
  .effort-notch.active .effort-dot {
    background: var(--og-accent);
    transform: scale(1.4);
    box-shadow: 0 0 6px var(--og-accent);
  }
  .effort-rail {
    width: 20px;
    height: 2px;
    background: var(--og-border);
    flex-shrink: 0;
  }
  .effort-label-row {
    display: flex;
    justify-content: space-around;
  }
  .effort-label {
    font-size: 9px;
    color: var(--og-text-muted);
    white-space: nowrap;
    text-align: center;
    flex: 1;
  }
  .effort-label.active {
    color: var(--og-accent);
    font-weight: 600;
  }
</style>
