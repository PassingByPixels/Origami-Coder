<script lang="ts">
  // The room says a turn FAILED (W3 wave 3, report F13).
  //
  // A failed turn appends nothing to the transcript, and that is correct: "a
  // stack trace in the log would be a message every other agent then reads and
  // reacts to" (collab/runner.ts's drain). The failure lives on the agent's
  // status instead — which meant, until now, a blank ring and a 14px `!` you
  // had to find and click.
  //
  // So this row is drawn from the STATUSES, not from the messages: it is the
  // room's own note to the human, sitting at the foot of the stream beside the
  // waiting line, and no agent ever reads it. That is also why it survives an
  // empty transcript — an agent can fail its very first turn.
  //
  // Its own component rather than six lines in CollabStream.svelte, mirroring
  // CollabWaitingRow.svelte, which sits directly above it for the same reason.
  //
  // WAVE 2's needs-a-model REASON IS THE POINT. An unpinned collab agent now
  // fails clean with `@slug has no model — pick one in its agent definition`
  // (runner.ts: needsModelReason). That sentence names the next action, and a
  // next action behind a click is one nobody takes.
  import type { AgentFailure } from './collabSupervision';

  interface Props {
    failures: AgentFailure[];
    /** The stream's resolver — a slug where a name belongs is never printed. */
    nameOf: (slug: string) => string;
  }
  let { failures, nameOf }: Props = $props();
</script>

{#each failures as f (f.slug)}
  <!-- role=status, not alert: the turn already ended, so this is a state the
       room is in rather than an event to interrupt a reader with. -->
  <div class="cs-failure" role="status">
    <span class="cs-failure-who">{nameOf(f.slug)}</span>
    <span class="cs-failure-label">last turn failed</span>
    <span class="cs-failure-text">{f.text}</span>
  </div>
{/each}

<style>
  /* The error tone, and NOT a bubble: nobody said this, the room is reporting
     it. Matches CollabWaitingRow's shape line for line so the two footer rows
     read as one family. */
  .cs-failure {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 5px;
    padding: 3px 4px;
    font-size: 10px;
    color: var(--og-error-text);
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .cs-failure-who { font-weight: 600; }
  .cs-failure-label { text-transform: uppercase; letter-spacing: 0.06em; color: var(--og-error); }
  .cs-failure-text { flex: 1 1 100%; overflow-wrap: anywhere; }
</style>
