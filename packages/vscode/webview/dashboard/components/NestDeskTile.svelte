<script lang="ts">
  // NestDeskTile.svelte — one desk in the Desks card (t-s9jr6u, mock round 4):
  // OS glyph, host name (renamed in place), the home icon on the mother base,
  // a status dot and one meta line. The row actions show on hover or focus.
  // No key and no device id on the row (owner rule).
  import { tick } from 'svelte';
  import { tip } from '../../shared/WarmTooltip.svelte';
  import OsGlyph from './OsGlyph.svelte';
  import { deskLabel, deskMeta, HOME_WORD, type NestDesk } from './nestsStatus';

  interface Props {
    desk: NestDesk;
    now: number;
    onRename: (id: string, name: string) => void;
    onHome: (id: string) => void;
    onRemove: (desk: NestDesk) => void;
    /** t-selspn: "tailed: N chats, behind by M" on the mother base; '' elsewhere. */
    tail?: string;
  }
  let { desk, now, onRename, onHome, onRemove, tail = '' }: Props = $props();

  let renaming = $state(false);
  let draft = $state('');
  let confirming = $state(false);
  let input: HTMLInputElement | undefined = $state();

  async function startRename(): Promise<void> {
    draft = deskLabel(desk);
    renaming = true;
    await tick();
    input?.select();
  }
  function endRename(keep: boolean): void {
    if (!renaming) return; // Enter, then the blur of the removed input: one save
    const name = draft.trim().slice(0, 32);
    if (keep && name && name !== desk.name) onRename(desk.id, name);
    renaming = false;
  }
  /** Pressing the icon on the desk that holds it CLEARS it at once; making a
   *  desk the mother base asks first, because the other desks then prune. */
  function home(): void {
    if (desk.motherBase) onHome('');
    else confirming = true;
  }
</script>

