// Model picker tier marks — a pure LEAF, no DOM, no host wiring.
//
// t-q9013i: the Miller-column picker draws two different marks. Tier-1 (type)
// tabs get an SVG glyph keyed on the SAME ConnectionSection the picker already
// groups providers by (connectionSection.ts / modelGrouping.ts) — no string
// parsing needed, the section is already known. Tier-1b (source) tabs get a
// coloured monogram badge, because there is no section-like key for an
// individual vendor: `vendorKey` parses it out of the provider's own name
// ("Mistral: Pareto" -> mistral, "qwen3-32b" -> qwen, "llama3.3:70b" -> llama),
// mirroring projects/Mock-Redesign/redesign/redesign.js's enhanceModelPicker.
//
// These are monograms in the vendor's colour, not the real brand logos — those
// need licensed assets, so a coloured initial is the honest stand-in. Model
// rows keep no mark at all (ModelPickerRow.svelte is unchanged).

import type { ConnectionSection } from '../../sidebar/connectionSection';
import { groupTooltip, type OfferedRow } from './offeredProviders';

/** 'Local/Self Hosted' reads as 'Local' here — text and tooltip both — without
 *  touching SECTION_LABEL itself, which the sidebar's connection picker still
 *  uses unrenamed. */
export function tabLabel(name: string): string {
  return name === 'Local/Self Hosted' ? 'Local' : name;
}

/** Tier-1 tab tooltip: member count for a collapsed pill, else live/idle. */
export function tabTitle(
  tab: { collapsed: boolean; name: string; members: unknown[]; live: boolean },
  modelOptions: readonly OfferedRow[],
): string {
  if (tab.collapsed) return `${tabLabel(tab.name)} (${tab.members.length})`;
  return `${tabLabel(groupTooltip(modelOptions, tab.name))} — ${tab.live ? 'Live' : 'Idle'}`;
}

/** Tier-1b (source) tab tooltip: always live/idle, no collapsed case. */
export function subTitle(p: { name: string; live: boolean }, modelOptions: readonly OfferedRow[]): string {
  return `${groupTooltip(modelOptions, p.name)} — ${p.live ? 'Live' : 'Idle'}`;
}

export interface TypeGlyph {
  rects?: Array<{ x: number; y: number; width: number; height: number; rx?: number }>;
  paths?: string[];
}

/** One glyph per section, drawn as plain SVG primitives (no innerHTML/`{@html}`
 *  needed) so the shape is testable data, not a trusted-string hazard. */
export const TYPE_GLYPHS: Record<ConnectionSection, TypeGlyph> = {
  selfhosted: {
    rects: [
      { x: 3, y: 4, width: 18, height: 7, rx: 2 },
      { x: 3, y: 13, width: 18, height: 7, rx: 2 },
    ],
    paths: ['M7 7.5h.01', 'M7 16.5h.01'],
  },
  providers: {
    paths: ['M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.6A3.5 3.5 0 0 0 6.5 19Z'],
  },
  labs: {
    paths: ['M9 3h6', 'M10 3v6l-5 9a1.5 1.5 0 0 0 1.3 2.2h11.4A1.5 1.5 0 0 0 19 18l-5-9V3'],
  },
  other: {
    paths: ['M21 8l-9-5-9 5 9 5 9-5Z', 'M3 8v8l9 5 9-5V8'],
  },
};

/** Known vendors: [background colour, two/three-letter monogram]. Copied from
 *  the mock's `VENDOR` table (redesign.js) — same keys, same colours, so a
 *  vendor reads the same way in both places. */
const VENDOR: Record<string, [string, string]> = {
  openai: ['#10a37f', 'OA'], anthropic: ['#d97757', 'AN'], google: ['#4285f4', 'GO'],
  meta: ['#0866ff', 'ME'], mistral: ['#fa520f', 'MI'], deepseek: ['#4d6bfe', 'DS'],
  qwen: ['#6b5ce7', 'QW'], xai: ['#5b6470', 'XA'], grok: ['#5b6470', 'GK'],
  cohere: ['#39594d', 'CO'], nvidia: ['#76b900', 'NV'], microsoft: ['#00a4ef', 'MS'],
  amazon: ['#ff9900', 'AM'], ai21: ['#e91e63', 'A21'], perplexity: ['#20808d', 'PX'],
  nous: ['#7c3aed', 'NO'], groq: ['#f55036', 'GQ'], ollama: ['#8b8b8b', 'OL'],
  lmstudio: ['#7c5cff', 'LM'], openrouter: ['#6467f2', 'OR'], github: ['#6e7681', 'GH'],
  goopencode: ['#00add8', 'GO'], githubcopilot: ['#6e7681', 'GH'],
  llama: ['#0866ff', 'LL'], gemma: ['#4285f4', 'GE'], phi: ['#00a4ef', 'PH'],
  llava: ['#8b8b8b', 'LV'], claude: ['#d97757', 'CL'], gemini: ['#4285f4', 'GM'],
  gpt: ['#10a37f', 'GP'], kimi: ['#111111', 'KI'],
};

/** "Mistral: Pareto" -> mistral; "qwen3-32b" -> qwen; "llama3.3:70b" -> llama. */
export function vendorKey(text: string): string {
  const head = String(text ?? '').split(':')[0].trim();
  const first = head.split(/\s+/)[0] ?? '';
  const m = first.match(/^[A-Za-z][A-Za-z0-9.]*/);
  const key = (m ? m[0] : first).toLowerCase().replace(/[^a-z0-9]/g, '');
  return key.replace(/[0-9.]+$/, '');
}

/** Deterministic fallback hue for a vendor this table does not know, so an
 *  unrecognised provider still gets a stable colour rather than a random one
 *  on every render. */
function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export interface VendorMark {
  monogram: string;
  color: string;
}

/** The monogram badge for a source tab, keyed off its display name. */
export function vendorMark(name: string): VendorMark {
  const key = vendorKey(name);
  const known = VENDOR[key];
  return {
    monogram: known ? known[1] : (key.slice(0, 2) || '?').toUpperCase(),
    color: known ? known[0] : `hsl(${hashHue(key)} 45% 42%)`,
  };
}
