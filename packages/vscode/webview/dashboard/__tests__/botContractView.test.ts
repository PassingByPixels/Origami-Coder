// What a BOT CARD says about a contract, as pure functions.
//
// The card's whole job is to answer "is this bot ready to work" without opening
// the .md file, and the hard half of that is ABSENCE. Every contract key is
// optional and every default is today's behaviour, so a card has three states
// to draw per field, not two: chosen, chosen-as-the-default, and never stated.
// Collapsing the last two is the failure this file exists for — an unconfigured
// def that renders as "standard / memory on" looks deliberately set up, and
// nobody goes looking for the thing that was never decided.
//
// Pure because the interesting cases are invisible in a screenshot: "a def with
// no permission block is not a bot with no tools" is a sentence about data.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TIER_CHOICES,
  memorySummary,
  modelWarning,
  personaLine,
  tierSummary,
  toolsSummary,
  type BotDefView,
} from '../components/botContractView';

const def = (over: BotDefView = {}): BotDefView => ({ model: '', persona: '', ...over });

describe('tierSummary — a stated tier, an unknown one, and silence', () => {
  it('names a stated tier and marks it chosen', () => {
    expect(tierSummary({ tier: 'strict' })).toMatchObject({ text: 'strict', chosen: true });
  });

  // The engine's own defaults stand when nothing is stated. Saying "open" here
  // would be a lie in the other direction: `open` is a real, explicit choice.
  it('reads silence as the engine default, NOT as `open`', () => {
    const s = tierSummary({});
    expect(s.chosen).toBe(false);
    expect(s.text).not.toBe('open');
    expect(s.text).toMatch(/default/i);
  });

  it('keeps `open` distinguishable from silence, because the author chose it', () => {
    expect(tierSummary({ tier: 'open' })).toMatchObject({ text: 'open', chosen: true });
  });

  // A typo must be SHOWN. The engine adds no rules for a value it cannot read,
  // so a def with `permissions: stricter` is running wide open while its file
  // says otherwise — the one contract state a card must not render quietly.
  it('flags an unrecognised tier as a problem, quoting what was written', () => {
    const s = tierSummary({ unknownTier: 'stricter' });
    expect(s.text).toContain('stricter');
    expect(s.bad).toBe(true);
  });

  // The editor no longer OFFERS a tier (the tool checklist replaced it), but a
  // def may still state one by hand, so the card has to be able to say what it
  // means rather than printing a word with no explanation behind it.
  it('every tier a def can state has a hint saying what it permits', () => {
    expect(TIER_CHOICES.map((c) => c.id)).toEqual(['strict', 'standard', 'open']);
    for (const c of TIER_CHOICES) expect(c.hint.length).toBeGreaterThan(20);
  });
});

describe('toolsSummary — WHICH TOOLS, compactly enough for a card', () => {
  // A def with no permission block is not a bot with no tools: the engine
  // offers it everything. Drawing "0 tools" would be the opposite of the truth.
  it('reads NO block as the engine default, and marks it unchosen', () => {
    expect(toolsSummary(def(), 'worker')).toMatchObject({ text: 'engine default', chosen: false });
  });

  // The preset names are what a user recognises; the count is the fallback for
  // a set that is nobody's preset.
  it('names a preset set, and counts an adjusted one', () => {
    expect(toolsSummary(def({ tools: ['glob', 'grep', 'read'] }), 'observer'))
      .toMatchObject({ text: 'observer', chosen: true });
    expect(toolsSummary(def({ tools: ['read', 'grep', 'browser'] }), 'custom').text).toBe('3 tools');
    expect(toolsSummary(def({ tools: ['read'] }), 'custom').text).toBe('1 tool');
  });

  // An EMPTY tick set is a real, chosen answer — a bot allowed nothing — and it
  // must not read like the "no block" case above.
  it('keeps an empty tick set apart from an absent block', () => {
    const empty = toolsSummary(def({ tools: [] }), 'custom');
    expect(empty.chosen).toBe(true);
    expect(empty.text).not.toBe('engine default');
  });

  it('hangs the whole list on the title, since a card cannot hold thirty names', () => {
    expect(toolsSummary(def({ tools: ['bash', 'edit', 'read'] }), 'custom').title).toBe('bash, edit, read');
  });
});

