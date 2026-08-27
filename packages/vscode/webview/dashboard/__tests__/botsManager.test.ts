// botsManager — the Bots section's host half.
//
// It holds the four def-CRUD cases that used to sit in collabManager.ts (moved
// out when that dispatcher reached its cap, and moved HERE rather than anywhere
// else because they are what the Bots section is), plus the three things the
// section added: start a session as one bot, read and clear its memory, and the
// board-section handshake the collab room's "Manage bots" link needs.
//
// Every filesystem path below is a FIXTURE. The def writer and the memory store
// both take an explicit directory, so nothing here can resolve the developer's
// own config dir.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import {
  BOT_MESSAGE_TYPES,
  DOCS_URL,
  handleBotMessage,
  type BotsManagerHost,
} from '../../../src/dashboard/botsManager';
import { startBotSession } from '../../../src/dashboard/botSessionStart';

let cfg = '';
let posts: Array<Record<string, unknown>> = [];
let started: Array<[string, string, string]> = [];

const DEF = [
  '---',
  'description: "Builds it"',
  'mode: all',
  'hidden: true',
  'collab: true',
  'permissions: standard',
  'steps: 40',
  'permission:',
  '  "*": deny',
  '  read: allow',
  '  grep: allow',
  '---',
  '',
  'You are Crane.',
  '',
].join('\n');

function host(over: Partial<BotsManagerHost> = {}): BotsManagerHost {
  return {
    post: (m) => { posts.push(m); },
    configDir: () => cfg,
    startBotSession: async (slug, displayName, glyph) => { started.push([slug, displayName, glyph]); },
    ...over,
  };
}

const seedDef = (slug: string, body = DEF) => {
  fs.mkdirSync(path.join(cfg, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'agent', `${slug}.md`), body, 'utf8');
};
const seedMemory = (slug: string, body: string) => {
  const dir = path.join(cfg, 'bot', slug, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'general.md'), body, 'utf8');
};
const last = (type: string) => [...posts].reverse().find((p) => p.type === type);

beforeEach(() => {
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-bots-'));
  posts = [];
  started = [];
});
afterEach(() => fs.rmSync(cfg, { recursive: true, force: true }));

describe('BOT_MESSAGE_TYPES — every type this module owns, and only those', () => {
  it('claims the def CRUD that moved out of collabManager', () => {
    for (const t of ['listCollabAgentDefs', 'saveCollabAgentDef', 'deleteCollabAgentDef', 'collabArchetypeSetModel']) {
      expect(BOT_MESSAGE_TYPES.has(t), t).toBe(true);
    }
  });

  // The return value IS the routing: collabManager falls through to the
  // supervision dispatcher on anything this one did not take, so a message
  // answered `true` by mistake would be silently swallowed.
  it('answers false for a message it does not own, so the caller can fall through', async () => {
    expect(await handleBotMessage(host(), { type: 'collabPoll' })).toBe(false);
    expect(posts).toEqual([]);
  });
});

describe('the def list carries what a BOT card has to show', () => {
  it('lists the defs and their contracts', async () => {
    seedDef('collab-crane');
    expect(await handleBotMessage(host(), { type: 'listCollabAgentDefs' })).toBe(true);
    const reply = last('collabAgentDefs')!;
    const defs = reply.defs as Array<Record<string, unknown>>;
    expect(defs).toHaveLength(1);
    expect(defs[0].bot).toEqual({ tier: 'standard' });
    // WHICH TOOLS it has rides the same reply (W6): the card's Tools row is
    // read off the def's permission block, not off a second request.
    expect(defs[0].tools).toEqual(['grep', 'read']);
  });

  // Memory PRESENCE is the one card fact that is not in the def file: whether
  // this bot has actually kept anything is a property of its store. Carried on
  // the same reply, keyed by slug, so the card needs no second round trip.
  it('reports how many facts each bot has kept, and says nothing about one with no store', async () => {
    seedDef('collab-crane');
    seedDef('collab-heron');
    seedMemory('collab-crane', '- [2026-08-01] a\n- [2026-08-02] b\n');
    await handleBotMessage(host(), { type: 'listCollabAgentDefs' });
    expect(last('collabAgentDefs')!.memoryFacts).toEqual({ 'collab-crane': 2 });
  });

  it('saving a def writes it and re-lists, with the contract intact', async () => {
    seedDef('collab-crane');
    await handleBotMessage(host(), {
      type: 'saveCollabAgentDef',
      def: { slug: 'collab-crane', description: 'Builds it', model: '', glyph: '', persona: 'You are Crane.', bot: { tier: 'strict', memory: false } },
    });
    const written = fs.readFileSync(path.join(cfg, 'agent', 'collab-crane.md'), 'utf8');
    expect(written).toMatch(/^permissions: strict$/m);
    expect(written).toMatch(/^memory: false$/m);
    expect((last('collabAgentDefs')!.defs as Array<Record<string, unknown>>)[0].bot)
      .toEqual({ tier: 'strict', memory: false });
  });

  it('a refused save reaches the pane as an error field, not a thrown promise', async () => {
    await handleBotMessage(host(), { type: 'saveCollabAgentDef', def: { slug: 'NOT A SLUG' } });
    expect(String(last('collabAgentDefs')!.error)).toContain('NOT A SLUG');
  });
});

