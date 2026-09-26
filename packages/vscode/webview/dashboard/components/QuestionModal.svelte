<script lang="ts">
  import { otherOption, type PermOption } from './permissionOptions';

  // ONE engine ask carries ALL of these (acp/question.ts `_meta.questions`), so
  // a question is identified by its POSITION in the batch. It used to be keyed
  // by toolCallId, which cannot work: every question in a request shares the
  // asking tool's callID, so N questions collapsed onto one key.
  //
  // t-yyz5qi (redesign R2, mockup H): the ask opens in the middle of the pane
  // over a dimmed, blurred backdrop, one question at a time, numbered choices,
  // "Other…" opens room to write, dots jump back. t-xum9v2: a `multiple`
  // question ticks any number of choices and answers with all of them.
  interface Question {
    title: string;
    options: PermOption[];
    multiple?: boolean;
  }

  interface Answer {
    optionId: string;
    answerText?: string;
    optionIds?: string[];
  }

  type Draft = { optionId: string; answerText: string; optionIds?: string[] };

  interface Props {
    questions: Question[];
    onSubmit: (answers: Answer[]) => void;
    onClose: () => void;
    /**
     * The draft — which question is open, and what has been entered so far,
     * keyed by question INDEX. Nothing is sent until Submit, so the user can
     * step back and change an earlier answer. BINDABLE, and the caller owns it,
     * because leaving the asking chat's tab unmounts this modal — state kept
     * here would be lost on a tab switch. ChatPane stores it per chat
     * (panes/questionAsks.ts). The defaults keep a caller that binds neither
     * working exactly as before.
     */
    currentIndex?: number;
    answers?: Record<number, Draft>;
  }

  let {
    questions, onSubmit, onClose,
    currentIndex = $bindable(0),
    answers = $bindable({}),
  }: Props = $props();

  let totalQuestions = $derived(questions.length);
  let currentQuestion = $derived(questions[currentIndex]);
  let multiple = $derived(!!currentQuestion?.multiple);

  // "Revise" (plan exit, dream review) is the plan's own "Other": it opens the
  // text box. The plan-mode lane (t-xsufpe) owns what happens to that text.
  const isOpenText = (o: PermOption) => o.name.trim() === 'Revise';
  let isPlan = $derived(!!currentQuestion?.options.some(isOpenText));
  let other = $derived(currentQuestion
    ? (otherOption(currentQuestion.options) ?? currentQuestion.options.find(isOpenText) ?? null)
    : null);
  let displayOptions = $derived(currentQuestion
    ? currentQuestion.options.filter((o) => o.name.trim() !== 'Other' && o.optionId !== other?.optionId)
    : []);

  let currentAnswer = $derived(answers[currentIndex]);
  let selectedOption = $derived(currentAnswer?.optionId ?? '');
  let ticked = $derived(currentAnswer?.optionIds ?? []);
  let freeText = $derived(currentAnswer?.answerText ?? '');
  // The text box is open while "Other…" is picked or holds text.
  let otherOpen = $state(false);
  let showText = $derived(otherOpen || !!freeText || (!!other && selectedOption === other.optionId && !multiple));
  let slide = $state<'r' | 'l' | ''>('');

  function draft(patch: Partial<Draft>) {
    const held = answers[currentIndex] ?? { optionId: '', answerText: '' };
    answers = { ...answers, [currentIndex]: { ...held, ...patch } };
  }

  function selectOption(optionId: string) {
    if (!currentQuestion) return;
    if (multiple) {
      const next = ticked.includes(optionId) ? ticked.filter((id) => id !== optionId) : [...ticked, optionId];
      draft({ optionIds: next, optionId: next[0] ?? '' });
      return;
    }
    otherOpen = false;
    answers = { ...answers, [currentIndex]: { optionId, answerText: '' } };
  }

  function pickOther() {
    if (!other) return;
    otherOpen = true;
    if (!multiple) draft({ optionId: other.optionId });
  }

  function updateFreeText(text: string) {
    if (!currentQuestion) return;
    draft({ answerText: text });
  }

  function isAnswered(index: number): boolean {
    const a = answers[index];
    return !!(a?.optionId || a?.answerText || a?.optionIds?.length);
  }

  function jumpTo(i: number) {
    if (i < 0 || i >= totalQuestions || i === currentIndex) return;
    slide = i > currentIndex ? 'r' : 'l';
    otherOpen = false;
    currentIndex = i;
  }

  function goBack() { jumpTo(currentIndex - 1); }
  function goNext() { jumpTo(currentIndex + 1); }

  // One answer per question, in batch order — the engine matches them by
  // position, so a skipped question must still produce an entry.
  function handleSubmit() {
    const result: Answer[] = questions.map((q, i) => {
      const a = answers[i];
      const qOther = otherOption(q.options) ?? q.options.find(isOpenText) ?? null;
      if (q.multiple) {
        // Every tick, in option order; an empty list is the answer "none apply".
        const ids = q.options.filter((o) => a?.optionIds?.includes(o.optionId)).map((o) => o.optionId);
        const text = a?.answerText?.trim();
        return { optionId: ids[0] ?? '', optionIds: ids, ...(text ? { answerText: text } : {}) };
      }
      if (a) {
        if (a.optionId) return { optionId: a.optionId, answerText: a.answerText || undefined };
        if (a.answerText && qOther) return { optionId: qOther.optionId, answerText: a.answerText };
      }
      const opts = q.options.filter((o) => o.name.trim() !== 'Other');
      return { optionId: opts[0]?.optionId ?? '' };
    });
    onSubmit(result);
  }

  let isFirst = $derived(currentIndex === 0);
  let isLast = $derived(currentIndex === totalQuestions - 1);
  // A single-choice question needs a pick (or text) before Next/Submit; a
  // multi one does not ("none apply" is an answer).
  let canAdvance = $derived(multiple || isAnswered(currentIndex));

  function advance() {
    if (!canAdvance) return;
    if (isLast) handleSubmit(); else goNext();
  }

  // Keys while the ask is open: 1-9 pick, Enter = Next / Submit, Esc closes.
  // In the text box, Ctrl+Enter advances and Esc only leaves the box. Keys
  // typed elsewhere (the composer) are not ours.
  let frame = $state<HTMLElement | null>(null);
  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
    if (typing && !frame?.contains(t)) return;
    if (typing) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); advance(); }
      else if (e.key === 'Escape') { e.preventDefault(); t!.blur(); }
      return;
    }
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= displayOptions.length) { selectOption(displayOptions[n - 1]!.optionId); return; }
    if (other && n === displayOptions.length + 1) { pickOther(); return; }
    if (e.key === 'Enter' && !(t && t.tagName === 'BUTTON')) { e.preventDefault(); advance(); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="qm-backdrop" onclick={onClose} role="presentation"></div>
<div class="qm-frame" role="dialog" aria-modal="true" aria-label={isPlan ? 'Plan review' : 'Clarifying questions'} bind:this={frame}>
  <span class="qm-travel" aria-hidden="true"></span>
  <div class="qm-header">
    <svg class="qm-icon" viewBox="0 0 24 24" aria-hidden="true">
      {#if isPlan}<path d="M9 5h10M9 12h10M9 19h10"/><path d="M4 5h.5M4 12h.5M4 19h.5"/>
      {:else}<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.4M12 16.5v.5"/>{/if}
    </svg>
    <span class="qm-title">{isPlan ? 'Plan review' : totalQuestions > 1 ? 'Clarifying questions' : 'The agent asks'}</span>
    {#if totalQuestions > 1}
      <span class="qm-stepper">
        {#each questions as _q, i}
          <button
            class="qm-step"
            class:active={i === currentIndex}
            class:done={isAnswered(i)}
            onclick={() => jumpTo(i)}
            title="Question {i + 1}{isAnswered(i) ? ' (answered)' : ''}"
            aria-label="Go to question {i + 1}"
          ></button>
        {/each}
      </span>
    {/if}
    <span class="qm-counter">{currentIndex + 1} of {totalQuestions}</span>
    <button class="qm-close" onclick={onClose} title="Close (Esc)" aria-label="Cancel">&#10005;</button>
  </div>
  <div class="qm-body">
    {#key currentIndex}
      <div class="qm-question-block" class:in-r={slide === 'r'} class:in-l={slide === 'l'}>
        <div class="qm-q-title">{currentQuestion?.title}</div>
        {#if multiple}<div class="qm-hint">Tick all that apply</div>{/if}
        <div class="option-list" role={multiple ? 'group' : 'radiogroup'}>
          {#each displayOptions as opt, oi}
            {@const on = multiple ? ticked.includes(opt.optionId) : selectedOption === opt.optionId}
            <button
              class="opt-btn"
              class:selected={on}
              class:multi={multiple}
              role={multiple ? 'checkbox' : 'radio'}
              aria-checked={on}
              onclick={() => selectOption(opt.optionId)}
            >
              <kbd class="opt-num">{oi + 1}</kbd>
              {#if multiple}<span class="opt-box" aria-hidden="true"></span>{/if}
              <span class="opt-text">{opt.name}</span>
              <svg class="opt-tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>
            </button>
          {/each}
          {#if other}
            <button class="opt-btn-other opt-other" class:selected={showText} onclick={pickOther}>
              <kbd class="opt-num">{displayOptions.length + 1}</kbd>
              <span class="opt-text">{isOpenText(other) ? 'Revise…' : 'Other…'}</span>
            </button>
          {/if}
        </div>
        <div class="free-text-row" class:open={showText || !other}>
          <div>
            <textarea
              class="free-text-input"
              class:active={!!freeText}
              placeholder={isPlan ? 'What should change about the plan?' : 'Type your own answer…'}
              value={freeText}
              oninput={(e) => updateFreeText((e.target as HTMLTextAreaElement).value)}
            ></textarea>
            <div class="free-text-hint">{isPlan ? 'The agent stays in plan mode and revises' : 'Sent as your answer to this question'} · Ctrl+Enter</div>
          </div>
        </div>
      </div>
    {/key}
  </div>
  <div class="qm-footer">
    <span class="qm-keys">1–{displayOptions.length + (other ? 1 : 0)} to pick · Enter for {isLast ? 'submit' : 'next'} · Esc to close</span>
    <button class="qm-cancel-btn" onclick={onClose}>Cancel</button>
    {#if totalQuestions > 1}<button class="qm-nav-btn" onclick={goBack} disabled={isFirst}>Back</button>{/if}
    {#if !isLast}
      <button class="qm-nav-btn primary" onclick={goNext} disabled={!canAdvance}>Next</button>
    {:else}
      <button class="qm-submit-btn" onclick={handleSubmit} disabled={!canAdvance}>Submit</button>
    {/if}
  </div>
</div>

<style>
  .qm-backdrop {
    position: absolute; inset: 0; z-index: 50;
    background: color-mix(in srgb, var(--og-bg) 62%, transparent); backdrop-filter: blur(2px);
    animation: qm-fade 240ms ease;
  }
  .qm-frame {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(540px, calc(100% - 32px)); max-height: 80%; z-index: 51; overflow: hidden;
    background: var(--og-surface); border: 1px solid color-mix(in srgb, var(--og-chat) 45%, var(--og-border));
    border-radius: 12px; box-shadow: 0 24px 60px -24px rgba(0, 0, 0, 0.8);
    display: flex; flex-direction: column; animation: qm-rise 350ms cubic-bezier(0.23, 1, 0.32, 1);
  }
  /* The chat-blue line that travels along the top edge while the ask waits. */
  .qm-travel { position: absolute; left: 12px; right: 12px; top: 0; height: 1px; overflow: hidden; }
  .qm-travel::after {
    content: ''; position: absolute; inset: 0 auto 0 0; width: 34%; background: var(--og-chat);
    animation: qm-travel 3.6s cubic-bezier(0.77, 0, 0.175, 1) infinite;
  }
  .qm-header { display: flex; align-items: center; gap: 8px; padding: 11px 14px 0; font-size: 12px; color: var(--og-text-secondary); flex-shrink: 0; }
  .qm-icon { width: 15px; height: 15px; fill: none; stroke: var(--og-chat); stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; flex-shrink: 0; }
  .qm-title { font-weight: 600; color: var(--og-text); }
  .qm-stepper { display: inline-flex; gap: 5px; margin-left: 4px; }
  .qm-step {
    width: 7px; height: 7px; padding: 0; border-radius: 50%; cursor: pointer;
    border: 1px solid var(--og-text-muted); background: transparent; transition: background-color 160ms ease, transform 160ms ease;
  }
  .qm-step.done { background: var(--og-text-muted); }
  .qm-step.active { border-color: var(--og-chat); background: var(--og-chat); transform: scale(1.25); }
  .qm-counter { font-size: 11px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; margin-right: auto; }
  .qm-close {
    width: 22px; height: 22px; border: 0; border-radius: 6px; background: transparent;
    color: var(--og-text-muted); cursor: pointer; font-size: 12px; font-family: inherit; flex-shrink: 0;
  }
  .qm-close:hover { background: var(--og-bg); color: var(--og-text); }
  .qm-body { flex: 1; padding: 10px 14px 4px; overflow-y: auto; }
  .qm-question-block.in-r { animation: qm-in-r 240ms cubic-bezier(0.23, 1, 0.32, 1); }
  .qm-question-block.in-l { animation: qm-in-l 240ms cubic-bezier(0.23, 1, 0.32, 1); }
  .qm-q-title { font-size: 14px; line-height: 1.45; color: var(--og-text); margin-bottom: 10px; }
  .qm-hint { font-size: 11px; color: var(--og-text-muted); margin: -6px 0 8px; }
  .option-list { display: flex; flex-direction: column; gap: 6px; }
  .opt-btn, .opt-btn-other {
    display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 12px; text-align: left;
    border-radius: 8px; border: 1px solid var(--og-border); background: var(--og-bg); cursor: pointer;
    font: inherit; font-size: 12.5px; color: var(--og-text-secondary);
    transition: border-color 160ms ease, background-color 160ms ease, color 160ms ease;
  }
  .opt-btn:hover, .opt-btn-other:hover { border-color: var(--og-text-muted); color: var(--og-text); }
  .opt-btn.selected, .opt-btn-other.selected { border-color: var(--og-chat); background: color-mix(in srgb, var(--og-chat) 10%, var(--og-bg)); color: var(--og-text); }
  .opt-num { font: inherit; font-size: 10.5px; color: var(--og-text-muted); min-width: 1ch; }
  .opt-box { width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--og-text-muted); flex-shrink: 0; }
  .opt-btn.selected .opt-box { border-color: var(--og-chat); background: var(--og-chat); }
  .opt-text { flex: 1; }
  /* The tick rolls in on the chosen option. */
  .opt-tick {
    width: 15px; height: 15px; fill: none; stroke: var(--og-chat); stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round;
    opacity: 0; transform: translateY(40%); filter: blur(2px);
    transition: opacity 240ms cubic-bezier(0.23, 1, 0.32, 1), transform 240ms cubic-bezier(0.23, 1, 0.32, 1), filter 240ms ease;
  }
  .opt-btn.selected .opt-tick { opacity: 1; transform: none; filter: none; }
  .free-text-row { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 350ms cubic-bezier(0.23, 1, 0.32, 1); }
  .free-text-row.open { grid-template-rows: 1fr; }
  .free-text-row > div { overflow: hidden; min-height: 0; }
  .free-text-input {
    display: block; width: 100%; min-height: 96px; margin-top: 6px; resize: vertical; box-sizing: border-box;
    font: inherit; font-size: 12.5px; line-height: 1.5; color: var(--og-text); background: var(--og-input-bg);
    border: 1px solid var(--og-border); border-radius: 8px; padding: 8px 10px; outline: none;
  }
  .free-text-input.active, .free-text-input:focus { border-color: var(--og-chat); }
  .free-text-hint { font-size: 10.5px; color: var(--og-text-muted); margin: 4px 0 2px; }
  .qm-footer {
    display: flex; align-items: center; gap: 8px; padding: 10px 14px 12px; margin-top: 8px;
    border-top: 1px solid var(--og-border); flex-shrink: 0;
  }
  .qm-keys { font-size: 10.5px; color: var(--og-text-muted); margin-right: auto; }
  .qm-cancel-btn, .qm-nav-btn, .qm-submit-btn {
    font: inherit; font-size: 12px; padding: 4px 12px; border-radius: 7px; cursor: pointer;
    border: 1px solid var(--og-border); background: var(--og-bg); color: var(--og-text-secondary);
  }
  .qm-cancel-btn:hover, .qm-nav-btn:hover:not(:disabled) { color: var(--og-text); border-color: var(--og-text-muted); }
  .qm-nav-btn:disabled, .qm-submit-btn:disabled { opacity: 0.4; cursor: default; }
  .qm-nav-btn.primary, .qm-submit-btn {
    border-color: var(--og-chat); background: color-mix(in srgb, var(--og-chat) 16%, var(--og-bg)); color: var(--og-text);
  }
  @keyframes qm-fade { from { opacity: 0; } }
  @keyframes qm-rise { from { opacity: 0; transform: translate(-50%, calc(-50% + 10px)) scale(0.98); } }
  @keyframes qm-in-r { from { opacity: 0; transform: translateX(22px); } }
  @keyframes qm-in-l { from { opacity: 0; transform: translateX(-22px); } }
  @keyframes qm-travel { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
  @media (prefers-reduced-motion: reduce) {
    .qm-backdrop, .qm-frame, .qm-question-block, .qm-travel::after { animation: none; }
    .opt-tick, .free-text-row { transition: none; }
  }
</style>
