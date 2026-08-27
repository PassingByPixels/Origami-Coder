// WHICH tab/provider is active, given a Grouping (modelGrouping.test.ts owns
// WHERE a provider sits) plus the user's explicit picks and the chat's
// current model. Split out of modelGrouping.test.ts at the same point the
// source split (round 5, t-o92558).

import { describe, expect, it } from 'vitest';
import { groupProviders, groupId, type PickerProvider } from './modelGrouping';
import { resolveTopSelection, resolveGroupProvider, resolveSelectedProvider } from './modelSelection';

const lmstudio: PickerProvider = { id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1' };
const openrouter: PickerProvider = { id: 'openrouter', name: 'OpenRouter', live: true, baseURL: 'https://openrouter.ai/api/v1' };
const opencodeZen: PickerProvider = { id: 'opencode', name: 'OpenCode Zen', live: true, baseURL: 'https://opencode.ai/zen/v1' };
const openai: PickerProvider = { id: 'openai', name: 'OpenAI', live: true };

describe('resolveTopSelection — the active top-level tab', () => {
  const g = groupProviders([lmstudio, openrouter, opencodeZen, openai]);
  const providersPill = groupId('providers');

  it('honours an explicit lone-provider pick', () => {
    expect(resolveTopSelection(g, 'lmstudio', 'openrouter')).toBe('lmstudio');
  });

  it('honours an explicit pill pick', () => {
    expect(resolveTopSelection(g, providersPill, 'lmstudio')).toBe(providersPill);
  });

  it('opens the tab that owns the current model, when it is a lone provider', () => {
    expect(resolveTopSelection(g, '', 'lmstudio')).toBe('lmstudio');
  });

  it('opens the pill when the current model belongs to one of its collapsed members', () => {
    // The key auto-select case: a current Providers-pill model must reach INTO the pill.
    expect(resolveTopSelection(g, '', 'opencode')).toBe(providersPill);
  });

  it('defaults to the first tab (SECTION_ORDER) with no pick and no current model', () => {
    expect(resolveTopSelection(g, '', '')).toBe('lmstudio');
  });

  it('defaults to the first tab even when it is itself a pill (no locals configured)', () => {
    const pillOnly = groupProviders([openrouter, opencodeZen]);
    expect(resolveTopSelection(pillOnly, '', '')).toBe(groupId('providers'));
  });

  it('is empty when nothing is configured', () => {
    expect(resolveTopSelection(groupProviders([]), '', '')).toBe('');
  });
});

describe('resolveGroupProvider — which provider within an active pill', () => {
  const members = groupProviders([openrouter, opencodeZen]).tabs[0].members;

  it('honours an explicit sub-pick', () => {
    expect(resolveGroupProvider(members, 'opencode', 'openrouter/x')).toBe('opencode');
  });

  it('falls to the current model\'s provider when it is a member of this pill', () => {
    expect(resolveGroupProvider(members, '', 'opencode')).toBe('opencode');
  });

  it('defaults to the first member', () => {
    expect(resolveGroupProvider(members, '', 'lmstudio')).toBe('openrouter');
  });

  it('is empty with no members', () => {
    expect(resolveGroupProvider([], '', 'openai')).toBe('');
  });
});

describe('resolveSelectedProvider — the concrete provider whose models show', () => {
  const g = groupProviders([lmstudio, openrouter, opencodeZen]);
  const providersPill = groupId('providers');

  it('resolves a pill selection to its chosen sub-provider', () => {
    expect(resolveSelectedProvider(g, providersPill, 'openrouter')).toBe('openrouter');
  });

  it('passes a concrete top selection straight through', () => {
    expect(resolveSelectedProvider(g, 'lmstudio', 'openrouter')).toBe('lmstudio');
  });
});
