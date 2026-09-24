// DRIFT GUARDS for the phone shell.
//
// The shell is three mirrors held together by string literals, and every one
// of them fails SILENTLY when it drifts:
//
//   1. index.html declares element ids that ui.ts / main.ts query by name. A
//      rename leaves the PIN sheet inert — no error, no sheet, no approval.
//   2. remote.css hides affordances by the chat bundle's own class names. If
//      the bundle renames one, the gate stops hiding it and a phone tap starts
//      opening files on the desktop again. Nothing goes red.
//   3. index.html references files esbuild has to put beside it. A missing
//      copy is a 404 in a browser nobody is watching.
//
// Each test reads BOTH files, per the mirror rule in the agent guide.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..', '..');
const read = (rel: string) => readFileSync(path.join(pkgRoot, rel), 'utf8');

const HTML = read('webview/remote/index.html');
const CSS = read('webview/remote/remote.css');
const UI = read('webview/remote/ui.ts');
const MAIN = read('webview/remote/main.ts');
/** The bundle loader moved out of main.ts when the repair watch moved in; the
 *  contract below is about what the SHELL fetches, so it reads both. */
const BUNDLE = read('webview/remote/bundle.ts');
const SESSIONS = read('webview/remote/sessions.ts');
const ESBUILD = read('esbuild.js');

