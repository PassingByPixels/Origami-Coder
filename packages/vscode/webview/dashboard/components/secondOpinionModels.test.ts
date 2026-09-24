// secondOpinionModels — WHICH models may give a second opinion, and how the
// flyout arranges them.
//
// The rule the whole feature rests on is here, and it is one line of code with
// no visible symptom when it breaks: exclude the chat's OWN model. Get it wrong
// and the flyout still opens, the list still renders, a pick still produces a
// review — and the review is by the model that just did the work. Nothing in
// the UI could tell you. So it is asserted directly, on the projection, rather
// than by counting rows in a rendered flyout (where a row missing for an
// unrelated reason passes the same assertion).
//
// The other rules worth pinning: a value with no provider half cannot be split
// for the engine, so it must never be offered and then refused by the host;
// and the TIER a provider lands in must agree with the connections picker,
// because the same provider bucketing two ways in two menus a click apart is
// exactly the bug modelGrouping.ts's round 5 fixed.

import { describe, expect, it } from 'vitest';
import { reviewerModels, REVIEWER_MODEL_CAP } from './secondOpinionModels';

const options = [
  { value: 'lmstudio/qwen3-coder-30b', name: 'Qwen3 Coder 30B' },
  { value: 'lmstudio/devstral-small', name: 'Devstral Small' },
  { value: 'openrouter/anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
  { value: 'openrouter/openai/gpt-5', name: 'GPT-5' },
];

const list = (currentModel = '', filter = '') => reviewerModels({ modelOptions: options, currentModel, filter });
/** Every offered value, browse tree or search rows alike — the exclusion rule
 *  must hold identically in both projections. */
const flat = (l: ReturnType<typeof reviewerModels>) =>
  l.searching ? l.matches : l.tiers.flatMap((t) => t.providers.flatMap((g) => g.models));
const values = (currentModel = '', filter = '') => flat(list(currentModel, filter)).map((m) => m.value);
const providers = (l: ReturnType<typeof reviewerModels>) => l.tiers.flatMap((t) => t.providers.map((g) => g.provider));

describe('the chat’s own model is never a reviewer', () => {
  it('drops it — asking the model that just answered is the same opinion', () => {
    expect(values('lmstudio/qwen3-coder-30b')).toEqual([
      'lmstudio/devstral-small',
      'openrouter/anthropic/claude-sonnet-4',
      'openrouter/openai/gpt-5',
    ]);
  });

  it('drops it from a provider that has other models, leaving that provider present', () => {
    // The dangerous near-miss: excluding a whole PROVIDER instead of one model
    // would look right in any fixture where the current model is alone.
    const l = list('lmstudio/qwen3-coder-30b');
    expect(providers(l)).toEqual(['lmstudio', 'openrouter']);
    expect(l.tiers[0].providers[0].models.map((m) => m.name)).toEqual(['Devstral Small']);
  });

  it('drops a provider that had only that one model, rather than showing an empty heading', () => {
    const only = reviewerModels({
      modelOptions: [
        { value: 'lmstudio/qwen3-coder-30b', name: 'Qwen3 Coder 30B' },
        { value: 'openrouter/openai/gpt-5', name: 'GPT-5' },
      ],
      currentModel: 'lmstudio/qwen3-coder-30b',
      filter: '',
    });
    expect(providers(only)).toEqual(['openrouter']);
  });

  it('matches on the FULL value, never on the bare model name', () => {
    // "gpt-5" served by two providers is two different models. Excluding by the
    // bare half would silently remove the one still worth asking.
    const twice = reviewerModels({
      modelOptions: [
        { value: 'openrouter/openai/gpt-5', name: 'GPT-5' },
        { value: 'azure/openai/gpt-5', name: 'GPT-5 (Azure)' },
      ],
      currentModel: 'openrouter/openai/gpt-5',
      filter: '',
    });
    expect(flat(twice).map((m) => m.value)).toEqual(['azure/openai/gpt-5']);
  });

  it('excludes nothing when the chat has no model yet — there is no "same model" to guard', () => {
    expect(values('')).toHaveLength(4);
  });
});

describe('what cannot be offered', () => {
  it('drops a value with no provider half — the host could only refuse it', () => {
    const bad = reviewerModels({
      modelOptions: [
        { value: 'bare-model-id', name: 'Bare' },
        { value: '/leading-slash', name: 'Leading' },
        { value: 'trailing-slash/', name: 'Trailing' },
        { value: '', name: 'Empty' },
        { value: 'lmstudio/good', name: 'Good' },
      ],
      currentModel: '',
      filter: '',
    });
    expect(flat(bad).map((m) => m.value)).toEqual(['lmstudio/good']);
  });

  it('lists a duplicated catalogue entry once', () => {
    const dupes = reviewerModels({
      modelOptions: [
        { value: 'lmstudio/a', name: 'A' },
        { value: 'lmstudio/a', name: 'A again' },
      ],
      currentModel: '',
      filter: '',
    });
    expect(flat(dupes)).toHaveLength(1);
  });

  it('survives an empty catalogue with no groups and no counts', () => {
    expect(reviewerModels({ modelOptions: [], currentModel: 'lmstudio/x', filter: '' }))
      .toEqual({ searching: false, tiers: [], matches: [], shown: 0, total: 0 });
  });
});

describe('tiers — the connections picker’s own sections, off the same signal', () => {
  const status = [
    { id: 'lmstudio', baseURL: 'http://127.0.0.1:1234/v1' },
    { id: 'vllm-2', baseURL: 'http://100.64.1.30:8000/v1' },
    { id: 'openrouter', baseURL: 'https://openrouter.ai/api/v1' },
    { id: 'anthropic', baseURL: 'https://api.anthropic.com/v1' },
  ];
  const mixed = [
    { value: 'openrouter/openai/gpt-5', name: 'GPT-5' },
    { value: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' },
    { value: 'lmstudio/qwen3-coder-30b', name: 'Qwen3 Coder 30B' },
    { value: 'vllm-2/laguna-large', name: 'Laguna Large' },
  ];

  it('buckets by baseURL when the providerStatus probe has answered — loopback and tailnet are self-hosted', () => {
    const l = reviewerModels({ modelOptions: mixed, currentModel: '', filter: '', providerStatus: status });
    expect(l.tiers.map((t) => t.tier)).toEqual(['selfhosted', 'providers', 'labs']);
    expect(l.tiers[0].providers.map((g) => g.provider)).toEqual(['lmstudio', 'vllm-2']);
    expect(l.tiers[1].providers.map((g) => g.provider)).toEqual(['openrouter']);
    expect(l.tiers[2].providers.map((g) => g.provider)).toEqual(['anthropic']);
  });

  it('wears the SAME section faces the connections picker shows', () => {
    const l = reviewerModels({ modelOptions: mixed, currentModel: '', filter: '', providerStatus: status });
    expect(l.tiers.map((t) => t.label)).toEqual(['Local/Self Hosted', 'Providers', 'Labs']);
  });

  it('still classifies by id before the probe answers, defaulting the unrecognised to self-hosted', () => {
    // The picker's own bootstrap rule (modelGrouping.sectionOf): no baseURL yet,
    // so a known aggregator/lab id still buckets right and an unknown one reads
    // as the local server it almost always is — never lost to Other.
    const l = reviewerModels({ modelOptions: mixed, currentModel: '', filter: '' });
    expect(l.tiers.map((t) => t.tier)).toEqual(['selfhosted', 'providers', 'labs']);
    expect(l.tiers[0].providers.map((g) => g.provider)).toEqual(['lmstudio', 'vllm-2']);
  });

  it('sends an unrecognised PUBLIC host to the visible Other section, never hides it', () => {
    const l = reviewerModels({
      modelOptions: [{ value: 'myproxy/some-model', name: 'Some Model' }],
      currentModel: '',
      filter: '',
      providerStatus: [{ id: 'myproxy', baseURL: 'https://models.example.com/v1' }],
    });
    expect(l.tiers.map((t) => t.tier)).toEqual(['other']);
    expect(flat(l)).toHaveLength(1);
  });

  it('keeps catalogue order of first appearance within a tier — NOT alphabetical', () => {
    // The model picker shows the config file's own order, and two menus one
    // click apart must not disagree about it.
    const reversed = reviewerModels({
      modelOptions: [
        { value: 'zprovider/one', name: 'One' },
        { value: 'aprovider/two', name: 'Two' },
      ],
      currentModel: '',
      filter: '',
    });
    expect(providers(reversed)).toEqual(['zprovider', 'aprovider']);
  });

  it('falls back to the bare id when the catalogue entry has no display name', () => {
    const unnamed = reviewerModels({
      modelOptions: [{ value: 'lmstudio/qwen3', name: '' }],
      currentModel: '',
      filter: '',
    });
    expect(flat(unnamed)[0].name).toBe('qwen3');
  });
});

describe('the filter — flat ranked model rows, tree bypassed', () => {
  it('answers matches flat, with no tiers to click through', () => {
    const l = list('', 'devstral');
    expect(l.searching).toBe(true);
    expect(l.tiers).toEqual([]);
    expect(l.matches.map((m) => m.value)).toEqual(['lmstudio/devstral-small']);
  });

  it('matches the full value too — a user who knows the id finds it', () => {
    expect(values('', 'anthropic/')).toEqual(['openrouter/anthropic/claude-sonnet-4']);
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(values('', '  GPT-5 ')).toEqual(['openrouter/openai/gpt-5']);
  });

  it('cannot bring the excluded current model back', () => {
    expect(values('lmstudio/qwen3-coder-30b', 'qwen3')).toEqual([]);
  });

  it('ranks a name prefix over a name hit over an id-only hit', () => {
    const ranked = reviewerModels({
      modelOptions: [
        { value: 'p/serves-qwen-distill', name: 'Distill (qwen base)' }, // name hit
        { value: 'p/qwen3-coder', name: 'Qwen3 Coder' },                 // name prefix
        { value: 'p/mystery-qwen-id', name: 'Mystery' },                 // id-only hit
      ],
      currentModel: '',
      filter: 'qwen',
    });
    expect(ranked.matches.map((m) => m.value)).toEqual([
      'p/qwen3-coder',
      'p/serves-qwen-distill',
      'p/mystery-qwen-id',
    ]);
  });
});

describe('the caps', () => {
  const many = Array.from({ length: REVIEWER_MODEL_CAP + 12 }, (_, i) => ({
    value: `openrouter/model-${i}`,
    name: `Model ${i}`,
  }));

  it('caps one provider’s EXPANDED rows but reports its true count on the header', () => {
    const capped = reviewerModels({ modelOptions: many, currentModel: '', filter: '' });
    const group = capped.tiers[0].providers[0];
    expect(group.models).toHaveLength(REVIEWER_MODEL_CAP);
    expect(group.count).toBe(REVIEWER_MODEL_CAP + 12);
  });

  it('counts eligible models AFTER the exclusion, so a header count is not inflated by one', () => {
    const capped = reviewerModels({ modelOptions: many, currentModel: 'openrouter/model-0', filter: '' });
    expect(capped.tiers[0].providers[0].count).toBe(REVIEWER_MODEL_CAP + 11);
    expect(capped.total).toBe(REVIEWER_MODEL_CAP + 11);
  });

  it('caps search matches but reports the true match count, so the flyout can say it hid some', () => {
    const capped = reviewerModels({ modelOptions: many, currentModel: '', filter: 'model' });
    expect(capped.matches).toHaveLength(REVIEWER_MODEL_CAP);
    expect(capped.shown).toBe(REVIEWER_MODEL_CAP);
    expect(capped.total).toBe(REVIEWER_MODEL_CAP + 12);
  });

  it('reports shown === total outside search, so the flyout’s global hint stays silent', () => {
    const browse = reviewerModels({ modelOptions: many, currentModel: '', filter: '' });
    expect(browse.shown).toBe(browse.total);
  });
});
