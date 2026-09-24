<script lang="ts">
  // THE SUB-AGENT LEDGER (t-f1j2y3) — one sheet answering "who has what".
  // Replaces SubagentToolsTable.svelte, which ran the axes the other way round:
  // agents down, tools across, and a tool name read sideways in a rotated
  // header. Tools are the long list and the thing being searched for, so tools
  // are the ROWS; agents are eight-ish columns that fit across a pane.
  //
  // Column one is the tool and its description, column two is the WORKSPACE
  // state (the same setting the card pill writes — the reference every agent
  // cell is read against), then one column per sub-agent type.
  //
  // WHY A GLYPH PER CELL AND A WORD ON THE CARD. The old table said "On/Def/Off"
  // in every cell, which at agents x tools is a page of shouting words. A cell
  // here is a dot, and the state is carried by SHAPE as well as fill — filled
  // disc, ring, bar, dashed ring — so it never depends on colour alone in any
  // of the five themes. The words are in the legend, pinned in the header row
  // beside "Tool" so they stay on screen while the sheet scrolls, and in every
  // cell's title.
  //
  // All arithmetic — grouping, the counts, the lock rules, the cycle — is
  // ledgerRows.ts. This file is markup and CSS.
  import {
    groupBySource, workspaceState, cellState, cellLock, workspaceLock,
    nextState, type LedgerAgent, type LedgerTool, type LedgerState,
  } from './ledgerRows';
  import { resetAllBody, resetColumnBody } from './ledgerResetCopy';
  import ConfirmModal from '../components/ConfirmModal.svelte';
  import LedgerColumnHead from './LedgerColumnHead.svelte';

  let { rows, tools, onPick, onColumn, onRowAll, onWorkspace, onResetColumn, onResetAll }: {
    rows: LedgerAgent[];
    /** The pane's own (filtered) tool list, in its order. */
    tools: LedgerTool[];
    onPick: (agent: string, id: string, next: LedgerState) => void;
    onColumn: (agent: string, next: LedgerState) => void;
    onRowAll: (id: string) => void;
    onWorkspace: (tool: LedgerTool, next: LedgerState) => void;
    /** One agent back on its definition's values — the column header's menu,
     *  confirmed here too (t-fisfs5 R5). */
    onResetColumn: (agent: string) => void;
    /** Every agent at once. Confirmed here first: it drops overrides across the
     *  whole sheet, and nothing in the webview can put them back. */
    onResetAll: () => void;
  } = $props();

  const FULL: Record<LedgerState, string> = { loaded: 'Loaded', deferred: 'Deferred', off: 'Off' };
  let groups = $derived(groupBySource(tools));
  let confirmReset = $state(false);
  let confirmColumn = $state<string | null>(null); // the column awaiting a confirm
  /** The description on ONE line for the title, so a tooltip is not a wall. */
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

  function resetAll(): void {
    confirmReset = false;
    onResetAll();
  }
  function resetColumn(): void {
    const agent = confirmColumn; confirmColumn = null; if (agent) onResetColumn(agent);
  }
</script>

