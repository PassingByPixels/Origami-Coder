// The BOTS section, driven through its real message contract.
//
// collabAgentsPane.test.ts already pins what this view was: a def list and an
// editor. These are what it BECAME — a place a bot is set up as a character and
// then put to work — and each one is a claim that would be silently wrong
// rather than visibly broken:
//
//  1. THE CARD MUST BE HONEST ABOUT ABSENCE. Every contract key is optional and
//     every default is today's behaviour, so a card that draws an unconfigured
//     def as "worker / memory on" makes it look deliberately set up, and nobody
//     goes looking for the decision nobody made.
//  2. A NEW BOT MUST BE USABLE AFTER ONE FORM PASS. The starting tick set has to
//     reach the SAVED message, not just the on-screen control — the writer
//     resolves unstated fields from disk, so a default that never crossed the
//     wire is a default that never happened.
//  3. THE SAVE MESSAGE MUST SURVIVE THE WIRE. A webview `postMessage`
//     structured-clones, and W6's live bug was a payload that could not be
//     cloned: everything looked right on screen and nothing was ever written.
//  4. START SESSION MUST NAME THE BOT. A chat opened as the wrong agent looks
//     completely normal until it behaves like the wrong character.
//  5. A REFUSAL MUST SURFACE. A button that silently does nothing is
//     indistinguishable from an engine that has not finished starting.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import CollabAgentsPane from '../panes/CollabAgentsPane.svelte';
import { OBSERVER_TOOLS, WORKER_TOOLS, allToolKeys } from '../../../src/dashboard/botTools';

const posts = () =>
  globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;
const lastPost = (type: string) => [...posts()].reverse().find((p) => p.type === type);
const cards = (c: Element) => Array.from(c.querySelectorAll('.ca-card'));
const button = (c: Element, label: string) =>
  Array.from(c.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)!;
const facts = (card: Element): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const f of card.querySelectorAll('.ca-fact')) {
    out[f.querySelector('.cf-k')!.textContent!.trim()] = f.querySelector('.cf-v')!.textContent!.trim();
  }
  return out;
};

/** A def as the host sends it: `bot` always present, empty when unconfigured. */
const def = (over: Record<string, unknown> = {}) => ({
  slug: 'collab-crane', description: 'Builds it.', model: '', glyph: 'crane',
  persona: 'You are Crane.\nYou build what the room agreed on.\n\nRules follow.',
  preset: 'worker', steps: '', vision: false, visionProfile: false, bot: {}, ...over,
});

async function mounted(defs: unknown[] = [def()], extra: Record<string, unknown> = {}) {
  const rendered = render(CollabAgentsPane);
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'collabAgentDefs', defs, archetypes: [], ...extra } }));
  await tick();
  return rendered;
}
async function openCreateForm(container: Element) {
  await fireEvent.click(button(container, '＋ New bot'));
  await tick();
}
async function typeName(container: Element, value: string) {
  const input = container.querySelector('input[aria-label="Agent name"]') as HTMLInputElement;
  await fireEvent.input(input, { target: { value } });
  await tick();
}
/** One tool checkbox in the editor's checklist, by the permission key it writes. */
const toolBox = (c: Element, key: string) =>
  Array.from(c.querySelectorAll('.bc-tool')).find((l) => l.textContent?.trim().startsWith(key))!
    .querySelector('input') as HTMLInputElement;
const ticked = (c: Element) =>
  Array.from(c.querySelectorAll('.bc-tool')).filter((l) => l.querySelector('input')!.checked)
    .map((l) => l.textContent!.trim().replace(/\+\d+$/, ''));
/** AgentModelSelect is a trigger + popover, not a `<select>`: open it, open the
 *  provider group (they mount collapsed), then click the one option. */
async function pickModel(c: Element, name: string) {
  await fireEvent.click(c.querySelector('.ams-trigger') as HTMLElement);
  await tick();
  await fireEvent.click(c.querySelector('.ams-group') as HTMLElement);
  await tick();
  await fireEvent.click(Array.from(c.querySelectorAll('.ams-opt')).find((b) => b.textContent?.includes(name))!);
  await tick();
}

beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });
afterEach(() => cleanup());

