<script lang="ts">
  // "THE FLOCK IS RUNNING SOMEWHERE ELSE" — the one line this pane owed since
  // 0.4.83.
  //
  // Each VS Code window spawns its own engine, and `flock/service.ts` opens one
  // relay socket per friend per engine. The relay allows one socket per role per
  // rid, so two windows took each friend's slot from each other in a loop — and
  // the pane said nothing at all, so the owner saw a friends list that simply
  // did not answer. `flock-owner.json` decides which engine holds the links;
  // this is what the ones that do not say.
  //
  // NO TAKE-OVER BUTTON IN V1, deliberately, and the copy says why instead of
  // leaving a dead end: the hand-over is automatic and costs one heartbeat, so a
  // button would be a second way to do a thing that already happens. Origami
  // Remote's pane DOES have one, because there a person is choosing which window
  // their phone mirrors; here nobody is choosing anything.
  //
  // t-vbj03h: the banner NAMES the holder's pid (flock-owner.json), so the owner
  // can find that origami.exe in Task Manager and see which window runs it.
  interface Props {
    transport: 'relay' | 'other-engine' | 'none';
    holderPid?: number;
  }
  let { transport, holderPid }: Props = $props();
</script>

{#if transport === 'other-engine'}
  <div class="fk-elsewhere" role="status">
    <b>Flock is running in another window</b>
    <span>
      {holderPid === undefined ? 'An engine of another window' : `Engine process ${holderPid} (origami.exe)`}
      holds the links to your contacts. It is not an engine of this window, so this window does not
      ask or answer. Close the window that runs it. This window then takes over in a few seconds.
    </span>
  </div>
{/if}

<style>
  /* A WAITING border, not an error fill: nothing is broken, and a red banner
     for a working feature running one window over would be a lie. */
  .fk-elsewhere {
    display: flex; flex-direction: column; gap: 4px; margin-top: 16px; padding: 8px 16px;
    border-radius: 6px; border: 1px solid var(--og-status-waiting); background: var(--og-surface-alt);
  }
  .fk-elsewhere b { font-weight: 600; color: var(--og-text); }
  .fk-elsewhere span { color: var(--og-text-secondary); }
</style>
