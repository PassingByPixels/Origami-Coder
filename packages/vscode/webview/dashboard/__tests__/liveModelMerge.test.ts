// liveModelMerge.test.ts — the model picker's live-mirror projection
// (src/dashboard/liveModelMerge.ts).
//
// The defect this suite pins: the picker's LM Studio and DGX Spark tabs showed
// an accumulated history of every model origami.json had ever held, not what the
// servers were serving. The merge itself was written correctly, but every poll
// ran under ONE `Promise.all` inside ONE `catch {}` — so the first poll to
// REJECT threw away every provider's live list at once. node:http throws
// synchronously on an `https:` URL, and a single https provider block was
// enough to disable the live mirror for every local server in the config.
//
// Hence the first test: one throwing provider, and its neighbours must still be
// mirrored. It fails against a bare `Promise.all` and passes with the
// per-provider catch. The rest pin the behaviour the mirror owes the user:
// prune-on-display, keep-config-when-down, and reconcile-options-onto-live-ids.

import { describe, expect, it, vi } from 'vitest';
import { mergeLiveModels, pollableProviders, type ModelOptionRow } from '../../../src/dashboard/liveModelMerge';
import type { ConfiguredProvider } from '../../../src/dashboard/firstFold';

/** A configured catalog row as the engine hands it to broadcastModelOptions. */
function cfgRow(value: string, name = value): ModelOptionRow {
  return { value, name, configured: true };
}

/** Provider blocks in origami.json shape. */
function providers(spec: Record<string, { baseURL?: string; models?: string[]; apiKey?: string }>): Record<string, ConfiguredProvider> {
  const out: Record<string, ConfiguredProvider> = {};
  for (const [pid, s] of Object.entries(spec)) {
    out[pid] = {
      options: {
        ...(s.baseURL ? { baseURL: s.baseURL } : {}),
        ...(s.apiKey ? { apiKey: s.apiKey } : {}),
      },
      models: Object.fromEntries((s.models ?? []).map((id) => [id, { name: id }])),
    };
  }
  return out;
}

describe('pollableProviders — which servers the node:http poller may ask', () => {
  it('offers http: base URLs and skips https:, so a cloud block is never polled', () => {
    const blocks = providers({
      forge: { baseURL: 'http://127.0.0.1:1234/v1' },
      rig1: { baseURL: 'http://10.20.30.40:8000/v1' },
      skyvault: { baseURL: 'https://skyvault.example/api/v1' },
      keyless: {},
    });
    expect(pollableProviders(blocks)).toEqual([
      { pid: 'forge', baseURL: 'http://127.0.0.1:1234/v1' },
      { pid: 'rig1', baseURL: 'http://10.20.30.40:8000/v1' },
    ]);
  });

  it('picks providers by PROTOCOL, not by name — an http provider called openrouter is still polled', () => {
    // The old code excluded a provider whose baseURL matched /openrouter\.ai/.
    // The rule is now "can node:http reach it", so nothing is special-cased by
    // name and every self-hosted server benefits without being listed anywhere.
    const blocks = providers({ openrouter: { baseURL: 'http://openrouter.local:9000/v1' } });
    expect(pollableProviders(blocks).map((p) => p.pid)).toEqual(['openrouter']);
  });

  it('carries a configured apiKey so a key-protected self-hosted server is still pollable', () => {
    // Without the key the poll 401s, ids come back empty, and mergeLiveModels'
    // "server did not answer" branch leaves the picker frozen on the configured
    // catalog — the live list silently stops tracking the server.
    const blocks = providers({ forge: { baseURL: 'http://127.0.0.1:1234/v1', apiKey: 'lms-secret-123' } });
    expect(pollableProviders(blocks)).toEqual([
      { pid: 'forge', baseURL: 'http://127.0.0.1:1234/v1', apiKey: 'lms-secret-123' },
    ]);
  });

  it('omits the key entirely when none is configured — no empty-string field', () => {
    const blocks = providers({ forge: { baseURL: 'http://127.0.0.1:1234/v1' } });
    expect(pollableProviders(blocks)).toEqual([{ pid: 'forge', baseURL: 'http://127.0.0.1:1234/v1' }]);
    expect('apiKey' in pollableProviders(blocks)[0]).toBe(false);
  });
});

