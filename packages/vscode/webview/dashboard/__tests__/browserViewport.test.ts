// browserViewport.test.ts — the page viewport the agent's captures are taken at
// (src/browserViewport.ts, t-ntmm93).
//
// THE FIXTURES COME FROM THE SHIPPED BUNDLE, not from the code under test.
// VS Code 1.138.0, the build installed on this machine:
//   - `screenshot_page`'s inputSchema is `{ pageId, ref, selector, element,
//     scrollIntoViewIfNeeded }` — no size, so a capture cannot be ASKED for one.
//   - `run_playwright_code` answers through the same `xmi` shape browserForce's
//     fixtures use: a `Result: …` text part, then the summary. `RESIZED` below is
//     that shape, which is why a note can be parsed out of it at all.
//   - `out/main.js` maps `Emulation.setDeviceMetricsOverride` onto the browser
//     view's `setDevice(...)`, and `page.setViewportSize` is the Playwright call
//     that sends it. That is the ONLY seam, and it is the one the snippet uses.
//
// What this pins, and the real defect each catches:
//   1. A capture must never claim a size it did not get. Every path out of
//      applyViewport returns a sentence, and the sentences differ.
//   2. The gate is the same one the forced click reads. A viewport attempt with
//      auto-approve OFF would raise VS Code's own modal and hold the turn.
//   3. The settings pair is clamped to the workbench's own 50..9999 bounds, so a
//      typo cannot persist as a viewport no page could have.

import { describe, expect, it, beforeEach, vi } from 'vitest';

const { fake } = vi.hoisted(() => ({
  fake: { autoApprove: false as unknown, settings: {} as Record<string, unknown> },
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => (key === 'chat.tools.global.autoApprove' ? fake.autoApprove : fake.settings[key]),
    }),
  },
}));

import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  applyViewport,
  clampViewport,
  measuredNote,
  planViewport,
  readViewport,
  viewportInput,
  viewportSnippet,
} from '../../../src/browserViewport';
import { shouldApplyBeside } from '../../../src/browserFocus';

const SHIPPED_TOOLS = [
  'open_browser_page',
  'list_browser_pages',
  'screenshot_page',
  'read_page',
  'run_playwright_code',
];
const NO_PLAYWRIGHT = SHIPPED_TOOLS.filter((t) => t !== 'run_playwright_code');

const HD = { width: 1920, height: 1080 } as const;
const ON = () => true;
const OFF = () => false;

/** `run_playwright_code`'s success shape: Result part, then summary. */
function resized(measured: string) {
  return { content: [{ value: `Result: ${JSON.stringify(measured)}` }, { value: 'Ran Playwright code.' }] };
}

/** Its failure shape: hasError + toolResultError, the refusal branch. */
function refused(message: string) {
  return { content: [{ value: message }], hasError: true, toolResultError: message };
}

beforeEach(() => {
  fake.autoApprove = false;
  fake.settings = {};
});

