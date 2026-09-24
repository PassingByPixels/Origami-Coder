<script lang="ts">
  // THE RELAY CARD, and the point of the whole page: the address field is the
  // moment a person decides whose relay to trust, so everything that answers
  // "what does that person learn about me" sits directly under it — the
  // picture, then the two rows, verbatim from the design (reports/
  // remote_control_design_2026-09-02.md section 3). It is not a tooltip and it
  // does not collapse.
  //
  // NO COMMAND, NO PORTS, NO PARAGRAPH. The first round of mockups printed the
  // self-host command with our own ports on it and the owner rejected the
  // round: an address, a picture, two rows and a link to the guide is the whole
  // card.
  //
  // The draft lives HERE rather than in the pane because the field is the only
  // editable thing on this page, and its one rule — a broadcast caused by some
  // other control must not wipe a URL half-typed into the box — is a rule about
  // this field alone.
  import { untrack } from 'svelte';
  import RemoteRelayDiagram from './RemoteRelayDiagram.svelte';
  import { REMOTE_ICON_RELAY } from './remoteIcons';
  import { REMOTE_SELF_HOST_URL } from './remoteLinks';

  interface Props {
    /** The URL the HOST last reported. Re-seeds the box unless it is dirty. */
    relayUrl: string;
    onsave: (url: string) => void;
  }
  let { relayUrl, onsave }: Props = $props();

  let draft = $state('');
  let dirty = $state(false);
  // Depends on `relayUrl` ALONE — `dirty` is read inside untrack. Without that
  // the effect re-runs the moment Save clears the flag and puts the previous
  // host value back into a box the user just committed.
  $effect(() => {
    const url = relayUrl;
    untrack(() => {
      if (!dirty) draft = url;
    });
  });

  function save(): void {
    dirty = false;
    onsave(draft);
  }
</script>

<section class="card" data-name="relay">
  <div class="card-head">
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">{@html REMOTE_ICON_RELAY}</svg>
    <span class="caps">Relay</span>
  </div>
  <div class="relay-row">
    <input
      class="inp mono" aria-label="Relay address" placeholder="wss://relay.origamilabs.nl"
      bind:value={draft} oninput={() => (dirty = true)}
    />
    <button class="btn" disabled={!dirty} onclick={save}>Save</button>
  </div>

  <RemoteRelayDiagram />

  <table class="remote-relay-table">
    <tbody>
      <tr class="sees"><th>Sees</th><td>A random rendezvous id, connect and disconnect times, padded frame counts</td></tr>
      <tr class="not"><th>Does not see</th><td>Prompts, replies, file paths, diffs, tool names, repo names, model names, who the user is</td></tr>
    </tbody>
  </table>

  <p class="links">
    <a class="rx-link" href={REMOTE_SELF_HOST_URL} target="_blank" rel="noopener">Run your own relay — guide</a>
  </p>
</section>

<style>
  .card {
    background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 16px;
    display: flex; flex-direction: column; gap: 8px; min-width: 0;
  }
  .card-head { display: flex; align-items: center; gap: 8px; }
  .caps {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-muted);
    font-weight: 600; flex: 1; min-width: 0;
  }
  .ico {
    width: 16px; height: 16px; flex: 0 0 auto; color: var(--og-text-muted); stroke: currentColor; fill: none;
    stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round;
  }
  .relay-row { display: flex; gap: 8px; }
  .inp {
    font: inherit; font-size: 11.5px; padding: 5px 8px; flex: 1; min-width: 0; background: var(--og-input-bg);
    color: var(--og-text); border: 1px solid var(--og-input-border); border-radius: 5px;
  }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
  .btn {
    font: inherit; font-size: 11.5px; padding: 5px 12px; border-radius: 5px; cursor: pointer;
    white-space: nowrap; background: var(--og-btn-bg); color: var(--og-btn-text); border: 1px solid var(--og-border);
  }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .remote-relay-table { width: 100%; border-collapse: collapse; }
  .remote-relay-table th, .remote-relay-table td {
    text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--og-border); vertical-align: top;
    line-height: 1.45;
  }
  .remote-relay-table th {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; white-space: nowrap;
    width: 104px;
  }
  .remote-relay-table tr:last-child th, .remote-relay-table tr:last-child td { border-bottom: none; }
  .remote-relay-table .sees th { color: var(--og-success); }
  .remote-relay-table .not th { color: var(--og-text-muted); }
  .remote-relay-table td { color: var(--og-text-secondary); }
  .links { margin: 0; display: flex; gap: 16px; flex-wrap: wrap; }
  .rx-link { color: var(--og-accent-2); text-decoration: underline; }
</style>
