<script lang="ts">
  // ONE notch rail + its label row — extracted out of ApprovePopover.svelte
  // (t-kgsupy round 4, over its 135-line cap once it grew a second row) so
  // the popover owns the shell/backdrop/row-iteration and this owns a
  // single row's own click/dot/label wiring. `dotColor`/`labelColor` moved
  // down with it — they are about one rail's own mode, not the popover.
  //
  // GENERIC by design (`options: Opt[]`), which is what lets ApprovePopover
  // mount it twice for two independent settings (the per-chat Actions preset
  // and VS Code's global Browser auto-approve) without either row knowing
  // the other exists — and, from the mode round, lets ModeControl mount it a
  // third time so the composer has ONE dot-slider idiom instead of two.
  //
  // `hint` is what that third caller needed: a mode's tooltip has to say what
  // the mode DOES ("Deep Plan" alone does not tell you it never starts
  // building), while Ask/Auto/Bypass are their own explanation. Absent, the
  // tooltip stays the option name, exactly as the two approve rows had it.
  interface Opt { value: string; name: string; hint?: string }

  let { mode, options, onSelect, disabled = false }: {
    mode: string;
    options: Opt[];
    onSelect: (value: string) => void;
    disabled?: boolean;
  } = $props();

  /** The dot's fill. Auto is the success tone, bypass the error tone — the two
   *  states where a tool runs without being asked about, and the glow is what
   *  makes "this chat is not asking me any more" visible at a glance. */
  function dotColor(value: string): string {
    if (value === 'auto') return 'background: var(--og-success); box-shadow: 0 0 6px var(--og-success);';
    if (value === 'bypass') return 'background: var(--og-error); box-shadow: 0 0 6px var(--og-error);';
    return 'background: var(--og-text-muted);';
  }

  function labelColor(value: string): string {
    if (value !== mode) return '';
    return 'color: ' + (value === 'auto' ? 'var(--og-success)' : value === 'bypass' ? 'var(--og-error)' : 'var(--og-text)');
  }
</script>

<div class="approve-track">
  <div class="approve-rail-row">
    {#each options as opt, i (opt.value)}
      <!-- The notch holds only a decorative dot, so its accessible NAME comes
           from aria-label rather than from the tooltip — which is now free to
           carry a longer `hint` without renaming the control. -->
      <button class="approve-notch" class:active={opt.value === mode} disabled={disabled}
        onclick={() => onSelect(opt.value)} aria-label={opt.name} title={opt.hint ?? opt.name}>
        <span class="approve-dot" style={opt.value === mode ? dotColor(opt.value) : ''}></span>
      </button>
      {#if i < options.length - 1}<span class="approve-rail"></span>{/if}
    {/each}
  </div>
  <div class="approve-label-row">
    {#each options as opt (opt.value)}
      <span class="approve-label" class:active={opt.value === mode} style={labelColor(opt.value)}>{opt.name}</span>
    {/each}
  </div>
</div>

<style>
  .approve-track { display: flex; flex-direction: column; gap: 3px; }
  .approve-rail-row { display: flex; align-items: center; }
  .approve-notch {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    background: none;
    border: none;
    cursor: pointer;
    font-family: inherit;
  }
  .approve-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--og-border);
    transition: background 0.15s, transform 0.15s;
    flex-shrink: 0;
  }
  .approve-notch:hover .approve-dot { background: var(--og-text-muted); transform: scale(1.3); }
  .approve-notch.active .approve-dot { transform: scale(1.4); }
  .approve-notch:disabled { opacity: 0.4; cursor: not-allowed; }
  .approve-notch:disabled .approve-dot { transform: none; }
  /* The connectors GROW (never shrink below 20px): with long labels — the mode
     rail's "Build / Plan / Deep Plan" — the label row is what sets the track's
     width, and fixed-width connectors would leave the dots packed left of the
     labels they belong to. */
  .approve-rail { flex: 1 0 20px; height: 2px; background: var(--og-border); }
  /* The gap is the fix for long labels fusing into one word ("BuildPlanDeep
     Plan"): each label box is content-sized under flex, so without a gap two
     wide neighbours touch. */
  .approve-label-row { display: flex; justify-content: space-around; column-gap: 10px; }
  .approve-label {
    font-size: 9px;
    color: var(--og-text-muted);
    white-space: nowrap;
    text-align: center;
    flex: 1;
  }
  .approve-label.active { font-weight: 600; }
</style>
