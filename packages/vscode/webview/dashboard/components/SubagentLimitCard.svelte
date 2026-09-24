<script lang="ts">
  // SubagentLimitCard.svelte — Settings › Agents › "Sub-agent time limit".
  //
  // Born in Insights (an uncapped sub-agent is the largest unbudgeted spend);
  // moved to the Settings view as a row in t-s9jr6u, because Insights now
  // holds insights only (owner, round 6). The "reload" pill on the row says the
  // engine reads the value at spawn. The setting is written by
  // the HOST (subagentLimitPane.ts), never from here: a webview naming a
  // configuration key is a webview choosing what the extension writes.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import SettingRow from './SettingRow.svelte';
  let { filter = '' }: { filter?: string } = $props();
  const vscode = getVsCodeApi();

  let hours = $state(4);
  let min = $state(0.5);
  let fallback = $state(4);
  let stored = $state(false);
  let error: string | null = $state(null);
  // The value in the box while it is being typed in. Kept apart from `hours` so
  // a half-typed "0." is not sent, and so the host's reply can correct the box.
  let draft = $state('4');

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type !== 'subagentLimitData') return;
    hours = typeof msg.hours === 'number' ? msg.hours : fallback;
    min = typeof msg.min === 'number' ? msg.min : min;
    fallback = typeof msg.default === 'number' ? msg.default : fallback;
    stored = msg.stored === true;
    error = typeof msg.error === 'string' ? msg.error : null;
    // Unset = an EMPTY box with the engine default as its placeholder (round 5).
    draft = stored ? String(hours) : '';
  });

  vscode.postMessage({ type: 'requestSubagentLimit' });

  // One-way value + an explicit read of the event target, NOT `bind:value`: on
  // a number input Svelte binds a number (or undefined for anything unparseable)
  // and writes it back, so a half-typed "0." fights the box while it is typed.
  function commit(event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    const next = Number(raw);
    if (!raw.trim() && !stored) return; // still unset: nothing to send
    if (!raw.trim() || !Number.isFinite(next) || next < min) {
      // Snap the box back rather than sending a value the host would refuse
      // anyway — this just makes the refusal visible where it was typed.
      draft = stored ? String(hours) : '';
      (event.target as HTMLInputElement).value = draft;
      error = `A sub-agent limit must be at least ${min} hours.`;
      return;
    }
    vscode.postMessage({ type: 'subagentLimitSet', hours: next });
  }
</script>

<SettingRow id="subagentLimit" {filter}>
  {#snippet control()}
    <label class="sal-field">
      <input class="sal-input" type="number" step="0.5" {min} value={draft} placeholder={String(fallback)} onchange={commit} aria-label="Sub-agent time limit in hours" />
      <span class="sal-unit">hours</span>
    </label>
  {/snippet}
  {#snippet extra()}
    {#if error}<div class="sal-error">{error}</div>{/if}
  {/snippet}
</SettingRow>

<style>
  .sal-field { display: flex; align-items: center; gap: 6px; }
  .sal-input {
    width: 64px; padding: 4px 8px; background: var(--og-bg); color: var(--og-text); border: 1px solid var(--og-input-border);
    border-radius: 6px; font-family: inherit; font-size: 11px; font-variant-numeric: tabular-nums;
  }
  .sal-input:focus { outline: none; border-color: var(--og-chat); }
  .sal-unit { font-size: 11px; color: var(--og-text-muted); }
  .sal-error { font-size: 10.5px; color: var(--og-error); }
</style>
