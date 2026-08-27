<script lang="ts">
  // Agent-type picker (S6a roster + S12 custom dropdown) — the picker shared by the
  // create form, the card's queued-task editor and each race-variant row. It was a
  // native <select>; S12 makes it a custom listbox so each entry can show its brand
  // GLYPH (ArchetypeGlyph) beside a CAPITALIZED display name. The value/onchange
  // contract is unchanged, so the three call sites need no edits.
  //
  // Entries: 'Tsuru (default)' (id 'tsuru' = the engine default, sets NO mode) +
  // every harvested engine mode EXCEPT the one flagged as the engine default (Tsuru
  // already means it). Before any harvest the roster is empty, so it degrades to
  // Tsuru alone. Display names are capitalized for the label ONLY; ids/values are
  // untouched. The menu is position:fixed off the trigger rect — the board column
  // (.am-col overflow-y:auto) and board (.am-board overflow) clip an absolute popup,
  // exactly as AgentModelSelect already documents; fixed escapes the clip.
  import ArchetypeGlyph from './ArchetypeGlyph.svelte';
  import { archetypeGlyph } from './archetypeGlyphs';
  import { tick } from 'svelte';

  // S15: the popup is a TILE GRID (3 columns) - a glyph (or a clean initial-letter
  // tile when the type has none) over the capitalized name. 2D keyboard nav below.
  const COLS = 3;
  const hasGlyph = (id: string): boolean => archetypeGlyph(id) !== null;

  interface AgentType { id: string; name: string; default?: boolean; description?: string }
  interface Props { agentTypes: AgentType[]; value: string; onchange: (v: string) => void; }
  let { agentTypes, value, onchange }: Props = $props();

  // Display-only: first letter uppercased. ids/values never change.
  const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

  interface Entry { id: string; label: string; desc?: string }
  let modes = $derived(agentTypes.filter((t) => !t.default && t.id !== 'tsuru'));
  let entries = $derived<Entry[]>([
    { id: 'tsuru', label: 'Tsuru (default)' },
    ...modes.map((m) => ({ id: m.id, label: cap(m.name), desc: m.description })),
  ]);
  // An id absent from the roster (e.g. a type harvested later) shows its OWN
  // capitalized id — matching AgentCard's line2 badge — never a false "Tsuru".
  let selected = $derived(entries.find((e) => e.id === value) ?? (value ? { id: value, label: cap(value) } : entries[0]));

  let open = $state(false);
  let activeIdx = $state(0);
  let menuPos = $state<{ top: number; left: number; width: number } | null>(null);
  let triggerEl: HTMLButtonElement | undefined;
  let menuEl = $state<HTMLUListElement | undefined>(undefined);

  const uid = `att-${Math.random().toString(36).slice(2, 9)}`;
  const optId = (i: number): string => `${uid}-opt-${i}`;

  async function openMenu(): Promise<void> {
    activeIdx = Math.max(0, entries.findIndex((e) => e.id === selected.id));
    const r = triggerEl?.getBoundingClientRect();
    menuPos = r ? { top: r.bottom + 2, left: r.left, width: r.width } : null;
    open = true;
    await tick();
    // Now the menu is measured: clamp left inside the viewport (mirrors
    // AgentModelSelect) and flip above the trigger if it overflows the bottom.
    if (r && menuEl) {
      const left = Math.max(8, Math.min(r.left, window.innerWidth - menuEl.offsetWidth - 8));
      const h = menuEl.offsetHeight;
      const top = r.bottom + h > window.innerHeight && r.top - h > 0 ? r.top - h - 2 : r.bottom + 2;
      menuPos = { top, left, width: r.width };
    }
  }
  function close(): void { open = false; }
  function choose(i: number): void {
    const e = entries[i];
    if (e) onchange(e.id);
    open = false;
    triggerEl?.focus();
  }
  function onTriggerKey(e: KeyboardEvent): void {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openMenu(); }
      return;
    }
    const n = entries.length;
    // 2D grid nav: Left/Right step ±1 (row-major, so they wrap across row edges),
    // Up/Down step ±COLS (one grid row), all clamped to the flat range.
    if (e.key === 'ArrowRight') { e.preventDefault(); activeIdx = Math.min(n - 1, activeIdx + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(n - 1, activeIdx + COLS); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(0, activeIdx - COLS); }
    else if (e.key === 'Home') { e.preventDefault(); activeIdx = 0; }
    else if (e.key === 'End') { e.preventDefault(); activeIdx = n - 1; }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(activeIdx); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  }
  function onWinKey(e: KeyboardEvent): void {
    if (open && e.key === 'Escape') { close(); triggerEl?.focus(); }
  }