<div class="tile" class:is-off={!desk.online} class:show-acts={confirming} data-desk={desk.id}>
  <OsGlyph os={desk.os} />
  <div class="main">
    <div class="name">
      {#if renaming}
        <input class="rename" aria-label="Desk name" bind:this={input} bind:value={draft}
          onkeydown={(e) => { if (e.key === 'Enter') endRename(true); else if (e.key === 'Escape') endRename(false); }}
          onblur={() => endRename(true)} />
      {:else}
        <span class="label">{deskLabel(desk)}</span>
        {#if desk.motherBase}<span class="home" use:tip={`${HOME_WORD} — keeps every chat`} aria-label={HOME_WORD}>{@render homeIcon()}</span>{/if}
      {/if}
    </div>
    <div class="meta">
      {#if renaming}Enter saves · Esc cancels · shown on every desk{:else}
        <span class="dot" class:off={!desk.online}></span><span class="ell">{deskMeta(desk, now)}{#if tail}<span class="tail" data-tail>{` · ${tail}`}</span>{/if}</span>
      {/if}
    </div>
  </div>
  {#if !renaming}
    <div class="acts">
      <button class="ico" aria-label="Rename" use:tip={'Rename'} onclick={startRename}>{@render pencilIcon()}</button>
      <button class="ico" class:on={desk.motherBase} aria-label={desk.motherBase ? `Clear ${HOME_WORD}` : `Make ${deskLabel(desk)} the ${HOME_WORD}`}
        use:tip={desk.motherBase ? `Clear ${HOME_WORD}` : `Make ${deskLabel(desk)} the ${HOME_WORD}`} onclick={home}>{@render homeIcon()}</button>
      <button class="ico danger" aria-label={desk.self ? 'Take this desk out of the nest' : `Remove ${deskLabel(desk)}`}
        use:tip={desk.self ? 'Take this desk out of the nest' : `Remove ${deskLabel(desk)}`} onclick={() => onRemove(desk)}>{@render xIcon()}</button>
    </div>
  {/if}
  {#if confirming}
    <div class="pop" role="dialog" aria-label={`Make ${deskLabel(desk)} the ${HOME_WORD}?`}>
      <div class="pop-title">{@render homeIcon()}<span>Make {deskLabel(desk)} the {HOME_WORD}?</span></div>
      <p>It keeps every chat. The other desks keep the window set in Nests › Storage.</p>
      <div class="row">
        <button class="btn primary" onclick={() => { confirming = false; onHome(desk.id); }}>Make {HOME_WORD}</button>
        <button class="btn quiet" onclick={() => (confirming = false)}>Cancel</button>
      </div>
    </div>
  {/if}
</div>

{#snippet homeIcon()}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h8V6.5"/></svg>{/snippet}
{#snippet pencilIcon()}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 3.5l2 2L6 12H4v-2z"/></svg>{/snippet}
{#snippet xIcon()}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>{/snippet}

<style>
  .tile {
    position: relative; display: flex; align-items: center; gap: 8px; min-width: 0; height: 44px; padding: 0 8px 0 10px;
    background: var(--og-input-bg); border: 1px solid var(--og-border); border-radius: 6px; box-sizing: border-box;
  }
  .tile.is-off .label, .tile.is-off :global(.os) { opacity: 0.6; }
  .main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .name { display: flex; align-items: center; gap: 6px; min-width: 0; font-weight: 600; font-size: 12px; }
  .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .home { display: inline-flex; width: 12px; height: 12px; color: var(--og-accent); flex: 0 0 auto; }
  .home svg, .ico svg, .pop-title svg { width: 12px; height: 12px; }
  .meta { display: flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--og-text-muted); white-space: nowrap; overflow: hidden; }
  .ell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; background: var(--og-success); }
  .dot.off { background: transparent; box-shadow: inset 0 0 0 1.5px var(--og-text-muted); opacity: 0.8; }
  .acts { display: flex; gap: 2px; opacity: 0; transition: opacity 120ms ease; }
  .tile:hover .acts, .tile:focus-within .acts, .tile.show-acts .acts { opacity: 1; }
  .ico {
    width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; padding: 0;
    border: 1px solid transparent; border-radius: 5px; background: transparent; color: var(--og-text-secondary); cursor: pointer;
  }
  .ico:hover { background: var(--og-btn-hover); border-color: var(--og-border); color: var(--og-text); }
  .ico.on { color: var(--og-accent); }
  .ico.danger:hover { color: var(--og-error-text); border-color: color-mix(in srgb, var(--og-error) 60%, var(--og-border)); }
  .rename {
    flex: 0 1 160px; min-width: 0; font: inherit; font-size: 12px; font-weight: 600; padding: 1px 6px; height: 20px; color: var(--og-text);
    background: var(--og-bg); border: 1px solid var(--og-chat); border-radius: 6px; box-shadow: 0 0 0 1px color-mix(in srgb, var(--og-chat) 40%, transparent);
  }
  .rename:focus { outline: none; }
  .pop {
    position: absolute; left: 0; top: calc(100% + 6px); z-index: 20; width: 300px; max-width: calc(100vw - 40px);
    background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 8px; padding: 10px 12px;
    box-shadow: 0 10px 26px color-mix(in srgb, var(--og-bg) 75%, transparent);
    display: flex; flex-direction: column; gap: 6px; font-size: 11px; line-height: 1.4; color: var(--og-text);
  }
  .pop-title { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 11.5px; }
  .pop p { margin: 0; color: var(--og-text-secondary); }
  .row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
  .btn {
    font: inherit; font-size: 11px; padding: 4px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap;
    background: var(--og-btn-bg); color: var(--og-btn-text); border: 1px solid var(--og-border);
  }
  .btn.primary { background: var(--og-chat); color: var(--og-bg); border-color: var(--og-chat); font-weight: 600; }
  .btn.quiet { background: transparent; color: var(--og-text-secondary); }
</style>
