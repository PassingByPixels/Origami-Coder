<script lang="ts">
  // The Artifacts pane's "?" (t-vbj8xu): how artifacts move between desks.
  // Each line is checked against the code; the ticket report lists file:line
  // per claim. Change a line only with the code that makes it true.
  import HelpPopover from '../../shared/HelpPopover.svelte';

  const lines = [
    'Each desk keeps its own artifacts. A new version never replaces an old one.',
    'With Nests on, your desks share the list, not the files.',
    'Open an artifact from another desk to bring its files here. A desk that holds them must be online.',
    'Each row names the desk that made the newest version.',
    'With Nests off, nothing leaves this desk.',
  ];
</script>

<HelpPopover label="How artifacts work between desks" heading="How artifacts move between your desks" {lines}>
  <svg viewBox="0 0 280 100" role="img" aria-label="This desk keeps every version. The list goes both ways through the relay. The files go to the other desk when it opens the artifact.">
    <defs>
      <marker id="hp-af-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="head" d="M0,0 L10,5 L0,10 z" /></marker>
      <marker id="hp-af-head-hi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="head-hi" d="M0,0 L10,5 L0,10 z" /></marker>
    </defs>
    <rect class="box" x="1" y="1" width="110" height="96" rx="8" />
    <text class="t-title" x="11" y="19">This desk</text>
    <text class="t-muted t-small" x="11" y="33">made it</text>
    <rect class="box-dim" x="11" y="42" width="26" height="20" rx="3" />
    <text class="t-muted t-small" x="24" y="56" text-anchor="middle">v1</text>
    <rect class="box-dim" x="41" y="42" width="26" height="20" rx="3" />
    <text class="t-muted t-small" x="54" y="56" text-anchor="middle">v2</text>
    <rect class="box-hi" x="71" y="42" width="26" height="20" rx="3" />
    <text class="t-title t-small" x="84" y="56" text-anchor="middle">v3</text>
    <text class="t-muted t-small" x="11" y="78">keeps every</text>
    <text class="t-muted t-small" x="11" y="91">version</text>
    <rect class="box-dim" x="116" y="1" width="48" height="96" rx="6" />
    <text class="t-title t-small" x="140" y="16" text-anchor="middle">Relay</text>
    <text class="t-small" x="140" y="42" text-anchor="middle">list</text>
    <path class="line dash" d="M113 48 H167" marker-start="url(#hp-af-head)" marker-end="url(#hp-af-head)" />
    <text class="t-small" x="140" y="68" text-anchor="middle">files</text>
    <path class="line-hi" d="M113 75 H167" marker-end="url(#hp-af-head-hi)" />
    <text class="t-muted t-small" x="140" y="88" text-anchor="middle">on Open</text>
    <rect class="box" x="169" y="1" width="110" height="96" rx="8" />
    <text class="t-title" x="179" y="19">Other desk</text>
    <text class="t-muted t-small" x="179" y="33">sees the list</text>
    <rect class="box-dim" x="179" y="42" width="90" height="20" rx="4" />
    <text class="t-small" x="224" y="56" text-anchor="middle">v3 · not here</text>
    <rect class="fill-chat" x="179" y="70" width="46" height="20" rx="4" />
    <text class="t-on t-small" x="202" y="84" text-anchor="middle">Open</text>
  </svg>
</HelpPopover>
