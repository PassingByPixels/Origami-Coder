// Reads Origami workspace data from disk: settings.toml, BOARD.md, goals/, projects/,
// cron/jobs.json, wiki/pages/

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface WorkspaceData {
  settings: {
    model: string;
    activeAgent: string;
    apiBase: string;
    /** Active mode, surfaced in the dashboard header. `'normal'` if missing. */
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
  /** Orphan plans queued in `Endeavors/_inbox/plans/` waiting for adoption. */
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
  /** File-path prefixes the plan would touch; scored against a project's `paths:`. */
  suggestedPaths: string[];
}

export interface AgentProfile {
  id: string;
  name: string;
  archetype: string;
}

/**
 * Mirrors the Rust `wiki::Task` schema. `status` is a 5-state projection of the
 * 12-state Rust enum; the source-of-truth value is preserved in `rawStatus`.
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
 * Carries the additive frontmatter (`parent_goal`, `phase`, `paths`) plus the
 * task list read from YAML frontmatter. `done` / `total` derive from that list.
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
   * Raw outbound link targets parsed from the page body — `[[wikilinks]]` and
   * relative markdown links to other `.md` files. Left unresolved here; the
   * memory graph resolves them to page ids against the full page set.
   */
  links: string[];
}

/** Find the workspace path from ~/.origami/settings.toml */
export function findWorkspacePath(): string | null {
  const settingsPath = path.join(os.homedir(), '.origami', 'settings.toml');
  if (!fs.existsSync(settingsPath)) return null;
  const content = fs.readFileSync(settingsPath, 'utf-8');
  const match = content.match(/workspace_path\s*=\s*'([^']+)'/);
  return match ? match[1] : null;
}

/** Read settings.toml for model name, active agent, etc. */
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
  // Mode-centric fields. Tolerate missing keys in a legacy settings.toml.
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

/** Read cron/jobs.json — up to 10 jobs sorted by next_run_at. */
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

/** Read BOARD.md — parse markdown task sections. */
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
 * Read `goals/<slug>/goal.md` — the subdirectory-per-goal shape Rust's
 * `wiki::ops::goal_create` writes; the slug is the goal's stable id.
 *
 * The phase-chip regex here matches the Rust-side writer
 * (`wiki::ops::goal_set_phases` / `goal_recompute_chips`) exactly. Both sides
 * MUST stay in lockstep.
 */
