<script lang="ts">
  // The composer's FOCUS toggle — the eye at the right-hand end of the changes
  // row, level with Send. Pressed, the transcript above it drops to the
  // conversation alone: no tool cards, no reasoning, no turn bookkeeping. It is
  // a back-and-forth view switch, so the same button turns everything back on.
  //
  // Its OWN file rather than more markup inside ChangesPill.svelte, on the
  // pattern ModeControl and CompactionThresholdMenu set in the same composer:
  // the row is a row, and what sits at either end of it is a leaf. The glyph is
  // drawn inline (one path, one circle) because the webview ships no icon
  // library and a single 13px eye does not justify pulling one in.
  //
  // It owns NO state. WHICH chat is focused is a per-cell field on the session
  // (ChatPane.svelte): a grid can show twelve chats, and each answers the
  // question for itself.
  interface Props {
    /** Focus view is ON for the chat this composer belongs to. */
    focused: boolean;
    /** Flip it. The caller owns the flag; this reports the click and nothing else. */
    onToggle: () => void;
  }
  let { focused, onToggle }: Props = $props();
</script>

<button
  class="focus-eye"
  class:on={focused}
  aria-pressed={focused}
  aria-label="Focus view"
  title={focused
    ? 'Exit focus — show everything (reasoning, tool activity, turn verdicts)'
    : 'Focus — show only the conversation (hide reasoning and tool activity)'}
  onclick={onToggle}
>
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"
    fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">
    <path d="M1.5 12S5.6 5 12 5s10.5 7 10.5 7-4.1 7-10.5 7S1.5 12 1.5 12Z" />
    <circle cx="12" cy="12" r="3.2" />
  </svg>
</button>

<style>
  /* Pinned to the RIGHT end of the utility row (the changes pill holds the
     left), which is what puts it under the Send button. It borrows the pill's
     muted-outline idiom but drops the border until the view is ON: an
     always-outlined box beside an often-empty row reads as a second pill with
     nothing in it. No vertical margin — the row it sits in has no vertical
     padding on purpose (0.4.60 UAT), and a margin here would put it back. */
  .focus-eye {
    display: inline-flex;
    align-items: center;
    margin-left: auto;
    padding: 1px 5px;
    font: inherit;
    color: var(--og-text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    cursor: pointer;
    opacity: 0.8;
  }
  .focus-eye:hover { opacity: 1; color: var(--og-text-secondary); border-color: var(--og-border); }
  .focus-eye:focus-visible { outline: 1px solid var(--og-chat); outline-offset: 1px; }
  /* ON is carried by colour AND a border, never colour alone: this is a 13px
     glyph on a 17px strip, and a tint by itself is easy to miss — which on a
     toggle that HIDES rows would read as a transcript that lost them. */
  .focus-eye.on {
    color: var(--og-accent);
    border-color: var(--og-accent);
    opacity: 1;
  }
</style>
