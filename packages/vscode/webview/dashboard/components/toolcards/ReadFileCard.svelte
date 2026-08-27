<script lang="ts">
  // Pillar 2 dashboard upgrade (2026-05-22) — specialised renderer for
  // read_file results. The runtime echoes the raw file contents back.
  // For images, the result is a `[IMAGE:mime;base64,data]` marker
  // and the multimodal pipeline handles it separately; that case
  // never reaches this card.
  //
  // We try to derive a sensible language hint from the path that
  // appears in the title prefix (the runtime renders the call as
  // "read_file <path>" or similar). Highlight.js is shared with
  // MessageRow's fence rendering via the same import path.

  // Use the shared `lib/core` instance — languages are already
  // registered by MessageRow.svelte at module init time, so the
  // same hljs singleton can highlight any of those languages here
  // without duplicating registrations or pulling in the full
  // highlight.js bundle. Critical for bundle size: importing the
  // default `from 'highlight.js'` ballooned the dashboard from
  // ~820 kB to 2.5 MB.
  import hljs from 'highlight.js/lib/core';

  interface Props {
    result: string;
  }

  let { result }: Props = $props();

  // Language inference: look for a path on the first preamble-ish
  // line (e.g. `Read <bytes> from path/to/file.rs`) or fall back to
  // plaintext. Conservative — only highlight when we recognise an
  // extension highlight.js supports.
  const LANG_BY_EXT: Record<string, string> = {
    rs: 'rust', ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript',
    py: 'python', go: 'go', java: 'java',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    yml: 'yaml', yaml: 'yaml',
    toml: 'ini', ini: 'ini',
    json: 'json', md: 'markdown',
    html: 'xml', xml: 'xml',
    css: 'css', scss: 'css',
    sql: 'sql', svelte: 'xml',
  };

  function inferLang(text: string): string {
    // The runtime sometimes prefixes the body with a `Read N bytes
    // from <path>` header. Try the first line first.
    const firstLine = text.split('\n', 1)[0] ?? '';
    const m = /([A-Za-z0-9_\-./]+)\.([a-zA-Z0-9]+)\b/.exec(firstLine);
    if (m) {
      const lang = LANG_BY_EXT[m[2].toLowerCase()];
      if (lang) return lang;
    }
    return '';
  }

  // Strip the optional preamble header so we don't double-render it
  // when we know what to do with it. The body is everything that
  // looks like code; the header (if any) is shown separately above.
  function split(text: string): { header: string | null; body: string } {
    const lines = text.split('\n');
    const first = lines[0] ?? '';
    if (/^Read \d+ bytes from /.test(first) || /^File:/.test(first)) {
      return { header: first, body: lines.slice(1).join('\n').trimStart() };
    }
    return { header: null, body: text };
  }

  let split_ = $derived(split(result));
  let lang = $derived(inferLang(result));
  let highlighted = $derived.by(() => {
    if (!lang) return null;
    try {
      return hljs.highlight(split_.body, { language: lang, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  });

  const LINE_THRESHOLD = 40;
  let lineCount = $derived(split_.body.split('\n').length);
  let collapsible = $derived(lineCount > LINE_THRESHOLD);
  let collapsed = $state(false);
  $effect(() => {
    // Default-collapsed when the file is huge; default-open otherwise.
    if (collapsible && lineCount > LINE_THRESHOLD * 3) {
      collapsed = true;
    }
  });
</script>

<div class="readfile-card">
  {#if split_.header}
    <div class="readfile-header">{split_.header}</div>
  {/if}
  {#if collapsible}
    <button
      class="readfile-toggle"
      onclick={() => collapsed = !collapsed}
      title={collapsed ? 'Expand' : 'Collapse'}
    >
      {collapsed ? `▶ Show ${lineCount} lines` : `▼ Hide ${lineCount} lines`}
    </button>
  {/if}
  {#if !collapsed}
    <pre class="readfile-body"><code>{#if highlighted}{@html highlighted}{:else}{split_.body}{/if}</code></pre>
  {/if}
</div>

<style>
  .readfile-card {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
  }

  .readfile-header {
    color: var(--og-text-muted);
    font-style: italic;
    margin-bottom: 4px;
  }

  .readfile-toggle {
    background: none;
    border: none;
    padding: 2px 0;
    color: var(--og-accent, #89b4fa);
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    text-align: left;
  }
  .readfile-toggle:hover {
    text-decoration: underline;
  }

  .readfile-body {
    margin: 4px 0 0 0;
    padding: 4px 6px;
    background: var(--og-bg, #181825);
    border-radius: 3px;
    color: var(--og-text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.4;
  }

  .readfile-body :global(.hljs-keyword)  { color: #cba6f7; }
  .readfile-body :global(.hljs-string)   { color: #a6e3a1; }
  .readfile-body :global(.hljs-number)   { color: #fab387; }
  .readfile-body :global(.hljs-comment)  { color: #6c7086; font-style: italic; }
  .readfile-body :global(.hljs-function) { color: #89b4fa; }
  .readfile-body :global(.hljs-title)    { color: #89b4fa; }
  .readfile-body :global(.hljs-type)     { color: #f9e2af; }
</style>
