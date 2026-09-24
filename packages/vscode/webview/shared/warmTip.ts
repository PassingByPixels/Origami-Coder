// WARM TOOLTIP — the wire behind WarmTooltip.svelte.
//
// Ported from react-bits Micro/WarmTooltip (see Mock-Redesign/CHANGES.md
// change 6). Three timings carry the whole behaviour:
//   FUSE  — hover this long before the first tip appears, so a stray pass of
//           the pointer over a dock shows nothing.
//   GRACE — stay open this long after leaving, so travelling between two dock
//           items does not blink the tip away between them.
//   WARM  — after a tip closes the group stays warm this long, and the next
//           tip opens with NO fuse. That is what makes a dock read as one
//           control rather than seven independent ones.
//
// PUBLIC API (the A2 chat-pane lane reuses this):
//   import WarmTooltip, { tip } from '../shared/WarmTooltip.svelte';
//   <WarmTooltip />                      once per webview root
//   <button use:tip={'Chat history'}>    on every control that wants a label
// `use:tip` replaces a native `title`: do not write both, or the browser draws
// its own tooltip under ours. Pass '' (or nothing) to disable one.
//
// This module owns NO markup. WarmTooltip.svelte registers itself as the sink
// and draws the single box; that keeps the tip's CSS scoped to the component
// that writes its element, which is the only place Svelte will apply it.

import { unwatchOpenTip, watchOpenTip } from './warmTipWatch';

export const TIP_FUSE = 380; // ms of hover before the first tip opens
export const TIP_GRACE = 80; // ms the tip stays open after the pointer leaves
export const TIP_WARM = 300; // ms the group stays warm after a tip closes
// Placement (including the composer anchoring the option below asks for) is
// tipPlace.ts's — pure geometry, its own leaf.

/** Labels longer than this (or with a line break) get the wide, left-aligned box. */
export const TIP_WIDE_CHARS = 34;

/** What a control may ask for beyond the words. `anchor: 'composer'` lines
 *  the box up with the composer's own grid instead of centring it on a 20px
 *  control (tipPlace.ts). Every other caller passes a bare
 *  string and is untouched. */
export interface TipSpec {
  text: string;
  anchor?: 'composer';
}
export type TipLabel = string | TipSpec;

export function tipText(label: TipLabel): string {
  return typeof label === 'string' ? label : label.text;
}
export function tipAnchor(label: TipLabel): 'composer' | undefined {
  return typeof label === 'string' ? undefined : label.anchor;
}

type Sink = (node: HTMLElement | null, text: string, anchor?: 'composer') => void;

let sink: Sink | null = null;
let openNode: HTMLElement | null = null;
let warmUntil = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** WarmTooltip.svelte calls this on mount; the returned function unregisters. */
export function setTipSink(fn: Sink): () => void {
  sink = fn;
  return () => {
    if (sink === fn) sink = null;
  };
}

/** Pure: is the group warm, so the next tip should open with no fuse? */
export function fuseDelay(now: number, shown: boolean, warmAt: number): number {
  return shown || now < warmAt ? 0 : TIP_FUSE;
}

/** Pure: a long or multi-line label reads as a paragraph, not a pill. */
export function isWideLabel(text: string): boolean {
  return text.length > TIP_WIDE_CHARS || text.includes('\n');
}

function show(node: HTMLElement, text: string, anchor?: 'composer'): void {
  openNode = node;
  sink?.(node, text, anchor);
  // A tip must not outlive its control (warmTipWatch.ts says why).
  watchOpenTip(node, () => { clearTimeout(timer); warmUntil = Date.now() + TIP_WARM; hide(); });
}

function hide(): void {
  openNode = null;
  unwatchOpenTip();
  sink?.(null, '');
}

/**
 * The action. `label` is read at open time, so a control whose label changes
 * (the Front Desk count, a toggle's on/off wording) needs no re-binding.
 */
export function tip(node: HTMLElement, label: TipLabel) {
  let text = tipText(label);
  let anchor = tipAnchor(label);
  // The label also lands on the node as `data-tip`. The tip BOX is drawn
  // elsewhere and only while open, so without this the label would exist
  // nowhere in the DOM — unqueryable by a test, and invisible to anything
  // (the remote shell's CSS gates, a DOM probe) that used to read `title`.
  const stamp = () => { node.dataset.tip = text; };
  stamp();

  const enter = () => {
    if (!text) return;
    clearTimeout(timer);
    const delay = fuseDelay(Date.now(), openNode !== null, warmUntil);
    timer = setTimeout(() => show(node, text, anchor), delay);
  };
  const leave = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      warmUntil = Date.now() + TIP_WARM;
      hide();
    }, TIP_GRACE);
  };
  // Keyboard focus opens at once: a fuse on focus would mean tabbing through a
  // dock shows nothing at all.
  const onFocus = () => {
    if (!text) return;
    clearTimeout(timer);
    show(node, text, anchor);
  };
  const onBlur = () => {
    clearTimeout(timer);
    warmUntil = Date.now() + TIP_WARM;
    hide();
  };

  node.addEventListener('mouseenter', enter);
  node.addEventListener('mouseleave', leave);
  node.addEventListener('focus', onFocus);
  node.addEventListener('blur', onBlur);

  return {
    update(next: TipLabel) {
      text = tipText(next);
      anchor = tipAnchor(next);
      stamp();
      if (openNode === node) show(node, text, anchor);
    },
    destroy() {
      clearTimeout(timer);
      if (openNode === node) hide();
      node.removeEventListener('mouseenter', enter);
      node.removeEventListener('mouseleave', leave);
      node.removeEventListener('focus', onFocus);
      node.removeEventListener('blur', onBlur);
    },
  };
}

/** Tests only: forget the warm window and any open tip between cases. */
export function resetTipState(): void {
  clearTimeout(timer);
  openNode = null;
  unwatchOpenTip();
  warmUntil = 0;
}
