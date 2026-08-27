// The bot contract ON A DEF FILE — parse, serialize, and the save path.
//
// botContract.test.ts proves the frontmatter keys read and write correctly in
// isolation, and botTools.test.ts does the same for the permission block the
// tool checklist writes. This proves they survive what actually happens: a def is
// read off disk, shown in a form, sent back across the message boundary and
// written again. Three seams, and every one of them has a way to lose a field:
//
//   parseAgentDef        can drop a key it does not know about
//   serializeAgentDef    can omit one it was given, or invent one it was not
//   defFromForm          forwards STATED fields only, so a key it does not
//                        list can never reach the writer at all — which is how
//                        a hand-added `vision:` line used to vanish
//
// The whole point of the contract is that a bot stays configured. A field that
// silently resets on an unrelated save is the failure this file exists for.

import { describe, it, expect } from 'vitest';
import { parseAgentDef, serializeAgentDef } from '../../../src/dashboard/collabAgentDef';
import { defFromForm } from '../../../src/dashboard/collabAgentDefForm';

const FULL = [
  '---',
  'description: "Reviews the claim"',
  'mode: all',
  'hidden: true',
  'collab: true',
  'model: lmstudio/qwen-32b',
  'permissions: strict',
  'memory: false',
  'steps: 25',
  'permission:',
  '  "*": deny',
  '  read: allow',
  '  glob: allow',
  '  grep: allow',
  '---',
  '',
  'You are Heron.',
  '',
].join('\n');

describe('parseAgentDef — a def carries its bot contract', () => {
  it('reads every contract key off the file', () => {
    expect(parseAgentDef('collab-heron', FULL)!.bot).toEqual({ tier: 'strict', memory: false });
  });

  // WHICH TOOLS is the other half of the contract since W6, and it lives in the
  // permission BLOCK rather than in a frontmatter scalar — so it crosses the
  // same three seams and can be lost at any of them.
  it('reads the tool ticks off the permission block', () => {
    expect(parseAgentDef('collab-heron', FULL)!.tools).toEqual(['glob', 'grep', 'read']);
  });

  // The default state of every def already on disk. An empty object, not
  // undefined, so the form can bind to it without a null check — but with no
  // field set, so nothing renders as chosen.
  it('gives a def that declares none of them an EMPTY contract', () => {
    const plain = ['---', 'description: "x"', 'mode: all', 'collab: true', 'steps: 40', '---', '', 'You are X.', ''].join('\n');
    expect(parseAgentDef('collab-x', plain)!.bot).toEqual({});
  });
});

describe('serializeAgentDef — the contract is written, and only what was stated', () => {
  it('round-trips a fully-declared def back to the same contract', () => {
    const parsed = parseAgentDef('collab-heron', FULL)!;
    expect(parseAgentDef('collab-heron', serializeAgentDef(parsed))!.bot).toEqual(parsed.bot);
  });

  // The sharpest regression this file guards. A def with no contract must come
  // back out with no contract lines: stamping `permissions: open` (or any other
  // "harmless" default) onto every save would make every existing agent look
  // deliberately configured, and would change what the engine does with the
  // ones whose own `permission:` block was the only thing speaking for them.
  it('writes NO contract line for a def that declared none', () => {
    const plain = ['---', 'description: "x"', 'mode: all', 'collab: true', 'steps: 40', '---', '', 'You are X.', ''].join('\n');
    const out = serializeAgentDef(parseAgentDef('collab-x', plain)!);
    expect(out).not.toMatch(/^permissions:/m);
    expect(out).not.toMatch(/^memory:/m);
    // ...and the two keys W6 stripped are not written back for anybody.
    expect(out).not.toMatch(/^skills:/m);
    expect(out).not.toMatch(/^model_prefer:/m);
  });

  // `memory: true` IS the engine default. Writing it would put a line in every
  // file to say nothing — the rule `vision:` already follows.
  it('omits memory when it is on and writes it when it is off', () => {
    const base = parseAgentDef('collab-x', FULL)!;
    expect(serializeAgentDef({ ...base, bot: { memory: true } })).not.toMatch(/^memory:/m);
    expect(serializeAgentDef({ ...base, bot: { memory: false } })).toMatch(/^memory: false$/m);
  });

  // The permission BLOCK and the tier are different statements and the engine
  // composes them (a tier is a starting point, an explicit block beats it). A
  // serializer that dropped one when the other was present would silently widen
  // or narrow what the bot may do.
  it('writes the tier ALONGSIDE the preset permission block, never instead of it', () => {
    const out = serializeAgentDef({ ...parseAgentDef('collab-x', FULL)!, preset: 'observer', bot: { tier: 'strict' } });
    expect(out).toMatch(/^permissions: strict$/m);
    expect(out).toMatch(/^permission:$/m);
  });
});