describe('the bot card renders every contract field, absence included', () => {
  it('draws an UNCONFIGURED def as the engine defaults, not as a set-up bot', async () => {
    const { container } = await mounted();
    const f = facts(cards(container)[0]!);
    expect(f.Tools).toBe('engine default');
    expect(f.Memory).toBe('on');
    // ...and the muted class is what says "nobody decided this" at a glance.
    const values = Array.from(cards(container)[0]!.querySelectorAll('.ca-fact .cf-v.unset')).map((v) => v.textContent!.trim());
    expect(values).toEqual(expect.arrayContaining(['engine default', 'on']));
  });

  it('draws a CONFIGURED def as chosen, with no muted marker on the fields it states', async () => {
    // A pinned model too, so the assertion below covers the WHOLE row: `model:
    // ''` is itself an unstated field and would otherwise account for the mark.
    const { container } = await mounted([def({ model: 'lmstudio/qwen-32b', tools: [...OBSERVER_TOOLS], bot: { memory: false } })]);
    const card = cards(container)[0]!;
    expect(facts(card)).toMatchObject({ Tools: 'observer', Memory: 'off' });
    expect(card.querySelectorAll('.ca-fact .cf-v.unset')).toHaveLength(0);
  });

  // The card summary the ruling asked for: a preset is NAMED, an adjusted set
  // says how many tools it really is, and a def with no block at all says so.
  it('names a preset tick set and counts an adjusted one', async () => {
    const { container } = await mounted([
      def({ tools: [...WORKER_TOOLS] }),
      def({ slug: 'collab-heron', tools: [...WORKER_TOOLS, 'browser'] }),
      def({ slug: 'collab-owl' }),
    ]);
    expect(facts(cards(container)[0]!).Tools).toBe('worker');
    expect(facts(cards(container)[1]!).Tools).toBe(`${WORKER_TOOLS.length + 1} tools`);
    expect(facts(cards(container)[2]!).Tools).toBe('engine default');
  });

  // An EMPTY tick set is a real, different answer from an absent block: one is
  // a bot allowed nothing, the other is a bot offered everything.
  it('keeps "allowed nothing" and "no block at all" apart', async () => {
    const { container } = await mounted([def({ tools: [] }), def({ slug: 'collab-heron' })]);
    const allowedNothing = cards(container)[0]!;
    expect(facts(allowedNothing).Tools).not.toBe('engine default');
    // ...and it is a CHOICE, so it is not drawn in the muted "nobody decided
    // this" tone the absent block below takes.
    expect(allowedNothing.querySelector('.ca-fact .cf-v.unset')!.textContent).not.toMatch(/tool/);
    expect(facts(cards(container)[1]!).Tools).toBe('engine default');
    expect(Array.from(cards(container)[1]!.querySelectorAll('.ca-fact .cf-v.unset')).map((v) => v.textContent))
      .toContain('engine default');
  });

  // The TIER is not a control any more, so drawing "engine default" on every
  // card would spend a label on a decision nobody can make from here.
  it('draws a Tier row only for a def that states one', async () => {
    const { container } = await mounted([def(), def({ slug: 'collab-heron', bot: { tier: 'strict' } })]);
    expect('Tier' in facts(cards(container)[0]!)).toBe(false);
    expect(facts(cards(container)[1]!).Tier).toBe('strict');
  });

  // W6 ruling (c): a model preference no longer silences the warning, because
  // there is no such key any more. A stale one left in a file must not hide a
  // bot that has nothing deciding its model.
  it('warns an unpinned def even when a stale model preference is present', async () => {
    const { container } = await mounted([def({ bot: { modelPrefer: ['any'] } })]);
    expect(container.querySelector('.ca-card-stale')!.textContent).toMatch(/No model pinned/);
    const { container: pinned } = await mounted([def({ model: 'lmstudio/qwen-32b' })]);
    expect(pinned.querySelector('.ca-card-stale')).toBeNull();
  });

  // The one card fact that is not in the def file.
  it('reports what a bot has actually KEPT, from the store rather than the def', async () => {
    const { container } = await mounted([def()], { memoryFacts: { 'collab-crane': 7 } });
    expect(facts(cards(container)[0]!).Memory).toBe('7 kept');
  });

  it('shows the persona so one bot is recognisable beside another', async () => {
    const { container } = await mounted();
    expect(cards(container)[0]!.querySelector('.ca-card-persona')!.textContent)
      .toBe('You are Crane. You build what the room agreed on.');
  });

  // A tier the engine cannot read adds NO rules — the def claims a permission
  // level it is not running under. Drawing that quietly is the failure.
  it('flags an unreadable permission tier instead of rendering it as a value', async () => {
    const { container } = await mounted([def({ bot: { unknownTier: 'stricter' } })]);
    expect(cards(container)[0]!.querySelector('.ca-fact .cf-v.bad')!.textContent).toContain('stricter');
  });
});

