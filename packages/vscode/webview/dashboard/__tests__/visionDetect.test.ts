// Which local models can see, per server flavour.
//
// THE REQUIREMENT THESE VERIFY. The engine defaults every config-declared model
// to `capabilities.input.image === false`. So a wrong answer here has two very
// different costs: a false NEGATIVE tells a working VLM it is blind (the shipped
// SGLang bug in packages/engine/test/provider/config-vision.test.ts), and a
// false POSITIVE sends pixels to a text model that will answer with the engine's
// own "ERROR: Cannot read image" line. The third state — the server did not say
// — must produce NO entry at all, so the caller writes nothing either way.
//
// FIXTURES ARE FRESH. The LM Studio bodies are shaped from the endpoint the old
// inline mapper read; the Ollama bodies from Ollama's own docs/api.md ("Show
// Model Information", `capabilities: ["completion","vision"]`). Nothing here was
// captured from a live server, and no test makes a request.

import { describe, expect, it } from 'vitest';
import {
  detectVision,
  lmStudioVision,
  ollamaVision,
  serverRoot,
  type VisionProbe,
} from '../../../src/dashboard/visionDetect';

/** A probe over canned answers, keyed by URL. Records every call. */
function probeOf(routes: Record<string, unknown>, calls: string[] = []): VisionProbe {
  const answer = (url: string) => {
    calls.push(url);
    return url in routes ? { ok: true, json: routes[url] } : { ok: false };
  };
  return {
    getJson: async (url) => answer(url),
    postJson: async (url, body) => answer(`${url} ${JSON.stringify(body)}`),
  };
}

