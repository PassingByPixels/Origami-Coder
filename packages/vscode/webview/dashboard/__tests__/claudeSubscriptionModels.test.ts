// claudeSubscriptionModels.test.ts — the readiness shape (src/claudeSubscription/readiness.ts)
// and the rows the host attaches to `modelOptions` (src/claudeSubscription/models.ts),
// tested the same way claudeCodeModels.test.ts tests the passthrough's pair: the row
// with no tab is unreachable, the tab with no rows is empty, and a not-ready tab that
// still LOOKS pickable is the bug this pair exists to catch.

import { describe, expect, it } from 'vitest';
import {
  CLAUDE_SUBSCRIPTION_ALIASES, CLAUDE_SUBSCRIPTION_GROUP, CLAUDE_SUBSCRIPTION_PROVIDER,
  claudeSubscriptionAlias, claudeSubscriptionModelRows, claudeSubscriptionPickRefusal, isClaudeSubscriptionModel,
  mergeClaudeSubscriptionRows,
} from '../../../src/claudeSubscription/models';
import {
  CLAUDE_SUBSCRIPTION_VERSION_FLOOR, readinessFixLine, readinessFromCli,
  type ClaudeSubscriptionReadiness,
} from '../../../src/claudeSubscription/readiness';
import { groupTooltip, withOffered } from '../components/offeredProviders';
import { classifySection } from '../../sidebar/connectionSection';
import { visibleModels } from '../components/modelList';

describe('readinessFixLine — one line per state, empty for ready', () => {
  it('says nothing for ready', () => {
    expect(readinessFixLine({ state: 'ready' })).toBe('');
  });

  it('names the fix for cli-missing', () => {
    expect(readinessFixLine({ state: 'cli-missing' })).toMatch(/Install it/);
  });

  it('names the fix for not-logged-in', () => {
    expect(readinessFixLine({ state: 'not-logged-in' })).toMatch(/sign in/i);
  });

  it('names the found version AND the floor for version-too-old', () => {
    const line = readinessFixLine({ state: 'version-too-old', found: '2.0.5', floor: '2.1.263' });
    expect(line).toContain('2.0.5');
    expect(line).toContain('2.1.263');
  });

  // t-tjt9wd: the engine's own text for a Gate B reason none of the other
  // three name (env conflicts, no version reported at all).
  it('passes the engine\'s own reason through verbatim for the generic unready state', () => {
    expect(readinessFixLine({ state: 'unready', reason: 'ANTHROPIC_API_KEY is set' })).toBe('ANTHROPIC_API_KEY is set');
  });
});

describe('readinessFromCli — what this extension can tell locally', () => {
  it('no CLI at all -> cli-missing', () => {
    expect(readinessFromCli(null)).toEqual({ state: 'cli-missing' });
    expect(readinessFromCli(undefined)).toEqual({ state: 'cli-missing' });
  });

  it('a version below the floor -> version-too-old, carrying both numbers', () => {
    expect(readinessFromCli({ version: '2.1.198' })).toEqual({
      state: 'version-too-old', found: '2.1.198', floor: CLAUDE_SUBSCRIPTION_VERSION_FLOOR,
    });
  });

  it('a version AT the floor -> ready', () => {
    expect(readinessFromCli({ version: CLAUDE_SUBSCRIPTION_VERSION_FLOOR })).toEqual({ state: 'ready' });
  });

  it('a version above the floor -> ready', () => {
    expect(readinessFromCli({ version: '2.2.0' })).toEqual({ state: 'ready' });
  });

  it('a CLI that reports no version is not refused for it — same rule discovery.ts uses', () => {
    expect(readinessFromCli({ version: '' })).toEqual({ state: 'ready' });
  });

  // CANNOT produce not-logged-in — see readiness.ts's file header. Pinned so a
  // future local probe is a deliberate change, not a silent one.
  it('never reports not-logged-in — there is no local probe for it yet', () => {
    const states = [readinessFromCli(null), readinessFromCli({ version: '2.1.263' }), readinessFromCli({ version: '1.0.0' })];
    expect(states.some((s) => s.state === 'not-logged-in')).toBe(false);
  });
});

