<script lang="ts">
  import { tip } from '../../shared/warmTip';
  // ConnectedRow — t-yyz5yk (Round 8 E): the "session is up" system line as a
  // handshake row in place of an italic sentence. A link line draws solid
  // green (350 ms, once), then the row is still. The session id is shortened
  // and copies on click; the full id is in the tooltip.
  //
  // Not built here (see the lane report): the two contact chips need the
  // agent's and the peer's names on this row, which the host line does not
  // carry; "Type a message and press Enter" moving into the composer
  // placeholder belongs to the composer lane.
  import { copy } from '../panes/flockCopy';
  import { shortSessionId } from './connectedLine';
  interface Props { sessionId: string; }
  let { sessionId }: Props = $props();
  let copied = $state(false);
  function onCopy() {
    copy(sessionId);
    copied = true;
    setTimeout(() => (copied = false), 1200);
  }
</script>

<!-- `row system`: it is still the transcript's system row (row order and
     kind are read by class elsewhere); the visually hidden sentence keeps the
     full wording for a screen reader and for find-in-chat. -->
<div class="row system conn-row" role="status">
  <span class="conn-sr">Connected. Session {sessionId}.</span>
  <span class="conn-link" aria-hidden="true"></span>
  <span class="conn-state">connected</span>
  <button class="conn-sid" type="button" use:tip={`Copy session id: ${sessionId}`} onclick={onCopy}>{copied ? 'copied' : shortSessionId(sessionId)}</button>
</div>

<style>
  .conn-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 26px;
    margin: 6px 0;
    font-size: 11px;
    white-space: nowrap;
  }
  .conn-link {
    position: relative;
    flex: 0 1 90px;
    min-width: 30px;
    height: 1px;
    background: color-mix(in srgb, var(--og-border) 70%, transparent);
    overflow: hidden;
  }
  .conn-link::before {
    content: '';
    position: absolute;
    inset: 0;
    background: color-mix(in srgb, var(--og-success) 70%, transparent);
    transform-origin: left;
    animation: conn-draw 350ms cubic-bezier(0.23, 1, 0.32, 1) both;
  }
  @keyframes conn-draw { from { transform: scaleX(0); } }
  .conn-state { color: var(--og-success); }
  .conn-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .conn-sid {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10.5px;
    color: var(--og-text-muted);
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid transparent;
    background: none;
    cursor: pointer;
    transition: border-color 160ms ease, color 160ms ease;
  }
  .conn-sid:hover, .conn-sid:focus-visible { border-color: var(--og-border); color: var(--og-text-secondary); outline: none; }
  @media (prefers-reduced-motion: reduce) {
    .conn-link::before { animation: none; }
    .conn-sid { transition: none; }
  }
</style>
