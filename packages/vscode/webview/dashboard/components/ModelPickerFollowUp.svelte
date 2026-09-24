<script lang="ts">
  // t-di2zmm: the follow-up shown IN PLACE of the row just picked for this
  // chat — "also send sub-agents there too?" instead of making the user
  // close, reopen and navigate to the Sub-agents target for the same
  // question. A LEAF: it posts nothing, ModelPicker owns the wire and the
  // decision of when to show it (not shown on passthrough cells, or once the
  // sub-agent model already matches the pick).

  let { modelName, onAlsoForSubagents, onChooseSubagentModel }: {
    modelName: string;
    onAlsoForSubagents: () => void;
    onChooseSubagentModel: () => void;
  } = $props();
</script>

<div class="mp-followup" role="group" aria-label="Sub-agent model for {modelName}">
  <span class="mp-followup-label">{modelName} set for this chat.</span>
  <button class="mp-followup-btn" onclick={onAlsoForSubagents}>Also use for sub-agents</button>
  <button class="mp-followup-btn" onclick={onChooseSubagentModel}>Choose a sub-agent model…</button>
</div>

<style>
  .mp-followup {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    font-size: 10px;
    background: var(--og-btn-bg);
    border: 1px solid var(--og-border);
    border-radius: 5px;
  }
  .mp-followup-label { color: var(--og-text-muted); flex: 1 1 100%; }
  .mp-followup-btn {
    padding: 3px 7px;
    font-size: 10px;
    font-family: inherit;
    color: var(--og-text-secondary);
    background: var(--og-input-bg);
    border: 1px solid var(--og-border);
    border-radius: 4px;
    cursor: pointer;
  }
  .mp-followup-btn:hover { color: var(--og-text); border-color: var(--og-accent); }
</style>
