// enginesPane.ts — the Settings view's "Engines" group, host side: read and
// write the seven `origamicoder.elastic.*` settings (t-xf2e9q).
//
// Its own module rather than more cases in DashboardPanel.ts, on the
// cacheWarmingPane.ts / subagentLimitPane.ts precedent: a pane that reads
// SETTINGS and never the engine needs nothing from the panel but `post`.
//
// Six of the seven are read FRESH every tracker pass (elasticWindow.ts
// readElasticSettings, called from ActivityTracker on each poke/tick), so a
// write here changes behaviour without a reload. `warmSpare` is read at the
// moment a NEW chat's engine starts (warmSpareWindow.ts); a chat already open
// keeps the engine it has, which is what its row's pill has to say.

import * as vscode from 'vscode';
import { ELASTIC_SECTION } from '../elastic/elasticWindow';
import { warmSpareEnabled } from '../elastic/warmSpareWindow';
import { cacheWarmingEnabled } from '../cacheWarming';

export const ENGINES_MESSAGE_TYPES = new Set(['requestEngineSettings', 'engineSettingsSet']);

export interface EnginesHost {
  post(message: Record<string, unknown>): void;
}

/** The five number settings: their package.json minimum and default. */
const NUMBER_KEYS = {
  idleAfterMinutes: { min: 1, default: 5 },
  trimAfterMinutes: { min: 0, default: 0 },
  retrimMinutes: { min: 1, default: 10 },
  parkAfterMinutes: { min: 0, default: 20 }, // t-ze0hwh
  parkUntimedAfterMinutes: { min: 0, default: 20 },
} as const;
type NumberKey = keyof typeof NUMBER_KEYS;
const BOOLEAN_KEYS = ['enabled', 'warmSpare'] as const;
type BooleanKey = (typeof BOOLEAN_KEYS)[number];
export type EngineSettingKey = NumberKey | BooleanKey;

function isNumberKey(key: unknown): key is NumberKey {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(NUMBER_KEYS, key);
}
function isBooleanKey(key: unknown): key is BooleanKey {
  return key === 'enabled' || key === 'warmSpare';
}

function config(): { get<T>(key: string): T | undefined } {
  try {
    return vscode.workspace.getConfiguration(ELASTIC_SECTION);
  } catch {
    return { get: () => undefined };
  }
}

/** The pane's state: the stored value, or the package.json default when
 *  nothing usable is stored. The bounds ride along so a row's `min` and its
 *  help text cannot drift from what a write below it discards. */
function state(error?: string): Record<string, unknown> {
  const c = config();
  const num = (key: NumberKey): number => {
    const v = c.get<number>(key);
    const { min, default: d } = NUMBER_KEYS[key];
    return typeof v === 'number' && Number.isFinite(v) && v >= min ? v : d;
  };
  return {
    type: 'engineSettingsData',
    enabled: c.get<boolean>('enabled') !== false,
    warmSpare: warmSpareEnabled(),
    cacheWarming: cacheWarmingEnabled(), // t-z6ytkw: the Engines chart draws the warm blips only while warming is on
    idleAfterMinutes: num('idleAfterMinutes'),
    trimAfterMinutes: num('trimAfterMinutes'),
    retrimMinutes: num('retrimMinutes'),
    parkAfterMinutes: num('parkAfterMinutes'),
    parkUntimedAfterMinutes: num('parkUntimedAfterMinutes'),
    mins: Object.fromEntries(Object.entries(NUMBER_KEYS).map(([k, v]) => [k, v.min])),
    ...(error ? { error } : {}),
  };
}

async function writeSetting(key: EngineSettingKey, value: unknown): Promise<string | undefined> {
  try {
    await vscode.workspace.getConfiguration(ELASTIC_SECTION).update(key, value, vscode.ConfigurationTarget.Global);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return undefined;
}

export async function handleEnginesMessage(
  host: EnginesHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  if (m.type === 'requestEngineSettings') {
    host.post(state());
    return;
  }
  if (m.type !== 'engineSettingsSet') return;
  const key = m['key'];
  const value = m['value'];

  if (isBooleanKey(key)) {
    // A webview is not a trusted validator: anything that is not an exact
    // boolean is refused, the shape cacheWarmingPane.ts already takes.
    if (typeof value !== 'boolean') {
      host.post(state(`${key} takes true or false.`));
      return;
    }
    host.post(state(await writeSetting(key, value)));
    return;
  }
  if (isNumberKey(key)) {
    const { min } = NUMBER_KEYS[key];
    const num = typeof value === 'number' ? value : Number.NaN;
    // Refused rather than clamped: a stored value under the minimum is one a
    // reader would silently fall back from, so the setting would read as set
    // and do nothing — the same failure subagentLimitPane.ts guards against.
    if (!Number.isFinite(num) || num < min) {
      host.post(state(`${key} must be at least ${min}.`));
      return;
    }
    host.post(state(await writeSetting(key, num)));
    return;
  }
  host.post(state('Unknown engine setting.'));
}
