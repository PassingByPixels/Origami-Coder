// engineSettings.test.ts — Settings › Engines (t-xf2e9q): the seven
// `origamicoder.elastic.*` settings, both halves.
//
// The promise each row makes: it shows what is actually in force (the package
// default when nothing is stored) and a write below the package.json minimum
// is refused rather than silently discarded by the reader that uses it
// (elasticWindow.ts readElasticSettings / warmSpareWindow.ts warmSpareEnabled).
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';

const { fake } = vi.hoisted(() => ({
  fake: { settings: {} as Record<string, unknown>, updateThrows: false },
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: (section: string) => ({
      get: (key: string) => fake.settings[`${section}.${key}`],
      update: (key: string, value: unknown) => {
        if (fake.updateThrows) throw new Error('settings file is read-only');
        fake.settings[`${section}.${key}`] = value;
        return Promise.resolve();
      },
    }),
  },
  ConfigurationTarget: { Global: 1 },
}));

import { ENGINES_MESSAGE_TYPES, handleEnginesMessage } from '../../../src/dashboard/enginesPane';
import { SETTING_GROUPS, settingRow } from '../panes/settingsGroups';
import EngineSettingsCard from '../components/EngineSettingsCard.svelte';

const pkg = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string) => readFileSync(nodePath.join(pkg, rel), 'utf8');
const pkgJson = () => JSON.parse(read('package.json'));

beforeEach(() => {
  fake.settings = {};
  fake.updateThrows = false;
  globalThis.__vscodeApiMock.postMessage.mockClear();
});
afterEach(() => cleanup());

describe('settingsGroups — the Engines group', () => {
  it('exists, with a row for every origamicoder.elastic.* setting', () => {
    const group = SETTING_GROUPS.find((g) => g.name === 'Engines');
    expect(group).toBeDefined();
    const ids = group!.rows.map((r) => r.id).sort();
    expect(ids).toEqual(
      ['elasticEnabled', 'idleAfter', 'parkAfter', 'parkUntimedAfter', 'retrim', 'trimAfter', 'warmSpare'].sort(),
    );
  });

  it('only warmSpare carries a reload-style pill — the tracker reads the other six every pass', () => {
    const noPill = ['elasticEnabled', 'idleAfter', 'parkAfter', 'parkUntimedAfter', 'trimAfter', 'retrim'];
    for (const id of noPill) expect(settingRow(id as never).reload, id).toBeUndefined();
    expect(settingRow('warmSpare' as never).reload).toBeDefined();
    expect(settingRow('warmSpare' as never).reload!.toLowerCase()).toContain('next');
  });

  it('the help text names the defaults the package.json manifest contributes', () => {
    const props = pkgJson().contributes.configuration.properties;
    expect(settingRow('idleAfter' as never).help).toContain(String(props['origamicoder.elastic.idleAfterMinutes'].default));
    expect(settingRow('parkAfter' as never).help).toContain(String(props['origamicoder.elastic.parkAfterMinutes'].default));
    expect(settingRow('retrim' as never).help).toContain(String(props['origamicoder.elastic.retrimMinutes'].default));
    expect(settingRow('parkAfter' as never).help).toContain('Default: 20'); // t-ze0hwh
    expect(settingRow('parkUntimedAfter' as never).help).toContain('Default: 20');
  });

  it('t-ze0hwh: no park or warm text says a park waits for the cache to expire (since t-z6ytkw it parks at the user\'s time)', () => {
    const props = pkgJson().contributes.configuration.properties;
    const texts = [settingRow('parkAfter' as never).help, settingRow('parkUntimedAfter' as never).help, settingRow('cacheWarming' as never).help,
      props['origamicoder.elastic.parkAfterMinutes'].description, props['origamicoder.elastic.parkUntimedAfterMinutes'].description, props['origamicoder.cacheWarming.enabled'].description];
    const { container } = render(EngineSettingsCard); // the Engines chart's legend and summary too
    texts.push(container.querySelector('.etl-legend')!.textContent!, container.querySelector('.etl')!.getAttribute('aria-label')!);
    for (const t of texts) expect(t).not.toMatch(/already expired|already past its life|only after that cache|wait longer|cache is not lost/i);
    expect(settingRow('parkAfter' as never).help).toMatch(/wakes .* warm/i);
    expect(props['origamicoder.elastic.parkAfterMinutes'].description).toMatch(/wakes .* warm/i);
  });

  it('t-ze0hwh: before the host answers, the card and its chart show the 20 min defaults, not 60 / 120', () => {
    const { container } = render(EngineSettingsCard);
    const park = container.querySelector('[aria-label="Park idle chats after, minutes"]') as HTMLInputElement;
    const untimed = container.querySelector('[aria-label="Park after, for providers with no published cache life, minutes"]') as HTMLInputElement;
    expect([park.value, untimed.value]).toEqual(['20', '20']);
    expect(container.querySelector('.etl')!.getAttribute('aria-label')).toContain('parked after 20 min');
  });
});

