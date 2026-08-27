// CollabAgentsPane — the Agents board's Collab tab: the def list (now CARDS)
// and the create/edit form.
//
// Two things this view is on the hook for, and both are correctness, not looks:
//
//  1. The card must show the facts a def is CHOSEN on. A collab is assembled by
//     picking agents out of this list, and that pick turns on what the agent is
//     for, what it may DO (worker edits files and runs commands; observer
//     cannot), which model it is pinned to and how many steps it gets. A card
//     that drops one of those sends someone to the .md file to find it.
//
//  2. The persona box must arrive SEEDED and must never eat typed text. It used
//     to open empty, which is why agents got made with one-line personas. The
//     seed follows the preset and the name while the box is untouched — and the
//     moment the user types, nothing may write it again. The second half is the
//     one worth guarding: a form that silently replaces a paragraph somebody
//     wrote is a bug they will not report, they will just stop using the form.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tick } from 'svelte';
import CollabAgentsPane from '../panes/CollabAgentsPane.svelte';
import { personaSeed } from '../components/collabPersonaSeed';

const posts = () =>
  globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;
const flat = (s: string | null) => (s ?? '').replace(/\s+/g, ' ');

// Layout rules are asserted against the SOURCE, never a computed style: jsdom
// does not apply a component's injected <style>, so `getComputedStyle` here
// would be a test passing on nothing. Same read-the-file discipline
// architecture.test.ts uses. fileURLToPath + join, NOT `new URL(...,
// import.meta.url)` — vite rewrites that form into an asset URL readFileSync
// cannot open.
const componentSrc = (file: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'components', file), 'utf8');
/** The one declaration block for `sel` — the `\s*\{` anchor stops `.ca-card`
 *  matching `.ca-card-head` or `.ca-btn` matching `.ca-btn:hover`. */
const rule = (src: string, sel: string) => src.match(new RegExp(`\\${sel}\\s*\\{[^}]*\\}`))![0];

// Deliberately one of each preset, and a legacy seed, so a card that renders
// only the happy shape is caught. Model ids are local/free ones throughout.
const DEFS = [
  {
    slug: 'collab-crane', description: 'Builds the thing the room agreed on.',
    model: 'lmstudio/qwen-32b', glyph: 'crane', persona: 'You are Crane.',
    preset: 'worker' as const, steps: '40',
  },
  {
    slug: 'collab-heron', description: 'Checks the claim before it costs an afternoon.',
    model: '', glyph: 'heron', persona: 'You are Heron.',
    preset: 'observer' as const, steps: '',
  },
  {
    slug: 'collab-scribe', description: '', model: 'ollama/llama3.2', glyph: '',
    persona: 'You are Scribe.', preset: 'custom' as const, steps: '12', legacySeed: true,
  },
];

async function withDefs(defs: unknown[] = DEFS, archetypes: unknown[] = []) {
  const rendered = render(CollabAgentsPane);
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'collabAgentDefs', defs, archetypes } }));
  await tick();
  return rendered;
}

const cards = (c: Element) => Array.from(c.querySelectorAll('.ca-card'));
const persona = (c: Element) => c.querySelector('textarea.ca-text') as HTMLTextAreaElement;
const button = (c: Element, label: string) =>
  Array.from(c.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)!;

async function openCreateForm(container: Element) {
  await fireEvent.click(button(container, '＋ New bot'));
  await tick();
}
/** The form's Name box is the slug box — there is no second display-name field. */
async function typeName(container: Element, value: string) {
  const input = container.querySelector('input[aria-label="Agent name"]') as HTMLInputElement;
  await fireEvent.input(input, { target: { value } });
  await tick();
}
/** One tool checkbox in the editor's checklist, by the permission key it writes.
 *  It replaced `pickPreset` when W9 retired the Worker/Observer buttons: a tick
 *  is now the only permission control there is. */
const toolBox = (c: Element, key: string) =>
  Array.from(c.querySelectorAll('.bc-tool')).find((l) => l.textContent?.trim().startsWith(key))!
    .querySelector('input') as HTMLInputElement;

beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });
afterEach(() => cleanup());

