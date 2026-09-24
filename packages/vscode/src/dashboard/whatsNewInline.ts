// whatsNewInline.ts — pure expansion of the diagram and screenshot tokens in a curated
// What's new note (packages/vscode/whats-new/<version>.md, t-v5r1fd). No vscode, no fs:
// the caller passes lookups, so the rules are testable with plain strings.
//
// A token sits on its own line:
//   {{diagram:<name>|<caption>}}  -> whats-new/diagrams/<name>.svg, inlined, so the
//                                    SVG's classes take the theme's --og-* colours
//   {{shot:<name>|<caption>}}     -> whats-new/shots/<name>.png when it exists; else a
//                                    marked placeholder in the owner's preview only,
//                                    and nothing in the real pop-up

const TOKEN_RE = /^\{\{(diagram|shot):([a-z0-9-]+)\|([^}\r\n]*)\}\}[ \t]*$/gm;

export interface WhatsNewLookups {
  /** The SVG markup of a diagram, or undefined when the file is missing. */
  diagram(name: string): string | undefined;
  /** The webview URI of a screenshot, or undefined when the owner has not added it. */
  shot(name: string): string | undefined;
  /** True in the owner's preview: show placeholders for missing screenshots. */
  preview: boolean;
}

/** Every token name in a note, by kind. The drift test uses it to check each file exists. */
export function whatsNewTokens(markdown: string): Array<{ kind: 'diagram' | 'shot'; name: string; caption: string }> {
  return [...markdown.matchAll(TOKEN_RE)].map((m) => ({ kind: m[1] as 'diagram' | 'shot', name: m[2], caption: m[3].trim() }));
}

export function expandWhatsNewTokens(markdown: string, lookups: WhatsNewLookups): string {
  return markdown.replace(TOKEN_RE, (_all, kind: string, name: string, rawCaption: string) => {
    const caption = `<figcaption>${escapeHtml(rawCaption.trim())}</figcaption>`;
    if (kind === 'diagram') {
      const svg = lookups.diagram(name);
      return svg ? `<figure class="wn-fig">${inlineSvg(svg)}${caption}</figure>` : '';
    }
    const uri = lookups.shot(name);
    if (uri) {
      return `<figure class="wn-shot"><img src="${escapeHtml(uri)}" alt="${escapeHtml(rawCaption.trim())}" />${caption}</figure>`;
    }
    if (!lookups.preview) return '';
    return (
      `<figure class="wn-shot wn-shot-missing"><div class="wn-shot-slot">Screenshot to come: ` +
      `<code>whats-new/shots/${name}.png</code></div>${caption}</figure>`
    );
  });
}

/** An SVG file as one HTML block: no XML prolog, no comments, no blank lines (a blank
 *  line would end the markdown HTML block in the middle of the figure). */
function inlineSvg(svg: string): string {
  return svg
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