describe('pollableProviders — keyless-catalog gateways (Zen/Go) are the ONE https exception', () => {
  // The requirement (owner, 2026-08-21): ONE OpenCode Go connection must offer
  // its models in the picker — not a connection per model. The gateway feed is
  // the ENTITLED set (gatewayEntitlements.ts), merged here exactly like a local
  // server's live list. The gate is the PRESET id's keylessCatalog flag, never
  // a URL or name match.
  it('offers an https block whose provider id is a keyless-catalog preset, key included', () => {
    const blocks = providers({
      'opencode-go': { baseURL: 'https://opencode.ai/zen/v1', apiKey: 'go-key-1' },
    });
    expect(pollableProviders(blocks)).toEqual([
      { pid: 'opencode-go', baseURL: 'https://opencode.ai/zen/v1', apiKey: 'go-key-1' },
    ]);
  });

  it('still skips https OpenRouter — its preset says keylessCatalog: false (own priced flow)', () => {
    const blocks = providers({
      openrouter: { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'or-key' },
    });
    expect(pollableProviders(blocks)).toEqual([]);
  });

  it('a Zen connection with one configured model yields every ENTITLED id as a pickable row', async () => {
    const blocks = providers({
      'opencode-go': { baseURL: 'https://opencode.ai/zen/v1', apiKey: 'go-key-1', models: ['deepseek-v4-flash-free'] },
    });
    const rows = await mergeLiveModels(
      [cfgRow('opencode-go/deepseek-v4-flash-free', 'deepseek-v4-flash-free')],
      blocks,
      async () => ['claude-fable-5', 'gpt-5.6-sol', 'deepseek-v4-flash-free'],
    );
    expect(rows).toEqual([
      { value: 'opencode-go/deepseek-v4-flash-free', name: 'deepseek-v4-flash-free', configured: true },
      { value: 'opencode-go/claude-fable-5', name: 'claude-fable-5', configured: false },
      { value: 'opencode-go/gpt-5.6-sol', name: 'gpt-5.6-sol', configured: false },
    ]);
  });
});

describe('mergeLiveModels — the key reaches the fetcher', () => {
  it('hands each provider its own key, and undefined for the keyless ones', async () => {
    const seen: Array<[string, string | undefined]> = [];
    const blocks = providers({
      forge: { baseURL: 'http://127.0.0.1:1234/v1', apiKey: 'lms-secret-123' },
      rig1: { baseURL: 'http://10.20.30.40:8000/v1' },
    });
    await mergeLiveModels([], blocks, async (baseURL, apiKey) => { seen.push([baseURL, apiKey]); return []; });
    expect(seen).toEqual([
      ['http://127.0.0.1:1234/v1', 'lms-secret-123'],
      ['http://10.20.30.40:8000/v1', undefined],
    ]);
  });
});

