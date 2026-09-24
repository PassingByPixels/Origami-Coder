<script lang="ts">
  // The Nests pane's "?" (t-vbj8xu): how Nests joins desks. Each line is
  // checked against the code; the ticket report lists file:line per claim.
  // Change a line only with the code that makes it true.
  import HelpPopover from '../../shared/HelpPopover.svelte';

  const lines = [
    'Nests is off until you turn it on. While it is off, nothing dials the relay.',
    'On, your desks send each other their chat lists through the relay. The relay gets sealed data only.',
    'Continue here brings a chat from another desk to this desk.',
    'The mother base copies the open chats of the other desks. They stay available when their desk is off.',
  ];
</script>

<HelpPopover label="How Nests works between desks" heading="How Nests joins your desks" {lines}>
  <svg viewBox="0 0 280 150" role="img" aria-label="This desk and the other desk connect through the relay, which gets sealed data only. The relay also connects the mother base, which copies the open chats.">
    <defs>
      <marker id="hp-nh-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="head" d="M0,0 L10,5 L0,10 z" /></marker>
      <marker id="hp-nh-head-hi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="head-hi" d="M0,0 L10,5 L0,10 z" /></marker>
    </defs>
    <rect class="box" x="1" y="1" width="104" height="50" rx="8" />
    <text class="t-title" x="11" y="18">This desk</text>
    <rect class="fill-chat" x="11" y="26" width="84" height="18" rx="4" />
    <text class="t-on t-small" x="53" y="39" text-anchor="middle">Continue here</text>
    <rect class="box" x="175" y="1" width="104" height="50" rx="8" />
    <text class="t-title" x="185" y="18">Other desk</text>
    <text class="t-muted t-small" x="185" y="38">had the chat</text>
    <rect class="box-dim" x="92" y="60" width="96" height="34" rx="6" />
    <text class="t-title" x="140" y="75" text-anchor="middle">Relay</text>
    <text class="t-muted t-small" x="140" y="88" text-anchor="middle">sealed data</text>
    <path class="line" d="M60 54 L104 62" marker-start="url(#hp-nh-head)" marker-end="url(#hp-nh-head)" />
    <path class="line" d="M220 54 L176 62" marker-start="url(#hp-nh-head)" marker-end="url(#hp-nh-head)" />
    <path class="line-hi" d="M140 96 V116" marker-end="url(#hp-nh-head-hi)" />
    <rect class="box-hi" x="60" y="119" width="160" height="30" rx="8" />
    <text class="t-title" x="140" y="132" text-anchor="middle">Mother base</text>
    <text class="t-muted t-small" x="140" y="144" text-anchor="middle">copies the open chats</text>
  </svg>
</HelpPopover>
