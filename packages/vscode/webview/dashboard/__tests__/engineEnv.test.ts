// engineEnv.test.ts — what the shell adds to the engine child's environment
// (src/engineEnv.ts), driven against a faked `vscode` module.
//
// Two regressions this file exists for. The first is the one that made the
// module worth extracting: writing ORIGAMI_EXPERIMENTAL_CODE_MODE='false' when
// the setting is off would look harmless and would silently OVERRIDE an
// ORIGAMI_EXPERIMENTAL=true the user set outside VS Code — the engine reads the
// var as tri-state (runtime-flags.ts `enabledByExperimental`), so "off" has to
// mean "write nothing", not "write false".
//
// The second is drift: these var names are a mirror of the engine's, across a
// process boundary, so a rename there leaves the toggle doing nothing at all
// with every test still green. The last case reads the engine's own file.

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

import { ENGINE_FLAGS, CODE_MODE_SETTING, engineSpawnEnv, codeModeEnabled } from '../../../src/engineEnv';
import {
  AGENT_KIND_VAR,
  AGENT_NAME_VAR,
  AGENT_NAME_SETTING,
  BACKGROUND_KIND,
  agentNameSetting,
} from '../../../src/peerName';

beforeEach(() => {
  fake.settings = {};
  fake.throws = false;
});

describe('engineSpawnEnv — the flags this shell turns on', () => {
  it('always enables background subagents, whatever else is set', () => {
    expect(engineSpawnEnv({ codeMode: false })[ENGINE_FLAGS.backgroundSubagents]).toBe('true');
    expect(engineSpawnEnv({ codeMode: true })[ENGINE_FLAGS.backgroundSubagents]).toBe('true');
  });

  it('writes NO code-mode variable when the setting is off, rather than writing false', () => {
    const env = engineSpawnEnv({ codeMode: false });

    expect(Object.keys(env)).toEqual([ENGINE_FLAGS.backgroundSubagents]);
    expect(ENGINE_FLAGS.codeMode in env).toBe(false);
  });

  it('enables code mode only when the setting is on', () => {
    expect(engineSpawnEnv({ codeMode: true })[ENGINE_FLAGS.codeMode]).toBe('true');
  });
});

describe('codeModeEnabled — reading the setting', () => {
  it('is off by default, on only for an exact true', () => {
    expect(codeModeEnabled()).toBe(false);
    fake.settings[CODE_MODE_SETTING] = 'true';
    expect(codeModeEnabled()).toBe(false);
    fake.settings[CODE_MODE_SETTING] = true;
    expect(codeModeEnabled()).toBe(true);
  });

  it('is off when there is no settings store at all', () => {
    fake.settings[CODE_MODE_SETTING] = true;
    fake.throws = true;

    expect(codeModeEnabled()).toBe(false);
  });
});

describe('agentNameSetting — this window’s peer-discovery name', () => {
  it('is blank by default, trimmed when set, and blank with no settings store', () => {
    expect(agentNameSetting()).toBe('');
    fake.settings[AGENT_NAME_SETTING] = '  reviewer  ';
    expect(agentNameSetting()).toBe('reviewer');
    fake.throws = true;
    expect(agentNameSetting()).toBe('');
  });

  it('writes NO name variable when the setting is blank, so the engine’s basename(cwd) fallback stands', () => {
    // Writing an empty ORIGAMI_AGENT_NAME would beat the fallback and publish a
    // NAMELESS agent — the peer list's whole job is telling windows apart.
    expect(AGENT_NAME_VAR in engineSpawnEnv({ codeMode: false })).toBe(false);
    expect(AGENT_NAME_VAR in engineSpawnEnv({ codeMode: false, agentName: '   ' })).toBe(false);
  });

  it('writes the trimmed name when the setting has one', () => {
    expect(engineSpawnEnv({ codeMode: false, agentName: ' reviewer ' })[AGENT_NAME_VAR]).toBe('reviewer');
  });
});

describe('headless — the sessions no human is watching', () => {
  it('declares a headless session background, and says nothing for a chat', () => {
    // The engine reads ORIGAMI_CLIENT='acp' and concludes a person is watching.
    // This shell spawns one engine per LOCAL session, so that is equally true of
    // an Agent Manager run with no chat — which is where round-3 UAT delivered
    // three handoffs that nobody ever saw.
    expect(engineSpawnEnv({ codeMode: false, headless: true })[AGENT_KIND_VAR]).toBe(BACKGROUND_KIND);
    expect(AGENT_KIND_VAR in engineSpawnEnv({ codeMode: false })).toBe(false);
    expect(AGENT_KIND_VAR in engineSpawnEnv({ codeMode: false, headless: false })).toBe(false);
  });
});

describe('drift guard — the env var names are the engine’s', () => {
  const engineSrc = (...parts: string[]) =>
    readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'engine', 'src', ...parts),
      'utf8',
    );

  it('every name in ENGINE_FLAGS still exists in the engine’s runtime-flags.ts', () => {
    const src = engineSrc('effect', 'runtime-flags.ts');

    for (const name of Object.values(ENGINE_FLAGS)) {
      expect(src, `${name} is not read by the engine any more — the toggle would do nothing`).toContain(`"${name}"`);
    }
  });

  it('AGENT_NAME_VAR still exists in the engine file that READS it', () => {
    // Its own guard, pointed at its own reader: this one is not a runtime FLAG,
    // it is the identity string the peer broker resolves a display name from.
    // Renamed there and unguarded here, every window would silently fall back to
    // basename(cwd) and the setting would do nothing.
    expect(
      engineSrc('origami', 'agent-broker.ts'),
      `${AGENT_NAME_VAR} is not read by the broker any more — the setting would do nothing`,
    ).toContain(`"${AGENT_NAME_VAR}"`);
  });

  it('AGENT_KIND_VAR and its value still exist in the broker that READS them', () => {
    // Renamed there and unguarded here, every headless session would go back to
    // registering as interactive and peer handoffs would go back to landing in
    // chats that do not exist — silently, with this whole suite green.
    const src = engineSrc('origami', 'agent-broker.ts');

    expect(src, `${AGENT_KIND_VAR} is not read by the broker any more`).toContain(`"${AGENT_KIND_VAR}"`);
    expect(src, `"${BACKGROUND_KIND}" is not the word the broker compares against`).toContain(`"${BACKGROUND_KIND}"`);
  });
});
