<script lang="ts">
  // The Add a desk panel: one string, two carriers (t-rz1b14; the round-4
  // panel for the Nests view, t-s9jr6u). Its own component on the
  // FlockInviteQr ruling: the QR needs a REAL white ground behind real black,
  // and isolating that literal here keeps the Desks card var-only. The copy box
  // is not a fallback: most desks have no camera. The panel closes ITSELF when
  // the new desk joins (the host closes the invitation and pushes a snapshot).
  import { onDestroy } from 'svelte';

  interface Props {
    inviteKey: string;
    /** The same string, drawn host-side. Empty while the QR has not arrived. */
    inviteQr: string;
    /** ms epoch the invitation lapses at, or null when the host did not say. */
    expiresAt: number | null;
    onCancel: () => void;
  }
  let { inviteKey, inviteQr, expiresAt, onCancel }: Props = $props();
  let copied = $state(false);
  let now = $state(Date.now());
  const timer = setInterval(() => (now = Date.now()), 1000);
  onDestroy(() => clearInterval(timer));

  let left = $derived(expiresAt ? Math.max(0, Math.round((expiresAt - now) / 1000)) : null);
  let clock = $derived(left === null ? '' : ` · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`);

  function copy(): void {
    void navigator.clipboard?.writeText(inviteKey).then(() => (copied = true));
  }
</script>

<div class="invite">
  {#if inviteQr}<div class="qr" aria-label="Invitation code">{@html inviteQr}</div>{/if}
  <div class="body">
    <div class="title">Add a desk</div>
    <p class="help">On the new desk, open Nests, turn it on and paste this key. The key works for one desk only. Then accept that desk here.</p>
    <div class="key"><code class="mono">{inviteKey}</code><button class="btn" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button></div>
    <p class="help">Add each desk once. It then reaches every other desk.</p>
    <div class="timer">
      <span class="mark" aria-hidden="true"></span><span>Waiting for the new desk{clock}</span>
      <span class="grow"></span><button class="link" onclick={onCancel}>Cancel</button>
    </div>
  </div>
</div>

<style>
  .invite {
    display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; padding: 10px; border-radius: 6px;
    background: var(--og-surface-alt); border: 1px solid color-mix(in srgb, var(--og-chat) 45%, var(--og-border));
  }
  /* The one literal in this component, and the reason it exists. */
  .qr { width: 132px; height: 132px; background: #ffffff; border-radius: 5px; padding: 4px; flex: 0 0 auto; box-sizing: border-box; }
  .qr :global(svg) { width: 100%; height: 100%; display: block; }
  .body { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
  .title { font-weight: 600; font-size: 12px; }
  .help { margin: 0; font-size: 11px; color: var(--og-text-secondary); }
  .key { display: flex; gap: 6px; align-items: stretch; min-width: 0; }
  .key code {
    flex: 1 1 auto; min-width: 0; font-size: 10px; line-height: 1.35; word-break: break-all; color: var(--og-text);
    background: var(--og-input-bg); border: 1px solid var(--og-border); border-radius: 5px; padding: 4px 7px;
  }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
  .btn { font: inherit; font-size: 11px; padding: 4px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap; background: var(--og-btn-bg); color: var(--og-btn-text); border: 1px solid var(--og-border); }
  .btn:hover { background: var(--og-btn-hover); }
  .timer { display: flex; align-items: center; gap: 8px; font-size: 10.5px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .grow { flex: 1 1 auto; }
  .link { font: inherit; font-size: 10.5px; background: none; border: 0; padding: 0; cursor: pointer; color: var(--og-text-secondary); }
  .link:hover { color: var(--og-text); text-decoration: underline; }
  .mark { width: 12px; height: 12px; border-radius: 50%; flex: 0 0 auto; box-shadow: inset 0 0 0 1.5px var(--og-border); position: relative; }
  .mark::after { content: ''; position: absolute; inset: 0; border-radius: 50%; border: 1.5px solid transparent; border-top-color: var(--og-chat); animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .mark::after { animation: none; } }
</style>
