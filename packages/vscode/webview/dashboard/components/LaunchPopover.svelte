<script lang="ts">
  // Launching a Todo ticket (contract §6) — the ONLY place an agent type and a
  // model are chosen on this board. Everything else about the run comes from the
  // ticket file itself (title, body, acceptance), so this asks the two questions
  // the file cannot answer and gets out of the way.
  //
  // "Race models" fans the SAME ticket across up to four (agent, model) variants;
  // every sibling carries the ticket id, so the board still shows one race, one
  // ticket. Start runs now; Queue provisions the worktree and waits.
  //
  // SPEC mode (contract §11.3) reuses this picker for a different job: no
  // worktree, no race, no queue — just the agent and the model that will sit in a
  // chat with you and write the ticket's acceptance. A second near-identical
  // popover would only drift from this one.
  import AgentModelSelect from './AgentModelSelect.svelte';
  import AgentTypeSelect from './AgentTypeSelect.svelte';
  import type { RepoBoard, TicketRow } from './boardBuckets';

  interface ModelOpt { value: string; name: string; configured?: boolean; }
  interface ProviderStat { id: string; name: string; live: boolean; flavor?: 'lmstudio' | 'ollama' | 'other'; }

  interface Props {
    repo: RepoBoard;
    ticket: TicketRow;
    anchor: { top: number; bottom: number; left: number };
    agentTypes: Array<{ id: string; name: string }>;
    modelOptions: ModelOpt[];
    providerStatus: ProviderStat[];
    /** 'spec' = the §11.3 picker: agent + model only, one button, no worktree. */
    mode?: 'launch' | 'spec';
    post: (msg: Record<string, unknown>) => void;
    onclose: () => void;
  }
  let { repo, ticket, anchor, agentTypes, modelOptions, providerStatus, mode = 'launch', post, onclose }: Props = $props();

  let agent = $state('tsuru');
  let model = $state('');
  let raceMode = $state(false);
  let variantModels = $state<string[]>(['', '']);
  let variantAgents = $state<string[]>(['tsuru', 'tsuru']);

  // Anchored under the opening card, NEVER centred (contract §12.1): a `transform`
  // here makes descendants' `position: fixed` resolve against THIS box instead of
  // the viewport — that threw the model menu into a far corner. Viewport px, on open.
  const GAP = 6;
  let el = $state<HTMLDivElement>();
  let pos = $state({ top: 0, left: 0 });
  $effect(() => {
    void raceMode; void variantModels.length; // re-place after Race/variants grow the box — a low card would push Start off-screen
    const box = el?.getBoundingClientRect(), w = box?.width || 380, h = box?.height || 0;
    const top = anchor.bottom + GAP + h <= window.innerHeight - GAP ? anchor.bottom + GAP : Math.max(GAP, anchor.top - GAP - h);
    pos = { top, left: Math.max(GAP, Math.min(anchor.left, window.innerWidth - w - GAP)) };
  });

  let spec = $derived(mode === 'spec');
  // A blank variant resolves to the repo default at run time (run.ts
  // effectiveModel), so its leading option must say which default it means.
  let leadLabel = $derived(repo.defaultModel ? 'Repo default' : 'Engine default');
  // fanout.ts dedupes identical (agent, EFFECTIVE model) pairs and refuses what
  // is left if fewer than two survive. Say that here — the alternative is a
  // Start that comes back as an error banner for a rule the form never showed.
  let dupes = $derived(
    new Set(variantModels.map((m, i) => `${variantAgents[i] ?? 'tsuru'} ${m || repo.defaultModel}`)).size
      < variantModels.length,
  );

  function launch(start: boolean): void {
    if (spec) {
      post({ type: 'amTicketSpec', root: repo.root, id: ticket.id, agentName: agent, model });
      onclose();
      return;
    }
    if (raceMode) {
      const variants = variantModels.map((m, i) => ({ agentName: variantAgents[i] ?? 'tsuru', model: m }));
      post({ type: 'amTicketLaunch', root: repo.root, id: ticket.id, start, variants });
    } else {
      post({ type: 'amTicketLaunch', root: repo.root, id: ticket.id, agentName: agent, model, start });
    }
    onclose();
  }
</script>

