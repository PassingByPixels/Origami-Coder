<script lang="ts">
  // SoloChatHeader.svelte — t-qn0wj5, proposal 23 (port of Mock-Redesign
  // CHANGES.md #37). A popped-out chat editor tab (ChatPane's `soloSessionId`
  // set) has no brand to shrink — this codebase never drew one in the pane
  // itself, only in the sidebar (webview/chat, port-sidebar's file, not
  // touched) — so the mock's "shrink the brand to 24px" becomes: draw a 24px
  // strip in its place, carrying the session title and a model/status dot,
  // in the multi-tab bar's stead (ChatPane.svelte hides `.session-tabs`
  // whenever `soloSessionId` is set — see the `{#if sessions.length > 0 &&
  // !soloSessionId}` guard).
  //
  // Its own leaf rather than inline in ChatPane.svelte: that file sits at
  // 2445/2477 lines, 32 lines of headroom, and this strip's markup + styles
  // alone would have spent most of it.
  interface Props {
    number: number;
    agentName: string;
    title?: string;
    peerName?: string;
    modelName?: string;
    waiting: boolean;
  }
  let { number, agentName, title, peerName, modelName, waiting }: Props = $props();

  const text = $derived(
    `#${number} ${agentName}${title ? ': ' + title : ''}${peerName ? ' · ' + peerName : ''}`,
  );
</script>

<div class="solo-chat-header" role="banner">
  <span class="solo-chat-title">{text}</span>
  <span
    class="solo-chat-dot"
    class:waiting
    aria-hidden="true"
    title={modelName ? `Model: ${modelName}` : undefined}
  ></span>
</div>

<style>
  /* 24px strip, matched to the mock's own measured height (CHANGES.md #37). */
  .solo-chat-header {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 24px;
    min-height: 24px;
    padding: 0 10px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--og-border);
    background: var(--og-pane-header);
  }
  .solo-chat-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--og-text-secondary);
    font-size: 11px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .solo-chat-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--og-chat);
  }
  .solo-chat-dot.waiting {
    background: var(--og-status-waiting);
  }
</style>
