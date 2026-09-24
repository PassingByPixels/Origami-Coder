<script lang="ts">
  // NestDesksEmpty.svelte — the Desks card with no nest yet (t-s9jr6u, mock
  // round 4): two choices side by side, Start or Join. A leaf so the card
  // stays under its cap. The join key is checked by the HOST (its parser
  // names the fix); this only refuses to post an empty one.
  interface Props { error: string | null; joining: boolean; onStart: () => void; onJoin: (key: string) => void }
  let { error, joining, onStart, onJoin }: Props = $props();
  let key = $state('');

  function join(): void {
    const text = key.trim();
    if (text) onJoin(text);
  }
</script>

<div class="choices">
  <div class="choice">
    <div class="choice-title">Start a nest</div>
    <p>This desk is the first member.</p>
    <button class="btn" disabled={joining} onclick={onStart}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>
      Start and add a desk
    </button>
  </div>
  <div class="choice">
    <div class="choice-title">Join a nest</div>
    <p>Paste the key that the other desk shows.</p>
    <div class="join">
      <input class="inp mono" class:bad={!!error} aria-label="Nest key" placeholder="origami-group-v2.…" bind:value={key}
        onkeydown={(e) => e.key === 'Enter' && join()} />
      <button class="btn primary" disabled={joining || !key.trim()} onclick={join}>{joining ? 'Joining…' : 'Join'}</button>
    </div>
    {#if error}<p class="err" role="alert">{error}</p>{/if}
  </div>
</div>

<style>
  .choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; }
  .choice {
    display: flex; flex-direction: column; gap: 6px; align-items: flex-start; padding: 10px 12px; border-radius: 6px;
    background: var(--og-input-bg); border: 1px solid var(--og-border);
  }
  .choice-title { font-weight: 600; font-size: 12px; }
  .choice p { margin: 0; color: var(--og-text-secondary); font-size: 11px; }
  .join { display: flex; gap: 6px; width: 100%; }
  .inp {
    flex: 1 1 auto; min-width: 0; font: inherit; font-size: 10.5px; padding: 4px 8px; color: var(--og-text);
    background: var(--og-bg); border: 1px solid var(--og-input-border); border-radius: 6px;
  }
  .inp:focus { outline: none; border-color: var(--og-chat); }
  .inp.bad { border-color: var(--og-error); }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
  .err { margin: 0; font-size: 10.5px; color: var(--og-error-text); }
  .btn {
    font: inherit; font-size: 11px; padding: 4px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap;
    background: var(--og-btn-bg); color: var(--og-btn-text); border: 1px solid var(--og-border);
    display: inline-flex; align-items: center; gap: 6px;
  }
  .btn svg { width: 11px; height: 11px; }
  .btn:hover { background: var(--og-btn-hover); }
  .btn:disabled { opacity: 0.55; cursor: default; }
  .btn.primary { background: var(--og-chat); color: var(--og-bg); border-color: var(--og-chat); font-weight: 600; }
</style>