describe('CollabAgentsPane — the def list renders as cards', () => {
  it('draws one card per def, and reads the list off the filesystem wire', async () => {
    const { container } = await withDefs();
    expect(cards(container)).toHaveLength(3);
    // The list is read from disk, not from `collab_agents`: the wire lacks
    // the persona/permission/steps fields this form needs, not because a
    // saved def is stale to the engine (it re-scans on every collab call).
    expect(posts()).toContainEqual({ type: 'listCollabAgentDefs' });
  });

  it('each card carries the facts the def is chosen on', async () => {
    const { container } = await withDefs();
    const crane = flat(cards(container)[0]!.textContent);

    expect(crane).toContain('Crane');                     // name, prefix dropped
    expect(crane).toContain('@collab-crane');             // the @mention handle
    expect(crane).toContain('worker');                    // the preset chip
    expect(crane).toContain('lmstudio/qwen-32b');         // the pinned model
    expect(crane).toContain('40');                        // the per-turn budget
    expect(crane).toContain('Builds the thing the room agreed on.');
  });

  it('names the preset per card — worker and observer are not interchangeable', async () => {
    const { container } = await withDefs();
    const chips = Array.from(container.querySelectorAll('.ca-chip')).map((c) => c.textContent?.trim());
    expect(chips).toEqual(['worker', 'observer', 'custom']);
  });

  // M4.4 — vision is a capability the room acts on (a picture is sent, or a
  // note about one is). Only the def that HAS it gets a chip; a "no vision"
  // chip on every other card would bury the one that means something.
  it('chips the vision-capable def and no other', async () => {
    const { container } = await withDefs([
      { ...DEFS[0], vision: true },
      DEFS[1],
      { ...DEFS[2], vision: false },
    ]);
    const visionChips = cards(container).map((c) => !!c.querySelector('.ca-chip.vision'));
    expect(visionChips).toEqual([true, false, false]);
    expect(container.querySelector('.ca-chip.vision')!.textContent!.trim()).toBe('vision');
  });

  // The list is a comparison surface, so its container is a GRID that reflows
  // to the panel width, not a single column. Asserted against the SOURCE rule
  // (jsdom never applies the component's injected styles, and a computed style
  // it did not apply would be a test that passes on nothing) — the same
  // read-the-file discipline architecture.test.ts uses. The failure is silent
  // otherwise: a stack still renders every card, just unusably.
  it('lays the cards out as a reflowing grid, not a stack', async () => {
    const { container } = await withDefs();
    expect(container.querySelector('.ca-list')).not.toBeNull();
    // fileURLToPath + join, NOT `new URL(..., import.meta.url)`: vite rewrites
    // that form into an asset URL, which readFileSync cannot open.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.join(here, '..', 'panes', 'CollabAgentsPane.svelte'), 'utf8');
    const rule = src.match(/\.ca-list\s*\{[^}]*\}/)![0];
    expect(rule).toMatch(/display:\s*grid/);
    expect(rule).toMatch(/repeat\(auto-fit,\s*minmax\(210px,\s*1fr\)\)/);
    expect(rule).not.toMatch(/flex-direction/);
  });

  it('says NO PINNED MODEL rather than printing an empty model line', async () => {
    const { container } = await withDefs();
    // '' means the collab session's own model runs it — not a model named "".
    expect(flat(cards(container)[1]!.textContent)).toContain('no pinned model');
  });

  // v4: unpinned is a first-class, ACTIONABLE state, not just a fact row —
  // an agent with no model needs one picked before a turn can run it.
  it('warns when a def has no pinned model, and says nothing when it does', async () => {
    const { container } = await withDefs();
    expect(flat(cards(container)[1]!.textContent)).toContain('No model pinned');  // heron: model ''
    expect(flat(cards(container)[0]!.textContent)).not.toContain('No model pinned'); // crane: pinned
  });

  it('gives a VISION profile the stronger warning: it would run blind', async () => {
    const rendered = render(CollabAgentsPane);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'collabAgentDefs', defs: DEFS, visionDefs: [{ ...DEFS[1], slug: 'vision-blind', visionProfile: true }], archetypes: [] },
    }));
    await tick();
    await fireEvent.click(button(rendered.container, 'Vision Agents'));
    await tick();
    expect(flat(cards(rendered.container)[0]!.textContent)).toContain('cannot see');
  });

  // UAT round 2 item 3: the facts area slims to what the FILE states. A row
  // labelled "Steps: preset default" spent a whole labelled fact saying the
  // def carries no budget of its own — and the preset's real numbers live
  // engine-side, so copying them here would be a second source of truth free
  // to drift from the first. Absent is the honest rendering of absent.
  it('DROPS the steps row when the file pins no budget, and keeps it when one is pinned', async () => {
    const { container } = await withDefs();
    const labels = (c: Element) => Array.from(c.querySelectorAll('.cf-k')).map((k) => k.textContent);
    // The contract facts are ALWAYS drawn — every one of them has an honest
    // "the def said nothing" reading, which is itself the thing a card has to
    // show. Steps is the odd one out: its default lives engine-side, so an
    // absent budget has nothing truthful to print.
    expect(labels(cards(container)[1]!)).toEqual(['Model', 'Tools', 'Memory']); // steps: ''
    expect(flat(cards(container)[1]!.textContent)).not.toContain('preset default');
    expect(labels(cards(container)[0]!)).toEqual(['Model', 'Tools', 'Memory', 'Steps']); // steps: '40'
  });

  // The other half of the same slim: the HANDLE row restated the name for every
  // def whose slug IS its name, which is most of them.
  it('shows @handle inline ONLY when it differs from the name, never as a labelled row', async () => {
    const { container } = await withDefs([DEFS[0], { ...DEFS[1], slug: 'heron' }]);
    // Crane is filed as `collab-crane`, so the @mention is a fact the name does
    // not already carry — and it reads beside the name, where a mention is read.
    expect(flat(cards(container)[0]!.textContent)).toContain('Crane@collab-crane');
    expect(Array.from(cards(container)[0]!.querySelectorAll('.cf-k')).map((k) => k.textContent)).not.toContain('Handle');
    // A def filed as plain `heron` prints "Heron" once, not "Heron @heron".
    expect(flat(cards(container)[1]!.textContent)).not.toContain('@heron');
  });

  it('a def that crossed the wire with NO preset still reads as worker', async () => {
    // `preset` is optional on the type on purpose — a def can reach the webview
    // across a boundary that only forwards the text fields. Worker is what the
    // row this card replaced showed, and what the writer resolves to; a blank
    // chip would be the pane inventing a fourth permission level.
    const { container } = await withDefs([{ ...DEFS[0], preset: undefined }]);
    expect(container.querySelector('.ca-chip')!.textContent!.trim()).toBe('worker');
  });

  it('keeps the missing-description and legacy-seed states visible', async () => {
    const { container } = await withDefs();
    const scribe = flat(cards(container)[2]!.textContent);
    expect(scribe).toContain('No description.');
    expect(scribe).toContain('Old shipped template');
  });

  it('states the engine-restart caveat for deletes only — saves and edits are live', async () => {
    const { container } = await withDefs();
    const text = flat(container.textContent);
    expect(text).toMatch(/Deleting one still\s+needs an engine restart/);
    expect(text).not.toContain('join after the engine restarts');
  });

  it('an empty directory reads as empty, not as still loading', async () => {
    const { container } = await withDefs([]);
    expect(flat(container.querySelector('.ca-empty')!.textContent)).toContain('No bots yet');
    expect(cards(container)).toHaveLength(0);
  });
});

