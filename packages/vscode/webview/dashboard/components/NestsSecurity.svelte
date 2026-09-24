<script lang="ts">
  // SECURITY — the Nests view's card that tells the owner how a nest is kept
  // safe (t-sj32zl), and where to find the guide to run their own relay. The
  // words are ASD-STE100 Simplified Technical English: short sentences, one
  // meaning per word, no metaphors. Each claim matches the code:
  // the relay (engine/src/relay/server.ts: memory only, blind), the one-time
  // key and the Accept step (src/remote/groupHandshake.ts), removal
  // (groupControl.groupForget + a new invite mints a new Kg).
  import { REMOTE_SELF_HOST_URL } from './remoteLinks';

  let shut = $state(false);
</script>

<section class="card sec-card" class:is-shut={shut} data-name="security">
  <div class="head">
    <button class="chev" aria-expanded={!shut} aria-label="Collapse Security" onclick={() => (shut = !shut)}>▾</button>
    <span class="caps">Security</span>
  </div>
  {#if !shut}
    <dl class="sec">
      <dt>The relay</dt>
      <dd>
        The relay only moves bytes from one desk to another. It has no accounts. Each desk encrypts every
        message before it sends it, and only your desks have the key to decrypt it. The relay keeps nothing
        on its disk.
      </dd>
      <dt>The invite key</dt>
      <dd>
        An invite key does not contain the nest key. It is for one desk only, and it stops after 10 minutes.
        After one desk uses it, the key does not work again. Each new invite makes a new key.
      </dd>
      <dt>Accept</dt>
      <dd>
        When a desk uses the key, this desk shows the name of that desk and a 6-digit code. The new desk shows
        a code too. Click Accept only if the name and the two codes are the same. Only then does this desk
        send the nest key, encrypted for the new desk only.
      </dd>
      <dt>Remove a desk</dt>
      <dd>
        To lock a desk out, forget the nest on a desk that stays. Start a new nest there and add the other
        desks again. The new nest has a new key. The removed desk has only the old key, and no desk uses it.
      </dd>
    </dl>
    <p class="links">
      <a class="rx-link" href={REMOTE_SELF_HOST_URL} target="_blank" rel="noopener">Run your own relay — guide</a>
    </p>
  {/if}
</section>

<style>
  .card {
    background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 12px 14px;
    display: flex; flex-direction: column; gap: 10px; min-width: 0; color: var(--og-text); font-size: 11.5px; line-height: 1.4;
  }
  .head { display: flex; align-items: center; gap: 6px; min-height: 21px; }
  .chev { width: 16px; height: 16px; padding: 0; border: 0; background: transparent; cursor: pointer; color: var(--og-text-muted); font-size: 10px; line-height: 16px; transition: transform 160ms ease; }
  .card.is-shut .chev { transform: rotate(-90deg); }
  .caps { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-muted); font-weight: 600; }
  .sec { margin: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 12px; row-gap: 8px; }
  .sec dt { color: var(--og-text-muted); white-space: nowrap; }
  .sec dd { margin: 0; color: var(--og-text-secondary); max-width: 620px; }
  .links { margin: 0; font-size: 11px; }
  .rx-link { color: var(--og-accent-2); text-decoration: underline; } /* RemoteRelay.svelte's link, same guide */
</style>
