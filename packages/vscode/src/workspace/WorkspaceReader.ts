// Reads Origami workspace data from disk and sends it to the webview.
// Sources: settings.toml, BOARD.md, goals/, projects/, cron/jobs.json, wiki/pages/

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface WorkspaceData {
  settings: {
    model: string;
    activeAgent: string;
    apiBase: string;
    /**
     * Phase 8 of the 2026-04-26 collapse — active mode + per-mode
     * default models. Surfaced in the dashboard header so the user can
     * see which mode is in force at a glance, alongside the active
     * model name. `'normal'` if missing (matches Rust-side default).
     */
    activeMode: 'normal' | 'game';
    defaultModelNormal: string;
    defaultModelGame: string;
  };
  tasks: TaskItem[];
  goals: GoalItem[];
  projects: ProjectItem[];
  cronJobs: CronJob[];
  wikiPages: WikiPage[];
  agents: AgentProfile[];
  /**
   * Phase 3.5 of the Endeavors PM overhaul — orphan plans queued
   * in `Endeavors/_inbox/plans/` waiting for adoption. Each entry
   * carries the optional path-overlap hint the adoption cron
   * uses to score candidate parents; the BoardPane reuses it for
   * the per-project inbox badge.
   */
  inboxPlans: InboxPlan[];
}

export interface InboxPlan {
  /** X-<ULID> — durable plan id. */
  id: string;
  /** Cute generated label, e.g. "scoped-profiler-latency-quietly". */
  title: string;
  /** ISO-8601 instant the plan was first parked in the inbox. */
  created: string;
  /** Days since `created` (computed). */
  ageDays: number;
  /** Hint about the entity kind that should adopt this plan. */
  suggestedParentKind?: 'project' | 'goal' | 'task';
  /**
   * File-path prefixes the plan would touch. Compared against
   * each project's declared `paths:` to score candidate parents.
   */
  suggestedPaths: string[];
}

export interface AgentProfile {
  id: string;
  name: string;
  archetype: string;
}

/**
 * TaskItem mirrors the canonical Rust
 * `wiki::Task` schema. Status is a 5-state projection of the 12-state
 * Rust enum (Pending / Planning / InProgress / Blocked / Done) so the
 * dashboard can render distinct state colours without exposing the
 * full lifecycle to the UI; the source-of-truth status is preserved
 * via `rawStatus` for tooltip / detail views.
 */
export interface TaskItem {
  id: string;
  title: string;
  agent: string;
  /** 5-state projection used by the board kanban. */
  status: 'pending' | 'planning' | 'in_progress' | 'blocked' | 'done';
  /** Source-of-truth Rust `TaskStatus` (snake_case). */
  rawStatus?: string;
  priority: 'high' | 'medium' | 'low';
  project?: string;
  goal?: string;
  /** Slice B.0 — names of other tasks in the same project this depends on. */
  dependsOn?: string[];
  /** Slice B.0 — what 'done' looks like, set by the planning step. */
  acceptanceCriteria?: string;
  /** Slice B.0 — slug of the InteractivePlan page, if a plan has been generated. */
  planLink?: string;
  relPath: string;
}

export interface GoalGate {
  name: string;
  done: number;
  total: number;
  complete: boolean;
}

export interface GoalItem {
  id: string;
  title: string;
  agent: string;
  pct: number;
  target: string;
  status: 'active' | 'blocked' | 'archived';
  gates: GoalGate[];
  relPath: string;
}

/**
 * Slice B.0 — ProjectItem carries the additive frontmatter fields
 * (`parent_goal`, `phase`, `paths`) plus the structured task list
 * read directly from the project's YAML frontmatter (instead of
 * the legacy `[x]`/`[ ]` checklist count). `done` / `total` are
 * derived from the task list for backward-compat with existing
 * BoardPane render code.
 */
export interface ProjectItem {
  id: string;
  name: string;
  agent: string;
  done: number;
  total: number;
  status: string;
  /** Slice B.0 — slug of the parent goal this project rolls up under. */
  parentGoal?: string;
  /** Slice B.0 — phase tag of the parent goal (e.g. `"A1"`). */
  phase?: string;
  /** Slice B.0 — workspace-relative paths / crates this project owns. */
  paths?: string[];
  /** Slice B.0 — full task list parsed from YAML frontmatter. */
  tasks?: TaskItem[];
  relPath: string;
}

export interface CronJob {
  id: string;
  name: string;
  agent: string;
  enabled: boolean;
  state: string;
  nextRunAt: number;
  lastRunAt: number;
  lastStatus: string;
  lastError: string | null;
  schedule: string;
  scheduleKind: string;
  prompt: string;
  skills: string[];
  sourceFile: string;
}

export interface WikiPage {
  id: string;
  title: string;
  namespace: string;
  updated: string;
  snippet: string;
  tags: string[];
  content: string;
  /**
   * Raw outbound link targets parsed from the page body — `[[wikilinks]]`
   * (with optional `|alias` / `#anchor`) and relative markdown links to other
   * `.md` files. Left unresolved here; the memory graph resolves them to page
   * ids against the full page set so page↔page edges survive content
   * truncation. Empty when the page links nowhere.
   */
  links: string[];
}

/**
 * Find the workspace path from ~/.origami/settings.toml
 */