describe('CollabAgentsPane — the card CRUD wires still fire', () => {
  it('Edit opens that def in the form, with its own persona untouched', async () => {
    const { container } = await withDefs();
    await fireEvent.click(button(cards(container)[1]!, 'Edit'));
    await tick();
    // The existing body is the user's text — including, elsewhere, an empty
    // one. The seed must not reach an edit.
    expect(persona(container).value).toBe('You are Heron.');
  });

  it('Delete asks once before it posts, then posts that slug', async () => {
    const { container } = await withDefs();
    const card = cards(container)[0]!;
    await fireEvent.click(button(card, 'Delete'));
    await tick();
    expect(posts().filter((p) => p.type === 'deleteCollabAgentDef')).toEqual([]);

    await fireEvent.click(button(card, 'Delete it'));
    expect(posts()).toContainEqual({ type: 'deleteCollabAgentDef', slug: 'collab-crane' });
  });

  it('a confirm armed on one card does not arm the others', async () => {
    const { container } = await withDefs();
    await fireEvent.click(button(cards(container)[0]!, 'Delete'));
    await tick();
    // The second card must still be offering "Delete", not "Delete it".
    expect(button(cards(container)[1]!, 'Delete')).toBeTruthy();
    expect(cards(container)[1]!.textContent).not.toContain('Delete it');
  });

  // UAT round 1 item 7: Edit/Delete crowded the head next to the name, which
  // is what turned names into "Ar…"/"Ca…" on Passing's screenshot — they now
  // live in a footer row, and the head is buttons-free.
  it('Edit and Delete live in the card FOOTER, not beside the name in the head', async () => {
    const { container } = await withDefs();
    const card = cards(container)[0]!;
    const head = card.querySelector('.ca-card-head')!;
    const footer = card.querySelector('.ca-card-footer')!;
    expect(head.querySelector('button')).toBeNull();
    expect(footer.contains(button(card, 'Edit'))).toBe(true);
    expect(footer.contains(button(card, 'Delete'))).toBe(true);
  });

  it('Save writes the draft the form is showing', async () => {
    const { container } = await withDefs();
    await openCreateForm(container);
    await typeName(container, 'collab-scout');
    await fireEvent.click(button(container, 'Save'));

    const saved = posts().find((p) => p.type === 'saveCollabAgentDef') as { def: Record<string, unknown> };
    expect(saved.def.slug).toBe('collab-scout');
    // `custom`, and that is the W9 default arriving intact rather than a bug: a
    // new bot is born ticked on EVERY tool, which is not either shipped preset,
    // and `preset` is only ever a READING of the ticks (botTools.presetOfTools).
    expect(saved.def.preset).toBe('custom');
  });
});

