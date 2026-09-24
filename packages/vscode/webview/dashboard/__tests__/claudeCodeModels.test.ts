// claudeCodeModels.test.ts — the two halves of one wire: the rows the HOST
// attaches to `modelOptions`, and the tab the PICKER derives from them.
//
// They are tested together because neither is meaningful alone. A row with no
// tab is unreachable; a tab with no rows is empty. The bug this pair replaces
// was exactly that kind of gap — a correct message with nowhere to land.

import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_ALIASES, CLAUDE_CODE_PROVIDER, claudeCodeAlias, claudeCodeModelRows,
  claudeCodeValue, isClaudeCodeModel,
} from '../../../src/claudeCode/models';
import { groupTooltip, withOffered } from '../components/offeredProviders';
import { classifySection } from '../../sidebar/connectionSection';

const CLI = { binary: 'C:\\claude.exe', version: '2.1.198', source: 'probe' };

describe('the rows the host offers', () => {
  it('offers nothing at all when the CLI was not found', () => {
    expect(claudeCodeModelRows(null)).toEqual([]);
    expect(claudeCodeModelRows(undefined)).toEqual([]);
  });

  it('offers the four aliases most-capable first, labelled, under ONE unversioned group', () => {
    const rows = claudeCodeModelRows(CLI);
    expect(rows.map((r) => r.value)).toEqual(['claude-code/fable', 'claude-code/opus', 'claude-code/sonnet', 'claude-code/haiku']);
    expect(rows.map((r) => r.name)).toEqual(['Fable', 'Opus', 'Sonnet', 'Haiku']);
    // The LABEL is the bare harness name. A tab that renamed itself on every CLI
    // upgrade made the version read as part of the product name.
    expect(new Set(rows.map((r) => r.group))).toEqual(new Set(['Claude Code']));
  });

  it('keeps the version, but in the TOOLTIP text rather than the label', () => {
    for (const row of claudeCodeModelRows(CLI)) expect(row.groupDetail).toBe('Claude Code 2.1.198');
    expect(groupTooltip(claudeCodeModelRows(CLI), 'Claude Code')).toBe('Claude Code 2.1.198');
    // No detail to show -> the tooltip falls back to the label, never to ''.
    expect(groupTooltip([{ value: 'x', group: 'Claude Code' }], 'Claude Code')).toBe('Claude Code');
    expect(groupTooltip(claudeCodeModelRows(CLI), 'LM Studio')).toBe('LM Studio');
  });

  it('never claims a vision capability it cannot know, and is never a config model', () => {
    for (const row of claudeCodeModelRows(CLI)) {
      // '' draws NO chip (ModelPickerRow's `{#if visionState}`) — an absence,
      // not an "auto-off" claim about a harness we never probed for images.
      expect(row.visionState).toBe('');
      expect(row.configured).toBe(false);
    }
  });

  it('still names the group when the CLI reported no version', () => {
    expect(claudeCodeModelRows({ ...CLI, version: '' })[0]!.group).toBe('Claude Code');
    expect(claudeCodeModelRows({ ...CLI, version: '' })[0]!.groupDetail).toBe('Claude Code');
  });
});

describe('the prefix that routes a pick away from the engine', () => {
  it('claims its own ids and nothing else', () => {
    expect(isClaudeCodeModel('claude-code/opus')).toBe(true);
    expect(isClaudeCodeModel('lmstudio/qwen3-30b')).toBe(false);
    expect(isClaudeCodeModel('claude-code')).toBe(false);       // the bare provider is not a model
    expect(isClaudeCodeModel('anthropic/claude-code/x')).toBe(false); // prefix, not substring
    expect(isClaudeCodeModel(undefined)).toBe(false);
    expect(isClaudeCodeModel(42)).toBe(false);
  });

  it('hands the CLI the bare alias, which is what `--model` takes', () => {
    expect(claudeCodeAlias('claude-code/opus')).toBe('opus');
    expect(claudeCodeAlias('lmstudio/qwen3-30b')).toBe('');
  });

  it('round-trips every alias it offers', () => {
    for (const alias of CLAUDE_CODE_ALIASES) expect(claudeCodeAlias(claudeCodeValue(alias))).toBe(alias);
    expect(claudeCodeValue('opus-4-1-20250805')).toBe(''); // a concrete id is not an alias we offer
  });

  it('buckets under Labs through the shared classifier, not a fork of it', () => {
    expect(classifySection({ id: CLAUDE_CODE_PROVIDER })).toBe('labs');
  });
});

describe('the tab the picker derives', () => {
  const rows = claudeCodeModelRows(CLI);
  const lmstudio = { id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1' };

  it('adds one provider per group, after the configured ones', () => {
    expect(withOffered([lmstudio], rows)).toEqual([
      lmstudio,
      { id: 'claude-code', name: 'Claude Code', live: true, detail: 'Claude Code 2.1.198' },
    ]);
  });

  it('adds nothing for rows that name no group — an ordinary catalogue is untouched', () => {
    const plain = [{ value: 'lmstudio/qwen3-30b' }, { value: 'openrouter/x' }];
    const base = [lmstudio];
    expect(withOffered(base, plain)).toBe(base); // same array: nothing to add
    expect(withOffered([], [])).toEqual([]);
  });

  it('never shadows a configured provider that already holds the id', () => {
    const own = { id: 'claude-code', name: 'My Own Block', live: false, baseURL: 'http://127.0.0.1:9/v1' };
    expect(withOffered([own], rows)).toEqual([own]);
  });

  it('adds ONE tab for four rows, not four', () => {
    const out = withOffered([], rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('Claude Code');
  });

  it('survives a malformed row rather than inventing an empty tab', () => {
    expect(withOffered([], [{ value: '', group: 'Ghost' }])).toEqual([]);
  });
});
