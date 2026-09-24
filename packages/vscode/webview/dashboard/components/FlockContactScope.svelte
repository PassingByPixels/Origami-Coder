<script lang="ts">
  // ONE CONTACT'S OWN PERMISSIONS, WHERE THE OWNER IS ALREADY LOOKING AT THEM.
  //
  // This was a fold at the bottom of the Permissions chip, headed by "N of M
  // contacts override the defaults" — a decision about ONE person filed in the
  // panel about EVERYONE. The owner reaches it when they are reading that
  // person's thread, so it hangs off the Edit control in that thread's head.
  //
  // TICK PILLS, NOT A SECOND CHECKLIST. Every known repo, wiki folder and
  // folder is one overlaid set with the desk's defaults and this contact's
  // own — the same look as the bots page's tool grid (FlockScopePills.svelte
  // copies `.bc-tool`), so a `default` tag says which ticks came from the
  // desk and a dashed edge says which ones somebody decided for this person
  // alone. Clicking a pill ADDS or REDUCES for this contact only; Browse…
  // adds a folder that is theirs and not the desk's. contactScope.ts owns
  // that arithmetic and is tested as values, because jsdom cannot see a mark.
  //
  // RESET TO DEFAULT clears all three overrides — scope, auto-answer and
  // budget — because "reset" that left one of them behind is the reason the
  // owner would then have to go looking for the other two. It is hidden when
  // there is nothing to reset.
  //
  // THE RENAME IS STILL HERE. Edit used to be the rename and nothing else, and
  // losing it in a redesign of the same control would be a feature deleted by
  // accident. It is seeded EMPTY, never with the name they declared: pre-filling
  // and saving would pin a label identical to the one it fell back to, and the
  // row would look edited when nothing had been decided.
  import FlockScopePills from './FlockScopePills.svelte';
  import { autoPill, overridden, scopePills, toggledScope } from '../panes/contactScope';
  import type { ContactEdit } from '../panes/contactScope';

  interface Props extends ContactEdit {
    handle: string;
    /** What the thread head calls them, for the rename box's placeholder. */
    name: string;
    onclose: () => void;
  }
  let { handle, name, flock, picked, options, onpost, onclose }: Props = $props();

  let draft = $state('');
  let budgetDraft: string | null = $state(null);
  let appliedPick = $state(0);

  let friend = $derived(flock.friends.find((row) => row.handle === handle));
  let desk = $derived(flock.frontDesk.scope);
  let pills = $derived(scopePills(friend, desk, options));
  let auto = $derived(autoPill(friend, flock.frontDesk.autoAnswer === true));
  let resettable = $derived(overridden(friend));

  const policy = (patch: Record<string, unknown>) => onpost({ type: 'flockSetPolicy', handle, ...patch });

  // A folder browsed FOR this contact, never one browsed for the defaults —
  // `target` is what tells the two pickers apart now that both are on screen.
  $effect(() => {
    if (!picked || picked.nonce === appliedPick || picked.target !== handle) return;
    appliedPick = picked.nonce;
    policy({ scope: toggledScope(friend, desk, picked.kind, picked.path) });
  });

  function commitBudget(): void {
    const raw = (budgetDraft ?? '').trim();
    budgetDraft = null;
    if (raw === '') return policy({ dailyBudgetTokens: null });
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) policy({ dailyBudgetTokens: Math.round(value) });
  }
</script>

<div class="cs" data-contact-scope={handle}>
  <div class="cs-row">
    <span class="fk-caps">Your name for them</span>
    <input
      class="fk-inp"
      aria-label={`Your name for ${name}`}
      placeholder={`${name} (their own name)`}
      bind:value={draft}
      onkeydown={(e) => { if (e.key === 'Enter') { onclose(); policy({ displayName: draft.trim() || null }); } }}
    />
    <button class="fk-btn primary" onclick={() => { onclose(); policy({ displayName: draft.trim() || null }); }}
      >Save name</button
    >
  </div>

  <label class="fk-tick cs-auto" class:picked={auto.on} class:differs={auto.differs}>
    <input
      type="checkbox"
      checked={auto.on}
      onchange={() => policy({ autoAnswer: auto.on ? false : true })}
    />
    <span>Answer without asking</span>
    {#if !auto.differs}<span class="fk-tag">default</span>{/if}
  </label>

  <FlockScopePills
    {pills}
    onbrowse={() => onpost({ type: 'flockBrowseFolder', kind: 'folders', target: handle })}
    ontoggle={(kind, value) => policy({ scope: toggledScope(friend, desk, kind, value) })}
  />

  <div class="cs-row">
    <span class="fk-caps">Daily budget</span>
    <input
      class="fk-inp budget"
      inputmode="numeric"
      placeholder={flock.frontDesk.dailyBudgetTokens === undefined
        ? 'no cap'
        : `${flock.frontDesk.dailyBudgetTokens} (default)`}
      aria-label={`Daily token budget for ${name}`}
      value={budgetDraft ?? (friend?.policy.dailyBudgetTokens === undefined ? '' : String(friend.policy.dailyBudgetTokens))}
      oninput={(e) => (budgetDraft = e.currentTarget.value)}
      onblur={commitBudget}
      onkeydown={(e) => { if (e.key === 'Enter') commitBudget(); }}
    />
    {#if resettable}
      <button class="fk-btn" onclick={() => policy({ scope: null, autoAnswer: null, dailyBudgetTokens: null })}
        >Reset to default</button
      >
    {:else}
      <span class="fk-muted">Following every default.</span>
    {/if}
    <button class="fk-btn" onclick={onclose}>Close</button>
  </div>
</div>

<style>
  /* ABSOLUTE, anchored to the thread head: the head is a wrapping flex row and
     an in-flow panel would push the composer and the whole thread down every
     time the owner opened it. `right: 0` so it hangs under Edit/Revoke rather
     than off the pane's right edge, and a max-width so a long folder path
     cannot make it wider than the column it belongs to. */
  .cs {
    position: absolute; top: 100%; right: 8px; z-index: 5; width: max-content; max-width: min(420px, calc(100% - 16px));
    display: flex; flex-direction: column; gap: 8px; padding: 12px; margin-top: 4px;
    background: var(--og-surface-alt); border: 1px solid var(--og-accent-2); border-radius: 6px;
  }
  .cs-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .cs-row .fk-inp { flex: 1; min-width: 120px; }
  /* 16ch, not 12: the PLACEHOLDER is the desk default plus the word default,
     and a box that ellipses it hides which number is being inherited. */
  .cs-row .budget { flex: 0 0 16ch; min-width: 0; }
  /* The lone "Answer without asking" pill, same look as FlockScopePills.svelte
     draws its groups in — a Svelte scoped style cannot reach across files, so
     this is the same handful of rules rather than a shared import. */
  .cs-auto { align-self: flex-start; }
  .fk-tick {
    display: flex; align-items: center; gap: 4px; font-size: 10px; padding: 2px 7px 2px 5px;
    background: transparent; color: var(--og-text-secondary); border: 1px solid var(--og-border);
    border-radius: 8px; cursor: pointer; font-family: var(--vscode-editor-font-family, monospace);
  }
  .fk-tick.picked { color: var(--og-text); border-color: var(--og-accent); background: color-mix(in srgb, var(--og-accent) 18%, transparent); }
  .fk-tick.differs { border-color: var(--og-accent-2); border-style: dashed; }
  .fk-tick input { margin: 0; }
  .fk-tag { margin-left: 2px; opacity: 0.6; font-style: italic; }
</style>
