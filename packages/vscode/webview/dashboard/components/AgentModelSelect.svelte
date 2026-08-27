<script lang="ts">
  // A compact, searchable model combobox for the Agent Manager board (NOT the
  // chat ModelPicker — this one never loads/switches anything, it just picks a
  // value). Closed: a small field showing the current selection (pretty name) or
  // placeholder. Open: an autofocused filter + a scrollable list with provider
  // groups COLLAPSED by default ("<provider> (N)" + a liveness dot); typing a
  // filter auto-expands matching groups and hides the rest; Enter picks the sole
  // visible match. `leading` options (Engine/Repo default) render above the
  // groups, always visible. A set value absent from options shows "(unavailable)".
  interface Opt { value: string; name: string; }
  interface ProviderStat { id: string; name: string; live: boolean; flavor?: 'lmstudio' | 'ollama' | 'other'; }
  interface LeadOpt { value: string; label: string; }
  interface Props {
    options: Opt[];
    providerStatus?: ProviderStat[];
    value: string;
    onchange: (v: string) => void;
    placeholder?: string;
    leading?: LeadOpt[];
    compact?: boolean;
  }
  let { options, providerStatus = [], value, onchange, placeholder = 'Select model', leading = [], compact = false }: Props = $props();

  const LMS_TIP = 'not auto-loaded — load via the chat model picker if needed';

  let open = $state(false);
  let filter = $state('');
  let expanded = $state<Record<string, boolean>>({}); // provider id -> forced expand
  // The menu is position:fixed (off the trigger rect) so it escapes the board
  // column's overflow clip; measured on open.
  let triggerEl: HTMLButtonElement | undefined;
  let menuPos = $state<{ top: number; left: number } | null>(null);

  let groups = $derived.by(() => {
    const byProv = new Map<string, { id: string; name: string; live: boolean; flavor?: string; options: Opt[] }>();
    for (const o of options) {
      const pid = o.value.split('/')[0] || o.value;
      let g = byProv.get(pid);
      if (!g) {
        const ps = providerStatus.find((p) => p.id === pid);
        g = { id: pid, name: ps?.name ?? pid, live: ps?.live ?? false, flavor: ps?.flavor, options: [] };
        byProv.set(pid, g);
      }
      g.options.push(o);
    }
    return [...byProv.values()];
  });

  let q = $derived(filter.trim().toLowerCase());
  function matches(o: Opt): boolean {
    if (!q) return true;
    return o.name.toLowerCase().includes(q) || o.value.toLowerCase().includes(q);
  }
  // Groups with at least one matching option; each carries its filtered list.
  let filteredGroups = $derived.by(() =>
    groups.map((g) => ({ ...g, matched: g.options.filter(matches) })).filter((g) => g.matched.length > 0),
  );
  // The flat list of currently visible (matched) options — Enter picks it iff 1.
  let visibleOptions = $derived.by(() => filteredGroups.flatMap((g) => g.matched));

  function pretty(v: string): string {
    const parts = v.split('/');
    return parts.length > 1 ? parts.slice(1).join('/') : v;
  }
  let selLabel = $derived.by(() => {
    const lead = leading.find((l) => l.value === value);
    if (lead) return lead.label;
    if (!value) return placeholder;
    const opt = options.find((o) => o.value === value);
    if (opt) return opt.name;
    return `${pretty(value)} (unavailable)`; // a set value no longer in the list
  });
  let stale = $derived(!!value && !leading.some((l) => l.value === value) && !options.some((o) => o.value === value));

  // A group is open when it's forced open OR a filter is active (auto-expand).
  function groupOpen(id: string): boolean {
    return q.length > 0 || expanded[id] === true;
  }
  function toggleGroup(id: string): void {
    expanded = { ...expanded, [id]: !expanded[id] };
  }

  function openMenu(): void {
    open = true;
    filter = '';
    expanded = {};
    const r = triggerEl?.getBoundingClientRect();
    menuPos = r ? { top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 268)) } : null;
  }
  function close(): void {
    open = false;
    filter = '';
  }
  function choose(v: string): void {
    onchange(v);
    close();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') { close(); e.stopPropagation(); return; }
    if (e.key === 'Enter') {
      if (visibleOptions.length === 1) { choose(visibleOptions[0].value); e.preventDefault(); }
    }
  }
  // Escape must close even once focus has left the filter input (e.g. after a
  // group header click) — the input-scoped onKey can't see those keydowns.
  function onWinKey(e: KeyboardEvent): void {
    if (open && e.key === 'Escape') close();
  }
  function autofocus(node: HTMLInputElement) { node.focus(); }
</script>

<svelte:window onkeydown={onWinKey} />

