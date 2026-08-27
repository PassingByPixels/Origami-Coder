// Collabs — collabMarkdown.ts: the collab stream's markdown pipeline,
// mirroring MessageRow.svelte (the chat message renderer) so a collab bubble
// reads the same as a chat one — same escaping, same syntax-highlighted code
// blocks. Kept its own module rather than duplicated inline in
// CollabStream.svelte, which sits close to its architecture cap.
//
// Configured PER CALL — options passed straight to marked.parse, never
// marked.setOptions — deliberately. ChatView.svelte mounts CollabPane
// unconditionally (only `collabMode` decides which one RENDERS), so this
// module and MessageRow's own marked.setOptions() call both live in the one
// chat webview bundle. A shared mutable global would let whichever loaded
// last silently override the other's renderer; a per-call options object
// cannot be raced.
//
// `renderer.link` is narrower than MessageRow's: collab bubbles have no
// vscode-message wiring to open a file, so every link renders as an ordinary
// external one rather than a file-link that looks clickable and does nothing.

import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import { renderChartBlock } from '../shared/chartBlock';
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
import markdownLang from 'highlight.js/lib/languages/markdown';
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
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('markdown', markdownLang);
hljs.registerLanguage('md', markdownLang);
hljs.registerLanguage('lua', lua);
hljs.registerLanguage('toml', toml);
hljs.registerLanguage('ini', toml);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('text', plaintext);

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const renderer = new marked.Renderer();

// Shown in the header of a `chart` fence the renderer could not parse. A spec
// that failed used to fall through to an anonymous code block and say NOTHING:
// a live session emitted YAML into the fence, parseSpec only ever calls
// JSON.parse, and every chart in that session silently became a code block
// nobody questioned. The body still shows the user's text — the header now says
// why there is no picture, and what the fence actually takes.
const CHART_HINT = '<span class="chart-hint">chart spec did not parse — this fence takes JSON</span>';

// Same markup as MessageRow's code renderer — a header (language + Copy
// button) over a highlight.js-highlighted <pre><code> — so the two surfaces'
// code blocks share one CSS contract. The `chart` branch mirrors MessageRow's
// own renderer.code; keep the two in sync.
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
    highlighted = language ? hljs.highlight(code, { language }).value : hljs.highlightAuto(code).value;
  } catch {
    highlighted = escapeHtml(code);
  }
  const langLabel = lang || 'text';
  return `<div class="code-block"><div class="code-header"><span class="code-lang">${escapeHtml(langLabel)}</span>${chartHint}<button class="copy-btn" data-code="${escapeAttr(code)}">Copy</button></div><pre><code class="hljs">${highlighted}</code></pre></div>`;
};
renderer.link = ({ href, text: linkText }: { href: string; text: string }) =>
  `<a href="${escapeAttr(href)}" class="ext-link" title="${escapeAttr(href)}">${linkText}</a>`;

const MARKED_OPTIONS = { renderer, breaks: true, gfm: true };

/** One collab message, rendered the way chat renders one: markdown (with the
 *  same highlighted code blocks) for an agent, escaped plain text with hard
 *  breaks for a human — mirrors MessageRow's kind==='agent' gate exactly,
 *  since a human typing a literal `**` almost never means bold. Trimmed:
 *  marked trails every block with its own newline, which would otherwise
 *  show up as a stray blank text node once the HTML is inserted. */
export function renderCollabMessage(text: string, kind: 'human' | 'agent'): string {
  const html =
    kind === 'agent' ? (marked.parse(text, MARKED_OPTIONS) as string) : escapeHtml(text).replace(/\n/g, '<br>');
  return html.trim();
}
