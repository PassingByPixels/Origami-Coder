<script lang="ts">
  // THE FRONT DESK TILE: what answers an inbound question, and what it cost.
  //
  // It is a file of its own because the tile is two components and a
  // disclosure, not one: the desk's own controls, and the LOG of what it has
  // already done. The log is pinned to the tile floor because it is a record
  // and the controls above it are not.
  //
  // The PERMISSIONS are not here. They are the tile beside this one, on the
  // owner's own layout: the desk is "who answers, on what model, up to what
  // budget", and the permissions are "and what may they touch" — two questions,
  // two tiles, and the scope checklists need a whole tile's width to be read.
  import FlockFrontDesk from './FlockFrontDesk.svelte';
  import FlockInbox from './FlockInbox.svelte';
  import FlockTile from './FlockTile.svelte';
  import type { FlockAnswerRow, FlockFrontDeskState } from '../panes/flockTypes';

  interface ModelOpt { value: string; name: string }
  interface ProviderStat { id: string; name: string; live: boolean; flavor?: 'lmstudio' | 'ollama' | 'other' }

  interface Props {
    frontDesk: FlockFrontDeskState;
    /** How many questions are parked right now. The tile's one big number. */
    waiting: number;
    path: string;
    answers: FlockAnswerRow[];
    modelOptions: ModelOpt[];
    providerStatus: ProviderStat[];
    /** origamicoder.flock.enabled — the desk stays usable either way; the pill
     *  in the head reads "off" instead of the model's own state while it is. */
    enabled: boolean;
    onfrontdesk: (patch: Record<string, unknown>) => void;
    onenabled: (enabled: boolean) => void;
  }
  let { frontDesk, waiting, path, answers, modelOptions, providerStatus, enabled, onfrontdesk, onenabled }: Props = $props();
</script>

<FlockTile icon="fk-inbox" title="Front desk" edge={enabled && frontDesk.model ? 'ok' : enabled ? 'broken' : undefined}>
  {#snippet head()}
    <span class="fk-pill" class:ok={enabled && !!frontDesk.model} class:err={enabled && !frontDesk.model}>
      <span class="fk-dot"></span>{!enabled ? 'off' : frontDesk.model ? 'answering' : 'not set'}</span>
  {/snippet}
  <FlockFrontDesk {frontDesk} {waiting} {path} {modelOptions} {providerStatus} {enabled} {onenabled} onchange={onfrontdesk} />
  <details class="fk-disc answered">
    <summary>
      <svg class="fk-ico chev" aria-hidden="true"><use href="#fk-chev" /></svg><span>Recently answered</span>
    </summary>
    <FlockInbox {answers} />
  </details>
</FlockTile>

<style>
  .answered { margin-top: auto; }
</style>
