<script lang="ts">
  // ThoughtLine — the summary line of a reasoning block while the model is
  // still thinking, and after it stops (CHANGES.md change 22, from react-bits
  // Micro/ThoughtLine).
  //
  // Working: a shimmer sweeps the label and a drawn line travels under it.
  // Settled: both stop, over 350ms, so the row does not simply snap.
  //
  // Extracted out of ThoughtPill.svelte (123 of its 125-line cap) rather than
  // raising that cap. It is a real seam, not a line-count dodge: the pill owns
  // the FOLD — a native <details>, its open state, the body — while this owns
  // the INDICATOR, which is a self-contained animation vocabulary with no state
  // of its own. The mock has to infer "working" from the text growing; the
  // product is told, so `working` is a prop and there is no timer here.
  //
  // The line lives INSIDE the <summary> at the caller, which is the whole
  // reason this is a component and not two loose rules: a closed <details>
  // hides every sibling after its summary, and a thought block starts closed,
  // so a line placed after the summary never renders at all.
  interface Props {
    /** The summary text — 'Thought process', 'thinking…', a tool name. */
    label: string;
    /** The label is a TOOL LINE, not prose: monospace, never italicised. */
    mono?: boolean;
    /** This thought is still arriving. False settles the row. */
    working?: boolean;
  }
  let { label, mono = false, working = false }: Props = $props();
</script>

<span class="thought-label" class:mono class:working>{label}</span>
<span class="tl-line" class:working aria-hidden="true"></span>

<style>
  .thought-label {
    display: inline-block;
    opacity: 1;
    filter: blur(0);
    transition:
      opacity 350ms cubic-bezier(0.23, 1, 0.32, 1),
      filter 350ms cubic-bezier(0.23, 1, 0.32, 1);
  }
  /* A TOOL line is code, not prose — a tool name set in italic serif reads as
     commentary about a tool rather than as the call that ran. */
  .thought-label.mono {
    font-family: var(--vscode-editor-font-family, monospace);
    font-style: normal;
  }
  /* The sweep is painted THROUGH the text (background-clip), so the label reads
     as lit from behind rather than as a moving box over it. */
  .thought-label.working {
    background: linear-gradient(
      100deg,
      color-mix(in srgb, var(--og-text-secondary) 40%, transparent) 30%,
      var(--og-chat) 50%,
      color-mix(in srgb, var(--og-text-secondary) 40%, transparent) 70%
    );
    background-size: 250% 100%;
    background-position: 125% 0;
    background-clip: text;
    -webkit-background-clip: text;
    color: transparent;
    -webkit-text-fill-color: transparent;
    animation: tl-shimmer 1.8s linear infinite;
  }
  @keyframes tl-shimmer { to { background-position: -125% 0; } }

  /* The drawn line takes the SLACK after the label on the same row, rather than
     a row of its own: the summary keeps the height it has at 0.4.151. It exists
     at rest too, at zero opacity, so settling is a fade and not a reflow. */
  .tl-line {
    position: relative;
    display: block;
    flex: 1 1 60px;
    min-width: 60px;
    align-self: center;
    height: 1px;
    margin: 0 0 0 8px;
    overflow: hidden;
    background: color-mix(in srgb, var(--og-border) 70%, transparent);
    opacity: 0;
    transition: opacity 350ms ease;
  }
  .tl-line.working { opacity: 1; }
  .tl-line::after {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: 34%;
    background: var(--og-chat);
    animation: tl-travel 1.8s cubic-bezier(0.77, 0, 0.175, 1) infinite;
  }
  @keyframes tl-travel {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(340%); }
  }

  @media (prefers-reduced-motion: reduce) {
    .thought-label { transition: none; }
    .thought-label.working { animation: none; }
    .tl-line::after { animation-duration: 4s; }
  }
</style>