describe('CollabAgentsPane — a new agent arrives with its persona seeded', () => {
  it('opens SEEDED, not empty — the whole point of the change', async () => {
    const { container } = await withDefs();
    await openCreateForm(container);
    expect(persona(container).value.length).toBeGreaterThan(0);
    // ONE seed since W9 — the Worker/Observer buttons went, so there is no
    // preset for a seed to follow and the only input left is the name.
    expect(persona(container).value).toBe(personaSeed('collab-'));
    expect(persona(container).value).toContain('You are the bot Agent.');
  });

  it('follows the NAME box while the body is untouched', async () => {
    const { container } = await withDefs();
    await openCreateForm(container);
    await typeName(container, 'collab-scout');
    expect(persona(container).value).toContain('You are the bot Scout.');
  });

  // Ticking is not a seed input any more, and that is the behaviour W9 wanted:
  // the box follows the NAME. A tick that rewrote the body would undo a persona
  // the user was halfway through reading, for a control about permissions.
  it('does NOT rewrite the body when the tool ticks change', async () => {
    const { container } = await withDefs();
    await openCreateForm(container);
    await typeName(container, 'collab-scout');
    const seeded = persona(container).value;
    await fireEvent.click(toolBox(container, 'bash'));
    await tick();
    expect(persona(container).value).toBe(seeded);
  });
});

