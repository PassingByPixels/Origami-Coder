<script lang="ts">
  import PermissionTextEntry from './PermissionTextEntry.svelte';
  import { isQuestionShaped, otherOption } from './permissionOptions';

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
  }

  let { title, options, action, target, command, waiting = 0, onChoice, onYolo }: Props = $props();

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
</script>

<div class="permission-bar">
  <div class="permission-title">
    <span>{title || 'Approve tool call?'}</span>
    {#if waiting > 0}<span class="perm-queue" title="{waiting} more waiting behind this one">1 of {waiting + 1}</span>{/if}
  </div>
  {#if action || showTarget}
    <div class="permission-context">
      {#if action}<span class="perm-action">{action}</span>{/if}
      {#if showTarget}<span class="perm-target" title={target}>{target}</span>{/if}
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
          class:revise={opt.name === 'Revise'}
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
  .permission-bar {
    padding: 10px 12px;
    background: var(--og-surface);
    border-top: 2px solid var(--og-warning);
    flex-shrink: 0;
  }

  .permission-title {
    font-weight: 600;
    font-size: 12px;
    margin-bottom: 8px;
    color: var(--og-text);
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .perm-queue {
    flex-shrink: 0;
    font-weight: 600;
    font-size: 9.5px;
    padding: 1px 6px;
    border-radius: 3px;
    color: var(--og-warning);
    border: 1px solid var(--og-warning);
  }

  .permission-context {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
    font-size: 11px;
    min-width: 0;
  }

  .perm-action {
    flex-shrink: 0;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
    font-size: 9.5px;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--og-btn-bg);
    color: var(--og-text-muted);
    border: 1px solid var(--og-border);
  }

  .perm-target {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
    color: var(--og-text);
    font-family: var(--vscode-editor-font-family, monospace);
  }

  /* The literal command — shown in full: wraps, and scrolls if it's very long,
     rather than being truncated to a useless single line. */
  .perm-command {
    margin: 0 0 8px 0;
    padding: 6px 8px;
    max-height: 96px;
    overflow: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--og-text);
    background: var(--og-input-bg);
    border: 1px solid var(--og-border);
    border-radius: 4px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .permission-buttons {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .perm-btn {
    padding: 5px 12px;
    font-size: 12px;
    cursor: pointer;
    border: 1px solid var(--og-border);
    background: var(--og-btn-bg);
    color: var(--og-btn-text);
    border-radius: 3px;
    font-family: inherit;
  }

  .perm-btn:hover {
    background: var(--og-btn-hover);
  }

  .perm-btn.deny {
    background: rgba(248, 113, 113, 0.15);
    color: var(--og-error);
    border-color: var(--og-error);
  }

  .perm-btn.deny:hover {
    background: rgba(248, 113, 113, 0.25);
  }

  .perm-btn.revise {
    border-color: var(--og-chat);
    color: var(--og-chat);
  }

  /* Pushes YOLO to the far right, away from the option the user actually came
     here to press. The row wraps, so this is `flex: 1` on a spacer rather than
     `margin-left: auto` — a wrapped row would otherwise strand the button
     alone at the top. */
  .perm-spacer { flex: 1 1 auto; min-width: 8px; }

  .perm-btn.yolo {
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  /* .perm-btn.primary, .revise-input and .revise-hint went to
     PermissionTextEntry.svelte with the markup they dressed. */
</style>