describe('enginesPane — the host half', () => {
  const posted: Record<string, unknown>[] = [];
  const host = { post: (m: Record<string, unknown>) => posted.push(m) };
  beforeEach(() => { posted.length = 0; });

  it('claims both of its message types and nothing else', () => {
    expect([...ENGINES_MESSAGE_TYPES].sort()).toEqual(['engineSettingsSet', 'requestEngineSettings']);
  });

  it('reports the package.json defaults when nothing is stored', async () => {
    await handleEnginesMessage(host, { type: 'requestEngineSettings' });
    expect(posted[0]).toMatchObject({
      enabled: true,
      warmSpare: true,
      idleAfterMinutes: 5,
      parkAfterMinutes: 20,
      parkUntimedAfterMinutes: 20,
      trimAfterMinutes: 0,
      retrimMinutes: 10,
    });
  });

  it('writes a boolean setting and refuses anything else', async () => {
    await handleEnginesMessage(host, { type: 'engineSettingsSet', key: 'enabled', value: false });
    expect(fake.settings['origamicoder.elastic.enabled']).toBe(false);
    await handleEnginesMessage(host, { type: 'engineSettingsSet', key: 'enabled', value: 'false' });
    expect(fake.settings['origamicoder.elastic.enabled']).toBe(false); // untouched
    expect(posted.at(-1)).toMatchObject({ error: expect.stringContaining('true or false') });
  });

  it('writes a number setting at or above its package.json minimum', async () => {
    await handleEnginesMessage(host, { type: 'engineSettingsSet', key: 'idleAfterMinutes', value: 10 });
    expect(fake.settings['origamicoder.elastic.idleAfterMinutes']).toBe(10);
    await handleEnginesMessage(host, { type: 'engineSettingsSet', key: 'parkAfterMinutes', value: 0 });
    expect(fake.settings['origamicoder.elastic.parkAfterMinutes']).toBe(0); // 0 = off, minimum is 0
  });

  it('REFUSES a number below its package.json minimum rather than storing a value the reader discards', async () => {
    await handleEnginesMessage(host, { type: 'engineSettingsSet', key: 'idleAfterMinutes', value: 0 });
    expect(fake.settings['origamicoder.elastic.idleAfterMinutes']).toBeUndefined();
    expect(posted.at(-1)).toMatchObject({ error: expect.stringContaining('at least 1') });

    await handleEnginesMessage(host, { type: 'engineSettingsSet', key: 'retrimMinutes', value: 0 });
    expect(fake.settings['origamicoder.elastic.retrimMinutes']).toBeUndefined();
    expect(posted.at(-1)).toMatchObject({ error: expect.stringContaining('at least 1') });
  });

  it('reports a write that failed instead of reporting success', async () => {
    fake.updateThrows = true;
    await handleEnginesMessage(host, { type: 'engineSettingsSet', key: 'warmSpare', value: false });
    expect(posted.at(-1)).toMatchObject({ error: expect.stringContaining('read-only') });
  });

  it('ignores a message that is not its own', async () => {
    await handleEnginesMessage(host, { type: 'somethingElse' });
    expect(posted).toEqual([]);
  });

  it('the minimums it enforces match package.json exactly', () => {
    const props = pkgJson().contributes.configuration.properties;
    const min = (id: string) => props[`origamicoder.elastic.${id}`].minimum;
    expect(min('idleAfterMinutes')).toBe(1);
    expect(min('trimAfterMinutes')).toBe(0);
    expect(min('retrimMinutes')).toBe(1);
    expect(min('parkAfterMinutes')).toBe(0);
    expect(min('parkUntimedAfterMinutes')).toBe(0);
  });
});

