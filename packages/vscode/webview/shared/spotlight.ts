// spotlight.ts — ONE pointer-follow highlight, shared by every card that wants it.
//
// The board columns and the chat transcript cards must read as the same kind of
// surface (Mock-Redesign CHANGES.md change 7), so the behaviour lives here once
// and the LOOK lives once in shared/theme.css as `.og-spotlight`. A component
// that copied either would drift from the other the first time one was tuned.
//
// USAGE:
//   import { spotlight } from '../../shared/spotlight';
//   <div class="tool-card og-spotlight" use:spotlight>…</div>
//
// The action writes three custom properties on the node and nothing else:
//   --sp-x / --sp-y  the pointer, in % of the box (the radial gradient's centre)
//   --sp-on          1 while the pointer is inside, 0 otherwise (the fade)
// They are NOT --og-* names on purpose: they are per-node state, not theme
// colours, and the theme-discipline test reads --og-* as a palette promise.
//
// `pointermove` rather than `mousemove`: a pen or touch drag moves the same
// highlight, and a pointer that leaves during a drag still fires pointerleave.

/** Percent of the box the pointer sits at, clamped — a pointer event can land
 *  a fraction outside the rect on a sub-pixel border. */
export function spotPercent(pos: number, start: number, size: number): number {
  if (size <= 0) return 50;
  return Math.max(0, Math.min(100, ((pos - start) / size) * 100));
}

export function spotlight(node: HTMLElement) {
  const move = (e: PointerEvent) => {
    const r = node.getBoundingClientRect();
    node.style.setProperty('--sp-x', `${spotPercent(e.clientX, r.left, r.width)}%`);
    node.style.setProperty('--sp-y', `${spotPercent(e.clientY, r.top, r.height)}%`);
    node.style.setProperty('--sp-on', '1');
  };
  const leave = () => node.style.setProperty('--sp-on', '0');

  node.addEventListener('pointermove', move);
  node.addEventListener('pointerleave', leave);
  return {
    destroy() {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerleave', leave);
    },
  };
}