describe('startBotSession — one bot, its own chat', () => {
  it('asks the host to start a session for the slug the card named, under the name it draws', async () => {
    expect(await handleBotMessage(host(), { type: 'startBotSession', slug: 'collab-crane', displayName: 'Crane' })).toBe(true);
    expect(started).toEqual([['collab-crane', 'Crane', '']]);
  });

  // The slug is the honest fallback, never a prettier one invented here: an
  // older pane that sends no display name gets a tab titled with the id it
  // asked for, not with a name nothing on disk agrees to.
  it('falls back to the slug when the message carried no display name', async () => {
    await handleBotMessage(host(), { type: 'startBotSession', slug: 'collab-crane' });
    expect(started).toEqual([['collab-crane', 'collab-crane', '']]);
  });

  // A slug from a webview message is untrusted: the host turns it into an
  // engine agent id, so a malformed one must be refused here rather than
  // handed on.
  it('refuses a slug that is not a legal agent name, and says so', async () => {
    await handleBotMessage(host(), { type: 'startBotSession', slug: '../../etc' });
    expect(started).toEqual([]);
    expect(String(last('botSessionResult')!.error)).toMatch(/name/i);
  });

  // The host method is OPTIONAL, because the shell that owns session creation
  // may be older than this module. A missing one is a message the user can act
  // on, never a silent no-op that leaves the button looking broken.
  it('reports a host that cannot start sessions instead of doing nothing', async () => {
    await handleBotMessage({ post: (m) => { posts.push(m); }, configDir: () => cfg }, { type: 'startBotSession', slug: 'collab-crane' });
    expect(String(last('botSessionResult')!.error)).toMatch(/reload/i);
  });

  // The PANE WAITS ON THIS. A bot card marks itself "Starting…" on click and can
  // only put the button back when the host answers — so a success that posted
  // nothing would leave the card stuck mid-flight with the chat already open,
  // and no other message would ever come to correct it.
  it('answers a SUCCESSFUL start too, so the pane can stop waiting', async () => {
    await handleBotMessage(host(), { type: 'startBotSession', slug: 'collab-crane', displayName: 'Crane' });
    expect(last('botSessionResult')).toEqual({ type: 'botSessionResult', slug: 'collab-crane', ok: true });
  });

  it('carries a failure from the host through to the pane', async () => {
    await handleBotMessage(
      host({ startBotSession: async () => { throw new Error('agent type unavailable: collab-crane'); } }),
      { type: 'startBotSession', slug: 'collab-crane' },
    );
    expect(String(last('botSessionResult')!.error)).toContain('agent type unavailable');
  });

  // --- the chat is BRANDED with the bot's own creature ---------------------
  // A bot's empty state draws that creature where an ordinary chat draws the
  // crane, so the glyph has to reach the panel with the request that creates
  // the session — it is stamped onto the session and posted with
  // `sessionCreated`, which is the one message every view of a chat gets.
  it('reads the glyph off the def on disk and sends it with the start', async () => {
    seedDef('collab-owl', DEF.replace('collab: true', 'collab: true\nglyph: owl'));
    await handleBotMessage(host(), { type: 'startBotSession', slug: 'collab-owl', displayName: 'Owl' });
    expect(started).toEqual([['collab-owl', 'Owl', 'owl']]);
  });

  // OFF THE FILE, not off the message. The pane's copy of a def is only as
  // fresh as its last list reply, and a def edited in another window since then
  // would brand the chat with the previous creature.
  it('ignores a glyph the message claims, and trusts the file', async () => {
    seedDef('collab-owl', DEF.replace('collab: true', 'collab: true\nglyph: owl'));
    await handleBotMessage(host(), { type: 'startBotSession', slug: 'collab-owl', displayName: 'Owl', glyph: 'dragon' });
    expect(started[0]![2]).toBe('owl');
  });

  // A def that states none, and a slug with no file at all, both answer '' —
  // which the empty state reads as "draw the brand crane". Neither is an error:
  // a glyph is optional, and a missing def is the engine's refusal to report,
  // not this module's.
  it('answers an empty glyph for a def that states none, and for no def at all', async () => {
    seedDef('collab-crane');
    await handleBotMessage(host(), { type: 'startBotSession', slug: 'collab-crane', displayName: 'Crane' });
    await handleBotMessage(host(), { type: 'startBotSession', slug: 'collab-ghost', displayName: 'Ghost' });
    expect(started.map((s) => s[2])).toEqual(['', '']);
    expect(last('botSessionResult')).toEqual({ type: 'botSessionResult', slug: 'collab-ghost', ok: true });
  });
});

