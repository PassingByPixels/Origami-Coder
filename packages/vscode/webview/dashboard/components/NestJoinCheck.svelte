<script lang="ts">
  // NestJoinCheck.svelte — the Accept step (t-sj32zl). A desk that pasted an
  // invite key waits here; the desk that made the key shows the joining desk's
  // name and the same six-digit code, with Accept and Decline. The group
  // secret goes to the new desk ONLY on Accept. The host derives the code
  // (groupCrypto.deriveMatchCode); this leaf only draws it.
  import type { JoinCheck } from './nestJoinCheck';
  interface Props { check: JoinCheck; onAnswer: (accept: boolean) => void; onCancel: () => void }
  let { check, onAnswer, onCancel }: Props = $props();
</script>

<div class="check" data-side={check.side}>
  {#if check.side === 'inviter'}
    <div class="title"><span class="name">{check.name}</span> wants to join this nest.</div>
    <div class="code">Code <span class="mono">{check.code}</span></div>
    <p class="help">Make sure that the new desk shows the same code. If it does not, click Decline.</p>
    <div class="row">
      <button class="btn primary" onclick={() => onAnswer(true)}>Accept</button>
      <button class="btn" onclick={() => onAnswer(false)}>Decline</button>
    </div>
  {:else}
    <div class="title">Waiting for the other desk to accept.</div>
    <div class="code">Code <span class="mono">{check.code}</span></div>
    <p class="help">On the other desk, make sure that it shows "{check.name}" and this code.</p>
    <div class="row"><button class="link" onclick={onCancel}>Cancel</button></div>
  {/if}
</div>

<style>
  .check {
    display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 6px;
    background: var(--og-surface-alt); border: 1px solid color-mix(in srgb, var(--og-chat) 45%, var(--og-border));
  }
  .title { font-size: 12px; color: var(--og-text); }
  .name { font-weight: 600; }
  .code { font-size: 11px; color: var(--og-text-secondary); }
  .code .mono { font-size: 15px; letter-spacing: 0.08em; color: var(--og-text); font-weight: 600; margin-left: 4px; }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
  .help { margin: 0; font-size: 11px; color: var(--og-text-secondary); }
  .row { display: flex; gap: 6px; align-items: center; }
  .btn {
    font: inherit; font-size: 11px; padding: 4px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap;
    background: var(--og-btn-bg); color: var(--og-btn-text); border: 1px solid var(--og-border);
  }
  .btn:hover { background: var(--og-btn-hover); }
  .btn.primary { background: var(--og-chat); color: var(--og-bg); border-color: var(--og-chat); font-weight: 600; }
  .link { font: inherit; font-size: 10.5px; background: none; border: 0; padding: 0; cursor: pointer; color: var(--og-text-secondary); }
  .link:hover { color: var(--og-text); text-decoration: underline; }
</style>
