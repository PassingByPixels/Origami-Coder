<script lang="ts">
  // THE FRONT DESK TILE: what happens when a FRIEND's Origami asks this one.
  //
  // THE MODEL IS REQUIRED AND HAS NO DEFAULT — an owner ruling with a reason
  // the engine states in flock/policy.ts: picking the cheapest configured model
  // would spend someone's money on a decision they never made, and picking
  // their main one would spend a lot of it. Unset, every inbound question is
  // refused, so this tile carries a red left edge and says so in red, at the
  // top, permanently — not as a toast that scrolls away.
  //
  // The PENDING COUNT is the biggest number on the page because it is the only
  // thing on the page that somebody else is waiting on.
  //
  // The primary button sits under the field it commits, NOT at the tile floor:
  // the mock's own Playwright pass found it below the fold at 900x700 when the
  // tallest tile in the row set the height.
  import AgentModelSelect from './AgentModelSelect.svelte';
  import type { FlockFrontDeskState } from '../panes/flockTypes';

  interface ModelOpt { value: string; name: string }
  interface ProviderStat { id: string; name: string; live: boolean; flavor?: 'lmstudio' | 'ollama' | 'other' }

  interface Props {
    frontDesk: FlockFrontDeskState;
    /** How many questions are parked right now. The tile's one big number. */
    waiting: number;
    path: string;
    modelOptions: ModelOpt[];
    providerStatus: ProviderStat[];
    /** origamicoder.flock.enabled. The MASTER SWITCH lives here, on the count
     *  row, so the sentence beside it can state what happens either way — the
     *  same placement RemoteStory.svelte uses for Remote's own switch. */
    enabled: boolean;
    onchange: (patch: Record<string, unknown>) => void;
    onenabled: (enabled: boolean) => void;
  }
  let { frontDesk, waiting, path, modelOptions, providerStatus, enabled, onchange, onenabled }: Props = $props();

  const ON = 'Your Origami answers contacts on the desk model, inside the folders you share, nothing else.';
  // The engine only reads this setting at its NEXT spawn (flockEnabled.ts) — a
  // chat already running keeps Flock until it restarts, and this line says so
  // rather than promising a stop this switch cannot make happen mid-session.
  const OFF = 'Off by default: no relay connection for Flock, no owner lease, no mailbox. Turning this on opens a relay connection, takes an owner lease, and lets your contacts\' questions reach you. Reload the window (or open a new chat) to start it.';

  let budgetDraft = $state('');
  let seeded = $state('');

  // Re-seed from the host's value whenever the host sends a DIFFERENT one. Not
  // a $derived: this is editable, and a derived would fight the keyboard.
  $effect(() => {
    const key = JSON.stringify(frontDesk);
    if (key === seeded) return;
    seeded = key;
    budgetDraft = frontDesk.dailyBudgetTokens === undefined ? '' : String(frontDesk.dailyBudgetTokens);
  });

  function commitBudget(): void {
    const raw = budgetDraft.trim();
    // Empty means NO CAP, which is `null` on the wire — a cleared field and an
    // untouched one are different intentions, and only `null` removes the key.
    if (raw === '') { onchange({ dailyBudgetTokens: null }); return; }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return;
    onchange({ dailyBudgetTokens: Math.round(value) });
  }
</script>

<div class="fk-count-row">
  <label class="sw big" title="Turn Flock on or off">
    <input type="checkbox" checked={enabled} onchange={(e) => onenabled(e.currentTarget.checked)} />
    <span class="track"></span>
    <span class="sw-label">Flock is {enabled ? 'on' : 'off'}</span>
  </label>
  <div>
    <div class="fk-display">{waiting}</div>
    <div class="fk-sec">{waiting === 1 ? 'question waiting' : 'questions waiting'}</div>
  </div>
</div>
<p class="sw-state">{enabled ? ON : OFF}</p>

{#if !frontDesk.model}
  <p class="fd-required" role="alert">
    <b>No model — every inbound question is refused.</b> There is no default on purpose: it would
    spend your money on a choice you never made.
  </p>
{/if}

<label class="fk-field">
  <span class="fk-caps">Model — required</span>
  <AgentModelSelect
    options={modelOptions}
    {providerStatus}
    value={frontDesk.model ?? ''}
    placeholder="Pick the model your front desk answers on"
    onchange={(v) => onchange({ model: v || null })}
  />
</label>

<label class="fk-field">
  <span class="fk-caps">Daily budget — per contact, per UTC day</span>
  <input
    class="fk-inp"
    inputmode="numeric"
    placeholder="no cap"
    aria-label="Daily budget"
    bind:value={budgetDraft}
    onblur={commitBudget}
    onkeydown={(e) => { if (e.key === 'Enter') commitBudget(); }}
  />
</label>

<p class="fk-muted">Blank budget means no cap. Written to <code class="fk-mono">{path}</code>.</p>

<style>
  /* The master switch — same shape as RemoteStory.svelte's own: a 46x24 track,
     success colours on, muted off. */
  .sw.big { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
  .sw.big input { position: absolute; opacity: 0; width: 0; height: 0; }
  .sw.big .track {
    width: 46px; height: 24px; border-radius: 999px; background: var(--og-success-soft);
    border: 1px solid var(--og-success); position: relative; flex: 0 0 auto;
    transition: background 0.15s, border-color 0.15s;
  }
  .sw.big .track::after {
    content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%;
    background: var(--og-success); transform: translateX(20px); transition: transform 0.15s, background 0.15s;
  }
  .sw.big:has(input:not(:checked)) .track { background: var(--og-surface-alt); border-color: var(--og-border); }
  .sw.big:has(input:not(:checked)) .track::after { background: var(--og-text-muted); transform: translateX(0); }
  .sw.big input:focus-visible + .track { outline: 1px solid var(--og-accent); outline-offset: 2px; }
  .sw-label { font-weight: 600; color: var(--og-text); white-space: nowrap; }
  .sw-state { margin: 0; font-size: 10.5px; color: var(--og-text-muted); line-height: 1.5; }
  .fd-required { margin: 0; color: var(--og-error-text); line-height: 1.5; }
  .fd-required b { font-weight: 600; }
</style>