describe('start session — one bot, its own chat', () => {
  // BOTH names, and they are different things: `slug` is the engine agent the
  // session is pointed at, `displayName` is what the chat tab reads. Sending
  // the slug for both would title the tab "Collab-crane" for a bot every other
  // surface — this card included — calls Crane.
  it('posts the slug the engine knows AND the name the tab should read', async () => {
    const { container } = await mounted();
    await fireEvent.click(button(cards(container)[0]!, 'Start session'));
    expect(lastPost('startBotSession')).toEqual({ type: 'startBotSession', slug: 'collab-crane', displayName: 'Crane' });
  });

  it('names the RIGHT bot when several are listed', async () => {
    const { container } = await mounted([def(), def({ slug: 'collab-heron' })]);
    await fireEvent.click(button(cards(container)[1]!, 'Start session'));
    expect(lastPost('startBotSession')!.slug).toBe('collab-heron');
  });

  // A vision profile is prompted with one image through a direct completion
  // with no tools on it. There is no turn to run "as" it.
  it('is not offered for a vision profile', async () => {
    const { container } = render(CollabAgentsPane);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'collabAgentDefs', defs: [], visionDefs: [def({ slug: 'vision-eye', visionProfile: true, vision: true })], archetypes: [] },
    }));
    await tick();
    await fireEvent.click(button(container, 'Vision Agents'));
    await tick();
    expect(cards(container)).toHaveLength(1);
    expect(button(cards(container)[0]!, 'Start session')).toBeUndefined();
  });

  it('surfaces a refusal rather than leaving the button looking broken', async () => {
    const { container } = await mounted();
    await fireEvent.click(button(cards(container)[0]!, 'Start session'));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'botSessionResult', slug: 'collab-crane', error: 'agent type unavailable: collab-crane' } }));
    await tick();
    expect(container.querySelector('.ca-error')!.textContent).toContain('agent type unavailable');
  });
});

