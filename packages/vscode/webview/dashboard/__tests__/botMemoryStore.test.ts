// PER-BOT MEMORY, read and cleared from the shell.
//
// The engine owns the store (packages/engine/src/agent/bot-memory.ts). This
// package owns the two things a human does with it from the Bots section: SEE
// what a bot has kept, and WIPE it. The second is destructive and takes a slug
// that arrived over a webview message, which is the whole reason this module
// exists as a fenced leaf instead of a `path.join` at a call site.
//
// EVERY PATH IN THIS FILE IS A FIXTURE DIRECTORY. Nothing here resolves the
// developer's real config dir: `configDir` is a required argument with no
// default, so a test that forgot to pass one would not compile, let alone
// write. (realConfigGuard.ts is the backstop, not the design.)
//
// The fence is the point. `resolveInBotRoot` is asserted against traversal,
// absolute paths and the prefix-sibling trap — `<root>-evil` starts with
// `<root>` as a STRING and is not inside it, which is exactly the case a
// `startsWith` check waves through.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import {
  OutsideBotRootError,
  botMemoryDir,
  botMemoryRoot,
  botSlug,
  clearBotMemory,
  readBotMemory,
  resolveInBotRoot,
} from '../../../src/dashboard/botMemoryStore';

let cfg = '';
beforeEach(() => { cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-botmem-')); });
afterEach(() => { fs.rmSync(cfg, { recursive: true, force: true }); });

const seed = (slug: string, topic: string, body: string) => {
  const dir = botMemoryDir(cfg, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${topic}.md`), body, 'utf8');
};

describe('where a bot store lives — a sibling of agent/, keyed to the definition', () => {
  // Outside `agent/` on purpose: the engine's loader globs `agent/**` for
  // markdown, so a memory file under it would be loaded as an agent definition.
  it('is <configDir>/bot/<slug>, never inside the agent directory', () => {
    expect(botMemoryRoot(cfg, 'collab-crane')).toBe(path.join(cfg, 'bot', 'collab-crane'));
    expect(botMemoryDir(cfg, 'collab-crane')).toBe(path.join(cfg, 'bot', 'collab-crane', 'memory'));
  });

  // A nested definition is named `team/crane`. The slash is FLATTENED, not
  // followed, so a bot's directory is always exactly one level under `bot/` —
  // which is what makes the fence's root a fixed, checkable string.
  it('flattens a nested definition name into ONE segment', () => {
    expect(botSlug('team/crane')).toBe('team-crane');
    expect(botMemoryRoot(cfg, 'team/crane')).toBe(path.join(cfg, 'bot', 'team-crane'));
  });

  it('never returns an empty segment for a name that slugs away to nothing', () => {
    expect(botSlug('...')).toBe('bot');
    expect(botSlug('')).toBe('bot');
  });
});

describe('the fence — resolveInBotRoot refuses anything that is not strictly inside', () => {
  const root = () => path.join(cfg, 'bot', 'collab-crane');

  it('resolves an ordinary relative path', () => {
    expect(resolveInBotRoot(root(), 'memory/general.md')).toBe(path.join(root(), 'memory', 'general.md'));
  });

  it('refuses traversal, wherever the .. sits', () => {
    expect(() => resolveInBotRoot(root(), '../collab-heron/memory/general.md')).toThrow(OutsideBotRootError);
    expect(() => resolveInBotRoot(root(), 'memory/../../escape.md')).toThrow(OutsideBotRootError);
  });

  it('refuses an ABSOLUTE path, which path.join would have silently honoured', () => {
    expect(() => resolveInBotRoot(root(), path.join(os.tmpdir(), 'anywhere.md'))).toThrow(OutsideBotRootError);
  });

  // The trap a startsWith check waves through.
  it('refuses the prefix sibling <root>-evil', () => {
    expect(() => resolveInBotRoot(root(), path.join('..', 'collab-crane-evil', 'x.md'))).toThrow(OutsideBotRootError);
  });

  // The root IS a directory, never a write or delete target.
  it('refuses the root itself', () => {
    expect(() => resolveInBotRoot(root(), '.')).toThrow(OutsideBotRootError);
  });
});

describe('readBotMemory — what the pane shows', () => {
  it('reports an absent store as empty rather than failing', () => {
    expect(readBotMemory(cfg, 'collab-nobody')).toMatchObject({ facts: 0, topics: [] });
  });

  it('counts the remembered bullets per topic and returns the text to read', () => {
    seed('collab-crane', 'general', '# general\n\n- [2026-08-01] Ships on Fridays.\n- [2026-08-02] Hates YAML.\n');
    seed('collab-crane', 'repo', '# repo\n\n- [2026-08-03] The engine is a sibling package.\n');
    const store = readBotMemory(cfg, 'collab-crane');
    expect(store.facts).toBe(3);
    expect(store.topics.map((t) => t.topic).sort()).toEqual(['general', 'repo']);
    expect(store.text).toContain('Ships on Fridays.');
  });

  // MEMORY.md is the index the engine writes beside the topics. It is not a
  // topic and its lines are not facts; counting it would inflate every store.
  it('does not count the MEMORY.md index as a topic', () => {
    seed('collab-crane', 'general', '- [2026-08-01] One fact.\n');
    fs.writeFileSync(path.join(botMemoryDir(cfg, 'collab-crane'), 'MEMORY.md'), '# Memory Index\n\n- [general](general.md) - hook\n', 'utf8');
    const store = readBotMemory(cfg, 'collab-crane');
    expect(store.topics.map((t) => t.topic)).toEqual(['general']);
    expect(store.facts).toBe(1);
  });

  // A slug from a webview message is untrusted input on the READ path too: a
  // traversing slug must not turn a "show me this bot's memory" into a file
  // read somewhere else on disk.
  it('refuses a traversing slug instead of reading outside the bot directory', () => {
    expect(() => readBotMemory(cfg, '../../etc')).not.toThrow();
    expect(readBotMemory(cfg, '../../etc').dir).toBe(path.join(cfg, 'bot', 'etc', 'memory'));
  });
});

describe('clearBotMemory — the destructive one', () => {
  it('removes the store and reports it gone', () => {
    seed('collab-crane', 'general', '- [2026-08-01] One fact.\n');
    expect(clearBotMemory(cfg, 'collab-crane')).toBeNull();
    expect(fs.existsSync(botMemoryDir(cfg, 'collab-crane'))).toBe(false);
    expect(readBotMemory(cfg, 'collab-crane').facts).toBe(0);
  });

  // The bot's own root survives — only `memory/` goes. A future per-bot file
  // beside it (state, a log) must not be collateral of "forget what you know".
  it('deletes ONLY the memory directory, not the bot root around it', () => {
    seed('collab-crane', 'general', '- [2026-08-01] One fact.\n');
    const keep = path.join(botMemoryRoot(cfg, 'collab-crane'), 'notes.txt');
    fs.writeFileSync(keep, 'keep me', 'utf8');
    clearBotMemory(cfg, 'collab-crane');
    expect(fs.existsSync(keep)).toBe(true);
  });

  it('a store that was never written is not an error', () => {
    expect(clearBotMemory(cfg, 'collab-nobody')).toBeNull();
  });

  // THE ONE THAT MATTERS. A slug crafted to escape must delete nothing outside
  // the bot tree — proven by a real sibling file that is still there after.
  it('a traversing slug cannot delete anything outside <configDir>/bot', () => {
    const victim = path.join(cfg, 'agent', 'collab-crane.md');
    fs.mkdirSync(path.dirname(victim), { recursive: true });
    fs.writeFileSync(victim, '---\ncollab: true\n---\n', 'utf8');
    clearBotMemory(cfg, '../agent');
    clearBotMemory(cfg, '..');
    clearBotMemory(cfg, path.join(cfg, 'agent'));
    expect(fs.existsSync(victim)).toBe(true);
    expect(fs.existsSync(path.join(cfg, 'agent'))).toBe(true);
  });
});
