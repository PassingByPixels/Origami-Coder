// The add/re-key provider flow (t-o92558 round 4). Every dependency is faked —
// the flow takes its fetch/catalog/writer as deps — so NO real config write and
// NO network happen here.
//
// These are regression tests for a defect a user hit, not echoes of the code:
//
//   Pasting an OpenCode Zen key produced NO pill. Two causes, both covered below.
//   1. The Zen/Go presets shipped model:'' and the flow's model-id guard rejected
//      them, so nothing was ever written. Tests: "writes the block".
//   2. The only key check in the codebase pointed at OpenRouter's host AND said
//      "OpenRouter" in its failure text. Tests: "hits the preset's own host",
//      "names the preset's own provider".
//
// The /models fixture is the REAL payload, captured live from
// GET https://opencode.ai/zen/v1/models on 2026-08-13 (200, keyless, 61 ids) and
// trimmed to a representative slice — derived from the external thing, not
// invented, per the repo's fixture rule.

import { describe, expect, it, vi } from 'vitest';
import {
  GO_DEFAULT_MODEL,
  KEY_ONLY_PRESETS,
  ZEN_DEFAULT_MODEL,
  checkProviderKey,
  fetchCatalogIds,
  keyRejectedMessage,
  parseModelIds,
  pickDefaultModel,
} from '../../../src/dashboard/keyOnlyPresets';
import { CLAUDE_DEFAULT_MODEL, CLAUDE_MODELS, type ClaudeModelConfig } from '../../../src/dashboard/anthropicCatalog';
import { setupProvider, type SetupProviderDeps } from '../../../src/dashboard/setupProvider';
import type { ModelChoice } from '../../../src/dashboard/firstFold';

// A trimmed capture of the live keyless reply. Shape and ids are verbatim.
const ZEN_MODELS_FIXTURE = {
  object: 'list',
  data: [
    { id: 'claude-fable-5', object: 'model', created: 1786614499, owned_by: 'opencode' },
    { id: 'gpt-5.6-sol', object: 'model', created: 1786614499, owned_by: 'opencode' },
    { id: 'kimi-k2.7-code', object: 'model', created: 1786614499, owned_by: 'opencode' },
    { id: 'deepseek-v4-pro', object: 'model', created: 1786614499, owned_by: 'opencode' },
    { id: 'deepseek-v4-flash-free', object: 'model', created: 1786614499, owned_by: 'opencode' },
    { id: 'laguna-s-2.1-free', object: 'model', created: 1786614499, owned_by: 'opencode' },
  ],
};

