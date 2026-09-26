<script lang="ts">
  // t-yyz5yk (Round 8, "Inside each element"): send_message opened. The bar
  // names the recipient and whether the message arrived; the engine's own
  // sentence stays below it (it says when the other agent reads it).
  // Recipient and verdict come from the engine's title and output
  // (packages/engine/src/tool/agents.ts): "send_message: <name>" and
  // "Delivered to ..." on success, "send_message: refused" + "Refused: ..."
  // otherwise. Anything else shows the text as it came, with no verdict.

  interface Props {
    result: string;
    title?: string;
    status?: string;
  }

  let { result, title = '', status = '' }: Props = $props();

  let named = $derived(/^send_message:\s*(.+)$/.exec(title)?.[1]?.trim() ?? '');
  let refused = $derived(named === 'refused' || /^Refused:/.test(result) || status === 'failed');
  let delivered = $derived(!refused && /^Delivered to /.test(result));
  // The row title is frozen at the pending frame (bare "send_message"), so the
  // result's "Delivered to <name> (session ...)" is the usual source.
  let to = $derived(refused ? '' : (/^Delivered to (.+?) \(session /.exec(result)?.[1] ?? named));
</script>

<div class="dbox">
  <div class="dbar">
    {#if to}to <span class="msg-to" data-av={to.slice(0, 1).toUpperCase()}>{to}</span> ·{/if}
    {#if refused}<span class="msg-state bad">refused</span>
    {:else if delivered}<span class="msg-state">delivered</span>
    {:else if status !== 'completed'}<span class="msg-state">sending…</span>{/if}
  </div>
  {#if result}<div class="msg-note" class:bad={refused}>{result}</div>{/if}
</div>

<style>
  .dbox { border: 1px solid var(--og-border); border-radius: 8px; background: var(--og-bg); overflow: hidden; font-size: 11px; }
  .dbar { display: flex; align-items: center; gap: 6px; padding: 3px 8px; border-bottom: 1px solid var(--og-border); background: color-mix(in srgb, var(--og-surface) 60%, transparent); color: var(--og-text-muted); }
  .msg-to { display: inline-flex; align-items: center; gap: 4px; padding: 0 6px 0 2px; border-radius: 9px; background: color-mix(in srgb, var(--og-chat) 12%, transparent); color: var(--og-text); }
  .msg-to::before { content: attr(data-av); display: inline-grid; place-items: center; width: 13px; height: 13px; border-radius: 50%; font-size: 8.5px; background: var(--og-chat); color: var(--og-bg); }
  .msg-state { color: var(--og-success); }
  .msg-state.bad { color: var(--og-error); }
  .msg-note { padding: 6px 10px; color: var(--og-text-secondary); white-space: pre-wrap; word-wrap: break-word; }
  .msg-note.bad { color: var(--og-error); }
</style>
