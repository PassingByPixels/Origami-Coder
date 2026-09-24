// boardViews.ts — the Agents board's rail table: every rail entry (id, name,
// caption, hover title, icon, component) is one row in VIEWS, and the markup
// routes generically off it, so adding a view is a one-entry change.
//
// A table in a .ts, not markup: `isViewId` validates it (a deleted view's saved
// id degrades to Folds, not a blank body) and earns a test without a render.

import type { Component } from 'svelte';
import AgentManagerPane from './AgentManagerPane.svelte';
import SkillsPane from './SkillsPane.svelte';
import SchedulesPane from './SchedulesPane.svelte';
import LabyrinthPane from './LabyrinthPane.svelte';
import InstructionsPane from './InstructionsPane.svelte';
import ToolsPane from './ToolsPane.svelte';
import PluginsPane from './PluginsPane.svelte';
import MCPPane from './MCPPane.svelte';
import CollabAgentsPane from './CollabAgentsPane.svelte';
import RemotePane from './RemotePane.svelte'; import FlockPane from './FlockPane.svelte'; import ArtifactsPane from './ArtifactsPane.svelte'; import NestsPane from './NestsPane.svelte'; import SettingsPane from './SettingsPane.svelte';
import { FLOCK_ICON, SKILLS_ICON, CRONS_ICON, LABYRINTH_ICON, INSTRUCTIONS_ICON, COLLAB_AGENTS_ICON, TOOLS_ICON, PLUGINS_ICON, MCP_ICON } from './boardIcons'; import { REMOTE_ICON, FLOCK_FRIENDS_ICON } from './boardIconsPeer'; import { ARTIFACTS_ICON } from './boardIconsArtifacts'; import { NESTS_ICON, SETTINGS_ICON } from './boardIconsNests'; import { noteRequestedTab } from './scheduleTabRequest';

// `friends` is the Flock view's id, not `flock`: that word is already the
// Folds view's persisted id, and freeing it would reset every user's Folds.
// t-ru1qsp: `loops` and `crons` folded into one `schedules` id (owner: "one
// icon one word"). Both words still name a REQUEST section (viewForSection
// below), never a ViewId — a saved `loops`/`crons` from before the fold no
// longer matches a row and degrades to Folds, the same as any deleted view.
export type ViewId = 'artifacts' | 'flock' | 'labyrinth' | 'skills' | 'schedules' | 'instructions' | 'collabagents' | 'tools' | 'plugins' | 'mcp' | 'remote' | 'nests' | 'friends' | 'settings';

export interface NavEntry {
  id: ViewId;
  /** Full view name, for the host brand bar. */
  name: string;
  /** Abbreviated rail caption (the rail is 48px wide). */
  label: string;
  title: string;
  /** Inline SVG (24x24 viewBox, stroke=currentColor) — static, never
   *  user-derived. Rendered via {@html}, same pattern as MessageRow.svelte. */
  icon: string;
  component: Component;
  foot?: boolean; // drawn at the rail's FOOT, above Docs (t-s9jr6u Settings)
}

