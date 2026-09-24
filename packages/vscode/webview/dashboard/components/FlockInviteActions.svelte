<script lang="ts">
  // THE INVITE TILE'S HEAD: the two acts, and how long one lasts.
  //
  // Two pills, equal, side by side. Making an invite and taking one are the
  // same size of decision, and a primary beside a small quiet button would say
  // one of them was the real one. They sit in the tile HEAD rather than in the
  // body because the body is the two panels they write into — the head is what
  // you press, the body is what appears.
  //
  // Create is DISABLED while no model is set. Not because the invite would
  // fail — it would work — but because the friend it brings in would have every
  // question refused, and the fix is one tile up.
  interface Props {
    /** No front-desk model: an invite now buys a contact a refusal. */
    blocked: boolean;
    oninvite: () => void;
    /** Take the caret to the accept box in the body below. */
    onpaste: () => void;
  }
  let { blocked, oninvite, onpaste }: Props = $props();
</script>

<span class="acts">
  {#if blocked}
    <button class="fk-btn pill" disabled title="Set the front desk model first — every question would be refused">
      Pick a model first
    </button>
  {:else}
    <button class="fk-btn primary pill" data-primary onclick={oninvite}>Create invite</button>
  {/if}
  <button class="fk-btn pill" onclick={onpaste}>Paste an invite</button>
</span>
<span class="fk-pill"><span class="fk-dot amber"></span>48 h · single use</span>

<style>
  .acts { display: inline-flex; gap: 8px; flex-wrap: wrap; }
  .acts .pill { border-radius: 999px; }
</style>
