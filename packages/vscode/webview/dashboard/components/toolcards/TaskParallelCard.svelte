<script lang="ts">
  // Pillar 2 dashboard upgrade (2026-05-22) — specialised renderer for
  // `task_parallel`. The runtime fan-outs sub-agents in parallel and
  // serialises their outputs as a single merged blob; we don't get a
  // structured array on the wire today. The result string typically
  // contains per-child sections separated by either a delimiter line
  // (e.g. `── child N: <agent> ──`) or just blank lines.
  //
  // We try to split on the delimiter; if absent the whole result
  // shows as one tab. Each tab uses the same MessageRow markdown
  // pipeline as TaskCard so multi-line code blocks render properly.

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
  let activeIdx = $state(0);
</script>

<div class="parallel-card">
  {#if children.length > 1}
    <div class="parallel-tabs">
      {#each children as c, i (i)}
        <button
          class="parallel-tab"
          class:active={activeIdx === i}
          onclick={() => activeIdx = i}
        >
          {c.label}
        </button>
      {/each}
    </div>
  {/if}
  <div class="parallel-body">
    <MessageRow kind="agent" label="" text={children[activeIdx]?.body ?? ''} />
  </div>
</div>

<style>
  .parallel-card {
    font-family: inherit;
    font-size: 11px;
  }

  .parallel-tabs {
    display: flex;
    gap: 2px;
    margin-bottom: 6px;
    border-bottom: 1px solid var(--og-border);
  }

  .parallel-tab {
    background: none;
    border: none;
    padding: 4px 8px;
    color: var(--og-text-muted);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .parallel-tab:hover {
    color: var(--og-text);
  }
  .parallel-tab.active {
    color: var(--og-accent, #89b4fa);
    border-bottom-color: var(--og-accent, #89b4fa);
    font-weight: 600;
  }

  .parallel-body {
    padding-left: 8px;
    border-left: 2px solid var(--og-accent-soft, rgba(137, 180, 250, 0.3));
  }
</style>
