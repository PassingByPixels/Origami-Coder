// t-qn0wj5, proposal 26: the compact density CSS hook itself.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const themeCss = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'theme.css'),
  'utf8',
);

describe('chat density compact CSS (t-qn0wj5, proposal 26)', () => {
  it('sets the session tab to 24px min-height only under .chat-density-compact', () => {
    expect(themeCss).toMatch(/\.chat-pane\.chat-density-compact \.session-tab\s*\{[^}]*min-height:\s*24px/);
  });

  it('never sets that height outside the compact scope (Comfortable stays at today\'s size)', () => {
    const bareRule = themeCss.match(/(?<!\.chat-density-compact )\.session-tab\s*\{([^}]*)\}/);
    // The plain (Comfortable) .session-tab rule lives in ChatPane.svelte, not
    // here — theme.css should carry NO unscoped .session-tab height rule.
    expect(bareRule).toBeNull();
  });
});
