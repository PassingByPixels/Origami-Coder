// browserForce.test.ts — the last rung of the click ladder.
//
// THE FIXTURE IS THE POINT. `UNACTIONABLE` below is the verbatim failure from
// the round-2 live UAT against VS Code 1.132.0 — the one that proved the whole
// theory: the locator RESOLVED, and then the element never became "visible,
// enabled and stable". Round 2 retried it narrowed; the retry resolved an
// element too and still timed out, which is what moved the blame from the
// selector to the page. This file's whole reason to exist is the attempt made
// AFTER that, so a fixture invented to match the gate would prove nothing.
//
// The two RESULT SHAPES matter as much as the message, exactly as they do in
// browserRetry.test.ts. `run_playwright_code` answers through `xmi`, which
// pushes `Result: …` and any error as text parts AHEAD of the summary and sets
// an `isError` that `$invokeTool` drops on the way to an extension — so on this
// path a success and a failure differ ONLY by which parts arrive and in what
// order. A gate that read the flag alone would call every forced failure green.

import { describe, expect, it, beforeEach, vi } from 'vitest';

const { fake } = vi.hoisted(() => ({
  fake: { autoApprove: false as unknown, reads: 0 },
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => {
        fake.reads += 1;
        return key === 'chat.tools.global.autoApprove' ? fake.autoApprove : undefined;
      },
    }),
  },
}));

import { forceAfterFailure, forceInput, forceSnippet, planForce, type ForceContext } from '../../../src/browserForce';

/** Round-2's live failure, verbatim. */
const UNACTIONABLE = `locator.click: Timeout 10000ms exceeded.
Call log:
  - waiting for locator('#submit')
  -   locator resolved to <input checked type="checkbox" id="submit">
  - attempting click action
  -   waiting for element to be visible, enabled and stable`;

/** Round-2's OTHER live failure — already answered one rung up. */
const STRICT_MODE = `locator.click: Error: strict mode violation: locator('text=Entrypoint') resolved to 3 elements:
    1) <a class="nav-link" href="#entrypoint">Entrypoint</a>`;

const SHIPPED_TOOLS = ['click_element', 'read_page', 'run_playwright_code', 'list_browser_pages'];

function ctx(over: Partial<ForceContext> = {}): ForceContext {
  return { tools: SHIPPED_TOOLS, pageId: 'page-1', action: 'click', selector: '#submit', ...over };
}

const ON = () => true;
const OFF = () => false;

beforeEach(() => {
  fake.autoApprove = false;
  fake.reads = 0;
});

describe('planForce — what earns a forced click, and what does not', () => {
  it('runs on the actionability timeout, which is the failure it was reasoned about', () => {
    expect(planForce(ctx(), UNACTIONABLE, ON).run).toBe(true);
  });

  it('never runs on a strict-mode violation — the rung above already answered that', () => {
    // Forcing an ambiguous selector would click an element nobody chose, and
    // report it as a success.
    expect(planForce(ctx(), STRICT_MODE, ON)).toEqual({ run: false });
  });

  it('never runs for a verb that is not a click', () => {
    expect(planForce(ctx({ action: 'type' }), UNACTIONABLE, ON)).toEqual({ run: false });
    expect(planForce(ctx({ action: 'read' }), UNACTIONABLE, ON)).toEqual({ run: false });
  });

  it('never runs on any other failure', () => {
    expect(planForce(ctx(), 'No browser page found with ID page-7.', ON)).toEqual({ run: false });
    expect(planForce(ctx(), 'net::ERR_CONNECTION_REFUSED at http://localhost:9999/', ON)).toEqual({ run: false });
  });

  it('is BARRED when global auto-approve is off, and says which setting and why', () => {
    // The gate that keeps this from hanging a headless flow. `run_playwright_code`
    // carries confirmationMessages, and the no-chat-context branch of invokeTool
    // raises a modal dialog for them — with nobody there to answer it.
    const plan = planForce(ctx(), UNACTIONABLE, OFF);
    expect(plan.run).toBe(false);
    expect((plan as { why: string }).why).toContain('chat.tools.global.autoApprove');
    expect((plan as { why: string }).why).toContain('modal');
  });

  it('is barred when the build published no run_playwright_code, and says that instead', () => {
    const plan = planForce(ctx({ tools: ['click_element', 'list_browser_pages'] }), UNACTIONABLE, ON);
    expect(plan.run).toBe(false);
    expect((plan as { why: string }).why).toContain('published no "run_playwright_code"');
    expect((plan as { why: string }).why).not.toContain('autoApprove');
  });

  it('the note admits the checks were skipped rather than reporting a clean click', () => {
    const plan = planForce(ctx(), UNACTIONABLE, ON) as { note: string };
    expect(plan.note).toContain('force');
    expect(plan.note).toContain('SKIPPED');
    expect(plan.note).toContain('confirm the page actually changed');
  });
});