export function readGoals(workspacePath: string): GoalItem[] {
  const goals: GoalItem[] = [];
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

  // Legacy layout — surface goals not yet migrated; skip seen slugs.
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

    // Phase-chip gates: `- [x] Phase A1: Core runtime scaffold (5/5 tasks)`,
    // matching the Rust writer in `wiki::ops::format_chip_line`.
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

    // Roll percentage from the chips when available — summed task counts beat a
    // hand-typed `Progress:` line. Fall back to that line if no chips.
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

/** Read wiki/pages/*.md files. */
export function readWikiPages(workspacePath: string): WikiPage[] {
  return readWikiPagesFromDir(path.join(workspacePath, 'wiki', 'pages'), path.join(workspacePath, 'wiki'));
}

/**
 * The folder the memory graph sources by default: `<workspace>/wiki/pages`. The
 * wiki is ALWAYS the direct `wiki/pages`, empty or not. Callers pass the open
 * VS Code folder as the base.
 */
export function resolveDefaultWikiPages(workspacePath: string): string {
  return path.join(workspacePath, 'wiki', 'pages');
}

/** Read .md files recursively from an arbitrary directory. Used when the user
 *  picks a custom memory-graph folder. */
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
 * Parse outbound link targets from a page body — raw targets, resolved to page
 * ids downstream:
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
 * Read project pages from `<workspace>/wiki/pages/projects/*.md` — the path
 * `wiki::ops::project_create` writes to. Reads the YAML frontmatter directly so
 * structured Task fields come through faithfully. The frontmatter is a
 * constrained serde_yaml shape, so the parser below handles the needed fields
 * without a YAML library; anything it cannot parse degrades to defaults.
 */
export function readProjects(workspacePath: string): ProjectItem[] {
  const projects: ProjectItem[] = [];

  // Load every per-task file once, grouped by project_id. Inline `tasks:` is a
  // fallback only for projects with zero per-task files.
  const tasksByProjectId = readPerTaskFilesByProject(workspacePath);

  // Read the Endeavors layout first: each project lives at
  // `Endeavors/projects/<P-ULID>/project.md` with `id` + `slug` in frontmatter.
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

      // Prefer per-task files; inline `fm.tasks` is the un-migrated fallback.
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

  // Legacy fallback — surface projects not yet migrated; skip seen slugs.
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
 * Minimal YAML frontmatter parser shaped for the `wiki::ProjectFrontmatter`
 * write format: scalar fields, the `tasks:` block list and simple string arrays.
 * Returns `null` when there is no `---` fence. Hand-rolled rather than js-yaml
 * because the input shape is fixed by serde_yaml and this is a read path.
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
 * Walk `Endeavors/tasks/*.md` once and group every per-task file by its
 * `project: P-XXX` backlink. Values are in directory-listing order. Cheap on
 * every refresh; skips malformed files silently rather than failing.
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
 * Parse a single per-task file. Frontmatter (from `task_save_to_file` in
 * crates/wiki/src/endeavors.rs): `project`, `id`, `name`, `status`,
 * `assigned_to`, `priority`, `depends_on`, `acceptance_criteria`, `plan_link`.
 * Returns `null` when `project:` or `name:` is missing.
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
 * Shared finalisation for TaskItem rows: both the per-task-file path and the
 * inline fallback go through it, so the visible shape stays identical.
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
    const scalarMatch = line.match(/^([a-z_]+)\s*:\s*(.*)$/);
    if (!scalarMatch) {
      i++;
      continue;
    }
    const key = scalarMatch[1];
    const rawValue = scalarMatch[2];

    if (rawValue && rawValue !== '~' && rawValue !== 'null') {
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
        // A task block starts with `- name: ...` and ends at the next `-` at the
        // same indent.
        const taskLines: string[] = [];
        const startIndent = lines[i].match(/^(\s*)-/)?.[1].length ?? 0;
        taskLines.push(lines[i].replace(/^\s*-\s+/, ''));
        i++;
        while (i < lines.length) {
          const cur = lines[i];
          if (/^\s*-\s+/.test(cur) && (cur.match(/^(\s*)-/)?.[1].length ?? 0) <= startIndent) {
            break;
          }
          if (/^\S/.test(cur)) {
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
 * Project the 12-state Rust `TaskStatus` down to the 5 visual states the
 * dashboard renders. Unknown status defaults to `pending`.
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
 * V1 is single-agent: identity is a fixed fact, not a filesystem roster. The
 * brand identity is Tsuru; `archetype` stays the internal `coder` body.
 */
export function readAgents(_workspacePath: string): AgentProfile[] {
  return [{ id: 'tsuru', name: 'Tsuru', archetype: 'coder' }];
}

/**
 * Resolve an internal agent value (settings.toml `active_agent`, an archetype
 * like `coder`, or a roster id like `tsuru`) to the display label. NOTHING the
 * user sees should read `coder`. Unknown values fall back to the brand default.
 */
export function displayAgentName(internal?: string): string {
  const roster = readAgents('');
  if (internal) {
    const v = internal.trim().toLowerCase();
    const hit = roster.find(
      (a) => a.id.toLowerCase() === v || a.archetype.toLowerCase() === v || a.name.toLowerCase() === v,
    );
    if (hit) return hit.name;
    // An UNKNOWN agent id renders as ITSELF (capitalised) rather than
    // masquerading as the brand default.
    if (v) return v.charAt(0).toUpperCase() + v.slice(1);
  }
  // Empty / unset — brand default is the first roster entry (Tsuru).
  return roster[0]?.name ?? 'Tsuru';
}

/**
 * Read the agent's `profile/art.txt` for the chat-banner ASCII art. Null when
 * missing or empty, so callers can render the banner conditionally.
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

/** Read all workspace data at once. */
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
 * Read every orphan plan at `Endeavors/_inbox/plans/<X-ULID>.md`. Cold-stored
 * plans at `Endeavors/_inbox/cold/` are deliberately not surfaced. Empty array
 * when the inbox does not exist.
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

    // The inbox plan YAML is a flat shape; hand-roll a tiny parser mirroring
    // `parseProjectFrontmatter`. Read the canonical `id:` from frontmatter and
    // fall back to the filename stem only for legacy plans that lack the field.
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
 * Score how well an orphan plan fits a candidate project: each `suggestedPaths`
 * prefix fully contained by one of the project's `paths:` counts as +1. Pure
 * count, not normalised — used for ordering only.
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