/** A fetch stand-in that records every URL it was asked for. */
function recordingFetch(reply: (url: string) => { status: number; json?: unknown }) {
  const calls: Array<{ url: string; method: string; body?: string; auth?: string }> = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push({
      url: u,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    });
    const r = reply(u);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json ?? {},
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function deps(over: Partial<SetupProviderDeps> & { msg: SetupProviderDeps['msg'] }): {
  d: SetupProviderDeps;
  posts: object[];
  written: ModelChoice[];
  refreshed: string[];
} {
  const posts: object[] = [];
  const written: ModelChoice[] = [];
  const refreshed: string[] = [];
  const d: SetupProviderDeps = {
    sessionId: 's1',
    fetchImpl: recordingFetch(() => ({ status: 200 })).impl,
    fetchLocalModels: async () => [],
    fetchCatalog: async () => [],
    cacheCatalog: () => {},
    costFor: async () => undefined,
    write: (c) => { written.push(c); return { path: '/cfg', model: `${c.providerId}/${c.modelId}` }; },
    post: (msgObj) => { posts.push(msgObj); },
    refresh: (id) => { refreshed.push(id); },
    ...over,
  };
  return { d, posts, written, refreshed };
}

const errors = (posts: object[]) =>
  posts.filter((p) => (p as { type?: string }).type === 'error').map((p) => (p as { message: string }).message);
const systems = (posts: object[]) =>
  posts.filter((p) => (p as { type?: string }).type === 'system').map((p) => (p as { text: string }).text);

describe('checkProviderKey — a key is proved against ITS OWN provider', () => {
  it('OpenCode Zen is checked at opencode.ai, never at openrouter.ai', async () => {
    const f = recordingFetch(() => ({ status: 200 }));
    await checkProviderKey({ presetId: 'opencode', apiKey: 'k', fetchImpl: f.impl });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('https://opencode.ai/zen/v1/chat/completions');
    expect(f.calls[0].url).not.toContain('openrouter');
  });

  it('OpenCode Go is checked at ITS OWN gateway (zen/go/v1), never the Zen base', async () => {
    // A paid Go key answers 401 on every non-free zen/v1 model (proven live
    // 2026-08-21) — validating there tells a subscriber their good key is bad.
    const f = recordingFetch(() => ({ status: 200 }));
    await checkProviderKey({ presetId: 'opencode-go', apiKey: 'k', fetchImpl: f.impl });
    expect(f.calls[0].url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
  });

  it('OpenRouter keeps its own /key probe and its free-tier answer', async () => {
    const f = recordingFetch(() => ({ status: 200, json: { data: { label: 'sk-…9f', is_free_tier: true } } }));
    const v = await checkProviderKey({ presetId: 'openrouter', apiKey: 'k', fetchImpl: f.impl });
    expect(f.calls[0].url).toBe('https://openrouter.ai/api/v1/key');
    expect(f.calls[0].method).toBe('GET');
    expect(v).toMatchObject({ ok: true, label: 'sk-…9f', freeTier: true });
  });

  it("the Zen probe costs one token and carries the caller's model", async () => {
    const f = recordingFetch(() => ({ status: 200 }));
    await checkProviderKey({ presetId: 'opencode', apiKey: 'k', model: 'kimi-k2.7-code', fetchImpl: f.impl });
    const body = JSON.parse(f.calls[0].body!);
    expect(f.calls[0].method).toBe('POST');
    expect(body.model).toBe('kimi-k2.7-code');
    expect(body.max_tokens).toBe(1);
    expect(f.calls[0].auth).toBe('Bearer k');
  });

  it('401 is a REJECTED key; a 5xx or a dead network is not', async () => {
    const bad = recordingFetch(() => ({ status: 401 }));
    expect(await checkProviderKey({ presetId: 'opencode', apiKey: 'k', fetchImpl: bad.impl }))
      .toMatchObject({ ok: false, rejected: true });

    const down = recordingFetch(() => ({ status: 502 }));
    // A gateway outage must not accuse the user's key — but 502 also proves the
    // request got PAST auth, which is the only question this probe asks.
    expect(await checkProviderKey({ presetId: 'opencode', apiKey: 'k', fetchImpl: down.impl }))
      .toMatchObject({ ok: true });

    const offline = (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as unknown as typeof fetch;
    const v = await checkProviderKey({ presetId: 'opencode', apiKey: 'k', fetchImpl: offline });
    expect(v.ok).toBe(false);
    expect(v.rejected).toBeFalsy();
  });

  it('a 400 (unknown model) still counts as a VALID key — the gate was passed', async () => {
    // The regression this prevents: Zen retires the default model id, every good
    // key starts reading as invalid, and nobody can connect.
    const f = recordingFetch(() => ({ status: 400 }));
    expect(await checkProviderKey({ presetId: 'opencode', apiKey: 'k', fetchImpl: f.impl }))
      .toMatchObject({ ok: true });
  });
});

describe('keyRejectedMessage — the sentence a user reads names the right company', () => {
  it('says the preset, not OpenRouter', () => {
    const msg = keyRejectedMessage('OpenCode Zen', { ok: false, rejected: true, reason: 'invalid API key (401)' });
    expect(msg).toBe('OpenCode Zen key rejected (invalid API key (401)). Nothing was saved.');
    expect(msg).not.toContain('OpenRouter');
  });

  it('distinguishes "they refused you" from "we could not ask"', () => {
    expect(keyRejectedMessage('OpenCode Zen', { ok: false, reason: 'timeout' }))
      .toBe('OpenCode Zen could not be reached (timeout). Nothing was saved.');
  });
});

describe('the keyless catalog drives the picker', () => {
  it('reads ids out of the REAL /models payload shape', () => {
    expect(parseModelIds(ZEN_MODELS_FIXTURE)).toEqual([
      'claude-fable-5', 'gpt-5.6-sol', 'kimi-k2.7-code',
      'deepseek-v4-pro', 'deepseek-v4-flash-free', 'laguna-s-2.1-free',
    ]);
  });

  it('fetches WITHOUT an Authorization header — that is what makes it pre-key', async () => {
    const f = recordingFetch(() => ({ status: 200, json: ZEN_MODELS_FIXTURE }));
    const ids = await fetchCatalogIds('https://opencode.ai/zen/v1', f.impl);
    expect(f.calls[0].url).toBe('https://opencode.ai/zen/v1/models');
    expect(f.calls[0].auth).toBeUndefined();
    expect(ids).toContain(ZEN_DEFAULT_MODEL);
  });

  it('degrades to [] on a dead gateway rather than throwing setup away', async () => {
    const dead = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    expect(await fetchCatalogIds('https://opencode.ai/zen/v1', dead)).toEqual([]);
  });

  it('starts on the preset default when the catalog really carries it', () => {
    expect(pickDefaultModel(parseModelIds(ZEN_MODELS_FIXTURE), ZEN_DEFAULT_MODEL)).toBe(ZEN_DEFAULT_MODEL);
  });

  it('never offers an id the catalog contradicts', () => {
    // The default was retired: fall to something the gateway actually serves.
    expect(pickDefaultModel(['kimi-k2.7-code', 'glm-5.2'], ZEN_DEFAULT_MODEL)).toBe('kimi-k2.7-code');
  });
});

describe('setupProvider — a key-only preset with only a key pasted', () => {
  it('WRITES the block (the round-4 defect: it used to write nothing at all)', async () => {
    const f = recordingFetch(() => ({ status: 200 }));
    const { d, posts, written, refreshed } = deps({
      fetchImpl: f.impl,
      msg: {
        providerId: 'opencode',
        providerName: 'OpenCode Zen',
        npm: '@ai-sdk/openai-compatible',
        baseURL: 'https://opencode.ai/zen/v1',
        apiKey: 'sk-zen-real',
        modelId: ZEN_DEFAULT_MODEL,
        modelName: ZEN_DEFAULT_MODEL,
      },
    });
    await setupProvider(d);
    expect(errors(posts)).toEqual([]);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      providerId: 'opencode',
      baseURL: 'https://opencode.ai/zen/v1',
      apiKey: 'sk-zen-real',
      modelId: ZEN_DEFAULT_MODEL,
    });
    // The pill only appears because the write is followed by a status refresh.
    expect(refreshed).toEqual(['opencode']);
    expect(systems(posts).some((t) => t.includes('connected'))).toBe(true);
  });

  it('still writes when the caller posts NO model id — the preset default fills in', async () => {
    const f = recordingFetch(() => ({ status: 200 }));
    const { d, posts, written } = deps({
      fetchImpl: f.impl,
      msg: { providerId: 'opencode-go', providerName: 'OpenCode Go', apiKey: 'sk-go', modelId: '', modelName: '' },
    });
    await setupProvider(d);
    expect(errors(posts)).toEqual([]);
    expect(written[0].modelId).toBe(GO_DEFAULT_MODEL);
    // No baseURL posted either — the preset's own (Go's OWN gateway) is used.
    expect(written[0].baseURL).toBe('https://opencode.ai/zen/go/v1');
  });

  it('a rejected key names the PRESET and saves nothing', async () => {
    const f = recordingFetch(() => ({ status: 401 }));
    const { d, posts, written, refreshed } = deps({
      fetchImpl: f.impl,
      msg: { providerId: 'opencode', providerName: 'OpenCode Zen', apiKey: 'sk-bad', modelId: ZEN_DEFAULT_MODEL },
    });
    await setupProvider(d);
    expect(written).toEqual([]);
    expect(refreshed).toEqual([]);
    expect(errors(posts)).toEqual(['OpenCode Zen key rejected (invalid API key (401)). Nothing was saved.']);
    expect(errors(posts).join()).not.toContain('OpenRouter');
  });

  it('validates against the model about to be written, not a fixed one', async () => {
    const f = recordingFetch(() => ({ status: 200 }));
    const { d } = deps({
      fetchImpl: f.impl,
      msg: { providerId: 'opencode', providerName: 'OpenCode Zen', apiKey: 'k', modelId: 'glm-5.2' },
    });
    await setupProvider(d);
    expect(JSON.parse(f.calls[0].body!).model).toBe('glm-5.2');
  });
});

describe('setupProvider — the paths that already worked keep working', () => {
  it('OpenRouter still validates at /key and auto-picks a free model on a free-tier key', async () => {
    const f = recordingFetch(() => ({ status: 200, json: { data: { label: 'k', is_free_tier: true } } }));
    const cached: unknown[] = [];
    const { d, written } = deps({
      fetchImpl: f.impl,
      fetchCatalog: async () => [
        { id: 'x-ai/grok-4', name: 'Grok 4', free: false, cost: { input: 3, output: 15 } },
        { id: 'meta/llama:free', name: 'Llama free', free: true },
      ],
      cacheCatalog: (mm) => { cached.push(...mm); },
      msg: { providerId: 'openrouter', providerName: 'OpenRouter', apiKey: 'sk-or', modelId: '' },
    });
    await setupProvider(d);
    expect(f.calls[0].url).toBe('https://openrouter.ai/api/v1/key');
    expect(written[0].modelId).toBe('meta/llama:free');
    expect(cached).toHaveLength(2);
  });

  it('a local endpoint with no key still auto-picks the loaded model', async () => {
    const { d, written } = deps({
      fetchLocalModels: async () => ['qwen/qwen3-coder-30b'],
      msg: { providerId: 'lmstudio', providerName: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', modelId: '' },
    });
    await setupProvider(d);
    expect(written[0].modelId).toBe('qwen/qwen3-coder-30b');
  });

  it('a local endpoint with NOTHING loaded is still refused', async () => {
    const { d, posts, written } = deps({
      fetchLocalModels: async () => [],
      msg: { providerId: 'lmstudio', providerName: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', modelId: '' },
    });
    await setupProvider(d);
    expect(written).toEqual([]);
    expect(errors(posts)[0]).toContain('No model loaded');
  });
});

// A self-hosted server behind an API key. Previously impossible to express: the
// auto-pick branch was gated on `!apiKey`, so a key arriving with a blank model
// skipped the probe and died on the "needs a model id" guard with nothing
// written. The gate is now "is this baseURL self-hosted?" (selfHosted.ts) rather
// than "is it keyless?", which is the question that was actually meant — a
// loopback/tailnet server is one we can probe, whatever its auth.
describe('setupProvider — a self-hosted endpoint WITH an API key', () => {
  it('still auto-picks the loaded model, and the probe is given the key', async () => {
    const seen: Array<{ baseURL: string; apiKey?: string }> = [];
    const { d, written } = deps({
      fetchLocalModels: async (baseURL, apiKey) => { seen.push({ baseURL, apiKey }); return ['qwen/qwen3-coder-30b']; },
      msg: { providerId: 'lmstudio', providerName: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', apiKey: 'lms-secret-123', modelId: '' },
    });
    await setupProvider(d);
    // The regression this guards: without the key the probe 401s, the flow
    // reports "No model loaded" and a perfectly healthy server never connects.
    expect(seen).toEqual([{ baseURL: 'http://127.0.0.1:1234/v1', apiKey: 'lms-secret-123' }]);
    expect(written[0].modelId).toBe('qwen/qwen3-coder-30b');
  });

  it('persists the key on the written block, so the SDK can send it', async () => {
    const { d, written } = deps({
      fetchLocalModels: async () => ['m1'],
      msg: { providerId: 'lmstudio', providerName: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', apiKey: 'lms-secret-123', modelId: '' },
    });
    await setupProvider(d);
    expect(written[0].apiKey).toBe('lms-secret-123');
  });

  it('a BLANK key is not a key — nothing is persisted, exactly as before', async () => {
    const seen: Array<string | undefined> = [];
    const { d, written } = deps({
      fetchLocalModels: async (_b, apiKey) => { seen.push(apiKey); return ['m1']; },
      msg: { providerId: 'lmstudio', providerName: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', apiKey: '', modelId: '' },
    });
    await setupProvider(d);
    // undefined, never '' — writeModelConfig's `if (choice.apiKey)` and the SDK's
    // `...options.apiKey && { Authorization }` both key off truthiness, so an
    // empty string would be harmless, but the block must simply have no field.
    expect(written[0].apiKey).toBeUndefined();
    expect(seen).toEqual([undefined]);
    // ...and a blank key on a fresh ADD asks for NO clear. This is the 0.4.28
    // regression's boundary: the writer must be told to remove a key, never
    // left to infer it from the field being empty.
    expect(written[0].clearApiKey).toBe(false);
  });

  // The Re-key blank submit — the one caller allowed to remove a stored key.
  // ControlStrip decides it (providerIdentity.clearsStoredKey) and posts it;
  // this flow's only job is to carry it through to writeModelConfig unaltered.
  it('a Re-key blank submit carries clearApiKey THROUGH to the writer', async () => {
    const { d, written } = deps({
      fetchLocalModels: async () => ['m1'],
      msg: { providerId: 'lmstudio', providerName: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', apiKey: '', clearApiKey: true, modelId: '' },
    });
    await setupProvider(d);
    expect(written[0].apiKey).toBeUndefined();
    expect(written[0].clearApiKey).toBe(true);
  });

  it('a Re-key with a real key carries no clear — the key wins', async () => {
    const { d, written } = deps({
      fetchLocalModels: async () => ['m1'],
      msg: { providerId: 'lmstudio', providerName: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', apiKey: 'sk-typed', clearApiKey: false, modelId: '' },
    });
    await setupProvider(d);
    expect(written[0].apiKey).toBe('sk-typed');
    expect(written[0].clearApiKey).toBe(false);
  });

  it('a truthy-but-not-true clearApiKey is NOT a clear — only a real boolean removes a key', async () => {
    const { d, written } = deps({
      fetchLocalModels: async () => ['m1'],
      msg: { providerId: 'lmstudio', providerName: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', apiKey: '', clearApiKey: 'yes', modelId: '' },
    });
    await setupProvider(d);
    expect(written[0].clearApiKey).toBe(false);
  });

  it('a TAILNET endpoint with a key auto-picks too — not just loopback', async () => {
    const { d, written } = deps({
      fetchLocalModels: async () => ['qwen3.6-35b'],
      msg: { providerId: 'vllm', providerName: 'vLLM', baseURL: 'http://100.64.1.10:8000/v1', apiKey: 'sk-spark', modelId: '' },
    });
    await setupProvider(d);
    expect(written[0].modelId).toBe('qwen3.6-35b');
    expect(written[0].apiKey).toBe('sk-spark');
  });

  it('a keyed server that answers with NO models is still refused, key or not', async () => {
    const { d, posts, written } = deps({
      fetchLocalModels: async () => [],
      msg: { providerId: 'lmstudio', providerName: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', apiKey: 'k', modelId: '' },
    });
    await setupProvider(d);
    expect(written).toEqual([]);
    expect(errors(posts)[0]).toContain('No model loaded');
  });
});

describe('setupProvider — the paths that already worked keep working (part 2)', () => {

  it('a non-preset REMOTE compat provider with no model is still refused', async () => {
    // The "needs a model id" guard is not gone — it just no longer catches
    // presets that were always going to supply one.
    const { d, posts, written } = deps({
      msg: { providerId: 'other', providerName: 'Custom', baseURL: 'https://x.example/v1', apiKey: 'k', modelId: '' },
    });
    await setupProvider(d);
    expect(written).toEqual([]);
    expect(errors(posts)).toEqual(['Provider setup needs a model id.']);
  });

  it('a writer that throws is reported, not swallowed', async () => {
    const f = recordingFetch(() => ({ status: 200 }));
    const { d, posts } = deps({
      fetchImpl: f.impl,
      write: () => { throw new Error('config is corrupt'); },
      msg: { providerId: 'opencode', providerName: 'OpenCode Zen', apiKey: 'k', modelId: ZEN_DEFAULT_MODEL },
    });
    await setupProvider(d);
    expect(errors(posts)[0]).toBe('Provider setup failed: config is corrupt');
  });
});

describe('the preset table itself', () => {
  it('Zen and Go are DISTINCT gateways — Go must never point at the Zen base', () => {
    // models.dev: opencode = zen/v1, opencode-go = zen/go/v1. The old "one
    // gateway, key picks the tier" claim made a paid Go subscription look like
    // a dead key (owner-hit, 2026-08-21).
    expect(KEY_ONLY_PRESETS['opencode-go'].baseURL).toBe('https://opencode.ai/zen/go/v1');
    expect(KEY_ONLY_PRESETS['opencode'].baseURL).toBe('https://opencode.ai/zen/v1');
  });

  it("the Zen default is inside the family this /v1 preset can actually call", () => {
    // Zen routes gpt-* to /responses and claude-* to /messages, which this
    // chat-completions preset does not speak. A default from either family would
    // be a connection that cannot send its first message.
    expect(ZEN_DEFAULT_MODEL).not.toMatch(/^(gpt|claude)-/);
    expect(parseModelIds(ZEN_MODELS_FIXTURE)).toContain(ZEN_DEFAULT_MODEL);
  });

  it('OpenRouter carries NO default — its first model depends on the key tier', () => {
    expect(KEY_ONLY_PRESETS.openrouter.defaultModel).toBe('');
    expect(KEY_ONLY_PRESETS.openrouter.keylessCatalog).toBe(false);
  });

  it('an unknown provider id is not silently "validated"', async () => {
    const spy = vi.fn();
    const v = await checkProviderKey({ presetId: 'not-a-preset', apiKey: 'k', fetchImpl: spy as unknown as typeof fetch });
    expect(v.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});

// A CLOUD connection submits ONE model id (ControlStrip's cloud form is key +
// model id), and the picker is built from the config blocks — so before 0.4.60 a
// connected Claude declared exactly one model and offered exactly one row, for
// good. The family is attached here, host-side, and writeModelConfig merges it in
// (firstFold's `choice.catalog` loop) alongside whatever the form chose.
//
// The assertions are on what reaches the WRITER, because that is the observable
// the picker later reads back out of origami.json. `written[0].catalog` is the
// literal record writeModelConfig iterates.
describe('setupProvider — a Claude connect declares the whole family, not one model', () => {
  it('attaches the baked Claude catalog to the written choice', async () => {
    const { d, posts, written } = deps({
      msg: {
        providerId: 'anthropic',
        providerName: 'Claude',
        apiKey: 'sk-ant-real',
        modelId: CLAUDE_DEFAULT_MODEL,
        modelName: CLAUDE_DEFAULT_MODEL,
      },
    });
    await setupProvider(d);
    expect(errors(posts)).toEqual([]);
    expect(written).toHaveLength(1);
    // More than the submitted one, and the submitted one is among them — the two
    // halves of "the picker now offers the family".
    const ids = Object.keys(written[0].catalog ?? {});
    expect(ids.length).toBeGreaterThan(1);
    expect(ids).toContain(CLAUDE_DEFAULT_MODEL);
    expect(ids).toEqual(Object.keys(CLAUDE_MODELS));
  });

  it('every attached entry carries a real window and price — a 0 here breaks compaction and spend', async () => {
    // An engine spawned from source has no baked models.dev snapshot, so any
    // field the block omits resolves to 0: limit.context 0 disables auto-
    // compaction outright, and cost 0 makes the spend readout silently wrong.
    const { d, written } = deps({
      msg: { providerId: 'anthropic', providerName: 'Claude', apiKey: 'sk-ant', modelId: CLAUDE_DEFAULT_MODEL },
    });
    await setupProvider(d);
    for (const [id, m] of Object.entries(written[0].catalog!)) {
      const model = m as unknown as ClaudeModelConfig;
      expect(model.limit.context, `${id} context`).toBeGreaterThan(0);
      expect(model.limit.output, `${id} output`).toBeGreaterThan(0);
      expect(model.cost.input, `${id} input cost`).toBeGreaterThan(0);
      expect(model.name, `${id} display name`).toBeTruthy();
    }
  });

  it('a model id the form typed itself is still what gets SELECTED — the catalog only adds', async () => {
    const { d, written } = deps({
      msg: { providerId: 'anthropic', providerName: 'Claude', apiKey: 'sk-ant', modelId: 'claude-opus-4-7' },
    });
    await setupProvider(d);
    // cfg.model is built from modelId, so an id outside the baked six must not be
    // displaced by the default. (writeModelConfig writes it as its own entry.)
    expect(written[0].modelId).toBe('claude-opus-4-7');
    expect(Object.keys(written[0].catalog ?? {})).toContain(CLAUDE_DEFAULT_MODEL);
  });

  it('NO other provider gets a catalog — this is a Claude-only table, keyed on the engine id', async () => {
    // The guard that stops the family leaking onto OpenAI/xAI/local blocks, whose
    // model lists are their own business. Keyed on providerId, never on the label.
    for (const msg of [
      { providerId: 'openai', providerName: 'OpenAI', apiKey: 'sk-o', modelId: 'gpt-5' },
      { providerId: 'xai', providerName: 'xAI', apiKey: 'sk-x', modelId: 'grok-4' },
    ]) {
      const { d, written } = deps({ msg });
      await setupProvider(d);
      expect(written[0].catalog, msg.providerId).toBeUndefined();
    }
    const local = deps({
      fetchLocalModels: async () => ['m1'],
      msg: { providerId: 'lmstudio', providerName: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', modelId: '' },
    });
    await setupProvider(local.d);
    expect(local.written[0].catalog).toBeUndefined();
  });
});

describe('notifyError — a failed connect must be visible OFF the chat transcript', () => {
  // The defect (owner, 2026-08-21): the `post` error lines target a chat
  // session, and from the CONFIG view there may be no visible chat at all — a
  // refused OpenCode Go key produced NOTHING the user could see. The host toast
  // is the always-visible half; these pin that every failure exit reaches it.
  it('fires on a refused key, with the same sentence the transcript gets', async () => {
    const notifyError = vi.fn();
    const { d, posts, written } = deps({
      msg: { providerId: 'opencode-go', apiKey: 'bad-key' },
      fetchImpl: recordingFetch(() => ({ status: 401 })).impl,
      notifyError,
    });
    await setupProvider(d);
    expect(written).toHaveLength(0);
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError.mock.calls[0][0]).toBe(errors(posts)[0]);
    expect(notifyError.mock.calls[0][0]).toContain('OpenCode Go');
  });

  it('fires when the flow throws (Provider setup failed)', async () => {
    const notifyError = vi.fn();
    const { d } = deps({
      msg: { providerId: 'lmstudio', providerName: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', modelId: 'm' },
      write: () => { throw new Error('config is corrupt'); },
      notifyError,
    });
    await setupProvider(d);
    expect(notifyError).toHaveBeenCalledWith('Provider setup failed: config is corrupt');
  });

  it('stays silent on a successful connect — the reload toast owns that path', async () => {
    const notifyError = vi.fn();
    const { d, written } = deps({
      msg: { providerId: 'opencode-go', apiKey: 'good-key', modelId: 'deepseek-v4-flash-free' },
      fetchImpl: recordingFetch(() => ({ status: 200 })).impl,
      notifyError,
    });
    await setupProvider(d);
    expect(written).toHaveLength(1);
    expect(notifyError).not.toHaveBeenCalled();
  });
});
