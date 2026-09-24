<script lang="ts">
  // SpendBadge.svelte — the composer's ONE funding readout, and the decision
  // about which kind of readout is honest for this chat.
  //
  // Extracted out of InputBar.svelte (1199 of a 1200-line cap) when the Claude
  // Code passthrough proved the badge had been answering the wrong question.
  // The engine bills an API key, so "$0.3160" is money. A passthrough child
  // authenticates from ~/.claude against the user's PLAN — `system/init`
  // reports `apiKeySource: "none"` — and the CLI's `total_cost_usd` is then the
  // API-equivalent list price of a turn the month already paid for. Rendering
  // it as spend invents a bill that will never arrive.
  //
  // So the slot holds the dollar figure on an API key, and NOTHING on a plan.
  //
  // PHASE 2 MOVED THE HEADROOM HALF OUT. This badge used to also draw the
  // plan's own "7d 90%" here. That readout answers "am I burning my
  // subscription", which is the question the OAuth providers already answer in
  // the MODEL PICKER's usage slot, in the house wording ("92% used · resets in
  // 3d 4h") — so the Claude plan's headroom went there too (ModelPicker.svelte
  // `ccUsageText`, formatted by passthroughUsagePill.ts). Two badges saying the
  // same thing in one bar made the user look in two places, and this one also
  // sat behind `{#if modelOnline && modelName}` in InputBar, so on a passthrough
  // cell with no engine model name it never rendered at all.
  //
  // What stays here is the DECISION, which was always the point of the split:
  // a plan must never be shown a dollar figure, because `total_cost_usd` on a
  // subscription is the API-equivalent list price of something already paid for.
  //
  // `subscription` alone only ever covered the Claude Code passthrough. A
  // chat run on the ENGINE's own native OAuth/flat-rate connections (Copilot,
  // ChatGPT, Grok, opencode-go) hits the same defect — Copilot's models carry
  // list prices, so `sessionCost` reads real dollars for a plan — and billing.ts
  // is that second, general half of the same decision (providerId + authKind).
  import { fmtUsd } from '../lib/money';
  import { isPerTokenBilled, type AuthKind } from './billing';

  let { totalCost = 0, subagentCost = 0, subscription = false, providerId = '', authKind = 'unknown' }: {
    /** This chat plus its sub-agents, in USD. */
    totalCost?: number;
    /** The sub-agent half of `totalCost` — named in the tooltip, because "why
     *  did that jump" is answered by the split, not by the sum. */
    subagentCost?: number;
    /** This cell is funded by a PLAN (Claude Code passthrough), so no dollar figure may be shown. */
    subscription?: boolean;
    /** This session's raw provider id (e.g. "github-copilot"), for billing.ts. */
    providerId?: string;
    /** How that connection authenticates — see billing.ts. */
    authKind?: AuthKind;
  } = $props();

  let showCost = $derived(!subscription && isPerTokenBilled(providerId, authKind) && totalCost > 0);
  let costTitle = $derived(subagentCost > 0
    ? `${fmtUsd(totalCost)} (+${fmtUsd(subagentCost)} subagents) — this chat plus the sub-agents it spawned. Type /spend for this month's total across all chats.`
    : `This chat's cost so far. Local models are free; OpenRouter accrues. Type /spend for this month's total across all chats.`);
</script>

{#if showCost}
  <span class="ctx-sep">&middot;</span>
  <span class="cost" title={costTitle}>{fmtUsd(totalCost)}</span>
{/if}

<style>
  /* Mirrors InputBar's own separator: Svelte scopes styles per component, so a
     leaf that draws one has to declare it. */
  .ctx-sep {
    font-size: 10px;
    color: var(--og-text-muted);
  }
  /* Per-chat cost readout — money, so a touch more presence than the muted tps. */
  .cost {
    font-size: 10px;
    font-weight: 600;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-secondary);
    cursor: help;
  }
</style>