// W8-L2 (live UAT): "clicking Start session on a bot shows NOTHING anywhere for
// ~10 seconds, then the chat appears". Nothing was broken — a bot chat is
// PROVISIONAL (sessionAnnounce.ts), so the panel is deliberately held back until
// the engine has accepted the definition, and that wait is a cold engine boot:
// measured at 4.9 s to `session/new` on this machine (spawn 1.3 s + the first
// directory snapshot 3.5 s), with the bot path costing the same as an ordinary
// chat. So for the whole wait this CARD is the only surface the click has, and
// the button is the only thing on it that knows the click happened.
describe('a bot start says so while it is in flight', () => {
  const startBtn = (card: Element) => card.querySelector('.ca-btn.primary') as HTMLButtonElement;
  const result = (over: Record<string, unknown>) =>
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'botSessionResult', slug: 'collab-crane', ...over } }));

  it('marks the card that was clicked, and only that one', async () => {
    const { container } = await mounted([def(), def({ slug: 'collab-heron' })]);
    await fireEvent.click(startBtn(cards(container)[0]!));
    await tick();
    expect(startBtn(cards(container)[0]!).textContent!.trim()).toBe('Starting…');
    expect(startBtn(cards(container)[0]!).disabled).toBe(true);
    // The bot NOT being started must still offer to start — a pane-wide "busy"
    // would take the one action away from every other card on screen.
    expect(startBtn(cards(container)[1]!).textContent!.trim()).toBe('Start session');
    expect(startBtn(cards(container)[1]!).disabled).toBe(false);
  });

  it('clears when the chat opens', async () => {
    const { container } = await mounted();
    await fireEvent.click(startBtn(cards(container)[0]!));
    await tick();
    expect(startBtn(cards(container)[0]!).textContent!.trim()).toBe('Starting…');
    result({ ok: true });
    await tick();
    expect(startBtn(cards(container)[0]!).textContent!.trim()).toBe('Start session');
    expect(startBtn(cards(container)[0]!).disabled).toBe(false);
  });

  // The refusal already had a home. What it must ALSO do is give the button
  // back: a card stuck on "Starting…" beside an error is a bot you cannot retry.
  it('clears on a refusal too, beside the error it already reports', async () => {
    const { container } = await mounted();
    await fireEvent.click(startBtn(cards(container)[0]!));
    await tick();
    expect(startBtn(cards(container)[0]!).textContent!.trim()).toBe('Starting…');
    result({ error: 'No agent DEFINITION named "collab-crane" is loaded.' });
    await tick();
    expect(container.querySelector('.ca-error')!.textContent).toContain('No agent DEFINITION');
    expect(startBtn(cards(container)[0]!).textContent!.trim()).toBe('Start session');
    expect(startBtn(cards(container)[0]!).disabled).toBe(false);
  });

  // Every start spawns its OWN engine child (acpClient.start), so an impatient
  // second click during the silent 5 s is a second engine and a second chat for
  // one intended session. `disabled` is a hint the DOM can be talked out of;
  // this asserts the pane refuses the duplicate itself.
  it('refuses a second start for the same bot while the first is in flight', async () => {
    const { container } = await mounted();
    await fireEvent.click(startBtn(cards(container)[0]!));
    await tick();
    await fireEvent.click(startBtn(cards(container)[0]!));
    expect(posts().filter((p) => p.type === 'startBotSession')).toHaveLength(1);
  });

  // ...and a DIFFERENT bot is not blocked by it. Two bots starting at once is a
  // legitimate thing to ask for, and the first one's wait must not disarm the rest.
  it('lets another bot start while one is in flight, and tracks both', async () => {
    const { container } = await mounted([def(), def({ slug: 'collab-heron' })]);
    await fireEvent.click(startBtn(cards(container)[0]!));
    await tick();
    await fireEvent.click(startBtn(cards(container)[1]!));
    await tick();
    expect(posts().filter((p) => p.type === 'startBotSession')).toHaveLength(2);
    expect(startBtn(cards(container)[0]!).textContent!.trim()).toBe('Starting…');
    expect(startBtn(cards(container)[1]!).textContent!.trim()).toBe('Starting…');
    // One result clears ONE card: the slug on the reply is which bot it is about.
    result({ ok: true });
    await tick();
    expect(startBtn(cards(container)[0]!).textContent!.trim()).toBe('Start session');
    expect(startBtn(cards(container)[1]!).textContent!.trim()).toBe('Starting…');
  });
});