describe('serverRoot — the native API sits beside /v1, not under it', () => {
  it.each([
    ['http://127.0.0.1:1234/v1', 'http://127.0.0.1:1234'],
    ['http://127.0.0.1:11434/v1/', 'http://127.0.0.1:11434'],
    ['http://127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['http://box:8000/v1//', 'http://box:8000'],
  ])('%s -> %s', (input, expected) => {
    expect(serverRoot(input)).toBe(expected);
  });
});

describe('LM Studio — the /api/v0/models type tag', () => {
  it('vlm is sight, llm is not, and both are DEFINITE answers', () => {
    const map = lmStudioVision({
      data: [
        { id: 'qwen2.5-vl-7b', type: 'vlm' },
        { id: 'qwen3-coder-30b', type: 'llm' },
      ],
    });
    expect(map.get('qwen2.5-vl-7b')).toBe(true);
    expect(map.get('qwen3-coder-30b')).toBe(false);
  });

  it('a model with NO type is absent from the map, not recorded as blind', () => {
    // This is the `/v1`-only case. Recording `false` would strip the flag from a
    // model the user had already declared sighted by hand.
    const map = lmStudioVision({ data: [{ id: 'mystery-model' }, { id: 'seen', type: 'vlm' }] });
    expect(map.has('mystery-model')).toBe(false);
    expect(map.size).toBe(1);
  });

  it('an embeddings model is a definite NO — it is typed, just not a vlm', () => {
    expect(lmStudioVision({ data: [{ id: 'nomic-embed', type: 'embeddings' }] }).get('nomic-embed')).toBe(false);
  });

  it('a bare array (no data envelope) is read the same way', () => {
    expect(lmStudioVision([{ id: 'a', type: 'vlm' }]).get('a')).toBe(true);
  });

  it.each([
    ['null', null],
    ['an object with no models', { object: 'list' }],
    ['a string', 'nope'],
    ['data as a string', { data: 'nope' }],
  ])('%s yields an empty map rather than throwing', (_name, body) => {
    expect(lmStudioVision(body).size).toBe(0);
  });
});

describe('Ollama — the /api/show capabilities array', () => {
  it('"vision" in capabilities is sight', () => {
    expect(ollamaVision({ capabilities: ['completion', 'vision'] })).toBe(true);
  });

  it('capabilities without "vision" is a definite NO', () => {
    expect(ollamaVision({ capabilities: ['completion', 'tools'] })).toBe(false);
  });

  it('an EMPTY capabilities array is still a definite NO — the server answered', () => {
    expect(ollamaVision({ capabilities: [] })).toBe(false);
  });

  it('NO capabilities key is UNKNOWN — an older Ollama must not blind a working VLM', () => {
    expect(ollamaVision({ model_info: { 'qwen3.architecture': 'qwen3' } })).toBeUndefined();
    expect(ollamaVision({})).toBeUndefined();
    expect(ollamaVision(null)).toBeUndefined();
  });

  it('capabilities as a non-array is UNKNOWN, not false', () => {
    expect(ollamaVision({ capabilities: 'vision' })).toBeUndefined();
  });

  it('matching is case-insensitive — the array is a server-side enum we do not control', () => {
    expect(ollamaVision({ capabilities: ['Vision'] })).toBe(true);
  });
});

describe('detectVision — picking the flavour by which endpoint answers', () => {
  it('LM Studio answers first and Ollama is never asked', async () => {
    const calls: string[] = [];
    const map = await detectVision(
      { apiBase: 'http://127.0.0.1:1234/v1', modelIds: ['qwen2.5-vl-7b'] },
      probeOf({ 'http://127.0.0.1:1234/api/v0/models': { data: [{ id: 'qwen2.5-vl-7b', type: 'vlm' }] } }, calls),
    );
    expect(map.get('qwen2.5-vl-7b')).toBe(true);
    expect(calls).toEqual(['http://127.0.0.1:1234/api/v0/models']);
  });

  it('Ollama: /api/tags confirms the flavour, then one /api/show per CONFIGURED model', async () => {
    const calls: string[] = [];
    const root = 'http://127.0.0.1:11434';
    const map = await detectVision(
      { apiBase: `${root}/v1`, modelIds: ['llava:7b', 'qwen3-coder:30b'] },
      probeOf(
        {
          [`${root}/api/tags`]: { models: [{ name: 'llava:7b' }] },
          [`${root}/api/show {"model":"llava:7b"}`]: { capabilities: ['completion', 'vision'] },
          [`${root}/api/show {"model":"qwen3-coder:30b"}`]: { capabilities: ['completion', 'tools'] },
        },
        calls,
      ),
    );
    expect(map.get('llava:7b')).toBe(true);
    expect(map.get('qwen3-coder:30b')).toBe(false);
    // The order proves the cheap confirmation happens before the per-model spend.
    expect(calls).toEqual([
      `${root}/api/v0/models`,
      `${root}/api/tags`,
      `${root}/api/show {"model":"llava:7b"}`,
      `${root}/api/show {"model":"qwen3-coder:30b"}`,
    ]);
  });

  it('a model /api/show refuses is left out of the map, not marked blind', async () => {
    const root = 'http://127.0.0.1:11434';
    const map = await detectVision(
      { apiBase: `${root}/v1`, modelIds: ['pulled-away:latest'] },
      probeOf({ [`${root}/api/tags`]: { models: [] } }),
    );
    expect(map.size).toBe(0);
  });

  it('vLLM / SGLang: NEITHER endpoint answers, so nothing is claimed and no model is probed', async () => {
    // The regression this guards: an SGLang box serving a native VLM had its
    // vision flag stripped because "no answer" was read as "no vision".
    const calls: string[] = [];
    const map = await detectVision(
      { apiBase: 'http://100.64.1.10:8000/v1', modelIds: ['qwen3.8-27b'] },
      probeOf({}, calls),
    );
    expect(map.size).toBe(0);
    expect(calls).toEqual([
      'http://100.64.1.10:8000/api/v0/models',
      'http://100.64.1.10:8000/api/tags',
    ]);
    expect(calls.some((c) => c.includes('/api/show'))).toBe(false);
  });

  it('NO probe request carries a payload to be inferred from — only metadata is read', async () => {
    // Detection must never send a test image or a test completion.
    const calls: string[] = [];
    const root = 'http://127.0.0.1:11434';
    await detectVision(
      { apiBase: `${root}/v1`, modelIds: ['llava:7b'] },
      probeOf({ [`${root}/api/tags`]: { models: [] }, [`${root}/api/show {"model":"llava:7b"}`]: { capabilities: [] } }, calls),
    );
    for (const call of calls) {
      expect(call).not.toContain('completions');
      expect(call).not.toContain('data:image');
    }
  });
});
