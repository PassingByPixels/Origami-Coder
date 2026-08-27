<script lang="ts">
  // The inspector COLUMN: its drag divider and the panel behind it.
  //
  // Collapsing removes the divider WITH the column (RepoMapScreen's right rail
  // does the same): a divider with nothing beyond it cannot be dragged, so the
  // pane mounts this only while the column is open.
  //
  // Extracted VERBATIM from LabyrinthPane.svelte at its architecture cap when
  // the back journey landed. No behaviour moved with it — the pane still owns
  // the width state and the host round trip, and reports both up as before.
  // Colours are theme vars ONLY.
  import LabyrinthDivider from './LabyrinthDivider.svelte';
  import LabyrinthInspector from './LabyrinthInspector.svelte';
  import { MIN_INSPECT_WIDTH, DEFAULT_INSPECT_WIDTH } from './labyrinthColumns';
  import type { LayoutStep } from './labyrinthLayout';

  let { containerEl, width, step, onChange, onCommit }: {
    containerEl: HTMLElement | undefined;
    /** null = the default CSS width; nothing has been dragged yet. */
    width: number | null;
    step: LayoutStep | null;
    onChange: (w: number) => void;
    onCommit: (w: number) => void;
  } = $props();
</script>

<LabyrinthDivider edge="right" {containerEl} value={width} min={MIN_INSPECT_WIDTH} defaultPx={DEFAULT_INSPECT_WIDTH} label="Resize the inspector" {onChange} {onCommit} />
<div class="lab-inspect" style={width ? `width:${width}px` : undefined}>
  <LabyrinthInspector {step} />
</div>

<style>
  .lab-inspect { width: 340px; flex-shrink: 0; border-left: 1px solid var(--og-border); min-height: 0; }
</style>