describe('a new bot is ready after ONE form pass', () => {
  const savedDef = () => lastPost('saveCollabAgentDef')!.def as Record<string, unknown>;

  // W9 owner ruling: a new bot starts ABLE and the user takes away. Asserted on
  // screen AND on the wire — the writer resolves unstated fields from disk, so a
  // starting set that never crossed the message boundary never happened.
  it('is born with EVERY tool ticked, and the whole set reaches the saved def', async () => {
    const { container } = await mounted();
    await openCreateForm(container);
    await typeName(container, 'collab-scout');
    const every = allToolKeys();
    expect(ticked(container).sort()).toEqual([...every].sort());
    await fireEvent.click(button(container, 'Save'));
    expect(savedDef().slug).toBe('collab-scout');
    expect((savedDef().tools as string[]).sort()).toEqual([...every].sort());
  });

  // The buttons themselves. Their absence is the ruling, and a test that only
  // checked the starting SET would still pass with them sitting there re-stamping
  // it — which is the state the ruling was written to end.
  it('offers no Worker and no Observer button anywhere in the editor', async () => {
    const { container } = await mounted();
    await openCreateForm(container);
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent!.trim());
    expect(labels).not.toContain('Worker');
    expect(labels).not.toContain('Observer');
  });

  // The other half of "ready in one pass": the starting set must not quietly
  // also decide the things it has no business deciding. The tier is one of
  // them now — W6 took the control away, so writing the key would configure a
  // def by a decision nobody can see or change.
  it('states no tier and no memory opt-out unless asked', async () => {
    const { container } = await mounted();
    await openCreateForm(container);
    await typeName(container, 'collab-scout');
    await fireEvent.click(button(container, 'Save'));
    expect(savedDef().bot).toEqual({});
  });

  // The ruling in one test: born ticked, then the user TAKES AWAY. An untick
  // that did not survive the save would make the checklist decoration.
  it('unticking after birth survives the save', async () => {
    const { container } = await mounted();
    await openCreateForm(container);
    await typeName(container, 'collab-scout');
    await fireEvent.click(toolBox(container, 'bash'));
    await fireEvent.click(toolBox(container, 'edit'));
    await tick();
    await fireEvent.click(button(container, 'Save'));
    expect((savedDef().tools as string[]).sort())
      .toEqual(allToolKeys().filter((k) => k !== 'bash' && k !== 'edit').sort());
  });

  // An EXISTING def keeps what its file says. "Everything ticked" is what a NEW
  // bot starts from, never a state the editor imposes on a def it merely opened:
  // saving an observer after a look would silently hand it bash and edit.
  it('leaves an existing def’s stored ticks exactly as they were', async () => {
    const { container } = await mounted([def({ tools: [...OBSERVER_TOOLS] })]);
    await fireEvent.click(button(cards(container)[0]!, 'Edit'));
    await tick();
    expect(ticked(container).sort()).toEqual([...OBSERVER_TOOLS].sort());
    await fireEvent.click(button(container, 'Save'));
    expect((savedDef().tools as string[]).sort()).toEqual([...OBSERVER_TOOLS].sort());
  });

  // Tick -> save -> reload -> same ticks. The host echoes the parsed def back,
  // so the editor reopened on it has to show what the file now says.
  it('round-trips a tick set: what was saved is what the editor reopens on', async () => {
    const picked = [...OBSERVER_TOOLS, 'browser', 'chart'];
    const { container } = await mounted([def({ tools: picked })]);
    await fireEvent.click(button(cards(container)[0]!, 'Edit'));
    await tick();
    expect(ticked(container).sort()).toEqual([...picked].sort());
    await fireEvent.click(button(container, 'Save'));
    expect((savedDef().tools as string[]).sort()).toEqual([...picked].sort());
  });

  // ON is stored as SILENCE, because `memory: true` is already the engine
  // default — writing it would put a line in every file that says nothing.
  it('memory OFF is written, memory ON is left unstated', async () => {
    const { container } = await mounted();
    await openCreateForm(container);
    await typeName(container, 'collab-scout');
    const box = Array.from(container.querySelectorAll('input[type="checkbox"]'))
      .find((i) => (i.closest('label')?.textContent ?? '').includes('own memory')) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await fireEvent.change(box, { target: { checked: false } });
    await fireEvent.click(button(container, 'Save'));
    expect((savedDef().bot as { memory: boolean }).memory).toBe(false);
  });

  // The checklist is the ENGINE's list when there is an engine to ask, so the
  // pane has to ask. The shipped mirror still works, which is why this asserts
  // the request rather than the presence of a particular row.
  it('asks the engine for the tool catalogue so the checklist is the real one', async () => {
    await mounted();
    expect(posts().map((p) => p.type)).toContain('toolsRequest');
  });

  // The live list REPLACES the shipped mirror rather than being merged into it,
  // so a user-file or plugin tool the engine reported is tickable at once.
  it('builds the checklist from the tools the ENGINE reported, unknown ones included', async () => {
    const { container } = await mounted([def({ tools: ['read'] })]);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'toolsData', tools: [{ id: 'read' }, { id: 'acme_deploy' }] },
    }));
    await fireEvent.click(button(cards(container)[0]!, 'Edit'));
    await tick();
    expect(Array.from(container.querySelectorAll('.bc-tool')).map((l) => l.textContent!.trim()))
      .toEqual(['acme_deploy', 'read']);

    await fireEvent.click(toolBox(container, 'acme_deploy'));
    await tick();
    await fireEvent.click(button(container, 'Save'));
    expect((savedDef().tools as string[]).sort()).toEqual(['acme_deploy', 'read']);
  });

  // THE CHECKLIST GROWS WITH THE ENGINE, and W9 made that load-bearing rather
  // than merely nice: "all ticked" is a claim the form makes about the list it
  // is drawing, so a new bot born off the SHIPPED mirror while the engine offers
  // a newer tool would open with a row visibly unticked and save a def denying
  // a capability nobody withheld. Asserted end to end — the row renders, it is
  // ticked, and it round-trips into the saved def.
  it('a NEW bot is born ticked on a tool this build has never heard of', async () => {
    const { container } = await mounted();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'toolsData', tools: [{ id: 'read' }, { id: 'bash' }, { id: 'acme_deploy' }] },
    }));
    await tick();
    await openCreateForm(container);
    await typeName(container, 'collab-scout');

    // It RENDERS — the engine's list, not the mirror's.
    expect(Array.from(container.querySelectorAll('.bc-tool')).map((l) => l.textContent!.trim()))
      .toEqual(['acme_deploy', 'bash', 'read']);
    // ...and it is TICKED, which the shipped mirror alone could never produce.
    expect(ticked(container).sort()).toEqual(['acme_deploy', 'bash', 'read']);
    expect(allToolKeys()).not.toContain('acme_deploy');

    // ...and it ROUND-TRIPS: the novel key reaches the saved def, so the file
    // says `acme_deploy: allow` rather than falling under the deny-all base.
    await fireEvent.click(button(container, 'Save'));
    expect((savedDef().tools as string[]).sort()).toEqual(['acme_deploy', 'bash', 'read']);
  });

  // A key the FILE allows that neither list knows still gets a row: without one
  // there would be no way to untick a line the user wrote by hand, and the
  // writer would keep copying it out forever.
  it('gives a ticked key nothing knows about a row of its own', async () => {
    const { container } = await mounted([def({ tools: ['read', 'legacy_thing'] })]);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'toolsData', tools: [{ id: 'read' }] } }));
    await fireEvent.click(button(cards(container)[0]!, 'Edit'));
    await tick();
    expect(ticked(container).sort()).toEqual(['legacy_thing', 'read']);
  });

  // A HAND-TUNED block scopes a tool to particular commands (`bash:` then
  // `"git status": allow`), which no tick can say — so it parses to NO tick set
  // and is copied out verbatim. Drawing an all-unticked checklist over it would
  // claim the bot has no tools while the file grants it several, and one click
  // would replace a block the editor has just promised to keep.
  it('shows no checklist over a hand-tuned block, and says why', async () => {
    const { container } = await mounted([def({
      preset: 'custom',
      customPermission: 'permission:\n  "*": deny\n  bash:\n    "git status": allow',
    })]);
    await fireEvent.click(button(cards(container)[0]!, 'Edit'));
    await tick();
    expect(container.querySelectorAll('.bc-tool')).toHaveLength(0);
    expect(container.textContent).toMatch(/hand-tuned permission block/i);

    // ...and ONE explicit button is the way out — the last control left on this
    // pane, and not a preset: it writes what a NEW bot writes, all of it.
    await fireEvent.click(button(container, 'Replace with a tick list'));
    await tick();
    expect(ticked(container).sort()).toEqual([...allToolKeys()].sort());
    await fireEvent.click(button(container, 'Save'));
    expect((savedDef().tools as string[]).sort()).toEqual([...allToolKeys()].sort());
  });

  // Nothing was touched, so nothing may be rewritten: the tick set stays absent
  // and the writer keeps the block exactly as it stands.
  it('a hand-tuned def saved untouched states no tick set at all', async () => {
    const { container } = await mounted([def({
      preset: 'custom',
      customPermission: 'permission:\n  "*": deny\n  bash:\n    "git status": allow',
    })]);
    await fireEvent.click(button(cards(container)[0]!, 'Edit'));
    await tick();
    await fireEvent.click(button(container, 'Save'));
    expect('tools' in savedDef()).toBe(false);
    expect(savedDef().customPermission).toContain('"git status": allow');
  });
});

