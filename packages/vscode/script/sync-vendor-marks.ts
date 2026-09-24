// Regenerates webview/shared/vendorMarks.ts's VENDOR_MARK_PATHS table from
// the `simple-icons` package (CC0/public domain) — t-qi0qrh follow-up: the
// owner asked for the companies' ACTUAL icons, not invented glyphs.
//
// simple-icons is a devDependency ONLY. This script runs at dev time and
// writes plain path-string literals into vendorMarks.ts; the runtime bundle
// never imports `simple-icons` itself (verified by `grep` in the deploy
// ritual — a bundle importing the whole icon set would drag in thousands of
// unused paths).
//
// Run: bun run script/sync-vendor-marks.ts
// (or: npx tsx script/sync-vendor-marks.ts)

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import * as si from 'simple-icons';

// One row per vendor id used by webview/shared/vendorMarks.ts's
// matchVendorMarkId(). `key` is the simple-icons export name; `null` means
// simple-icons has no icon for this vendor (checked 2026-09-21 against
// simple-icons@16.31.0) — those keep the hand-drawn fallback glyph already
// in vendorMarks.ts instead of being touched by this script.
const SOURCES: Array<{ id: string; key: string | null; note?: string }> = [
  { id: 'anthropic', key: 'siAnthropic' },
  { id: 'openai', key: null, note: 'simple-icons has no OpenAI icon; path supplied by the owner (2026-09-21, the OpenAI mark, 24x24)' },
  { id: 'google', key: 'siGooglegemini', note: 'Gemini mark specifically, not the generic Google "G"' },
  { id: 'meta', key: 'siMeta' },
  { id: 'mistral', key: 'siMistralai' },
  { id: 'xai', key: null, note: 'simple-icons only has "X" (X Corp); path supplied by the owner (2026-09-21, the xAI brand mark scaled from 466x517 to 24x24)' },
  { id: 'deepseek', key: 'siDeepseek' },
  { id: 'qwen', key: 'siQwen' },
  { id: 'openrouter', key: 'siOpenrouter' },
  { id: 'githubcopilot', key: 'siGithubcopilot' },
  { id: 'lmstudio', key: 'siLmstudio' },
  { id: 'ollama', key: 'siOllama' },
  // t-s9k0q6: the OS marks for the sidebar's desk chips (DeskChip.svelte).
  // Not vendors, so matchVendorMarkId() never returns them; they share the
  // table because the shape (one 24x24 path, fill="currentColor") is the same.
  { id: 'macos', key: 'siApple' },
  { id: 'linux', key: 'siLinux' },
  { id: 'windows', key: null, note: 'simple-icons has no Windows icon; four squares, a plain geometric stand-in' },
];

// The hand-drawn fallback for the two vendors simple-icons does not cover —
// same paths vendorMarks.ts already shipped, kept verbatim so `openai`/`xai`
// do not silently change shape when this script reruns.
const FALLBACK_PATHS: Record<string, string> = {
  openai: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
  xai: 'M1.187 8.483 L12.052 24.0 L16.881 24.0 L6.016 8.483 L1.187 8.483Z M1.181 24.0 L6.014 24.0 L8.428 20.552 L6.012 17.101 L1.181 24.0Z M22.819 0.0 L17.986 0.0 L9.636 11.925 L12.052 15.376 L22.819 0.0Z M18.86 24.0 L22.819 24.0 L22.819 1.725 L18.86 7.378 L18.86 24.0Z',
  windows: 'M1 1h10.5v10.5H1Zm11.5 0H23v10.5H12.5ZM1 12.5h10.5V23H1Zm11.5 0H23V23H12.5Z',
};
// The owner-supplied openai path and the hand-drawn xai glyph both fill
// correctly under the SVG default (nonzero); no entry opts into evenodd.
const FALLBACK_FILL_RULE: Record<string, 'evenodd'> = {};

interface Entry {
  path: string;
  fillRule?: 'evenodd';
  source: string;
}

