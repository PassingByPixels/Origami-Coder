<script lang="ts">
  interface PlanScoreView {
    feasibility: number;
    specificity: number;
    riskCoverage: number;
    total: number;
    notes: string;
  }

  interface PlanCandidateView {
    index: number;
    title: string;
    planId: string;
    textPreview: string;
    score: PlanScoreView | null;
  }

  interface BestOfNVerdictView {
    winnerIndex: number;
    rationale: string;
    fallback: boolean;
  }

  interface Props {
    planId: string;
    title: string;
    filePath: string;
    status: string;
    revisionCount: number;
    alternatives?: PlanCandidateView[];
    verdict?: BestOfNVerdictView | null;
    onApprove: () => void;
    onReject: () => void;
    onRefine: (feedback: string) => void;
    onSelectAlternative?: (altIndex: number) => void;
    onOpenFile: (path: string) => void;
  }

  let {
    planId,
    title,
    filePath,
    status,
    revisionCount,
    alternatives = [],
    verdict = null,
    onApprove,
    onReject,
    onRefine,
    onSelectAlternative,
    onOpenFile,
  }: Props = $props();

  let showFeedback = $state(false);
  let feedbackText = $state('');
  let activeTab = $state<number | null>(null);

  // When a best-of-N verdict arrives, default the active tab to the
  // live winner so the preview matches the plan the user is about to
  // approve. Users click another tab to diff against the critic's
  // pick, then "Pick this plan instead" to swap.
  $effect(() => {
    if (alternatives.length >= 2 && verdict && activeTab === null) {
      activeTab = verdict.winnerIndex;
    }
  });

  function submitFeedback() {
    if (feedbackText.trim()) {
      onRefine(feedbackText.trim());
      feedbackText = '';
      showFeedback = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitFeedback();
    }
  }

  function selectTab(idx: number) {
    activeTab = idx;
  }

  function pickActiveAlt() {
    if (activeTab === null) return;
    if (!onSelectAlternative) return;
    if (verdict && activeTab === verdict.winnerIndex) return;
    onSelectAlternative(activeTab);
  }

  // R2.2 de-chimera: the V1 loop has no best-of-N producer (no critic
  // round emits scored alternatives), so the alternatives/score tab bar
  // is dead/lying UI in V1. Gate it off behind a constant — the markup +
  // the frozen wire (`origami/planCandidates`) stay for a future producer,
  // they are simply never presented in V1. Flip this to re-enable.
  const V1_SHOW_BEST_OF_N = false;
  const showAlternatives = $derived(V1_SHOW_BEST_OF_N && alternatives.length >= 2);
  const activeCandidate = $derived<PlanCandidateView | null>(
    activeTab !== null
      ? (alternatives.find(a => a.index === activeTab) ?? null)
      : null,
  );
  const activeIsLiveWinner = $derived(
    verdict !== null && activeTab === verdict.winnerIndex,
  );
</script>