describe('EngineSettingsCard — the pane half', () => {
  it('asks the host for the settings on mount', () => {
    render(EngineSettingsCard);
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'requestEngineSettings' });
  });

  it('sends a toggle to the host', async () => {
    const { container } = render(EngineSettingsCard);
    const switches = container.querySelectorAll('[role=switch]');
    expect(switches.length).toBe(2); // elasticEnabled, warmSpare
    (switches[0] as HTMLButtonElement).click();
    await tick();
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenLastCalledWith({
      type: 'engineSettingsSet',
      key: 'enabled',
      value: false,
    });
  });

  it('follows the HOST for a number field, so a refused write does not leave the box lying', async () => {
    const { container } = render(EngineSettingsCard);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'engineSettingsData', idleAfterMinutes: 5, mins: { idleAfterMinutes: 1 } },
    }));
    await tick();
    const input = container.querySelector('[aria-label="Idle after, minutes"]') as HTMLInputElement;
    expect(input.value).toBe('5');

    await fireEvent.change(input, { target: { value: '9' } });
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenLastCalledWith({
      type: 'engineSettingsSet',
      key: 'idleAfterMinutes',
      value: 9,
    });
  });

  it('never sends a number below its minimum, and snaps the box back', async () => {
    const { container } = render(EngineSettingsCard);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'engineSettingsData', idleAfterMinutes: 5, mins: { idleAfterMinutes: 1 } },
    }));
    await tick();
    const input = container.querySelector('[aria-label="Idle after, minutes"]') as HTMLInputElement;
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.change(input, { target: { value: '0' } });
    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalled();
    expect(input.value).toBe('5');
  });

  it('is mounted in the Settings view (Engines group)', () => {
    const settings = read(nodePath.join('webview', 'dashboard', 'panes', 'SettingsPane.svelte'));
    expect(settings).toMatch(/Engines:\s*EngineSettingsCard/);
  });
});

describe('EngineTimeline in the card — t-xq22sx', () => {
  const send = async (data: Record<string, unknown>) => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'engineSettingsData', ...data } }));
    await tick();
  };
  const left = (el: Element | null) => parseFloat((el as HTMLElement).style.left);

  it('redraws at once when the host reports a new value, stop markers in order', async () => {
    const { container } = render(EngineSettingsCard);
    await send({ enabled: true, idleAfterMinutes: 5, parkAfterMinutes: 60, parkUntimedAfterMinutes: 120 });
    const timed = () => container.querySelector('[data-lane=timed] [data-seg=parked]');
    const untimed = () => container.querySelector('[data-lane=untimed] [data-seg=parked]');
    expect(left(timed())).toBeLessThan(left(untimed()));
    const before = left(timed());
    await send({ enabled: true, idleAfterMinutes: 5, parkAfterMinutes: 100, parkUntimedAfterMinutes: 120 });
    expect(left(timed())).toBeGreaterThan(before);
    expect(container.querySelector('.etl')!.getAttribute('aria-label')).toContain('100 min');
  });

  it('park 0 removes both stop bars; elastic off removes every step', async () => {
    const { container } = render(EngineSettingsCard);
    await send({ enabled: true, parkAfterMinutes: 0 });
    expect(container.querySelectorAll('[data-seg=parked]').length).toBe(0);
    expect(container.querySelectorAll('[data-seg=idle]').length).toBe(2);
    await send({ enabled: false });
    expect(container.querySelectorAll('[data-seg=idle], [data-seg=background], [data-trim]').length).toBe(0);
    expect(container.textContent).toContain('Elastic engines is off');
  });

  it('t-z6ytkw: draws a wake-to-warm blip on the cache-life lane after its stop, only while cache warming is on', async () => {
    const { container } = render(EngineSettingsCard);
    await send({ enabled: true, idleAfterMinutes: 5, parkAfterMinutes: 10, parkUntimedAfterMinutes: 120, cacheWarming: true });
    const blips = () => [...container.querySelectorAll('[data-warm]')];
    expect(blips().map((b) => b.getAttribute('data-warm'))).toEqual(['48']);
    expect(container.querySelector('[data-lane=untimed] [data-warm]')).toBeNull();
    expect(left(blips()[0]!)).toBeGreaterThan(left(container.querySelector('[data-lane=timed] [data-seg=parked]')));
    await send({ enabled: true, idleAfterMinutes: 5, parkAfterMinutes: 10, parkUntimedAfterMinutes: 120, cacheWarming: false });
    expect(blips().length).toBe(0);
  });

  it('turns its motion off under prefers-reduced-motion', () => {
    const src = read(nodePath.join('webview', 'dashboard', 'components', 'EngineTimeline.svelte'));
    expect(src).toMatch(/prefers-reduced-motion: reduce\)\s*\{[^}]*transition: none/);
  });
});