export function findWorkspacePath(): string | null {
  const settingsPath = path.join(os.homedir(), '.origami', 'settings.toml');
  if (!fs.existsSync(settingsPath)) return null;
  const content = fs.readFileSync(settingsPath, 'utf-8');
  const match = content.match(/workspace_path\s*=\s*'([^']+)'/);
  return match ? match[1] : null;
}

/**
 * Read settings.toml for model name, active agent, etc.
 */
export function readSettings(): WorkspaceData['settings'] {
  const settingsPath = path.join(os.homedir(), '.origami', 'settings.toml');
  const defaults: WorkspaceData['settings'] = {
    model: '',
    activeAgent: '',
    apiBase: '',
    activeMode: 'normal',
    defaultModelNormal: '',
    defaultModelGame: '',
  };
  if (!fs.existsSync(settingsPath)) return defaults;

  const content = fs.readFileSync(settingsPath, 'utf-8');
  const model = content.match(/^model\s*=\s*"([^"]+)"/m);
  const agent = content.match(/^active_agent\s*=\s*"([^"]+)"/m);
  const api = content.match(/^api_base\s*=\s*"([^"]+)"/m);
  // Phase 8 — mode-centric fields. Tolerate missing keys (legacy
  // settings.toml that hasn't been re-saved since the migration).
  const mode = content.match(/^active_mode\s*=\s*"([^"]+)"/m);
  const normal = content.match(/^default_model_normal\s*=\s*"([^"]+)"/m);
  const game = content.match(/^default_model_game\s*=\s*"([^"]+)"/m);

  return {
    model: model ? model[1] : '',
    activeAgent: agent ? agent[1] : '',
    apiBase: api ? api[1] : '',
    activeMode: mode && mode[1] === 'game' ? 'game' : 'normal',
    defaultModelNormal: normal ? normal[1] : '',
    defaultModelGame: game ? game[1] : '',
  };
}

/**
 * Read cron/jobs.json — returns up to 10 jobs sorted by next_run_at
 */
export function readCronJobs(workspacePath: string): CronJob[] {
  const jobsPath = path.join(workspacePath, 'cron', 'jobs.json');
  if (!fs.existsSync(jobsPath)) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
    if (!Array.isArray(raw)) return [];

    return raw
      .map((j: any): CronJob => {
        const sched = j.schedule || {};
        const scheduleKind = String(sched.kind || '');
        let schedule = '';
        if (scheduleKind === 'cron') schedule = String(sched.expr || '');
        else if (scheduleKind === 'interval') schedule = `every ${sched.minutes ?? '?'} min`;
        else schedule = String(sched.expr || sched.minutes || '');
        return {
          id: j.id || '',
          name: j.name || '',
          agent: j.agent || '',
          enabled: j.enabled ?? true,
          state: j.state || 'idle',
          nextRunAt: j.next_run_at || 0,
          lastRunAt: j.last_run_at || 0,
          lastStatus: j.last_status || '',
          lastError: j.last_error ?? null,
          schedule,
          scheduleKind,
          prompt: String(j.prompt || ''),
          skills: Array.isArray(j.skills) ? j.skills.map(String) : [],
          sourceFile: String(j.source_file || ''),
        };
      })
      .sort((a: CronJob, b: CronJob) => a.nextRunAt - b.nextRunAt)
      .slice(0, 10);
  } catch {
    return [];
  }
}

/**
 * Read BOARD.md — parse markdown task sections
 */
