// The two formatters extracted out of ChatPane.svelte (t-qcx1cb). This file is the
// extraction's gift: inside the pane, `fmtHistoryDate`'s real job — an absent or
// unparseable timestamp — was reachable only by feeding the whole history list a bad
// row, so nothing ever checked it.

import { describe, expect, it } from 'vitest';
import { fmtHistoryDate, prettyModel } from './chatLabels';

describe('prettyModel', () => {
  it('drops the provider from a provider/model id', () => {
    expect(prettyModel('anthropic/claude-opus-4')).toBe('claude-opus-4');
  });

  it('keeps every later slash — an id can carry a path', () => {
    expect(prettyModel('lmstudio/qwen/qwen3-coder')).toBe('qwen/qwen3-coder');
  });

  it('leaves a bare id alone, and an absent one empty', () => {
    expect(prettyModel('gpt-5')).toBe('gpt-5');
    expect(prettyModel(undefined)).toBe('');
  });
});

describe('fmtHistoryDate', () => {
  it('is empty for an unparseable date, so the row prints its folder alone', () => {
    expect(fmtHistoryDate('not a date')).toBe('');
    expect(fmtHistoryDate('')).toBe('');
  });

  it('renders a real ISO timestamp as something', () => {
    expect(fmtHistoryDate('2026-09-21T12:00:00Z')).not.toBe('');
  });
});
