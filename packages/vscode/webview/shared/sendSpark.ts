// sendSpark.ts — t-qn0wj5, proposal 25 (port of Mock-Redesign CHANGES.md #40's
// ClickSpark, react-bits Animations/ClickSpark). A click-time spark burst on the
// composer's Send button: 8 sparks, radius 15, length 10, 400ms, the reference's
// t*(2-t) ease, drawn in --og-chat.
//
// Attached as a document-level, CAPTURING click listener keyed on the stable
// `.action-btn` (SendStopButton, t-qmzp9g) / `.input-area` selectors, rather than a component edit: both live
// in InputBar.svelte, which lane port-composer owns. This file never imports or
// edits that component — the same non-invasive-enhancer approach the original
// Mock-Redesign layer used for exactly this reason (redesign.js's own doc: "every
// enhancer works with the product's DOM, never inside it").
//
// The canvas draw loop needs a real 2D context and getBoundingClientRect layout,
// neither of which jsdom provides (WORKING_ON_ORIGAMI_CODER.md Part 6) — so only
// the pure, DOM-free pieces below (selector matching, the ease curve, the point
// geometry) are unit-tested. The burst itself is UNTESTED by the suite; it was
// confirmed by eye in the running extension (screenshot in the port-theme report).

const SPARK_N = 8;
const SPARK_R = 15;
const SPARK_LEN = 10;
const SPARK_MS = 400;

/** The reference's own ease: fast out, slow to a stop. */
export function sparkEase(k: number): number {
  return k * (2 - k);
}

/** One spark's line segment at progress k (0..1), 0-indexed among SPARK_N. */
export function sparkSegment(i: number, k: number): { x1: number; y1: number; x2: number; y2: number } {
  const a = (Math.PI * 2 * i) / SPARK_N;
  const r0 = SPARK_R * sparkEase(k);
  const tip = r0 + SPARK_LEN * (1 - k);
  return { x1: Math.cos(a) * r0, y1: Math.sin(a) * r0, x2: Math.cos(a) * tip, y2: Math.sin(a) * tip };
}

/** Given the click target, find the Send button and its composer ancestor —
 *  or null if the click was not on Send. Pure DOM traversal, no side effects. */
export function sendSparkTarget(target: EventTarget | null): { btn: HTMLElement; area: HTMLElement } | null {
  const el = target instanceof Element ? target : null;
  // Only a SEND sparks: while a turn runs the same control is the hold-to-stop
  // button (`data-busy`), and a spark on a stop would celebrate a kill.
  const btn = el?.closest('.action-btn') as HTMLElement | null;
  if (!btn || btn.hasAttribute('data-busy')) return null;
  const area = btn.closest('.input-area') as HTMLElement | null;
  if (!area) return null;
  return { btn, area };
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function sparkCanvas(area: HTMLElement): HTMLCanvasElement {
  let c = area.querySelector<HTMLCanvasElement>(':scope > canvas.og-send-spark');
  if (!c) {
    c = document.createElement('canvas');
    c.className = 'og-send-spark';
    area.appendChild(c);
  }
  const r = area.getBoundingClientRect();
  if (c.width !== Math.round(r.width) || c.height !== Math.round(r.height)) {
    c.width = Math.round(r.width);
    c.height = Math.round(r.height);
  }
  return c;
}

function drawBurst(area: HTMLElement, x: number, y: number): void {
  const c = sparkCanvas(area);
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--og-chat').trim() || '#5aa9d4';
  const t0 = performance.now();
  (function draw(now: number) {
    const k = (now - t0) / SPARK_MS;
    ctx.clearRect(0, 0, c.width, c.height);
    if (k >= 1) return;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 1 - k;
    for (let i = 0; i < SPARK_N; i++) {
      const seg = sparkSegment(i, k);
      ctx.beginPath();
      ctx.moveTo(x + seg.x1, y + seg.y1);
      ctx.lineTo(x + seg.x2, y + seg.y2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  })(t0);
}

let mounted = false;

/** Mount once per webview. Idempotent — a second call is a no-op, so ChatPane's
 *  onMount can call it without tracking whether it already ran. */
export function mountSendSpark(root: Document = document): void {
  if (mounted) return;
  mounted = true;
  root.addEventListener(
    'click',
    (e: MouseEvent) => {
      if (reducedMotion()) return; // t-qn0wj5 acceptance: reduced-motion branch
      const found = sendSparkTarget(e.target);
      if (!found) return;
      const box = found.area.getBoundingClientRect();
      drawBurst(found.area, e.clientX - box.left, e.clientY - box.top);
    },
    true,
  );
}

/** Test-only: lets a fresh test re-mount without a fresh module instance. */
export function resetSendSparkForTest(): void {
  mounted = false;
}