describe('memorySummary — on unless the def opted out', () => {
  it('unstated is ON, because that is the engine default', () => {
    expect(memorySummary({}, 0)).toMatchObject({ on: true, chosen: false });
  });

  it('`memory: false` is off, and is a chosen state', () => {
    expect(memorySummary({ memory: false }, 0)).toMatchObject({ on: false, chosen: true });
  });

  // Presence is what tells "configured to remember" from "has remembered".
  it('reports what the bot has actually kept when it has kept anything', () => {
    expect(memorySummary({}, 12).text).toContain('12');
    expect(memorySummary({}, 0).text).not.toMatch(/\d/);
  });

  it('a bot that opted out shows no fact count even if a stale store exists', () => {
    expect(memorySummary({ memory: false }, 12).text).not.toContain('12');
  });
});

describe('modelWarning — the two model statements read together', () => {
  it('warns an UNPINNED def with no preference: nothing decides its model', () => {
    expect(modelWarning(def())).toMatch(/no model pinned/i);
  });

  it('says nothing when a model is pinned', () => {
    expect(modelWarning(def({ model: 'lmstudio/qwen-32b' }))).toBe('');
  });

  // W6 ruling (c): "a bot simply needs a pinned model, period". `model_prefer:`
  // used to silence this, which meant an unpinned bot could look fine because
  // of a second statement nobody could see on the card. There is one condition
  // now, and a stale preference left in a file cannot suppress it.
  it('is NOT silenced by a leftover model preference — only a pin silences it', () => {
    expect(modelWarning(def({ bot: { modelPrefer: ['local+large-context', 'any'] } as never })))
      .toMatch(/no model pinned/i);
  });

  it('tells a vision profile the sharper truth — it would run blind', () => {
    expect(modelWarning(def({ visionProfile: true }))).toMatch(/cannot see/i);
  });
});

describe('personaLine — the character, in one line', () => {
  it('takes the opening paragraph and flattens its wrapping', () => {
    expect(personaLine(def({ persona: 'You are Crane.\nYou build.\n\nRules follow.' })))
      .toBe('You are Crane. You build.');
  });

  it('is empty for a def with no persona, so the card draws nothing', () => {
    expect(personaLine(def())).toBe('');
  });
});

// THE MIRROR'S DRIFT GUARD. tsconfig.webview.json pins rootDir to `webview/`,
// so botContractView.ts cannot import BotContract from src/ — not even as a
// type. The shape is therefore copied, and a copy with no guard is a lie
// waiting to happen: a fifth contract key added host-side and not here is a
// field the card silently never draws. Same obligation repoMapPillars.test.ts
// carries for the pillar mirror.
describe('the webview mirror of BotContract still matches the host shape', () => {
  const fieldsOf = (src: string, iface: string): string[] => {
    const body = src.match(new RegExp(`interface ${iface} \\{([\\s\\S]*?)\\n\\}`))![1];
    return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]).sort();
  };
  const read = (...rel: string[]) =>
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', ...rel), 'utf8');

  it('declares exactly the fields src/dashboard/botContract.ts does', () => {
    expect(fieldsOf(read('webview', 'dashboard', 'components', 'botContractView.ts'), 'BotContract'))
      .toEqual(fieldsOf(read('src', 'dashboard', 'botContract.ts'), 'BotContract'));
  });

  it('declares the same permission tiers', () => {
    const host = read('src', 'dashboard', 'botContract.ts').match(/BOT_TIERS = \[([^\]]*)\]/)![1];
    expect(TIER_CHOICES.map((c) => c.id)).toEqual([...host.matchAll(/'([a-z]+)'/g)].map((m) => m[1]));
  });
});

// WHAT A NEW BOT IS BORN WITH used to be tested here, through a `QUICK_DEFAULTS`
// constant this module exported. W6 emptied it to `{}` and W9 deleted it: an
// exported name for "nothing" is a place a default can quietly grow back, which
// is the exact "looks deliberately set up" failure this module is written
// against. The claim now lives where a new bot is actually built — botsPane.test
// asserts the saved def's `bot` is `{}` and its tick set is every tool.