// THE W6 LIVE BUG, as the owner hit it: "assigning a model to crane doesn't
// save — continues to show the unpinned model argument".
//
// The pane posts the draft, and `draft` is a `$state` rune, so every nested
// value read off it is a PROXY. `{ ...draft }` flattened only the top level —
// fine while every field was a string, and broken the moment the def grew
// objects. A webview postMessage STRUCTURED-CLONES, and structured clone throws
// DataCloneError on a Proxy: the post never left the webview, the host never
// heard of the save, and the card came back still warning about the model that
// had just been picked. Nothing logged, nothing refused.
//
// The test mock is a plain spy that never serialises, which is exactly why the
// whole suite stayed green through it — so this clones what it captured.
describe('the save message survives the wire it is actually sent over', () => {
  const send = () => structuredClone(lastPost('saveCollabAgentDef'));

  it('a picked model reaches the host, and the payload is CLONEABLE', async () => {
    const { container } = await mounted([def()], {});
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'modelOptions', options: [{ value: 'lmstudio/qwen-32b', name: 'Qwen 32B' }] },
    }));
    await tick();
    await fireEvent.click(button(cards(container)[0]!, 'Edit'));
    await tick();
    await pickModel(container, 'Qwen 32B');
    await fireEvent.click(button(container, 'Save'));

    expect(send).not.toThrow();
    expect((send()!.def as { model: string }).model).toBe('lmstudio/qwen-32b');
  });

  // The nested values are what broke it, so each one is named: a payload that
  // clones only because the def happened to be flat proves nothing.
  it('carries the nested contract and tick set as plain data', async () => {
    const { container } = await mounted([def({ tools: [...WORKER_TOOLS], bot: { memory: false } })]);
    await fireEvent.click(button(cards(container)[0]!, 'Edit'));
    await tick();
    await fireEvent.click(button(container, 'Save'));

    const def_ = send()!.def as { tools: string[]; bot: Record<string, unknown> };
    expect(def_.tools.sort()).toEqual([...WORKER_TOOLS].sort());
    expect(def_.bot).toEqual({ memory: false });
  });

  it('survives it for a NEW bot too, which is born with the same nested fields', async () => {
    const { container } = await mounted();
    await openCreateForm(container);
    await typeName(container, 'collab-scout');
    await fireEvent.click(button(container, 'Save'));
    expect(send).not.toThrow();
  });
});