describe('claudeSubscriptionModelRows — the rows the host offers', () => {
  it('the setting is off: no rows at all, whatever the readiness', () => {
    expect(claudeSubscriptionModelRows(false, { state: 'ready' })).toEqual([]);
    expect(claudeSubscriptionModelRows(false, { state: 'cli-missing' })).toEqual([]);
  });

  it('on + ready: the four aliases, most-capable first, selectable', () => {
    const rows = claudeSubscriptionModelRows(true, { state: 'ready' });
    expect(rows.map((r) => r.value)).toEqual([
      'claude-subscription/fable', 'claude-subscription/opus', 'claude-subscription/sonnet', 'claude-subscription/haiku',
    ]);
    // t-xu5o64: the same "Claude (Sub)/<model>" the engine's rows carry.
    expect(rows.map((r) => r.name)).toEqual(['Claude (Sub)/Fable', 'Claude (Sub)/Opus', 'Claude (Sub)/Sonnet', 'Claude (Sub)/Haiku']);
    expect(new Set(rows.map((r) => r.group))).toEqual(new Set([CLAUDE_SUBSCRIPTION_GROUP]));
    for (const r of rows) {
      expect(r.selectable).not.toBe(false);
      expect(r.configured).toBe(false);
      expect(r.visionState).toBe('');
    }
  });

  it('the label never says "Claude Code"', () => {
    for (const r of claudeSubscriptionModelRows(true, { state: 'ready' })) expect(r.group).not.toMatch(/Claude Code/);
  });

  it.each<ClaudeSubscriptionReadiness>([
    { state: 'cli-missing' },
    { state: 'not-logged-in' },
    { state: 'version-too-old', found: '2.0.0', floor: '2.1.263' },
  ])('on + not ready ($state): ONE non-selectable marker row carrying the fix line', (readiness) => {
    const rows = claudeSubscriptionModelRows(true, readiness);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.group).toBe(CLAUDE_SUBSCRIPTION_GROUP);
    expect(rows[0]!.groupDetail).toBe(readinessFixLine(readiness));
    expect(rows[0]!.selectable).toBe(false);
    // Never a real alias — a stale caller iterating aliases must not pick it.
    expect(CLAUDE_SUBSCRIPTION_ALIASES.includes(rows[0]!.value.split('/')[1]!)).toBe(false);
  });
});

describe('isClaudeSubscriptionModel / claudeSubscriptionAlias — the prefix and the round-trip', () => {
  it('claims its own ids and nothing else', () => {
    expect(isClaudeSubscriptionModel('claude-subscription/opus')).toBe(true);
    expect(isClaudeSubscriptionModel('claude-code/opus')).toBe(false);
    expect(isClaudeSubscriptionModel('claude-subscription')).toBe(false);
    expect(isClaudeSubscriptionModel(undefined)).toBe(false);
  });

  it('round-trips every real alias', () => {
    for (const alias of CLAUDE_SUBSCRIPTION_ALIASES) {
      expect(claudeSubscriptionAlias(`${CLAUDE_SUBSCRIPTION_PROVIDER}/${alias}`)).toBe(alias);
    }
  });

  it('the not-ready marker is never read as a real alias', () => {
    expect(claudeSubscriptionAlias('claude-subscription/__status__')).toBe('');
  });

  it('buckets under Labs through the shared classifier', () => {
    expect(classifySection({ id: CLAUDE_SUBSCRIPTION_PROVIDER })).toBe('labs');
  });
});

