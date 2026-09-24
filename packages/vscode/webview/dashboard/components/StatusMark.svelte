<script lang="ts">
  // StatusMark — a tool call's verdict as ONE mark that draws when the result
  // lands (CHANGES.md change 21, ported from react-bits Micro/StatusMark).
  //
  // The ring is the running state; the check draws over 240ms after a 120ms
  // delay when the call completes; the cross draws in its place when it fails.
  // Because the <svg> node SURVIVES the status change — only `data-status`
  // flips — the browser has a before and an after to interpolate between, which
  // is what makes the tick an ANIMATION rather than a swap. Replacing the glyph
  // with a different element per state would draw it already finished.
  //
  // The outer class is `check`/`cross`/`spinner`, the same three names the
  // header's glyphs carried before this component existed. That is not
  // decoration: browserCard.test.ts and chartCard.test.ts assert on those names
  // to prove a FAILED call never reads as a green tick — the honest-status
  // guard — and it must keep holding through the restyle.
  interface Props {
    /** `done` draws the check, `failed` the cross, anything else the ring. */
    status: 'done' | 'failed' | 'running';
  }
  let { status }: Props = $props();
  const CHECK = 'M7.5 12.25 10.5 15.25 16.75 8.75';
  const CROSS = 'M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5';
  let cls = $derived(status === 'done' ? 'check' : status === 'failed' ? 'cross' : 'spinner');
</script>

<svg class="status-mark {cls}" data-status={status} viewBox="0 0 24 24" aria-hidden="true">
  <circle class="sm-track" cx="12" cy="12" r="9" transform="rotate(-90 12 12)" />
  <circle class="sm-ring" cx="12" cy="12" r="9" />
  <path class="sm-check" d={CHECK} pathLength="1" />
  <path class="sm-cross" d={CROSS} pathLength="1" />
</svg>

<style>
  .status-mark {
    --sm-stroke: 2.2;
    --sm-fill: 0.1;
    --sm-draw: 240ms;
    --sm-check-delay: 120ms;
    --sm-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
    flex: none;
    /* 13px is the scale the 0.4.151 header glyphs already read at — the mark
       replaces them, it does not enlarge them. */
    width: 13px;
    height: 13px;
    overflow: visible;
    color: var(--og-text-muted);
    transition: color 200ms ease;
  }
  .status-mark[data-status='done'] { color: var(--og-success); }
  .status-mark[data-status='failed'] { color: var(--og-error); }
  .status-mark[data-status='running'] { color: var(--og-warning); }

  /* The disc behind the mark: invisible while pending, a faint wash once a
     verdict lands, so the tick sits on something rather than floating. */
  .sm-track {
    fill: currentColor;
    stroke: currentColor;
    stroke-width: var(--sm-stroke);
    fill-opacity: 0;
    stroke-opacity: 0;
    transition: fill-opacity 180ms ease, stroke-opacity 200ms ease;
  }
  .status-mark[data-status='running'] .sm-track { stroke-opacity: 0.2; }
  .status-mark[data-status='done'] .sm-track,
  .status-mark[data-status='failed'] .sm-track { fill-opacity: var(--sm-fill); }

  .sm-ring {
    fill: none;
    stroke: currentColor;
    stroke-width: var(--sm-stroke);
    stroke-linecap: round;
    opacity: 1;
  }
  /* The ring carries NO attribute transform (owner, 0.4.157: the arc wobbled
     below the track). An attribute rotate(-90 12 12) becomes a translated
     matrix once CSS animates `transform`, and interpolating that matrix to a
     plain rotate drifts the centre. The -90deg start lives in the keyframes
     instead, and the origin is pinned to the view box, not the stroke box. */
  .status-mark[data-status='running'] .sm-ring {
    stroke-dasharray: 33 15;
    transform-box: view-box;
    transform-origin: 12px 12px;
    animation: sm-spin 1100ms linear infinite;
  }
  .status-mark:not([data-status='running']) .sm-ring { transform: rotate(-90deg); transform-box: view-box; transform-origin: 12px 12px; }
  @keyframes sm-spin { from { transform: rotate(-90deg); } to { transform: rotate(270deg); } }

  /* `pathLength="1"` normalises both paths to a length of 1, so ONE dash pair
     draws either of them regardless of their real geometry. */
  .sm-check,
  .sm-cross {
    fill: none;
    stroke: currentColor;
    stroke-width: var(--sm-stroke);
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 1 2;
    stroke-dashoffset: 1.05;
    opacity: 0;
    transition: stroke-dashoffset 160ms var(--sm-ease-out), opacity 0ms linear 160ms;
  }
  .status-mark[data-status='done'] .sm-check,
  .status-mark[data-status='failed'] .sm-cross {
    stroke-dashoffset: 0;
    opacity: 1;
    transition:
      stroke-dashoffset var(--sm-draw) var(--sm-ease-out) var(--sm-check-delay),
      opacity 0ms linear var(--sm-check-delay);
  }

  @media (prefers-reduced-motion: reduce) {
    .status-mark[data-status='running'] .sm-ring { animation-duration: 3s; }
    .sm-check,
    .sm-cross { stroke-dashoffset: 0; transition: opacity 200ms ease; }
  }
</style>
