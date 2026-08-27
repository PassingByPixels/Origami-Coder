<script lang="ts">
  // Triage's capture (contract §11.2), now behind a "+" (§12.2): the BOARD owns
  // the collapsed affordance and mounts this expanded, so the title takes focus
  // on mount and Escape / Add hand control back through `oncollapse`.
  import QuickAddFields from './QuickAddFields.svelte';
  import { buildQuickAddTicket } from '../lib/quickAddTicket';

  interface Props {
    root: string;
    post: (msg: Record<string, unknown>) => void;
    oncollapse: () => void;
  }
  let { root, post, oncollapse }: Props = $props();

  // The draft lives HERE, not in the fields: the Add button reads the title to
  // know if it is enabled and the acceptance to know which column it will land
  // in, and a collapse must drop the lot with the form.
  let title = $state('');
  let body = $state('');
  let priority = $state('normal');
  let labels = $state('');
  let acceptance = $state('');

  function add(): void {
    const msg = buildQuickAddTicket({ root, title, body, priority, labels, acceptance });
    if (!msg) return; // a body with no title is not a ticket
    post(msg);
    oncollapse();
  }
  // Escape COLLAPSES instead of reaching the board's own Escape (which closes the
  // popover / editor) — the half-typed fields go with the form. Every other key
  // is you typing, so the board's '/' and 'n' shortcuts must not see it either.
  function onKey(e: KeyboardEvent, submits: boolean): void {
    e.stopPropagation();
    if (e.key === 'Escape') { oncollapse(); return; }
    if (submits && e.key === 'Enter') { e.preventDefault(); add(); }
  }
</script>

<div class="am-qa">
  <QuickAddFields bind:title bind:body bind:priority bind:labels bind:acceptance onkey={onKey} />

  <button class="am-qa-add" onclick={add} disabled={!title.trim()}
    title={acceptance.trim() ? 'Create this ticket in Todo (has acceptance criteria)' : 'Create this ticket in Triage'}>
    Add
  </button>
</div>

<style>
  .am-qa { display: flex; flex-direction: column; gap: 4px; flex: none; }
  .am-qa-add {
    align-self: flex-end; padding: 2px 9px; font-size: 11px; cursor: pointer;
    background: var(--og-surface, rgba(255, 255, 255, 0.06)); color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.12)); border-radius: 4px;
  }
  .am-qa-add:hover:not(:disabled) { filter: brightness(1.2); }
  .am-qa-add:disabled { opacity: 0.45; cursor: default; }
</style>
