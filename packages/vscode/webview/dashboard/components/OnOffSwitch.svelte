<script lang="ts">
  // OnOffSwitch.svelte — the hard switch of mock round 5 (t-s9jr6u): the word
  // "On" / "Off" before a 26 x 14 px track, chat-blue when on. The Nests view
  // toolbar and the Settings view's switch rows use it.
  //
  // One-way: `checked` is what the HOST last reported. A press asks; the host's
  // reply moves the knob, so a refused write never leaves the switch lying.
  let { checked, label, onchange }: { checked: boolean; label: string; onchange: (next: boolean) => void } = $props();
</script>

<button class="sw" class:is-on={checked} role="switch" aria-checked={checked} aria-label={label} onclick={() => onchange(!checked)}>
  <span class="sw-word">{checked ? 'On' : 'Off'}</span>
  <span class="sw-track"><span class="sw-knob"></span></span>
</button>

<style>
  .sw {
    font: inherit; display: inline-flex; align-items: center; gap: 6px; padding: 0; border: 0; background: none;
    cursor: pointer; color: var(--og-text-muted); font-size: 11px;
  }
  .sw-track {
    position: relative; width: 26px; height: 14px; border-radius: 7px; flex: 0 0 auto; box-sizing: border-box;
    background: var(--og-input-bg); border: 1px solid var(--og-input-border);
    transition: background 160ms ease, border-color 160ms ease;
  }
  .sw-knob {
    position: absolute; top: 2px; left: 2px; width: 8px; height: 8px; border-radius: 50%; background: var(--og-text-muted);
    transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1), background 160ms ease;
  }
  .sw.is-on { color: var(--og-text); }
  .sw.is-on .sw-track { background: var(--og-chat); border-color: var(--og-chat); }
  .sw.is-on .sw-knob { transform: translateX(12px); background: var(--og-bg); }
  .sw:focus-visible { outline: 1px solid var(--og-chat); outline-offset: 2px; border-radius: 4px; }
  @media (prefers-reduced-motion: reduce) { .sw-knob, .sw-track { transition: none; } }
</style>
