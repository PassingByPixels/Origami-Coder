<script lang="ts">
  // CONFIG — the Nests view's last card (t-s9jr6u, mock round 5): four
  // key/value rows. Keep on a new desk (the defaults a new desk starts with),
  // Mother base (the same action as the tile's home button), This desk (read
  // only) and Relay (read only: Nests and Remote share one relay, changed in
  // Remote › Relay).
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { tip } from '../../shared/WarmTooltip.svelte';
  import { deskLabel, HOME_WORD, osWord, type NestDesk } from './nestsStatus';
  import { NEW_DESK_WINDOWS, windowsShort } from './nestStorageModel';

  let { desks, self, relayUrl }: { desks: NestDesk[]; self: { name: string; os: string }; relayUrl: string } = $props();
  const vscode = getVsCodeApi();
  let shut = $state(false);
  let home = $derived(desks.find((d) => d.motherBase)?.id ?? '');
  let me = $derived(desks.find((d) => d.self));
</script>

<section class="card cfg-card" class:is-shut={shut} data-name="config">
  <div class="head">
    <button class="chev" aria-expanded={!shut} aria-label="Collapse Config" onclick={() => (shut = !shut)}>▾</button>
    <span class="caps">Config</span>
  </div>
  {#if !shut}
    <div class="cfg">
      <span class="k">Keep on a new desk</span>
      <span class="v" use:tip={'Chats 30 days · Sub-agent chats 14 days · Tool output 7 days · Artifacts 90 days. A new desk starts with these; change them per desk in Storage.'}>{windowsShort(NEW_DESK_WINDOWS)}</span>
      <span class="k">Mother base</span>
      <span class="v">
        <span class="home" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h8V6.5"/></svg></span>
        <select class="sel" aria-label={HOME_WORD} disabled={desks.length < 2} value={home}
          onchange={(e) => vscode.postMessage({ type: 'groupSetMotherBase', id: e.currentTarget.value })}>
          <option value="">{desks.length < 2 ? 'None yet' : 'None'}</option>
          {#each desks as d (d.id)}<option value={d.id}>{deskLabel(d)}{d.self ? ' (this desk)' : ''}</option>{/each}
        </select>
      </span>
      <span class="k">This desk</span>
      <span class="v">{me ? deskLabel(me) : self.name} <span class="muted">· {osWord(me?.os || self.os)}</span></span>
      <span class="k">Relay</span>
      <span class="v relay"><code class="mono">{relayUrl}</code><span class="pill" use:tip={'Nests and Remote use one relay. Change it in Remote › Relay.'}>same relay as Remote</span></span>
    </div>
  {/if}
</section>

<style>
  .card {
    background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 12px 14px;
    display: flex; flex-direction: column; gap: 10px; min-width: 0; color: var(--og-text); font-size: 11.5px; line-height: 1.4;
  }
  .head { display: flex; align-items: center; gap: 6px; min-height: 21px; }
  .chev { width: 16px; height: 16px; padding: 0; border: 0; background: transparent; cursor: pointer; color: var(--og-text-muted); font-size: 10px; line-height: 16px; transition: transform 160ms ease; }
  .card.is-shut .chev { transform: rotate(-90deg); }
  .caps { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-muted); font-weight: 600; }
  .cfg { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: stretch; }
  .cfg > span { min-height: 30px; display: flex; align-items: center; gap: 6px; min-width: 0; border-bottom: 1px solid color-mix(in srgb, var(--og-border) 55%, transparent); }
  .cfg > span:nth-last-child(-n + 2) { border-bottom: 0; }
  .k { color: var(--og-text-muted); white-space: nowrap; }
  .v { padding-left: 10px; justify-content: flex-end; text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: var(--og-text-muted); }
  .home { width: 11px; height: 11px; color: var(--og-accent); display: inline-flex; }
  .home svg { width: 11px; height: 11px; }
  .sel { font: inherit; font-size: 10.5px; padding: 2px 4px; color: var(--og-text); background: var(--og-bg); border: 1px solid var(--og-input-border); border-radius: 5px; min-width: 96px; }
  .relay { flex-wrap: wrap; row-gap: 3px; padding: 3px 0; }
  .relay code { font-size: 10.5px; color: var(--og-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
  .pill { display: inline-flex; align-items: center; padding: 0 6px; height: 16px; border-radius: 8px; border: 1px solid var(--og-border); color: var(--og-text-secondary); font-size: 9.5px; font-weight: 600; white-space: nowrap; }
</style>