describe('CollabAgentsPane — typed text is never clobbered by the seed', () => {
  it('unticking a tool leaves an edited body exactly as the user left it', async () => {
    const { container } = await withDefs();
    await openCreateForm(container);
    const MINE = 'You are Scout. You read the map and you say what is on it.';
    await fireEvent.input(persona(container), { target: { value: MINE } });
    await tick();

    await fireEvent.click(toolBox(container, 'bash'));
    await tick();
    expect(persona(container).value).toBe(MINE);
    await fireEvent.click(toolBox(container, 'bash'));
    await tick();
    expect(persona(container).value).toBe(MINE);
  });

  it('typing the NAME after editing the body does not re-seed over it either', async () => {
    const { container } = await withDefs();
    await openCreateForm(container);
    const MINE = 'Hand-written persona.';
    await fireEvent.input(persona(container), { target: { value: MINE } });
    await tick();

    await typeName(container, 'collab-scout');
    expect(persona(container).value).toBe(MINE);
  });

  it('a body the user CLEARED stays cleared — empty is a choice, not a gap', async () => {
    const { container } = await withDefs();
    await openCreateForm(container);
    await fireEvent.input(persona(container), { target: { value: '' } });
    await tick();

    await typeName(container, 'collab-scout');
    expect(persona(container).value).toBe('');
  });

  it('a fresh create form re-seeds after a previous one was edited', async () => {
    const { container } = await withDefs();
    await openCreateForm(container);
    await fireEvent.input(persona(container), { target: { value: 'typed' } });
    await tick();
    await fireEvent.click(button(container, 'Cancel'));
    await tick();

    await openCreateForm(container);
    expect(persona(container).value).toContain('You are the bot Agent.');
  });

  it('opening an EXISTING def after editing a draft does not seed over the file', async () => {
    const { container } = await withDefs();
    await openCreateForm(container);
    await fireEvent.click(button(container, 'Cancel'));
    await tick();

    await fireEvent.click(button(cards(container)[0]!, 'Edit')); // Edit crane
    await tick();
    expect(persona(container).value).toBe('You are Crane.');
  });
});

// --- M4.4. The form is the only place a user can turn vision on without
// hand-editing frontmatter, and it is also where the round-trip used to break:
// the pane rebuilt the def field by field on save, so a `vision:` line added by
// hand vanished the first time anyone pressed Save on that agent.
describe('CollabAgentsPane — the vision checkbox', () => {
  const visionBox = (c: Element) =>
    Array.from(c.querySelectorAll('input[type="checkbox"]'))
      .find((i) => (i.closest('label')?.textContent ?? '').includes('Vision capable')) as HTMLInputElement;

  it('a new agent starts text-only and SAYS so', async () => {
    const { container } = await withDefs();
    await openCreateForm(container);
    expect(visionBox(container).checked).toBe(false);
    expect(flat(container.querySelector('.ca-form')!.textContent)).toContain('never the picture itself');
  });

  it('ticking it puts vision:true on the saved def', async () => {
    const { container } = await withDefs();
    await openCreateForm(container);
    await typeName(container, 'collab-seer');
    await fireEvent.click(visionBox(container));
    await tick();
    await fireEvent.click(button(container, 'Save'));
    await tick();

    const saved = posts().find((p) => p.type === 'saveCollabAgentDef')!;
    expect((saved.def as Record<string, unknown>).vision).toBe(true);
    expect((saved.def as Record<string, unknown>).slug).toBe('collab-seer');
  });

  it('opening an existing SEEING def shows it ticked, and saving keeps it', async () => {
    // The regression this catches is the exact one reported: edit an agent for
    // an unrelated reason, press Save, and it silently stops seeing.
    const { container } = await withDefs([{ ...DEFS[0], vision: true }]);
    await fireEvent.click(button(cards(container)[0]!, 'Edit'));
    await tick();
    expect(visionBox(container).checked).toBe(true);

    await fireEvent.click(button(container, 'Save'));
    await tick();
    expect((posts().find((p) => p.type === 'saveCollabAgentDef')!.def as Record<string, unknown>).vision).toBe(true);
  });

  it('un-ticking it turns vision OFF rather than leaving the field unstated', async () => {
    const { container } = await withDefs([{ ...DEFS[0], vision: true }]);
    await fireEvent.click(button(cards(container)[0]!, 'Edit'));
    await tick();
    await fireEvent.click(visionBox(container));
    await tick();
    await fireEvent.click(button(container, 'Save'));
    await tick();
    // `false`, NOT undefined: an unstated field means "keep the file's value"
    // to the writer, so turning it off has to be said out loud.
    expect((posts().find((p) => p.type === 'saveCollabAgentDef')!.def as Record<string, unknown>).vision).toBe(false);
  });
});

