<script lang="ts">
  // The capture's input surface, split out of QuickAdd when Triage's one-field
  // box (contract §11.2) grew to five. It is the boxes and nothing else — the
  // shell keeps the state, the submit and the keyboard rule. All five came out
  // together because ONE rule dresses the title, tasks and acceptance boxes as
  // a family; cutting the title away from the other two would have split that
  // rule into two scoped copies with nothing to keep them in step.
  import { quickAddRows } from '../lib/quickAddTicket';

  interface Props {
    title: string;
    body: string;
    priority: string;
    labels: string;
    acceptance: string;
    /** The shell's key rule. `submits` is true for the title alone, so Enter
     *  in any other box is still a newline. */
    onkey: (e: KeyboardEvent, submits: boolean) => void;
  }
  let {
    title = $bindable(),
    body = $bindable(),
    priority = $bindable(),
    labels = $bindable(),
    acceptance = $bindable(),
    onkey,
  }: Props = $props();

  let rows = $derived(quickAddRows(body));
  const focusNow = (node: HTMLInputElement): void => node.focus();
</script>

<input class="am-quickadd" type="text" bind:value={title} onkeydown={(e) => onkey(e, true)}
  use:focusNow placeholder="Title" spellcheck="false" aria-label="Add a ticket" />
<textarea class="am-qa-tasks" bind:value={body} onkeydown={(e) => onkey(e, false)} rows={rows}
  placeholder="Tasks — one per line (optional)" spellcheck="false" aria-label="Tasks for this ticket"></textarea>

<div class="am-qa-mid">
  <select class="am-qa-prio" bind:value={priority} aria-label="Priority">
    <option value="low">low</option>
    <option value="normal">normal</option>
    <option value="high">high</option>
  </select>
  <input class="am-qa-labels" type="text" bind:value={labels}
    placeholder="Labels (optional)" spellcheck="false" aria-label="Labels (comma-separated)" />
</div>

<textarea class="am-qa-acc" bind:value={acceptance} rows={2}
  placeholder="Acceptance — one criterion per line (optional)" spellcheck="false"
  aria-label="Acceptance criteria (one per line)"></textarea>

<style>
  .am-quickadd, .am-qa-tasks, .am-qa-acc {
    background: var(--og-bg); color: var(--og-text); font: inherit; font-size: 11px;
    border: 1px dashed var(--og-border, rgba(255, 255, 255, 0.18)); border-radius: 6px;
    padding: 5px 8px; resize: none;
  }
  .am-quickadd:focus, .am-qa-tasks:focus, .am-qa-acc:focus {
    border-style: solid; border-color: var(--og-accent, #3b6ea5); outline: none;
  }
  .am-qa-mid { display: flex; gap: 4px; }
  .am-qa-prio {
    background: var(--og-bg); color: var(--og-text); font: inherit; font-size: 11px;
    border: 1px solid var(--og-border, rgba(255,255,255,0.12)); border-radius: 4px;
    padding: 3px 4px; flex: none; width: 64px;
  }
  .am-qa-prio:focus { border-color: var(--og-accent, #3b6ea5); outline: none; }
  .am-qa-labels {
    background: var(--og-bg); color: var(--og-text); font: inherit; font-size: 11px;
    border: 1px dashed var(--og-border, rgba(255,255,255,0.18)); border-radius: 4px;
    padding: 3px 6px; flex: 1;
  }
  .am-qa-labels:focus { border-style: solid; border-color: var(--og-accent, #3b6ea5); outline: none; }
</style>