/** remote.css with its comments stripped: what the browser actually paints. */
const DECLS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every id the shell's TypeScript looks up by name. */
function queriedIds(src: string): string[] {
  return [...src.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
}

describe('index.html <-> the code that queries it', () => {
  it('declares every id ui.ts and main.ts fetch by name', () => {
    const ids = [...new Set([...queriedIds(UI), ...queriedIds(MAIN), ...queriedIds(SESSIONS)])];
    expect(ids.length).toBeGreaterThan(3);
    for (const id of ids) {
      expect(HTML, `index.html has no element with id="${id}"`).toContain(`id="${id}"`);
    }
  });

  it('mounts #app, which the chat bundle targets by that exact id', () => {
    // webview/chat/main.ts: document.getElementById('app').
    expect(read('webview/chat/main.ts')).toContain("getElementById('app')");
    expect(HTML).toContain('id="app"');
  });

  it('loads chat.css BEFORE remote.css, so the phone overrides win', () => {
    // chat.css carries the :root[data-theme] --og-* palettes; remote.css only
    // overrides. Swap the order and the overrides lose on equal specificity.
    expect(HTML.indexOf('href="chat.css"')).toBeLessThan(HTML.indexOf('href="remote.css"'));
    expect(HTML.indexOf('href="chat.css"')).toBeGreaterThan(-1);
  });

  it('does NOT load chat.js with a static tag', () => {
    // ChatView reads __ORIGAMI_SOLO_SESSION__ during mount, so main.ts must
    // inject the bundle after the desktop names a session. A static tag here
    // would boot the bundle into SidebarLauncher: no transcript, no composer.
    expect(HTML).not.toMatch(/<script[^>]+src="chat\.js"/);
    expect(BUNDLE).toContain("s.src = 'chat.js'");
  });

  it('carries its own CSP, since a static file gets no webview nonce', () => {
    expect(HTML).toContain('Content-Security-Policy');
    expect(HTML).not.toContain('nonce-');
    // The socket is the one connection the page is allowed to make.
    expect(HTML).toMatch(/connect-src[^;"]*wss:/);
    // esbuild-svelte compiles component styles with css:'injected', which
    // writes <style> at runtime — blocked without this.
    expect(HTML).toMatch(/style-src[^;"]*'unsafe-inline'/);
  });
});

describe('remote.css feature gates <-> the chat bundle they hide', () => {
  // Each entry: the selector remote.css gates on, and the bundle source that
  // must still emit it. If the bundle renames the class, this goes red rather
  // than the gate quietly doing nothing.
  const GATES: Array<[selector: string, source: string, marker: string]> = [
    ['a.file-link', 'webview/dashboard/components/MessageRow.svelte', 'class="file-link"'],
    ['.tool-path', 'webview/dashboard/components/ToolCard.svelte', 'class="tool-path"'],
    ['.tab-popout', 'webview/dashboard/panes/ChatPane.svelte', 'class="tab-popout"'],
    // The Export button carries a CLASS for this gate: its title became a warm
    // tooltip, and a title selector would have stopped hiding it in silence.
    [
      'button.export-md-btn',
      'webview/dashboard/components/ComposerModeRow.svelte',
      'class="mode-btn export-md-btn"',
    ],
  ];

  for (const [selector, source, marker] of GATES) {
    it(`gates ${selector}, and ${path.basename(source)} still emits it`, () => {
      expect(CSS, `remote.css no longer gates ${selector}`).toContain(selector);
      expect(read(source), `${source} no longer emits ${marker}`).toContain(marker);
    });
  }

  it('gates the composer and transcript selectors the layout depends on', () => {
    for (const [selector, source] of [
      ['.input-area', 'webview/dashboard/components/InputBar.svelte'],
      ['.cell-messages', 'webview/dashboard/panes/ChatPane.svelte'],
      ['.chat-grid', 'webview/dashboard/panes/ChatPane.svelte'],
      ['.chat-cell', 'webview/dashboard/panes/ChatPane.svelte'],
      ['textarea.input', 'webview/dashboard/components/InputBar.svelte'],
    ] as const) {
      expect(CSS).toContain(selector);
      const bare = selector.replace('textarea', '').replace('.', '');
      expect(read(source), `${source} no longer has .${bare}`).toContain(`class="${bare}"`);
    }
  });

  it('uses only --og-* tokens, never a literal colour', () => {
    // Part 7 of the agent guide: a literal here would ignore the user's theme
    // on all four palettes, and no screenshot of one theme would show it.
    // Comments are stripped first — this guard is about what the browser
    // paints, and a comment EXPLAINING why rgba() was avoided is not a
    // violation of the rule it is documenting. (It read as one, once.)
    const literals = [
      ...DECLS.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
      ...DECLS.matchAll(/\brgba?\(/g),
      ...DECLS.matchAll(/\bhsla?\(/g),
    ].map((m) => m[0]);
    expect(literals, `remote.css hard-codes ${literals.join(', ')}`).toEqual([]);
  });

  it('names only tokens that shared/theme.css actually defines', () => {
    // `var(--og-green, #4caf50)` once silently defeated theming everywhere.
    const defined = new Set([...read('webview/shared/theme.css').matchAll(/(--og-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...DECLS.matchAll(/var\((--og-[a-z0-9-]+)/g)].map((m) => m[1]));
    expect([...used].filter((t) => !defined.has(t))).toEqual([]);
    expect(used.size).toBeGreaterThan(5);
  });
});

describe('esbuild remote entry <-> what index.html asks the browser to fetch', () => {
  it('copies every local file the shell fetches at runtime', () => {
    const refs = [
      ...[...HTML.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]),
      // chat.js is not in the HTML — bundle.ts injects it after mount — so the
      // copy list has to be checked against BOTH sources, not just the markup.
      ...[...(MAIN + BUNDLE).matchAll(/\.src = '([^']+)'/g)].map((m) => m[1]),
    ].filter((u) => !/^(https?:|data:|#)/.test(u));
    expect(refs).toContain('chat.js');
    for (const ref of refs) {
      const emitted = ref === 'remote.js' || ref === 'remote.css'; // esbuild outputs
      expect(emitted || ESBUILD.includes(`'${ref}'`), `esbuild.js never puts ${ref} in out/remote`).toBe(true);
    }
  });

  it('serves the SAME chat bundle the VS Code panel loads', () => {
    // Copied, not rebuilt: one bundle, two hosts. A second build would let the
    // phone drift from the desktop with nothing to notice it.
    expect(ESBUILD).toContain("['out/webview/chat.js', 'chat.js']");
    expect(ESBUILD).toContain("['out/webview/chat.css', 'chat.css']");
  });

  it('ships an icon the manifest can point at', () => {
    const manifest = JSON.parse(read('webview/remote/manifest.webmanifest')) as { icons: Array<{ src: string }> };
    for (const icon of manifest.icons) expect(ESBUILD).toContain(`'${icon.src}'`);
    expect(HTML).toContain('href="manifest.webmanifest"');
  });
});
