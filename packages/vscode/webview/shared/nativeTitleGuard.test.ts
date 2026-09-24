// t-v483ot — the house tooltip guard.
//
// Controls use the warm tooltip (`use:tip`, warmTip.ts), not a native `title`.
// On 0.4.173 the new controls (Connections Refresh, find LOADED/ALL, the find
// arrows, ...) all shipped with a bare `title`, so the owner saw the plain
// browser tooltip beside warm ones.
//
// Many older native titles remain. nativeTitleBaseline.json holds each file's
// count as a ratchet: a file may not gain one, and a file that loses one must
// lower its number (so the ratchet never holds slack that a new title could
// use). A new .svelte file starts at zero. A real exception (an element where
// the tooltip must be native) goes in the baseline with a reason in the commit.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findNativeTitles } from './nativeTitleScan';
import baseline from './nativeTitleBaseline.json';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function svelteFiles(): string[] {
  return readdirSync(path.join(pkgRoot, 'webview'), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.svelte'))
    .map((f) => `webview/${f.split(path.sep).join('/')}`)
    .sort();
}

describe('findNativeTitles — the scan itself', () => {
  it('counts a title on a native button or span', () => {
    expect(findNativeTitles('<button title="Refresh">R</button>')).toHaveLength(1);
    expect(findNativeTitles('<span class="x" title={label}>x</span>')).toHaveLength(1);
    expect(findNativeTitles('<button\n  {title}\n  aria-label={title}\n>x</button>')).toHaveLength(1);
  });

  it('is not ended early by an arrow function or a > inside the tag', () => {
    const src = '<button onclick={() => (n > 1 ? a() : b())} class="c"\n  title="Next (Enter)">x</button>';
    expect(findNativeTitles(src)).toEqual([{ tag: 'button', line: 1 }]);
  });

  it('ignores use:tip, component props, object keys, script, style and comments', () => {
    const src = [
      '<script lang="ts">const t = { title: "x" }; const h = \'<button title="x">\';</script>',
      '<!-- <button title="old"> -->',
      '<button use:tip={\'Refresh\'} aria-label="Refresh">R</button>',
      '<ConnectionPill title="LM Studio" />',
      '<button onclick={() => open({ title: row.title })}>Open</button>',
      '<iframe title="Preview" src="x"></iframe>',
      '<style>button[title] { color: red; }</style>',
    ].join('\n');
    expect(findNativeTitles(src)).toEqual([]);
  });

  it('reports the line of the tag', () => {
    expect(findNativeTitles('<div>\n\n<span title="x">x</span></div>')).toEqual([{ tag: 'span', line: 3 }]);
  });
});

describe('no new native title tooltips in the webview', () => {
  const files = svelteFiles();

  it('scans the real webview (a guard that reads nothing proves nothing)', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('webview/chat/ConnectionsHeader.svelte');
  });

  it('holds every .svelte file to its baseline count of native titles', () => {
    const allowed = baseline as Record<string, number>;
    const problems: string[] = [];
    for (const rel of files) {
      const hits = findNativeTitles(readFileSync(path.join(pkgRoot, rel), 'utf8'));
      const max = allowed[rel] ?? 0;
      if (hits.length > max) {
        const where = hits.map((h) => `${rel}:${h.line} <${h.tag}>`).join(', ');
        problems.push(`${rel}: ${hits.length} native title(s), baseline ${max}. Use use:tip (warmTip.ts) instead: ${where}`);
      } else if (hits.length < max) {
        problems.push(`${rel}: ${hits.length} native title(s), baseline ${max}. Lower the baseline in nativeTitleBaseline.json to ${hits.length}`);
      }
    }
    for (const rel of Object.keys(allowed)) {
      if (!files.includes(rel)) problems.push(`${rel}: in nativeTitleBaseline.json but no longer exists. Remove the entry`);
    }
    expect(problems).toEqual([]);
  });
});
