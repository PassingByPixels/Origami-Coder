// boardViews.ts — the Agents board's rail TABLE, extracted from
// BoardShell.svelte when the Bots section landed and that file stood at 188 of
// its 190-line cap. The shell keeps state, routing and layout; this keeps the
// one array they are all driven from.
//
// The extensibility contract BoardShell.svelte has always stated lives here
// now: every rail entry (id, name, caption, hover title, icon, component) is
// ONE row in VIEWS, the markup routes generically off it, and adding a view
// stays a one-entry change rather than another `{#if}` branch.
//
// A TABLE IN A .ts, not markup: `isViewId` is a validation rule over it (a
// saved id whose view was deleted must degrade to Folds, not to a blank body),
// and a rule earns a test without rendering nine panes to ask it.

import type { Component } from 'svelte';
import AgentManagerPane from './AgentManagerPane.svelte';
import SkillsPane from './SkillsPane.svelte';
import LoopsPane from './LoopsPane.svelte';
import CronsPane from './CronsPane.svelte';
import LabyrinthPane from './LabyrinthPane.svelte';
import InstructionsPane from './InstructionsPane.svelte';
import ToolsPane from './ToolsPane.svelte';
import PluginsPane from './PluginsPane.svelte';
import MCPPane from './MCPPane.svelte';
import CollabAgentsPane from './CollabAgentsPane.svelte';
import { FLOCK_ICON, SKILLS_ICON, LOOPS_ICON, CRONS_ICON, LABYRINTH_ICON, INSTRUCTIONS_ICON, COLLAB_AGENTS_ICON, TOOLS_ICON, PLUGINS_ICON, MCP_ICON } from './boardIcons';

export type ViewId = 'flock' | 'labyrinth' | 'skills' | 'loops' | 'crons' | 'instructions' | 'collabagents' | 'tools' | 'plugins' | 'mcp';

export interface NavEntry {
  id: ViewId;
  /** Full view name, for the host brand bar. */
  name: string;
  /** Abbreviated rail caption (the rail is 48px wide). */
  label: string;
  title: string;
  /** Inline SVG child markup (24x24 viewBox, stroke=currentColor) — static,
   *  never user-derived. Rendered via {@html} inside an <svg> wrapper, the
   *  same pattern MessageRow.svelte / ReadFileCard.svelte already use. */
  icon: string;
  component: Component;
}

// RAIL ORDER is the owner's: the surfaces a session STARTS from first, then
// the two that schedule work, then the reference views. `id` is the persisted
// state key and never moves with a rename — only name/label/title are display.
export const VIEWS: NavEntry[] = [
  // label 'Git' not 'Fol' (owner ruling): the rail's three-letter captions
  // should name what each view DOES, and Folds is git-worktree agents —
  // 'Fol' abbreviated the display name, 'Git' names the function. id/name/
  // title/icon are unchanged; only the short rail caption moved.
  { id: 'flock', name: 'Folds', label: 'Git', title: 'Folds — agents running in isolated git worktrees', icon: FLOCK_ICON, component: AgentManagerPane },
  // NO Collabs overview row here (W6-L3, owner ruling): a live collab is
  // already visible in the Collabs half of the sidebar, the same place an
  // active chat session is — a second rail entry for the same rooms would be
  // a duplicate surface, not a new one.
  // BOTS is the second rail section (W4). The id stays `collabagents`, and
  // that is the same rule the Insights rename follows two rows down: the id
  // is the persisted state key, so renaming it would silently reset every
  // user who had this view open. The ICON is unchanged too, deliberately —
  // it is the same surface under a truer name, and a new glyph would read as
  // a new place.
  { id: 'collabagents', name: 'Bots', label: 'Bot', title: 'Bots — the agent definitions a chat, a collab or a sub-agent runs, with their permissions, skills and memory', icon: COLLAB_AGENTS_ICON, component: CollabAgentsPane },
  { id: 'loops', name: 'Loops', label: 'Loo', title: 'Loops — recurring /loop prompts, persisted across reloads', icon: LOOPS_ICON, component: LoopsPane },
  { id: 'crons', name: 'Crons', label: 'Cro', title: 'Crons — scheduled runs that fire with VS Code closed', icon: CRONS_ICON, component: CronsPane },
  { id: 'skills', name: 'Skills', label: 'Ski', title: 'Skills — the workspace skill catalogue', icon: SKILLS_ICON, component: SkillsPane },
  { id: 'labyrinth', name: 'Labyrinth', label: 'Lab', title: 'Labyrinth — review a past run as a map of its steps', icon: LABYRINTH_ICON, component: LabyrinthPane },
  // id stays 'instructions' so a saved view survives the rename to Insights.
  { id: 'instructions', name: 'Insights', label: 'Ins', title: 'Insights — every file feeding the system prompt, with its size', icon: INSTRUCTIONS_ICON, component: InstructionsPane },
  { id: 'tools', name: 'Tools', label: 'Too', title: 'Tools — every tool the model can reach, and which of them cost context', icon: TOOLS_ICON, component: ToolsPane },
  { id: 'plugins', name: 'Plugins', label: 'Plu', title: 'Plugins — installed agent-plugins.org packages, their skills and MCP servers', icon: PLUGINS_ICON, component: PluginsPane },
  // MCP sits after Plugins because a plugin can BRING a server: reading the
  // plugin row first is what makes a plugin-sourced server here make sense.
  { id: 'mcp', name: 'MCP', label: 'Mcp', title: 'MCP — every MCP server the engine knows, with its live connection, and the controls that change it', icon: MCP_ICON, component: MCPPane },
];

export const DEFAULT_VIEW: ViewId = 'flock';

/** Validated against VIEWS rather than a hardcoded list, so a saved id whose
 *  view was DELETED degrades to Folds instead of to an empty body. */
export function isViewId(v: unknown): v is ViewId {
  return VIEWS.some((entry) => entry.id === v);
}

/**
 * The rail entry a host-side section request names.
 *
 * The collab room's "Manage bots" link cannot post a ViewId: it is a different
 * webview, and the id it would have to know is the historical `collabagents`
 * rather than the name on the rail. So the request carries the SECTION word the
 * user sees, and the mapping lives here beside the table it maps into.
 */
export function viewForSection(section: string): ViewId | undefined {
  return section === 'bots' ? 'collabagents' : isViewId(section) ? section : undefined;
}