// What "start a session as this bot" actually does, at the seam DashboardPanel
// hands it two closures across (botSessionStart.ts).
//
// ONE step, not two. The chat is created AS the bot: the slug rides ACP
// `session/new`'s `_meta.agent`, which is the field the engine builds both the
// session row and the FIRST turn's identity from. The create-then-set pair this
// replaces left a window in which the session existed as `build` — a chat
// titled Crane answering "I'm Origami … No specialized persona loaded", which
// is the W7-L1 UAT report.
describe('startBotSession — the chat is created AS the bot', () => {
  const client = (current: string, ids: string[]) => ({
    getModeOption: () => ({ current, options: ids.map((value) => ({ value, name: value })) }),
  });

  it('creates the chat under the DISPLAY name and AS the SLUG, in one call', async () => {
    const created: Array<[string, string]> = [];
    await startBotSession(
      {
        create: async (n, agent) => { created.push([n, agent]); return 's1'; },
        clientOf: () => client('collab-crane', ['build', 'plan', 'collab-crane']),
      },
      'collab-crane',
      'Crane',
    );
    expect(created).toEqual([['Crane', 'collab-crane']]);
  });

  // Checked against the ENGINE's own answer, never against what we asked for.
  // `mode.current` is the live `session.modeId` the first prompt resolves
  // persona, bot memory and the def's tool denies from — so a chat the engine
  // LISTS the bot in but did not bring up AS the bot is still the reported bug,
  // and an engine too old to read `_meta.agent` lands exactly there.
  it('refuses a chat the engine listed the bot in but did not start as it', async () => {
    await expect(
      startBotSession(
        { create: async () => 's1', clientOf: () => client('build', ['build', 'plan', 'collab-crane']) },
        'collab-crane',
        'Crane',
      ),
    ).rejects.toThrow(/collab-crane[\s\S]*build/);
  });

  it('names the ids the engine really offers when the bot is not among them', async () => {
    await expect(
      startBotSession(
        { create: async () => 's1', clientOf: () => client('build', ['build', 'plan']) },
        'collab-crane',
        'Crane',
      ),
    ).rejects.toThrow(/build, plan/);
  });

  it('reports a chat that never started rather than assuming it is the bot', async () => {
    await expect(
      startBotSession({ create: async () => 's1', clientOf: () => undefined }, 'collab-crane', 'Crane'),
    ).rejects.toThrow(/did not start/);
  });

  // The engine refuses `session/new` outright for a definition it has not
  // loaded, and its sentence NAMES the ids it does offer. That sentence reaches
  // the pane unchanged: rewrapping it here would throw away the alternatives,
  // and the shell cannot fix an identity it is not told the valid values for.
  it('lets the engine refusal through verbatim instead of rewrapping it', async () => {
    await expect(
      startBotSession(
        {
          create: async () => {
            throw new Error('The engine has not loaded an agent called "collab-crane". It offers: build, plan.');
          },
          clientOf: () => undefined,
        },
        'collab-crane',
        'Crane',
      ),
    ).rejects.toThrow(/has not loaded an agent called "collab-crane"\. It offers: build, plan/);
  });
});

