<script lang="ts">
  // Remote pane — pair a phone to this machine, in the shape the owner picked
  // (mock F2, Downloads/remote-ui-mockups/f2-candidate.html).
  //
  // SHAPE: a status strip, then one grid. The story card carries the argument
  // and the master switch; the pair column runs the full height beside it,
  // because the code is 200px square whatever else is on the page; the two
  // reference cards sit under the story. Five stacked sections preceded this
  // and made you read three of them to learn whether a phone was attached.
  //
  // Nothing on this page is an engine read. Origami Remote is entirely an
  // extension-host feature: the settings are VS Code's, the pairing secret is
  // the OS keychain's, and the socket belongs to the controller `activateRemote`
  // owns. So every value here arrives in one `remoteData` broadcast from
  // src/dashboard/remotePane.ts and every control posts back to it — there is no
  // optimistic local state, because a settings write can fail silently (a
  // policy-locked setting, a read-only settings file) and a toggle stuck ON
  // would be telling the owner their phone can reach them when it cannot.
  //
  // `modes` (which chats a phone put into YOLO) is carried in the payload and
  // drawn NOWHERE here: the envelope pill is all this page says about privilege,
  // and the chat's own surface owns the rest. The field stays on the wire so the
  // pill's data path is one broadcast, not two.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import RemoteDeviceRow from '../components/RemoteDeviceRow.svelte';
  // The device group card (t-rz1b14) moved to the Nests view (t-s9jr6u): it is
  // the Desks card there, behind the Nests switch. This pane is the phone's.
  import RemoteHero from '../components/RemoteHero.svelte';
  import RemotePills from '../components/RemotePills.svelte';
  import RemoteRelay from '../components/RemoteRelay.svelte';
  import RemoteStory from '../components/RemoteStory.svelte';
  import { isKeyFoldOpen, withKeyFold } from '../components/remoteFoldState';
  import { REMOTE_ICON_PHONE } from '../components/remoteIcons';
  const vscode = getVsCodeApi();

  interface RemoteData {
    enabled: boolean;
    relayUrl: string;
    connection: 'off' | 'unpaired' | 'pending' | 'other-window' | 'connecting' | 'paired';
    rid: string | null;
    /** What the OWNER called this phone, or ''. The phone never sends one. */
    deviceName: string;
    device: { name: string; fp: string; platform: string; app: string; backend: string; session: 'off' | 'on' | 'old-app' } | null;
    capability: 'watch' | 'ask' | 'full';
    modes: Array<{ sessionId: string; mode: string; device: string; fp: string; at: number }>;
    pairedAt: number | null;
    lastSeen: number | null;
    detail: string;
    error?: string;
  }

  let data: RemoteData | null = $state(null);
  let qrSvg = $state(''); let qrExpiresAt = $state(0);
  /** The relay's http(s) origin, in the SAME form the app shows after a scan
   *  — so the owner can compare the two by eye. Posted alongside the QR by
   *  `relayHttpUrl`, never re-derived here from the setting string. */
  let relayOrigin = $state('');
  let folds: unknown = $state(vscode.getState());

  function load(): void {
    vscode.postMessage({ type: 'remoteRequest' });
  }

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type === 'remoteQr') {
      qrSvg = typeof msg.svg === 'string' ? msg.svg : '';
      qrExpiresAt = typeof msg.expiresAt === 'number' ? msg.expiresAt : 0;
      relayOrigin = typeof msg.relayOrigin === 'string' ? msg.relayOrigin : '';
      return;
    }
    if (msg.type !== 'remoteData') return;
    data = msg as RemoteData;
  });

  load();

  function setEnabled(on: boolean): void {
    // Switching OFF also revokes host-side. Said on the switch's own tooltip,
    // because it is the one thing about it that is not obvious.
    qrSvg = ''; relayOrigin = '';
    vscode.postMessage({ type: 'remoteSetEnabled', enabled: on });
  }
  function saveRelay(url: string): void {
    vscode.postMessage({ type: 'remoteSetRelayUrl', url });
  }
  function pair(): void {
    qrSvg = ''; relayOrigin = '';
    vscode.postMessage({ type: 'remotePair' });
  }
  /** Point the phone at THIS window. The window that had it stands down on its
   *  own next heartbeat; the relay's one-socket rule does the eviction. */
  function takeOver(): void {
    vscode.postMessage({ type: 'remoteTakeOver' });
  }
  function revoke(): void {
    qrSvg = ''; relayOrigin = '';
    vscode.postMessage({ type: 'remoteRevoke' });
  }
  /** Naming is desktop-side and goes nowhere near the wire: the rid is sent
   *  back so the host keeps the name against the pairing it belongs to, not
   *  against whatever is paired by the time the message lands. */
  function rename(rid: string, name: string): void {
    vscode.postMessage({ type: 'remoteSetDeviceName', rid, name });
  }
  /** The fingerprint fold, remembered per pairing. The bag is RE-READ here
   *  rather than trusted from mount: every pane on this board writes its own
   *  key into the same `setState` object, and a stale copy would drop theirs. */
  function foldKey(open: boolean): void {
    const next = withKeyFold(vscode.getState(), data?.rid ?? null, open);
    vscode.setState(next);
    folds = next;
  }

  let connection = $derived(data?.connection ?? 'off');
  // NB `pending` has a rid AND an open socket and is still not a device.
  let attached = $derived(connection === 'paired' || connection === 'connecting');
  let enabled = $derived(data?.enabled === true);
  // Nothing pushes host state in here (onRemoteChange has no subscriber,
  // DashboardPanel.post is private), so while a code shows, ask again.
  $effect(() => {
    if (connection !== 'pending') return;
    const poll = setInterval(load, 2_000);
    return () => clearInterval(poll);
  });
  let capability = $derived(data?.capability ?? 'full');
  let deviceName = $derived(data?.deviceName ?? '');
  let keyOpen = $derived(isKeyFoldOpen(folds, data?.rid ?? null));
  // WIRE v1.3. `on` means this socket's frames are sealed with K', the key both
  // ends derived from an ECDH with the enrolled Secure Enclave key — so a
  // copied Ks opens nothing the relay's ring replays. The two `off` readings
  // are the cases that do not close the hole and must not look as if they do:
  // an app that predates v1.3, and a page that enrolled no key at all.
  let sessionKey = $derived(
    !data?.device ? 'off (no device key)'
    : data.device.session === 'on' ? 'on'
    : data.device.session === 'old-app' ? 'off (old app)'
    : 'off',
  );
