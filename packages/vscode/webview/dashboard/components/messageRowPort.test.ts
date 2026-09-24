// The R2/R3 transcript port's TURN rules (t-qmzegs items 1 and 2), tested the
// only honest way this suite can: against the CSS SOURCE.
//
// vitest.config.mts does not set `css: true`, so no <style> element ever
// reaches the test DOM and `getComputedStyle(row).background` returns ''. A
// test that asserted a computed colour here would be asserting nothing while
// looking rigorous. What IS decidable is what the component ships: the rules
// are read out of MessageRow.svelte's own text and checked for the shape the
// round-3 spec fixes (Mock-Redesign/CHANGES.md changes 18/19/20 + 41).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
// Line endings normalised: the working copy is checked out CRLF on Windows and
// LF on CI, and a selector-list lookup that spans a newline must not depend on
// which one the reader happened to get.
const SRC = readFileSync(path.join(here, 'MessageRow.svelte'), 'utf8').replace(/\r\n/g, '\n');
const STYLE = SRC.slice(SRC.lastIndexOf('<style>'));

/** The declarations of the FIRST rule whose selector list ends with `selector`
 *  — matched on the literal text, so no regex-escaping of `.`/`::` is needed.
 *  Returns '' when no such rule exists, which is itself what the tests below
 *  assert: an absent rule fails loudly rather than passing silently. */
function rule(selector: string): string {
  const needle = selector + ' {';
  const at = STYLE.indexOf(needle);
  if (at < 0) return '';
  const close = STYLE.indexOf('}', at);
  return STYLE.slice(at + needle.length, close < 0 ? undefined : close);
}

describe('change 18 + 41 — the USER turn is tinted and railed; the AGENT turn has no surface', () => {
  it('the user turn carries a surface tint', () => {
    expect(rule('.user')).toMatch(/background:/);
  });

  it('the user turn carries a 2px left rail in the chat colour', () => {
    const rail = rule('.user::after');
    expect(rail).toMatch(/content: ''/);
    expect(rail).toMatch(/width: 2px/);
    expect(rail).toMatch(/background: var\(--og-chat\)/);
  });

  it('the rail needs a positioned row to hang off', () => {
    expect(rule('.row')).toMatch(/position: relative/);
  });

  it('the AGENT turn has no surface and no rail — round 3 reverted both', () => {
    // The agent is the only speaker with no box, and that is what makes its
    // prose the thing the eye lands on. A background on .agent is the defect
    // round 2 shipped and round 3 took back out.
    expect(rule('.agent')).not.toMatch(/background/);
    expect(rule('.agent::after')).toBe('');
  });
});

describe('change 19 — the timestamp sits inline after the label, not at the far right', () => {
  it('the timestamp no longer pushes itself to the right edge', () => {
    // `margin-left: auto` on .timestamp is what made the time a COLUMN. Inline
    // after the label, it reads as part of the label line.
    expect(rule('.timestamp')).not.toMatch(/margin-left: auto/);
  });

  it('the timestamp is muted and reveals on hover or focus', () => {
    expect(rule('.timestamp')).toMatch(/color: var\(--og-text-muted\)/);
    expect(rule('.timestamp')).toMatch(/opacity: 0;/);
    expect(STYLE).toMatch(/\.row:hover > \.row-header \.timestamp/);
    expect(STYLE).toMatch(/\.row:focus-within > \.row-header \.timestamp/);
  });

  it('whatever the header still right-aligns keeps its own margin-left: auto', () => {
    // The spend/token badge is the header's right-hand end; losing the
    // timestamp's `auto` must not drag the badge in with it.
    expect(rule('.row-header > :last-child:not(.timestamp):not(.label)')).toMatch(/margin-left: auto/);
  });
});

describe('change 20 reversed by the owner on 0.4.154 — prose keeps the full pane width', () => {
  it('the DIRECT .text of a user or agent turn has no reading-measure cap', () => {
    const measure = rule('.user > .text,\n  .agent > .text');
    expect(measure).toMatch(/max-width: none/);
    expect(measure).not.toMatch(/\dch/);
    expect(measure).toMatch(/display: block/);
  });

  it('the cap is on the DIRECT child only, so a .text inside a card is not capped', () => {
    // `.user .text` (descendant) would reach into any nested card body. The
    // `>` is the whole point of the rule.
    expect(STYLE).not.toMatch(/\.user \.text,/);
  });
});