const entries: Record<string, Entry> = {};
for (const { id, key, note } of SOURCES) {
  if (key) {
    const icon = (si as Record<string, { path: string; title: string }>)[key];
    if (!icon) throw new Error(`simple-icons export "${key}" not found for vendor "${id}" — check the package version`);
    entries[id] = { path: icon.path, source: `${icon.title} — Simple Icons, CC0` };
  } else {
    entries[id] = {
      path: FALLBACK_PATHS[id],
      fillRule: FALLBACK_FILL_RULE[id],
      source: `hand-drawn (not in Simple Icons)${note ? ' — ' + note : ''}`,
    };
  }
}

function renderTable(): string {
  const lines: string[] = [];
  for (const { id } of SOURCES) {
    const e = entries[id];
    lines.push(`  // ${id}: ${e.source}`);
    const fillRule = e.fillRule ? `, fillRule: '${e.fillRule}'` : '';
    lines.push(`  ${id}: { path: '${e.path}'${fillRule} },`);
  }
  return lines.join('\n');
}

const OUT_FILE = path.resolve(import.meta.dirname, '..', 'webview', 'shared', 'vendorMarks.ts');

const HEADER = `// Vendor marks — t-qi0qrh: inline monochrome SVG glyphs for the model
// picker's source tabs, in place of a coloured monogram badge for the big
// providers. A pure LEAF: no DOM, no host wiring, matchVendorMarkId() only
// classifies a display name/id string.
//
// GENERATED by script/sync-vendor-marks.ts — do not hand-edit the table
// below; rerun the script instead. Ten of the twelve paths are the vendor's
// REAL mark, copied from the \`simple-icons\` package (CC0 / public domain,
// https://github.com/simple-icons/simple-icons — devDependency only, never
// imported by the runtime bundle). Two vendors simple-icons does not cover
// (openai, xai) keep a hand-drawn stand-in; see each entry's comment.
// The last three rows are OS marks for the sidebar's desk chips (t-s9k0q6):
// Apple and Linux from simple-icons, Windows a hand-drawn four squares.
//
// Rendered with fill="currentColor" in ModelPickerTab.svelte; a path's own
// \`fillRule\` defaults to the SVG standard (nonzero) unless the table says
// 'evenodd' — simple-icons paths are wound for nonzero, the two hand-drawn
// fallbacks are not.

export interface VendorMarkPath {
  /** SVG path \`d\` attribute, 24x24 viewBox. */
  path: string;
  /** 'evenodd' only for the hand-drawn fallbacks that need it to punch a hole. */
  fillRule?: 'evenodd';
}

export const VENDOR_MARK_PATHS: Record<string, VendorMarkPath> = {
${renderTable()}
};
`;

const RESOLVER = `
/** Ordered, most-specific-first: a name/id is checked against each pattern in
 *  turn and the first match wins. Substring-based (not the picker's own
 *  vendorKey, which only reads the FIRST word of a name and would mis-key
 *  multi-word display names like "LM Studio" or "GitHub Copilot"). */
const VENDOR_ALIASES: Array<[RegExp, string]> = [
  [/ollama/, 'ollama'],
  [/anthropic|claude/, 'anthropic'],
  [/openai|\\bgpt\\b/, 'openai'],
  [/gemini|google/, 'google'],
  [/llama|meta/, 'meta'],
  [/mistral/, 'mistral'],
  [/\\bxai\\b|grok/, 'xai'],
  [/deepseek/, 'deepseek'],
  [/qwen/, 'qwen'],
  [/openrouter/, 'openrouter'],
  [/copilot/, 'githubcopilot'],
  [/lm ?studio/, 'lmstudio'],
];

/** A vendor mark id for a display name or provider id, or undefined when none
 *  of the twelve named vendors match — the caller falls back to the monogram. */
export function matchVendorMarkId(nameOrId: string): string | undefined {
  const n = (nameOrId ?? '').toLowerCase();
  for (const [pattern, id] of VENDOR_ALIASES) if (pattern.test(n)) return id;
  return undefined;
}
`;

writeFileSync(OUT_FILE, HEADER + RESOLVER, 'utf8');
console.log(`Wrote ${OUT_FILE}`);
for (const { id, key, note } of SOURCES) {
  console.log(`  ${id.padEnd(14)} ${key ? `simple-icons.${key} (${entries[id].source})` : `FALLBACK — ${note}`}`);
}
