// browserRetry.test.ts — the ONE bounded retry a failed page verb gets.
//
// THE FIXTURE IS THE POINT, the same way it is in browserBridge.test.ts. The two
// failure strings below are the VERBATIM messages from a live UAT click against
// VS Code 1.132.0's `click_element` — not messages invented to match the regexes
// they are matched by. That distinction is the whole reason this suite exists:
// the browser tool once passed 38/38 while being structurally incapable of
// working, because every fixture had been derived from the implementation
// instead of from the thing it integrates with.
//
// The two RESULT SHAPES are equally load-bearing, and both are exercised for
// each failure. VS Code reports a driven verb's failure in two structurally
// different ways and browserResult.ts reads both:
//   - `hasError` (the ext-host projection of `toolResultError`), set when
//     PlaywrightSession throws out of the tool and `Nm(msg)` catches it;
//   - an error text part pushed AHEAD of the summary by `xmi`, with no flag at
//     all, when `invokeFunction` catches the throw into { result, error, summary }.
// A retry that only triggered on one of them would be dead on half the real
// failures, and nothing about the code's shape would say so.

import { describe, expect, it } from 'vitest';
import { driveWithRetry, planRetry } from '../../../src/browserRetry';
// The input builders moved to browserDrive.ts with the drive they belong to.
import { clickInput } from '../../../src/browserDrive';

/**
 * Live message 1 — the ambiguous selector. The model asked for `text=Entrypoint`
 * on a page carrying a nav link, a heading and a table cell with that word;
 * Playwright refuses ambiguity rather than guessing, so NOTHING was clicked.
 */
const STRICT_MODE = `locator.click: Error: strict mode violation: locator('text=Entrypoint') resolved to 3 elements:
    1) <a class="nav-link" href="#entrypoint">Entrypoint</a> aka getByRole('link', { name: 'Entrypoint' })
    2) <h2 id="entrypoint">Entrypoint</h2> aka getByRole('heading', { name: 'Entrypoint' })
    3) <td class="cell">Entrypoint</td> aka getByRole('cell', { name: 'Entrypoint' })

Call log:
  - waiting for locator('text=Entrypoint')`;

/**
 * Live message 2 — the element EXISTS ("locator resolved to <button …>") and
 * then never becomes actionable. This is the one that reads like a broken tool:
 * the selector was right, the DOM had it, and ten seconds later nothing had
 * happened.
 */
const UNACTIONABLE = `locator.click: Timeout 10000ms exceeded.
Call log:
  - waiting for locator('#submit')
  -   locator resolved to <button id="submit" class="btn">Submit</button>
  - attempting click action
  -   waiting for element to be visible, enabled and stable`;

/** The ext-host projection of a tool that THREW: the flag is what survives. */
function threwResult(message: string) {
  return { content: [{ value: message }], hasError: true, toolResultError: message };
}

/** The `xmi` shape: the error is a text part AHEAD of the summary, unflagged. */
function xmiResult(message: string) {
  return { content: [{ value: message }, { value: 'Clicked the element matching #submit.' }] };
}

function okResult(summary = 'Clicked.') {
  return { content: [{ value: summary }] };
}

