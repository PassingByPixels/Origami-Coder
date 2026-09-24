<script lang="ts">
  // THE DESK'S DEFAULTS — what the front desk may touch when it answers.
  //
  // A BODY, NOT A TILE, since the messenger wave: the pane hangs it in a
  // FlockChip and a card inside a card is two borders saying one thing.
  //
  // THE SWITCH IS THE CHIP'S HEAD, and it is drawn by the pane rather than
  // here. It is the one permission that is a yes or a no, so it reads as the
  // chip's state and has to stay on screen while the chip is shut; everything
  // in this file is what that yes is allowed to reach.
  //
  // PER-CONTACT OVERRIDES ARE NOT HERE ANY MORE. They were a fold at the bottom
  // of this body, one row per contact, headed by a count of how many of them
  // were off the defaults. That put a decision about ONE person in the panel
  // about EVERYONE, which is the wrong place to read it and the wrong place to
  // make it: the owner is looking at a contact when they want to change what
  // that contact may see. It moved to the Edit control in that contact's own
  // thread head — FlockContactScope.svelte — and this file is the defaults and
  // nothing else, which is why it is now three lines of wire around one picker.
  import FlockScopePicker from './FlockScopePicker.svelte';
  import type { FlockFrontDeskState, FlockPickedFolder, FlockScopeKind, FlockScopeOptions } from '../panes/flockTypes';

  interface Props {
    frontDesk: FlockFrontDeskState;
    options: FlockScopeOptions;
    /** A folder the host's picker just returned, with a nonce so the same path
     *  twice is still two picks. `target` says whose picker asked for it — a
     *  contact's popover is the other one, and this must ignore those. */
    picked: FlockPickedFolder | null;
    onfrontdesk: (patch: Record<string, unknown>) => void;
    onbrowse: (kind: FlockScopeKind) => void;
  }
  let { frontDesk, options, picked, onfrontdesk, onbrowse }: Props = $props();

  let appliedPick = $state(0);

  let scope = $derived({
    repos: frontDesk.scope?.repos ?? [],
    wiki: frontDesk.scope?.wiki ?? [],
    folders: frontDesk.scope?.folders ?? [],
  });

  // The host answers a browse asynchronously, so the pick lands as a prop.
  $effect(() => {
    if (!picked || picked.nonce === appliedPick || picked.target !== '') return;
    appliedPick = picked.nonce;
    onfrontdesk({ scope: { ...scope, [picked.kind]: [...new Set([...scope[picked.kind], picked.path])] } });
  });
</script>

<p class="fk-muted">
  These are the defaults every contact starts from. Off means every question waits at the Front Desk.
  Nothing is shared until it is ticked. Edit on a contact adds to or reduces this for that contact alone.
</p>

<FlockScopePicker
  id="defaults"
  {scope}
  {options}
  onchange={(next) => onfrontdesk({ scope: next })}
  {onbrowse}
/>
