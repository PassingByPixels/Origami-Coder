<script lang="ts">
  // THE COMPOSER'S ONE ACTION CONTROL (CHANGES.md round 2, change 25).
  //
  // Send and Cancel used to stack in a column. They are one button now: an
  // arrow that morphs into a stop square while a turn runs. At rest it sends.
  // While busy a CLICK DOES NOTHING and a 600ms HOLD stops the turn — a stray
  // click on a control that has just changed meaning under the pointer must
  // not kill a running turn. The 600ms and the tap rule live in holdToStop.ts.
  //
  // Its own file because InputBar.svelte is at its cap and the morph is a
  // whole behaviour: a 7-point polygon lerped arrow -> square, and the hold's
  // fill, which is a width driven by --hold-p.
  import { tip } from '../../shared/warmTip';
  import { createHold, HOLD_MS } from './holdToStop';

  interface Props {
    /** A turn is running: the arrow is a square and the click is dead. */
    busy: boolean;
    disabled?: boolean;
    /** Why the button refuses at rest (no connection), or '' for the usual tip. */
    refusal?: string;
    /** At rest. */
    onSend: () => void;
    /** After a completed hold, never on a click. */
    onStop: () => void;
    /** Released too soon — the caller says so where it can be read. */
    onTooShort?: () => void;
  }
  let { busy, disabled = false, refusal = '', onSend, onStop, onTooShort }: Props = $props();

  // arrow -> square, the reference's two 7-point polygons. Lerped by `t`.
  const ARROW = [12, 4.5, 18.5, 11, 14.25, 11, 14.25, 19.5, 9.75, 19.5, 9.75, 11, 5.5, 11];
  const SQUARE = [12, 6, 18, 6, 18, 12, 18, 18, 6, 18, 6, 12, 6, 6];
  function pathAt(t: number): string {
    let d = '';
    for (let i = 0; i < ARROW.length; i += 2) {
      d += (i ? 'L' : 'M') + (ARROW[i] + (SQUARE[i] - ARROW[i]) * t).toFixed(2) +
        ' ' + (ARROW[i + 1] + (SQUARE[i + 1] - ARROW[i + 1]) * t).toFixed(2);
    }
    return d + 'Z';
  }
  // No rAF: the shape is a pure function of `busy` and the SVG path animates
  // through the CSS transition on `d` where the browser supports it. One less
  // frame loop per mounted composer, and it is correct on the first paint.
  let glyph = $derived(pathAt(busy ? 1 : 0));

  /** 0..1 while a hold fills. Drives the fill's width; reset on release. */
  let progress = $state(0);
  let raf = 0;
  let pressedAt = 0;

  const hold = createHold({
    onStop: () => { stopFill(); onStop(); },
    onTap: () => { stopFill(); onTooShort?.(); },
  });

  function stopFill() {
    cancelAnimationFrame(raf);
    progress = 0;
  }

  function press(e: PointerEvent | KeyboardEvent) {
    if (!busy || disabled) return;
    if ('button' in e && e.button !== 0) return;
    if (hold.held()) return;
    pressedAt = Date.now();
    hold.down(pressedAt);
    const tick = () => {
      progress = Math.min(1, (Date.now() - pressedAt) / HOLD_MS);
      if (progress < 1 && hold.held()) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  /** pointerup, pointercancel, pointerleave and lostpointercapture are the
   *  same event here: a drag off the button must not leave the fill running
   *  and stop the turn a second later. */
  function release() {
    if (!hold.held()) return;
    hold.up(Date.now());
    stopFill();
  }

  function click() {
    if (busy) return; // stop is hold-only
    if (disabled) return;
    onSend();
  }
</script>

<button
  class="action-btn"
  class:busy
  type="button"
  {disabled}
  data-busy={busy ? '' : undefined}
  aria-label={busy ? 'Stop (hold)' : 'Send'}
  style="--hold-p: {progress}"
  onclick={click}
  onpointerdown={press}
  onpointerup={release}
  onpointercancel={release}
  onpointerleave={release}
  onlostpointercapture={release}
  onkeydown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); if (busy) press(e); else click(); } }}
  onkeyup={(e) => { if (e.key === 'Enter' || e.key === ' ') release(); }}
  use:tip={refusal || (busy ? 'Hold to stop the running turn' : 'Send')}
>
  <span class="action-fill" aria-hidden="true"></span>
  <svg class="action-glyph" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"
    fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
    <path d={glyph} />
  </svg>
</button>

<style>
  .action-btn {
    position: relative;
    display: inline-grid;
    place-items: center;
    isolation: isolate;
    width: 34px;
    height: 34px;
    padding: 0;
    border: 0;
    border-radius: 9px;
    background: var(--og-chat);
    color: var(--og-bg);
    cursor: pointer;
    overflow: hidden;
    transition: background-color 200ms ease, color 200ms ease, opacity 200ms ease;
  }
  .action-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  /* Busy is a quiet button with red ink: the STOP is the hold, not the colour,
     and a solid red button invites the click that is deliberately dead. */
  .action-btn.busy { background: var(--og-btn-bg); color: var(--og-error); }
  .action-btn:focus-visible { outline: 2px solid var(--og-chat); outline-offset: 2px; }
  /* The hold's fill, left to right, under the glyph. Width is the progress —
     no transition, because the value is already driven frame by frame. */
  .action-fill {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: 1;
    width: calc(var(--hold-p, 0) * 100%);
    /* Tinted, not solid: the stop square is drawn in --og-error too, and a
       solid fill would swallow the one glyph that says what is happening. */
    background: color-mix(in srgb, var(--og-error) 38%, transparent);
  }
  .action-glyph {
    position: relative;
    z-index: 2;
    display: block;
    transform-origin: 50% 50%;
  }
  .action-btn.busy .action-glyph { transition: color 200ms ease; }
  .action-glyph path { transition: d 240ms cubic-bezier(0.23, 1, 0.32, 1); }
  @media (prefers-reduced-motion: reduce) {
    .action-glyph path { transition: none; }
  }
</style>
