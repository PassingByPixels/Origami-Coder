<script lang="ts">
  // CronForm — the create/edit draft for one cron, EXTRACTED from CronsPane
  // when the pane's list became a table and it ran out of room under its
  // architecture cap. Behaviour-preserving: same fields, same schedule shapes,
  // same submit payload the panel's createCron/updateCron handlers already take.
  //
  // The form owns its own draft state and hands the finished draft back through
  // `onsubmit`; the pane owns everything to do with the WIRE (which id is being
  // edited, the host round-trip, the error that comes back).
  //
  // MODEL IS REQUIRED — Save/Create stays disabled without one. An unpinned
  // cron does not run on a "workspace default"; there is no such thing. The
  // resolution it actually falls through to, and why that costs money, is
  // written where the control lives: CronRunTarget.svelte.
  import CronRunTarget from './CronRunTarget.svelte';

  type Weekday = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';
  const WEEKDAYS: Weekday[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

  interface CronDraftInit {
    name?: string; prompt?: string; agent?: string; model?: string;
    schedule?: { kind: string; time?: string; days?: Weekday[]; every?: number };
  }
  interface ModelOpt { value: string; name: string }
  interface ProviderStat { id: string; name: string; live: boolean; flavor?: 'lmstudio' | 'ollama' | 'other' }

  interface Props {
    initial?: CronDraftInit | null;
    editing: boolean;
    error?: string;
    modelOptions?: ModelOpt[];
    providerStatus?: ProviderStat[];
    onsubmit: (draft: Record<string, unknown>) => void;
    oncancel: () => void;
  }
  const { initial = null, editing, error = '', modelOptions = [], providerStatus = [], onsubmit, oncancel }: Props = $props();

  // `initial` SEEDS the draft once and is never read again: the pane remounts
  // this component (keyed on its form counter) every time the form is opened,
  // so there is no live prop to track. Snapshotting says that outright — and
  // keeps Svelte from warning that a prop read in a $state initialiser only
  // captures its first value, which here is the intent, not a bug.
  const seed = $state.snapshot(initial) ?? {};

  let fName = $state(seed.name ?? '');
  let fPrompt = $state(seed.prompt ?? '');
  let fKind = $state(seed.schedule?.kind ?? 'daily');
  let fTime = $state(seed.schedule?.time ?? '09:00');
  let fDays: Weekday[] = $state(seed.schedule?.days ?? ['MON']);
  let fEvery = $state(seed.schedule?.every ?? 1);
  let fAgent = $state(seed.agent ?? '');
  let fModel = $state(seed.model ?? '');

  function scheduleDraft() {
    if (fKind === 'daily') return { kind: 'daily', time: fTime };
    if (fKind === 'weekly') return { kind: 'weekly', days: fDays, time: fTime };
    return { kind: fKind, every: Number(fEvery) };
  }
  function submit() {
    onsubmit({ name: fName, prompt: fPrompt, schedule: scheduleDraft(), agent: fAgent, model: fModel });
  }
  function toggleDay(d: Weekday) {
    fDays = fDays.includes(d) ? fDays.filter((x) => x !== d) : [...fDays, d];
  }
</script>

<div class="cron-form">
  <input class="cf-input" placeholder="Name" bind:value={fName} />
  <textarea class="cf-input cf-prompt" rows="2" placeholder="Prompt to run" bind:value={fPrompt}></textarea>
  <div class="cf-row">
    <select class="cf-input cf-kind" bind:value={fKind}>
      <option value="daily">Daily</option>
      <option value="weekly">Weekly</option>
      <option value="hourly">Every N hours</option>
      <option value="minutely">Every N minutes</option>
    </select>
    {#if fKind === 'daily' || fKind === 'weekly'}
      <input class="cf-input cf-time" type="time" bind:value={fTime} />
    {:else}
      <input class="cf-input cf-time" type="number" min="1" bind:value={fEvery} />
    {/if}
  </div>
  {#if fKind === 'weekly'}
    <div class="cf-days">
      {#each WEEKDAYS as d (d)}
        <button class="cf-day" class:on={fDays.includes(d)} onclick={() => toggleDay(d)}>{d}</button>
      {/each}
    </div>
  {/if}
  <CronRunTarget bind:agent={fAgent} bind:model={fModel} {modelOptions} {providerStatus} />
  {#if error}<div class="cf-error">{error}</div>{/if}
  <div class="cf-row cf-actions">
    <button class="cf-save" onclick={submit} disabled={!fModel}>{editing ? 'Save' : 'Create'}</button>
    <button class="cf-cancel" onclick={oncancel}>Cancel</button>
  </div>
</div>

<style>
  .cron-form { margin: 10px 12px 0; padding: 10px; background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
  .cf-input { background: var(--og-input-bg); border: 1px solid var(--og-input-border); color: var(--og-text); border-radius: 4px; padding: 4px 6px; font-size: 11px; font-family: inherit; flex: 1; min-width: 0; }
  .cf-prompt { resize: vertical; }
  .cf-row { display: flex; gap: 6px; }
  .cf-kind { flex: 2; }
  .cf-time { flex: 1; }
  .cf-days { display: flex; gap: 3px; }
  .cf-day { flex: 1; background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text-secondary); border-radius: 4px; cursor: pointer; padding: 3px 0; font-size: 9px; }
  .cf-day.on { background: var(--og-accent); color: var(--og-text); }
  .cf-error { color: var(--og-error-text); background: var(--og-error-soft); border: 1px solid var(--og-error); border-radius: 4px; padding: 5px 7px; font-size: 10px; line-height: 1.4; }
  .cf-actions { justify-content: flex-end; }
  .cf-save, .cf-cancel { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 3px 10px; font-size: 11px; }
  .cf-save { background: var(--og-accent); }
  .cf-save:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
