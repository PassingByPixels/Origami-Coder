<script lang="ts">
  import PermissionTextEntry from './PermissionTextEntry.svelte';
  import { isQuestionShaped, otherOption } from './permissionOptions';
  import { enterOption, escOption, trayKeyAnswer } from './trayKeys';

  interface Props {
    title: string;
    options: { optionId: string; name: string; kind: string }[];
    /** Ground-truth action kind (edit / execute / read / fetch / …) and target
     *  (path / dir / url / command) so the user approves with context. Both are
     *  optional — a bare prompt still renders. NO agent-authored "reason": a
     *  local model rationalises, and a wrong justification launders a bad call. */
    action?: string;
    target?: string;
    /** The literal shell command for an execute ask. Rendered verbatim in a
     *  monospace block (wrap + scroll on overflow) so the user sees exactly what
     *  they're approving — never truncated to a useless title. */
    command?: string;
    /** How many further asks are queued BEHIND this one (sub-agents of one chat all
     *  ask through this bar). Shown as "1 of N" — a user staring at one prompt with
     *  three invisible ones behind it is exactly the stall this surfaces. */
    waiting?: number;
    /** reviseText is set only for the plan-mode "Revise" path — the caller
     *  resolves the permission AND sends that text as the next prompt. */
    onChoice: (optionId: string | null, reviseText?: string, answerText?: string) => void;
    /** YOLO. Absent (every bar mounted before M4.4, and every test that does
     *  not care) means no button at all — this is a control, not a decoration,
     *  and one that renders without a handler is a lie about what a click does. */
    onYolo?: () => void;
    /** t-yyz5qi: Enter = Allow once, Esc = Reject (trayKeys.ts). Only the chat in
     *  focus takes keys — in the grid every cell has a tray, and one key press
     *  must answer one ask. Off by default. */
    keys?: boolean;
  }

  let { title, options, action, target, command, waiting = 0, onChoice, onYolo, keys = false }: Props = $props();

  // When the target IS the command (the workdir-less fallback populated it),
  // don't render it twice — the command block below carries it.
  const showTarget = $derived(target && target !== command);

  // WHICH KIND OF ASK this is. A question (no allow_always) gets the free-text
  // "Other" answer; a real consent ask gets the yolo button. Never both — a
  // "bypass everything" control on a question would be answering the model's
  // question by granting it permissions it did not ask for.
  const isQuestion = $derived(isQuestionShaped(options));
  const other = $derived(otherOption(options));

  // Two paths into the same text box: plan-mode "Revise" (resolve with the
  // Revise option, hand the text back as the NEXT prompt) and M4.4's "Other"
  // (resolve with the Other option, the text IS the answer). `entry` holds
  // which one is open; null = the option buttons are showing.
  const reviseOption = $derived(options.find((o) => o.name === 'Revise'));
  let entry = $state<'revise' | 'other' | null>(null);

  function submitEntry(text: string) {
    if (entry === 'revise' && reviseOption) onChoice(reviseOption.optionId, text);
    else if (entry === 'other' && other) onChoice(other.optionId, undefined, text);
    entry = null;
  }

  const enterId = $derived(enterOption(options)?.optionId);
  const escId = $derived(escOption(options)?.optionId);
  function onKey(e: KeyboardEvent) {
    if (!keys || entry) return;
    const id = trayKeyAnswer(e, options);
    if (id === null) return;
    e.preventDefault();
    onChoice(id);
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- t-yyz5qi (mockup B): the ask rises as one tray out of the composer's top
     edge, amber, with a slow travelling line: waiting on you, not working. -->
<div class="permission-bar tray" role="alertdialog" aria-label="Permission request">
  {#if waiting > 0}<span class="tray-stack" aria-hidden="true"></span>{/if}
  <span class="tray-travel" aria-hidden="true"></span>
  <div class="permission-title">
    <span>{title || 'Approve tool call?'}</span>
    {#if waiting > 0}<span class="perm-queue" title="{waiting} more waiting behind this one">1 of {waiting + 1}</span>{/if}
  </div>
  {#if action || showTarget}
    <div class="permission-context">
      {#if action}<span class="perm-action">{action}</span>{/if}
      {#if showTarget}<span class="perm-target" title={target}><bdi dir="ltr">{target}</bdi></span>{/if}
    </div>
  {/if}
  {#if command}
    <pre class="perm-command" title={command}>{command}</pre>
  {/if}
  {#if entry}
    {#key entry}
      <PermissionTextEntry
        placeholder={entry === 'revise' ? 'What should the agent change about the plan?' : 'Type your answer…'}
        hint={entry === 'revise' ? 'The agent stays in plan mode and revises' : 'Sent as your answer to the question'}
        submitLabel={entry === 'revise' ? 'Send revision' : 'Send answer'}
        onSubmit={submitEntry}
        onCancel={() => (entry = null)}
      />
    {/key}
  {:else}
    <div class="permission-buttons">
      {#each options as opt}
        <button
          class="perm-btn"
          class:deny={opt.kind === 'reject_once' && opt.name !== 'Revise'}
          class:yes={opt.kind === 'allow_once' && !isQuestion}
          class:revise={opt.name === 'Revise'}
          data-key={keys && !isQuestion ? (opt.optionId === enterId ? 'Enter' : opt.optionId === escId ? 'Esc' : null) : null}
          onclick={() => {
            if (opt.name === 'Revise') entry = 'revise';
            else if (other && opt.optionId === other.optionId) entry = 'other';
            else onChoice(opt.optionId);
          }}>
          {opt.name}
        </button>
      {/each}
      <!-- YOLO. Off to the right, in the deny red, and ONLY on a real consent
           ask: it answers this one with its allow option AND flips the chat to
           bypass, so it is the most destructive control on the bar and is
           coloured like it. Hidden on a question, where "approve everything"
           has no meaning. -->
      {#if onYolo && !isQuestion}
        <span class="perm-spacer"></span>
        <button class="perm-btn deny yolo" onclick={onYolo}
          title="YOLO — approve this and stop asking in this chat. Every tool call, including deletes and shell commands, runs without a prompt until you switch Approve back.">
          YOLO
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* The tray. It sits under the composer's stacking layer (.input-area is
     z-index 3), so the rise reads as coming out of the composer's top edge. */
  .permission-bar {
    position: relative; z-index: 2; flex-shrink: 0;
    margin: 0 12px -1px; padding: 10px 12px 9px;
    border: 1px solid color-mix(in srgb, var(--og-warning) 50%, var(--og-border)); border-bottom: 0;
    border-radius: 10px 10px 0 0;
    background: color-mix(in srgb, var(--og-warning) 6%, var(--og-surface));
    box-shadow: 0 -8px 24px -12px rgba(0, 0, 0, 0.6);
    animation: tray-rise 420ms cubic-bezier(0.23, 1, 0.32, 1);
  }
  @keyframes tray-rise { from { transform: translateY(100%); clip-path: inset(0 0 100% 0); } to { clip-path: inset(0 0 0 0); } }
  /* Half-speed travelling line along the top edge (3.6 s): waiting, not working. */
  .tray-travel { position: absolute; left: 10px; right: 10px; top: 0; height: 1px; overflow: hidden; }
  .tray-travel::after {
    content: ''; position: absolute; inset: 0 auto 0 0; width: 34%; background: var(--og-warning);
    animation: tray-travel 3.6s cubic-bezier(0.77, 0, 0.175, 1) infinite;
  }
  @keyframes tray-travel { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
  /* Queued asks: a thin card edge behind the tray. */
  .tray-stack {
    position: absolute; left: 10px; right: 10px; top: -5px; height: 5px; border-radius: 8px 8px 0 0;
    border: 1px solid var(--og-border); border-bottom: 0; background: var(--og-surface);
  }
  @media (prefers-reduced-motion: reduce) { .permission-bar, .tray-travel::after { animation: none; } }

  .permission-title {
    display: flex; align-items: baseline; gap: 6px; margin-bottom: 7px;
    font-weight: 500; font-size: 12px; color: var(--og-text);
  }
  .perm-queue {
    flex-shrink: 0; font-weight: 600; font-size: 9.5px; padding: 1px 6px; border-radius: 3px;
    color: var(--og-warning); border: 1px solid var(--og-warning);
  }
  .permission-context { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; font-size: 11px; min-width: 0; }
  .perm-action {
    flex-shrink: 0; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; font-size: 9.5px;
    padding: 1px 6px; border-radius: 3px; background: var(--og-btn-bg); color: var(--og-text-muted); border: 1px solid var(--og-border);
  }
  .perm-target {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left;
    color: var(--og-text); font-family: var(--vscode-editor-font-family, monospace);
  }
  /* The literal command — shown in full: wraps, and scrolls if it's very long,
     rather than being truncated to a useless single line. */
  .perm-command {
    margin: 0 0 8px 0; padding: 6px 8px; max-height: 96px; overflow: auto;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; line-height: 1.4;
    color: var(--og-text); background: var(--og-bg); border: 1px solid var(--og-border); border-radius: 6px;
    white-space: pre-wrap; word-break: break-word;
  }
  .permission-buttons { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .perm-btn {
    padding: 2px 10px; font: inherit; font-size: 11.5px; cursor: pointer; border-radius: 6px;
    border: 1px solid var(--og-border); background: var(--og-bg); color: var(--og-text-secondary);
    transition: transform 160ms ease, border-color 160ms ease;
  }
  .perm-btn:hover { border-color: var(--og-text-muted); color: var(--og-text); }
  .perm-btn:active { transform: scale(0.97); }
  .perm-btn.yes { border-color: color-mix(in srgb, var(--og-warning) 60%, transparent); color: var(--og-warning); }
  .perm-btn.deny { color: var(--og-error); border-color: color-mix(in srgb, var(--og-error) 50%, var(--og-border)); }
  .perm-btn.revise { border-color: var(--og-chat); color: var(--og-chat); }
  /* The key hint, outside the button's text so its label stays exact. */
  .perm-btn[data-key]::after { content: attr(data-key); font-size: 9.5px; opacity: 0.6; margin-left: 5px; }
  /* Pushes YOLO to the far right, away from the option the user actually came
     here to press. The row wraps, so this is `flex: 1` on a spacer rather than
     `margin-left: auto` — a wrapped row would otherwise strand the button
     alone at the top. */
  .perm-spacer { flex: 1 1 auto; min-width: 8px; }
  .perm-btn.yolo {
    font-weight: 600; letter-spacing: 0.04em; color: var(--og-error);
    background: color-mix(in srgb, var(--og-error) 14%, var(--og-bg)); border-color: var(--og-error);
  }
</style>
