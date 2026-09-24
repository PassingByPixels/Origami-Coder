<script lang="ts">
  // ToolRunGroup — a RUN of tool calls drawn as one stepped strip, and a lone
  // call drawn as it always was (CHANGES.md change 21).
  //
  // Extracted rather than inlined into ChatTranscript.svelte for the reason
  // Svelte forces: a <style> is scoped to the component holding the markup, so
  // the rail and the step nodes have to live with the wrapper they decorate.
  // It also keeps the transcript's loop one branch, not two near-identical
  // ToolCard call sites that could drift apart.
  //
  // WHICH cards belong together is not decided here — that is toolRuns.ts,
  // which the transcript applies to its already-folded row list, so focus mode
  // folds first and the strip groups whatever survives.
  import ToolCard from './ToolCard.svelte';
  import type { Message } from '../panes/chatMessage';

  interface Props {
    /** The cards, in order. One row draws bare; two or more draw in the strip. */
    rows: Message[];
    /** ToolCard's own props, the same values the transcript passed before. */
    sessionId: string;
    readOnly?: boolean;
    onImageClick?: (src: string, alt: string) => void;
    /** A `task` card's header is the word `task`, so the transcript names it
     *  the way the sub-agent drawer does. Passed as a function because the
     *  numbering is derived from the WHOLE transcript, not from this run. */
    nameOf: (msg: Message) => string;
  }
  let { rows, sessionId, readOnly = false, onImageClick, nameOf }: Props = $props();
  let stepped = $derived(rows.length > 1);
</script>

<div class="tool-run" class:stepped>
  {#each rows as msg (msg.id)}
    <div class="tool-step" data-tool-call={msg.toolCallId} class:done={msg.toolStatus === 'completed'} class:failed={msg.toolStatus === 'failed'}>
      <ToolCard
        title={nameOf(msg)}
        kind={msg.toolKind || 'other'}
        toolName={msg.toolName || ''}
        status={msg.toolStatus || 'completed'}
        result={msg.toolResult}
        diff={msg.toolDiff}
        path={msg.toolPath}
        stream={msg.taskStream}
        resumed={msg.taskResumed}
        shell={msg.toolShell}
        toolLines={msg.toolLines}
        images={msg.toolImages} readImage={msg.toolReadImage} browser={msg.toolBrowser}
        sessionId={sessionId} startedAt={msg.timestamp} {readOnly} {onImageClick}
      />
    </div>
  {/each}
</div>

<style>
  /* A single card is drawn exactly as before: no wrapper chrome, no rail. A
     stepper around one step is a rail with nothing to connect. */
  .tool-run { display: contents; }
  .tool-run.stepped {
    display: block;
    position: relative;
    margin: 4px 0 4px 3px;
    padding-left: 13px;
  }
  /* The connector. Inset top and bottom so it runs BETWEEN the step nodes
     rather than past the first and last one. */
  .tool-run.stepped::before {
    content: '';
    position: absolute;
    top: 10px;
    bottom: 10px;
    left: 4px;
    width: 1px;
    background: var(--og-border);
  }
  .tool-run.stepped .tool-step { position: relative; }
  .tool-run.stepped .tool-step::before {
    content: '';
    position: absolute;
    top: 9px;
    left: -13px;
    width: 9px;
    height: 9px;
    border: 1px solid var(--og-border);
    border-radius: 50%;
    background: var(--og-bg);
    box-sizing: border-box;
  }
  /* The node takes the call's own verdict, so the rail reads as a progress
     column: how far down this turn got, and where it stopped. */
  .tool-run.stepped .tool-step.done::before {
    border-color: var(--og-success);
    background: color-mix(in srgb, var(--og-success) 25%, var(--og-bg));
  }
  .tool-run.stepped .tool-step.failed::before {
    border-color: var(--og-error);
    background: color-mix(in srgb, var(--og-error) 25%, var(--og-bg));
  }
</style>
