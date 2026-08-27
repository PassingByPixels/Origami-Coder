<script module lang="ts">
  /**
   * The envelope tool/agents.ts wraps a handoff in, followed by an instruction
   * sentence for the RECEIVING MODEL. The human should see neither — strip
   * everything from the opening tag through </peer_message> for display, and
   * leave anything that does not match that pattern alone rather than guessing.
   *
   * Exported from the component (the InstructionRowActions.svelte pattern) so
   * the rule is testable without mounting anything.
   */
  export function peerBody(text: string): string {
    const match = /^<peer_message\b[^>]*>\n?([\s\S]*?)\n?<\/peer_message>/.exec(text.trim());
    return match ? match[1] : text;
  }
</script>

<script lang="ts">
  /**
   * A message from ANOTHER agent session, badged as agent-origin.
   *
   * The whole point of this row is that it must not read as the human. It is
   * left-aligned and rule-marked where a user message is a filled bubble, and it
   * leads with WHO sent it. The reply address is not shown to the user — the
   * model receives it in the instruction text that peerBody() strips.
   */
  let { from, replyTo, text, timestamp }: {
    from: string;
    replyTo: string;
    text: string;
    timestamp?: number;
  } = $props();

  const clock = (ts?: number) =>
    ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
</script>

<div class="peer-row" data-peer-from={from}>
  <div class="peer-head">
    <span class="peer-badge">from {from}</span>
    {#if timestamp}<span class="peer-time">{clock(timestamp)}</span>{/if}
  </div>
  <div class="peer-text">{peerBody(text)}</div>
</div>

<style>
  .peer-row {
    margin: 6px 0;
    padding: 6px 10px;
    border-left: 3px solid var(--og-accent-2);
    background: var(--og-surface-alt);
    border-radius: 0 4px 4px 0;
  }
  .peer-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
    font-size: 11px;
    color: var(--og-text-secondary);
  }
  .peer-badge {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 3px;
    border: 1px solid var(--og-accent-2);
    color: var(--og-accent-2);
  }
  .peer-time {
    margin-left: auto;
    color: var(--og-text-muted);
  }
  .peer-text {
    margin-top: 4px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--og-text);
  }
</style>
