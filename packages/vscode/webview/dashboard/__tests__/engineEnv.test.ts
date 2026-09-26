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

import { describe, expect, it, vi, afterAll, beforeEach } from 'vitest';
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
  SUBAGENT_LIMIT_DEFAULT_HOURS,
  SUBAGENT_LIMIT_MIN_HOURS,
  SUBAGENT_LIMIT_SETTING,
  subagentLimitHours,
  subagentMaxMs,
} from '../../../src/subagentLimit';
import {
  AGENT_KIND_VAR,
  AGENT_NAME_VAR,
  AGENT_NAME_SETTING,
  BACKGROUND_KIND,
  agentNameSetting,
} from '../../../src/peerName';
import { SIDE_QUESTS_FLAG, SIDE_QUESTS_SETTING, sideQuestsEnabled, sideQuestsSpawnEnv } from '../../../src/sideQuestsFlag';

/** `sideQuestsSpawnEnv` now reads the env override as well as the setting
 *  (t-fisfs5 R3), and `engineSpawnEnv` calls it with no argument, so it reads
 *  the REAL process env. A developer running the suite with
 *  ORIGAMI_EXPERIMENTAL_SIDE_QUESTS set would otherwise flip every
 *  setting-driven case below; the var is cleared for the file and restored
 *  after it. */
const realSideQuestsVar = process.env[SIDE_QUESTS_FLAG];

beforeEach(() => {
  fake.settings = {};
  fake.throws = false;
  delete process.env[SIDE_QUESTS_FLAG];
});

afterAll(() => {
  if (realSideQuestsVar === undefined) delete process.env[SIDE_QUESTS_FLAG];
  else process.env[SIDE_QUESTS_FLAG] = realSideQuestsVar;
});

