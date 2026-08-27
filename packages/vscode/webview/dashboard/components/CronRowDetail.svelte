<script lang="ts">
  // CronRowDetail — what a cron actually DOES, revealed under its own row.
  //
  // The prompt used to be reachable only by opening the Edit form, which put
  // the answer to "what is this job?" behind a mutation screen. It is the
  // FIRST thing here, in full.
  //
  // Everything on this panel is already in the row the table was handed, so
  // expanding re-reads no log and re-queries no scheduler — opening ten rows
  // costs ten divs.
  //
  // The exact command line is NOT reconstructed here. The origami binary is
  // resolved at registration time and this webview has never seen it; printing
  // a plausible `origami run …` would be a guess presented as the thing running
  // unattended at 3am. The launcher script is named instead — it holds the real
  // line, verbatim, and can be opened.
  interface CronRow {
    id: string; name: string; prompt: string; agent?: string; model?: string;
    enabled: boolean; taskName: string; logPath: string; scriptPath: string;
  }
  interface Props {
    row: CronRow;
    workspace: string;
    /** The table's column count — this panel occupies ONE cell spanning all of
     *  them, because detail in extra <td>s would add columns and re-flow every
     *  other row's widths. The table owns that number, so it passes it in. */
    columns: number;
  }
  const { row, workspace, columns }: Props = $props();
  const { id, prompt, agent, model, taskName, scriptPath, logPath } = $derived(row);
</script>

<tr class="cron-detail-row" class:off={!row.enabled}><td colspan={columns}>
<div class="cd" id="cron-detail-{id}">
  <div class="cd-k">Prompt</div>
  <!-- Arbitrary user text of any length: it wraps, breaks mid-token if it has
       to, and scrolls once tall — it never widens the table it sits in. -->
  <div class="cd-prompt">{prompt}</div>

  <dl class="cd-facts">
    <div class="cd-fact">
      <dt>Agent</dt>
      <dd class="cd-v">{agent ? agent : 'engine default (no --agent)'}</dd>
    </div>
    <div class="cd-fact">
      <dt>Model</dt>
      <!-- "engine default" was the old wording and it was WRONG in the way that
           costs money: there is no default. With no `--model` the engine takes
           the first still-resolvable entry of the machine-wide recent-models
           file (~/.local/state/origami/model.json), i.e. the last model picked
           in ANY chat on this computer, and failing that the first model of the
           first provider. Say that, so a legacy cron reads as a thing to fix.
           New crons cannot be created unpinned (cronService.validate). -->
      {#if model}
        <dd class="cd-v">{model}</dd>
      {:else}
        <dd class="cd-v cd-unpinned">not pinned — this job runs on whatever model was last used on this
          machine (or the first configured one). Edit the cron to pin it.</dd>
      {/if}
    </div>
    <!-- Omitted rather than shown blank when the host did not send one: an
         empty value under this label reads as "runs nowhere", which is the one
         thing it never means. -->
    {#if workspace}
      <div class="cd-fact">
        <dt>Workspace</dt>
        <dd class="cd-v cd-path">{workspace}</dd>
      </div>
    {/if}
    <div class="cd-fact">
      <dt>Scheduled task</dt>
      <dd class="cd-v cd-path">{taskName}</dd>
    </div>
    <div class="cd-fact">
      <dt>Launcher script</dt>
      <dd class="cd-v cd-path">{scriptPath}</dd>
    </div>
    <div class="cd-fact">
      <dt>Log</dt>
      <dd class="cd-v cd-path">{logPath}</dd>
    </div>
  </dl>

  <div class="cd-note">
    The launcher script holds the exact command line, including the resolved origami binary — open it to
    read what the scheduler runs.
  </div>
</div>
</td></tr>

<style>
  .cron-detail-row > td { padding: 0 8px 10px; max-width: 0; }
  .cron-detail-row.off { opacity: 0.55; }
  .cd { padding: 2px 2px 6px; max-width: 100%; }
  .cd-k { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--og-text-muted); margin-bottom: 3px; }
  .cd-prompt {
    font-size: 11px; line-height: 1.5; color: var(--og-text);
    white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
    max-height: 220px; overflow-y: auto; overflow-x: hidden;
    background: var(--og-bg); border: 1px solid var(--og-border); border-radius: 4px; padding: 7px 9px;
  }
  /* auto-fit, not a fixed count — this board docks into a narrow side panel as
     often as it runs full width. */
  .cd-facts { margin: 8px 0 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 6px 14px; }
  .cd-fact { min-width: 0; }
  .cd-fact dt { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--og-text-muted); }
  .cd-unpinned { color: var(--og-warning-text); }
  .cd-v { margin: 1px 0 0; font-size: 10px; color: var(--og-text-secondary); overflow-wrap: anywhere; }
  .cd-path { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
  .cd-note { margin-top: 8px; font-size: 10px; font-style: italic; color: var(--og-text-muted); line-height: 1.4; }
</style>
