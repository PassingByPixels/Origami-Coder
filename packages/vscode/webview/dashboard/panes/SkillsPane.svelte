<script lang="ts">
  // Skills pane (production-readiness pass, 2026-06-06) — lets the user
  // review the skills available in the workspace. Data comes from the
  // `list_skills` ACP ext method via DashboardPanel (`skillsData`).
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { groupByCategory } from './skillsGrouping';
  const vscode = getVsCodeApi();

  // Mirrors SkillEntry in src/acpExtTypes.ts (not imported: tsconfig.webview.json
  // pins rootDir to `webview/`, so a cross-tree import breaks the type gate —
  // same rule InstructionsPane.svelte follows for InstructionEntry/InstructionSet).
  interface Skill {
    name: string;
    description: string;
    tier: string;
    ownerAgents: string[];
    tags: string[];
    immutable: boolean;
    /** The skill's own `category:` frontmatter, verbatim. Absent = uncategorised. */
    category?: string;
    /** The SKILL.md path (or pulled-URL cache path) it was discovered at. */
    location: string;
    /** Opening excerpt of the skill body, hard-capped engine-side. */
    contentPreview?: string;
  }

  interface SkillProblem {
    location: string;
    message: string;
  }

  let skills: Skill[] = $state([]);
  let problems: SkillProblem[] = $state([]);
  let error: string | null = $state(null);
  let loaded = $state(false);
  let query = $state('');
  /** Name of the one card showing its full details, or null when none is. */
  let expandedName: string | null = $state(null);

  /**
   * `rescan` asks the engine to re-walk the skill directories. The engine scans
   * ONCE per instance, so a plain re-read can only ever return the boot-time
   * list — the button was a no-op until this flag existed. Mount does not set
   * it: the cache is fresh at boot, and a re-scan re-pulls every configured
   * skills URL over the network.
   */
  function load(rescan: boolean) {
    loaded = false;
    error = null;
    vscode.postMessage({ type: 'listSkills', refresh: rescan });
  }

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type === 'skillsData') {
      skills = Array.isArray(msg.skills) ? msg.skills : [];
      problems = Array.isArray(msg.problems) ? msg.problems : [];
      error = typeof msg.error === 'string' ? msg.error : null;
      loaded = true;
    }
  });

  // Load on mount.
  load(false);

  let filtered = $derived(
    query.trim()
      ? skills.filter((s) => {
          const q = query.toLowerCase();
          return (
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            (s.tags || []).some((t) => t.toLowerCase().includes(q))
          );
        })
      : skills,
  );

  // Grouped AFTER filtering, so search narrows within every group and a group
  // left with no matches simply doesn't appear (groupByCategory only emits a
  // bucket for categories actually present in its input).
  let groups = $derived(groupByCategory(filtered));

  function toggleExpand(name: string) {
    expandedName = expandedName === name ? null : name;
  }

  function editSkill(location: string) {
    vscode.postMessage({ type: 'openSkillFile', location });
  }

  function tierLabel(t: string): string {
    if (t === 'optin') return 'opt-in';
    if (t === 'agentspecific') return 'agent-specific';
    return 'base';
  }
  function tierClass(t: string): string {
    if (t === 'optin') return 'tier-optin';
    if (t === 'agentspecific') return 'tier-agent';
    return 'tier-base';
  }
</script>

