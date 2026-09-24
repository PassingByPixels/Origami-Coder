<script lang="ts">
  // Pillar 2 dashboard upgrade (2026-05-22) — specialised renderer for
  // `task_parallel`. The runtime fan-outs sub-agents in parallel and
  // serialises their outputs as a single merged blob; we don't get a
  // structured array on the wire today. The result string typically
  // contains per-child sections separated by either a delimiter line
  // (e.g. `── child N: <agent> ──`) or just blank lines.
  //
  // We try to split on the delimiter; if absent the whole result
  // shows as one section. Each section uses the same MessageRow markdown
  // pipeline as TaskCard so multi-line code blocks render properly.
  //
  // t-q910fo. NO HEADER OF ITS OWN. The card used to print a tab strip above
  // the child rows — a second heading over a card the frame has already named
  // (ToolCard.svelte draws the title, the sub-agent badge and the status), and
  // one that no `task` card has. It also hid every child but one behind a click.
  // The children are now stacked as ROWS, each labelled by MessageRow's own
  // label the way every other transcript row is, so the card matches a task
  // card and nothing is one interaction away.

  import MessageRow from '../MessageRow.svelte';

  interface Props {
    result: string;
  }

  let { result }: Props = $props();

  interface ChildOutput {
    label: string;
    body: string;
  }

  function parseChildren(text: string): ChildOutput[] {
    // Look for `── child N: <agent> ──` separators (or any heading-like
    // separator). If none found, treat the whole text as a single child.
    const sep = /^(?:──|---|===)\s*child\s+(\d+)(?:\s*:\s*([^─\-=]+?))?\s*(?:──|---|===)$/im;
    const lines = text.split('\n');
    const indices: { idx: number; label: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = sep.exec(lines[i]);
      if (m) {
        const n = m[1];
        const agent = (m[2] ?? '').trim();
        indices.push({ idx: i, label: agent ? `Child ${n} — ${agent}` : `Child ${n}` });
      }
    }
    if (indices.length === 0) {
      return [{ label: 'Sub-agent output', body: text.trim() }];
    }
    const out: ChildOutput[] = [];
    for (let i = 0; i < indices.length; i++) {
      const startLine = indices[i].idx + 1;
      const endLine = i + 1 < indices.length ? indices[i + 1].idx : lines.length;
      out.push({
        label: indices[i].label,
        body: lines.slice(startLine, endLine).join('\n').trim(),
      });
    }
    return out;
  }

  let children = $derived(parseChildren(result));
</script>

<div class="parallel-card">
  <!-- One row per child, in order. A child is named only when there is more than
       one to tell apart: an unsplit result is the whole answer, and labelling it
       'Sub-agent output' would put back the very heading this card lost. -->
  {#each children as c, i (i)}
    <div class="parallel-body">
      <MessageRow kind="agent" label={children.length > 1 ? c.label : ''} text={c.body} />
    </div>
  {/each}
</div>

<style>
  .parallel-card {
    font-family: inherit;
    font-size: 11px;
  }

  /* One stacked child. The accent rule is the only chrome left — the same
     quoting bar TaskCard's own body uses. */
  .parallel-body {
    padding-left: 8px;
    border-left: 2px solid var(--og-accent-soft, rgba(137, 180, 250, 0.3));
  }
  .parallel-body + .parallel-body {
    margin-top: 6px;
  }
</style>
