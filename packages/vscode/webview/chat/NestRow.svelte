<script lang="ts">
  // t-s9k0q6 (round 7 rules 4-5): one chat on another desk. The product row's
  // own classes and box (ChatsList.svelte's .session-row / .session-open /
  // .session-dot / .session-name, copied below because Svelte scopes CSS to
  // the file that writes the markup), so a Nest row is the same 28 px as a
  // Here row. One line: state dot, title (ellipsis), desk chip, age.
  //
  // Plain click = open the chat read only (t-sc093o; the host pulls the body,
  // and the tooltip is the round-7 read-only sentence). Hover or keyboard
  // focus = ONE button, "Continue here", over the age; the chip steps left by
  // the button's width so the button never covers it.
  import { tip } from '../shared/WarmTooltip.svelte';
  import DeskChip from './DeskChip.svelte';
  import { ageText, continueCase, continueTip, readText, type NestDesk, type NestIndexRow } from './nestIndex';

  let { row, desk, name, home, now, pending, onOpen, onContinue }: {
    row: NestIndexRow;
    desk: NestDesk | undefined;
    name: string;
    /** The mother base, for the offline sentence. */
    home: NestDesk | undefined;
    now: number;
    /** A Continue is on its way to the host: the button is off until it answers. */
    pending: boolean;
    onOpen: (row: NestIndexRow) => void;
    onContinue: (row: NestIndexRow) => void;
  } = $props();

  const kind = $derived(continueCase(row, desk));
  const tipText = $derived(continueTip(row, desk, name));
</script>

<div class="nest-item">
  <div class="session-row nest-row" role="listitem" data-k={kind} data-id={row.id}>
    <button class="session-open" onclick={() => onOpen(row)} disabled={pending} use:tip={readText(row, desk, name, home, now)}>
      <span class="session-dot" data-state={kind === 'running' ? 'running' : 'idle'} aria-hidden="true"></span>
      <span class="session-name">{row.title}</span>
      <DeskChip {desk} {name} />
      <span class="nest-age">{ageText(row.lastAt, now)}</span>
    </button>
    <button class="nest-cont" disabled={pending} onclick={() => onContinue(row)} use:tip={tipText}>Continue here</button>
  </div>
</div>

<style>
  .nest-item { position: relative; }
  /* --- the product row's box (ChatsList.svelte), no ring, no drag --- */
  .session-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: 5px;
  }
  .session-row:hover { background: var(--og-btn-bg); }
  .session-open {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 7px;
    text-align: left;
    padding: 6px 8px;
    background: transparent;
    border: none;
    cursor: pointer;
    font-family: inherit;
    overflow: hidden;
  }
  .session-open:focus-visible { outline: 1px solid var(--og-chat); outline-offset: -1px; border-radius: 5px; }
  .session-dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    margin-right: 1px;
    border-radius: 50%;
    background: var(--og-text-muted);
    opacity: 0.55;
  }
  .session-dot[data-state='running'] {
    background: var(--og-chat);
    opacity: 1;
    animation: nest-dot-pulse 1.6s cubic-bezier(0.77, 0, 0.175, 1) infinite;
  }
  @keyframes nest-dot-pulse {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--og-chat) 55%, transparent); }
    55% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--og-chat) 0%, transparent); }
  }
  @media (prefers-reduced-motion: reduce) {
    .session-dot { animation: none !important; }
  }
  .session-name {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 12px;
    color: var(--og-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* --- the Nest parts --- */
  .nest-row[data-k='offline'] .session-name,
  .nest-row[data-k='closed'] .session-name { color: var(--og-text-muted); }
  .nest-row[data-k='offline'] .session-dot { opacity: 0.6; }
  /* A closed chat: a hollow dot. */
  .nest-row[data-k='closed'] .session-dot {
    background: transparent;
    box-shadow: inset 0 0 0 1.3px var(--og-text-muted);
    opacity: 0.7;
  }
  .nest-age {
    flex: 0 0 auto;
    width: 32px;
    margin-left: 4px;
    text-align: right;
    font-size: 10px;
    color: var(--og-text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    align-self: center;
  }
  .nest-cont {
    display: none;
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    height: 18px;
    padding: 0 7px;
    border: 1px solid var(--og-border);
    border-radius: 5px;
    background: var(--og-btn-hover);
    color: var(--og-text);
    font: inherit;
    font-size: 10.5px;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
  }
  .nest-cont:hover { border-color: var(--og-chat); }
  .nest-cont:focus-visible { outline: 1px solid var(--og-chat); outline-offset: 1px; }
  .nest-cont:disabled { opacity: 0.55; cursor: default; }
  .nest-row:hover .nest-cont,
  .nest-row:focus-within .nest-cont { display: inline-flex; align-items: center; }
  /* While the button shows, the age hides and the chip steps aside, so the
     title keeps the room it can and the chip is never covered. */
  .nest-row:hover .nest-age,
  .nest-row:focus-within .nest-age { visibility: hidden; }
  .nest-row:hover :global(.desk-chip),
  .nest-row:focus-within :global(.desk-chip) { margin-right: 66px; }
</style>
