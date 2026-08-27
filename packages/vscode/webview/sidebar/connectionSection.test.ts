// Pure heuristic tests — no DOM. Mirrors providerGrid.test.ts.

import { describe, expect, it } from 'vitest';
import { classifySection, SECTION_ORDER, SECTION_LABEL, isSelfHostedHost } from './connectionSection';

// The Local and Hosted sections MERGED into one 'selfhosted' bucket: LM Studio,
// Ollama, SGLang and a tailnet vLLM are all the same kind of thing — a server the
// user runs — and splitting them on loopback-vs-LAN made the picker ask a question
// the user does not care about. The loopback/private DISTINCTION still exists as a
// predicate (isSelfHostedHost's two halves, and firstFold.isLoopbackBaseUrl on the
// host side), because `lms`/Ollama CLI management genuinely only works against a
// server on THIS machine — but that is a capability signal, not a grouping one.
describe('classifySection — every self-run server lands in ONE section', () => {
  it('127.0.0.1 (LM Studio\'s real default) is selfhosted', () => {
    expect(classifySection({ id: 'lmstudio', baseURL: 'http://127.0.0.1:1234/v1' })).toBe('selfhosted');
  });

  it('localhost by name is selfhosted', () => {
    expect(classifySection({ id: 'ollama', baseURL: 'http://localhost:11434/v1' })).toBe('selfhosted');
  });

  it('any 127.x.x.x is selfhosted, not just 127.0.0.1', () => {
    expect(classifySection({ baseURL: 'http://127.5.5.5:9000' })).toBe('selfhosted');
  });

  it('a tailnet 100.x address (vLLM\'s real Spark default) lands in the SAME section as LM Studio', () => {
    // The merge, asserted as an equality rather than two separate literals: this
    // is the test that goes red if anyone re-splits the sections later.
    expect(classifySection({ id: 'vllm', baseURL: 'http://100.64.1.10:8000/v1' }))
      .toBe(classifySection({ id: 'lmstudio', baseURL: 'http://127.0.0.1:1234/v1' }));
    expect(classifySection({ id: 'vllm', baseURL: 'http://100.64.1.10:8000/v1' })).toBe('selfhosted');
  });

  it('192.168.x LAN is selfhosted', () => {
    expect(classifySection({ baseURL: 'http://192.168.1.20:8080/v1' })).toBe('selfhosted');
  });

  it('10.x LAN is selfhosted', () => {
    expect(classifySection({ baseURL: 'http://10.0.0.5:9000' })).toBe('selfhosted');
  });

  it('172.16-31.x LAN is selfhosted, but 172.32.x (outside the RFC1918 block) is not', () => {
    expect(classifySection({ baseURL: 'http://172.20.0.5:9000' })).toBe('selfhosted');
    expect(classifySection({ baseURL: 'http://172.32.0.5:9000' })).toBe('other');
  });

  it('a bare host:port with no scheme still parses', () => {
    expect(classifySection({ baseURL: '100.64.1.30:8000' })).toBe('selfhosted');
  });

  it('100.x outside the CGNAT /10 (e.g. 100.200.x, a public 100.x address) is not tailnet', () => {
    expect(classifySection({ baseURL: 'http://100.200.1.1:8000' })).toBe('other');
  });
});

// The predicate the HOST side mirrors (src/dashboard/firstFold.ts's
// isSelfHostedBaseUrl). Exported so selfHosted.mirror.test.ts can read both
// files and fail on drift, per the repo's mirror rule.
describe('isSelfHostedHost — the loopback-or-private predicate, on its own', () => {
  it('accepts loopback and private/tailnet hosts', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '10.0.0.5', '192.168.1.20', '172.20.0.5', '100.64.0.1', '100.127.255.255'])
      expect(isSelfHostedHost(h), h).toBe(true);
  });

  it('rejects public hosts and the near-miss ranges', () => {
    for (const h of ['example.com', 'api.anthropic.com', '172.32.0.5', '100.200.1.1', '100.63.0.1', '8.8.8.8'])
      expect(isSelfHostedHost(h), h).toBe(false);
  });
});

