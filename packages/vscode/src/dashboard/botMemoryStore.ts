// botMemoryStore.ts - the shell's half of per-bot memory: NOT the project's,
// NOT the user's global store, and not a chat session's (which dies with the
// chat). The engine writes it; this module shows and wipes it.
//
// Lives at `<configDir>/bot/<slug>/memory/`, a SIBLING of `agent/` — inside
// `agent/` it would be loaded as an agent definition by the engine's loader.
//
// `clear` is destructive and its slug arrives over a webview message, so every
// path goes through `resolveInBotRoot`, which refuses anything not strictly
// inside the root (traversal, absolute paths, prefix-sibling tricks).

import * as fs from 'node:fs';
import path from 'node:path';

/** Directory name holding every bot's private state, beside `agent/`. */
export const BOT_DIR = 'bot';
/** The foldered store inside a bot's root - MemoryLayout.MEMORY_DIR. */
export const MEMORY_DIR = 'memory';
/** The index the engine writes beside the topic files. Not a topic itself. */
export const INDEX_FILE = 'MEMORY.md';

/** A path that would land outside the bot's own directory. */
export class OutsideBotRootError extends Error {
  constructor(readonly root: string, readonly requested: string) {
    super(`refusing a bot-memory path outside its root: ${requested} is not inside ${root}`);
    this.name = 'OutsideBotRootError';
  }
}

/**
 * One filesystem-safe segment for a definition name, mirroring the engine's
 * own slug rule so the shell resolves the same directory the engine writes.
 * A nested name is flattened to one level under `bot/`.
 */
export function botSlug(agentName: string): string {
  const cleaned = agentName.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'bot';
}

/** `<configDir>/bot/<slug>` - everything one bot privately owns. */
export function botMemoryRoot(configDir: string, agentName: string): string {
  return path.join(configDir, BOT_DIR, botSlug(agentName));
}

/** `<configDir>/bot/<slug>/memory` - the foldered store inside that root. */
export function botMemoryDir(configDir: string, agentName: string): string {
  return path.join(botMemoryRoot(configDir, agentName), MEMORY_DIR);
}

/**
 * Resolve `relative` inside `rootDir`, or throw.
 *
 * Uses `path.relative`, not `startsWith` — a prefix compare would accept
 * `<root>-evil`, and `..` can appear anywhere in the path, not just the front.
 */
export function resolveInBotRoot(rootDir: string, relative: string): string {
  const base = path.resolve(rootDir);
  const target = path.resolve(base, relative);
  const rel = path.relative(base, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new OutsideBotRootError(base, relative);
  return target;
}

/** One topic file in a bot's store, and how many facts it holds. */
export interface BotMemoryTopic {
  topic: string;
  facts: number;
}

/** A bot's store, as the pane shows it. */
export interface BotMemoryStore {
  /** The directory, named so the pane can tell the user where to look. */
  dir: string;
  topics: BotMemoryTopic[];
  /** Total remembered bullets across every topic. */
  facts: number;
  /** Every topic file concatenated, for the read-only view. */
  text: string;
}

/** A remembered fact is a top-level `- ` bullet - MemoryLayout.bulletsOf. */
const bulletsOf = (text: string): string[] =>
  text.split(/\r?\n/).filter((line) => /^-\s+\S/.test(line));

/**
 * Read a bot's store. An absent or unreadable store is EMPTY, never an
 * error — a bot that hasn't remembered anything yet is the ordinary case.
 */
export function readBotMemory(configDir: string, agentName: string): BotMemoryStore {
  const dir = botMemoryDir(configDir, agentName);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { dir, topics: [], facts: 0, text: '' };
  }
  const topics: BotMemoryTopic[] = [];
  const parts: string[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.md') || name === INDEX_FILE) continue;
    let text: string;
    try {
      text = fs.readFileSync(resolveInBotRoot(dir, name), 'utf8');
    } catch {
      continue; // one unreadable topic must not hide the rest
    }
    const topic = name.slice(0, -3);
    topics.push({ topic, facts: bulletsOf(text).length });
    parts.push(text.trim());
  }
  return { dir, topics, facts: topics.reduce((n, t) => n + t.facts, 0), text: parts.join('\n\n') };
}

/**
 * Delete a bot's store. Returns an error string on refusal rather than
 * throwing. Only `memory/` is removed — the bot's root survives. The target
 * is resolved through the fence, so a crafted slug removes nothing.
 */
export function clearBotMemory(configDir: string, agentName: string): string | null {
  const root = botMemoryRoot(configDir, agentName);
  let target: string;
  try {
    target = resolveInBotRoot(root, MEMORY_DIR);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