<span class="ams" class:compact>
  <button class="ams-trigger" class:stale bind:this={triggerEl} onclick={() => (open ? close() : openMenu())} title={value || placeholder}>
    <span class="ams-label">{selLabel}</span>
    <span class="ams-caret" aria-hidden="true">▾</span>
  </button>

  {#if open}
    <button class="ams-backdrop" aria-label="Close model select" onclick={close}></button>
    <div class="ams-menu" role="dialog" aria-label="Select a model" style="top: {menuPos?.top ?? 0}px; left: {menuPos?.left ?? 0}px">
      <input class="ams-filter" type="text" bind:value={filter} onkeydown={onKey} use:autofocus
        placeholder="Filter models…" spellcheck="false" autocomplete="off" aria-label="Filter models" />
      <div class="ams-list" role="listbox">
        {#each leading as l (l.value)}
          <button class="ams-opt lead" class:current={l.value === value} role="option" aria-selected={l.value === value} onclick={() => choose(l.value)}>
            {l.label}
          </button>
        {/each}
        {#each filteredGroups as g (g.id)}
          <button class="ams-group" onclick={() => toggleGroup(g.id)} title={g.live ? `${g.name} — Live` : `${g.name} — offline`}>
            <span class="ams-chev">{groupOpen(g.id) ? '▾' : '▸'}</span>
            <span class="ams-dot" class:live={g.live}></span>
            <span class="ams-gname">{g.name}</span>
            <span class="ams-gcount">({g.matched.length})</span>
          </button>
          {#if groupOpen(g.id)}
            {#each g.matched as o (o.value)}
              <button class="ams-opt" class:current={o.value === value} role="option" aria-selected={o.value === value}
                onclick={() => choose(o.value)} title={g.flavor === 'lmstudio' ? LMS_TIP : o.value}>
                {o.name}
              </button>
            {/each}
          {/if}
        {/each}
        {#if filteredGroups.length === 0 && leading.length === 0}
          <div class="ams-empty">No models match.</div>
        {/if}
      </div>
    </div>
  {/if}
</span>

<style>
  .ams { position: relative; display: inline-flex; min-width: 0; flex: 1; }
  .ams-trigger {
    display: inline-flex; align-items: center; gap: 5px; width: 100%; min-width: 0;
    background: var(--og-bg); color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.15));
    border-radius: 4px; padding: 3px 6px; font: inherit; font-size: 11px; cursor: pointer;
    text-align: left;
  }
  .ams.compact .ams-trigger { padding: 2px 6px; }
  .ams-trigger:hover { filter: brightness(1.15); }
  .ams-trigger.stale { border-color: #c0902f; }
  .ams-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
  .ams-caret { color: var(--og-text); opacity: 0.6; flex-shrink: 0; font-size: 9px; }

  .ams-backdrop { position: fixed; inset: 0; z-index: 40; background: transparent; border: none; padding: 0; margin: 0; cursor: default; }
  .ams-menu {
    position: fixed; z-index: 41;
    width: 260px; max-width: 84vw; display: flex; flex-direction: column; gap: 5px; padding: 7px;
    background: var(--og-surface, #23262e); border: 1px solid var(--og-border, rgba(255, 255, 255, 0.18));
    border-radius: 8px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.34);
  }
  .ams-filter {
    width: 100%; box-sizing: border-box; padding: 5px 8px; font: inherit; font-size: 11px;
    color: var(--og-text); background: var(--og-bg); border: 1px solid var(--og-border, rgba(255, 255, 255, 0.2));
    border-radius: 5px; outline: none;
  }
  .ams-list { display: flex; flex-direction: column; gap: 1px; max-height: 260px; overflow-y: auto; }
  .ams-group {
    display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 6px; font: inherit; font-size: 11px;
    font-weight: 600; text-align: left; color: var(--og-text); background: transparent; border: none;
    border-radius: 4px; cursor: pointer;
  }
  .ams-group:hover { background: var(--og-bg); }
  .ams-chev { width: 10px; flex-shrink: 0; opacity: 0.7; }
  .ams-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: var(--og-text-muted, #888); }
  .ams-dot.live { background: #6fbf73; box-shadow: 0 0 5px #6fbf73; }
  .ams-gname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ams-gcount { opacity: 0.6; font-weight: 400; }
  .ams-opt {
    display: block; width: 100%; padding: 4px 6px 4px 22px; font: inherit; font-size: 12px; text-align: left;
    color: var(--og-text); background: transparent; border: 1px solid transparent; border-radius: 4px; cursor: pointer;
    overflow-wrap: anywhere;
  }
  .ams-opt.lead { padding-left: 8px; }
  .ams-opt:hover { background: var(--og-bg); }
  .ams-opt.current { border-color: var(--og-accent, #3b6ea5); }
  .ams-empty { padding: 6px; font-size: 11px; opacity: 0.6; }
</style>