</script>

<div class="remote-pane" class:off={!enabled}>
  <div class="pane-title">
    <h1><span class="big">Origami Remote</span></h1>
    <span class="sub">Your phone reads and drives this session. Every command runs on this desktop.</span>
    <button class="quiet" onclick={load} title="Re-read the settings and the connection">Refresh</button>
  </div>

  {#if data?.error}<div class="remote-error" role="alert">{data.error}</div>{/if}

  <RemotePills {connection} {deviceName} rid={data?.rid ?? null} lastSeen={data?.lastSeen ?? null} relayUrl={data?.relayUrl ?? ''} {capability} />
  <!-- The controller's last status line, verbatim: it names the REAL failure
       ("rejected a frame (replay)"), which no pill can. -->
  {#if data?.detail}<p class="remote-detail">{data.detail}</p>{/if}

  <div class="top">
    <RemoteStory {enabled} onenabled={setEnabled} />

    <RemoteHero
      {connection}
      {deviceName}
      rid={data?.rid ?? null}
      device={data?.device ?? null}
      lastSeen={data?.lastSeen ?? null}
      {qrSvg}
      {qrExpiresAt}
      {relayOrigin}
      onpair={pair}
      ontakeover={takeOver}
    />

    <div class="mid">
      <section class="card" data-name="your phone">
        <div class="card-head">
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">{@html REMOTE_ICON_PHONE}</svg><span class="caps">Your phone</span>
        </div>
        {#if attached && data?.rid}
          <RemoteDeviceRow
            {deviceName}
            rid={data.rid} device={data.device ?? null}
            pairedAt={data.pairedAt}
            lastSeen={data.lastSeen}
            {keyOpen}
            onkeyfold={foldKey}
            onrename={(name) => rename(data!.rid!, name)}
            onrevoke={revoke}
          />
        {:else}
          <p class="empty">No device is paired. One pairing at a time; a second phone needs a new code.</p>
        {/if}
        {#if attached && data?.rid}<p class="session">Session key: <b>{sessionKey}</b></p>{/if}
        <p class="note">
          The phone never sends a name — the pairing is anonymous by design, and the rendezvous id is
          the only handle it has. Name it here and the name stays on this machine, beside the id.
        </p>
      </section>

      <RemoteRelay relayUrl={data?.relayUrl ?? ''} onsave={saveRelay} />
    </div>
  </div>
</div>

<style>
  /* Three text sizes only — 10px small caps for a card head, 11.5px for every
     sentence, 26px for the one name the reader takes away — and an 8px spacing
     scale: 4 / 8 / 16 / 24. Both are the Labyrinth Flight page's, so these two
     rail panes cannot drift from the rest of the board. */
  /* THE PANE FILLS ITS HOST. The 1180px cap this replaces left a third of a
     1900px screen empty — the same fault the Flock pane had. The board body is
     a flex column with a real height, so `flex: 1` takes all of it. */
  .remote-pane {
    flex: 1; min-height: 0; padding: 16px 24px 40px; overflow-y: auto; color: var(--og-text);
    font-size: 11.5px; line-height: 1.5; container-type: inline-size;
  }
  .pane-title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .pane-title h1 { margin: 0; font-size: 11.5px; font-weight: 700; letter-spacing: 0.02em; }
  .pane-title .big { font-size: 26px; letter-spacing: -0.01em; }
  .pane-title .sub { color: var(--og-text-secondary); }
  .quiet { font: inherit; font-size: 11.5px; margin-left: auto; padding: 4px 10px; border-radius: 5px; cursor: pointer; background: var(--og-btn-bg); color: var(--og-text-secondary); border: 1px solid var(--og-border); }
  .remote-error { margin-top: 16px; padding: 8px 10px; border-radius: 6px; background: var(--og-surface); border: 1px solid var(--og-error); color: var(--og-error-text); }
  .remote-pane :global(.pills) { margin-top: 16px; }
  .remote-detail { margin: 8px 0 0; color: var(--og-text-muted); }

  /* THE GRID. Two columns, two rows: the story takes the wide cell, the pair
     column spans BOTH rows beside it, and the two reference cards sit under the
     story. `align-self: start` on the story is what stops the tall pair column
     stretching prose that does not need stretching. */
  .top {
    display: grid; grid-template-columns: 2fr 1fr; grid-template-rows: auto 1fr; gap: 16px;
    margin-top: 16px; align-items: stretch;
  }
  .top > :global(.story) { grid-column: 1; grid-row: 1; align-self: start; }
  .top > :global(.hero) { grid-column: 2; grid-row: 1 / 3; display: flex; flex-direction: column; }
  /* `start`, not `stretch`: with nothing paired the phone card is three lines
     and the relay card is a diagram plus a table, and a stretched short card is
     exactly the dead space this rebuild exists to remove. */
  .mid {
    grid-column: 1; grid-row: 2; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px; align-items: start;
  }
  /* CONTAINER, not viewport — the pane's width tracks VS Code's side panels. */
  @container (max-width: 1000px) {
    .top { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto; }
    .top > :global(.story), .top > :global(.hero), .mid { grid-column: 1; grid-row: auto; }
  }
  @container (max-width: 820px) { .mid { grid-template-columns: minmax(0, 1fr); } }

  /* OFF is not a different page. The three cards that only mean something while
     a socket can exist go quiet and stop taking clicks; the story card keeps its
     full contrast, because it is the thing still worth reading and it holds the
     switch that turns this back on. */
  .remote-pane.off :global(.hero), .remote-pane.off .mid { opacity: 0.45; pointer-events: none; }

  .card { background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 16px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .card-head { display: flex; align-items: center; gap: 8px; }
  .caps { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-muted); font-weight: 600; flex: 1; min-width: 0; }
  .ico { width: 16px; height: 16px; flex: 0 0 auto; color: var(--og-text-muted); stroke: currentColor; fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .note { margin: 0; color: var(--og-text-secondary); }
  .session { margin: 0; color: var(--og-text-muted); }
  .session b { color: var(--og-text); font-weight: 600; }
  .empty { margin: 0; color: var(--og-text-muted); font-style: italic; }
</style>