describe('planRetry — the two live failures, and nothing else', () => {
  it('strict-mode violation retries as the FIRST match', () => {
    const plan = planRetry('click', 'text=Entrypoint', STRICT_MODE);
    expect(plan?.selector).toBe('text=Entrypoint >> nth=0');
  });

  it('the strict-mode note reports WHICH element was clicked, verbatim from the candidate list', () => {
    const plan = planRetry('click', 'text=Entrypoint', STRICT_MODE);
    expect(plan?.note).toContain('<a class="nav-link" href="#entrypoint">Entrypoint</a>');
    // …and NOT the `aka` suggestion tacked onto that line, which names a
    // different selector and would read as the thing that was clicked.
    expect(plan?.note).not.toContain('getByRole');
  });

  it('the strict-mode note carries the real match count off the message', () => {
    expect(planRetry('click', 'text=Entrypoint', STRICT_MODE)?.note).toContain('matched 3 elements');
  });

  it('actionability timeout retries against visible elements only', () => {
    const plan = planRetry('click', '#submit', UNACTIONABLE);
    expect(plan?.selector).toBe('#submit >> visible=true');
  });

  it('the actionability note quotes the wait VS Code actually spent, not a remembered default', () => {
    expect(planRetry('click', '#submit', UNACTIONABLE)?.note).toContain('within 10000ms');
  });

  it('`type` gets the same repair — the failure is the selector, not the verb', () => {
    expect(planRetry('type', 'text=Entrypoint', STRICT_MODE)?.selector).toBe('text=Entrypoint >> nth=0');
    expect(planRetry('type', '#submit', UNACTIONABLE)?.selector).toBe('#submit >> visible=true');
  });

  it('`hover` gets it too — hover_element runs through the same helper as a click', () => {
    // Both failures below are Playwright's, not the tool's: hover_element is
    // `locator(sel).hover()` driven by the same `IT` wrapper, so an ambiguous
    // selector and an unactionable element read exactly the same coming back.
    expect(planRetry('hover', 'text=Entrypoint', STRICT_MODE)?.selector).toBe('text=Entrypoint >> nth=0');
    expect(planRetry('hover', '#submit', UNACTIONABLE)?.selector).toBe('#submit >> visible=true');
  });

  it('a verb that names no element — or names TWO — is never retried', () => {
    expect(planRetry('read', 'text=Entrypoint', STRICT_MODE)).toBeUndefined();
    expect(planRetry('screenshot', '#submit', UNACTIONABLE)).toBeUndefined();
    expect(planRetry('navigate', '#submit', UNACTIONABLE)).toBeUndefined();
    expect(planRetry('dialog', '#submit', UNACTIONABLE)).toBeUndefined();
    expect(planRetry('raw', '#submit', UNACTIONABLE)).toBeUndefined();
    // `drag` is the deliberate omission: it carries a FROM and a TO, this file
    // rewrites only the selector it is handed, and the failure does not say
    // which end was ambiguous — so a retry could narrow the wrong one and report
    // it as a repair.
    expect(planRetry('drag', 'text=Entrypoint', STRICT_MODE)).toBeUndefined();
  });

  it('any OTHER failure is left alone — a second attempt would hit the same wall', () => {
    expect(planRetry('click', '#submit', 'No browser page found with ID page-7.')).toBeUndefined();
    expect(planRetry('click', '#submit', 'net::ERR_CONNECTION_REFUSED at http://localhost:9999/')).toBeUndefined();
    expect(planRetry('click', '#submit', 'Target page, context or browser has been closed')).toBeUndefined();
  });

  // The first version of this guard compared `selector + suffix` to `selector`,
  // which can never be equal — it was dead code that read like a check. These
  // cases are what caught it.
  it('a selector already narrowed the same way is not narrowed twice', () => {
    expect(planRetry('click', 'text=Entrypoint >> nth=0', STRICT_MODE)).toBeUndefined();
    expect(planRetry('click', '#submit >> visible=true', UNACTIONABLE)).toBeUndefined();
  });

  it("an nth the MODEL chose is never re-picked inside — `>> nth=2` is a deliberate pick", () => {
    expect(planRetry('click', 'text=Entrypoint >> nth=2', STRICT_MODE)).toBeUndefined();
    expect(planRetry('click', 'text=Entrypoint >>nth=11', STRICT_MODE)).toBeUndefined();
  });

  it('the suffix is only "already there" in the trailing position it would have applied to', () => {
    // `>> nth=0 >> visible=true` ends in the VISIBLE clause, so the ambiguity
    // repair still has work to do — the nth applies to the pre-filter set.
    expect(planRetry('click', 'text=E >> nth=0 >> visible=true', STRICT_MODE)?.selector)
      .toBe('text=E >> nth=0 >> visible=true >> nth=0');
  });

  it('a trailing space does not defeat the guard, nor double-space the narrowed selector', () => {
    expect(planRetry('click', '#submit >> visible=true  ', UNACTIONABLE)).toBeUndefined();
    expect(planRetry('click', '#submit  ', UNACTIONABLE)?.selector).toBe('#submit >> visible=true');
  });
});

