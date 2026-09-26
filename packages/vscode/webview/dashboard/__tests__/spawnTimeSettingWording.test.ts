// spawnTimeSettingWording.test.ts — t-xtimx0. Owner UAT of 0.4.178, step 10: unticking
// origami.experimentalCodeMode showed "reload the window", but no reload was needed. The warm
// spare was dropped at once ("[spare] ... dropped: a spawn-time setting changed") and the next
// new chat had no `execute` tool. What IS fixed is each open chat: its spawn env is captured once
// (acpClient.ts `this.spawnEnv ??= engineOverlay(...)`) and reused across a park and restore, so
// its requests stay byte-identical.
//
// THE SET. Every setting the spawn digest covers (warmSpareWindow.ts `spawnDigest`: the binary +
// `engineOverlay`, acpClient.ts), read from engineEnv.ts `engineSpawnEnv` and its callers:
//   origami.experimentalCodeMode           engineEnv.ts codeModeEnabled
//   origami.agentName                      peerName.ts agentNameSetting
//   origami.subagentTimeLimitHours         subagentLimit.ts subagentLimitHours
//   origami.experimentalSideQuests         sideQuestsFlag.ts sideQuestsSpawnEnv
//   origami.experimentalClaudeSubscription claudeSubscriptionFlag.ts claudeSubscriptionSpawnEnv
//   origamicoder.flock.enabled             flockEnabled.ts flockSpawnEnv
//   origamicoder.cacheWarming.enabled      cacheWarming.ts cacheWarmingSpawnEnv
//   origami.devEngineSource                acpClient.ts resolveDevEngine (the binary)
// Each description must say what happens: new chats get the change, open chats keep their value.

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CodeModeCard from '../panes/CodeModeCard.svelte';

const pkg = JSON.parse(
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json'), 'utf8'),
);
const described = (key: string): string => {
  const prop = pkg.contributes.configuration.properties[key];
  expect(prop, `${key} is not contributed`).toBeDefined();
  return String(prop.description ?? prop.markdownDescription ?? '');
};

const SPAWN_TIME = [
  'origami.experimentalCodeMode',
  'origami.agentName',
  'origami.subagentTimeLimitHours',
  'origami.experimentalSideQuests',
  'origami.experimentalClaudeSubscription',
  'origamicoder.flock.enabled',
  'origamicoder.cacheWarming.enabled',
  'origami.devEngineSource',
];

describe('spawn-time settings say "new chats", not "reload the window" (t-xtimx0)', () => {
  it.each(SPAWN_TIME)('%s', (key) => {
    const text = described(key).toLowerCase();
    expect(text).toMatch(/new chats?/);
    expect(text).toContain('open chat');
    // Flock is the one exception: an engine already running (an open chat, the window's
    // background engine) may still hold its relay lease, so switching it off EVERYWHERE is a
    // reload. The description may say so, but must lead with the new-chat rule.
    if (key !== 'origamicoder.flock.enabled') expect(text).not.toMatch(/reload the window|window reloads|next starts/);
  });

  it('the code-mode card in the Tools view says the same', () => {
    const { container } = render(CodeModeCard, { props: { on: true, onToggle: () => {} } });
    const text = container.textContent ?? '';
    expect(text).toMatch(/New chats use the change at once/);
    expect(text).toMatch(/Open chats keep/);
    expect(text).not.toMatch(/Reload the window/i);
  });
});