<div class="am-launch-back" role="presentation" onclick={onclose}></div>
<div class="am-launch" role="dialog" aria-label={spec ? 'Spec ticket' : 'Launch ticket'}
  bind:this={el} style="top: {pos.top}px; left: {pos.left}px">
  <div class="am-launch-head">
    <span class="am-launch-id">{ticket.id.toUpperCase()}</span>
    <span class="am-launch-title">{ticket.title}</span>
  </div>

  <label>
    <span>Agent</span>
    <AgentTypeSelect agentTypes={agentTypes} value={agent} onchange={(v) => (agent = v)} />
  </label>
  {#if !spec}
    <label class="am-race">
      <span>Race</span>
      <span class="am-race-ctl">
        <input type="checkbox" bind:checked={raceMode} aria-label="Race models" />
        <span class="am-race-hint">race this ticket across up to 4 models</span>
      </span>
    </label>
  {/if}

  {#if !raceMode}
    <label>
      <span>Model</span>
      <AgentModelSelect options={modelOptions} providerStatus={providerStatus}
        value={model} onchange={(v) => (model = v)}
        leading={[{ value: '', label: leadLabel }]} placeholder="Model" />
    </label>
  {:else}
    <div class="am-variants">
      {#each variantModels as _v, i (i)}
        <div class="am-variant-row">
          <span class="am-variant-n">{i + 1}</span>
          <AgentTypeSelect agentTypes={agentTypes} value={variantAgents[i] ?? 'tsuru'}
            onchange={(v) => (variantAgents = variantAgents.map((x, j) => (j === i ? v : x)))} />
          <AgentModelSelect options={modelOptions} providerStatus={providerStatus}
            value={variantModels[i]} onchange={(v) => (variantModels = variantModels.map((x, j) => (j === i ? v : x)))}
            leading={[{ value: '', label: leadLabel }]} placeholder="Model" />
          {#if variantModels.length > 2}
            <button class="am-variant-x" title="Remove this variant" aria-label="Remove this variant"
              onclick={() => { variantModels = variantModels.filter((_, j) => j !== i); variantAgents = variantAgents.filter((_, j) => j !== i); }}>✕</button>
          {/if}
        </div>
      {/each}
      {#if variantModels.length < 4}
        <button class="am-add-variant" onclick={() => { variantModels = [...variantModels, '']; variantAgents = [...variantAgents, 'tsuru']; }}>+ variant</button>
      {/if}
      {#if dupes}
        <div class="am-race-dupe">two rows name the same agent + model — identical variants collapse, and a race needs 2 that differ</div>
      {/if}
    </div>
  {/if}

  <div class="am-launch-actions">
    <button class="am-btn primary" onclick={() => launch(true)}>{spec ? 'Spec in chat' : 'Start'}</button>
    {#if !spec}
      <button class="am-btn" title="Provision the worktree now and run the ticket later"
        onclick={() => launch(false)}>Queue</button>
    {/if}
    <button class="am-btn" onclick={onclose}>Cancel</button>
  </div>
</div>

<style>
  .am-launch-back { position: fixed; inset: 0; z-index: 40; }
  .am-launch {
    position: fixed; z-index: 41;
    width: 380px; max-width: 92vw; padding: 12px;
    display: flex; flex-direction: column; gap: 8px;
    background: var(--og-bg, #1e1e1e); color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.18)); border-radius: 8px;
  }
  .am-launch-head { display: flex; align-items: baseline; gap: 6px; font-size: 12px; }
  .am-launch-id { font-family: var(--vscode-editor-font-family, monospace); opacity: 0.7; font-size: 10px; }
  .am-launch-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .am-launch label { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
  .am-launch label span { min-width: 44px; opacity: 0.75; }
  /* The Race row reads as a CONTROL, not as another dim field label: UAT round 1
     reported the variants feature as removed because this line looked like help
     text sitting between two selects. */
  .am-launch label.am-race {
    align-items: center; padding: 6px 0;
    border-top: 1px solid var(--og-border, rgba(255, 255, 255, 0.12));
    border-bottom: 1px solid var(--og-border, rgba(255, 255, 255, 0.12));
  }
  .am-launch label.am-race > span:first-child { opacity: 1; font-weight: 600; }
  .am-race-ctl { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
  .am-race-ctl input { flex: none; }
  .am-race-hint { font-size: 11px; opacity: 0.7; }
  .am-race-dupe { font-size: 10px; color: #e6a23c; line-height: 1.35; }
  .am-variants { display: flex; flex-direction: column; gap: 6px; }
  .am-variant-row { display: flex; align-items: center; gap: 6px; }
  .am-variant-n { width: 14px; flex: none; text-align: center; opacity: 0.6; font-size: 11px; }
  .am-variant-x {
    flex: none; padding: 0 4px; cursor: pointer; color: #ff9d9d;
    background: transparent; border: 1px solid transparent; border-radius: 4px;
  }
  .am-add-variant {
    align-self: flex-start; padding: 2px 8px; font-size: 11px; cursor: pointer;
    background: var(--og-surface, rgba(255, 255, 255, 0.06)); color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.12)); border-radius: 4px;
  }
  .am-launch-actions { display: flex; gap: 6px; margin-top: 2px; }
  .am-btn {
    padding: 3px 9px; font-size: 12px; cursor: pointer; white-space: nowrap;
    background: var(--og-surface, rgba(255, 255, 255, 0.06)); color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.12)); border-radius: 4px;
  }
  .am-btn:hover { filter: brightness(1.2); }
  .am-btn.primary { background: var(--og-accent, #3b6ea5); border-color: transparent; }
</style>
