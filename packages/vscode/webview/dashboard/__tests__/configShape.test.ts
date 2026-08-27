// configShape.ts is a MIRROR of the engine's config schema, so this file is
// two things at once: the behaviour tests for the validator, and the drift
// guard the house rule requires of every mirror — a test that reads BOTH files
// and fails when they stop agreeing.
//
// The mirror is not a preference. `effect`, `@origami/core` and `jsonc-parser`
// are all UNRESOLVABLE from packages/vscode (this monorepo installs per
// package), at runtime and under vitest alike, so the real Effect schema
// cannot be imported here even in a test. The guard below reads
// packages/core/src/v1/config/{config,provider}.ts as TEXT instead, which
// needs no resolution and trips the moment the real schema moves.
//
// What the failure looks like without the guard: the engine adds a top-level
// key, a writer in this package starts emitting it, configShapeErrors calls it
// unrecognized, and every Connections action refuses with a message about a
// key that is perfectly legal. Or the reverse — the engine REMOVES one, the
// mirror keeps allowing it, a writer persists it, and the engine throws the
// whole file away and runs the user on `{}` with every pill still green.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODALITIES, TOP_LEVEL_KEYS, configShapeErrors } from '../../../src/dashboard/configShape';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const coreConfig = readFileSync(path.join(repoRoot, 'packages/core/src/v1/config/config.ts'), 'utf8');
const coreProvider = readFileSync(path.join(repoRoot, 'packages/core/src/v1/config/provider.ts'), 'utf8');

/** The body of a top-level `export const <name> = Schema.Struct({ … })`,
 *  bounded at the first column-0 `})` so a later declaration cannot leak in. */
function structBody(src: string, name: string): string {
  const start = src.indexOf(`export const ${name} = Schema.Struct({`);
  expect(start, `${name} not found — the schema was restructured`).toBeGreaterThan(-1);
  const rest = src.slice(start);
  const end = /^\}\)/m.exec(rest);
  expect(end, `no end found for ${name}`).toBeTruthy();
  return rest.slice(0, end!.index);
}

describe('drift guard — the mirror still matches the real engine schema', () => {
  it('declares exactly the top-level keys ConfigV1.Info declares', () => {
    const declared = [...structBody(coreConfig, 'Info').matchAll(/^  ([$A-Za-z_][\w$]*): /gm)].map((m) => m[1]);
    expect(declared.length, 'no keys parsed — the extraction broke, not the mirror').toBeGreaterThan(20);
    expect([...TOP_LEVEL_KEYS].sort()).toEqual([...declared].sort());
  });

  it('declares exactly the modalities ConfigProviderV1.Model accepts', () => {
    const block = /modalities: Schema\.optional\(\s*Schema\.Struct\(\{[\s\S]*?input: Schema\.optional\(Schema\.mutable\(Schema\.Array\(Schema\.Literals\(\[([^\]]*)\]\)\)\)\)/
      .exec(coreProvider);
    expect(block, 'modalities.input literals not found in the real schema').toBeTruthy();
    const declared = [...block![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    expect([...MODALITIES]).toEqual(declared);
  });

  // This one is load-bearing enough that modelContextLimit.test.ts documents it
  // in its own header: `output` is a REQUIRED sibling of `context`, so a bare
  // `{ context }` does not partially apply — it invalidates the whole file.
  it('still requires BOTH context and output inside limit', () => {
    const limit = /limit: Schema\.optional\(\s*Schema\.Struct\(\{([\s\S]*?)\}\),\s*\),/.exec(coreProvider);
    expect(limit, 'Model.limit not found in the real schema').toBeTruthy();
    expect(limit![1]).toMatch(/\bcontext: Schema\.Finite\b/);
    expect(limit![1]).toMatch(/\boutput: Schema\.Finite\b/);
  });

  it('still requires finite input and output inside cost', () => {
    const cost = /cost: Schema\.optional\(\s*Schema\.Struct\(\{([\s\S]*?)\n {4}\}\),\s*\),/.exec(coreProvider);
    expect(cost, 'Model.cost not found in the real schema').toBeTruthy();
    expect(cost![1]).toMatch(/\binput: Schema\.Finite\b/);
    expect(cost![1]).toMatch(/\boutput: Schema\.Finite\b/);
  });
});

describe('configShapeErrors catches what the writers can actually emit', () => {
  it('passes a realistic config the writers produce', () => {
    expect(configShapeErrors({
      model: 'lmstudio/qwen3-8b',
      agent: { build: { frequency_penalty: 0.3 } },
      experimental: { tool_search: { defer: ['read'], always: [] } },
      provider: {
        lmstudio: {
          name: 'LM Studio',
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'http://127.0.0.1:1234/v1' },
          models: {
            'qwen3-8b': { name: 'qwen3-8b', attachment: true, modalities: { input: ['text', 'image'] }, limit: { context: 65536, output: 0 } },
          },
        },
      },
    })).toEqual([]);
  });

  // The live trigger named in the review: OpenRouter answers with a price the
  // extension cannot parse, `Number(...)` gives NaN, JSON.stringify writes it
  // as null, and Schema.Finite rejects the WHOLE file.
  it('catches a NaN cost, which reaches disk as null and zeroes the config', () => {
    const problems = configShapeErrors({
      provider: { openrouter: { models: { 'kimi-k3': { cost: { input: Number.NaN, output: 2 } } } } },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('provider.openrouter.models.kimi-k3.cost.input');
  });

  it('catches a limit missing its required output sibling', () => {
    const problems = configShapeErrors({
      provider: { vllm: { models: { x: { limit: { context: 262144 } } } } },
    });
    expect(problems).toEqual([expect.stringContaining('provider.vllm.models.x.limit.output')]);
  });

  it('catches a modality the engine does not define', () => {
    const problems = configShapeErrors({
      provider: { vllm: { models: { x: { modalities: { input: ['text', 'hologram'] } } } } },
    });
    expect(problems).toEqual([expect.stringContaining('"hologram"')]);
  });

  it('catches an unrecognized top-level key, which the engine rejects outright', () => {
    expect(configShapeErrors({ modelz: 'typo/model' })).toEqual([
      'unrecognized top-level key: modelz',
    ]);
  });

  it('accepts Infinity nowhere — it serialises to null exactly like NaN', () => {
    expect(configShapeErrors({
      provider: { vllm: { models: { x: { limit: { context: Number.POSITIVE_INFINITY, output: 0 } } } } },
    })).toEqual([expect.stringContaining('limit.context')]);
  });

  it('is not fooled by a non-object config', () => {
    expect(configShapeErrors('{}')).toEqual(['config must be a JSON object']);
    expect(configShapeErrors(null)).toEqual(['config must be a JSON object']);
  });
});
