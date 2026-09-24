<script lang="ts">
  // The paired device, and the one thing the owner asked for that the pairing
  // protocol cannot give: a NAME.
  //
  // The phone never sends one — the pairing is anonymous by design and the
  // rendezvous id is the only handle the wire carries. So the name is something
  // the DESKTOP was told, kept desktop-side against the rid, and shown beside
  // the rid rather than instead of it: the prefix is what matches the pairing,
  // the name is what makes it recognisable. Dropping the rid would take away the
  // only value that can be checked against the phone.
  //
  // The edit is inline rather than a dialog because naming a device is a
  // one-field afterthought to a pairing that already succeeded. Enter commits,
  // Escape abandons; no function key is bound (a webview must not take one).
  //
  // The device KEY (fingerprint, backend, platform, app) is a second block,
  // RemoteDeviceKey.svelte, drawn under this row when the paired phone has
  // enrolled one. Read-only identity beside an editable name: two jobs. Its
  // fold state is the PANE's (that is where the persisted state bag is), so it
  // passes straight through here.
  import RemoteDeviceKey from './RemoteDeviceKey.svelte';
  import { ago, avatarInitials, deviceLabel, ridPrefix, DEVICE_NAME_MAX } from './remoteFormat';
  import { REMOTE_ICON_PENCIL } from './remoteIcons';

  interface Props {
    deviceName: string;
    rid: string;
    /** The enrolled device key, or null when the pairing has none. */
    device: { name: string; fp: string; platform: string; app: string; backend: string } | null;
    /** Whether the key's fingerprint fold stands open, and how to persist it. */
    keyOpen: boolean;
    onkeyfold: (open: boolean) => void;
    pairedAt: number | null;
    lastSeen: number | null;
    onrename: (name: string) => void;
    onrevoke: () => void;
  }
  let { deviceName, rid, device, pairedAt, lastSeen, keyOpen, onkeyfold, onrename, onrevoke }: Props = $props();

  let editing = $state(false);
  let draft = $state('');

  function start(): void {
    draft = deviceName;
    editing = true;
  }
  // Escape closes the box, which BLURS it, which would otherwise commit the
  // draft the user just abandoned. Clearing `editing` first is what makes the
  // blur a no-op — the guard is the whole reason this is not one line.
  function commit(): void {
    if (!editing) return;
    editing = false;
    // Sent even when it is the same string: the host is the only thing that
    // decides what was kept, and a webview that skipped the post would be
    // deciding on its behalf.
    onrename(draft.trim());
  }
  function key(e: KeyboardEvent): void {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') editing = false;
  }
</script>

<div class="row">
  <span class="avatar">{avatarInitials(deviceName, rid)}</span>
  <span class="grow">
    {#if editing}
      <input
        class="inp name-edit"
        aria-label="Device name"
        maxlength={DEVICE_NAME_MAX}
        placeholder="Name this phone"
        bind:value={draft}
        onkeydown={key}
        onblur={commit}
      />
    {:else}
      <span class="name" class:mono={!deviceName.trim()}>{deviceLabel(deviceName, rid)}</span>
      <button class="icon-btn" title="Rename this device" aria-label="Rename this device" onclick={start}>
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">{@html REMOTE_ICON_PENCIL}</svg>
      </button>
      {#if deviceName.trim()}<span class="rid mono">{ridPrefix(rid)}</span>{/if}
    {/if}
    <span class="meta">paired {ago(pairedAt)} · last seen {ago(lastSeen)}</span>
  </span>
  <button class="btn danger" onclick={onrevoke}>Revoke</button>
  {#if device}
    <div class="keyslot"><RemoteDeviceKey {device} open={keyOpen} onfold={onkeyfold} /></div>
  {/if}
</div>

<style>
  .row {
    display: flex; align-items: center; gap: 8px; padding: 8px; border: 1px solid var(--og-border);
    border-radius: 5px; background: var(--og-surface-alt); flex-wrap: wrap;
  }
  .grow { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .keyslot { flex-basis: 100%; min-width: 0; }
  .name { font-size: 11.5px; font-weight: 600; }
  .meta { flex-basis: 100%; font-size: 11.5px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .rid {
    font-size: 10px; color: var(--og-text-secondary); background: var(--og-input-bg);
    border: 1px solid var(--og-border); border-radius: 4px; padding: 1px 5px;
  }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
  .avatar {
    width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: 10px;
    font-weight: 700; color: var(--og-bg); background: var(--og-success); flex: 0 0 auto;
  }
  .inp {
    font: inherit; font-size: 11.5px; padding: 5px 8px; min-width: 0; color: var(--og-text);
    background: var(--og-input-bg); border: 1px solid var(--og-input-border); border-radius: 5px;
  }
  .name-edit { flex: 1 1 140px; }
  .icon-btn {
    display: inline-flex; padding: 2px; border: none; background: none; cursor: pointer;
    color: var(--og-text-muted); border-radius: 4px;
  }
  .icon-btn:hover { color: var(--og-text); background: var(--og-btn-hover); }
  .ico {
    width: 13px; height: 13px; stroke: currentColor; fill: none; stroke-width: 1.5;
    stroke-linecap: round; stroke-linejoin: round;
  }
  .btn {
    font: inherit; font-size: 11.5px; padding: 5px 12px; border-radius: 5px; cursor: pointer;
    white-space: nowrap; background: var(--og-btn-bg); color: var(--og-btn-text); border: 1px solid var(--og-border);
  }
  .btn.danger { border-color: var(--og-error); color: var(--og-error-text); }
</style>