<div class="plan-panel">
  <div class="plan-header">
    <span class="plan-icon">&#9776;</span>
    <span class="plan-title">{title}</span>
    {#if revisionCount > 0}
      <span class="plan-badge">{revisionCount} review{revisionCount > 1 ? 's' : ''}</span>
    {/if}
  </div>

  <div class="plan-meta">
    <span class="plan-status">{status}</span>
    <button class="plan-link" onclick={() => onOpenFile(filePath)}>
      View in editor
    </button>
  </div>

  {#if showAlternatives}
    <div class="alt-bar" role="tablist" aria-label="Plan alternatives">
      {#each alternatives as alt (alt.index)}
        {@const isWinner = verdict !== null && alt.index === verdict.winnerIndex}
        {@const isActive = activeTab === alt.index}
        <button
          type="button"
          role="tab"
          class="alt-tab"
          class:active={isActive}
          class:winner={isWinner}
          aria-selected={isActive}
          onclick={() => selectTab(alt.index)}
          title={alt.score ? alt.score.notes : ''}
        >
          <span class="alt-label">
            Plan {String.fromCharCode(65 + alt.index)}
            {#if isWinner}★{/if}
          </span>
          {#if alt.score}
            <span class="alt-score">{alt.score.total}/30</span>
          {:else}
            <span class="alt-score muted">—</span>
          {/if}
        </button>
      {/each}
    </div>
    {#if verdict !== null}
      <div class="alt-rationale">
        <span class="alt-rationale-label">
          {verdict.fallback ? 'Critic fell back' : 'Critic'}:
        </span>
        <span class="alt-rationale-text">{verdict.rationale || '—'}</span>
      </div>
    {/if}
    {#if activeCandidate && !activeIsLiveWinner}
      <div class="alt-preview">
        <div class="alt-preview-head">
          <span class="alt-preview-title">{activeCandidate.title}</span>
          <button type="button" class="plan-btn pick" onclick={pickActiveAlt}>
            Pick this plan instead
          </button>
        </div>
        {#if activeCandidate.textPreview}
          <pre class="alt-preview-body">{activeCandidate.textPreview}</pre>
        {/if}
      </div>
    {/if}
  {/if}

  {#if status === 'awaiting_user' || status === 'presented'}
    <!--
      Wave E.18 — explicit Yes / No / Refine button row matching the
      TUI's Y/N/R message box. The original "Approve & Execute" /
      "Request Changes" / "Reject" labels were verbose; these short
      action verbs read at a glance and pair with the keyboard
      shortcuts the TUI exposes (Y / N / R). The full meaning still
      surfaces via the title attribute on hover.
    -->
    <div class="plan-actions">
      <button
        class="plan-btn approve"
        onclick={onApprove}
        title="Approve and execute the plan"
      >
        Yes
      </button>
      <button
        class="plan-btn reject"
        onclick={onReject}
        title="Reject the plan and stay in plan mode"
      >
        No
      </button>
      <button
        class="plan-btn refine"
        onclick={() => { showFeedback = !showFeedback; }}
        title="Request changes — open an inline feedback box"
      >
        Refine
      </button>
    </div>

    {#if showFeedback}
      <div class="plan-feedback">
        <textarea
          class="plan-feedback-input"
          bind:value={feedbackText}
          onkeydown={handleKeydown}
          placeholder="Describe what you'd like changed..."
          rows="3"
        ></textarea>
        <button class="plan-btn submit" onclick={submitFeedback}>
          Send Feedback
        </button>
      </div>
    {/if}
  {:else if status === 'self_review'}
    <div class="plan-reviewing">
      <span class="plan-spinner"></span>
      Self-reviewing plan (round {revisionCount})...
    </div>
  {/if}
</div>

<style>
  .plan-panel {
    padding: 10px 12px;
    background: var(--og-surface, #1e1e2e);
    border-left: 3px solid var(--og-accent, #89b4fa);
    border-radius: 4px;
    margin: 8px 0;
  }

  .plan-header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    font-size: 13px;
    color: var(--og-text, #cdd6f4);
  }

  .plan-icon {
    font-size: 14px;
    opacity: 0.7;
  }

  .plan-title {
    flex: 1;
  }

  .plan-badge {
    font-size: 11px;
    font-weight: 400;
    background: var(--og-accent, #89b4fa);
    color: var(--og-bg, #1e1e2e);
    padding: 1px 6px;
    border-radius: 8px;
  }

  .plan-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 6px;
    font-size: 11px;
    color: var(--og-muted, #6c7086);
  }

  .plan-status {
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .plan-link {
    background: none;
    border: none;
    color: var(--og-accent, #89b4fa);
    cursor: pointer;
    font-size: 11px;
    text-decoration: underline;
    padding: 0;
  }

  .plan-link:hover {
    color: var(--og-text, #cdd6f4);
  }

  .alt-bar {
    display: flex;
    gap: 4px;
    margin-top: 10px;
    flex-wrap: wrap;
  }

  .alt-tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    font-size: 11px;
    cursor: pointer;
    border: 1px solid var(--og-border, #313244);
    background: var(--og-surface, #1e1e2e);
    color: var(--og-text, #cdd6f4);
    border-radius: 3px;
    font-family: inherit;
  }

  .alt-tab:hover {
    background: var(--og-hover, #313244);
  }

  .alt-tab.active {
    border-color: var(--og-accent, #89b4fa);
    color: var(--og-accent, #89b4fa);
  }

  .alt-tab.winner {
    border-top-color: var(--og-success, #a6e3a1);
    border-top-width: 2px;
  }

  .alt-label {
    font-weight: 600;
  }

  .alt-score {
    font-variant-numeric: tabular-nums;
    color: var(--og-muted, #6c7086);
  }

  .alt-score.muted {
    font-style: italic;
    opacity: 0.6;
  }

  .alt-rationale {
    margin-top: 6px;
    font-size: 11px;
    color: var(--og-muted, #6c7086);
    line-height: 1.35;
  }

  .alt-rationale-label {
    font-weight: 600;
    margin-right: 4px;
  }

  .alt-rationale-text {
    font-style: italic;
  }

  .alt-preview {
    margin-top: 8px;
    padding: 6px 8px;
    background: var(--og-bg, #11111b);
    border: 1px solid var(--og-border, #313244);
    border-radius: 4px;
  }

  .alt-preview-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }

  .alt-preview-title {
    flex: 1;
    font-size: 12px;
    font-weight: 600;
    color: var(--og-text, #cdd6f4);
  }

  .alt-preview-body {
    margin: 0;
    padding: 0;
    font-size: 11px;
    color: var(--og-muted, #6c7086);
    white-space: pre-wrap;
    font-family: var(--vscode-editor-font-family, monospace);
    max-height: 120px;
    overflow: auto;
  }

  .plan-actions {
    display: flex;
    gap: 6px;
    margin-top: 10px;
  }

  .plan-btn {
    padding: 5px 12px;
    border: 1px solid var(--og-border, #313244);
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    background: var(--og-surface, #1e1e2e);
    color: var(--og-text, #cdd6f4);
    transition: background 0.15s, border-color 0.15s;
  }

  .plan-btn:hover {
    background: var(--og-hover, #313244);
  }

  .plan-btn.approve {
    background: var(--og-success-bg, #1a3a2a);
    border-color: var(--og-success, #a6e3a1);
    color: var(--og-success, #a6e3a1);
  }

  .plan-btn.approve:hover {
    background: var(--og-success, #a6e3a1);
    color: var(--og-bg, #1e1e2e);
  }

  .plan-btn.reject {
    color: var(--og-error, #f38ba8);
    border-color: var(--og-error, #f38ba8);
  }

  .plan-btn.reject:hover {
    background: var(--og-error, #f38ba8);
    color: var(--og-bg, #1e1e2e);
  }

  .plan-btn.submit {
    background: var(--og-accent, #89b4fa);
    color: var(--og-bg, #1e1e2e);
    border-color: var(--og-accent, #89b4fa);
  }

  .plan-btn.pick {
    background: var(--og-accent, #89b4fa);
    color: var(--og-bg, #1e1e2e);
    border-color: var(--og-accent, #89b4fa);
    padding: 3px 10px;
    font-size: 11px;
  }

  .plan-btn.pick:hover {
    opacity: 0.9;
  }

  .plan-feedback {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .plan-feedback-input {
    width: 100%;
    padding: 6px 8px;
    background: var(--og-bg, #11111b);
    border: 1px solid var(--og-border, #313244);
    border-radius: 4px;
    color: var(--og-text, #cdd6f4);
    font-size: 12px;
    font-family: inherit;
    resize: vertical;
  }

  .plan-feedback-input::placeholder {
    color: var(--og-muted, #6c7086);
  }

  .plan-reviewing {
    margin-top: 8px;
    font-size: 12px;
    color: var(--og-muted, #6c7086);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .plan-spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid var(--og-border, #313244);
    border-top-color: var(--og-accent, #89b4fa);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