describe('classifySection — known aggregator domains are Providers', () => {
  it('openrouter.ai by host is providers', () => {
    expect(classifySection({ id: 'openrouter', baseURL: 'https://openrouter.ai/api/v1' })).toBe('providers');
  });

  it('openrouter by id alone (no baseURL) still resolves to providers', () => {
    expect(classifySection({ id: 'openrouter' })).toBe('providers');
  });

  // t-o92558 round 5. Round 4 kept opencode.ai in Labs on an explicit owner
  // override even though it is an aggregator by shape (one key, many model
  // families — Zen, Go — same as openrouter.ai). The owner reversed that call:
  // shape and decision now agree, so both presets classify as providers off
  // their shared base URL, same as OpenRouter above.
  it('both OpenCode presets classify as providers off their shared base URL', () => {
    expect(classifySection({ id: 'opencode', baseURL: 'https://opencode.ai/zen/v1' })).toBe('providers');
    expect(classifySection({ id: 'opencode-go', baseURL: 'https://opencode.ai/zen/v1' })).toBe('providers');
  });

  it('opencode.ai is providers, NOT labs — it is bucketed with the aggregators', () => {
    expect(classifySection({ baseURL: 'https://opencode.ai/zen/v1' })).toBe('providers');
    expect(classifySection({ baseURL: 'https://opencode.ai/zen/v1' })).not.toBe('labs');
  });

  it('the OpenCode ids resolve to providers on their own, for a re-key with no baseURL to hand', () => {
    expect(classifySection({ id: 'opencode' })).toBe('providers');
    expect(classifySection({ id: 'opencode-go' })).toBe('providers');
  });
});

describe('classifySection — known lab domains/ids are Labs', () => {
  it('a baked-catalog cloud id with no baseURL (OpenAI/xAI/Anthropic\'s real shape) is labs', () => {
    expect(classifySection({ id: 'openai' })).toBe('labs');
    expect(classifySection({ id: 'xai' })).toBe('labs');
    expect(classifySection({ id: 'anthropic' })).toBe('labs');
  });

  it('a Google/Gemini id (no catalog entry yet, but named in the ticket) is labs', () => {
    expect(classifySection({ id: 'google' })).toBe('labs');
  });

  it('a lab domain wins even if somehow reached via baseURL', () => {
    expect(classifySection({ baseURL: 'https://api.anthropic.com/v1' })).toBe('labs');
  });
});

describe('classifySection — unknown never disappears, it falls to a visible Other', () => {
  it('an unrecognised public domain is other', () => {
    expect(classifySection({ baseURL: 'https://example.com/v1' })).toBe('other');
  });

  it('an unrecognised id with no baseURL (the generic "Other" catalog template) is other', () => {
    expect(classifySection({ id: 'other', baseURL: '' })).toBe('other');
  });

  it('a garbage baseURL string does not throw, it falls to other', () => {
    expect(() => classifySection({ baseURL: 'not a url at all ://' })).not.toThrow();
    expect(classifySection({ baseURL: 'not a url at all ://' })).toBe('other');
  });

  it('no id and no baseURL is other', () => {
    expect(classifySection({})).toBe('other');
  });
});

describe('SECTION_ORDER / SECTION_LABEL — the picker\'s fixed rendering order', () => {
  it('lists FOUR buckets in the stated order, Other last', () => {
    expect(SECTION_ORDER).toEqual(['selfhosted', 'providers', 'labs', 'other']);
  });

  it('every section has a human label', () => {
    for (const s of SECTION_ORDER) expect(SECTION_LABEL[s]).toBeTruthy();
  });

  it('the merged section is labelled "Local/Self Hosted"', () => {
    expect(SECTION_LABEL.selfhosted).toBe('Local/Self Hosted');
  });

  it('no section is labelled just "Hosted" any more — the split is gone from the UI too', () => {
    expect(Object.values(SECTION_LABEL)).not.toContain('Hosted');
  });
});
