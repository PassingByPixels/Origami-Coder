// t-kgtr6c — the Agents board's TWO-TAB sub-nav and the Vision Agents tab.
//
// Round 3 removed a third tab, SubAgents, by owner decision. Its roster was
// read-only and its model/context override was a MIRROR of the chat model
// picker's — a mirror that wrote to the ACTIVE chat rather than to the board
// showing it. The picker is the sole surface now, so the drift guard that
// mirror owed is replaced by guard 4 below: the opposite assertion, that no
// second sender has come back.
//
// What is worth guarding here, and why each one is a real bug and not a look:
//
//  1. The tabs must SEPARATE the two def lists. They live in one directory and
//     are the same file format; a profile leaking into the collab roster offers
//     a describe-only agent as a collab participant, and a collab agent leaking
//     into the profile list offers to send a picture to a model that cannot see.
//
//  2. A new vision profile must be BORN a profile — `visionProfile: true` and
//     `vision: true` on the saved def. Miss either and the file writes itself
//     as a collab agent (wrong tab, wrong roster) or as a blind one (the engine
//     hands it a note saying an image was attached, never the image).
//
//  3. An open editor must not survive a tab switch. The form's Save posts one
//     message shape for both kinds; leaving it mounted across a switch is a
//     Save that writes a profile into the collab list, or the reverse.
//
//  4. `setSubagentModel` must have exactly ONE sender in the webview. Two
//     surfaces for one per-chat setting is what round 3 removed; a second one
//     re-appearing is the same defect returning, and nothing else would fail.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tick } from 'svelte';
import CollabAgentsPane from '../panes/CollabAgentsPane.svelte';

const posts = () =>
  globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;

// fileURLToPath + join, NOT `new URL(..., import.meta.url)` — vite rewrites
// that form into an asset URL readFileSync cannot open, and the test then
// collects zero cases while looking rigorous.
const here = path.dirname(fileURLToPath(import.meta.url));
const srcOf = (rel: string) => readFileSync(path.join(here, '..', rel), 'utf8');

const COLLAB_DEFS = [
  { slug: 'collab-crane', description: 'Builds it.', model: 'lmstudio/qwen-32b', glyph: 'crane', persona: 'You are Crane.', preset: 'worker' as const, steps: '40', visionProfile: false },
];
const VISION_DEFS = [
  { slug: 'vision-eye', description: 'Reads screenshots.', model: 'lmstudio/qwen2-vl', glyph: 'heron', persona: 'Describe what you see.', preset: 'observer' as const, steps: '', vision: true, visionProfile: true },
];
const ARCHETYPES = [
  { slug: 'architect', description: 'Plans the work.', model: 'lmstudio/qwen-32b', mode: 'subagent', managed: false, path: '/agents/architect.md' },
];

async function mounted(opts: { defs?: unknown[]; visionDefs?: unknown[]; archetypes?: unknown[] } = {}) {
  const rendered = render(CollabAgentsPane);
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        type: 'collabAgentDefs',
        defs: opts.defs ?? COLLAB_DEFS,
        visionDefs: opts.visionDefs ?? VISION_DEFS,
        archetypes: opts.archetypes ?? ARCHETYPES,
      },
    }),
  );
  await tick();
  return rendered;
}

const cards = (c: Element) => Array.from(c.querySelectorAll('.ca-card'));
const button = (c: Element, label: string) =>
  Array.from(c.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)!;
async function goTo(c: Element, label: string) {
  await fireEvent.click(button(c, label));
  await tick();
}

/** AgentModelSelect is a trigger + popover, not a `<select>`: open it, then
 *  click the one option. Driving it the way a user does is the point — a test
 *  that reached in and set the bound value would prove the binding, not the
 *  control. */
async function pickModel(c: Element) {
  await fireEvent.click(c.querySelector('.ams-trigger') as HTMLElement);
  await tick();
  // Its groups open COLLAPSED (`expanded = {}` on every open), so the provider
  // row has to be opened before its models exist in the DOM at all.
  await fireEvent.click(c.querySelector('.ams-group') as HTMLElement);
  await tick();
  const opt = Array.from(c.querySelectorAll('.ams-opt')).find((b) => b.textContent?.includes('Qwen 32B'));
  await fireEvent.click(opt as HTMLElement);
  await tick();
}

beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });
afterEach(() => cleanup());

