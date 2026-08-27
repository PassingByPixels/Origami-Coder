<script lang="ts">
  // The approve popover SHELL — backdrop, drop-shadow panel, row titles and
  // separators. Originally the notch rail itself (extracted from InputBar.svelte
  // when the composer grew its vision indicator, t-kgtr6c); round 3 reused it
  // as-is for a second gauge (the global Browser control) by mounting it
  // twice. Round 4 (t-kgsupy) merges those two mounts into ONE popover with
  // TWO labeled rows, so this file now iterates `rows: Row[]` and delegates
  // each row's own rail/dot/label drawing to ApproveRail.svelte — extracted
  // back out once this file crossed its cap.
  //
  // Round 5: wider popup, and each row's title shrinks to just "Actions:" /
  // "Browser:" (the ASK/AUTO/BYPASS names already show under the dots in
  // ApproveRail — spelling them out again in the header was noise) sitting
  // LEFT of its own rail instead of stacked above it.
  //
  // The STATE stays in the caller (InputBar): `approveMode` and
  // `browserApproveMode` are each read by their own badge/label logic there,
  // so lifting either down here would leave two owners of one truth. This
  // component draws the shell and rows and reports clicks; it decides
  // nothing and posts nothing.
  //
  // Every colour is a token EXCEPT the popover's drop shadow, which is moved
  // here verbatim from InputBar — a shadow is opacity over whatever is behind
  // it, not a themed surface, and inventing a token for it here would make this
  // file disagree with the four other popovers in the composer.
  import ApproveRail from './ApproveRail.svelte';

  interface Opt { value: string; name: string }
  interface Row {
    key: string;
    title: string;
    mode: string;
    options: Opt[];
    onSelect: (value: string) => void;
    disabled?: boolean;
  }

  let { open, rows, onClose }: {
    open: boolean;
    rows: Row[];
    onClose: () => void;
  } = $props();
</script>

{#if open}
  <button class="approve-backdrop" aria-label="Close approve selector" onclick={onClose}></button>
  <div class="approve-pop" onclick={(e) => e.stopPropagation()}>
    {#each rows as row, ri (row.key)}
      <div class="approve-row approve-row-{row.key}">
        <div class="approve-row-title">{row.title}</div>
        <ApproveRail mode={row.mode} options={row.options} onSelect={row.onSelect} disabled={row.disabled} />
      </div>
      {#if ri < rows.length - 1}<div class="approve-row-sep"></div>{/if}
    {/each}
  </div>
{/if}

<style>
  .approve-backdrop {
    position: fixed; inset: 0; z-index: 19;
    background: transparent; border: none; padding: 0; margin: 0; cursor: default;
  }
  .approve-pop {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    z-index: 20;
    min-width: 260px;
    padding: 10px 16px;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
  }
  /* t-kgsupy round 5 — the title sits LEFT of its own rail, not stacked above
     it: it is now just "Actions:" / "Browser:" (the option names already show
     under the dots in ApproveRail, so the header no longer repeats them, and
     a short label reads fine beside the rail instead of needing its own
     line). The separator is still the only thing telling two rows apart from
     one long rail, since each keeps its own independent state. */
  .approve-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .approve-row-title {
    flex-shrink: 0;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.3px;
    text-transform: uppercase;
    color: var(--og-text-muted);
    white-space: nowrap;
  }
  .approve-row-sep { height: 1px; background: var(--og-border); margin: 8px 0; }
</style>
