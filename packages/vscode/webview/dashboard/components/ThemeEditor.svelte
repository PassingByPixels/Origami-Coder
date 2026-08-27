<script lang="ts">
  // Live theme editor — color pickers for every CSS variable.
  // Changes apply instantly. Export dumps the final CSS block.

  import { getVsCodeApi } from '../../shared/vscodeApi';

  const vscode = getVsCodeApi();

  interface Props {
    onClose: () => void;
  }

  interface ColorEntry {
    key: string;
    label: string;
    group: string;
    value: string;
    isRgba: boolean;
  }

  let { onClose }: Props = $props();

  // Define all theme variables grouped for the editor
  const colorDefs: { key: string; label: string; group: string }[] = [
    // Backgrounds
    { key: '--og-bg', label: 'Background', group: 'Backgrounds' },
    { key: '--og-surface', label: 'Surface (cards, panels)', group: 'Backgrounds' },
    { key: '--og-surface-alt', label: 'Surface Alt (deep panels)', group: 'Backgrounds' },
    { key: '--og-pane-header', label: 'Pane Headers', group: 'Backgrounds' },
    { key: '--og-input-bg', label: 'Input Background', group: 'Backgrounds' },

    // Text
    { key: '--og-text', label: 'Primary Text', group: 'Text' },
    { key: '--og-text-secondary', label: 'Secondary Text', group: 'Text' },
    { key: '--og-text-muted', label: 'Muted Text', group: 'Text' },

    // Accents
    { key: '--og-accent', label: 'Accent A', group: 'Accents' },
    { key: '--og-accent-2', label: 'Accent B', group: 'Accents' },
    { key: '--og-chat', label: 'Chat Accent', group: 'Accents' },
    { key: '--og-crane', label: 'Crane Mark', group: 'Accents' },

    // Status
    { key: '--og-success', label: 'Success', group: 'Status' },
    { key: '--og-error', label: 'Error', group: 'Status' },
    { key: '--og-warning', label: 'Warning', group: 'Status' },

    // Controls
    { key: '--og-border', label: 'Borders', group: 'Controls' },
    { key: '--og-input-border', label: 'Input Border', group: 'Controls' },
    { key: '--og-btn-bg', label: 'Button Background', group: 'Controls' },
    { key: '--og-btn-hover', label: 'Button Hover', group: 'Controls' },
    { key: '--og-btn-text', label: 'Button Text', group: 'Controls' },
    { key: '--og-scrollbar', label: 'Scrollbar', group: 'Controls' },
    { key: '--og-scrollbar-hover', label: 'Scrollbar Hover', group: 'Controls' },
  ];

  // Read current computed values from :root
  function getCurrentValue(key: string): string {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(key).trim();
    return raw;
  }

  // Convert rgba(...) or hex to a hex color for the color picker
  function toHex(val: string): string {
    if (val.startsWith('#')) {
      // Ensure 6-digit hex
      if (val.length === 4) {
        return '#' + val[1] + val[1] + val[2] + val[2] + val[3] + val[3];
      }
      return val.slice(0, 7); // strip alpha if present
    }
    // Parse rgba
    const m = val.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) {
      const r = parseInt(m[1]).toString(16).padStart(2, '0');
      const g = parseInt(m[2]).toString(16).padStart(2, '0');
      const b = parseInt(m[3]).toString(16).padStart(2, '0');
      return `#${r}${g}${b}`;
    }
    return '#888888';
  }

  // Check if original value uses rgba
  function isRgbaValue(val: string): boolean {
    return val.startsWith('rgba');
  }

  // Extract alpha from rgba string
  function getAlpha(val: string): number {
    const m = val.match(/rgba?\([^)]*,\s*([\d.]+)\s*\)/);
    return m ? parseFloat(m[1]) : 1;
  }

  // Build entries with current values
  let entries: ColorEntry[] = $state(
    colorDefs.map(d => {
      const raw = getCurrentValue(d.key);
      return {
        ...d,
        value: toHex(raw),
        isRgba: isRgbaValue(raw),
      };
    })
  );

  // Alpha values for rgba entries
  let alphas: Record<string, number> = $state(
    Object.fromEntries(
      colorDefs.map(d => {
        const raw = getCurrentValue(d.key);
        return [d.key, getAlpha(raw)];
      })
    )
  );

  // Apply a color change live
  function updateColor(key: string, hex: string, alpha: number, isRgba: boolean) {
    let cssValue: string;
    if (isRgba) {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      cssValue = `rgba(${r}, ${g}, ${b}, ${alpha})`;
    } else {
      cssValue = hex;
    }
    document.documentElement.style.setProperty(key, cssValue);
  }

  function onColorChange(idx: number, newHex: string) {
    entries[idx].value = newHex;
    updateColor(entries[idx].key, newHex, alphas[entries[idx].key], entries[idx].isRgba);
  }

  function onAlphaChange(idx: number, newAlpha: number) {
    alphas[entries[idx].key] = newAlpha;
    updateColor(entries[idx].key, entries[idx].value, newAlpha, entries[idx].isRgba);
  }

  // Group entries
  let groups = $derived(() => {
    const map = new Map<string, { idx: number; entry: ColorEntry }[]>();
    entries.forEach((entry, idx) => {
      const list = map.get(entry.group) || [];
      list.push({ idx, entry });
      map.set(entry.group, list);
    });
    return Array.from(map.entries());
  });

  // Export as CSS
  function exportCSS() {
    let css = ':root[data-theme="custom"] {\n';
    for (const entry of entries) {
      const alpha = alphas[entry.key];
      let val: string;
      if (entry.isRgba) {
        const r = parseInt(entry.value.slice(1, 3), 16);
        const g = parseInt(entry.value.slice(3, 5), 16);
        const b = parseInt(entry.value.slice(5, 7), 16);
        val = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      } else {
        val = entry.value;
      }
      css += `  ${entry.key}: ${val};\n`;
    }
    css += '}';

    // Copy to clipboard
    navigator.clipboard.writeText(css).then(() => {
      exportMsg = 'Copied to clipboard!';
      setTimeout(() => exportMsg = '', 2000);
    }).catch(() => {
      exportMsg = css;
    });
  }

  let exportMsg = $state('');
  let fileInput: HTMLInputElement | undefined = $state();

  const STORAGE_KEY = 'origami.customTheme';

  interface ThemeSnapshot {
    version: 1;
    colors: Record<string, { value: string; alpha: number; isRgba: boolean }>;
  }

  function snapshot(): ThemeSnapshot {
    const colors: ThemeSnapshot['colors'] = {};
    for (const entry of entries) {
      colors[entry.key] = { value: entry.value, alpha: alphas[entry.key], isRgba: entry.isRgba };
    }
    return { version: 1, colors };
  }

  function applySnapshot(snap: ThemeSnapshot) {
    if (!snap || snap.version !== 1 || !snap.colors) return;
    entries = entries.map(e => {
      const c = snap.colors[e.key];
      if (!c) return e;
      return { ...e, value: c.value, isRgba: c.isRgba };
    });
    for (const key of Object.keys(snap.colors)) {
      alphas[key] = snap.colors[key].alpha;
    }
    // Apply each
    for (const entry of entries) {
      updateColor(entry.key, entry.value, alphas[entry.key], entry.isRgba);
    }
  }

  /** Resolve an entry to a hex string (hex8 when it carries alpha) for the
   *  workbench theme JSON, which only accepts hex colours. */
  function resolvedHex(entry: ColorEntry): string {
    if (!entry.isRgba) return entry.value;
    const a = Math.round(Math.max(0, Math.min(1, alphas[entry.key])) * 255);
    return entry.value + a.toString(16).padStart(2, '0');
  }

  /** The full --og-* palette as hex, for the host to map onto VS Code keys. */
  function buildPalette(): Record<string, string> {
    const p: Record<string, string> = {};
    for (const e of entries) p[e.key] = resolvedHex(e);
    return p;
  }

  function saveCustom() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot()));
      // G3 — also drive the whole VS Code workbench: the host rewrites the
      // "Origami Custom" contributed theme from this palette and applies it.
      vscode.postMessage({ type: 'saveWorkbenchTheme', palette: buildPalette() });
      exportMsg = 'Custom theme saved + applied to the workbench.';
    } catch (e) {
      exportMsg = 'Save failed: ' + (e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => exportMsg = '', 2500);
  }

  function loadCustom() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) { exportMsg = 'No saved custom theme.'; setTimeout(() => exportMsg = '', 2000); return; }
      applySnapshot(JSON.parse(raw) as ThemeSnapshot);
      exportMsg = 'Custom theme loaded.';
    } catch (e) {
      exportMsg = 'Load failed: ' + (e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => exportMsg = '', 2000);
  }

  function exportJSON() {
    const json = JSON.stringify(snapshot(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'origami-theme.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importJSON() { fileInput?.click(); }

  function onFilePicked(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        applySnapshot(JSON.parse(reader.result as string) as ThemeSnapshot);
        exportMsg = 'Theme imported from file.';
      } catch (err) {
        exportMsg = 'Invalid theme file.';
      }
      setTimeout(() => exportMsg = '', 2000);
    };
    reader.readAsText(file);
    input.value = '';
  }

  // Reset to original values from stylesheet
  function resetAll() {
    // Remove all inline overrides so stylesheet values take effect
    for (const entry of entries) {
      document.documentElement.style.removeProperty(entry.key);
    }
    // Re-read values
    entries = colorDefs.map(d => {
      const raw = getCurrentValue(d.key);
      return { ...d, value: toHex(raw), isRgba: isRgbaValue(raw) };
    });
    alphas = Object.fromEntries(
      colorDefs.map(d => [d.key, getAlpha(getCurrentValue(d.key))])
    );
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
<div class="overlay" onclick={onClose}>
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
  <div class="editor" onclick={(e) => e.stopPropagation()}>
    <div class="editor-header">
      <span class="editor-title">Theme Editor</span>
      <div class="editor-actions">
        <button class="action-btn" onclick={resetAll} title="Revert to the active theme's stylesheet values">Reset</button>
        <button class="action-btn" onclick={saveCustom} title="Save this palette as your custom theme (persists across sessions)">Save</button>
        <button class="action-btn" onclick={loadCustom} title="Load saved custom theme">Load</button>
        <button class="action-btn" onclick={exportJSON} title="Download as JSON">Export</button>
        <button class="action-btn" onclick={importJSON} title="Import from JSON file">Import</button>
        <button class="action-btn export" onclick={exportCSS} title="Copy CSS block to clipboard">Copy CSS</button>
        <button class="close-btn" onclick={onClose}>&times;</button>
      </div>
      <input type="file" accept="application/json,.json" bind:this={fileInput} onchange={onFilePicked} style="display:none" />
    </div>

    {#if exportMsg}
      <div class="export-msg">{exportMsg}</div>
    {/if}

    <div class="editor-body">
      {#each groups() as [groupName, items]}
        <div class="group">
          <div class="group-name">{groupName}</div>
          {#each items as { idx, entry }}
            <div class="color-row">
              <input
                type="color"
                value={entry.value}
                oninput={(e) => onColorChange(idx, (e.target as HTMLInputElement).value)}
                class="color-picker"
              />
              <div class="color-info">
                <span class="color-label">{entry.label}</span>
                <span class="color-var">{entry.key}</span>
              </div>
              <input
                type="text"
                value={entry.value}
                oninput={(e) => {
                  const v = (e.target as HTMLInputElement).value;
                  if (/^#[0-9a-fA-F]{6}$/.test(v)) onColorChange(idx, v);
                }}
                class="color-hex"
                maxlength="7"
              />
              {#if entry.isRgba}
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={alphas[entry.key]}
                  oninput={(e) => onAlphaChange(idx, parseFloat((e.target as HTMLInputElement).value))}
                  class="alpha-slider"
                  title="Alpha: {alphas[entry.key].toFixed(2)}"
                />
                <span class="alpha-val">{alphas[entry.key].toFixed(2)}</span>
              {/if}
              <div class="color-swatch" style="background: {entry.isRgba ? `rgba(${parseInt(entry.value.slice(1,3),16)},${parseInt(entry.value.slice(3,5),16)},${parseInt(entry.value.slice(5,7),16)},${alphas[entry.key]})` : entry.value}"></div>
            </div>
          {/each}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .editor {
    width: 520px;
    max-height: 85vh;
    background: var(--og-bg);
    border: 1px solid var(--og-border);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .editor-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--og-border);
    flex-shrink: 0;
  }

  .editor-title {
    font-weight: 700;
    font-size: 13px;
    color: var(--og-text);
  }

  .editor-actions {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .action-btn {
    padding: 4px 10px;
    font-size: 11px;
    background: var(--og-btn-bg);
    color: var(--og-btn-text);
    border: 1px solid var(--og-border);
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
  }

  .action-btn:hover { background: var(--og-btn-hover); }

  .action-btn.export {
    background: var(--og-accent);
    color: white;
    border-color: var(--og-accent);
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--og-text-muted);
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }

  .close-btn:hover { color: var(--og-text); }

  .export-msg {
    padding: 6px 14px;
    background: rgba(74, 222, 128, 0.1);
    color: var(--og-success);
    font-size: 11px;
    border-bottom: 1px solid var(--og-border);
    white-space: pre-wrap;
    font-family: var(--vscode-editor-font-family, monospace);
    max-height: 200px;
    overflow-y: auto;
  }

  .editor-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 14px;
  }

  .group {
    margin-bottom: 12px;
  }

  .group-name {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--og-text-muted);
    padding: 4px 0;
    border-bottom: 1px solid var(--og-border);
    margin-bottom: 6px;
  }

  .color-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
  }

  .color-picker {
    width: 28px;
    height: 28px;
    border: 1px solid var(--og-border);
    border-radius: 4px;
    cursor: pointer;
    padding: 0;
    background: none;
    flex-shrink: 0;
  }

  .color-picker::-webkit-color-swatch-wrapper { padding: 2px; }
  .color-picker::-webkit-color-swatch { border: none; border-radius: 2px; }

  .color-info {
    flex: 1;
    min-width: 0;
  }

  .color-label {
    display: block;
    font-size: 11px;
    color: var(--og-text);
  }

  .color-var {
    display: block;
    font-size: 9px;
    color: var(--og-text-muted);
    font-family: var(--vscode-editor-font-family, monospace);
  }

  .color-hex {
    width: 70px;
    padding: 2px 4px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text);
    background: var(--og-input-bg);
    border: 1px solid var(--og-input-border);
    border-radius: 3px;
    text-align: center;
    flex-shrink: 0;
  }

  .color-hex:focus {
    border-color: var(--og-chat);
    outline: none;
  }

  .alpha-slider {
    width: 50px;
    flex-shrink: 0;
    accent-color: var(--og-chat);
  }

  .alpha-val {
    font-size: 10px;
    color: var(--og-text-muted);
    width: 28px;
    text-align: right;
    flex-shrink: 0;
    font-family: var(--vscode-editor-font-family, monospace);
  }

  .color-swatch {
    width: 20px;
    height: 20px;
    border-radius: 3px;
    border: 1px solid var(--og-border);
    flex-shrink: 0;
  }
</style>
