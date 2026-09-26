<script lang="ts">
  // Pillar 2 dashboard upgrade (2026-05-22) — specialised renderer for
  // grep results. The runtime returns one match per line in
  // `path:line: content` form (see crates/tools/src/grep.rs:147).
  // Previously this dropped through the GenericCard fallback as an
  // opaque <pre> block; now each row is a clickable filename, a line
  // badge, and the matching text. Click a path → opens the file in
  // VS Code at the matching line.

  import { getVsCodeApi } from '../../../shared/vscodeApi';

  // t-yyz5yk (Round 8, "Inside each element"): hits grouped by file, each
  // group with its hit count, each line with its number and the pattern
  // marked. The Origami engine's format (packages/engine/src/tool/grep.ts) is
  //   Found N matches / <path>: / "  Line 12: text" / blank / <path>: ...
  // which the old `path:line: text` parser never matched, so every hit fell
  // through to the italic preamble. Both forms parse now.
  import { tip } from '../../../shared/warmTip';

  interface Props {
    result: string;
    /** The engine titles a grep call with its pattern; used to mark hits. */
    title?: string;
  }

  let { result, title = '' }: Props = $props();

  const vscode = getVsCodeApi();

  interface GrepHit {
    path: string;
    line: number;
    text: string;
  }

  function parseGrep(input: string): { hits: GrepHit[]; preamble: string[] } {
    const hits: GrepHit[] = [];
    const preamble: string[] = [];
    const lineRe = /^([^:]+):(\d+):\s?(.*)$/;
    const fileRe = /^(\S.*):$/;
    const engineRe = /^\s+Line (\d+): ?(.*)$/;
    let file = '';
    for (const raw of input.split('\n')) {
      if (!raw.trim()) continue;
      const e = file ? engineRe.exec(raw) : null;
      if (e) { hits.push({ path: file, line: Number(e[1]), text: e[2] }); continue; }
      const f = fileRe.exec(raw);
      if (f) { file = f[1]; continue; }
      const m = lineRe.exec(raw);
      if (m) hits.push({ path: m[1], line: Number(m[2]), text: m[3] });
      else preamble.push(raw);
    }
    return { hits, preamble };
  }

  let parsed = $derived(parseGrep(result));
  const MAX_VISIBLE = 50;
  let visibleHits = $derived(parsed.hits.slice(0, MAX_VISIBLE));
  let overflow = $derived(parsed.hits.length - visibleHits.length);
  let groups = $derived.by(() => {
    const out: { path: string; hits: GrepHit[] }[] = [];
    for (const h of visibleHits) {
      const last = out[out.length - 1];
      if (last && last.path === h.path) last.hits.push(h);
      else out.push({ path: h.path, hits: [h] });
    }
    return out;
  });
  // The "Found N matches" header is what the bar now says; every other note
  // (the engine's "(Results truncated ...)" advice) is kept as it was.
  let notes = $derived(parsed.hits.length ? parsed.preamble.filter((p) => !/^Found \d+ match/.test(p)) : parsed.preamble);
  // The engine's own total wins: it counts matches the output left out.
  let total = $derived(Number(parsed.preamble.map((p) => /^Found (\d+) match/.exec(p)?.[1]).find(Boolean) ?? parsed.hits.length));
  let fileCount = $derived(new Set(parsed.hits.map((h) => h.path)).size);
  // The pattern is marked only as literal text: the bare tool name is not a
  // pattern, and a regex would need the engine's own flags to match honestly.
  let needle = $derived(title && title !== 'grep' ? title : '');

  function pieces(text: string): { t: string; hit: boolean }[] {
    if (!needle || !text.includes(needle)) return [{ t: text, hit: false }];
    const out: { t: string; hit: boolean }[] = [];
    text.split(needle).forEach((part, i) => {
      if (i > 0) out.push({ t: needle, hit: true });
      if (part) out.push({ t: part, hit: false });
    });
    return out;
  }

  function openPath(path: string, line: number) {
    vscode.postMessage({ type: 'openAbsoluteFile', path, line });
  }
</script>

{#if notes.length > 0}
  <div class="grep-preamble">
    {#each notes as p, i (i)}
      <div>{p}</div>
    {/each}
  </div>
{/if}

{#if visibleHits.length === 0 && parsed.preamble.length === 0}
  <div class="grep-empty">(no matches)</div>
{:else if visibleHits.length > 0}
  <div class="dbox">
    <div class="dbar">{#if needle}<span class="dpat">{needle}</span>{' · '}{/if}{total} {total === 1 ? 'match' : 'matches'} in {fileCount} {fileCount === 1 ? 'file' : 'files'}</div>
    {#each groups as g, gi (gi)}
      <div class="gfile">{g.path} <span class="n">{g.hits.length}</span></div>
      {#each g.hits as hit, i (i)}
        <button type="button" class="gl" style="--i: {Math.min(i, 30)}" onclick={() => openPath(hit.path, hit.line)} use:tip={`Open ${hit.path}:${hit.line}`}>
          <b class="gl-n">{hit.line}</b><span class="grep-text">{#each pieces(hit.text) as p, k (k)}{#if p.hit}<mark>{p.t}</mark>{:else}{p.t}{/if}{/each}</span>
        </button>
      {/each}
    {/each}
    {#if overflow > 0}
      <div class="grep-overflow">… (+{overflow} more matches)</div>
    {/if}
  </div>
{/if}

<style>
  .grep-preamble { color: var(--og-text-muted); font-size: 11px; font-style: italic; margin-bottom: 4px; }
  .grep-empty { color: var(--og-text-muted); font-style: italic; font-size: 11px; }
  .dbox { border: 1px solid var(--og-border); border-radius: 8px; background: var(--og-bg); overflow: hidden; font-size: 11px; }
  .dbar { padding: 3px 8px; border-bottom: 1px solid var(--og-border); background: color-mix(in srgb, var(--og-surface) 60%, transparent); color: var(--og-text-muted); }
  .dpat { font-family: var(--vscode-editor-font-family, monospace); color: var(--og-text-secondary); }
  .gfile { display: flex; gap: 8px; padding: 3px 8px; border-top: 1px solid var(--og-border); color: var(--og-text); font-family: var(--vscode-editor-font-family, monospace); }
  .dbar + .gfile { border-top: 0; }
  .gfile .n { color: var(--og-text-muted); font-family: var(--vscode-font-family, sans-serif); }
  .gl {
    display: grid; grid-template-columns: 42px 1fr; width: 100%; padding: 0; border: 0; background: none; text-align: left; cursor: pointer;
    white-space: pre; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 18px; color: var(--og-text-secondary);
    animation: lnin 240ms cubic-bezier(0.23, 1, 0.32, 1) backwards; animation-delay: calc(var(--i, 0) * 16ms);
  }
  .gl:hover { background: var(--og-btn-bg); }
  .gl-n { font-weight: 400; text-align: right; padding-right: 8px; color: var(--og-text-muted); }
  .grep-text { overflow: hidden; text-overflow: ellipsis; }
  .gl mark { background: color-mix(in srgb, var(--og-warning) 30%, transparent); color: var(--og-text); border-radius: 2px; }
  .grep-overflow { color: var(--og-text-muted); font-style: italic; padding: 2px 8px; border-top: 1px solid var(--og-border); }
  @keyframes lnin { from { opacity: 0; transform: translateY(3px); } }
  @media (prefers-reduced-motion: reduce) { .gl { animation: none; } }
</style>