describe('the snippet — real Playwright, in the shape VS Code will run it', () => {
  it('is the BODY of `async (page) => { … }`, which is what run_playwright_code wraps it in', () => {
    // `q7e.invoke` builds `async (page) => { ${code} }`, so a snippet that
    // declared its own function, or referenced `document`/`window` directly,
    // would not run at all.
    const code = forceSnippet('#submit');
    expect(code).toContain('page.locator(');
    expect(code).not.toContain('async (page)');
    expect(code).not.toMatch(/\bdocument\.|\bwindow\./);
  });

  it('forces the click and scrolls first, and survives a scroll that times out', () => {
    const code = forceSnippet('#submit');
    expect(code).toContain('scrollIntoViewIfNeeded');
    expect(code).toContain('force: true');
    // The scroll runs its own actionability wait, so on the very page state
    // this exists for it can time out. Swallowing it is what keeps the force
    // reachable; without the try/catch the fallback would die before it acted.
    expect(code).toMatch(/try \{ await el\.scrollIntoViewIfNeeded\(\{ timeout: \d+ \}\); \} catch \{\}/);
  });

  it('takes the first match, because force does not make a locator unambiguous', () => {
    expect(forceSnippet('.row')).toContain('.first()');
  });

  it('escapes the selector instead of pasting it into javascript', () => {
    // A model-written selector is arbitrary text. `text="Save & Exit"` pasted
    // raw closes the string literal and breaks the snippet — which would read
    // as "the force fallback is broken" rather than "the selector was odd".
    const code = forceSnippet('text="Save\\Exit"');
    expect(code).toContain(String.raw`"text=\"Save\\Exit\""`);
    expect(code.split('\n')[0]).toBe(String.raw`const el = page.locator("text=\"Save\\Exit\"").first();`);
  });

  it('gives the snippet longer than run_playwright_code’s 5000ms default', () => {
    // The wrapper bounds the WHOLE snippet with timeoutMs (default 5000). The
    // two waits inside it add up to 6000, so on the default the outer bound
    // would cut the click short of its own timeout, every time.
    const input = forceInput('page-1', '#submit') as { pageId: string; code: string; timeoutMs: number };
    expect(input.pageId).toBe('page-1');
    expect(input.timeoutMs).toBe(8000);
    expect(input.timeoutMs).toBeGreaterThan(2000 + 4000);
    expect(input.code).toBe(forceSnippet('#submit'));
  });
});

describe('forceAfterFailure — the rung, wired to the setting', () => {
  /** The `xmi` success shape: `Result: …` then the summary, no flag at all. */
  const forced = { content: [{ value: 'Result: "forced click dispatched"' }, { value: 'Ran Playwright code.' }] };
  /** The `xmi` failure shape: the error is a text part AHEAD of the summary. */
  const forceFailed = {
    content: [{ value: 'locator.click: Element is not attached to the DOM' }, { value: 'Ran Playwright code.' }],
  };

  function runner(result: unknown) {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    return {
      calls,
      run: async (name: string, input: Record<string, unknown>) => {
        calls.push({ name, input });
        return result;
      },
    };
  }

  it('runs run_playwright_code with the forced snippet when auto-approve is ON', async () => {
    fake.autoApprove = true;
    const r = runner(forced);
    const out = await forceAfterFailure(r.run, ctx(), { failed: UNACTIONABLE });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].name).toBe('run_playwright_code');
    expect(String(r.calls[0].input.code)).toContain('force: true');
    expect(out.seen.failed).toBeUndefined();
    expect(out.note).toContain('force');
  });

  it('runs NOTHING and says why when auto-approve is off', async () => {
    fake.autoApprove = false;
    const r = runner(forced);
    const out = await forceAfterFailure(r.run, ctx(), { failed: UNACTIONABLE });
    expect(r.calls).toEqual([]);
    expect(out.seen.failed).toContain('chat.tools.global.autoApprove');
    // …and the original failure still LEADS. It is the real one.
    expect(String(out.seen.failed).startsWith('locator.click: Timeout 10000ms exceeded.')).toBe(true);
  });

  it('a forced click that also fails reports BOTH, first failure leading', async () => {
    fake.autoApprove = true;
    const r = runner(forceFailed);
    const out = await forceAfterFailure(r.run, ctx(), { failed: UNACTIONABLE });
    expect(out.seen.failed).toContain('waiting for element to be visible, enabled and stable');
    expect(out.seen.failed).toContain('A forced click (actionability checks skipped) also failed');
    expect(out.seen.failed).toContain('Element is not attached to the DOM');
    // and it never claims a force happened cleanly
    expect(out.note).toBeUndefined();
  });

  it('leaves a successful verb completely alone', async () => {
    fake.autoApprove = true;
    const r = runner(forced);
    const out = await forceAfterFailure(r.run, ctx(), { checked: { text: 'Clicked.' } as never });
    expect(r.calls).toEqual([]);
    expect(out.note).toBeUndefined();
  });

  it('does not even READ the setting for a failure it would never force', async () => {
    // The config read is deliberately lazy: every other failed verb in the
    // extension must leave the setting untouched.
    const r = runner(forced);
    await forceAfterFailure(r.run, ctx(), { failed: STRICT_MODE });
    await forceAfterFailure(r.run, ctx({ action: 'read' }), { failed: UNACTIONABLE });
    expect(fake.reads).toBe(0);
    expect(r.calls).toEqual([]);
  });

  it('treats a non-true setting value as OFF', async () => {
    // `get()` can answer undefined (never set) or a string from a hand-edited
    // settings.json. Neither is consent to skip a confirmation dialog.
    for (const value of [undefined, 'true', 1, {}]) {
      fake.autoApprove = value;
      const r = runner(forced);
      const out = await forceAfterFailure(r.run, ctx(), { failed: UNACTIONABLE });
      expect(r.calls).toEqual([]);
      expect(out.seen.failed).toContain('was not tried');
    }
  });
});
