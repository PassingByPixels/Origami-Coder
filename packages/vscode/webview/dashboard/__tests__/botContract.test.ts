// The BOT CONTRACT as the shell reads and writes it.
//
// The engine owns what `permissions:` and `memory:` MEAN
// (packages/engine/src/agent/bot.ts). This package owns the FILE the user edits,
// so it has to read those keys back off a def and write them out again without
// changing what the engine will make of them.
//
// W6 STRIPPED TWO KEYS this file used to own — `skills:` and `model_prefer:` —
// on owner ruling, and the last block below is what stops either creeping back:
// a serializer that wrote a key with no control behind it is exactly the "looks
// configured by a decision nobody made" failure the rest of this file guards.
// WHICH TOOLS a bot has moved to its permission block; botTools.test.ts owns it.
//
// Two failure classes are what these tests exist for:
//
//  1. A ROUND TRIP THAT INVENTS. The writer resolves an absent field from disk,
//     so "the file said nothing" and "the author chose the default" must stay
//     distinguishable end to end. A serializer that stamps `permissions: open`
//     onto every def would make every bot look configured, and a parser that
//     read a missing `memory:` as `false` would silently wipe a bot's store.
//  2. DRIFT FROM THE ENGINE. The tier names are MIRRORED here, because
//     `packages/engine` is not resolvable from this package. A mirror with no
//     guard is a lie waiting to happen, so the last block reads the engine
//     source itself.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT_TIERS, botContractLines, parseBotContract } from '../../../src/dashboard/botContract';

const front = (...lines: string[]) => lines.join('\n');

describe('parseBotContract — what the file SAYS, never what it probably meant', () => {
  it('a def with none of the keys carries an EMPTY contract', () => {
    const c = parseBotContract(front('description: "x"', 'mode: all', 'collab: true'));
    expect(c).toEqual({});
  });

  it('reads a known tier', () => {
    expect(parseBotContract(front('permissions: strict')).tier).toBe('strict');
  });

  // Never guessed at: the engine reports an unrecognised value rather than
  // picking a tier, so the pane has to be able to SHOW the typo.
  it('keeps an unrecognised tier as unknownTier and sets no tier at all', () => {
    const c = parseBotContract(front('permissions: stricter'));
    expect(c.tier).toBeUndefined();
    expect(c.unknownTier).toBe('stricter');
  });

  // The sharpest one. `memory:` decides whether a bot keeps a store across
  // sessions, and the engine's default is TRUE. An absent key read as `false`
  // would turn every existing def into a bot that forgets.
  it('reads memory only when the file states it — absent is undefined, not false', () => {
    expect(parseBotContract(front('memory: false')).memory).toBe(false);
    expect(parseBotContract(front('memory: true')).memory).toBe(true);
    expect(parseBotContract(front('description: "x"')).memory).toBeUndefined();
  });
});

describe('botContractLines — omitted at its default, so a def is never made to look configured', () => {
  it('writes NOTHING for an empty contract', () => {
    expect(botContractLines({})).toEqual([]);
  });

  it('writes the tier it was given', () => {
    expect(botContractLines({ tier: 'standard' })).toEqual(['permissions: standard']);
  });

  // An unknown tier is the user's own text. Dropping it would silently "fix"
  // their typo into today's engine defaults on the next unrelated save.
  it('preserves an unrecognised tier verbatim rather than dropping it', () => {
    expect(botContractLines({ unknownTier: 'stricter' })).toEqual(['permissions: stricter']);
  });

  // `memory: true` IS the engine default, so writing it says nothing and would
  // put a line in every file for no reason — the same rule `vision:` follows.
  it('writes memory ONLY when it is off', () => {
    expect(botContractLines({ memory: false })).toEqual(['memory: false']);
    expect(botContractLines({ memory: true })).toEqual([]);
    expect(botContractLines({})).toEqual([]);
  });

  it('round-trips every field back through the parser unchanged', () => {
    const contract = { tier: 'strict' as const, memory: false };
    expect(parseBotContract(botContractLines(contract).join('\n'))).toEqual(contract);
  });
});

// W6 rulings, as behaviour that can fail rather than as a deletion nobody can
// see. Both keys had a control behind them that is gone; a key still written
// here would be a def configured by a decision the user can no longer make or
// even read — which is the whole failure class this file's first block is about.
describe('the two keys W6 stripped stay stripped', () => {
  it('does not read `skills:` back — the tool checklist replaced it', () => {
    const c = parseBotContract(front('skills:', '  - code-review')) as Record<string, unknown>;
    expect('skills' in c).toBe(false);
  });

  it('does not read `model_prefer:` back — a bot simply needs a pinned model', () => {
    const c = parseBotContract(front('model_prefer:', '  - any')) as Record<string, unknown>;
    expect('modelPrefer' in c).toBe(false);
  });

  it('writes neither, whatever a caller hands it', () => {
    const lines = botContractLines({ skills: ['a'], modelPrefer: ['any'] } as never);
    expect(lines.join('\n')).not.toMatch(/skills|model_prefer/);
  });
});

// --- the mirror's drift guard ---------------------------------------------
// tsconfig pins this package away from packages/engine, so the vocabulary is
// copied. This reads the engine's own source: a tier renamed there and not here
// is a permission level the pane writes and the engine ignores.
const engineSrc = (file: string) =>
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'engine', 'src', 'agent', file),
    'utf8',
  );

describe('the mirrored vocabulary still agrees with the engine', () => {
  it('BOT_TIERS matches bot.ts TIERS', () => {
    const found = engineSrc('bot.ts').match(/const TIERS = \[([^\]]*)\]/)![1];
    const names = [...found.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    expect([...BOT_TIERS]).toEqual(names);
  });
});
