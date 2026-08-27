<script lang="ts">
  // WHAT a cron runs as — the agent it adopts and the model it burns. Split out
  // of CronForm.svelte when the model went from a free-text box to a real
  // picker plus the warning below it, which put that file over its cap.
  //
  // THE WARNING IS THE POINT OF THIS FILE. There is no "workspace default"
  // model for a scheduled run. `origami run` with no `--model`
  // (vscode/src/dashboard/crons/cronCommand.ts, runInvocation) leaves the
  // choice to the engine, and the engine resolves it in this order
  // (engine/src/provider/provider.ts, Provider.defaultModel):
  //
  //   1. `model` in origami.json, if it is set;
  //   2. otherwise the FIRST STILL-RESOLVABLE ENTRY of the machine-wide
  //      recent-models list in ~/.local/state/origami/model.json — i.e. the
  //      last model picked in any chat, in any workspace, on this computer;
  //   3. otherwise the first model of the first configured provider.
  //
  // Step 2 is the one that costs money at 3am. It is not a property of this
  // cron, this repo or this pane; it is a file that anything can move. So the
  // form refuses to create a job without a pinned model, and says why here
  // rather than in a tooltip nobody opens.
  import AgentModelSelect from './AgentModelSelect.svelte';

  interface ModelOpt { value: string; name: string }
  interface ProviderStat { id: string; name: string; live: boolean; flavor?: 'lmstudio' | 'ollama' | 'other' }

  let { agent = $bindable(''), model = $bindable(''), modelOptions = [], providerStatus = [] }: {
    agent: string;
    model: string;
    modelOptions?: ModelOpt[];
    providerStatus?: ProviderStat[];
  } = $props();
</script>

<div class="crt-row">
  <input class="crt-input" placeholder="Agent (optional)" bind:value={agent} />
  <AgentModelSelect options={modelOptions} {providerStatus} value={model}
    onchange={(v) => { model = v; }} placeholder="Model (required)" compact />
</div>
{#if !model}
  <div class="crt-warn">
    <strong>Pick a model.</strong> Unset is not "the default" — this job would run on whatever model was
    used last on this machine (or the first one configured), which is nobody's decision and can be the
    priciest one installed.
    {#if modelOptions.length === 0}
      No models are listed yet: open a chat so the engine can report its catalog, then reopen this form.
    {/if}
  </div>
{/if}

<style>
  .crt-row { display: flex; gap: 6px; align-items: stretch; }
  .crt-input { background: var(--og-input-bg); border: 1px solid var(--og-input-border); color: var(--og-text); border-radius: 4px; padding: 4px 6px; font-size: 11px; font-family: inherit; flex: 1; min-width: 0; }
  /* Warning tones, not error: nothing has gone wrong yet — this is the state
     the form is stopping you from committing to. */
  .crt-warn { color: var(--og-warning-text); background: var(--og-warning-soft); border: 1px solid var(--og-warning); border-radius: 4px; padding: 5px 7px; font-size: 10px; line-height: 1.45; }
</style>