export function readBoard(workspacePath: string): TaskItem[] {
  const boardPath = path.join(workspacePath, 'BOARD.md');
  if (!fs.existsSync(boardPath)) return [];

  const content = fs.readFileSync(boardPath, 'utf-8');
  const tasks: TaskItem[] = [];
  let currentStatus: TaskItem['status'] = 'pending';
  let counter = 0;

  for (const line of content.split('\n')) {
    if (/## .*pending/i.test(line)) currentStatus = 'pending';
    else if (/## .*in.?progress/i.test(line)) currentStatus = 'in_progress';
    else if (/## .*done|complete/i.test(line)) currentStatus = 'done';
    else if (line.startsWith('- ')) {
      const text = line.slice(2).trim();
      if (text && !text.startsWith('_')) {
        // Extract optional [project: X] / [goal: Y] / #project/X / #goal/Y tags
        const projectBracket = text.match(/\[project:\s*([^\]]+)\]/i)?.[1]?.trim();
        const goalBracket = text.match(/\[goal:\s*([^\]]+)\]/i)?.[1]?.trim();
        const projectHash = text.match(/(?:^|\s)#project\/([\w.-]+)/i)?.[1];
        const goalHash = text.match(/(?:^|\s)#goal\/([\w.-]+)/i)?.[1];
        const priorityTag = text.match(/\[(high|medium|low)\]/i)?.[1]?.toLowerCase() as 'high' | 'medium' | 'low' | undefined;
        const title = text.replace(/\[[^\]]*\]/g, '').replace(/(?:^|\s)#(?:project|goal)\/[\w.-]+/gi, '').trim();
        tasks.push({
          id: `board-${counter++}`,
          title,
          agent: 'coder',
          status: currentStatus,
          priority: priorityTag || 'medium',
          project: projectBracket || projectHash,
          goal: goalBracket || goalHash,
          relPath: 'BOARD.md',
        });
      }
    }
  }
  return tasks;
}

/**
 * Read `goals/<slug>/goal.md` files.
 *
 * Switched from the legacy flat
 * `goals/*.md` layout to the subdirectory-per-goal shape that
 * Rust's `wiki::ops::goal_create` actually writes. Each goal lives
 * at `<workspace>/goals/<slug>/goal.md` with a sibling
 * `progress.md`. The slug is the goal's stable id.
 *
 * Phase chip lines (the `- [x] Phase A1: name (5/5 tasks)` format
 * BoardPane renders as gates) are emitted into the `## Phases`
 * section by `wiki::ops::goal_set_phases` + auto-recomputed by
 * `wiki::ops::goal_recompute_chips` whenever a project task
 * mutation lands. The regex here matches the Rust-side writer
 * exactly — both sides MUST stay in lockstep.
 */
export function readGoals(workspacePath: string): GoalItem[] {
  const goals: GoalItem[] = [];
  // Endeavors PM overhaul — read the new layout first.
  const endeavorsDir = path.join(workspacePath, 'Endeavors', 'goals');
  if (fs.existsSync(endeavorsDir)) {
    for (const entry of fs.readdirSync(endeavorsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const id = entry.name; // G-<ULID>
      const goalFile = path.join(endeavorsDir, id, 'goal.md');
      if (!fs.existsSync(goalFile)) continue;
      const content = fs.readFileSync(goalFile, 'utf-8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      const yaml = fmMatch?.[1] ?? '';
      const slug =
        yaml.match(/^slug:\s*(.+)$/m)?.[1]?.trim().replace(/['"]/g, '') ?? id;
      const title =
        yaml.match(/^title:\s*(.+)$/m)?.[1]?.trim().replace(/['"]/g, '') ??
        content.match(/^#\s+(.+)/m)?.[1] ??
        slug;
      const status = (yaml.match(/^status:\s*(\w+)/m)?.[1] ??
        'active') as GoalItem['status'];
      const target =
        content.match(/^\*\*Target date:\*\*\s*(.+)/m)?.[1]?.trim() ||
        yaml.match(/^target_date:\s*(.+)$/m)?.[1]?.trim().replace(/['"]/g, '') ||
        '';
      const owner = 'coder';
      const pctFromYaml = parseInt(
        yaml.match(/^percent_complete:\s*(\d+)/m)?.[1] ?? '0',
        10,
      );

      // Phase chip gates from body.
      const gates: GoalGate[] = [];
      const gateRegex = /^- \[([ x])\]\s+(.+?)\s+\((\d+)\/(\d+)\s+tasks?\)/gm;
      let gm;
      while ((gm = gateRegex.exec(content)) !== null) {
        gates.push({
          name: gm[2],
          done: parseInt(gm[3]),
          total: parseInt(gm[4]),
          complete: gm[1] === 'x',
        });
      }

      let pct = pctFromYaml;
      if (gates.length > 0 && pct === 0) {
        const total = gates.reduce((acc, g) => acc + g.total, 0);
        const done = gates.reduce((acc, g) => acc + g.done, 0);
        pct = total > 0 ? Math.round((done / total) * 100) : 0;
      }

      goals.push({
        id: slug, // Keep id = slug for backward-compat with BoardPane keying
        title,
        agent: owner,
        pct,
        target,
        status,
        gates,
        relPath: `Endeavors/goals/${id}/goal.md`,
      });
    }
  }

  // Legacy layout — surface any goals not yet migrated. Skip slugs
  // already represented from the Endeavors pass.
  const seenSlugs = new Set(goals.map(g => g.id));
  const goalsDir = path.join(workspacePath, 'goals');
  if (!fs.existsSync(goalsDir)) return goals;

  for (const entry of fs.readdirSync(goalsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    if (seenSlugs.has(slug)) continue;
    const goalFile = path.join(goalsDir, slug, 'goal.md');
    if (!fs.existsSync(goalFile)) continue;

    const content = fs.readFileSync(goalFile, 'utf-8');
    const title = content.match(/^#\s+(.+)/m)?.[1] || slug;
    // `**Target date:** ...` line emitted by Rust goal builders;
    // tolerate the legacy `Target:` shape too for hand-edited goals.
    const target =
      content.match(/^\*\*Target date:\*\*\s*(.+)/m)?.[1]?.trim() ||
      content.match(/^Target:\s*(.+)/m)?.[1]?.trim() ||
      '';
    const status =
      (content.match(/^Status:\s*(.+)/m)?.[1]?.trim() ||
        'active') as GoalItem['status'];
    const owner = content.match(/^Owner:\s*(.+)/m)?.[1]?.trim() || 'coder';

    // Parse phase-chip gates: lines like
    // `- [x] Phase A1: Core runtime scaffold (5/5 tasks)`. Matches
    // the Rust-side writer in `wiki::ops::format_chip_line`.
    const gates: GoalGate[] = [];
    const gateRegex = /^- \[([ x])\]\s+(.+?)\s+\((\d+)\/(\d+)\s+tasks?\)/gm;
    let gm;
    while ((gm = gateRegex.exec(content)) !== null) {
      gates.push({
        name: gm[2],
        done: parseInt(gm[3]),
        total: parseInt(gm[4]),
        complete: gm[1] === 'x',
      });
    }

    // Roll percentage from the chips when available — sum of
    // task counts is more authoritative than a hand-typed
    // `Progress:` line. Fall back to that line if no chips.
    let pct = 0;
    if (gates.length > 0) {
      const total = gates.reduce((acc, g) => acc + g.total, 0);
      const done = gates.reduce((acc, g) => acc + g.done, 0);
      pct = total > 0 ? Math.round((done / total) * 100) : 0;
    } else {
      const pctMatch = content.match(/^Progress:\s*(\d+)/m);
      if (pctMatch) pct = parseInt(pctMatch[1]);
    }

    goals.push({
      id: slug,
      title,
      agent: owner,
      pct,
      target,
      status,
      gates,
      relPath: `goals/${slug}/goal.md`,
    });
  }
  return goals;
}

/**
 * Read wiki/pages/*.md files
 */
export function readWikiPages(workspacePath: string): WikiPage[] {
  return readWikiPagesFromDir(path.join(workspacePath, 'wiki', 'pages'), path.join(workspacePath, 'wiki'));
}

/**
 * The folder the memory graph sources by default: `<workspace>/wiki/pages`.
 * The workspace is the open project folder, whose wiki firstfold creates and
 * wrap writes to — so the wiki is ALWAYS the direct `wiki/pages`, empty or not
 * (it fills as wrap runs). Callers pass the open VS Code folder as the base.
 */
export function resolveDefaultWikiPages(workspacePath: string): string {
  return path.join(workspacePath, 'wiki', 'pages');
}

/**
 * Read .md files recursively from an arbitrary directory. Used when the user
 * picks a custom memory-graph folder.
 */
export function readWikiPagesFromDir(pagesDir: string, relRoot?: string): WikiPage[] {
  if (!fs.existsSync(pagesDir)) return [];
  const root = relRoot ?? pagesDir;

  const pages: WikiPage[] = [];
  const files = listMdFilesRecursive(pagesDir);
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relPath = path.relative(root, filePath);
    const title = content.match(/^#\s+(.+)/m)?.[1] || path.basename(filePath, '.md');
    const stat = fs.statSync(filePath);

    // Extract tags from YAML frontmatter if present
    const tags: string[] = [];
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const tagLine = fmMatch[1].match(/tags:\s*\[([^\]]+)\]/);
      if (tagLine) {
        tags.push(...tagLine[1].split(',').map(t => t.trim().replace(/['"]/g, '')));
      }
    }

    pages.push({
      id: relPath.replace(/\\/g, '/'),
      title,
      // Normalise to forward slashes so namespace labels/grouping don't render
      // as `pages\fitness` on Windows (path.dirname uses the OS separator).
      namespace: path.dirname(relPath).replace(/\\/g, '/') + '/',
      updated: stat.mtime.toISOString().slice(0, 10),
      snippet: content.replace(/^---[\s\S]*?---\n?/, '').replace(/^#.*\n?/, '').trim().slice(0, 200),
      tags,
      content: content.slice(0, 2000),
      links: extractPageLinks(content),
    });
  }
  return pages;
}

/**
 * Parse outbound link targets from a page body. Content-agnostic — matches the
 * two conventions any wiki uses and returns raw targets (resolved to page ids
 * downstream):
 *   - `[[Target]]`, `[[Target|alias]]`, `[[Target#anchor]]`
 *   - markdown links to a local `.md` file: `[text](path/to/page.md)`
 * Skips external `http(s)` links. Deduped, in first-seen order.
 */
function extractPageLinks(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    const t = m[1].trim();
    if (t) out.add(t);
  }
  for (const m of content.matchAll(/\]\(([^)]+?\.md)(?:#[^)]*)?\)/g)) {
    const t = m[1].trim();
    if (t && !/^https?:/i.test(t)) out.add(t);
  }
  return [...out];
}

function listMdFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listMdFilesRecursive(full));
    } else if (entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Slice B.0 — read project pages from
 * `<workspace>/wiki/pages/projects/*.md` (the canonical Rust path
 * that `wiki::ops::project_create` writes to). The legacy reader
 * scanned `<workspace>/projects/` and counted body checkboxes; this
 * version reads the YAML frontmatter directly so structured Task
 * fields (priority / status / depends_on / plan_link / etc.) come
 * through faithfully.
 *
 * The frontmatter is a constrained shape (it's emitted by `serde_yaml`
 * with a stable schema) so the parser below handles the fields we
 * need without pulling in a full YAML library. Anything it can't
 * parse degrades gracefully to defaults — bad/legacy pages still
 * render, just with empty task lists.
 */
export function readProjects(workspacePath: string): ProjectItem[] {
  const projects: ProjectItem[] = [];

  // V8 close (cozy-lantern) — load every per-task file once, group
  // by project_id. Each project's reader reaches into this map first;
  // inline tasks: are only consulted as a fallback for genuinely
  // un-migrated projects (zero per-task files for that project_id).
  const tasksByProjectId = readPerTaskFilesByProject(workspacePath);

  // Endeavors PM overhaul — read the new layout first.
  // Each project lives at `Endeavors/projects/<P-ULID>/project.md`
  // and carries `id` + `slug` in YAML frontmatter.
  const endeavorsDir = path.join(workspacePath, 'Endeavors', 'projects');
  if (fs.existsSync(endeavorsDir)) {
    for (const entry of fs.readdirSync(endeavorsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const projectId = entry.name; // P-<ULID>
      const projectFile = path.join(endeavorsDir, projectId, 'project.md');
      if (!fs.existsSync(projectFile)) continue;
      const content = fs.readFileSync(projectFile, 'utf-8');
      const fm = parseProjectFrontmatter(content);
      if (!fm) continue;

      const slug = (fm as { slug?: string }).slug || projectId;
      const relPath = `Endeavors/projects/${projectId}/project.md`;

      // V8 close (cozy-lantern): prefer per-task files when available.
      // Source priority: per-task files > inline fm.tasks. Inline is
      // a fallback for un-migrated projects only — zero per-task files
      // for this project_id means nothing has been migrated yet.
      let tasks: TaskItem[];
      const perTask = tasksByProjectId.get(projectId);
      if (perTask && perTask.length > 0) {
        tasks = perTask.map((t) => finalizeTaskItem(t, slug, fm, relPath));
      } else {
        tasks = (fm.tasks ?? []).map((t, idx) => finalizeTaskItem(
          {
            id: t.id && t.id.length > 0 ? t.id : `${slug}#${idx}`,
            name: t.name,
            assignedTo: t.assignedTo,
            status: t.status,
            priority: t.priority,
            dependsOn: t.dependsOn,
            acceptanceCriteria: t.acceptanceCriteria,
            planLink: t.planLink,
          },
          slug, fm, relPath,
        ));
      }
      const total = tasks.length;
      const done = tasks.filter(t => t.status === 'done').length;
      const agent = (fm.assignedAgents && fm.assignedAgents[0]) || 'coder';
      projects.push({
        id: slug,
        name: fm.title || slug,
        agent,
        done,
        total: total || 0,
        status: fm.status || 'planning',
        parentGoal: fm.parentGoal,
        phase: fm.phase,
        paths: fm.paths,
        tasks,
        relPath,
      });
    }
  }

  // Legacy fallback — surface any project not yet migrated. Skip
  // slugs already represented from the Endeavors pass.
  const seenSlugs = new Set(projects.map(p => p.id));
  const projDir = path.join(workspacePath, 'wiki', 'pages', 'projects');
  if (!fs.existsSync(projDir)) return projects;
  const files = fs.readdirSync(projDir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    if (seenSlugs.has(slug)) continue;
    const content = fs.readFileSync(path.join(projDir, file), 'utf-8');
    const fm = parseProjectFrontmatter(content);
    if (!fm) continue;

    const tasks: TaskItem[] = (fm.tasks ?? []).map((t, idx) => ({
      id: t.id && t.id.length > 0 ? t.id : `${slug}#${idx}`,
      title: t.name,
      agent: t.assignedTo ?? '',
      status: projectTaskStatus(t.status),
      rawStatus: t.status,
      priority: (t.priority ?? fm.priority ?? 'medium') as TaskItem['priority'],
      project: slug,
      goal: fm.parentGoal,
      dependsOn: t.dependsOn,
      acceptanceCriteria: t.acceptanceCriteria,
      planLink: t.planLink,
      relPath: `wiki/pages/projects/${file}`,
    }));

    const total = tasks.length;
    const done = tasks.filter(t => t.status === 'done').length;
    const agent = (fm.assignedAgents && fm.assignedAgents[0]) || 'zyn';

    projects.push({
      id: slug,
      name: fm.title || slug,
      agent,
      done,
      total: total || 0,
      status: fm.status || 'planning',
      parentGoal: fm.parentGoal,
      phase: fm.phase,
      paths: fm.paths,
      tasks,
      relPath: `wiki/pages/projects/${file}`,
    });
  }
  return projects;
}

/**
 * Slice B.0 — minimal YAML frontmatter parser shaped for the
 * `wiki::ProjectFrontmatter` write format. Handles the scalar fields
 * + `tasks:` block list + simple string arrays. Returns `null` when
 * there is no `---` fence (page malformed or no frontmatter).
 *
 * Why hand-rolled instead of pulling `js-yaml`: the input shape is
 * fixed by serde_yaml output and the dashboard is a
 * latency-sensitive read path. A 70-line targeted parser keeps the
 * dep tree small and avoids surprises from yaml-spec edge cases
 * we don't need.
 */
interface ParsedTaskFm {
  /** Endeavors PM overhaul — durable T-<ULID>. Empty on legacy tasks. */
  id?: string;
  name: string;
  status: string;
  assignedTo?: string;
  priority?: string;
  dependsOn: string[];
  acceptanceCriteria?: string;
  planLink?: string;
}

interface ParsedProjectFm {
  /** Endeavors PM overhaul — durable P-<ULID>. Empty on legacy. */
  id?: string;
  /** Endeavors PM overhaul — kebab-case slug. Empty on legacy. */
  slug?: string;
  title?: string;
  status?: string;
  priority?: string;
  parentGoal?: string;
  phase?: string;
  paths?: string[];
  assignedAgents?: string[];
  tasks?: ParsedTaskFm[];
}

/**
 * V8 close (cozy-lantern) — walk `Endeavors/tasks/*.md` once and
 * group every per-task file by its `project: P-XXX` backlink.
 * Returns a Map keyed by project_id; values are the tasks
 * belonging to that project, in directory-listing order (callers
 * should sort by status/priority if needed).
 *
 * Cheap to call on every refresh — typical workspaces have ≤ a few
 * hundred tasks. Skips malformed files silently rather than failing.
 */
function readPerTaskFilesByProject(workspacePath: string): Map<string, ParsedTaskFm[]> {
  const out = new Map<string, ParsedTaskFm[]>();
  const tasksDir = path.join(workspacePath, 'Endeavors', 'tasks');
  if (!fs.existsSync(tasksDir)) return out;
  for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const file = path.join(tasksDir, entry.name);
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const parsed = parsePerTaskFile(content);
      if (!parsed) continue;
      const list = out.get(parsed.projectId) ?? [];
      list.push(parsed.task);
      out.set(parsed.projectId, list);
    } catch { /* skip unreadable file */ }
  }
  return out;
}

/**
 * V8 close — parse a single per-task file. Frontmatter shape (from
 * `task_save_to_file` in crates/wiki/src/endeavors.rs):
 *
 * ```yaml
 * project: P-XXXX
 * id: T-XXXX
 * name: ...
 * status: pending
 * assigned_to: ...
 * priority: ...
 * depends_on: [...]
 * acceptance_criteria: ...
 * plan_link: ...
 * ```
 *
 * Returns `null` when the YAML frontmatter is missing or doesn't
 * carry the required `project:` and `name:` fields.
 */
function parsePerTaskFile(content: string): { projectId: string; task: ParsedTaskFm } | null {
  const fenceMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fenceMatch) return null;
  const block = fenceMatch[1];
  const lines = block.split(/\r?\n/);

  let projectId: string | undefined;
  let id: string | undefined;
  let name: string | undefined;
  let status = 'pending';
  let assignedTo: string | undefined;
  let priority: string | undefined;
  const dependsOn: string[] = [];
  let acceptanceCriteria: string | undefined;
  let planLink: string | undefined;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([a-z_]+)\s*:\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const rawValue = m[2];
    if (rawValue && rawValue !== '~' && rawValue !== 'null') {
      const v = unquoteYamlScalar(rawValue);
      switch (key) {
        case 'project': projectId = v; break;
        case 'id': id = v; break;
        case 'name': name = v; break;
        case 'status': status = v; break;
        case 'assigned_to': assignedTo = v; break;
        case 'priority': priority = v; break;
        case 'acceptance_criteria': acceptanceCriteria = v; break;
        case 'plan_link': planLink = v; break;
        default: /* ignore */ break;
      }
      i++;
      continue;
    }
    if (key === 'depends_on') {
      i++;
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        dependsOn.push(unquoteYamlScalar(lines[i].replace(/^\s*-\s+/, '').trim()));
        i++;
      }
      continue;
    }
    i++;
  }
  if (!projectId || !name || !id) return null;
  return {
    projectId,
    task: { id, name, status, assignedTo, priority, dependsOn, acceptanceCriteria, planLink },
  };
}

/**
 * V8 close — shared finalisation step for TaskItem rows. Both the
 * per-task-file path AND the inline fallback path go through this
 * so the visible shape stays identical regardless of source.
 */
function finalizeTaskItem(
  t: ParsedTaskFm,
  slug: string,
  fm: ParsedProjectFm,
  relPath: string,
): TaskItem {
  return {
    id: t.id && t.id.length > 0 ? t.id : `${slug}#${t.name}`,
    title: t.name,
    agent: t.assignedTo ?? '',
    status: projectTaskStatus(t.status),
    rawStatus: t.status,
    priority: (t.priority ?? fm.priority ?? 'medium') as TaskItem['priority'],
    project: slug,
    goal: fm.parentGoal,
    dependsOn: t.dependsOn,
    acceptanceCriteria: t.acceptanceCriteria,
    planLink: t.planLink,
    relPath,
  };
}

function parseProjectFrontmatter(content: string): ParsedProjectFm | null {
  const fenceMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fenceMatch) return null;
  const block = fenceMatch[1];
  const lines = block.split(/\r?\n/);

  const out: ParsedProjectFm = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Top-level scalar key.
    const scalarMatch = line.match(/^([a-z_]+)\s*:\s*(.*)$/);
    if (!scalarMatch) {
      i++;
      continue;
    }
    const key = scalarMatch[1];
    const rawValue = scalarMatch[2];

    if (rawValue && rawValue !== '~' && rawValue !== 'null') {
      // Inline scalar value.
      const value = unquoteYamlScalar(rawValue);
      switch (key) {
        case 'id': out.id = value; break;
        case 'slug': out.slug = value; break;
        case 'title': out.title = value; break;
        case 'status': out.status = value; break;
        case 'priority': out.priority = value; break;
        case 'parent_goal': out.parentGoal = value; break;
        case 'phase': out.phase = value; break;
        default: /* ignore */ break;
      }
      i++;
      continue;
    }

    // Empty value → block list or empty container.
    if (key === 'paths' || key === 'assigned_agents') {
      const items: string[] = [];
      i++;
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        const item = lines[i].replace(/^\s*-\s+/, '').trim();
        items.push(unquoteYamlScalar(item));
        i++;
      }
      if (key === 'paths') out.paths = items;
      else out.assignedAgents = items;
      continue;
    }

    if (key === 'tasks') {
      const tasks: ParsedTaskFm[] = [];
      i++;
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        // Each task block starts with `- name: ...` (or
        // `-` then `  name: ...` on the next line). Collect
        // every line that's part of this task — the task
        // ends at the next `-` at the same indent.
        const taskLines: string[] = [];
        const startIndent = lines[i].match(/^(\s*)-/)?.[1].length ?? 0;
        // First line: include text after `- ` for inline first field.
        taskLines.push(lines[i].replace(/^\s*-\s+/, ''));
        i++;
        while (i < lines.length) {
          const cur = lines[i];
          if (/^\s*-\s+/.test(cur) && (cur.match(/^(\s*)-/)?.[1].length ?? 0) <= startIndent) {
            break;
          }
          if (/^\S/.test(cur)) {
            // Top-level key — task list ended.
            break;
          }
          taskLines.push(cur.replace(/^\s{2,}/, ''));
          i++;
        }
        const task = parseTaskBlock(taskLines);
        if (task) tasks.push(task);
      }
      out.tasks = tasks;
      continue;
    }

    // Anything else: skip and advance.
    i++;
  }
  return out;
}

function parseTaskBlock(lines: string[]): ParsedTaskFm | null {
  let id: string | undefined;
  let name: string | undefined;
  let status = 'pending';
  let assignedTo: string | undefined;
  let priority: string | undefined;
  let dependsOn: string[] = [];
  let acceptanceCriteria: string | undefined;
  let planLink: string | undefined;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([a-z_]+)\s*:\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const value = m[2];
    if (value && value !== '~' && value !== 'null') {
      const v = unquoteYamlScalar(value);
      switch (key) {
        case 'id': id = v; break;
        case 'name': name = v; break;
        case 'status': status = v; break;
        case 'assigned_to': assignedTo = v; break;
        case 'priority': priority = v; break;
        case 'acceptance_criteria': acceptanceCriteria = v; break;
        case 'plan_link': planLink = v; break;
        case 'notes': /* ignore for board view */ break;
        default: /* ignore */ break;
      }
      i++;
      continue;
    }
    // Block list under task.
    if (key === 'depends_on') {
      i++;
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        dependsOn.push(unquoteYamlScalar(lines[i].replace(/^\s*-\s+/, '').trim()));
        i++;
      }
      continue;
    }
    i++;
  }
  if (!name) return null;
  return {
    id,
    name,
    status,
    assignedTo,
    priority,
    dependsOn,
    acceptanceCriteria,
    planLink,
  };
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Slice B.0 — project the 12-state Rust `TaskStatus` down to the
 * 5 distinct visual states the dashboard renders. `null`/unknown
 * status defaults to `pending` so legacy / hand-edited tasks still
 * render.
 */
function projectTaskStatus(raw: string): TaskItem['status'] {
  switch (raw) {
    case 'done':
    case 'archived':
      return 'done';
    case 'in_progress':
    case 'validating':
    case 'rework':
      return 'in_progress';
    case 'planning':
    case 'plan_review':
    case 'plan_approved':
    case 'needs_user_input':
    case 'approved':
      return 'planning';
    case 'blocked':
    case 'cancelled':
      return 'blocked';
    case 'pending':
    default:
      return 'pending';
  }
}

/**
 * V1 is single-agent: there is no multi-agent roster. Identity is a fixed
 * fact, not a filesystem-sourced roster. The brand identity is Tsuru (the
 * crane). `archetype` stays the internal `coder` body the bridge scaffolds
 * from; `name` is the display label the UI shows.
 */
export function readAgents(_workspacePath: string): AgentProfile[] {
  return [{ id: 'tsuru', name: 'Tsuru', archetype: 'coder' }];
}

/**
 * Resolve an internal agent value (a settings.toml `active_agent`, an
 * archetype body name like `coder`, or a roster id like `tsuru`) to the
 * user-visible display label from the fixed roster. The bridge / settings
 * may still carry the internal `coder` archetype, but NOTHING the user
 * sees should read `coder` — every label resolves to the brand identity
 * Tsuru (the crane). Unknown values fall back to the brand default.
 */
export function displayAgentName(internal?: string): string {
  const roster = readAgents('');
  if (internal) {
    const v = internal.trim().toLowerCase();
    const hit = roster.find(
      (a) => a.id.toLowerCase() === v || a.archetype.toLowerCase() === v || a.name.toLowerCase() === v,
    );
    if (hit) return hit.name;
    // S6e honest labels: an UNKNOWN agent id renders as ITSELF (capitalised), not
    // collapsed to the brand default - a typed agent shows its real id instead of
    // masquerading as Tsuru.
    if (v) return v.charAt(0).toUpperCase() + v.slice(1);
  }
  // Empty / unset — brand default is the first roster entry (Tsuru).
  return roster[0]?.name ?? 'Tsuru';
}

/**
 * S8 V16 (bright-muffin) — read just the agent's `profile/art.txt`
 * for the chat-banner ASCII art. Returns null when the file is
 * missing or empty so callers can render the banner conditionally
 * without parsing a full agent detail payload.
 */
export function readAgentArt(workspacePath: string, agentId: string): string | null {
  if (!agentId) return null;
  const artPath = path.join(workspacePath, 'agents', agentId, 'profile', 'art.txt');
  try {
    if (!fs.existsSync(artPath)) return null;
    const raw = fs.readFileSync(artPath, 'utf-8').replace(/\r\n/g, '\n').replace(/\s+$/, '');
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Read all workspace data at once
 */
export function readWorkspaceData(workspacePath: string): WorkspaceData {
  return {
    settings: readSettings(),
    tasks: readBoard(workspacePath),
    goals: readGoals(workspacePath),
    projects: readProjects(workspacePath),
    cronJobs: readCronJobs(workspacePath),
    wikiPages: readWikiPages(workspacePath),
    agents: readAgents(workspacePath),
    inboxPlans: readInboxPlans(workspacePath),
  };
}

/**
 * Phase 3.5 of the Endeavors PM overhaul — read every orphan plan
 * file at `Endeavors/_inbox/plans/<X-ULID>.md`. Cold-stored
 * (discarded) plans live at `Endeavors/_inbox/cold/` and are
 * deliberately not surfaced — the BoardPane only cares about
 * orphans waiting for a parent. Returns an empty array when the
 * inbox doesn't exist (un-migrated workspace).
 */
export function readInboxPlans(workspacePath: string): InboxPlan[] {
  const inboxDir = path.join(workspacePath, 'Endeavors', '_inbox', 'plans');
  if (!fs.existsSync(inboxDir)) return [];
  const out: InboxPlan[] = [];
  const today = Date.now();
  for (const entry of fs.readdirSync(inboxDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filenameStem = entry.name.replace(/\.md$/, '');
    const filePath = path.join(inboxDir, entry.name);
    let raw = '';
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) continue;
    const yaml = fmMatch[1];

    // The inbox plan YAML is a flat shape — id / title / status /
    // created / suggested_parent_kind / suggested_paths array.
    // Hand-roll a tiny parser to keep this file dep-free, mirroring
    // `parseProjectFrontmatter`.
    //
    // V11 close (bright-muffin, 2026-05-06) — read the canonical
    // `id:` from frontmatter rather than deriving it from the
    // filename stem. Plans now write under generated label
    // filenames, so the stem is
    // not the X-ULID. Falls back to the stem only when the
    // frontmatter is missing the field entirely (legacy plans
    // saved before the X-ULID field landed).
    const idFromFm =
      yaml.match(/^id:\s*(.+)$/m)?.[1]?.trim().replace(/['"]/g, '');
    const id = idFromFm && idFromFm.length > 0 ? idFromFm : filenameStem;
    const title =
      yaml.match(/^title:\s*(.+)$/m)?.[1]?.trim().replace(/['"]/g, '') ?? id;
    const created =
      yaml.match(/^created:\s*(.+)$/m)?.[1]?.trim().replace(/['"]/g, '') ?? '';
    const status =
      yaml.match(/^status:\s*(\w+)/m)?.[1] ?? 'orphan';
    if (status !== 'orphan') continue;
    const kindRaw = yaml.match(/^suggested_parent_kind:\s*(.+)$/m)?.[1]?.trim();
    const suggestedParentKind =
      kindRaw && kindRaw !== 'null' && kindRaw !== '~'
        ? (kindRaw.replace(/['"]/g, '') as InboxPlan['suggestedParentKind'])
        : undefined;

    // suggested_paths — block list under the key.
    const suggestedPaths: string[] = [];
    const lines = yaml.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      if (lines[i].startsWith('suggested_paths:')) {
        i++;
        while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
          suggestedPaths.push(
            lines[i]
              .replace(/^\s*-\s+/, '')
              .trim()
              .replace(/['"]/g, ''),
          );
          i++;
        }
        break;
      }
      i++;
    }

    let ageDays = 0;
    if (created) {
      const ts = Date.parse(created);
      if (!Number.isNaN(ts)) {
        ageDays = Math.max(0, Math.floor((today - ts) / 86_400_000));
      }
    }

    out.push({
      id,
      title,
      created,
      ageDays,
      suggestedParentKind,
      suggestedPaths,
    });
  }
  return out;
}

/**
 * Phase 3.5 — score how well an orphan plan fits a candidate
 * project. A plan's `suggestedPaths` are matched against the
 * project's declared `paths:`; each suggested-path prefix that is
 * fully contained by one of the project paths counts as +1. Pure
 * count, not normalised — the BoardPane uses it for ordering only.
 */
export function scoreInboxMatch(plan: InboxPlan, projectPaths: string[]): number {
  if (!plan.suggestedPaths || plan.suggestedPaths.length === 0) return 0;
  if (!projectPaths || projectPaths.length === 0) return 0;
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const allowed = projectPaths.map(norm);
  let score = 0;
  for (const sp of plan.suggestedPaths) {
    const p = norm(sp);
    if (allowed.some(a => p === a || p.startsWith(`${a}/`) || a.startsWith(`${p}/`))) {
      score += 1;
    }
  }
  return score;
}
