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
  import { getVsCodeApi } from '../../../shared/vscodeApi';
  import { fitToPane } from './readImageFit';
  import type { ToolReadImage } from '../../panes/chatToolMsg';

  const vscode = getVsCodeApi();

  interface Props {
    result: string;
    /** Set when the model read an IMAGE file. `src` is this surface's own
     *  resource URI for that file, never the model's base64 copy; `thumb` is
     *  the phone's capped JPEG in its place. The size-and-path line shows
     *  when neither could be made. */
    readImage?: ToolReadImage;
    /** t-l1sovi/t-mdjavm — clicking the PICTURE lighthouses it (opens the
     *  shared lightbox); the PATH text is a separate link that opens the
     *  file in the editor. Absent means no lightbox is wired up (the card
     *  falls back to the old open-in-editor click, so it is never dead). */
    onImageClick?: (src: string, alt: string) => void;
  }

  let { result, readImage, onImageClick }: Props = $props();

  // Whole KB, so a 3 KB icon does not read as "0 KB".
  let sizeKb = $derived(Math.max(1, Math.round((readImage?.bytes ?? 0) / 1024)));
  // `src` (desktop, a real resource URI) wins over `thumb` (the phone's
  // capped JPEG) when a surface somehow has both; neither means the
  // size-and-path placeholder.
  let pictureSrc = $derived(readImage?.src ?? readImage?.thumb);
  let picture = $derived(pictureSrc ? readImage : undefined);
  // The picture IS the card's body: it shows whenever the card is expanded and
  // hides with it. t-fh57s9 removed the card's own Show/Hide image toggle —
  // ToolCard's header pill is the single control.
  //
  // CHANGES.md change 46 — the PATH reveals the file in the OS explorer rather
  // than opening an editor tab on it. A path is the answer to "where is this?",
  // and for a picture the answer the owner wants is the folder it is in.
  function revealImage() {
    if (readImage?.path) vscode.postMessage({ type: 'revealInExplorer', path: readImage.path });
  }

  // t-l1sovi — the picture itself now lighthouses (enlarges + enhances in the
  // shared lightbox) instead of opening the file. Falls back to the old
  // open-in-editor click if no lightbox handler was wired up, so a caller
  // that forgets the prop still gets a working click rather than a dead one.
  function clickImage() {
    if (onImageClick && pictureSrc) onImageClick(pictureSrc, `Image read by the agent: ${readImage?.path ?? ''}`);
    else revealImage();
  }

  // t-mdjavm — the path text is the control. Desktop only: `src` is a real
  // webview resource URI for a local file, which is what proves this surface
  // has a real filesystem behind it. The phone/remote surface never gets a
  // `src` (see toolImageCard.ts) — only `thumb` — so its path renders as plain
  // text, and `revealInExplorer` is refused for it on the wire besides
  // (remoteRefusalsTable.ts): there is no explorer in a pocket.
  let canReveal = $derived(!!readImage?.src);

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
  {#if readImage}
    {#if picture}
      <!-- Click enlarges + enhances the picture (the lightbox) — see
           clickImage() above. Opening the real file is the path link below. -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <!-- `use:fitToPane` keeps --readimg-cap equal to the transcript's own
           height, so the picture draws at its natural size up to the PANE and
           re-bounds on a resize. See readImageFit.ts. -->
      <img
        class="readfile-image"
        use:fitToPane
        src={pictureSrc}
        alt={`Image read by the agent: ${picture.path}`}
        title="Enlarge"
        onclick={clickImage}
      />
      {#if canReveal}
        <button class="readfile-path-link" onclick={revealImage} title={`Reveal ${picture.path} in the file explorer`}>
          {picture.path}
        </button>
        <!-- The control spelled out: on this card the header's path is small
             and a long way from the picture it belongs to. -->
        <button class="readfile-reveal" onclick={revealImage} title={`Reveal ${picture.path} in the file explorer`}>
          {'◱'} Reveal in explorer
        </button>
      {:else}
        <div class="readfile-path-text">{picture.path}</div>
      {/if}
    {:else}
      <!-- No src, no thumb: the host could not make either one (t-fdw2j2 —
           an unreadable file, or a format the thumbnail encoder cannot
           decode above the cap). Say which picture it is and let the whole
           line open it, rather than showing a broken image or naming a
           surface ("the desktop") that may not even be this one. -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="readfile-header readfile-header--open" onclick={revealImage} title={`Reveal ${readImage?.path}`}>
        image ({sizeKb} KB) — click to reveal
      </div>
    {/if}
  {/if}
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

  .readfile-header--open {
    cursor: pointer;
  }
  .readfile-header--open:hover {
    text-decoration: underline;
  }

  /* CHANGES.md change 45 — the picture draws at its OWN size, and the pane is
     the only cap. `--readimg-cap` is written by fitToPane off the live
     transcript height; the 60vh fallback is for a card with no scrolling
     ancestor to measure, never for one inside the pane. */
  .readfile-image {
    display: block;
    max-width: 100%;
    max-height: var(--readimg-cap, 60vh);
    width: auto;
    height: auto;
    object-fit: contain;
    margin: 4px 0 0 0;
    border: 1px solid var(--og-border);
    border-radius: 3px;
    cursor: pointer;
  }

  /* The reveal control, spelled out under the picture. */
  .readfile-reveal {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin: 4px 0 0 0;
    padding: 2px 8px;
    border: 1px solid var(--og-border);
    border-radius: 5px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    font: inherit;
    font-size: 10px;
    cursor: pointer;
  }
  .readfile-reveal:hover {
    color: var(--og-text);
    border-color: color-mix(in srgb, var(--og-border) 40%, var(--og-chat));
  }

  /* t-mdjavm — the path under a read image, separate from the click-to-
     enlarge picture above it. */
  .readfile-path-link {
    display: block;
    margin: 3px 0 0 0;
    padding: 0;
    background: none;
    border: none;
    font: inherit;
    font-size: 10.5px;
    color: var(--og-accent, #89b4fa);
    cursor: pointer;
    text-align: left;
    word-break: break-all;
  }
  .readfile-path-link:hover {
    text-decoration: underline;
  }
  .readfile-path-text {
    margin: 3px 0 0 0;
    font-size: 10.5px;
    color: var(--og-text-muted);
    word-break: break-all;
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
