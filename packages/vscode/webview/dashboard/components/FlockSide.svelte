<script lang="ts">
  // THE RIGHT RAIL: the desk state, then the three things set once.
  //
  // The FRONT DESK stays a card and stays open, because its state can be
  // BROKEN — no model means every inbound question is refused — and a broken
  // desk behind a chevron is a feature that has quietly stopped working. The
  // other three are chips: their value is one line until the owner wants the
  // form (FlockChip.svelte says why, flockChips.ts decides which starts open).
  //
  // Its own file, not the pane's markup, for the pane's own reason: FlockPane
  // is the WIRE. This column is three components, one card and the rule that
  // says how each is dressed, and it sat the pane straight over its cap.
  //
  // The PERMISSIONS SWITCH is drawn here, in the chip's head, rather than in
  // FlockPermissions.svelte: it is the one permission that is a yes or a no, so
  // it has to stay readable while the chip is shut.
  import FlockCard from './FlockCard.svelte';
  import FlockChip from './FlockChip.svelte';
  import FlockDeskTile from './FlockDeskTile.svelte';
  import FlockIdentity from './FlockIdentity.svelte';
  import FlockInvite from './FlockInvite.svelte';
  import FlockPermissions from './FlockPermissions.svelte';
  import FlockSwitch from './FlockSwitch.svelte';
  import { iconOf } from '../panes/flockRows';
  import { scopeSummary, type ChipId } from '../panes/flockChips';
  import type { FlockPickedFolder, FlockScopeKind, FlockScopeOptions, FlockState } from '../panes/flockTypes';

  interface ModelOpt { value: string; name: string }
  interface ProviderStat { id: string; name: string; live: boolean; flavor?: 'lmstudio' | 'ollama' | 'other' }

  interface Props {
    state: FlockState;
    waiting: number;
    invite: string;
    inviteQr: string;
    modelOptions: ModelOpt[];
    providerStatus: ProviderStat[];
    scopeOptions: FlockScopeOptions;
    picked: FlockPickedFolder | null;
    /** Which chips are open. The pane owns it because it persists it. */
    open: Record<ChipId, boolean>;
    /** origamicoder.flock.enabled — the chips dim while off; the desk stays usable (`.side.off` below). */
    enabled: boolean;
    ontoggle: (id: ChipId) => void;
    oncopy: (text: string) => void;
    onpost: (msg: Record<string, unknown>) => void;
    onbrowse: (kind: FlockScopeKind) => void;
    onenabled: (enabled: boolean) => void;
  }
  let {
    state, waiting, invite, inviteQr, modelOptions, providerStatus, scopeOptions, picked, enabled,
    open, ontoggle, oncopy, onpost, onbrowse, onenabled }: Props = $props();

  let identityLine = $derived(state.specialties.join(', ') || state.availability || 'No specialty card yet');
</script>

<aside class="side" class:off={!enabled}>
  <FlockDeskTile
    frontDesk={state.frontDesk}
    {waiting}
    path={state.frontDeskPath}
    answers={state.answers}
    {modelOptions}
    {providerStatus}
    {enabled}
    {onenabled}
    onfrontdesk={(patch) => onpost({ type: 'flockFrontDesk', ...patch })}
  />

  <FlockChip
    id="identity"
    icon="fk-id"
    glyph={iconOf(state.identity)}
    title={state.identity.name || 'Your identity'}
    summary={identityLine}
    open={open.identity}
    ontoggle={() => ontoggle('identity')}
  >
    <FlockIdentity
      identity={state.identity}
      {oncopy}
      onidentity={(patch) => onpost({ type: 'flockSetIdentity', ...patch })}
    />
    <FlockCard
      specialties={state.specialties}
      availability={state.availability}
      onsave={(specialties) => onpost({ type: 'flockSetSpecialties', specialties })}
    />
  </FlockChip>

  <FlockChip
    id="invite"
    icon="fk-plus"
    title="Invite"
    summary="48 h · single use"
    open={open.invite}
    ontoggle={() => ontoggle('invite')}
  >
    <FlockInvite
      {invite}
      {inviteQr}
      blocked={!state.frontDesk.model}
      oninvite={() => onpost({ type: 'flockInvite' })}
      onaccept={(text) => onpost({ type: 'flockAccept', invite: text })}
      {oncopy}
    />
  </FlockChip>

  <FlockChip
    id="permissions"
    icon="fk-shield"
    title="Default permissions"
    summary={scopeSummary(state.frontDesk.scope)}
    open={open.permissions}
    ontoggle={() => ontoggle('permissions')}
  >
    {#snippet head()}
      <FlockSwitch
        checked={state.frontDesk.autoAnswer === true}
        label="Answer without asking me"
        text=""
        onchange={(autoAnswer) => onpost({ type: 'flockFrontDesk', autoAnswer })}
      />
    {/snippet}
    <FlockPermissions
      frontDesk={state.frontDesk}
      options={scopeOptions}
      {picked}
      onfrontdesk={(patch) => onpost({ type: 'flockFrontDesk', ...patch })}
      {onbrowse}
    />
  </FlockChip>
</aside>

<style>
  .side { display: flex; flex-direction: column; gap: 12px; min-height: 0; overflow-y: auto; }
  /* Off: the chips dim, not the desk (`.fk-tile`) — its fields and switch stay usable. */
  .side.off > :global(:not(.fk-tile)) { opacity: 0.4; pointer-events: none; }
</style>
