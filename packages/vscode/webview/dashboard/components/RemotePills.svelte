<script lang="ts">
  // The STATUS HEADER: every fact the Remote pane knows about itself, said once,
  // above everything else.
  //
  // The pane this replaces made you read three sections to learn whether a phone
  // was attached — the connection block said "Paired and connected", the devices
  // block said which one, and the relay block said where. One strip says all of
  // it, and a colour carries the tone so the state is legible before the words
  // are read.
  //
  // `connecting` is drawn as a WAITING pill: a pairing exists but the socket
  // does not, so a green pill would say the phone can reach this machine.
  //
  // `pending` is NOT a device. A code is on screen and the desktop's own socket
  // to the relay is up so the phone can find it, but no phone has answered, so
  // the strip says "waiting for a phone" and the device count stays at none.
  // `other-window` is not a device HERE either: the pairing is real, but another
  // window holds the socket, so a device count would claim the phone is reading
  // THIS window's chat when it is not.
  import { ago, deviceLabel, relayHost } from './remoteFormat';
  import { REMOTE_ICON_PHONE, REMOTE_ICON_RELAY, REMOTE_ICON_SHIELD } from './remoteIcons';

  interface Props {
    connection: 'off' | 'unpaired' | 'pending' | 'other-window' | 'connecting' | 'paired';
    deviceName: string;
    rid: string | null;
    lastSeen: number | null;
    relayUrl: string;
    /** The desk's envelope, which took the shield pill from the retired
     *  approvals policy: it is all that bounds a phone now. */
    capability: 'watch' | 'ask' | 'full';
  }
  let { connection, deviceName, rid, lastSeen, relayUrl, capability }: Props = $props();
  const ENVELOPE: Record<string, string> = { watch: 'Watch', ask: 'Ask', full: 'Full' };
  let attached = $derived(connection === 'paired' || connection === 'connecting');
  let label = $derived(deviceLabel(deviceName, rid));
</script>

<div class="pills">
  {#if connection === 'off'}
    <span class="pill off" data-state="off"><span class="dot"></span><b>Off</b></span>
  {:else if connection === 'unpaired'}
    <span class="pill wait" data-state="unpaired"><span class="dot"></span><b>On</b> · not paired</span>
  {:else if connection === 'pending'}
    <span class="pill wait" data-state="pending"><span class="dot"></span><b>On</b> · waiting for a phone</span>
  {:else if connection === 'other-window'}
    <span class="pill wait" data-state="other-window">
      <span class="dot"></span><b>Paired</b> · active in another window
    </span>
  {:else if connection === 'connecting'}
    <span class="pill wait" data-state="connecting">
      <span class="dot"></span><b>Paired</b> · <span class="mono">{label}</span> · reconnecting
    </span>
  {:else}
    <span class="pill ok" data-state="paired">
      <span class="dot"></span><b>Paired</b> · <span class="mono">{label}</span> · {ago(lastSeen)}
    </span>
  {/if}

  <span class="pill">
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">{@html REMOTE_ICON_RELAY}</svg>
    <span class="mono">{relayHost(relayUrl)}</span>
  </span>
  <span class="pill">
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">{@html REMOTE_ICON_SHIELD}</svg>
    {ENVELOPE[capability] ?? 'Full'}
  </span>
  {#if attached}
    <span class="pill">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">{@html REMOTE_ICON_PHONE}</svg><b>1</b> device
    </span>
  {:else}
    <span class="pill"><span class="dot"></span>No device</span>
  {/if}
</div>

<style>
  .pills { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .pill {
    display: inline-flex; align-items: center; gap: 8px; padding: 4px 10px; border-radius: 999px;
    border: 1px solid var(--og-border); background: var(--og-surface-alt); font-size: 11.5px;
    color: var(--og-text-secondary); white-space: nowrap;
  }
  .pill b { color: var(--og-text); font-weight: 600; }
  .pill .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--og-text-muted); flex: 0 0 auto; }
  .pill.ok { background: var(--og-success-soft); border-color: transparent; color: var(--og-success-text); }
  .pill.ok .dot { background: var(--og-success); }
  .pill.ok b { color: var(--og-success-text); }
  /* Waiting is a BORDER, not a fill: it must not read as an achieved state, and
     the pulse is the only motion on the page. */
  .pill.wait { background: var(--og-surface-alt); border-color: var(--og-status-waiting); color: var(--og-text); }
  .pill.wait .dot { background: var(--og-status-waiting); animation: remote-pulse 1.8s ease-in-out infinite; }
  @keyframes remote-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
  .ico {
    width: 13px; height: 13px; flex: 0 0 auto; stroke: currentColor; fill: none; stroke-width: 1.5;
    stroke-linecap: round; stroke-linejoin: round;
  }
</style>
