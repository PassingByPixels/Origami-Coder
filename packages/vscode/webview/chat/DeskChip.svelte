<script lang="ts">
  // t-s9k0q6 (round 7 rule 4): one desk, as a chip. The OS mark and the host
  // name; a DASHED border when that desk is offline. Used by the Nest rows and
  // by the fork parent line in Here, so the two cannot come to disagree about
  // what a desk looks like.
  //
  // The name is capped at 14 characters (an ellipsis past that): rule 4 says
  // the chip never truncates, but a long host name at 260 px would leave the
  // title nothing (the round-7 proposal names this as a port decision).
  import { tip } from '../shared/WarmTooltip.svelte';
  import { VENDOR_MARK_PATHS } from '../shared/vendorMarks';
  import type { NestDesk } from './nestIndex';

  let { desk, name }: { desk: NestDesk | undefined; name: string } = $props();

  /** The host's OS string to a mark id: VS Code's `process.platform` spelling
   *  and the plain one both land on the same three marks. */
  function osMark(os: string): string {
    const o = os.toLowerCase();
    if (o.startsWith('win')) return 'windows';
    if (o === 'darwin' || o.startsWith('mac')) return 'macos';
    if (o === 'linux') return 'linux';
    return '';
  }
  const mark = $derived(VENDOR_MARK_PATHS[osMark(desk?.os ?? '')]);
  const online = $derived(desk?.online === true);
  const label = $derived(
    `${name}${desk?.os ? ' · ' + desk.os : ''} · ${online ? 'online' : 'offline'}${desk?.motherBase ? ' · the mother base' : ''}`,
  );
</script>

<span class="desk-chip" class:off={!online} use:tip={label}>
  {#if mark}
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={mark.path} /></svg>
  {/if}
  <span class="desk-name">{name}</span>
</span>

<style>
  .desk-chip {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 15px;
    margin-left: 6px;
    padding: 0 5px;
    box-sizing: border-box;
    border: 1px solid var(--og-border);
    border-radius: 8px;
    color: var(--og-text-muted);
    background: color-mix(in srgb, var(--og-surface) 90%, transparent);
    font-size: 9.5px;
    font-weight: 600;
    line-height: 1;
    align-self: center;
  }
  .desk-chip svg { width: 9px; height: 9px; flex: 0 0 auto; }
  .desk-name { max-width: 14ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .desk-chip.off { border-style: dashed; opacity: 0.85; }
</style>
