<script lang="ts">
  // The New-collab draft, EXTRACTED from CollabsList.svelte (418 of its
  // 420-line cap) so flock M4's OBJECTIVE field could land without raising it
  // — the ratchet's own remedy. The markup and its styles came across
  // verbatim; Svelte scopes styles per component, so the rules the form needs
  // live here now rather than being inherited from the half that no longer
  // draws it.
  //
  // TITLE-ONLY IS STILL THE RULE (M3, the Goal 1 fix): there is no roster to
  // pick here, so nothing can race an agent list that has not arrived. The
  // objective joins the title as free text — OPTIONAL, and omitted from the
  // create message entirely when it is blank, because an empty objective and
  // no objective are the same absence and the engine should be told once.
  interface Props {
    /** `objective` is '' when the user left it blank — the caller decides
     *  whether to send the field at all, so this component never invents one. */
    onCreate: (title: string, objective: string) => void;
    onCancel: () => void;
  }
  let { onCreate, onCancel }: Props = $props();

  let title = $state('');
  let objective = $state('');

  function commit() {
    const t = title.trim();
    // An empty title CLOSES the form — there is nothing left to refuse.
    if (!t) { onCancel(); return; }
    onCreate(t, objective.trim());
  }
  /** Enter commits, Escape cancels — the same two keys a chat rename uses, so
   *  there is one text-entry idiom in this panel rather than two. The objective
   *  box is a textarea and deliberately does NOT take Enter: it is prose. */
  function titleKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  }
  function focusOnMount(node: HTMLInputElement) { node.focus(); }
</script>

<div class="collab-new">
  <input
    class="session-rename"
    placeholder="Collab title…"
    bind:value={title}
    use:focusOnMount
    onkeydown={titleKey}
    aria-label="New collab title" />
  <textarea
    class="collab-objective"
    rows="2"
    placeholder="Objective (optional) — what this room is for"
    bind:value={objective}
    onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }}
    aria-label="Collab objective"></textarea>
  <div class="collab-new-actions">
    <button class="chat-action primary" onclick={commit} disabled={!title.trim()}>Create</button>
    <button class="chat-action" onclick={onCancel}>Cancel</button>
  </div>
</div>

<style>
  /* --- carried across from CollabsList.svelte with the markup --- */
  .collab-new { padding: 0 10px 4px; }
  .collab-new-actions { display: flex; gap: 6px; padding: 6px 0 0; }
  .chat-action {
    font-size: 11px;
    padding: 4px 8px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
  }
  .chat-action:hover { border-color: var(--og-chat); color: var(--og-text); }
  .chat-action.primary { color: var(--og-text); border-color: var(--og-chat); }
  .chat-action:disabled { opacity: 0.45; cursor: default; border-color: var(--og-border); }
  .session-rename {
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
    font: inherit;
    font-size: 12px;
    color: var(--og-text);
    background: var(--og-btn-bg);
    border: 1px solid var(--og-accent);
    border-radius: 4px;
    padding: 4px 8px;
    outline: none;
  }
  /* The objective is prose, so it gets a box that admits it — quieter than the
     title's accent border, which is what the eye should land on first. */
  .collab-objective {
    width: 100%;
    margin-top: 4px;
    font: inherit;
    font-size: 11px;
    color: var(--og-text);
    background: var(--og-btn-bg);
    border: 1px solid var(--og-border);
    border-radius: 4px;
    padding: 4px 8px;
    outline: none;
    resize: vertical;
  }
  .collab-objective:focus { border-color: var(--og-accent); }
</style>