describe('bot memory — the view and the wipe', () => {
  const openEdit = async (container: Element) => {
    await fireEvent.click(button(cards(container)[0]!, 'Edit'));
    await tick();
  };

  it('offers View and Clear only for a bot that has kept something', async () => {
    const { container } = await mounted([def()], { memoryFacts: { 'collab-crane': 3 } });
    await openEdit(container);
    expect(button(container, 'View 3')).toBeDefined();
    expect(button(container, 'Clear')).toBeDefined();

    const { container: empty } = await mounted();
    await openEdit(empty);
    expect(button(empty, 'Clear')).toBeUndefined();
  });

  it('View asks the host for that bot\'s store and renders what comes back', async () => {
    const { container } = await mounted([def()], { memoryFacts: { 'collab-crane': 3 } });
    await openEdit(container);
    await fireEvent.click(button(container, 'View 3'));
    expect(lastPost('botMemoryRead')).toEqual({ type: 'botMemoryRead', slug: 'collab-crane' });

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'botMemoryData', slug: 'collab-crane', facts: 1, text: '- [2026-08-01] Ships on Fridays.', dir: '/cfg/bot/collab-crane/memory' },
    }));
    await tick();
    expect(container.querySelector('.bm-panel')!.textContent).toContain('Ships on Fridays.');
    expect(container.querySelector('.bm-dir')!.textContent).toBe('/cfg/bot/collab-crane/memory');
  });

  // The card's count is corrected from the store the host READ BACK, never
  // optimistically: a wipe that failed must not leave the card claiming zero.
  it('a clear updates the card count from the host reply, not from the click', async () => {
    const { container } = await mounted([def()], { memoryFacts: { 'collab-crane': 3 } });
    await openEdit(container);
    await fireEvent.click(button(container, 'Clear'));
    expect(lastPost('botMemoryClear')).toEqual({ type: 'botMemoryClear', slug: 'collab-crane' });
    expect(facts(cards(container)[0]!).Memory).toBe('3 kept');

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'botMemoryData', slug: 'collab-crane', facts: 0, text: '', dir: '/cfg/bot/collab-crane/memory' },
    }));
    await tick();
    expect(facts(cards(container)[0]!).Memory).toBe('on');
  });
});
