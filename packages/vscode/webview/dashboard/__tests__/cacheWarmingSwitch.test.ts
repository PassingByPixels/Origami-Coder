// cacheWarmingSwitch.test.ts — `origamicoder.cacheWarming.enabled` (t-ntmmvh),
// in the three places turning it off has to reach.
//
// The promise the setting makes is not "the card looks off". It is: the engine
// child is spawned with the kill switch set, and no warm request goes out. The
// engine half is proven in packages/engine/test/session/cache-warm.test.ts,
// against the module that owns the timer; this proves the shell half, and the
// NAME both halves have to agree on is read out of the engine's own source so
// the two cannot drift apart silently.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';

const { fake } = vi.hoisted(() => ({
  fake: { settings: {} as Record<string, unknown>, throws: false, updateThrows: false },
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: (section: string) => {
      if (fake.throws) throw new Error('no settings store');
      return {
        get: (key: string) => fake.settings[`${section}.${key}`],
        update: (key: string, value: unknown) => {
          if (fake.updateThrows) throw new Error('settings file is read-only');
          fake.settings[`${section}.${key}`] = value;
          return Promise.resolve();
        },
      };
    },
  },
  ConfigurationTarget: { Global: 1 },
}));

import {
  CACHE_WARMING_DISABLE_VAR,
  CACHE_WARMING_SETTING,
  cacheWarmingEnabled,
  cacheWarmingSpawnEnv,
  setCacheWarmingEnabled,
} from '../../../src/cacheWarming';
import { engineSpawnEnv } from '../../../src/engineEnv';
import { handleCacheWarmingMessage } from '../../../src/dashboard/cacheWarmingPane';
import CacheWarmingCard from '../components/CacheWarmingCard.svelte';

const pkg = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string) => readFileSync(nodePath.join(pkg, rel), 'utf8');

beforeEach(() => {
  fake.settings = {};
  fake.throws = false;
  fake.updateThrows = false;
  globalThis.__vscodeApiMock.postMessage.mockClear();
});
afterEach(() => cleanup());

describe('cacheWarmingEnabled — reading the setting', () => {
  // 0.4.184 (owner, 2026-09-26): OFF by default. Until 0.4.183 no warm was ever
  // sent (InstanceRef bug), so a warm is a new cost for users who never asked for it.
  it('is OFF by default, and the id is the one the package contributes', () => {
    expect(cacheWarmingEnabled()).toBe(false);
    expect(CACHE_WARMING_SETTING).toBe('origamicoder.cacheWarming.enabled');
    const contributed = JSON.parse(read('package.json')).contributes.configuration.properties[
      CACHE_WARMING_SETTING
    ];
    expect(contributed).toBeDefined();
    // The default ships in the manifest too, or VS Code shows a switch whose
    // position disagrees with what the engine will actually do.
    expect(contributed.default).toBe(false);
  });

  it('is on for an explicit true and NOTHING else', () => {
    fake.settings[CACHE_WARMING_SETTING] = true;
    expect(cacheWarmingEnabled()).toBe(true);
    for (const junk of ['true', 1, null, undefined, {}]) {
      fake.settings[CACHE_WARMING_SETTING] = junk;
      expect(cacheWarmingEnabled(), String(junk)).toBe(false);
    }
  });

  it('is off when there is no settings store at all', () => {
    fake.settings[CACHE_WARMING_SETTING] = true;
    fake.throws = true;
    expect(cacheWarmingEnabled()).toBe(false);
  });
});

describe('setCacheWarmingEnabled — writing the setting', () => {
  it('round-trips, and reports a refused write instead of pretending', async () => {
    expect(await setCacheWarmingEnabled(false)).toBeUndefined();
    expect(cacheWarmingEnabled()).toBe(false);
    expect(await setCacheWarmingEnabled(true)).toBeUndefined();
    expect(cacheWarmingEnabled()).toBe(true);
    fake.updateThrows = true;
    expect(await setCacheWarmingEnabled(false)).toContain('read-only');
    expect(cacheWarmingEnabled()).toBe(true);
  });
});