describe('Agents pane — the two-button sub-nav', () => {
  it('offers exactly Bots and Vision Agents, and opens on Bots', async () => {
    const { container } = await mounted();
    const nav = container.querySelector('.ca-nav')!;
    expect(Array.from(nav.querySelectorAll('button')).map((b) => b.textContent?.trim())).toEqual([
      'Bots',
      'Vision Agents',
    ]);
    // The tab you land on is the behaviour that existed before the split.
    expect(button(container, 'Bots').classList.contains('picked')).toBe(true);
  });

  it('Collab shows the collab defs and the reference agents, never a profile', async () => {
    const { container } = await mounted();
    const text = container.textContent ?? '';
    expect(cards(container)).toHaveLength(1);
    expect(text).toContain('Crane');
    expect(text).toContain('Reference agents');
    expect(text).not.toContain('vision-eye');
  });

  it('Vision Agents shows the profiles and drops the reference agents', async () => {
    const { container } = await mounted();
    await goTo(container, 'Vision Agents');
    const text = container.textContent ?? '';
    expect(text).toContain('Eye');
    expect(text).toContain('Reads screenshots.');
    // A profile is not a collab participant, and the archetype cards are the
    // Collab tab's own furniture.
    expect(text).not.toContain('Crane');
    expect(text).not.toContain('Reference agents');
  });

  it('offers no SubAgents tab and no sub-agent override anywhere on the board', async () => {
    // The removal itself, asserted on the RENDERED board rather than on the
    // absence of a file: the tab is gone, and so is the control it carried, on
    // both tabs. Sub-agent routing is the chat model picker's job now.
    const { container } = await mounted();
    expect(button(container, 'SubAgents')).toBeUndefined();
    for (const tab of ['Bots', 'Vision Agents']) {
      await goTo(container, tab);
      expect(container.textContent).not.toContain('Sub-agent model override');
      expect(container.querySelector('input[aria-label="Context length in thousands of tokens"]')).toBeNull();
    }
  });
});

describe('Agents pane — a new vision profile is born a profile', () => {
  it('saves visionProfile AND vision true, so it lands in the right tab and can be shown pixels', async () => {
    const { container } = await mounted();
    await goTo(container, 'Vision Agents');
    await fireEvent.click(button(container, '＋ New vision profile'));
    await tick();

    const name = container.querySelector('input[aria-label="Agent name"]') as HTMLInputElement;
    await fireEvent.input(name, { target: { value: 'vision-owl' } });
    await tick();
    await fireEvent.click(button(container, 'Save'));
    await tick();

    const saved = posts().find((p) => p.type === 'saveCollabAgentDef') as { def: Record<string, unknown> };
    expect(saved.def.slug).toBe('vision-owl');
    expect(saved.def.visionProfile).toBe(true);
    // Without this the engine hands the profile a note saying an image was
    // attached — the one thing a vision profile must never be handed.
    expect(saved.def.vision).toBe(true);
  });

  it('hides the permission presets and the vision checkbox on a profile', async () => {
    const { container } = await mounted();
    await goTo(container, 'Vision Agents');
    await fireEvent.click(button(container, '＋ New vision profile'));
    await tick();

    // A profile never takes a workspace turn, so Worker/Observer is a choice
    // that changes nothing, and "Vision capable" is already decided.
    expect(button(container, 'Worker')).toBeUndefined();
    expect(button(container, 'Observer')).toBeUndefined();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('says out loud that a profile without a model would run on the blind one', async () => {
    const { container } = await mounted();
    await goTo(container, 'Vision Agents');
    await fireEvent.click(button(container, '＋ New vision profile'));
    await tick();
    expect(container.textContent).toContain('the one that cannot see');
  });
});

describe('Agents pane — an open editor never crosses a tab', () => {
  it('switching tabs closes the form rather than carrying it over', async () => {
    const { container } = await mounted();
    await fireEvent.click(button(container, '＋ New bot'));
    await tick();
    expect(container.querySelector('textarea.ca-text')).not.toBeNull();

    await goTo(container, 'Vision Agents');
    // Left open, its Save would write a collab draft into the profile list.
    expect(container.querySelector('textarea.ca-text')).toBeNull();
  });
});

describe('sub-agent override — ONE surface, and it is the chat model picker', () => {
  // The inverse of the drift guard this replaces. A mirror had to be checked
  // for agreement; a sole surface has to be checked for SOLITUDE, and the
  // failure is the same silent shape either way — a second sender writes the
  // same per-chat setting from a place that cannot show which chat it landed
  // on, and every existing test still passes.
  const WEBVIEW = path.join(here, '..', '..');

  const sendersOf = (message: string): string[] => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
        } else if (/\.(svelte|ts)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
          // `postMessage({ type: 'x'` and the `pickType`-style indirection both
          // read as the quoted literal, which is what is matched here.
          if (readFileSync(full, 'utf8').includes(`'${message}'`)) hits.push(path.relative(WEBVIEW, full));
        }
      }
    };
    walk(WEBVIEW);
    return hits.sort();
  };

  it('ModelPicker.svelte is the only webview file that sends setSubagentModel', () => {
    expect(sendersOf('setSubagentModel')).toEqual([path.join('dashboard', 'components', 'ModelPicker.svelte')]);
  });

  it('the picker still carries both halves of the override — the model and the context length', () => {
    // The removal must not have taken the surviving surface's fields with it:
    // the host case reads contextLength off this same message.
    const picker = srcOf('components/ModelPicker.svelte');
    expect(picker).toContain("'setSubagentModel'");
    expect(picker).toContain('modelId');
    expect(picker).toContain('contextLength');
  });
});
