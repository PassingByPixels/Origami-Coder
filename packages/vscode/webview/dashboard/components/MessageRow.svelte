<script lang="ts">
  import { marked } from 'marked';
  import hljs from 'highlight.js/lib/core';

  // Register only the languages we actually need (tree-shakeable)
  import javascript from 'highlight.js/lib/languages/javascript';
  import typescript from 'highlight.js/lib/languages/typescript';
  import python from 'highlight.js/lib/languages/python';
  import rust from 'highlight.js/lib/languages/rust';
  import bash from 'highlight.js/lib/languages/bash';
  import json from 'highlight.js/lib/languages/json';
  import yaml from 'highlight.js/lib/languages/yaml';
  import css from 'highlight.js/lib/languages/css';
  import xml from 'highlight.js/lib/languages/xml';
  import sql from 'highlight.js/lib/languages/sql';
  import markdown from 'highlight.js/lib/languages/markdown';
  import lua from 'highlight.js/lib/languages/lua';
  import toml from 'highlight.js/lib/languages/ini';
  import diff from 'highlight.js/lib/languages/diff';
  import plaintext from 'highlight.js/lib/languages/plaintext';

  hljs.registerLanguage('javascript', javascript);
  hljs.registerLanguage('js', javascript);
  hljs.registerLanguage('typescript', typescript);
  hljs.registerLanguage('ts', typescript);
  hljs.registerLanguage('python', python);
  hljs.registerLanguage('py', python);
  hljs.registerLanguage('rust', rust);
  hljs.registerLanguage('rs', rust);
  hljs.registerLanguage('bash', bash);
  hljs.registerLanguage('sh', bash);
  hljs.registerLanguage('shell', bash);
  hljs.registerLanguage('json', json);
  hljs.registerLanguage('yaml', yaml);
  hljs.registerLanguage('yml', yaml);
  hljs.registerLanguage('css', css);
  hljs.registerLanguage('html', xml);
  hljs.registerLanguage('xml', xml);
  hljs.registerLanguage('svelte', xml);
  hljs.registerLanguage('sql', sql);
  hljs.registerLanguage('markdown', markdown);
  hljs.registerLanguage('md', markdown);
  hljs.registerLanguage('lua', lua);
  hljs.registerLanguage('toml', toml);
  hljs.registerLanguage('ini', toml);
  hljs.registerLanguage('diff', diff);
  hljs.registerLanguage('plaintext', plaintext);
  hljs.registerLanguage('text', plaintext);

  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { renderChartBlock } from '../../shared/chartBlock';
  const vscode = getVsCodeApi();

  interface Props {
    kind: 'user' | 'agent' | 'system' | 'tool' | 'error';
    label: string;
    text: string;
    images?: string[];
    timestamp?: number;
    /**
     * Pillar 3 dashboard upgrade (2026-05-22) — session-cumulative
     * token count at the moment this message landed. Stamped by
     * ChatPane on the last agent message of each completed turn.
     * Rendered as a small badge with hover tooltip showing the
     * full number. Optional — undefined → no badge.
     */
    tokensAtTurn?: number;
    /**
     * B9 (2026-06-06) — per-turn work + context spend. `tokensThisTurn`
     * is the tokens spent on this turn alone; `ctxPctAtTurn` is how full
     * the context window was at turn end. Both optional — render only
     * when the backend reported them (degrade gracefully otherwise).
     */
    tokensThisTurn?: number;
    ctxPctAtTurn?: number;
    /**
     * An attached image was clicked — the parent opens it enlarged. OPTIONAL:
     * TaskCard/TaskParallelCard mount this row too, and a sub-agent transcript
     * has no lightbox above it, so an absent handler must leave the picture
     * inert (and un-zoomable-looking) rather than throw.
     */
    onImageClick?: (src: string, alt: string) => void;
  }

  let { kind, label, text, images, timestamp, tokensAtTurn, tokensThisTurn, ctxPctAtTurn, onImageClick }: Props = $props();

  function formatTime(ts?: number): string {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatTokens(n: number): string {
    if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
    if (n >= 1000) return `${(n / 1000).toFixed(2)}k`;
    return String(n);
  }

  // Configure marked with syntax highlighting
  const renderer = new marked.Renderer();

  // Shown in the header of a `chart` fence the renderer could not parse. A
  // spec that failed used to fall through to an anonymous code block and say
  // NOTHING: a live session emitted YAML into the fence, parseSpec only ever
  // calls JSON.parse, and every chart in that session silently became a code
  // block nobody questioned. The body still shows the user's text — the header
  // now says why there is no picture, and what the fence actually takes.
  const CHART_HINT = '<span class="chart-hint">chart spec did not parse — this fence takes JSON</span>';

  // Override code block rendering to add syntax highlighting + copy button.
  // A `chart` fence tries the SVG renderer first — see the sync note in
  // collabMarkdown.ts's own renderer.code, which mirrors this branch.
  renderer.code = ({ text: code, lang }: { text: string; lang?: string }) => {
    let chartHint = '';
    if (lang === 'chart') {
      const svg = renderChartBlock(code);
      if (svg) return svg;
      chartHint = CHART_HINT;
    }
    const language = lang && hljs.getLanguage(lang) ? lang : undefined;
    let highlighted: string;
    try {
      highlighted = language
        ? hljs.highlight(code, { language }).value
        : hljs.highlightAuto(code).value;
    } catch {
      highlighted = escapeHtml(code);
    }
    const langLabel = lang || 'text';
    return `<div class="code-block"><div class="code-header"><span class="code-lang">${escapeHtml(langLabel)}</span>${chartHint}<button class="copy-btn" data-code="${escapeAttr(code)}">Copy</button></div><pre><code class="hljs">${highlighted}</code></pre></div>`;
  };

  // Make links open in VS Code (file paths) or external browser
  renderer.link = ({ href, text: linkText }: { href: string; text: string }) => {
    if (href && (href.startsWith('/') || href.match(/^[A-Z]:\\/i) || href.match(/^[a-zA-Z0-9_./-]+\.[a-z]+/))) {
      const { path: filePath, line } = splitPathLine(href);
      const dataLine = line !== undefined ? ` data-line="${line}"` : '';
      return `<a class="file-link" data-path="${escapeAttr(filePath)}"${dataLine}>${linkText}</a>`;
    }
    return `<a href="${escapeAttr(href)}" class="ext-link" title="${escapeAttr(href)}">${linkText}</a>`;
  };

  marked.setOptions({
    renderer,
    breaks: true,
    gfm: true,
  });

  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Split a "path:line[:col]" reference into its path and 1-based line.
  // A bare path, or a range like ":10-20", yields line: undefined.
  function splitPathLine(raw: string): { path: string; line?: number } {
    const m = raw.match(/^(.+?):(\d+)(?::\d+)?$/);
    if (m) return { path: m[1], line: parseInt(m[2], 10) };
    return { path: raw };
  }

  // Linkify bare file paths in already-rendered HTML so the agent naming a
  // file in prose ("packages/engine/src/agent/agent.ts:109") becomes a
  // click-to-open link — mirroring the markdown-link path above. Runs on
  // TEXT segments only: <pre>/<code>/<a> blocks and HTML tags are left
  // untouched so highlighted code and existing links are never mangled. A
  // token must have a path separator OR a :line suffix to qualify, which
  // skips version strings ("1.29.0"), domains, and "a.b" method refs.
  function linkifyPaths(html: string): string {
    // PROTECTED skips HIGHLIGHTED code (a whole <pre>…</pre> block) and existing
    // links, but deliberately NOT standalone inline <code>: coder models wrap
    // nearly every path in single backticks ("edit `src/foo.ts:78`"), which marked
    // renders as inline <code> — those MUST linkify or the most common way a path
    // appears is un-clickable. Fenced ```blocks``` render as <pre><code>…</code></pre>,
    // so the <pre> alternative still swallows them whole and their bodies stay literal.
    // (Assumes marked emits balanced tags; a malformed unclosed <pre> could let a
    // path in its body linkify — cosmetic only, the link still resolves.)
    const PROTECTED = /(<pre[\s\S]*?<\/pre>|<a\b[\s\S]*?<\/a>|<[^>]+>)/gi;
    // Leading (?<!...) boundary stops a match starting mid-token, which also
    // collapses O(n^2) backtracking to linear on a long separator-less blob
    // (verified: 100k chars 11.9s -> 0.6ms). The [A-Za-z]:[\\/] prefix lets a
    // Windows absolute path (C:/... or C:\...) linkify too.
    const PATH = /(?<![\w./\\-])((?:[A-Za-z]:[\\/])?(?:[\w.\-]+[\\/])*[\w.\-]+\.[A-Za-z][\w]{0,7})(:\d+(?::\d+)?)?/g;
    return html
      .split(PROTECTED)
      .map((seg, i) => {
        if (i % 2 === 1) return seg; // captured tag / protected block — leave as-is
        return seg.replace(PATH, (whole: string, pathPart: string, linePart?: string) => {
          const hasSep = /[\\/]/.test(pathPart);
          if (!hasSep && !linePart) return whole; // unqualified — leave as text
          const line = linePart ? linePart.slice(1).split(':')[0] : '';
          const dataLine = line ? ` data-line="${line}"` : '';
          return `<a class="file-link" data-path="${escapeAttr(pathPart)}"${dataLine}>${whole}</a>`;
        });
      })
      .join('');
  }

  // Only render markdown for agent messages; others stay plain text.
  // Either way, run the bare-path linkifier over the result.
  let rendered = $derived(
    linkifyPaths(
      kind === 'agent'
        ? marked.parse(text) as string
        : escapeHtml(text).replace(/\n/g, '<br>')
    )
  );

  function handleClick(e: MouseEvent) {
    const target = e.target as HTMLElement;

    // An attached image — enlarge it. FIRST, because the row's other branches
    // are all `closest()` lookups too and an image inside a linkified body
    // must never be mistaken for one of them.
    const img = target.closest('.chat-image') as HTMLImageElement | null;
    if (img && onImageClick) {
      e.preventDefault();
      onImageClick(img.src, img.alt);
      return;
    }

    // Copy button
    const copyBtn = target.closest('.copy-btn') as HTMLElement | null;
    if (copyBtn?.dataset.code != null) {
      e.preventDefault();
      navigator.clipboard.writeText(copyBtn.dataset.code);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      return;
    }

    // File path links
    const fileLink = target.closest('.file-link') as HTMLElement | null;
    if (fileLink?.dataset.path) {
      e.preventDefault();
      const rawLine = fileLink.dataset.line;
      const line = rawLine ? parseInt(rawLine, 10) : undefined;
      vscode.postMessage({ type: 'openAbsoluteFile', path: fileLink.dataset.path, line });
      return;
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="row {kind}" onclick={handleClick}>
  <div class="row-header">
    <span class="label">{label}</span>
    {#if timestamp}
      <span class="timestamp">{formatTime(timestamp)}</span>
    {/if}
    {#if (tokensThisTurn !== undefined && tokensThisTurn > 0) || (ctxPctAtTurn !== undefined && ctxPctAtTurn > 0)}
      <span
        class="spend-badge"
        class:hot={ctxPctAtTurn !== undefined && ctxPctAtTurn >= 80}
        class:warn={ctxPctAtTurn !== undefined && ctxPctAtTurn >= 60 && ctxPctAtTurn < 80}
        title={`This turn: ${tokensThisTurn ? tokensThisTurn.toLocaleString() + ' tokens spent' : 'spend unknown'}${ctxPctAtTurn ? ` · context ${ctxPctAtTurn}% full` : ''}${tokensAtTurn ? ` · ${tokensAtTurn.toLocaleString()} cumulative` : ''}`}
      >
        {#if tokensThisTurn !== undefined && tokensThisTurn > 0}thought {formatTokens(tokensThisTurn)} tok{/if}
        {#if ctxPctAtTurn !== undefined && ctxPctAtTurn > 0}{#if tokensThisTurn}· {/if}ctx {ctxPctAtTurn}%{/if}
      </span>
    {:else if tokensAtTurn !== undefined && tokensAtTurn > 0}
      <span
        class="token-badge"
        title={`Session-cumulative tokens at end of this turn: ${tokensAtTurn.toLocaleString()}`}
      >
        {formatTokens(tokensAtTurn)} tok
      </span>
    {/if}
  </div>
  {#if images && images.length > 0}
    <div class="attached-images">
      {#each images as src}
        <img class="chat-image" class:zoomable={!!onImageClick} src={src} alt="attached image" />
      {/each}
    </div>
  {/if}
  <span class="text">{@html rendered}</span>
</div>

<style>
  .row {
    margin: 4px 0;
    padding: 5px 8px;
    border-radius: 4px;
    word-wrap: break-word;
    font-size: 12px;
    line-height: 1.5;
  }

  .row-header {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .label {
    font-weight: 600;
    margin-right: 6px;
    opacity: 0.85;
  }

  .timestamp {
    font-size: 10px;
    color: var(--og-text-muted);
    opacity: 0.7;
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }

  /* Pillar 3 — token badge to the right of the timestamp, with
     hover tooltip showing the full count. Subtle styling so it
     doesn't compete with the message text for attention. */
  .token-badge {
    font-size: 10px;
    color: var(--og-text-muted);
    opacity: 0.65;
    margin-left: 4px;
    padding: 0 5px;
    border: 1px solid var(--og-border, rgba(255,255,255,0.08));
    border-radius: 8px;
    font-variant-numeric: tabular-nums;
    cursor: help;
  }
  .token-badge:hover {
    opacity: 1;
  }

  .spend-badge {
    font-size: 10px;
    color: var(--og-text-muted);
    opacity: 0.7;
    margin-left: 4px;
    padding: 0 5px;
    border: 1px solid var(--og-border, rgba(255,255,255,0.08));
    border-radius: 8px;
    font-variant-numeric: tabular-nums;
    cursor: help;
    white-space: nowrap;
  }
  .spend-badge:hover { opacity: 1; }
  .spend-badge.warn { color: var(--og-warning, #ffb74d); border-color: var(--og-warning, #ffb74d); opacity: 0.85; }
  .spend-badge.hot { color: var(--og-error, #ef5350); border-color: var(--og-error, #ef5350); opacity: 0.9; }

  .attached-images {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 4px 0;
  }

  .chat-image {
    max-width: 280px;
    max-height: 200px;
    border-radius: 6px;
    border: 1px solid var(--og-border);
    object-fit: contain;
  }
  /* The affordance follows the HANDLER, not the element: a row mounted without
     `onImageClick` (a sub-agent transcript) would otherwise offer a zoom that
     does nothing. `zoom-in` rather than the old `pointer` says what the click
     actually does now. */
  .chat-image.zoomable {
    cursor: zoom-in;
  }
  .chat-image.zoomable:hover {
    border-color: var(--og-chat);
  }

  .user {
    background: var(--og-surface);
    white-space: pre-wrap;
  }
  .user .label { color: var(--og-chat); }

  .agent .label { color: var(--og-accent-2); }

  .system {
    font-style: italic;
    opacity: 0.85;
    white-space: pre-wrap;
  }
  .system .label { color: var(--og-success); }

  .tool {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    background: var(--og-surface);
    border-left: 3px solid var(--og-warning);
    white-space: pre-wrap;
  }
  .tool .label { color: var(--og-warning); }

  .error {
    background: rgba(248, 113, 113, 0.1);
    border-left: 3px solid var(--og-error);
    white-space: pre-wrap;
  }
  .error .label { color: var(--og-error); }

  /* --- Markdown rendered content --- */
  .text :global(p) { margin: 0.4em 0; }
  .text :global(p:first-child) { margin-top: 0; }
  .text :global(p:last-child) { margin-bottom: 0; }

  .text :global(h1), .text :global(h2), .text :global(h3),
  .text :global(h4), .text :global(h5), .text :global(h6) {
    margin: 0.6em 0 0.3em;
    line-height: 1.3;
    color: var(--og-text);
  }
  .text :global(h1) { font-size: 1.3em; }
  .text :global(h2) { font-size: 1.15em; }
  .text :global(h3) { font-size: 1.05em; }

  .text :global(ul), .text :global(ol) {
    margin: 0.3em 0;
    padding-left: 1.5em;
  }
  .text :global(li) { margin: 0.15em 0; }

  .text :global(strong) { color: var(--og-text); }
  .text :global(em) { font-style: italic; }

  .text :global(a.ext-link) {
    color: var(--og-chat);
    text-decoration: underline;
    text-decoration-style: dotted;
  }
  .text :global(a.ext-link:hover) {
    text-decoration-style: solid;
  }

  .text :global(a.file-link) {
    color: var(--og-accent-2);
    text-decoration: underline;
    text-decoration-style: dotted;
    cursor: pointer;
  }
  .text :global(a.file-link:hover) {
    text-decoration-style: solid;
  }

  .text :global(code) {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    background: var(--og-surface);
    padding: 1px 4px;
    border-radius: 3px;
    color: var(--og-accent-2);
  }

  .text :global(blockquote) {
    margin: 0.4em 0;
    padding: 4px 12px;
    border-left: 3px solid var(--og-text-muted);
    opacity: 0.85;
  }

  .text :global(img) {
    max-width: 100%;
    max-height: 400px;
    border-radius: 6px;
    margin: 0.4em 0;
    border: 1px solid var(--og-border);
  }

  .text :global(hr) {
    border: none;
    border-top: 1px solid var(--og-border);
    margin: 0.6em 0;
  }

  .text :global(table) {
    border-collapse: collapse;
    margin: 0.4em 0;
    font-size: 11px;
  }
  .text :global(th), .text :global(td) {
    border: 1px solid var(--og-border);
    padding: 3px 8px;
    text-align: left;
  }
  .text :global(th) {
    background: var(--og-surface);
    font-weight: 600;
  }

  /* --- Code blocks --- */
  .text :global(.code-block) {
    margin: 0.5em 0;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid var(--og-border);
    background: var(--og-bg);
  }

  .text :global(.code-header) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 10px;
    background: var(--og-surface);
    border-bottom: 1px solid var(--og-border);
  }

  .text :global(.code-lang) {
    font-size: 10px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  /* The unparsed-chart hint — warning-coloured so a chart that did not draw
     is noticed, not another muted label in a code header. `.code-header` is
     justify-content: space-between, so a THIRD child lands centred, adrift
     between the lang label and Copy; the auto right margin absorbs the free
     space instead, putting the hint beside the label it explains. */
  .text :global(.chart-hint) {
    font-size: 10px;
    color: var(--og-warning);
    margin-right: auto;
  }

  .text :global(.copy-btn) {
    font-size: 10px;
    padding: 1px 8px;
    background: transparent;
    color: var(--og-text-muted);
    border: 1px solid var(--og-border);
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
  }
  .text :global(.copy-btn:hover) {
    color: var(--og-text);
    background: var(--og-btn-bg);
  }

  .text :global(pre) {
    margin: 0;
    padding: 10px 12px;
    overflow-x: auto;
    font-size: 12px;
    line-height: 1.5;
  }

  .text :global(pre code) {
    background: none;
    padding: 0;
    border-radius: 0;
    color: var(--og-text);
    font-size: inherit;
  }

  /* --- highlight.js token colors (VS Code-inspired dark theme) --- */
  .text :global(.hljs-keyword) { color: #c586c0; }
  .text :global(.hljs-built_in) { color: #dcdcaa; }
  .text :global(.hljs-type) { color: #4ec9b0; }
  .text :global(.hljs-literal) { color: #569cd6; }
  .text :global(.hljs-number) { color: #b5cea8; }
  .text :global(.hljs-string) { color: #ce9178; }
  .text :global(.hljs-regexp) { color: #d16969; }
  .text :global(.hljs-comment) { color: #6a9955; font-style: italic; }
  .text :global(.hljs-function) { color: #dcdcaa; }
  .text :global(.hljs-params) { color: #9cdcfe; }
  .text :global(.hljs-variable) { color: #9cdcfe; }
  .text :global(.hljs-attr) { color: #9cdcfe; }
  .text :global(.hljs-title) { color: #dcdcaa; }
  .text :global(.hljs-title.function_) { color: #dcdcaa; }
  .text :global(.hljs-title.class_) { color: #4ec9b0; }
  .text :global(.hljs-selector-class) { color: #d7ba7d; }
  .text :global(.hljs-selector-tag) { color: #569cd6; }
  .text :global(.hljs-property) { color: #9cdcfe; }
  .text :global(.hljs-meta) { color: #569cd6; }
  .text :global(.hljs-punctuation) { color: #d4d4d4; }
  .text :global(.hljs-operator) { color: #d4d4d4; }
  .text :global(.hljs-tag) { color: #569cd6; }
  .text :global(.hljs-name) { color: #569cd6; }
  .text :global(.hljs-addition) { color: #b5cea8; background: rgba(74, 222, 128, 0.1); }
  .text :global(.hljs-deletion) { color: #ce9178; background: rgba(248, 113, 113, 0.1); }
</style>