describe('driveWithRetry — one attempt, then at most one more', () => {
  /** Records every selector the tool was actually invoked with. */
  function recorder(replies: unknown[]) {
    const used: string[] = [];
    const run = async (input: Record<string, unknown>) => {
      used.push(String(input['selector']));
      return replies[used.length - 1];
    };
    return { used, run };
  }

  it('a first-attempt success never calls the tool twice and adds no note', async () => {
    const { used, run } = recorder([okResult()]);
    const out = await driveWithRetry(run, clickInput, 'page-1', 'click', '#submit');
    expect(used).toEqual(['#submit']);
    expect(out.seen.failed).toBeUndefined();
    expect(out.note).toBeUndefined();
  });

  for (const [shape, wrap] of [['hasError', threwResult], ['xmi text part', xmiResult]] as const) {
    it(`strict-mode arriving as ${shape}: re-invokes with >> nth=0 and reports which element`, async () => {
      const { used, run } = recorder([wrap(STRICT_MODE), okResult()]);
      const out = await driveWithRetry(run, clickInput, 'page-1', 'click', 'text=Entrypoint');
      expect(used).toEqual(['text=Entrypoint', 'text=Entrypoint >> nth=0']);
      expect(out.seen.failed).toBeUndefined();
      expect(out.note).toContain('<a class="nav-link" href="#entrypoint">Entrypoint</a>');
    });

    it(`actionability timeout arriving as ${shape}: re-invokes with >> visible=true`, async () => {
      const { used, run } = recorder([wrap(UNACTIONABLE), okResult()]);
      const out = await driveWithRetry(run, clickInput, 'page-1', 'click', '#submit');
      expect(used).toEqual(['#submit', '#submit >> visible=true']);
      expect(out.seen.failed).toBeUndefined();
      expect(out.note).toContain('never became clickable');
    });
  }

  it('the note is set ONLY on the far side of a retry that worked', async () => {
    const { run } = recorder([threwResult(UNACTIONABLE), threwResult('no visible match')]);
    const out = await driveWithRetry(run, clickInput, 'page-1', 'click', '#submit');
    expect(out.note).toBeUndefined();
  });

  it('when both attempts fail, the FIRST failure leads — the second describes a selector we invented', async () => {
    const { run } = recorder([threwResult(UNACTIONABLE), threwResult('no visible match')]);
    const out = await driveWithRetry(run, clickInput, 'page-1', 'click', '#submit');
    expect(out.seen.failed).toContain('locator resolved to <button id="submit" class="btn">Submit</button>');
    expect(out.seen.failed).toContain('A narrowed retry against "#submit >> visible=true" also failed');
  });

  it('a click that fails both ways says plainly that it CANNOT be forced from here', async () => {
    const { run } = recorder([threwResult(UNACTIONABLE), threwResult('no visible match')]);
    const out = await driveWithRetry(run, clickInput, 'page-1', 'click', '#submit');
    // click_element's schema is { pageId, ref, selector, element, dblClick, button } —
    // no force, no timeout. Neither has hover_element, which is why the sentence
    // names the page TOOLS rather than the click: this rung is reached by more
    // than one verb now, and a hover failure quoting "click_element" would be
    // describing a tool that never ran. Claiming a force here would be the false
    // green this whole feature keeps relearning.
    expect(out.seen.failed).toMatch(/no force or timeout option/i);
    expect(out.seen.failed).not.toMatch(/forced|force: true/i);
  });

  it('exactly ONE retry, ever — a repeat of the same failure is not retried again', async () => {
    const { used, run } = recorder([threwResult(STRICT_MODE), threwResult(STRICT_MODE), okResult()]);
    await driveWithRetry(run, clickInput, 'page-1', 'click', 'text=Entrypoint');
    expect(used).toHaveLength(2);
  });

  it('a verb with no selector at all is passed straight through', async () => {
    const { used, run } = recorder([threwResult(STRICT_MODE)]);
    const out = await driveWithRetry(run, clickInput, 'page-1', 'read', undefined);
    expect(used).toHaveLength(1);
    expect(out.seen.failed).toBe(STRICT_MODE);
  });

  it('the retry rebuilds the WHOLE input, so `element` describes the narrowed selector too', async () => {
    const inputs: Record<string, unknown>[] = [];
    const replies = [threwResult(STRICT_MODE), okResult()];
    const run = async (input: Record<string, unknown>) => {
      inputs.push(input);
      return replies[inputs.length - 1];
    };
    await driveWithRetry(run, clickInput, 'page-1', 'click', 'text=Entrypoint');
    // `element` is in click_element's `required` list, and VS Code spends it on
    // the sentence it shows the user — a stale one would describe the element
    // that was NOT clicked.
    expect(inputs[1]['element']).toContain('text=Entrypoint >> nth=0');
    expect(inputs[1]['pageId']).toBe('page-1');
  });
});
