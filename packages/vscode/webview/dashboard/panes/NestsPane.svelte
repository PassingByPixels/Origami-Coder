<script lang="ts">
  // Nests — the Agent Manager view that joins the owner's desks (t-s9jr6u;
  // mock rounds 4-6). Rail item directly after Remote.
  //
  // THE HARD SWITCH is the first control and it is OFF by default
  // (`origamicoder.nests.enabled`). Off, the view says what the feature does
  // and that nothing dials the relay, and shows nothing else: no desk list, no
  // storage, no config. On, it holds Desks, Storage and Config, top to bottom.
  //
  // This pane owns the groupData wire: one listener, one snapshot handed to the
  // three cards, so the Desks list, the Storage tabs and the Config select can
  // never disagree about which desks exist. The host (groupPane.ts) pushes a
  // fresh snapshot when a desk joins, says hello or drops off.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import OnOffSwitch from '../components/OnOffSwitch.svelte';
  import NestDesks from '../components/NestDesks.svelte';
  import NestStorage from '../components/NestStorage.svelte';
  import NestsConfig from '../components/NestsConfig.svelte';
  import NestsSecurity from '../components/NestsSecurity.svelte';
  import NestsHelp from '../components/NestsHelp.svelte';
  import { joinedDesk, nestsSummary, readDesks, readTail, type NestDesk, type NestTailState } from '../components/nestsStatus';
  import { readJoinCheck, type JoinCheck } from '../components/nestJoinCheck';

  const vscode = getVsCodeApi();
  let loaded = $state(false);
  let enabled = $state(false);
  let desks: NestDesk[] = $state([]);
  let inviteKey: string | null = $state(null);
  let inviteQr = $state('');
  let inviteExpiresAt: number | null = $state(null);
  let joinCheck: JoinCheck | null = $state(null); // t-sj32zl: the Accept step, on either desk
  let joinNotice: string | null = $state(null);
  let error: string | null = $state(null);
  let relayUrl = $state('wss://relay.origamilabs.nl');
  let self = $state({ name: 'This desk', os: '' });
  let joined: NestDesk | null = $state(null);
  let seq = $state(0);
  let tail: NestTailState | null = $state(null); // t-selspn: the mother base's tail, from groupData and each nest index push

  $effect(() => {
    const onMsg = (event: MessageEvent) => {
      const msg = event.data || {};
      if (msg.type === 'origami/nestIndex' || msg.type === 'groupData') tail = readTail(msg.tail);
      if (msg.type !== 'groupData') return;
      const next = readDesks(msg.devices);
      const nextKey = typeof msg.inviteKey === 'string' ? msg.inviteKey : null;
      joined = joinedDesk({ inviteKey, desks }, { inviteKey: nextKey, desks: next }) ?? (nextKey ? null : joined);
      desks = next;
      inviteKey = nextKey;
      inviteQr = typeof msg.inviteQr === 'string' ? msg.inviteQr : '';
      inviteExpiresAt = typeof msg.inviteExpiresAt === 'number' ? msg.inviteExpiresAt : null;
      joinCheck = readJoinCheck(msg.joinCheck);
      joinNotice = typeof msg.joinNotice === 'string' ? msg.joinNotice : null;
      error = typeof msg.error === 'string' ? msg.error : null;
      enabled = msg.nestsEnabled === true;
      if (typeof msg.relayUrl === 'string') relayUrl = msg.relayUrl;
      if (msg.self && typeof msg.self.name === 'string') self = { name: msg.self.name, os: String(msg.self.os ?? '') };
      loaded = true;
      seq += 1;
    };
    window.addEventListener('message', onMsg);
    vscode.postMessage({ type: 'groupRequest' });
    return () => window.removeEventListener('message', onMsg);
  });

  function toggle(next: boolean): void {
    vscode.postMessage({ type: 'groupSetEnabled', enabled: next });
  }
</script>

<div class="nests-pane">
  <div class="bar">
    <span class="title">Nests</span>
    <NestsHelp />
    <span class="sum">{#if enabled && desks.length}<span class="dot"></span>{/if}{loaded ? nestsSummary(enabled, desks) : ''}</span>
    <span class="grow"></span>
    <OnOffSwitch checked={enabled} label="Nests on or off" onchange={toggle} />
  </div>
  <div class="scroll">
    <div class="col">
      {#if !enabled}
        <p class="pitch">
          Nests joins your desks through the relay so a chat started on one continues on another.<br />
          <span class="muted">Nothing dials the relay until you turn this on.</span>
        </p>
        {#if error}<p class="err" role="alert">{error}</p>{/if}
      {:else}
        <NestDesks {desks} {inviteKey} {inviteQr} {inviteExpiresAt} {joinCheck} {joinNotice} {error} {joined} {seq} {tail} onDismissJoined={() => (joined = null)} />
        <NestStorage {desks} selfName={self.name} />
        <NestsConfig {desks} {self} {relayUrl} />
      {/if}
      <!-- Shown off too: the owner reads how a nest is kept safe BEFORE turning it on. -->
      <NestsSecurity />
    </div>
  </div>
</div>

<style>
  .nests-pane { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--og-text); font-size: 11.5px; line-height: 1.4; }
  /* The Insights toolbar pattern: caps title, one muted status, the control at the right. */
  .bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--og-border); flex-shrink: 0; }
  .title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-secondary); }
  .sum { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--og-text-muted); }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; background: var(--og-success); }
  .grow { flex: 1 1 auto; }
  .scroll { flex: 1; overflow-y: auto; min-height: 0; }
  .col { max-width: 760px; padding: 10px 12px 24px; display: flex; flex-direction: column; gap: 12px; }
  .pitch { margin: 4px 0 0; font-size: 12px; line-height: 1.55; color: var(--og-text-secondary); max-width: 560px; }
  .muted { color: var(--og-text-muted); }
  .err { margin: 0; font-size: 10.5px; color: var(--og-error-text); }
</style>
