<script lang="ts">
  // "This will wake: crane, heron" — the C14 preview line (report 2.5 / F8).
  //
  // Routing in a collab is MECHANICAL and fail-closed: prose `@name` wakes
  // nobody, a structured address list does, and an unaddressed message reaches
  // the lead alone. All correct, all invisible — a user learns the rules by
  // sending a message into silence. This line is the rules, said out loud,
  // before the send rather than after it.
  //
  // NOTHING BUT TEXT. The wording rule is collabPreview.ts's `previewText`,
  // pure and tested with no DOM; the asking is CollabComposer's. This draws.
  //
  // It renders NOTHING for an empty line rather than reserving a row: the
  // composer must not jump by a line height the moment a draft is started.

  interface Props {
    /** Already worded. '' before the first answer, and after a send. */
    text: string;
  }
  let { text }: Props = $props();
</script>

{#if text}
  <!-- aria-live=polite via role=status: it changes while the user types, and
       must never interrupt them mid-word. -->
  <div class="cp-preview" role="status">{text}</div>
{/if}

<style>
  /* Under the box, muted, monospace — a fact about the message, in the same
     register as the hop count below it rather than as a banner. */
  .cp-preview {
    padding: 2px 12px 0;
    font-size: 10px;
    color: var(--og-text-muted);
    font-family: var(--vscode-editor-font-family, monospace);
    flex-shrink: 0;
    overflow-wrap: anywhere;
  }
</style>