describe('bot memory — see it, wipe it', () => {
  it('reads a bot store back for the pane', async () => {
    seedMemory('collab-crane', '- [2026-08-01] Ships on Fridays.\n');
    await handleBotMessage(host(), { type: 'botMemoryRead', slug: 'collab-crane' });
    const reply = last('botMemoryData')!;
    expect(reply.slug).toBe('collab-crane');
    expect(reply.facts).toBe(1);
    expect(String(reply.text)).toContain('Ships on Fridays.');
  });

  it('clearing wipes the store and answers with the now-empty one', async () => {
    seedMemory('collab-crane', '- [2026-08-01] Ships on Fridays.\n');
    await handleBotMessage(host(), { type: 'botMemoryClear', slug: 'collab-crane' });
    expect(last('botMemoryData')!.facts).toBe(0);
    expect(fs.existsSync(path.join(cfg, 'bot', 'collab-crane', 'memory'))).toBe(false);
  });

  // The destructive path with an untrusted slug. Proven by a real file that is
  // still there afterwards, not by an assertion about the path string.
  it('a traversing slug clears nothing outside the bot tree', async () => {
    seedDef('collab-crane');
    await handleBotMessage(host(), { type: 'botMemoryClear', slug: '../agent' });
    expect(fs.existsSync(path.join(cfg, 'agent', 'collab-crane.md'))).toBe(true);
  });
});

describe('the board-section handshake — the collab room S9 dead end', () => {
  // Two paths, because the board may or may not already be open. An OPEN board
  // is a mounted webview that receives the broadcast now; a board being opened
  // for the first time has not attached yet, so it asks on mount instead.
  it('broadcasts the section at once, for a board that is already open', async () => {
    expect(await handleBotMessage(host(), { type: 'openBotsSection' })).toBe(true);
    expect(last('boardShowSection')!.section).toBe('bots');
  });

  it('replays the section to a board that mounts AFTER the request', async () => {
    await handleBotMessage(host(), { type: 'openBotsSection' });
    posts = [];
    await handleBotMessage(host(), { type: 'boardReady' });
    expect(last('boardShowSection')!.section).toBe('bots');
  });

  // The ack is what stops the request outliving the click. Without it a board
  // opened for any other reason, an hour later, would still jump to Bots.
  it('a board that acknowledges the switch is not sent it again on its next mount', async () => {
    await handleBotMessage(host(), { type: 'openBotsSection' });
    await handleBotMessage(host(), { type: 'boardSectionShown' });
    posts = [];
    await handleBotMessage(host(), { type: 'boardReady' });
    expect(last('boardShowSection')).toBeUndefined();
  });

  it('a plain board mount with no request pending is answered with silence', async () => {
    expect(await handleBotMessage(host(), { type: 'boardReady' })).toBe(true);
    expect(posts).toEqual([]);
  });
});

describe('boardOpenDocs — the rail Docs button', () => {
  it('opens DOCS_URL verbatim through the host seam and claims the message', async () => {
    const opened: string[] = [];
    expect(await handleBotMessage(host({ openExternal: (u) => void opened.push(u) }), { type: 'boardOpenDocs' })).toBe(true);
    expect(opened).toEqual([DOCS_URL]);
    // The URL is host-owned: a webview-supplied url field must change nothing.
    await handleBotMessage(host({ openExternal: (u) => void opened.push(u) }), { type: 'boardOpenDocs', url: 'https://evil.example' });
    expect(opened).toEqual([DOCS_URL, DOCS_URL]);
  });

  it('is declared in BOT_MESSAGE_TYPES so the dispatcher routes it here', () => {
    expect(BOT_MESSAGE_TYPES.has('boardOpenDocs')).toBe(true);
  });
});
