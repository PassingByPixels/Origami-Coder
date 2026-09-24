<script lang="ts">
  // ChatReopenLoading.svelte - the reopen loading state (t-v47uut). Drawn by ChatHistoryBar while
  // a reopened chat is restoring AND has no rows yet; the first row removes it.
  //
  // The layout is ChatEmptyState's (same column, gap, padding, 112px crane in --og-crane). When a
  // restore lands on a chat with no rows, the empty state takes the same place with no jump.
  //
  // Motion: the crane's own slow drift plus a slow fade in and out. Under prefers-reduced-motion
  // both stop: `still` leaves out the crane's SMIL (CSS cannot stop SMIL) and the CSS fade.
  import CraneMark from '../../shared/CraneMark.svelte';

  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
</script>

<div class="reopen-loading" class:still role="status">
  <div class="reopen-crane" style="color: var(--og-crane)">
    <CraneMark size={112} {still} />
  </div>
  <p class="reopen-text">Loading chat history…</p>
</div>

<style>
  .reopen-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    min-height: 100%;
    padding: 32px 24px;
    text-align: center;
    box-sizing: border-box;
  }
  .reopen-crane {
    display: flex;
    line-height: 0;
    opacity: 0.9;
    animation: reopen-breathe 2.8s ease-in-out infinite;
  }
  .reopen-text {
    margin: 0;
    font-size: 13px;
    font-weight: 500;
    color: var(--og-text-muted);
  }
  @keyframes reopen-breathe {
    0%, 100% { opacity: 0.9; }
    50% { opacity: 0.5; }
  }
  .still .reopen-crane { animation: none; }
  @media (prefers-reduced-motion: reduce) {
    .reopen-crane { animation: none; }
  }
</style>
