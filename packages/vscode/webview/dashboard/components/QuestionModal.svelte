<script lang="ts">
  import { otherOption, type PermOption } from './permissionOptions';

  // ONE engine ask carries ALL of these (acp/question.ts `_meta.questions`), so
  // a question is identified by its POSITION in the batch. It used to be keyed
  // by toolCallId, which cannot work: every question in a request shares the
  // asking tool's callID, so N questions collapsed onto one key.
  interface Question {
    title: string;
    options: PermOption[];
  }

  interface Answer {
    optionId: string;
    answerText?: string;
  }

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
    answers?: Record<number, { optionId: string; answerText: string }>;
  }

  let {
    questions, onSubmit, onClose,
    currentIndex = $bindable(0),
    answers = $bindable({}),
  }: Props = $props();

  let totalQuestions = $derived(questions.length);
  let currentQuestion = $derived(questions[currentIndex]);

  let displayOptions = $derived(currentQuestion
    ? currentQuestion.options.filter((o) => o.name.trim() !== 'Other')
    : []);
  let other = $derived(currentQuestion ? otherOption(currentQuestion.options) : null);

  // Bind to current question's answer for the active form
  let currentAnswer = $derived(answers[currentIndex]);
  let selectedOption = $derived(currentAnswer?.optionId ?? '');
  let freeText = $derived(currentAnswer?.answerText ?? '');

  function selectOption(optionId: string) {
    if (!currentQuestion) return;
    answers = { ...answers, [currentIndex]: { optionId, answerText: '' } };
  }

  function updateFreeText(text: string) {
    if (!currentQuestion) return;
    const existing = answers[currentIndex];
    answers = { ...answers, [currentIndex]: { optionId: existing?.optionId ?? '', answerText: text } };
  }

  function isAnswered(index: number): boolean {
    const a = answers[index];
    return !!(a?.optionId || a?.answerText);
  }

  function jumpTo(i: number) {
    if (i >= 0 && i < totalQuestions) currentIndex = i;
  }

  function goBack() { if (currentIndex > 0) currentIndex--; }
  function goNext() { if (currentIndex < totalQuestions - 1) currentIndex++; }

  // One answer per question, in batch order — the engine matches them by
  // position, so a skipped question must still produce an entry.
  function handleSubmit() {
    const result: Answer[] = questions.map((q, i) => {
      const a = answers[i];
      if (a) {
        if (a.optionId) return { optionId: a.optionId, answerText: a.answerText || undefined };
        const qOther = otherOption(q.options);
        if (a.answerText && qOther) return { optionId: qOther.optionId, answerText: a.answerText };
      }
      const opts = q.options.filter((o) => o.name.trim() !== 'Other');
      return { optionId: opts[0]?.optionId ?? '' };
    });
    onSubmit(result);
  }

  let isFirst = $derived(currentIndex === 0);
  let isLast = $derived(currentIndex === totalQuestions - 1);
</script>

