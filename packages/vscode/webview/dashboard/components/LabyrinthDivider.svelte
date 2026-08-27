<script lang="ts">
  // A draggable vertical divider between two of LabyrinthPane's three columns
  // (t-q41pe0), mirroring SidebarLauncher.svelte's Chats/Collabs divider
  // (t-kgserq) — pointer drag with capture, ArrowLeft/ArrowRight nudge, a
  // real WAI-ARIA separator. Kept as its own leaf (not inlined into the pane,
  // which was one line under its own cap) and deliberately NOT sharing code
  // with the sidebar's divider — the two features share no data.
  //
  // `edge` says which side of the container this divider tracks: 'left' grows
  // the column as the pointer moves right (the run index); 'right' shrinks
  // its column as the pointer moves right (the inspector, whose LEFT edge is
  // the divider). ArrowRight always mimics "move the divider right" either
  // way, so the two dividers feel the same to use despite growing opposite
  // columns.
  import { clampColumnWidth } from './labyrinthColumns';

  let {
    edge, containerEl, value, min, defaultPx, onChange, onCommit, label,
  }: {
    edge: 'left' | 'right';
    containerEl: HTMLElement | undefined;
    value: number | null;
    min: number;
    defaultPx: number;
    onChange: (px: number) => void;
    onCommit: (px: number) => void;
    label: string;
  } = $props();

  let resizing = $state(false);
  let dragWidth = 0; // plain var, set fresh at drag start: endResize reads THIS, not the prop, which may not have re-rendered yet.

  function widthFromClientX(clientX: number): number {
    const rect = containerEl?.getBoundingClientRect();
    const raw = edge === 'left' ? clientX - (rect?.left ?? 0) : (rect?.right ?? 0) - clientX;
    return clampColumnWidth(raw, rect?.width ?? 0, min);
  }
  function startResize(e: PointerEvent): void {
    e.preventDefault();
    resizing = true;
    dragWidth = value ?? defaultPx;
    (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
  }
  function onMove(e: PointerEvent): void {
    if (!resizing) return;
    dragWidth = widthFromClientX(e.clientX);
    onChange(dragWidth);
  }
  function endResize(): void {
    if (!resizing) return;
    resizing = false;
    onCommit(dragWidth);
  }
  function onKey(e: KeyboardEvent): void {
    const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    const step = edge === 'left' ? dir : -dir;
    const rect = containerEl?.getBoundingClientRect();
    dragWidth = clampColumnWidth((value ?? defaultPx) + step * 20, rect?.width ?? 0, min);
    onChange(dragWidth);
    onCommit(dragWidth);
  }
</script>

<svelte:window onpointermove={onMove} onpointerup={endResize} />

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="lab-divider"
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuetext={value ? `${value}px` : 'default'}
  tabindex="0"
  onpointerdown={startResize}
  onkeydown={onKey}
></div>

<style>
  .lab-divider {
    flex-shrink: 0;
    width: 7px;
    cursor: col-resize;
    position: relative;
  }
  .lab-divider::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 3px;
    width: 1px;
    background: var(--og-border);
  }
  .lab-divider:hover::before,
  .lab-divider:focus-visible::before {
    background: var(--og-accent);
  }
  .lab-divider:focus-visible {
    outline: 1px solid var(--og-chat);
    outline-offset: 1px;
  }
</style>