describe('mergeLiveModels — one bad provider must not poison the others (root cause)', () => {
  it('mirrors every reachable provider even when another provider POLL THROWS', async () => {
    const blocks = providers({
      forge: { baseURL: 'http://127.0.0.1:1234/v1', models: ['gone-a', 'gone-b'] },
      rig1: { baseURL: 'http://10.20.30.40:8000/v1', models: ['gone-c'] },
      // A block whose URL node:http cannot dial. The real poller threw
      // ERR_INVALID_PROTOCOL here, synchronously, before any request was made.
      relay: { baseURL: 'http://relay.invalid:1/v1', models: ['relay-one'] },
    });
    const fetchModels = vi.fn(async (baseURL: string) => {
      if (baseURL.includes('relay.invalid')) throw new TypeError('Protocol "https:" not supported. Expected "http:"');
      if (baseURL.includes('127.0.0.1')) return ['live-a'];
      return ['live-c'];
    });

    const rows = await mergeLiveModels(
      [cfgRow('forge/gone-a'), cfgRow('forge/gone-b'), cfgRow('rig1/gone-c'), cfgRow('relay/relay-one')],
      blocks,
      fetchModels,
    );

    const values = rows.map((r) => r.value);
    // The two reachable providers are mirrored…
    expect(values).toContain('forge/live-a');
    expect(values).toContain('rig1/live-c');
    expect(values).not.toContain('forge/gone-a');
    expect(values).not.toContain('forge/gone-b');
    expect(values).not.toContain('rig1/gone-c');
    // …and the thrower is degraded to its own configured list, alone.
    expect(values).toContain('relay/relay-one');
  });

  it('does not reject when EVERY poll throws — it degrades to the configured list', async () => {
    const blocks = providers({ forge: { baseURL: 'http://127.0.0.1:1234/v1', models: ['cfg-a'] } });
    const rows = await mergeLiveModels([cfgRow('forge/cfg-a')], blocks, async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(rows.map((r) => r.value)).toEqual(['forge/cfg-a']);
  });
});

describe('mergeLiveModels — the live list is the truth while the server answers', () => {
  it('a single-model server shows exactly one row however many the config holds', async () => {
    // The vLLM/DGX-Spark case: the server cannot switch models at runtime, so
    // /v1/models reports the ONE it loaded. Six accumulated config entries must
    // not read as six pickable models — five of them would 404 on the first turn.
    const blocks = providers({
      rig1: { baseURL: 'http://10.20.30.40:8000/v1', models: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'] },
    });
    const rows = await mergeLiveModels(
      ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map((id) => cfgRow(`rig1/${id}`)),
      blocks,
      async () => ['m4'],
    );
    expect(rows.map((r) => r.value)).toEqual(['rig1/m4']);
  });

  it('adds newly served models and drops ones the server no longer has', async () => {
    const blocks = providers({ forge: { baseURL: 'http://127.0.0.1:1234/v1', models: ['old-one', 'kept'] } });
    const rows = await mergeLiveModels(
      [cfgRow('forge/old-one'), cfgRow('forge/kept')],
      blocks,
      async () => ['kept', 'freshly-downloaded'],
    );
    expect(rows.map((r) => r.value).sort()).toEqual(['forge/freshly-downloaded', 'forge/kept']);
  });

  it('prunes only the polled provider — an unpollable one keeps its whole catalog', async () => {
    const blocks = providers({
      forge: { baseURL: 'http://127.0.0.1:1234/v1', models: ['stale'] },
      skyvault: { baseURL: 'https://skyvault.example/api/v1', models: ['cloud-a', 'cloud-b'] },
    });
    const rows = await mergeLiveModels(
      [cfgRow('forge/stale'), cfgRow('skyvault/cloud-a'), cfgRow('skyvault/cloud-b')],
      blocks,
      async () => ['served'],
    );
    expect(rows.map((r) => r.value)).toEqual(['skyvault/cloud-a', 'skyvault/cloud-b', 'forge/served']);
  });
});

describe('mergeLiveModels — a server that is down never empties a tab', () => {
  it('keeps the configured rows when the poll returns nothing', async () => {
    const blocks = providers({ forge: { baseURL: 'http://127.0.0.1:1234/v1', models: ['a', 'b'] } });
    const rows = await mergeLiveModels([cfgRow('forge/a'), cfgRow('forge/b')], blocks, async () => []);
    expect(rows.map((r) => r.value)).toEqual(['forge/a', 'forge/b']);
  });

  it('a stopped server does not cost the model its per-model config options', async () => {
    // Display-prune only: nothing here writes origami.json, so the block that
    // carries `variants`/`limit` for a briefly-offline model is untouched and
    // the row returns intact when the server does.
    const blocks = providers({ forge: { baseURL: 'http://127.0.0.1:1234/v1', models: ['tuned'] } });
    const before = JSON.stringify(blocks);
    await mergeLiveModels([cfgRow('forge/tuned')], blocks, async () => []);
    const back = await mergeLiveModels([cfgRow('forge/tuned')], blocks, async () => ['tuned']);
    expect(JSON.stringify(blocks)).toBe(before);
    expect(back.map((r) => r.value)).toEqual(['forge/tuned']);
  });
});

describe('mergeLiveModels — reconciling config options onto live ids', () => {
  it('a served id matching a config key carries that config entry, not a bare id', async () => {
    const blocks: Record<string, ConfiguredProvider> = {
      forge: {
        options: { baseURL: 'http://127.0.0.1:1234/v1' },
        models: { 'tuned-27b': { name: 'Tuned 27B' } },
      },
    };
    // The engine's snapshot predates the config edit, so the row is absent from
    // `options` and the merge is what re-introduces it.
    const rows = await mergeLiveModels([], blocks, async () => ['tuned-27b', 'never-configured']);
    expect(rows).toEqual([
      { value: 'forge/tuned-27b', name: 'Tuned 27B', configured: true },
      { value: 'forge/never-configured', name: 'never-configured', configured: false },
    ]);
  });

  it('leaves an already-present row alone rather than duplicating it', async () => {
    const blocks = providers({ forge: { baseURL: 'http://127.0.0.1:1234/v1', models: ['dup'] } });
    const rows = await mergeLiveModels([cfgRow('forge/dup', 'Engine Label')], blocks, async () => ['dup']);
    expect(rows).toEqual([{ value: 'forge/dup', name: 'Engine Label', configured: true }]);
  });

  it('does not mutate the caller\'s options array', async () => {
    const blocks = providers({ forge: { baseURL: 'http://127.0.0.1:1234/v1', models: ['stale'] } });
    const input = [cfgRow('forge/stale')];
    await mergeLiveModels(input, blocks, async () => ['served']);
    expect(input.map((r) => r.value)).toEqual(['forge/stale']);
  });
});
