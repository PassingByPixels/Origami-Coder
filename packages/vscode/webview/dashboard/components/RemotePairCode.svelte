<script lang="ts">
  // The code box: the tall panel filling the rest of the Pair card, in
  // whichever of its three faces pairing is currently in. It never goes
  // blank — a live code shows the square and its clock, an attached phone
  // shows which one and when it last spoke, and nothing paired shows what
  // pressing the button will do.
  //
  // The QR is black on white and stays that way (some phone cameras refuse a
  // themed one). The SVG comes host-side from src/remote/qr.ts, rendered
  // with {@html} — static markup generated from a secret this extension
  // generated itself, never anything a user or a relay supplied.
  import { onDestroy } from 'svelte';
  import { ago, deviceLabel } from './remoteFormat';
  import { REMOTE_ICON_LINK } from './remoteIcons';
  import { REMOTE_APP_URL } from './remoteLinks';

  interface Props {
    /** Inline SVG for the pairing code, or '' before the button is pressed. */
    svg: string;
    /** Epoch ms the code stops being accepted, from the host's own clock. */
    expiresAt: number;
    /** The relay's http(s) origin shown after a scan, so it can be compared by eye. */
    relayOrigin: string;
    /** True once a phone has answered — the summary face. */
    attached: boolean;
    deviceName: string;
    rid: string | null;
    device: { name: string; fp: string; platform: string; app: string; backend: string } | null;
    lastSeen: number | null;
    /** The window the clock counts down from. */
    windowMs?: number;
  }
  let { svg, expiresAt, relayOrigin, attached, deviceName, rid, device, lastSeen, windowMs = 60_000 }: Props = $props();

  let now = $state(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;

  // Ticked from a local timer, not a host-pushed countdown: the host need
  // not send sixty messages, and a slept tab catches up on its next frame.
  $effect(() => {
    if (!svg || !expiresAt) return;
    clearInterval(timer);
    now = Date.now();
    timer = setInterval(() => (now = Date.now()), 250);
    return () => clearInterval(timer);
  });
  onDestroy(() => clearInterval(timer));

  let secondsLeft = $derived(svg && expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0);
  let live = $derived(!!svg && secondsLeft > 0);
  let expired = $derived(!!svg && secondsLeft === 0);
  /** m:ss — a minute-long window reads as a clock, never as "52". */
  let clock = $derived(`${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`);
  let seconds = $derived(Math.round(windowMs / 1000));
  let meta = $derived([device?.platform ?? '', device?.app ?? ''].filter((s) => s.trim()).join(' · '));
</script>

<div class="code">
  {#if live}
    <span class="qr" role="img" aria-label="Pairing code">{@html svg}</span>
    {#if relayOrigin}
      <span class="relay-check"><code>{relayOrigin}</code><span class="note dim">This must match the relay the app shows after the scan.</span></span>
    {/if}
    <span class="caps live"><span class="dot"></span>A code is live · expires in {clock}</span>
  {:else}
    <!-- The code's footprint stays even with no code: the box is the
         tallest thing in the column, and the square is what the eye seeks. -->
    <span class="qr ghost" aria-hidden="true"><span class="ghost-say">the code appears here</span></span>
  {/if}

  {#if !live && attached}
    <div class="said">
      <span class="caps">The paired phone</span>
      <span class="who">{deviceLabel(deviceName, rid)}</span>
      {#if meta}<span class="kmeta">{meta}</span>{/if}
      <span class="kmeta">last seen {ago(lastSeen)}</span>
    </div>
  {:else if !live}
    <span class="caps">{expired ? 'The code expired. Show a new one to pair.' : 'How pairing goes'}</span>
  {/if}

  <ol class="steps">
    <li>
      <b>1</b><span>Open <a class="applink" href={REMOTE_APP_URL} target="_blank" rel="noopener" title="Origami Remote for iPhone">Origami Remote<svg class="ico xs" viewBox="0 0 24 24" aria-hidden="true">{@html REMOTE_ICON_LINK}</svg></a><span class="soon" title="Not on the App Store yet">coming soon</span> on the phone.</span>
    </li>
    <li><b>2</b><span>Scan this code. It carries the relay address, so you type nothing.</span></li>
    <li><b>3</b><span>The phone proves its key and this pane lists it under Your phone.</span></li>
  </ol>

  <span class="note dim">
    {#if live}
      The code expires after {seconds} seconds if no phone scans it. A new code replaces the paired phone.
    {:else if attached}
      Pair another phone to show a fresh code. The new phone takes this one's place.
    {:else}
      Pair a phone to show a code. It expires after {seconds} seconds if no phone scans it.
    {/if}
  </span>
</div>

<style>
  .code {
    display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
    gap: 14px; padding: 18px 16px; border: 1px solid var(--og-border); border-radius: 5px;
    background: var(--og-surface-alt); margin-top: 2px; min-width: 0;
  }
  /* The one literal colour on this board, and the reason the file sits outside
     the theme-vars list: a scannable QR needs real white behind real black.
     220px, for 200px OF SVG. The real pairing URL is 103 bytes, which the
     encoder puts at version 6: 41 modules plus the SVG's own 4-module quiet
     zone each side = a 49-module span, so 200px is 4.1 CSS px per module and
     168 would be 3.4 — under what a phone camera resolves comfortably at arm's
     length. theme.css resets everything to BORDER-BOX, so the 10px padding
     comes OUT of the declared width and the box has to be 220 to leave 200; the
     rule this replaces declared 200 with 8px of padding and really drew 184.
     The padding is white too, so it reads as extra quiet zone. */
  .qr { width: 220px; max-width: 100%; aspect-ratio: 1; flex: 0 0 auto; background: #ffffff; border-radius: 8px; padding: 10px; }
  .qr :global(svg) { display: block; width: 100%; height: 100%; }
  .qr.ghost { background: none; border: 1px dashed var(--og-border); display: grid; place-items: center; }
  .ghost-say { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-muted); font-weight: 600; max-width: 130px; line-height: 1.4; }
  .caps {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-muted);
    font-weight: 600;
  }
  .live { display: inline-flex; align-items: center; gap: 6px; color: var(--og-success); }
  .live .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--og-success); display: inline-block; }
  /* The relay origin, for a by-eye compare against what the app shows after
     scanning. `code` for the string that must match; the sentence beneath it
     stays a plain `.note`. */
  .relay-check { display: flex; flex-direction: column; gap: 2px; max-width: 220px; word-break: break-all; }
  .relay-check code { font-size: 11px; color: var(--og-text); }
  .said { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .said .who { font-weight: 600; font-size: 11.5px; color: var(--og-text); word-break: break-all; }
  .said .kmeta { color: var(--og-text-secondary); }
  .steps {
    list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px;
    text-align: left; max-width: 300px;
  }
  .steps li { display: flex; gap: 10px; align-items: flex-start; line-height: 1.45; }
  .steps b {
    flex: 0 0 18px; height: 18px; border-radius: 50%; background: var(--og-surface-alt);
    border: 1px solid var(--og-border); font-size: 10px; display: inline-flex; align-items: center;
    justify-content: center; color: var(--og-text-secondary);
  }
  .applink {
    color: var(--og-text); font-weight: 600; text-decoration: none;
    border-bottom: 1px dotted var(--og-text-muted); display: inline-flex; align-items: center; gap: 4px;
  }
  .applink:hover { border-bottom-color: var(--og-text); }
  .soon { font-size: 9px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--og-accent); border: 1px solid var(--og-accent); border-radius: 8px; padding: 0 5px; margin-left: 5px; vertical-align: 1px; } /* drop when the App Store listing is live */
  .ico.xs {
    width: 11px; height: 11px; color: var(--og-text-muted); stroke: currentColor; fill: none;
    stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
  }
  .note { margin: 0; color: var(--og-text-secondary); }
  .note.dim { color: var(--og-text-muted); max-width: 300px; }
</style>