</script>

<svelte:window onkeydown={onWinKey} />

<span class="att">
  <button
    type="button" class="am-agenttype" bind:this={triggerEl}
    role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={uid}
    aria-activedescendant={open ? optId(activeIdx) : undefined}
    onclick={() => (open ? close() : openMenu())} onkeydown={onTriggerKey}>
    <ArchetypeGlyph id={selected.id} />
    <span class="att-label">{selected.label}</span>
    <span class="att-caret" aria-hidden="true">▾</span>
  </button>

  {#if open}
    <button class="att-backdrop" aria-label="Close agent type select" onclick={close}></button>
    <ul class="att-menu att-grid" id={uid} role="listbox" aria-label="Agent type" bind:this={menuEl}
      style="top: {menuPos?.top ?? 0}px; left: {menuPos?.left ?? 0}px; min-width: {menuPos?.width ?? 0}px">
      {#each entries as e, i (e.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- keyboard is handled on the combobox trigger (aria-activedescendant) -->
        <li class="am-agenttype-option att-tile" class:active={i === activeIdx} class:current={e.id === value}
          id={optId(i)} data-value={e.id} role="option" aria-selected={e.id === value} title={e.desc || undefined}
          onpointerenter={() => (activeIdx = i)} onclick={() => choose(i)}>
          {#if hasGlyph(e.id)}
            <ArchetypeGlyph id={e.id} size={30} />
          {:else}
            <span class="att-initial" aria-hidden="true">{e.label.slice(0, 1).toUpperCase()}</span>
          {/if}
          <span class="att-optlabel">{e.label}</span>
        </li>
      {/each}
    </ul>
  {/if}
</span>

<style>
  .att { position: relative; display: inline-flex; min-width: 0; flex: 1; }
  .am-agenttype {
    display: inline-flex; align-items: center; gap: 5px; width: 100%; min-width: 0;
    background: var(--og-bg); color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.15));
    border-radius: 4px; padding: 4px 8px; font: inherit; font-size: 12px; cursor: pointer;
    text-align: left;
  }
  .am-agenttype:hover { filter: brightness(1.15); }
  .att-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
  .att-caret { color: var(--og-text); opacity: 0.6; flex-shrink: 0; font-size: 9px; }

  .att-backdrop { position: fixed; inset: 0; z-index: 40; background: transparent; border: none; padding: 0; margin: 0; cursor: default; }
  .att-menu {
    position: fixed; z-index: 41; margin: 0; padding: 4px; list-style: none;
    display: flex; flex-direction: column; gap: 1px; max-height: 260px; overflow-y: auto; max-width: 84vw;
    background: var(--og-surface, #23262e); border: 1px solid var(--og-border, rgba(255, 255, 255, 0.18));
    border-radius: 8px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.34);
  }
  .am-agenttype-option {
    display: flex; align-items: center; gap: 6px; padding: 4px 8px; font-size: 12px;
    color: var(--og-text); border: 1px solid transparent; border-radius: 4px; cursor: pointer;
  }
  .am-agenttype-option:hover, .am-agenttype-option.active { background: var(--og-bg); }
  .am-agenttype-option.current { border-color: var(--og-accent, #3b6ea5); }
  .att-optlabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* S15 grid: 3 columns of tiles (glyph/initial over the name). Overrides the
     base .att-menu flex-column so entries lay out as a grid. */
  .att-grid { display: grid; grid-template-columns: repeat(3, minmax(66px, 1fr)); gap: 4px; }
  .att-tile {
    flex-direction: column; align-items: center; gap: 4px; text-align: center;
    padding: 8px 6px; min-height: 62px; justify-content: center;
  }
  .att-tile .att-optlabel { max-width: 100%; font-size: 11px; }
  .att-initial {
    display: flex; align-items: center; justify-content: center; width: 30px; height: 30px;
    border-radius: 6px; background: var(--og-bg); border: 1px solid var(--og-border, rgba(255, 255, 255, 0.15));
    font-size: 15px; font-weight: 600; opacity: 0.85;
  }
</style>
