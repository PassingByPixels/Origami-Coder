<script lang="ts">
  // PAIR A PHONE — the column that runs the full height of the page beside the
  // story, because pairing is the one thing the reader came here to do and the
  // code is 200px square whatever else is on screen.
  //
  // The card says WHERE the pairing stands in one line, says what pressing the
  // button will cost in one sentence, offers the button, and then hands the
  // rest of its height to the code box. The box is `flex: 1`, so the column has
  // no dead tail at any width — the fault two rounds of mockups were rejected
  // for.
  //
  // ONE PRIMARY ACTION. The accent fill is spent on the single button marked
  // `data-primary` and on nothing else in the pane; that is what makes the page
  // readable at a glance, and it is asserted rather than trusted.
  import RemotePairCode from './RemotePairCode.svelte';
  import { REMOTE_ICON_CHECK, REMOTE_ICON_PHONE } from './remoteIcons';

  interface Props {
    connection: 'off' | 'unpaired' | 'pending' | 'other-window' | 'connecting' | 'paired';
    deviceName: string;
    rid: string | null;
    device: { name: string; fp: string; platform: string; app: string; backend: string } | null;
    lastSeen: number | null;
    qrSvg: string;
    qrExpiresAt: number;
    /** The relay's http(s) origin, in the form the app shows after a scan. */
    relayOrigin: string;
    /** No argument: the pairing code is the whole gesture, nothing is typed. */
    onpair: () => void;
    ontakeover: () => void;
  }
  let { connection, deviceName, rid, device, lastSeen, qrSvg, qrExpiresAt, relayOrigin, onpair, ontakeover }: Props = $props();

  // `pending` is deliberately NOT attached: a code on screen with no phone
  // behind it must keep the code visible and the "a phone is paired" face away.
  let attached = $derived(connection === 'paired' || connection === 'connecting');
  // The pairing is real but ANOTHER window holds the relay socket. There is
  // nothing to scan here — the code would be for a pairing that already exists.
  let elsewhere = $derived(connection === 'other-window');
</script>

<section class="card hero" data-name="pair a phone">
  <div class="card-head"><span class="caps">Pair a phone</span></div>

  {#if elsewhere}
    <div class="hero-h">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">{@html REMOTE_ICON_PHONE}</svg>
      Remote is active in another window
    </div>
    <p class="note">Your phone is mirroring a different VS Code window. Take over to point it at this one instead.</p>
    <div class="hero-do"><button class="btn primary" data-primary onclick={ontakeover}>Take over</button></div>
  {:else}
    <div class="hero-h">
      {#if attached}<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">{@html REMOTE_ICON_CHECK}</svg>{/if}
      {attached ? 'A phone is paired' : 'No phone paired'}
    </div>
    <p class="note">
      {#if attached}
        Pairing another phone takes this one's place. The new phone scans a fresh code, and a phone that
        has forgotten its pairing needs one too.
      {:else}
        One phone at a time. Show a code, scan it with the Origami Remote app, and the phone appears
        under Your phone.
      {/if}
    </p>
    <div class="hero-do">
      <button class="btn primary" data-primary onclick={onpair}>{attached ? 'Pair another phone' : 'Pair a phone'}</button>
    </div>
    <RemotePairCode
      svg={qrSvg} expiresAt={qrExpiresAt} {relayOrigin} {attached} {deviceName} {rid} {device} {lastSeen}
    />
  {/if}
</section>

<style>
  .card {
    background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 16px;
    display: flex; flex-direction: column; gap: 8px; min-width: 0;
  }
  /* The hero is the one card with the accent border: it is the page's subject,
     and everything to its left is the argument for using it. */
  .hero { border-color: var(--og-accent); }
  .card-head { display: flex; align-items: center; gap: 8px; }
  .caps {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-muted);
    font-weight: 600; flex: 1; min-width: 0;
  }
  .hero-h { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
  .hero-h .ico { color: var(--og-success); }
  .ico {
    width: 16px; height: 16px; flex: 0 0 auto; stroke: currentColor; fill: none; stroke-width: 1.5;
    stroke-linecap: round; stroke-linejoin: round;
  }
  .note { margin: 0; color: var(--og-text-secondary); }
  .hero-do { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 2px; }
  .btn {
    font: inherit; font-size: 11.5px; padding: 5px 12px; border-radius: 5px; cursor: pointer;
    white-space: nowrap; background: var(--og-btn-bg); color: var(--og-btn-text); border: 1px solid var(--og-border);
  }
  .btn.primary { background: var(--og-accent); border-color: var(--og-accent); color: var(--og-text); font-weight: 600; }
  /* THE CODE BOX TAKES THE REST OF THE COLUMN. The hero spans both grid rows,
     so without this the card ends where its prose does and leaves a third of
     the page empty beside the two cards under the story. */
  .hero > :global(.code) { flex: 1; margin-top: 12px; }
</style>