// --- D7: the roster also carries ARCHETYPE REFS (architect/ask/debug/...),
// as read-only cards after the collab ones. The archetypes array rides the
// SAME `collabAgentDefs` message the def list already uses, absent by
// default on save/delete (which never change the archetype set).
const ARCHETYPES = [
  { slug: 'architect', description: 'Designs before code.', mode: 'all', managed: false, path: '/tmp/agent/architect.md' },
  { slug: 'scout', description: 'Read-only recon subagent.', mode: 'subagent', managed: true, path: '/tmp/agent/scout.md' },
];
const arCards = (c: Element) => Array.from(c.querySelectorAll('.ar-card'));
// By NAME, not by @handle: an archetype's slug IS its name, so round 2 item 3
// stopped printing the mention on these cards at all.
const findAr = (c: Element, name: string) => arCards(c).find((a) => a.textContent?.includes(name))!;
const referenceToggle = (c: Element) => c.querySelector('.ca-section-toggle') as HTMLButtonElement;
/** Reference agents render collapsed on mount — every test below that reads
 *  an `.ar-card` field needs the group opened first. */
async function openReferenceAgents(container: Element) {
  await fireEvent.click(referenceToggle(container));
  await tick();
}

describe('CollabAgentsPane — archetype reference cards', () => {
  // UAT: "make reference agents collapsible and grouped by default, they
  // look cluttered" — the group renders COLLAPSED on every mount: a header
  // row (label + count), no cards.
  it('renders the reference-agents group COLLAPSED by default: a header with the count, no cards', async () => {
    const { container } = await withDefs(DEFS, ARCHETYPES);
    expect(flat(container.textContent)).toContain('Reference agents (2)');
    expect(arCards(container)).toHaveLength(0);
    expect(referenceToggle(container).getAttribute('aria-expanded')).toBe('false');
  });

  it('expands to show every archetype card on click, and collapses again on a second click', async () => {
    const { container } = await withDefs(DEFS, ARCHETYPES);
    await openReferenceAgents(container);
    expect(arCards(container)).toHaveLength(2);
    expect(referenceToggle(container).getAttribute('aria-expanded')).toBe('true');

    await openReferenceAgents(container); // second click collapses
    expect(arCards(container)).toHaveLength(0);
    expect(referenceToggle(container).getAttribute('aria-expanded')).toBe('false');
  });

  // User-created agents (the collab defs) are a SEPARATE list — the toggle
  // governs only the archetype cards below it.
  it('leaves the user-created collab cards visible regardless of the reference-agents toggle', async () => {
    const { container } = await withDefs(DEFS, ARCHETYPES);
    expect(cards(container)).toHaveLength(3); // collapsed
    await openReferenceAgents(container);
    expect(cards(container)).toHaveLength(3); // expanded — unaffected
  });

  it('no archetypes means no section at all, not an empty one — and no toggle to click', async () => {
    const { container } = await withDefs(DEFS, []);
    expect(container.textContent).not.toContain('Reference agents');
    expect(referenceToggle(container)).toBeNull();
  });

  it('Set model rides the SAME channel def CRUD already uses, with a new message type', async () => {
    const { container } = await withDefs(DEFS, ARCHETYPES);
    await openReferenceAgents(container);
    const architect = findAr(container, 'Architect');
    await fireEvent.click(button(architect, 'Set model'));
    await tick();
    // The popover's own trigger — proving the wiring reached AgentModelSelect.
    expect(architect.textContent).toContain('Engine default');
  });

  // UAT round 2 item 3. Scout used to be the one card with no Set model, on the
  // grounds that archetypes.ts would revert it. What that reasoning protected
  // was the wrong thing: scout is trusted by NAME for the S12 laundering fix
  // through its PERMISSION block, and a pinned model cannot re-grant a tool.
  it('scout offers Set model like every other archetype', async () => {
    const { container } = await withDefs(DEFS, ARCHETYPES);
    await openReferenceAgents(container);
    const scout = findAr(container, 'Scout');
    await fireEvent.click(button(scout, 'Set model'));
    await tick();
    expect(scout.textContent).toContain('Engine default');
  });

  it('carries the upgrade caveat as a HINT on the mode badge, not a badge of its own', async () => {
    const { container } = await withDefs(DEFS, ARCHETYPES);
    await openReferenceAgents(container);
    const chips = Array.from(findAr(container, 'Scout').querySelectorAll('.ar-chip'));
    expect(chips).toHaveLength(1);                       // one badge, not mode + a louder MANAGED
    expect(chips[0]!.textContent).toContain('subagent'); // still says what it is, first
    expect(chips[0]!.textContent).toContain('managed');
    expect(chips[0]!.getAttribute('title')).toBe('security anchor: ask/architect delegate to scout by NAME, so an upgrade restores this file even if hand-edited — a model pin lasts until then');
    // The old body line is gone with it — the caveat is said once, on hover.
    expect(flat(findAr(container, 'Scout').textContent)).not.toContain('upgrades revert edits');
    // ...and an unmanaged archetype says none of it.
    const architect = findAr(container, 'Architect');
    expect(architect.querySelector('.ar-chip.managed')).toBeNull();
    expect(flat(architect.textContent)).not.toContain('managed');
  });

  it('Open file posts the def\'s own absolute path', async () => {
    const { container } = await withDefs(DEFS, ARCHETYPES);
    await openReferenceAgents(container);
    await fireEvent.click(button(findAr(container, 'Architect'), 'Open file'));
    expect(posts()).toContainEqual({ type: 'openAbsoluteFile', path: '/tmp/agent/architect.md' });
  });

  // UAT round 1 item 7: same head-crowding fix as the collab card — Set model
  // and Open file live in a footer row, and the head carries only glyph/name/mode.
  it('Set model and Open file live in the card FOOTER, not beside the name in the head', async () => {
    const { container } = await withDefs(DEFS, ARCHETYPES);
    await openReferenceAgents(container);
    const architect = findAr(container, 'Architect');
    const head = architect.querySelector('.ar-card-head')!;
    const footer = architect.querySelector('.ar-card-footer')!;
    expect(head.querySelector('button')).toBeNull();
    expect(footer.contains(button(architect, 'Set model'))).toBe(true);
    expect(footer.contains(button(architect, 'Open file'))).toBe(true);
  });

  // UAT round 2 item 3, the whole point of it: a collab card and an archetype
  // card land in the SAME grid, so their footers must sit on ONE line across a
  // row however long each description runs. Two halves, both asserted — the
  // footer is the LAST child (nothing renders under it to push it off the
  // bottom edge) and the card is a flex COLUMN whose footer takes
  // `margin-top: auto`, which is what spends the height a grid item already
  // stretches to. The CSS is read from SOURCE: jsdom never applies a
  // component's injected styles, so a computed style would pass on nothing.
  it('the footer is the LAST child of EVERY card, legacy-seed notice included', async () => {
    const { container } = await withDefs(DEFS, ARCHETYPES);
    await openReferenceAgents(container);
    // Every card, not just the first: the legacy-seed card carries an extra
    // block, and a variable-height extra is exactly what would end up rendering
    // BELOW a footer and unpinning it from the bottom edge.
    // classList, not className: svelte appends its own scope class to every
    // styled element, so an equality check would assert the hash too.
    expect(cards(container)).toHaveLength(3);
    for (const c of cards(container)) expect(c.lastElementChild!.classList.contains('ca-card-footer')).toBe(true);
    expect(arCards(container)).toHaveLength(2);
    for (const a of arCards(container)) expect(a.lastElementChild!.classList.contains('ar-card-footer')).toBe(true);
  });

  it('both card kinds are flex columns with the footer pinned by margin-top: auto', () => {
    for (const [file, card, footer] of [
      ['CollabAgentCard.svelte', '.ca-card', '.ca-card-footer'],
      ['ArchetypeAgentCard.svelte', '.ar-card', '.ar-card-footer'],
    ] as const) {
      const src = componentSrc(file);
      expect(rule(src, card), `${file} ${card}`).toMatch(/display:\s*flex/);
      expect(rule(src, card), `${file} ${card}`).toMatch(/flex-direction:\s*column/);
      expect(rule(src, footer), `${file} ${footer}`).toMatch(/margin-top:\s*auto/);
    }
  });

  it('the two card kinds use the SAME button metrics — one grid, one button size', () => {
    const body = (file: string, sel: string) => {
      const r = rule(componentSrc(file), sel);
      return r.slice(r.indexOf('{') + 1).trim();
    };
    expect(body('CollabAgentCard.svelte', '.ca-btn')).toBe(body('ArchetypeAgentCard.svelte', '.ar-btn'));
  });
});
