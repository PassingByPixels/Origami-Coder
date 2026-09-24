<script lang="ts">
  // THE INVITE BODY: the two acts, and the two panels they write.
  //
  // A BODY, NOT A TILE. It draws no frame of its own any more: the messenger
  // pane hangs it inside a FlockChip, and a card inside a card is two borders
  // saying one thing. The two act pills lead the body rather than sitting in a
  // head this file no longer owns.
  //
  // BOTH PANELS ARE ON SCREEN AT ONCE, stacked, rather than one behind a
  // toggle. They are not alternatives — a contact link is two invites, one each
  // way, and a page that showed one box at a time taught the opposite.
  //
  // The QR keeps its footprint before there is one, so pressing Create does not
  // shove the accept box down the page.
  //
  // "Paste an invite" cannot OPEN a box that is already open, so it takes the
  // caret instead — one `focus()` call on a bound element, no flag, and nothing
  // for a second press to find already set.
  import FlockInviteActions from './FlockInviteActions.svelte';
  import FlockInviteQr from './FlockInviteQr.svelte';

  interface Props {
    /** The invite string the host just made, or '' before Create invite. */
    invite: string;
    /** Its QR as an SVG string, or '' when the invite was too long for one. */
    inviteQr: string;
    /** No front-desk model: an invite now buys a contact a refusal. */
    blocked: boolean;
    oninvite: () => void;
    onaccept: (invite: string) => void;
    oncopy: (text: string) => void;
  }
  let { invite, inviteQr, blocked, oninvite, onaccept, oncopy }: Props = $props();

  let paste = $state('');
  let box: HTMLTextAreaElement | null = $state(null);
</script>

<div class="acts"><FlockInviteActions {blocked} {oninvite} onpaste={() => box?.focus()} /></div>

<div class="panel">
  <span class="fk-caps">Your invite</span>
  <div class="qr-mini">
    {#if invite}
      <FlockInviteQr svg={inviteQr} />
    {:else}
      <div class="qr-blank" aria-hidden="true"><svg class="fk-ico lg"><use href="#fk-plus" /></svg></div>
    {/if}
  </div>
  {#if invite}
    <textarea class="fk-inp mono" readonly rows="2" aria-label="Your invite">{invite}</textarea>
    <button class="fk-btn" onclick={() => oncopy(invite)}>
      <svg class="fk-ico sm" aria-hidden="true"><use href="#fk-copy" /></svg> Copy invite text
    </button>
  {:else}
    <p class="fk-muted">Press <b>Create invite</b> above; the string and its QR land here.</p>
  {/if}
</div>

<div class="panel">
  <span class="fk-caps">Their invite</span>
  <textarea
    class="fk-inp mono"
    rows="3"
    bind:this={box}
    placeholder="Paste the origami://flock/invite#… string a contact sent you"
    aria-label="Accept an invite"
    bind:value={paste}
  ></textarea>
  <button class="fk-btn" disabled={!paste.trim()} onclick={() => { onaccept(paste.trim()); paste = ''; }}>
    Accept invite
  </button>
</div>

<p class="fk-muted">
  Public keys only, never a secret. It works once and expires in 48 hours. Sending it lets them ask
  you — a contact link is two invites, one each way.
</p>

<style>
  .acts { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .panel { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; min-width: 0; }
  .panel + .panel { border-top: 1px solid var(--og-border); padding-top: 8px; }
  .panel .fk-inp, .panel .qr-mini { width: 100%; }
  .qr-mini { display: flex; justify-content: center; }
  .qr-blank {
    width: 100%; max-width: 160px; aspect-ratio: 1; border-radius: 6px; display: grid; place-items: center;
    background: var(--og-surface-alt); border: 1px dashed var(--og-border); color: var(--og-text-muted);
  }
  .mono { font-family: var(--vscode-editor-font-family, monospace); overflow-wrap: anywhere; }
</style>