describe('engineSpawnEnv — the flags this shell turns on', () => {
  it('always enables background subagents, whatever else is set', () => {
    expect(engineSpawnEnv({ codeMode: false })[ENGINE_FLAGS.backgroundSubagents]).toBe('true');
    expect(engineSpawnEnv({ codeMode: true })[ENGINE_FLAGS.backgroundSubagents]).toBe('true');
  });

  it('writes NO code-mode variable when the setting is off, rather than writing false', () => {
    // Flock explicitly ON here so its own (now off-by-default) overlay does
    // not add a key this test is not about — see flockKillSwitch.test.ts.
    // This mock's `get` reads the bare key, same as CODE_MODE_SETTING above.
    fake.settings['enabled'] = true;
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

// t-fdv45j gave the flag a setting; t-ffjau8 turned the default over. The
// direction the variable is written in is now the OPPOSITE of code mode above:
// the engine defaults to ON, so silence means on and only OFF is spoken.
describe('side quests (t-fdv45j, default ON since t-ffjau8) — the setting reaches the engine spawn', () => {
  it('writes NO side-quests variable when the setting is on, because the engine already defaults to on', () => {
    expect(ENGINE_FLAGS.sideQuests in engineSpawnEnv({ codeMode: false })).toBe(false);
    expect(sideQuestsSpawnEnv()).toEqual({});
    fake.settings[SIDE_QUESTS_SETTING] = true;
    expect(ENGINE_FLAGS.sideQuests in engineSpawnEnv({ codeMode: false })).toBe(false);
    expect(sideQuestsSpawnEnv()).toEqual({});
  });

  it('writes the flag as an explicit false, and only when the setting is off', () => {
    fake.settings[SIDE_QUESTS_SETTING] = false;
    expect(engineSpawnEnv({ codeMode: false })[ENGINE_FLAGS.sideQuests]).toBe('false');
    expect(sideQuestsSpawnEnv()).toEqual({ [SIDE_QUESTS_FLAG]: 'false' });
  });

  it('sideQuestsEnabled is on by default and follows the setting once the env var is unset', () => {
    expect(sideQuestsEnabled({})).toBe(true);
    fake.settings[SIDE_QUESTS_SETTING] = false;
    expect(sideQuestsEnabled({})).toBe(false);
    fake.settings[SIDE_QUESTS_SETTING] = true;
    expect(sideQuestsEnabled({})).toBe(true);
  });

  it('is on when there is no settings store at all, the same way the engine defaults', () => {
    fake.throws = true;
    expect(sideQuestsEnabled({})).toBe(true);
    expect(sideQuestsSpawnEnv()).toEqual({});
  });

  // t-fisfs5 R3: the overlay used to read the SETTING alone, so a dev env var
  // moved the drawer without moving the engine (and the reverse). Both halves
  // now answer off one function.
  it('the spawn overlay agrees with the drawer when the env var says ON and the setting says off', () => {
    fake.settings[SIDE_QUESTS_SETTING] = false;
    const env = { [SIDE_QUESTS_FLAG]: 'true' };
    expect(sideQuestsEnabled(env)).toBe(true);
    // Nothing written: the engine's own default is ON and the inherited `true`
    // must not be overwritten with an explicit `false`.
    expect(sideQuestsSpawnEnv(env)).toEqual({});
  });

  it('the spawn overlay agrees with the drawer when the env var says OFF and the setting says on', () => {
    fake.settings[SIDE_QUESTS_SETTING] = true;
    const env = { [SIDE_QUESTS_FLAG]: 'false' };
    expect(sideQuestsEnabled(env)).toBe(false);
    expect(sideQuestsSpawnEnv(env)).toEqual({ [SIDE_QUESTS_FLAG]: 'false' });
  });

  it('with no env var set, the overlay still follows the setting alone', () => {
    expect(sideQuestsSpawnEnv({})).toEqual({});
    fake.settings[SIDE_QUESTS_SETTING] = false;
    expect(sideQuestsSpawnEnv({})).toEqual({ [SIDE_QUESTS_FLAG]: 'false' });
  });

  it('the env var wins over the setting whenever it is SET, in either direction', () => {
    fake.settings[SIDE_QUESTS_SETTING] = true;
    expect(sideQuestsEnabled({ [SIDE_QUESTS_FLAG]: 'false' })).toBe(false);
    fake.settings[SIDE_QUESTS_SETTING] = false;
    expect(sideQuestsEnabled({ [SIDE_QUESTS_FLAG]: 'true' })).toBe(true);
    expect(sideQuestsEnabled({ [SIDE_QUESTS_FLAG]: '1' })).toBe(true);
  });

  it('is contributed as a boolean, default TRUE, and says new chats pick it up', () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json'), 'utf8'),
    );
    const prop = pkg.contributes.configuration.properties[`origami.${SIDE_QUESTS_SETTING}`];
    expect(prop, 'the setting is not contributed at all').toBeDefined();
    expect(prop.type).toBe('boolean');
    // t-ffjau8. The headline feature ships on; a `false` here is the whole bug
    // this ticket fixed — the owner had no such setting and had no tool.
    expect(prop.default).toBe(true);
    expect(prop.description.toLowerCase()).toContain('on by default');
    expect(prop.description.toLowerCase()).toContain('turn this off');
    expect(prop.description.toLowerCase()).toContain('new chat');
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

describe('the sub-agent time limit — hours in, milliseconds out', () => {
  it('converts the setting’s hours to the milliseconds the engine reads', () => {
    expect(engineSpawnEnv({ codeMode: false, subagentLimitHours: 4 })[ENGINE_FLAGS.subagentMaxMs]).toBe('14400000');
    expect(engineSpawnEnv({ codeMode: false, subagentLimitHours: 0.5 })[ENGINE_FLAGS.subagentMaxMs]).toBe('1800000');
  });

  it('rounds to a WHOLE millisecond, because the engine discards a fraction', () => {
    // runtime-flags.ts reads this with `positiveInteger`, which maps a
    // non-integer to undefined — it does not clamp. An unrounded value would
    // look exactly like the setting doing nothing, with no error anywhere.
    expect(subagentMaxMs(1 / 3)).toBeUndefined(); // under the minimum first
    expect(subagentMaxMs(2.0000001)).toBe('7200000');
    expect(Number.isInteger(Number(subagentMaxMs(1.7)))).toBe(true);
  });

  it('writes NO variable when nothing usable is set, so the engine’s own default stands', () => {
    // Writing this shell's idea of four hours would freeze the engine's default
    // at whatever this file believed on the day it shipped.
    expect(ENGINE_FLAGS.subagentMaxMs in engineSpawnEnv({ codeMode: false })).toBe(false);
    expect(subagentMaxMs(undefined)).toBeUndefined();
    expect(subagentMaxMs(Number.NaN)).toBeUndefined();
    expect(subagentMaxMs(0)).toBeUndefined();
    expect(subagentMaxMs(-1)).toBeUndefined();
  });

  it('refuses a value below the minimum rather than clamping it up', () => {
    // Clamping would run a cap the user never chose while settings.json showed
    // another number — a silent disagreement is worse than the default.
    expect(subagentMaxMs(SUBAGENT_LIMIT_MIN_HOURS - 0.01)).toBeUndefined();
    expect(subagentMaxMs(SUBAGENT_LIMIT_MIN_HOURS)).toBe('1800000');
  });

  it('reads the setting, and reads nothing when there is no store', () => {
    expect(subagentLimitHours()).toBeUndefined();
    fake.settings[SUBAGENT_LIMIT_SETTING] = 2;
    expect(subagentLimitHours()).toBe(2);
    fake.settings[SUBAGENT_LIMIT_SETTING] = '2';
    expect(subagentLimitHours()).toBeUndefined();
    fake.settings[SUBAGENT_LIMIT_SETTING] = 6;
    fake.throws = true;
    expect(subagentLimitHours()).toBeUndefined();
  });

  it('declares the SAME default and minimum as package.json contributes', () => {
    // The pane shows these numbers and VS Code enforces them; two sources that
    // disagree means a settings.json value the pane cannot represent.
    const pkg = JSON.parse(
      readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json'), 'utf8'),
    );
    const prop = pkg.contributes.configuration.properties[`origami.${SUBAGENT_LIMIT_SETTING}`];
    expect(prop, 'the setting is not contributed at all').toBeDefined();
    expect(prop.type).toBe('number');
    expect(prop.default).toBe(SUBAGENT_LIMIT_DEFAULT_HOURS);
    expect(prop.minimum).toBe(SUBAGENT_LIMIT_MIN_HOURS);
    // The env is read at SPAWN. A description that does not say so sends the
    // user looking for a bug when the change appears to do nothing. t-xtimx0:
    // a NEW chat spawns with it at once; no reload is needed.
    expect(prop.description.toLowerCase()).toContain('new chats');
    expect(prop.description.toLowerCase()).not.toContain('reload the window');
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