describe('the engine spawn env', () => {
  it('sets the kill switch unless warming is explicitly on (the engine itself defaults ON)', () => {
    expect(cacheWarmingSpawnEnv()).toEqual({ [CACHE_WARMING_DISABLE_VAR]: '1' });
    fake.settings[CACHE_WARMING_SETTING] = true;
    expect(cacheWarmingSpawnEnv()).toEqual({});
  });

  it('reaches the REAL overlay every engine child is spawned with', () => {
    // Through engineSpawnEnv, not cacheWarmingSpawnEnv alone: a switch that is
    // never spread into the spawn is a switch that does nothing.
    expect(engineSpawnEnv({ codeMode: false })[CACHE_WARMING_DISABLE_VAR]).toBe('1');
    fake.settings[CACHE_WARMING_SETTING] = true;
    expect(engineSpawnEnv({ codeMode: false })[CACHE_WARMING_DISABLE_VAR]).toBeUndefined();
  });

  it('spells the variable exactly as the ENGINE reads it', () => {
    // The mirror guard. The engine owns the name; this reads that file rather
    // than restating the string, so a rename there fails HERE.
    const engine = readFileSync(
      nodePath.resolve(pkg, '..', 'engine', 'src', 'session', 'cache-warm.ts'),
      'utf8',
    );
    const declared = /DISABLE_ENV\s*=\s*"([A-Z_]+)"/.exec(engine)?.[1];
    expect(declared).toBe(CACHE_WARMING_DISABLE_VAR);
    // And the engine's default must be ON, or the two halves disagree about
    // what an absent variable means.
    expect(engine).toContain('raw === "1" || raw === "true"');
  });
});

describe('the host pane', () => {
  const post = vi.fn();
  beforeEach(() => post.mockClear());

  it('answers a read with the current value', async () => {
    await handleCacheWarmingMessage({ post }, { type: 'requestCacheWarming' });
    expect(post).toHaveBeenCalledWith({ type: 'cacheWarmingData', enabled: false });
  });

  it('writes a boolean and refuses anything else', async () => {
    await handleCacheWarmingMessage({ post }, { type: 'cacheWarmingSet', enabled: false });
    expect(cacheWarmingEnabled()).toBe(false);
    await handleCacheWarmingMessage({ post }, { type: 'cacheWarmingSet', enabled: 'false' });
    // Refused, and the stored value is untouched — a coerced string would have
    // turned warming back ON through the engine's `!== false` reading.
    expect(fake.settings[CACHE_WARMING_SETTING]).toBe(false);
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({ error: expect.stringContaining('true or false') }),
    );
  });

  it('ignores a message that is not its own', async () => {
    await handleCacheWarmingMessage({ post }, { type: 'somethingElse', enabled: false });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('the Settings row (t-s9jr6u: moved out of Insights)', () => {
  it('asks the host for the value and sends the toggle back', async () => {
    const { container } = render(CacheWarmingCard);
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'requestCacheWarming' });

    const sw = container.querySelector('[role=switch]') as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('false'); // OFF before the host has answered (the default)
    sw.click();
    await tick();
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenLastCalledWith({
      type: 'cacheWarmingSet',
      enabled: true,
    });
  });

  it('follows the HOST, so a refused write does not leave the switch lying', async () => {
    const { container } = render(CacheWarmingCard);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'cacheWarmingData', enabled: true } }));
    await tick();
    const sw = container.querySelector('[role=switch]') as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'cacheWarmingData', enabled: 'yes' } }));
    await tick();
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.textContent).toContain('Off');
  });

  it('is mounted in the Settings view (Cache group), and no longer in Insights', () => {
    const settings = read(nodePath.join('webview', 'dashboard', 'panes', 'SettingsPane.svelte'));
    expect(settings).toMatch(/Cache:\s*CacheWarmingCard/);
    const insights = read(nodePath.join('webview', 'dashboard', 'panes', 'InstructionsPane.svelte'));
    expect(insights).not.toContain('CacheWarmingCard');
  });
});
