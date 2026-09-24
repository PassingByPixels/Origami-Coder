<script lang="ts">
  // HOW A QUESTION TRAVELS — as a banner, not a diagram.
  //
  // The owner's question about this feature is "how is it connecting again, I
  // forgot", and no amount of prose in a friends list answers it. It used to be
  // a 620x150 SVG at the top of the pane; on a tiled page that is a picture the
  // reader scrolls past to reach the controls. Three icons and three sentences
  // carry the same three facts — it leaves sealed, the relay is blind, the
  // answering side is a caged desk — in one strip the width of the grid.
  //
  // THE "LIVE TODAY" FOLD IS GONE, and it was removed rather than rewritten.
  // It said three things: that v1 worked between two engines on one machine
  // over loopback, that the relay transport was next, and that a desk answers
  // only from the ticked lists. The first two stopped being true when the relay
  // landed (`flock/relay-transport.ts`, `DEFAULT_RELAY_URL`), and the third is
  // what the third tile beside it already says. A caveat that has outlived its
  // caveat is worse than none: the reader trusts it and is wrong.
  //
  // The three tiles stay because each is still true today: the question is
  // sealed and signed with the owner's key (`flock/envelope.ts`), the relay
  // moves bytes it cannot read, and the answering side is a caged read-only
  // desk that is priced and scoped (`flock/frontdesk.ts`).
</script>

<div class="fk-banner">
  <div class="fk-step">
    <svg class="fk-ico" aria-hidden="true"><use href="#fk-seal" /></svg>
    <span><b>You seal and sign</b>The question leaves sealed by your key.</span>
  </div>
  <div class="fk-step blind">
    <svg class="fk-ico" aria-hidden="true"><use href="#fk-relay" /></svg>
    <span><b>A blind relay carries it</b>Bytes only — it reads nothing.</span>
  </div>
  <div class="fk-step">
    <svg class="fk-ico" aria-hidden="true"><use href="#fk-inbox" /></svg>
    <span><b>Their desk answers</b>Signed, priced, inside the shared scope.</span>
  </div>
</div>

<style>
  .fk-banner {
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    background: var(--og-surface-alt); border: 1px solid var(--og-border);
    border-radius: 6px; padding: 8px 16px;
  }
  .fk-step { display: flex; gap: 8px; align-items: flex-start; flex: 1 1 190px; min-width: 0; }
  .fk-step .fk-ico { margin-top: 1px; color: var(--og-accent-2); }
  .fk-step.blind .fk-ico { color: var(--og-text-muted); }
  .fk-step b { display: block; font-weight: 600; color: var(--og-text); }
  .fk-step span { color: var(--og-text-secondary); }
</style>
