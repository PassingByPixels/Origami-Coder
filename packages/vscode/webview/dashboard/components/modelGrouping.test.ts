// The tier-1 provider grouping projection: which SECTION (Local/Self Hosted,
// Providers, Labs, Other — connectionSection.ts) each provider buckets into,
// and how a section collapses into ONE pill once it holds 2+ members. These
// assert the WHICH-pill-sits-where decisions the picker renders from,
// independent of the DOM. WHICH tab/provider ends up ACTIVE is a separate
// concern — see modelSelection.test.ts.
//
// Local and Hosted merged into ONE section: a loopback LM Studio and a tailnet
// vLLM are the same kind of thing and now share a pill. The tests below were
// rewritten rather than deleted — the pairs that used to prove "these two land
// in DIFFERENT sections" now prove "these two land in the SAME one", which is
// the assertion that goes red if anyone re-splits them.

import { describe, expect, it } from 'vitest';
import { groupProviders, groupId, promoteLoaded, type PickerProvider } from './modelGrouping';

const lmstudio: PickerProvider = { id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1' };
const ollama: PickerProvider = { id: 'ollama', name: 'Ollama', live: false, baseURL: 'http://127.0.0.1:11434/v1' };
const vllm: PickerProvider = { id: 'vllm', name: 'vLLM', live: true, baseURL: 'http://100.64.1.10:8000/v1' };
const spark2: PickerProvider = { id: 'spark2', name: 'Spark2', live: false, baseURL: 'http://100.64.1.20:8000/v1' };
const openrouter: PickerProvider = { id: 'openrouter', name: 'OpenRouter', live: true, baseURL: 'https://openrouter.ai/api/v1' };
const opencodeZen: PickerProvider = { id: 'opencode', name: 'OpenCode Zen', live: true, baseURL: 'https://opencode.ai/zen/v1' };
const openai: PickerProvider = { id: 'openai', name: 'OpenAI', live: true };
const anthropic: PickerProvider = { id: 'anthropic', name: 'Anthropic', live: true };

describe('groupProviders — a lone section member is its own top-level tab', () => {
  it('one self-hosted provider stays its own tab, not the Local/Self Hosted pill', () => {
    const g = groupProviders([lmstudio]);
    expect(g.tabs).toEqual([{ id: 'lmstudio', name: 'LM Studio', live: true, section: 'selfhosted', members: [lmstudio], collapsed: false }]);
  });

  it('a lone tailnet vLLM is its own tab, in the SAME section a loopback server would take', () => {
    const g = groupProviders([vllm]);
    expect(g.tabs).toEqual([{ id: 'vllm', name: 'vLLM', live: true, section: 'selfhosted', members: [vllm], collapsed: false }]);
    // The merge, stated as a relation so it survives a rename of the value:
    expect(groupProviders([vllm]).tabs[0].section).toBe(groupProviders([lmstudio]).tabs[0].section);
  });

  it('one aggregator (OpenRouter) is its own tab, not the Providers pill', () => {
    const g = groupProviders([openrouter]);
    expect(g.tabs[0]).toMatchObject({ id: 'openrouter', section: 'providers', collapsed: false });
  });

  it('one lab (OpenAI, id-only, no baseURL) is its own tab, not the Labs pill', () => {
    const g = groupProviders([openai]);
    expect(g.tabs[0]).toMatchObject({ id: 'openai', section: 'labs', collapsed: false });
  });
});

describe('groupProviders — 2+ members of a section collapse into that section\'s pill', () => {
  it('2 loopback providers collapse into the Local/Self Hosted pill', () => {
    const g = groupProviders([lmstudio, ollama]);
    expect(g.tabs).toEqual([
      { id: groupId('selfhosted'), name: 'Local/Self Hosted', live: true, section: 'selfhosted', members: [lmstudio, ollama], collapsed: true },
    ]);
  });

  it('2 tailnet providers collapse into that SAME pill — not a second "Hosted" one', () => {
    const g = groupProviders([vllm, spark2]);
    expect(g.tabs[0]).toMatchObject({ id: groupId('selfhosted'), name: 'Local/Self Hosted', collapsed: true, members: [vllm, spark2] });
  });

  it('THE MERGE: a loopback LM Studio and a tailnet vLLM share ONE pill, not two tabs', () => {
    // This is the ticket, in one assertion. Pre-merge these were two separate
    // one-item tabs ("LM Studio" and "vLLM"); they are now one collapsed pill.
    const g = groupProviders([lmstudio, vllm]);
    expect(g.tabs).toHaveLength(1);
    expect(g.tabs[0]).toMatchObject({
      id: groupId('selfhosted'),
      name: 'Local/Self Hosted',
      collapsed: true,
      members: [lmstudio, vllm],
    });
  });

  it('2 aggregators (OpenRouter + OpenCode Zen) collapse into the Providers pill', () => {
    // t-o92558 round 5 — OpenCode buckets HERE now, not with the labs below.
    const g = groupProviders([openrouter, opencodeZen]);
    expect(g.tabs[0]).toMatchObject({ id: groupId('providers'), name: 'Providers', collapsed: true, members: [openrouter, opencodeZen] });
  });

  it('2 labs collapse into the Labs pill — the mechanic every group above mirrors', () => {
    const g = groupProviders([openai, anthropic]);
    expect(g.tabs[0]).toMatchObject({ id: groupId('labs'), name: 'Labs', collapsed: true, members: [openai, anthropic] });
  });

  it('a pill\'s live dot lights if ANY member is live', () => {
    const g = groupProviders([{ ...openai, live: false }, { ...anthropic, live: true }]);
    expect(g.tabs[0].live).toBe(true);
  });
});

describe('groupProviders — mixed sections render in SECTION_ORDER, empty sections vanish', () => {
  it('self-hosted, providers and labs each get one row, Other never appears when empty', () => {
    // vLLM + LM Studio now share the FIRST row rather than taking one each, so
    // this list is three long where it used to be four — the merge, seen from
    // the render order.
    const g = groupProviders([anthropic, vllm, lmstudio, openrouter]);
    expect(g.tabs.map((t) => t.section)).toEqual(['selfhosted', 'providers', 'labs']);
  });

  it('is empty when nothing is configured', () => {
    expect(groupProviders([]).tabs).toEqual([]);
  });
});

describe('groupProviders — the modelOptions bootstrap fallback (no probe landed yet)', () => {
  it('an id with no baseURL and no recognised aggregator/lab match defaults to self-hosted, not Other', () => {
    // Exactly the shape ModelPicker builds before providerStatus lands: a bare
    // id scraped from modelOptions, nothing else. Must not vanish.
    const g = groupProviders([{ id: 'vllm', name: 'vLLM', live: false }]);
    expect(g.tabs).toEqual([{ id: 'vllm', name: 'vLLM', live: false, section: 'selfhosted', members: [{ id: 'vllm', name: 'vLLM', live: false }], collapsed: false }]);
  });

  it('a recognised lab id with no baseURL still resolves to Labs, not the bootstrap default', () => {
    expect(groupProviders([{ id: 'openai', name: 'openai', live: false }]).tabs[0].section).toBe('labs');
  });
});

describe('promoteLoaded — the already-loaded model leads the list', () => {
  const list = [
    { value: 'lmstudio/alpha' },
    { value: 'lmstudio/beta' },
    { value: 'lmstudio/gamma' },
  ];

  it('moves the loaded model to the front, preserving everything else in order', () => {
    expect(promoteLoaded(list, 'lmstudio/gamma').map((m) => m.value)).toEqual([
      'lmstudio/gamma',
      'lmstudio/alpha',
      'lmstudio/beta',
    ]);
  });

  it('never drops, duplicates or filters a row', () => {
    // The whole risk of reordering is losing something. Reselecting a model that
    // is not in this list at all must leave it completely alone.
    const out = promoteLoaded(list, 'openrouter/other');
    expect(out.map((m) => m.value)).toEqual(list.map((m) => m.value));
    expect(promoteLoaded(list, 'lmstudio/beta')).toHaveLength(list.length);
  });

  it('is a no-op when nothing is loaded or it is already first', () => {
    expect(promoteLoaded(list, '')).toEqual(list);
    expect(promoteLoaded(list, 'lmstudio/alpha')).toEqual(list);
  });

  it('survives an empty list', () => {
    expect(promoteLoaded([], 'lmstudio/alpha')).toEqual([]);
  });
});