describe('clampViewport — a setting cannot become a viewport no page could have', () => {
  it('defaults to 1920x1080 when neither side is set', () => {
    expect(clampViewport(undefined, undefined)).toEqual({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  });

  it('keeps a real pair', () => {
    expect(clampViewport(1366, 768)).toEqual({ width: 1366, height: 768 });
  });

  it('clamps to the workbench emulation toolbar bounds (50..9999), per side', () => {
    expect(clampViewport(0, 40000)).toEqual({ width: 50, height: 9999 });
  });

  it('falls back per side on a value that is not a number', () => {
    expect(clampViewport('wide', 720)).toEqual({ width: DEFAULT_WIDTH, height: 720 });
  });

  it('rounds, because a fractional CSS pixel is not a viewport', () => {
    expect(clampViewport(1280.6, 720.2)).toEqual({ width: 1281, height: 720 });
  });
});

describe('readViewport — the configured default, read LIVE', () => {
  it('is 1920x1080 out of the box', () => {
    expect(readViewport()).toEqual(HD);
  });

  it('follows the two settings, and a later change is picked up without a reload', () => {
    fake.settings['origami.browser.viewportWidth'] = 1280;
    fake.settings['origami.browser.viewportHeight'] = 720;
    expect(readViewport()).toEqual({ width: 1280, height: 720 });
    fake.settings['origami.browser.viewportWidth'] = 2560;
    expect(readViewport()).toEqual({ width: 2560, height: 720 });
  });
});

describe('planViewport — the gate, and what a capture owes when it is shut', () => {
  it('runs when the playwright tool is published and auto-approve is on', () => {
    expect(planViewport(SHIPPED_TOOLS, HD, ON)).toEqual({ run: true });
  });

  it('is barred with auto-approve OFF, and names the setting rather than guessing', () => {
    // Attempting it anyway raises VS Code's own modal, which holds the turn
    // until the engine's 30s bridge timeout kills it.
    const plan = planViewport(SHIPPED_TOOLS, HD, OFF);
    expect(plan.run).toBe(false);
    expect((plan as { why: string }).why).toContain('chat.tools.global.autoApprove');
    expect((plan as { why: string }).why).toContain("tab's own size");
  });

  it('is barred on a build that published no run_playwright_code, and says so instead', () => {
    const plan = planViewport(NO_PLAYWRIGHT, HD, ON);
    expect(plan.run).toBe(false);
    expect((plan as { why: string }).why).toContain('run_playwright_code');
    expect((plan as { why: string }).why).not.toContain('autoApprove');
  });

  it('quotes the CONFIGURED size in the refusal, not a hard-coded 1920x1080', () => {
    const plan = planViewport(SHIPPED_TOOLS, { width: 1280, height: 720 }, OFF);
    expect((plan as { why: string }).why).toContain('1280x720');
  });
});

describe('viewportSnippet — the one seam VS Code leaves open', () => {
  it('sets the size through page.setViewportSize, the call that sends setDeviceMetricsOverride', () => {
    expect(viewportSnippet(HD)).toContain('page.setViewportSize({ width: 1920, height: 1080 })');
  });

  it('MEASURES the result from inside the page, so the note is not a restatement of the request', () => {
    expect(viewportSnippet(HD)).toContain('window.innerWidth');
  });

  it('is sent with a timeout inside the engine bridge 30s ceiling', () => {
    const input = viewportInput('page-1', HD) as { pageId: string; timeoutMs: number };
    expect(input.pageId).toBe('page-1');
    expect(input.timeoutMs).toBeLessThan(30_000);
  });
});

describe('measuredNote — the capture says what it actually got', () => {
  it('confirms the size, and says it is independent of the tab', () => {
    expect(measuredNote(HD, 'Result: "1920x1080"')).toContain('Captured at a 1920x1080 page viewport');
  });

  it('reports the MISMATCH rather than the request when the page disagrees', () => {
    const note = measuredNote(HD, 'Result: "584x311"');
    expect(note).toContain('584x311');
    expect(note).not.toContain('Captured at a 1920x1080');
  });

  it('refuses to claim the size when the page reported nothing back', () => {
    expect(measuredNote(HD, 'Ran Playwright code.')).toContain('may still be at the tab size');
  });
});

describe('applyViewport — never fails the capture, always says which size it is', () => {
  it('applies the configured viewport and reports the measured one', async () => {
    fake.autoApprove = true;
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const note = await applyViewport(
      async (name, input) => {
        calls.push({ name, input });
        return resized('1920x1080');
      },
      SHIPPED_TOOLS,
      'page-1',
      HD,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('run_playwright_code');
    expect(note).toContain('Captured at a 1920x1080 page viewport');
  });

  it('does not touch the page at all when the gate is shut', async () => {
    let ran = 0;
    const note = await applyViewport(
      async () => {
        ran += 1;
        return resized('1920x1080');
      },
      SHIPPED_TOOLS,
      'page-1',
      HD,
    );
    expect(ran).toBe(0);
    expect(note).toContain('chat.tools.global.autoApprove');
  });

  it('reports a REFUSED resize as the tab-size capture it leaves behind', async () => {
    fake.autoApprove = true;
    const note = await applyViewport(async () => refused('No browser page found with ID page-1'), SHIPPED_TOOLS, 'page-1', HD);
    expect(note).toContain("tab's own size");
    expect(note).toContain('No browser page found with ID page-1');
  });

  it('survives a THROW out of the tool and still answers in prose', async () => {
    fake.autoApprove = true;
    const note = await applyViewport(
      async () => {
        throw new Error('This VS Code build does not expose vscode.lm.invokeTool.');
      },
      SHIPPED_TOOLS,
      'page-1',
      HD,
    );
    expect(note).toContain('invokeTool');
    expect(note).toContain("tab's own size");
  });
});

describe('shouldApplyBeside — a default never overwrites a decision', () => {
  it('applies the side-group placement when the user has never set it', () => {
    expect(shouldApplyBeside(true, { globalValue: undefined }, 'activeGroup')).toBe(true);
  });

  it('leaves an explicit user value alone, at any scope', () => {
    expect(shouldApplyBeside(true, { globalValue: 'activeGroup' }, 'activeGroup')).toBe(false);
    expect(shouldApplyBeside(true, { workspaceValue: 'window' }, 'window')).toBe(false);
    expect(shouldApplyBeside(true, { workspaceFolderValue: 'activeGroup' }, 'activeGroup')).toBe(false);
  });

  it('writes nothing when the placement is already beside, or the switch is off', () => {
    expect(shouldApplyBeside(true, { globalValue: undefined }, 'sideGroup')).toBe(false);
    expect(shouldApplyBeside(false, { globalValue: undefined }, 'activeGroup')).toBe(false);
  });

  it('treats a build with no such setting as nothing to preserve', () => {
    expect(shouldApplyBeside(true, undefined, undefined)).toBe(true);
  });
});
