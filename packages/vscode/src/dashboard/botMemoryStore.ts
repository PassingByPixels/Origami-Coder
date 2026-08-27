// botMemoryStore.ts - the shell's half of PER-BOT MEMORY.
//
// A bot is a character that keeps working across sessions, so it keeps a store
// of its own: NOT the project's memory, NOT the user's global one, and above
// all not a chat session's storage, which dies with the chat. The engine writes
// it (packages/engine/src/agent/bot-memory.ts) and injects it at the top of the
// bot's turns. This module does the two things a human does with it from the
// Bots section - SEE what a bot has kept, and WIPE it.
//
// WHERE IT LIVES: `<configDir>/bot/<slug>/memory/`, a SIBLING of the `agent/`
// directory the definition sits in. Outside `agent/` on purpose - the engine's
// loader globs `agent/**` for markdown, so a memory file under it would be
// loaded as an agent definition named `crane.memory/general`.
//
// THE FENCE, and why this is a module rather than a `path.join` at a call site.
// `clear` is destructive and its slug arrives over a webview message. Every
// path here goes through `resolveInBotRoot`, which RESOLVES the candidate and
// refuses anything that is not strictly inside the root: traversal, absolute
// paths, and the prefix-sibling trap (`<root>-evil` starts with `<root>` as a
// string and is not inside it). The slug is slugged FIRST - so `../../etc` has
// already collapsed to `etc` - and then fenced anyway: the slug is the sane
// path, the fence is the guarantee.
//
// `configDir` is a REQUIRED argument with no default. A caller has to say which
// config directory it means, so no path in this file can quietly resolve the
// developer's real one - which is what lets every test here run on a fixture.

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
 * One filesystem-safe segment for a definition name - the engine's own rule
 * (bot-memory.ts `slug`), mirrored so the shell resolves the SAME directory the
 * engine writes. A nested definition is named `team/crane`, so the slash is
 * FLATTENED rather than followed: a bot's directory is always exactly one level
 * under `bot/`, which is what makes the fence's root a fixed, checkable string.
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
 * `path.relative` is the check, not a `startsWith` on the string: a prefix
 * comparison accepts `<root>-evil`, and a `..` segment can appear anywhere in
 * the path, not just at the front. An empty result means the target IS the
 * root, which is a directory and never a write or delete target.
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
 * Read a bot's store. An absent or unreadable store is EMPTY, never an error: a
 * bot that has not remembered anything yet is the ordinary case, and the pane
 * has to render it as "nothing kept" rather than as a failure.
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
    // The INDEX is not a topic. Counting its hook lines would inflate every
    // store by exactly the number of topics it lists.
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
 * Delete a bot's store. Returns an error STRING on refusal rather than throwing,
 * the same shape the def CRUD answers in, so the caller stays a one-liner.
 *
 * ONLY `memory/` goes - the bot's root around it survives, so a future per-bot
 * file beside the store is not collateral of "forget what you know". The target
 * is resolved through the fence rather than joined, so a crafted slug removes
 * nothing: `../agent` fences to `<configDir>/bot/-agent/memory`, which does not
 * exist, and an absolute slug is refused outright.
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