// Rail order is deliberate: session-start surfaces first, then scheduling, then
// reference views. `id` is the persisted state key and never moves.
export const VIEWS: NavEntry[] = [
  { id: 'flock', name: 'Folds', label: 'Git', title: 'Folds — agents running in isolated git worktrees', icon: FLOCK_ICON, component: AgentManagerPane },
  // No separate rail row for Collabs: a live collab is already visible in
  // the sidebar, and `collabagents` keeps its id since it predates the rename.
  { id: 'collabagents', name: 'Bots', label: 'Bot', title: 'Bots — the agent definitions a chat, a collab or a sub-agent runs, with their permissions, skills and memory', icon: COLLAB_AGENTS_ICON, component: CollabAgentsPane },
  // Loops and Crons folded into one row (owner: "one icon one word, and
  // inside the UI are our Crons and Loops tabs"). The clock glyph is reused
  // rather than drawn twice over: Crons fires on a wall-clock time even with
  // VS Code closed, which is the more literal reading of "Schedules", and the
  // repeat-arrows glyph (still CRONS_ICON's sibling in boardIcons.ts) would
  // read as "only loops" to someone who has not opened the view yet.
  { id: 'schedules', name: 'Schedules', label: 'Sch', title: 'Schedules — crons that fire with VS Code closed, and loops that repeat while a chat stays open', icon: CRONS_ICON, component: SchedulesPane },
  { id: 'skills', name: 'Skills', label: 'Ski', title: 'Skills — the workspace skill catalogue', icon: SKILLS_ICON, component: SkillsPane },
  { id: 'labyrinth', name: 'Labyrinth', label: 'Lab', title: 'Labyrinth — review a past run as a map of its steps', icon: LABYRINTH_ICON, component: LabyrinthPane },
  // id stays 'instructions' so a saved view survives the rename to Insights.
  { id: 'instructions', name: 'Insights', label: 'Ins', title: 'Insights — every file feeding the system prompt, with its size', icon: INSTRUCTIONS_ICON, component: InstructionsPane },
  { id: 'tools', name: 'Tools', label: 'Too', title: 'Tools — every tool the model can reach, and which of them cost context', icon: TOOLS_ICON, component: ToolsPane },
  { id: 'plugins', name: 'Plugins', label: 'Plu', title: 'Plugins — installed agent-plugins.org packages, their skills and MCP servers', icon: PLUGINS_ICON, component: PluginsPane },
  // MCP sits after Plugins because a plugin can BRING a server: reading the
  // plugin row first is what makes a plugin-sourced server here make sense.
  { id: 'mcp', name: 'MCP', label: 'Mcp', title: 'MCP — every MCP server the engine knows, with its live connection, and the controls that change it', icon: MCP_ICON, component: MCPPane },
  // The two off-machine views sit last, together: everything above is about
  // this editor; these two are a phone in a pocket and a friend's Origami.
  // Artifacts sits with the off-machine pair: an artifact is one object in the
  // device group, and the pane's whole subject is the copy on the other machine.
  { id: 'artifacts', name: 'Artifacts', label: 'Art', title: 'Artifacts — the pages and reports your agents made, with every version and the device it came from', icon: ARTIFACTS_ICON, component: ArtifactsPane },
  { id: 'remote', name: 'Remote', label: 'Rem', title: 'Remote — pair a phone to watch, send, stop and approve this machine from anywhere', icon: REMOTE_ICON, component: RemotePane },
  // t-s9jr6u: Nests directly after Remote — both reach other devices over the relay.
  { id: 'nests', name: 'Nests', label: 'Nes', title: 'Nests — join your desks, and set what each desk keeps', icon: NESTS_ICON, component: NestsPane },
  { id: 'friends', name: 'Flock', label: 'Flo', title: 'Flock — the contacts whose Origami you may ask, and the front desk that answers theirs', icon: FLOCK_FRIENDS_ICON, component: FlockPane },
  { id: 'settings', name: 'Settings', label: 'Set', title: 'Settings — chat, agents, browser, cache and look', icon: SETTINGS_ICON, component: SettingsPane, foot: true },
];

export const DEFAULT_VIEW: ViewId = 'flock';

/** Validated against VIEWS rather than a hardcoded list, so a saved id whose
 *  view was DELETED degrades to Folds instead of to an empty body. */
export function isViewId(v: unknown): v is ViewId {
  return VIEWS.some((entry) => entry.id === v);
}

/**
 * The rail entry a host-side section request names. The collab room's
 * "Manage bots" link cannot post a ViewId — it is a different webview and
 * would need the historical `collabagents` id — so the request carries the
 * section word the user sees, mapped here beside the table it maps into.
 *
 * `crons` and `loops` are legacy section words (deep links predating the
 * t-ru1qsp fold): both now resolve to `schedules`, and the SPECIFIC one named
 * is remembered via noteRequestedTab (scheduleTabRequest.ts) so SchedulesPane
 * can open on the matching tab. BoardShell.svelte is at its 190-line cap with
 * no slack for a second call site, which is why this single, already-existing
 * call carries the side effect rather than a sibling function BoardShell
 * would also have to call.
 */
export function viewForSection(section: string): ViewId | undefined {
  if (section === 'bots') return 'collabagents';
  if (section === 'crons' || section === 'loops') { noteRequestedTab(section); return 'schedules'; }
  return isViewId(section) ? section : undefined;
}
