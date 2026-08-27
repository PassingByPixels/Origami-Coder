// Shared theme control for the lean sidebar.
//
// The webview HTML boots with data-theme="meadow" hardcoded by the host
// (DashboardPanel.renderHtml). App.svelte's old theme toggle only flipped
// data-theme in memory + posted `themeChanged` to sync VS Code's own
// colour theme; it did NOT survive a webview reload. Here we persist the
// chosen theme through the VS Code webview state API (getState/setState),
// which IS retained across reloads/hide-show, so the sidebar reopens on
// the theme the user last picked.

import { getVsCodeApi } from './vscodeApi';

export type ThemeId = 'meadow' | 'harbour' | 'ember' | 'midnight' | 'custom';

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  icon: string;
}

// The themes shipped in theme.css (:root[data-theme="..."]). Order is the
// cycle order — one per Origami Labs product, then the editable Custom slot.
export const THEMES: ThemeMeta[] = [
  { id: 'meadow', label: 'Meadow', icon: '☘' }, // shamrock — Folio green
  { id: 'harbour', label: 'Harbour', icon: '⚓' }, // anchor — Coder blue
  { id: 'ember', label: 'Ember', icon: '☀' }, // sun — Games bronze (warm paper)
  { id: 'midnight', label: 'Midnight', icon: '✦' }, // star — reserved 4th product
  { id: 'custom', label: 'Custom', icon: '✎' }, // pencil — user-edited palette
];

const STATE_KEY = 'origami.theme';

interface PersistedState {
  [STATE_KEY]?: ThemeId;
  [k: string]: unknown;
}

function isThemeId(v: unknown): v is ThemeId {
  return (
    v === 'meadow' || v === 'harbour' || v === 'ember' || v === 'midnight' || v === 'custom'
  );
}

/** The persisted theme, or 'meadow' (the HTML boot default) if none saved. */
export function loadTheme(): ThemeId {
  try {
    const state = (getVsCodeApi().getState() as PersistedState) || {};
    // Read loosely: a persisted value can be a stale id from an older build —
    // the removed 'lilac', or the old 'dark' which was renamed to 'meadow'.
    const saved = state[STATE_KEY] as unknown;
    if (saved === 'lilac' || saved === 'dark') return 'meadow';
    // 'quiet' was retinted to bronze and renamed 'ember' (2026-07-01).
    if (saved === 'quiet') return 'ember';
    return isThemeId(saved) ? saved : 'meadow';
  } catch {
    return 'meadow';
  }
}

/** Persist the theme through the webview state API (survives reloads). */
export function saveTheme(id: ThemeId): void {
  try {
    const vscode = getVsCodeApi();
    const state = (vscode.getState() as PersistedState) || {};
    state[STATE_KEY] = id;
    vscode.setState(state);
  } catch {
    /* getState/setState unavailable in this host — best-effort only. */
  }
}

/** Storage key the ThemeEditor writes the user's custom palette to. */
const CUSTOM_KEY = 'origami.customTheme';

/** Apply the saved custom palette as inline :root overrides (the ThemeEditor
 *  persists it here). No-op if nothing saved or storage is unavailable. The
 *  'custom' data-theme block is the brand-Dark seed; these overrides layer the
 *  user's edits on top. */
export function applyCustomOverrides(): void {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return;
    const snap = JSON.parse(raw) as {
      version?: number;
      colors?: Record<string, { value: string; alpha: number; isRgba: boolean }>;
    };
    if (snap?.version !== 1 || !snap.colors) return;
    for (const [key, c] of Object.entries(snap.colors)) {
      const val = c.isRgba
        ? `rgba(${parseInt(c.value.slice(1, 3), 16)}, ${parseInt(c.value.slice(3, 5), 16)}, ${parseInt(c.value.slice(5, 7), 16)}, ${c.alpha})`
        : c.value;
      document.documentElement.style.setProperty(key, val);
    }
  } catch {
    /* best-effort — DOM/storage may be unavailable in tests */
  }
}

/** Remove any inline --og-* overrides so a data-theme block takes effect again
 *  (called when leaving the 'custom' theme for a fixed palette). */
export function clearCustomOverrides(): void {
  try {
    const el = document.documentElement;
    for (let i = el.style.length - 1; i >= 0; i--) {
      const prop = el.style[i];
      if (prop.startsWith('--og-')) el.style.removeProperty(prop);
    }
  } catch {
    /* best-effort */
  }
}

/** Apply a theme to the document + persist it + tell the host so VS Code's
 *  own colour theme can follow (the same `themeChanged` wire App.svelte
 *  used; the host's handler honours the origami.syncVsCodeTheme setting). */
export function applyTheme(id: ThemeId): void {
  document.documentElement.setAttribute('data-theme', id);
  if (id === 'custom') applyCustomOverrides(); else clearCustomOverrides();
  saveTheme(id);
  try {
    getVsCodeApi().postMessage({ type: 'themeChanged', theme: id });
  } catch {
    /* host bridge not present (tests) — DOM + persistence still applied. */
  }
}

/** Apply + persist a theme WITHOUT posting `themeChanged` back to the
 *  host. Used by the cross-view `themeSync` broadcast: when the config
 *  view switches theme, the host re-broadcasts the id to the chat view (and
 *  vice-versa) so both surfaces stay in lock-step. Echoing `themeChanged`
 *  here would loop, so this path is post-free. */
export function applyThemeSilently(id: ThemeId): void {
  document.documentElement.setAttribute('data-theme', id);
  if (id === 'custom') applyCustomOverrides(); else clearCustomOverrides();
  saveTheme(id);
}

/** Index of an id within THEMES (0 if unknown). */
export function themeIndex(id: ThemeId): number {
  const i = THEMES.findIndex((t) => t.id === id);
  return i < 0 ? 0 : i;
}