describe('the tab the picker derives, and the empty-state message it carries', () => {
  it('adds ONE tab for the not-ready marker row, named for the group', () => {
    const rows = claudeSubscriptionModelRows(true, { state: 'cli-missing' });
    const out = withOffered([], rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe(CLAUDE_SUBSCRIPTION_GROUP);
    expect(groupTooltip(rows, CLAUDE_SUBSCRIPTION_GROUP)).toBe(readinessFixLine({ state: 'cli-missing' }));
  });

  it('adds ONE tab for the four ready rows too — not four', () => {
    const rows = claudeSubscriptionModelRows(true, { state: 'ready' });
    expect(withOffered([], rows)).toHaveLength(1);
  });

  it('visibleModels drops the not-ready marker even though its value carries the provider prefix', () => {
    const rows = claudeSubscriptionModelRows(true, { state: 'cli-missing' });
    const visible = visibleModels({
      providerId: CLAUDE_SUBSCRIPTION_PROVIDER, modelOptions: rows, openRouterModels: [], filter: '', loadedValue: '',
    });
    expect(visible).toEqual([]);
  });

  it('visibleModels lists the four ready aliases normally', () => {
    const rows = claudeSubscriptionModelRows(true, { state: 'ready' });
    const visible = visibleModels({
      providerId: CLAUDE_SUBSCRIPTION_PROVIDER, modelOptions: rows, openRouterModels: [], filter: '', loadedValue: '',
    });
    expect(visible.map((m) => m.value)).toEqual(rows.map((r) => r.value));
  });
});

// t-ty02bb. The engine lists the family's rows even while Gate B says no (the
// pinned four, in provider/claude-subscription.ts PINNED order), and the host
// used to append the marker row BESIDE them: on 0.4.170 the owner picked
// "claude-subscription/haiku" from a not-ready tab and learned why only when
// the first prompt failed.
describe('mergeClaudeSubscriptionRows — the engine rows and the host rows, joined', () => {
  const engine = [
    { value: 'lmstudio/qwen3', name: 'qwen3', configured: true },
    ...['sonnet', 'opus', 'haiku', 'fable'].map((id) => ({ value: `claude-subscription/${id}`, name: id, configured: true })),
  ];
  const tooOld: ClaudeSubscriptionReadiness = { state: 'version-too-old', found: '2.1.198', floor: '2.1.263' };
  const pick = (rows: Array<{ value: string; name: string; selectable?: boolean }>) =>
    visibleModels({ providerId: CLAUDE_SUBSCRIPTION_PROVIDER, modelOptions: rows, openRouterModels: [], filter: '', loadedValue: '' });

  it('not ready: nothing in the tab can be picked, and the tab says why', () => {
    const merged = mergeClaudeSubscriptionRows(engine, claudeSubscriptionModelRows(true, tooOld), tooOld);
    expect(pick(merged)).toEqual([]);
    expect(groupTooltip(merged, CLAUDE_SUBSCRIPTION_GROUP)).toBe(readinessFixLine(tooOld));
    expect(groupTooltip(merged, CLAUDE_SUBSCRIPTION_GROUP)).toContain('2.1.198');
    // Other providers' rows are untouched.
    expect(merged.map((r) => r.value)).toContain('lmstudio/qwen3');
  });

  it('ready: the engine catalog stays, each alias once', () => {
    const live = [...engine, { value: 'claude-subscription/opus[1m]', name: 'Opus (1M)', configured: true }];
    const merged = mergeClaudeSubscriptionRows(live, claudeSubscriptionModelRows(true, { state: 'ready' }), { state: 'ready' });
    const values = pick(merged).map((m) => m.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain('claude-subscription/opus[1m]');
    expect(values).toContain('claude-subscription/haiku');
  });

  it('the setting is off: the engine rows pass through unchanged', () => {
    expect(mergeClaudeSubscriptionRows(engine, [], tooOld)).toEqual(engine);
  });

  // t-xu5o64, owner UAT of 0.4.178 on a Max plan. The engine's live catalog is
  // the CLI picker's own values (recorded 2026-09-25 by one read-only handshake):
  // opus[1m], claude-fable-5-1[1m], sonnet, haiku. The host used to append its
  // aliases `fable` and `opus` beside them, because neither value is listed
  // under that exact name: two bare, unbadged rows ("Fable", "Opus").
  const ownerLive = [
    { value: 'lmstudio/qwen3', name: 'LM Studio/qwen3', configured: true, visionState: 'auto-off' },
    ...[['opus[1m]', 'Opus (1M context)'], ['claude-fable-5-1[1m]', 'Fable'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']]
      .map(([id, name]) => ({ value: `claude-subscription/${id}`, name: `Claude (Sub)/${name}`, configured: true, visionState: 'auto-on' })),
  ];

  it('ready with a live catalog: only the account\'s models, once each, named and badged alike, in one tab', () => {
    const merged = mergeClaudeSubscriptionRows(ownerLive, claudeSubscriptionModelRows(true, { state: 'ready' }), { state: 'ready' });
    const shown = pick(merged) as Array<{ value: string; name: string; visionState?: string }>;
    expect(shown.map((m) => m.value)).toEqual([
      'claude-subscription/opus[1m]', 'claude-subscription/claude-fable-5-1[1m]', 'claude-subscription/sonnet', 'claude-subscription/haiku',
    ]);
    for (const m of shown) {
      expect(m.name).toMatch(/^Claude \(Sub\)\//);
      expect(m.visionState).toBe('auto-on');
    }
    // The rows still give the family its one tab, named like the rows.
    const tabs = withOffered([], merged);
    expect(tabs.map((t) => t.name)).toEqual([CLAUDE_SUBSCRIPTION_GROUP]);
    expect(CLAUDE_SUBSCRIPTION_GROUP).toBe('Claude (Sub)');
    // Other providers' rows are untouched.
    expect(merged.find((r) => r.value === 'lmstudio/qwen3')).toEqual(ownerLive[0]);
  });

  it('ready but the engine lists no row of the family (no chat to ask): the aliases stand in, in the tab', () => {
    const merged = mergeClaudeSubscriptionRows(engine.slice(0, 1), claudeSubscriptionModelRows(true, { state: 'ready' }), { state: 'ready' });
    expect(pick(merged).map((m) => m.name)).toEqual(['Claude (Sub)/Fable', 'Claude (Sub)/Opus', 'Claude (Sub)/Sonnet', 'Claude (Sub)/Haiku']);
    expect(withOffered([], merged).map((t) => t.name)).toEqual([CLAUDE_SUBSCRIPTION_GROUP]);
  });
});

// t-y5ecbj, owner UAT of 0.4.179 (subscription ready, spare off). The picker
// showed Claude (Sub)/claude-fable-5-1[1m], /Fable (ticked: the saved pick
// `claude-subscription/fable`), /Haiku, /Opus, /opus[1m]. An engine lists its
// live catalog OR the pinned aliases, never both, so a second row of one family
// can only come from the origami.json block: every pick the chat's engine did
// not list is persisted there as `models[<id>] = { name: <id> }`
// (DashboardPanel setModel -> firstFold.writeModelConfig), and vision overrides
// add alias keys too (the block read from the owner's config on 2026-09-23 held
// opus, sonnet, haiku, fable).
describe('mergeClaudeSubscriptionRows — one row per model, readable names (t-y5ecbj)', () => {
  const READY: ClaudeSubscriptionReadiness = { state: 'ready' };
  const sub = (id: string, name: string) => ({ value: `claude-subscription/${id}`, name: `Claude (Sub)/${name}`, configured: true });
  const merged = (rows: Array<{ value: string; name: string }>, persisted: string[]) =>
    mergeClaudeSubscriptionRows(rows, claudeSubscriptionModelRows(true, READY), READY, new Set(persisted)) as Array<{ value: string; name: string; covers?: string[] }>;
  const family = (rows: Array<{ value: string }>) => rows.filter((r) => isClaudeSubscriptionModel(r.value));

  it('the UAT rows (pinned aliases + persisted full ids): each model once, readable, no raw id or [1m] in a name', () => {
    const uat = [
      sub('claude-fable-5-1[1m]', 'claude-fable-5-1[1m]'), sub('fable', 'Fable'), sub('haiku', 'Haiku'),
      sub('opus', 'Opus'), sub('opus[1m]', 'opus[1m]'), sub('sonnet', 'Sonnet'),
    ];
    const rows = family(merged(uat, ['opus', 'sonnet', 'haiku', 'fable', 'claude-fable-5-1[1m]', 'opus[1m]']));
    expect(rows.map((r) => [r.value, r.name])).toEqual([
      ['claude-subscription/claude-fable-5-1[1m]', 'Claude (Sub)/Fable (1M context)'],
      ['claude-subscription/haiku', 'Claude (Sub)/Haiku'],
      ['claude-subscription/opus[1m]', 'Claude (Sub)/Opus (1M context)'],
      ['claude-subscription/sonnet', 'Claude (Sub)/Sonnet'],
    ]);
  });

  it('live catalog + persisted alias rows named by their id: the aliases go, the live rows stay, names readable', () => {
    const live = [
      sub('opus[1m]', 'Opus (1M context)'), sub('claude-fable-5-1[1m]', 'Fable'), sub('sonnet', 'Sonnet'), sub('haiku', 'haiku'),
      sub('fable', 'fable'), sub('opus', 'opus'),
    ];
    const rows = family(merged(live, ['opus', 'sonnet', 'haiku', 'fable']));
    expect(rows.map((r) => [r.value, r.name])).toEqual([
      ['claude-subscription/opus[1m]', 'Claude (Sub)/Opus (1M context)'],
      ['claude-subscription/claude-fable-5-1[1m]', 'Claude (Sub)/Fable (1M context)'],
      ['claude-subscription/sonnet', 'Claude (Sub)/Sonnet'],
      ['claude-subscription/haiku', 'Claude (Sub)/Haiku'],
    ]);
  });

  it('a saved alias pick maps to its live row: the Fable row stands for `claude-subscription/fable`', () => {
    const rows = merged([sub('claude-fable-5-1[1m]', 'Fable'), sub('fable', 'fable'), sub('opus[1m]', 'Opus (1M context)'), sub('opus', 'opus')], ['fable', 'opus']);
    expect(rows.find((r) => r.value === 'claude-subscription/claude-fable-5-1[1m]')?.covers).toEqual(['claude-subscription/fable']);
    expect(rows.find((r) => r.value === 'claude-subscription/opus[1m]')?.covers).toEqual(['claude-subscription/opus']);
  });

  it('two rows of one family that both come from the live catalog (nothing persisted) both stay', () => {
    const rows = family(merged([sub('sonnet', 'Sonnet'), sub('sonnet[1m]', 'Sonnet (1M context)')], []));
    expect(rows.map((r) => r.value)).toEqual(['claude-subscription/sonnet', 'claude-subscription/sonnet[1m]']);
  });

  it('rows seeded from origami.json with no engine (bare names) read like the engine\'s', () => {
    const seeded = [{ value: 'claude-subscription/claude-fable-5-1[1m]', name: 'claude-fable-5-1[1m]', configured: true }];
    expect(family(merged(seeded, ['claude-fable-5-1[1m]'])).map((r) => r.name)).toEqual(['Claude (Sub)/Fable (1M context)']);
  });
});

describe('claudeSubscriptionPickRefusal — a pick is refused with the reason before any prompt', () => {
  it('not ready: says so, with the fix line', () => {
    const line = claudeSubscriptionPickRefusal('claude-subscription/haiku', { state: 'version-too-old', found: '2.1.198', floor: '2.1.263' });
    expect(line).toContain('not ready');
    expect(line).toContain('2.1.198');
    expect(line).toContain('2.1.263');
  });

  it('ready, or any other model: no refusal', () => {
    expect(claudeSubscriptionPickRefusal('claude-subscription/haiku', { state: 'ready' })).toBe('');
    expect(claudeSubscriptionPickRefusal('lmstudio/qwen3', { state: 'cli-missing' })).toBe('');
  });
});
