// claudeSubscriptionFlag.test.ts — the origami.experimentalClaudeSubscription
// setting (src/claudeSubscriptionFlag.ts) and the env overlay it adds to a
// spawn, driven against a faked `vscode` module (engineEnv.test.ts's harness).
//
// The regression this guards: writing the var as an explicit 'false' would
// look harmless and would silently OVERRIDE an
// ORIGAMI_EXPERIMENTAL_CLAUDE_SUBSCRIPTION=true a dev set outside VS Code —
// same class of bug engineEnv.test.ts pins for code mode. Plus two drift
// tests: one against ENGINE_FLAGS (t-tjt9wd — the name is now registered
// there, and engineEnv.test.ts's own drift guard checks it reads the engine's
// runtime-flags.ts), one against package.json's own contribution, so the
// setting id, default and env var name stay declared where the report says
// they are.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { fake } = vi.hoisted(() => ({ fake: { settings: {} as Record<string, unknown>, throws: false } }));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => {
      if (fake.throws) throw new Error('no settings store');
      return { get: (key: string) => fake.settings[key] };
    },
  },
}));

import {
  CLAUDE_SUBSCRIPTION_FLAG, CLAUDE_SUBSCRIPTION_SETTING, CLAUDE_SUBSCRIPTION_SETTING_ID,
  claudeSubscriptionEnabled, claudeSubscriptionSpawnEnv,
} from '../../../src/claudeSubscriptionFlag';
import { ENGINE_FLAGS } from '../../../src/engineEnv';

beforeEach(() => {
  fake.settings = {};
  fake.throws = false;
});

describe('claudeSubscriptionEnabled — reading the setting', () => {
  it('is off by default, on only for an exact true', () => {
    expect(claudeSubscriptionEnabled()).toBe(false);
    fake.settings[CLAUDE_SUBSCRIPTION_SETTING] = 'true';
    expect(claudeSubscriptionEnabled()).toBe(false);
    fake.settings[CLAUDE_SUBSCRIPTION_SETTING] = true;
    expect(claudeSubscriptionEnabled()).toBe(true);
  });

  it('is off when there is no settings store at all', () => {
    fake.settings[CLAUDE_SUBSCRIPTION_SETTING] = true;
    fake.throws = true;
    expect(claudeSubscriptionEnabled()).toBe(false);
  });
});

describe('claudeSubscriptionSpawnEnv — the overlay one spawn adds', () => {
  it('writes NOTHING when the setting is off, rather than an explicit false', () => {
    expect(claudeSubscriptionSpawnEnv()).toEqual({});
  });

  it('writes true only when the setting is on', () => {
    fake.settings[CLAUDE_SUBSCRIPTION_SETTING] = true;
    expect(claudeSubscriptionSpawnEnv()).toEqual({ [CLAUDE_SUBSCRIPTION_FLAG]: 'true' });
  });
});

describe('registered in ENGINE_FLAGS (t-tjt9wd)', () => {
  it('rides the same table every other engine flag does', () => {
    expect(ENGINE_FLAGS.claudeSubscription).toBe(CLAUDE_SUBSCRIPTION_FLAG);
    expect(Object.values(ENGINE_FLAGS)).toContain(CLAUDE_SUBSCRIPTION_FLAG);
  });
});

describe('the setting is contributed with the declared default, id and behaviour', () => {
  it('matches package.json exactly', () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json'), 'utf8'),
    );
    const prop = pkg.contributes.configuration.properties[CLAUDE_SUBSCRIPTION_SETTING_ID];
    expect(prop, 'the setting is not contributed at all').toBeDefined();
    expect(prop.type).toBe('boolean');
    expect(prop.default).toBe(false);
    expect(prop.description.toLowerCase()).toContain('experimental');
    expect(prop.description.toLowerCase()).toContain('one-time disclosure');
  });
});