<div class="lg-card">
  <div class="lg-head">
    <span class="lg-title">Sub-agents</span>
    <span class="lg-count">{rows.length} type{rows.length === 1 ? '' : 's'} · {tools.length} tool{tools.length === 1 ? '' : 's'}</span>
    <button class="lg-reset-all" title="Remove every override this sheet wrote, for every agent"
      onclick={() => (confirmReset = true)}>Reset all to defaults</button>
  </div>
  {#if rows.length === 0}
    <div class="lg-empty">The engine reported no sub-agent types.</div>
  {:else}
    <div class="lg-scroll">
      <table class="lg-table">
        <thead>
          <tr>
            <th class="lg-tool-h" scope="col">
              <span class="lg-h-name">Tool</span>
              <span class="lg-legend">
                <span><i class="lg-dot loaded"></i>Loaded</span>
                <span><i class="lg-dot deferred"></i>Deferred</span>
                <span><i class="lg-dot off"></i>Off</span>
                <span><i class="lg-dot locked"></i>Locked</span>
              </span>
            </th>
            <th class="lg-ws-h" scope="col" title="The tool's own state, from the Main agent view">Workspace</th>
            {#each rows as row (row.agent)}
              <th class="lg-agent-h" scope="col">
                <LedgerColumnHead {row} {tools} onColumn={(agent, next) => { if (next) onColumn(agent, next); }}
                  onReset={(agent) => (confirmColumn = agent)} />
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each groups as group (group.source)}
            <tr class="lg-group"><td colspan={rows.length + 2}>{group.label}</td></tr>
            {#each group.tools as tool (tool.id)}
              {@const ws = workspaceState(tool)}
              {@const wsLock = workspaceLock(tool)}
              <tr>
                <td class="lg-tool">
                  <div class="lg-name">
                    <span class="lg-id" title={tool.id}>{tool.id}</span>
                    <button class="lg-all" title={`Set ${tool.id} for every agent to its workspace state (${FULL[ws]})`}
                      onclick={() => onRowAll(tool.id)}>→ all agents</button>
                  </div>
                  {#if tool.description}
                    <div class="lg-desc lg-clamp" title={oneLine(tool.description)}>{oneLine(tool.description)}</div>
                  {/if}
                </td>
                <td class="lg-cell lg-ws">
                  <button class="lg-cellbtn" disabled={wsLock !== null}
                    title={wsLock ?? `Workspace · ${tool.id}: ${FULL[ws]} — click for ${FULL[nextState(ws)]}`}
                    onclick={() => { if (!wsLock) onWorkspace(tool, nextState(ws)); }}
                  ><i class="lg-dot {wsLock ? 'locked' : ws}"></i></button>
                </td>
                {#each rows as row (row.agent)}
                  {@const state = cellState(row, tool.id)}
                  {@const lock = cellLock(tool, state, row)}
                  <td class="lg-cell">
                    <button class="lg-cellbtn" disabled={lock !== null}
                      title={lock ?? `${row.agent} · ${tool.id}: ${FULL[state]} — click for ${FULL[nextState(state)]}`}
                      onclick={() => { if (!lock) onPick(row.agent, tool.id, nextState(state)); }}
                    ><i class="lg-dot {lock ? 'locked' : state}"></i></button>
                  </td>
                {/each}
              </tr>
            {/each}
          {/each}
        </tbody>
      </table>
    </div>
    <div class="lg-note">
      A cell is what this agent type would get if <code>task</code> spawned it now. Changes are written to that
      agent's block in the global <code>origami.json</code> — <strong>reload the window</strong> to apply them.
    </div>
  {/if}
</div>

<ConfirmModal
  open={confirmReset}
  title="Reset every sub-agent to defaults?"
  body={resetAllBody()}
  confirmLabel="Reset all"
  icon="↺"
  tone="warning"
  onConfirm={resetAll}
  onCancel={() => (confirmReset = false)}
/>

<ConfirmModal
  open={confirmColumn !== null}
  title={`Reset ${confirmColumn ?? ''} to defaults?`}
  body={resetColumnBody(confirmColumn)}
  confirmLabel="Reset column"
  icon="↺"
  tone="warning"
  onConfirm={resetColumn}
  onCancel={() => (confirmColumn = null)}
/>

<style>
  .lg-card { border: 1px solid var(--og-border); border-radius: 5px; background: var(--og-surface); color: var(--og-text); min-width: 0; }
  .lg-head { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid var(--og-border); }
  .lg-title { flex: 1; font-size: 12px; font-weight: 600; }
  .lg-count { font-size: 11px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .lg-empty { padding: 16px; font-size: 12px; font-style: italic; color: var(--og-text-muted); }
  /* The SHEET scrolls, never a cell's content: every cell below clips or wraps
     inside itself, so nothing ever paints past a border. */
  .lg-scroll { overflow: auto; max-height: 70vh; }
  .lg-table { border-collapse: separate; border-spacing: 0; font-size: 11px; font-variant-numeric: tabular-nums; table-layout: fixed; }
  .lg-table th, .lg-table td { padding: 0; border-bottom: 1px solid var(--og-border); }
  .lg-table thead th { position: sticky; top: 0; z-index: 3; background: var(--og-surface-alt); font-weight: 500; color: var(--og-text-secondary); padding: 6px; text-align: center; vertical-align: bottom; }
  /* Tool + legend: the one header that is also the sticky FIRST column, so the
     legend stays readable whichever way the sheet is scrolled. */
  .lg-tool-h { left: 0; z-index: 4; text-align: left; width: 280px; padding-left: 10px; }
  .lg-h-name { display: block; font-weight: 600; color: var(--og-text); }
  .lg-legend { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 3px; font-size: 10px; color: var(--og-text-muted); }
  .lg-legend span { display: inline-flex; align-items: center; gap: 4px; }
  .lg-ws-h, .lg-ws { border-right: 1px solid var(--og-border); }
  .lg-ws-h { width: 74px; }
  .lg-agent-h { width: 86px; padding: 0; }
  .lg-reset-all { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text-secondary); border-radius: 3px; font: inherit; font-size: 10px; padding: 2px 6px; cursor: pointer; }
  .lg-reset-all:hover { background: var(--og-btn-hover); color: var(--og-text); }
  .lg-group td { position: sticky; left: 0; background: var(--og-surface-alt); color: var(--og-text-muted); font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; padding: 4px 10px; }
  .lg-tool { position: sticky; left: 0; z-index: 2; background: var(--og-surface); padding: 5px 8px 5px 10px; width: 280px; max-width: 280px; }
  .lg-table tbody tr:hover td { background: var(--og-surface-alt); }
  .lg-name { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .lg-id { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; color: var(--og-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Shown only on hover or keyboard focus, so forty rows are not forty buttons
     competing with the tool names they sit beside. */
  .lg-all { margin-left: auto; flex-shrink: 0; visibility: hidden; background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text-secondary); border-radius: 3px; font-size: 9px; padding: 0 5px; cursor: pointer; font-family: inherit; }
  .lg-table tbody tr:hover .lg-all, .lg-all:focus-visible { visibility: visible; }
  .lg-all:hover { background: var(--og-btn-hover); color: var(--og-text); }
  /* Two lines, then it stops — with the whole line in the title. A description
     is the one field here with no length limit at all. */
  .lg-clamp { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
  .lg-desc { color: var(--og-text-muted); font-size: 10px; line-height: 1.35; overflow-wrap: anywhere; }
  .lg-cell { text-align: center; }
  .lg-cellbtn { width: 100%; height: 26px; border: none; background: transparent; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  .lg-cellbtn:hover:not(:disabled) { background: var(--og-btn-hover); }
  .lg-cellbtn:disabled { cursor: not-allowed; }
  /* SHAPE first, fill second — a filled disc, an open ring, a flat bar and a
     dashed ring read apart in a monochrome theme, which a fill alone does not.
     The fills reuse the card badges' vocabulary, so one tool looks the same on
     its card and in this sheet. */
  .lg-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; border: 1.5px solid var(--og-text-muted); flex: none; }
  .lg-dot.loaded { background: var(--og-success); border-color: var(--og-success); }
  .lg-dot.deferred { background: transparent; border-color: var(--og-warning); border-width: 2.5px; }
  .lg-dot.off { height: 2px; border: none; border-radius: 1px; background: var(--og-text-muted); }
  .lg-dot.locked { border-style: dashed; background: transparent; opacity: 0.55; }
  .lg-note { padding: 8px 10px; font-size: 11px; line-height: 1.5; color: var(--og-text-secondary); border-top: 1px solid var(--og-border); }
  .lg-note code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--og-text); }
</style>