<div class="skills-pane">
  <div class="skills-toolbar">
    <input class="skills-search" type="text" placeholder="Search skills…" bind:value={query} />
    <span class="skills-count">{filtered.length}/{skills.length}</span>
    <button class="skills-refresh" onclick={() => load(true)} title="Re-scan the skill directories">↻</button>
  </div>

  {#if loaded && problems.length > 0}
    <!-- A SKILL.md that exists but loaded nothing. Shown even on a successful
         list: the failure mode this fixes is a skill silently missing, so the
         one thing the pane must never do is render a clean list over it. -->
    <div class="skills-problems">
      {#each problems as p (p.location)}
        <div class="skills-problem"><code>{p.location}</code> — {p.message}</div>
      {/each}
    </div>
  {/if}

  {#if !loaded}
    <div class="skills-empty">Loading skills…</div>
  {:else if error}
    <div class="skills-error">{error}</div>
  {:else if skills.length === 0}
    <div class="skills-empty">No skills found. Origami skills live in <code>&lt;workspace&gt;/skills/&lt;name&gt;/SKILL.md</code> — run setup or add a skill folder there.</div>
  {:else if groups.length === 0}
    <div class="skills-empty">No skills match "{query}".</div>
  {:else}
    <div class="skills-groups">
      {#each groups as g (g.label)}
        <section class="skills-group">
          <div class="skills-group-header">
            <span class="skills-group-label">{g.label}</span>
            <span class="skills-group-count">{g.skills.length}</span>
          </div>
          <div class="skills-list">
            {#each g.skills as s (s.name)}
              {@const expanded = expandedName === s.name}
              <div
                class="skill-card"
                class:expanded
                role="button"
                tabindex="0"
                onclick={() => toggleExpand(s.name)}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(s.name); } }}
              >
                <div class="skill-head">
                  <span class="skill-name">{s.name}</span>
                  <span class="skill-tier {tierClass(s.tier)}">{tierLabel(s.tier)}</span>
                  {#if s.immutable}<span class="skill-immutable" title="Immutable — shipped with Origami">locked</span>{/if}
                </div>
                {#if s.description}<div class="skill-desc">{s.description}</div>{/if}
                <div class="skill-meta">
                  {#if s.ownerAgents && s.ownerAgents.length > 0}
                    <span class="skill-owners" title="Restricted to these agents">{s.ownerAgents.join(', ')}</span>
                  {/if}
                  {#each (s.tags || []) as tag}<span class="skill-tag">{tag}</span>{/each}
                </div>
                {#if expanded}
                  <div class="skill-details">
                    {#if s.category}<span class="skill-category">{s.category}</span>{/if}
                    <div class="skill-location"><code>{s.location}</code></div>
                    {#if s.contentPreview}<pre class="skill-preview">{s.contentPreview}</pre>{/if}
                    <button
                      class="skill-edit"
                      onclick={(e) => { e.stopPropagation(); editSkill(s.location); }}
                      title="Open SKILL.md in the editor"
                    >Edit</button>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .skills-pane { display: flex; flex-direction: column; height: 100%; }
  .skills-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--og-border); flex-shrink: 0; }
  .skills-search { flex: 1; padding: 4px 8px; font-size: 12px; background: var(--og-input-bg, var(--og-btn-bg)); color: var(--og-text); border: 1px solid var(--og-border); border-radius: 4px; font-family: inherit; }
  .skills-count { font-size: 11px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .skills-refresh { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 2px 8px; font-size: 13px; }
  .skills-refresh:hover { background: var(--og-btn-hover); }
  .skills-groups { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 16px; }
  .skills-group { display: flex; flex-direction: column; gap: 8px; }
  .skills-group-header { display: flex; align-items: baseline; gap: 6px; padding: 0 2px; }
  .skills-group-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--og-text-secondary); }
  .skills-group-count { font-size: 10px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .skills-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; align-content: start; }
  .skill-card { background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 10px 11px; display: flex; flex-direction: column; min-height: 64px; transition: border-color 0.12s, transform 0.12s; cursor: pointer; outline: none; }
  .skill-card:hover { border-color: var(--og-chat); transform: translateY(-1px); }
  .skill-card:focus-visible, .skill-card.expanded { border-color: var(--og-chat); }
  .skill-head { display: flex; align-items: center; gap: 8px; }
  .skill-name { font-weight: 600; font-size: 12px; color: var(--og-text); }
  .skill-tier { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; padding: 1px 6px; border-radius: 8px; font-weight: 600; }
  .tier-base { background: var(--og-btn-bg); color: var(--og-text-muted); }
  .tier-optin { background: rgba(251,191,36,0.15); color: var(--og-warning, #ffb74d); }
  .tier-agent { background: rgba(138,180,255,0.15); color: var(--og-chat, #89b4fa); }
  .skill-immutable { font-size: 9px; color: var(--og-text-muted); border: 1px solid var(--og-border); border-radius: 8px; padding: 0 6px; }
  .skill-desc { font-size: 11px; color: var(--og-text-secondary); margin-top: 4px; line-height: 1.4; }
  .skill-meta { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; align-items: center; }
  .skill-owners { font-size: 9px; color: var(--og-chat); background: rgba(138,180,255,0.12); padding: 1px 6px; border-radius: 3px; }
  .skill-tag { font-size: 9px; color: var(--og-text-muted); background: var(--og-btn-bg); padding: 1px 6px; border-radius: 3px; }
  .skill-details { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--og-border); }
  .skill-category { align-self: flex-start; font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--og-chat, #89b4fa); background: rgba(138,180,255,0.12); padding: 1px 6px; border-radius: 8px; font-weight: 600; }
  .skill-location code { word-break: break-all; color: var(--og-text-muted); }
  .skill-preview { font-size: 11px; color: var(--og-text-secondary); line-height: 1.4; white-space: pre-wrap; margin: 0; font-family: inherit; max-height: 160px; overflow-y: auto; }
  .skill-edit { align-self: flex-start; background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 3px 10px; font-size: 11px; }
  .skill-edit:hover { background: var(--og-btn-hover); }
  .skills-empty { color: var(--og-text-muted); font-style: italic; font-size: 12px; padding: 24px 16px; text-align: center; line-height: 1.6; grid-column: 1 / -1; }
  .skills-error { color: var(--og-error, #ef5350); font-size: 12px; padding: 16px; }
  .skills-problems { flex-shrink: 0; padding: 8px 12px; border-bottom: 1px solid var(--og-border); display: flex; flex-direction: column; gap: 4px; }
  .skills-problem { font-size: 11px; color: var(--og-warning); line-height: 1.4; }
  code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; }
</style>