<div class="qm-backdrop" onclick={onClose} role="presentation"></div>
<div class="qm-frame" role="dialog" aria-label="Clarifying questions">
  <div class="qm-header">
    <span class="qm-title">Clarifying questions</span>
    <span class="qm-counter">{currentIndex + 1} of {totalQuestions}</span>
    <button class="qm-close" onclick={onClose} title="Cancel" aria-label="Cancel">&#10005;</button>
  </div>
  <div class="qm-body">
    {#key currentIndex}
      <div class="qm-question-block">
        <div class="qm-q-header">
          <span class="qm-q-num">{currentIndex + 1}.</span>
          <span class="qm-q-title">{currentQuestion?.title}</span>
        </div>
        <div class="option-list">
          {#each displayOptions as opt, oi}
            <button
              class="opt-btn"
              class:selected={selectedOption === opt.optionId}
              onclick={() => selectOption(opt.optionId)}
            >
              <span class="opt-num">{oi + 1}.</span>
              <span class="opt-text">{opt.name}</span>
            </button>
          {/each}
        </div>
        <div class="free-text-row">
          <input
            class="free-text-input"
            class:active={!!freeText}
            type="text"
            placeholder="or type your own answer here"
            value={freeText}
            oninput={(e) => updateFreeText((e.target as HTMLInputElement).value)}
          />
        </div>
      </div>
    {/key}
  </div>
  <div class="qm-footer">
    <button class="qm-cancel-btn" onclick={onClose}>Cancel</button>
    <div class="qm-stepper">
      {#each questions as _q, i}
        <button
          class="qm-step"
          class:active={i === currentIndex}
          class:done={isAnswered(i)}
          onclick={() => jumpTo(i)}
          title="Question {i + 1}{isAnswered(i) ? ' (answered)' : ''}"
          aria-label="Go to question {i + 1}"
        >
          <span class="qm-step-dot" class:filled={isAnswered(i)}></span>
        </button>
      {/each}
    </div>
    <div class="qm-nav-btns">
      <button class="qm-nav-btn" onclick={goBack} disabled={isFirst}>Back</button>
      {#if !isLast}
        <button class="qm-nav-btn primary" onclick={goNext}>Next</button>
      {:else}
        <button class="qm-submit-btn" onclick={handleSubmit}>Submit</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .qm-backdrop { position: absolute; inset: 0; z-index: 50; background: rgba(0, 0, 0, 0.45); }
  .qm-frame {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(560px, 90%); max-height: 80%; z-index: 51; overflow: auto;
    background: var(--og-surface); border: 2px solid var(--og-chat); border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); display: flex; flex-direction: column;
  }
  .qm-header {
    display: flex; align-items: center; gap: 8px; padding: 8px 12px;
    background: var(--og-btn-bg); border-bottom: 1px solid var(--og-border); flex-shrink: 0;
  }
  .qm-title { font-weight: 600; font-size: 12px; color: var(--og-chat); }
  .qm-counter {
    font-size: 11px; color: var(--og-text-muted); font-variant-numeric: tabular-nums;
    margin-right: auto;
  }
  .qm-close {
    width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
    background: transparent; border: 1px solid var(--og-border); border-radius: 3px;
    color: var(--og-text-muted); cursor: pointer; font-size: 12px; font-family: inherit; flex-shrink: 0;
  }
  .qm-close:hover { color: var(--og-text); background: var(--og-btn-bg); }
  .qm-body { flex: 1; padding: 10px 12px; overflow-y: auto; }
  .qm-question-block {
    border: 1px solid var(--og-border); border-radius: 4px; padding: 10px; background: var(--og-bg);
  }
  .qm-q-header { display: flex; align-items: baseline; gap: 6px; margin-bottom: 8px; }
  .qm-q-num { font-weight: 700; font-size: 12px; color: var(--og-chat); flex-shrink: 0; }
  .qm-q-title { font-weight: 600; font-size: 12px; color: var(--og-text); }
  .option-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
  .opt-btn {
    display: flex; align-items: baseline; gap: 6px; padding: 5px 10px; font-size: 12px;
    cursor: pointer; border: 1px solid var(--og-border); background: var(--og-btn-bg);
    color: var(--og-btn-text); border-radius: 3px; font-family: inherit; text-align: left; width: 100%;
  }
  .opt-btn:hover { background: var(--og-btn-hover); }
  .opt-btn.selected { background: var(--og-btn-hover); border-color: var(--og-chat); color: var(--og-text); }
  .opt-num { color: var(--og-text-muted); font-variant-numeric: tabular-nums; min-width: 1.5em; flex-shrink: 0; }
  .opt-text { flex: 1; }
  .free-text-row { margin-bottom: 0; }
  .free-text-input {
    width: 100%; padding: 5px 8px; font-size: 12px; background: var(--og-input-bg);
    color: var(--og-text); border: 1px solid var(--og-border); border-radius: 3px;
    font-family: inherit; box-sizing: border-box;
  }
  .free-text-input.active { border-color: var(--og-chat); }
  .qm-footer {
    display: flex; align-items: center; gap: 8px; padding: 8px 12px;
    border-top: 1px solid var(--og-border); flex-shrink: 0;
  }
  .qm-cancel-btn {
    padding: 5px 10px; font-size: 11px; cursor: pointer;
    border: 1px solid var(--og-border); background: var(--og-btn-bg);
    color: var(--og-btn-text); border-radius: 3px; font-family: inherit;
  }
  .qm-cancel-btn:hover { background: var(--og-btn-hover); }
  .qm-stepper { display: flex; align-items: center; gap: 6px; flex: 1; justify-content: center; }
  .qm-step {
    display: flex; align-items: center; justify-content: center;
    padding: 0; background: none; border: none; cursor: pointer; font-family: inherit;
  }
  .qm-step-dot {
    width: 10px; height: 10px; border-radius: 2px;
    background: var(--og-border); transition: background 0.15s, transform 0.15s;
  }
  .qm-step:hover .qm-step-dot { background: var(--og-text-muted); transform: scale(1.2); }
  .qm-step.active .qm-step-dot { background: var(--og-chat); transform: scale(1.3); }
  .qm-step.done .qm-step-dot.filled { background: var(--og-success); }
  .qm-nav-btns { display: flex; gap: 6px; flex-shrink: 0; }
  .qm-nav-btn {
    padding: 5px 14px; font-size: 12px; cursor: pointer;
    border: 1px solid var(--og-border); background: var(--og-btn-bg);
    color: var(--og-btn-text); border-radius: 3px; font-family: inherit;
  }
  .qm-nav-btn:hover:not(:disabled) { background: var(--og-btn-hover); }
  .qm-nav-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .qm-nav-btn.primary { background: var(--og-chat); color: var(--og-bg); border-color: var(--og-chat); }
  .qm-submit-btn {
    padding: 5px 14px; font-size: 12px; cursor: pointer;
    border: 1px solid var(--og-chat); background: var(--og-chat);
    color: var(--og-surface); border-radius: 3px; font-family: inherit; font-weight: 600;
  }
  .qm-submit-btn:hover { opacity: 0.9; }
</style>