describe('defFromForm — an unstated contract must not reach the writer', () => {
  // Same rule preset/vision/visionProfile already follow, and for the same
  // reason: the writer resolves an ABSENT field from the file on disk, so
  // forwarding a fabricated empty contract would wipe a configured bot on any
  // save from a surface that happens not to edit it.
  it('omits `bot` entirely when the message carried none', () => {
    expect('bot' in defFromForm({ slug: 'collab-x', description: 'd' })).toBe(false);
  });

  it('forwards a stated contract through unchanged', () => {
    expect(defFromForm({ slug: 'collab-x', bot: { tier: 'standard', memory: false } }).bot)
      .toEqual({ tier: 'standard', memory: false });
  });

  // The tick set follows the same rule and needs it MORE: it decides what the
  // bot may do, so an absent one resetting to a preset block would widen or
  // narrow an agent on a save that never mentioned tools.
  it('omits `tools` when the message carried none, and forwards an EMPTY set as one', () => {
    expect('tools' in defFromForm({ slug: 'collab-x' })).toBe(false);
    expect(defFromForm({ slug: 'collab-x', tools: [] }).tools).toEqual([]);
    expect(defFromForm({ slug: 'collab-x', tools: ['read', 'bad key', 42] as never }).tools).toEqual(['read']);
  });

  // The message boundary is untrusted JSON: a `bot` that is not an object, or
  // whose fields are the wrong shape, must not be written into a def file.
  it('drops a bot field that is not the shape the contract declares', () => {
    expect('bot' in defFromForm({ slug: 'collab-x', bot: 'strict' })).toBe(false);
    expect(defFromForm({ slug: 'collab-x', bot: { tier: 'nope', memory: 'yes' } }).bot)
      .toEqual({ unknownTier: 'nope' });
  });
});

/**
 * THE DRIFT GUARD FOR THE ENGINE'S COPY OF THIS FILE FORMAT.
 *
 * `packages/engine/test/collab/hot-defs.test.ts` and
 * `packages/engine/test/acp/bot-session-agent.test.ts` both stand a fixture up
 * as "what the Bots pane saves", and neither package can import the other. The
 * three lines below are the ones the ENGINE's mode filter reads, so if this
 * serializer stops writing one of them, those fixtures stop describing reality
 * and the W7 failure repeats: a route refused in UAT, green in CI, because the
 * test was fed a def shape nobody has on disk.
 *
 * `hidden: true` is the load-bearing one. It is why a bot is not on the chat
 * picker, and why "Start session" on a bot had to be taught that a hidden
 * definition is still an identity (engine acp/directory.ts modeOptionsFrom).
 */
describe('serializeAgentDef — the header the engine reads', () => {
  const header = (over: Parameters<typeof serializeAgentDef>[0]) => serializeAgentDef(over).split('\n');
  const base = { slug: 'crane', description: 'A bot', model: '', glyph: '', persona: 'You are Crane.' };

  it('writes mode, hidden and collab on every saved def', () => {
    const lines = header({ ...base, preset: 'worker' });
    expect(lines).toContain('mode: all');
    expect(lines).toContain('hidden: true');
    expect(lines).toContain('collab: true');
  });

  it('keeps mode and hidden on a vision profile too', () => {
    // A profile takes the OTHER marker, so `collab: true` is correctly absent —
    // but it is still a hidden `mode: all` agent to the engine.
    const lines = header({ ...base, preset: 'worker', visionProfile: true });
    expect(lines).toContain('mode: all');
    expect(lines).toContain('hidden: true');
    expect(lines).toContain('vision-profile: true');
    expect(lines).not.toContain('collab: true');
  });
});

/**
 * Two rules the ENGINE's task roster depends on this writer for.
 *
 * `describeTask` (packages/engine/src/tool/registry.ts) renders one line per
 * offerable agent from its `description`, and re-admits the chat's own vision
 * profile as a delegation target. Both of the defects below were written by
 * this serializer and only visible in the engine.
 */
describe('serializeAgentDef — what the task roster reads back', () => {
  const base = { slug: 'crane', description: 'A bot', model: '', glyph: '', persona: 'You are Crane.', preset: 'worker' as const };

  // `description: ""` is not "no description" downstream: the engine's `??`
  // only catches an ABSENT key, so an empty string rendered as `- crane: ` with
  // nothing after the colon. Absent, the engine's own fallback applies.
  it('OMITS description when it is blank rather than writing an empty one', () => {
    expect(serializeAgentDef({ ...base, description: '' })).not.toMatch(/^description:/m);
    expect(serializeAgentDef({ ...base, description: '   ' })).not.toMatch(/^description:/m);
    expect(serializeAgentDef(base)).toMatch(/^description: "A bot"$/m);
  });

  // A vision profile is now a delegation target, and the first thing it does is
  // read a screenshot that almost never lives inside the project. Every block
  // this writer emits opens `"*": deny`, which closes external_directory too.
  it('gives a VISION PROFILE the external_directory ask, and no collab agent one', () => {
    const profile = serializeAgentDef({ ...base, slug: 'vision-eye', visionProfile: true });
    expect(profile).toMatch(/^ {2}external_directory: ask$/m);
    expect(serializeAgentDef(base)).not.toMatch(/external_directory/);
  });

  it('does not add a SECOND copy on a def that already states it', () => {
    // The round trip: read a profile back, save it again. A line appended every
    // time would grow the file on every save.
    const once = serializeAgentDef({ ...base, slug: 'vision-eye', visionProfile: true, preset: 'custom', customPermission: 'permission:\n  "*": deny\n  external_directory: allow' });
    expect(once.match(/external_directory/g)).toHaveLength(1);
    expect(once).toMatch(/external_directory: allow/);
  });

  it('applies to a tick-set block as well as a preset one', () => {
    const ticked = serializeAgentDef({ ...base, slug: 'vision-eye', visionProfile: true, tools: ['read', 'glob'] });
    expect(ticked).toMatch(/^ {2}external_directory: ask$/m);
    expect(ticked).toMatch(/^ {2}read: allow$/m);
  });
})
