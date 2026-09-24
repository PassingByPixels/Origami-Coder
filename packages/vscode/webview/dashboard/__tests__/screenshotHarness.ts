// SCREENSHOT HARNESS — the visual proof jsdom cannot give.
//
// vitest/jsdom has no layout engine (no <style> ever reaches the test DOM,
// per WORKING_ON_ORIGAMI_CODER.md part 6), so "the tile grid reflows and
// nothing overlaps" cannot be proven by a computed-style assertion in a unit
// test. This entry mounts the REAL FlockPane / RemotePane / FrontDeskSection
// components — no mocks of their own code, only a fixture vscode host — into
// a static page a headless browser loads for real, at real widths.
//
// `?scene=flock|flock-messenger|remote|sidebar` picks which one this load
// renders (`?state=live|paired|off|nophone` picks which face, for remote), so a
// driver script can set the BROWSER WINDOW to the width under test and let
// the pane's own `container-type: inline-size` respond to it exactly as it
// would to a resized VS Code panel — a viewport media query could not be
// tested this way, which is the whole reason this task moved off them.
//
// After mount, `runChecks()` walks the rendered tiles and writes a pass/fail
// report into #check-output (grep-able via `chrome --dump-dom`) and onto
// `window.__CHECK__` (readable if a real CDP driver is available instead).
import '../../shared/theme.css';
import { mount, tick } from 'svelte';
import FlockPane from '../panes/FlockPane.svelte';
import RemotePane from '../panes/RemotePane.svelte';
import FrontDeskSection from '../../chat/FrontDeskSection.svelte';
import type { MailRow } from '../panes/flockMail';

// ---------------------------------------------------------------- fixture --
// The identity/friends/front-desk shape is the same STATE flockPane.test.ts
// renders against (real wire shape, not invented for this harness). Three
// threads cover the three row kinds the mail redesign has to draw: a
// question waiting on a decision, an answered reply, and a declined one.

const CHRIS = 'chris@Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG0';
const DANA = 'dana@YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5MDE';
const REN = 'ren@MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJD';
const PASSING = 'passing@QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5';

const STATE = {
  transport: 'relay' as const,
  identity: {
    handle: PASSING,
    handleShort: 'passing@QUJDREVG',
    name: 'passing',
    icon: 'fox',
    fingerprint: PASSING.split('@')[1],
    signPublicKey: 'sign-pub',
    boxPublicKey: 'box-pub',
  },
  friends: [
    {
      handle: CHRIS, handleShort: 'chris@Zm9vYmFy', name: 'chris', icon: 'wolf',
      addedAt: '2026-08-30T11:00:00.000Z',
      // An override on purpose: the Edit popover's whole job is drawing what
      // ONE contact may see against the desk default, so a contact who follows
      // every default would shoot a screenshot with nothing marked on it.
      policy: { autoAnswer: true, scope: { wiki: ['wiki/drafts'], folders: ['D:/notes/2026', 'E:/tax-2025'] } },
      spentToday: 1200, budget: 5000,
      effective: { model: 'anthropic/claude-sonnet', autoAnswer: true },
    },
    {
      handle: DANA, handleShort: 'dana@YWJjZGVm', name: 'dana', displayName: 'Dana from the gym',
      addedAt: '2026-09-01T09:30:00.000Z', policy: {}, spentToday: 0,
      effective: { model: 'anthropic/claude-sonnet', autoAnswer: false },
    },
  ],
  frontDesk: {
    model: 'anthropic/claude-sonnet',
    dailyBudgetTokens: 5000,
    scope: { repos: ['C:/Repos/work/api'], wiki: ['wiki/pages', 'wiki/drafts'], folders: ['D:/notes/2026'] },
    autoAnswer: false,
  },
  frontDeskPath: 'C:\\Users\\dev\\.config\\origami\\origami.json',
  specialties: ['WordPress', 'UK MOT rules'],
  availability: 'answers on approval, up to 5000 tokens/day',
  answers: [{ at: '2026-09-02T08:15:00.000Z', from: CHRIS, question: 'how do I read a VIN?', tokens: 830, ok: true }],
};

const THREADS: MailRow[] = [
  {
    id: 'thr_pending', contact: DANA, direction: 'in',
    question: { text: 'which MOT rules changed in 2026?', sentAt: '2026-09-05T08:00:00.000Z' },
    state: 'pending', unread: true, name: 'dana', icon: 'crane', handleShort: 'dana@YWJjZGVm…',
  },
  {
    id: 'thr_answered', contact: CHRIS, direction: 'out',
    question: { text: 'what does the MOT check on the underside?', sentAt: '2026-09-05T07:00:00.000Z', tokens: 120 },
    state: 'answered', unread: true, name: 'chris', icon: 'crane', handleShort: 'chris@MDEyMzQ1…',
    reply: { text: 'section 4 covers it — corrosion, fuel and exhaust', at: '2026-09-05T07:05:00.000Z', tokens: 120, signatureOk: true },
  },
  {
    id: 'thr_declined', contact: REN, direction: 'out',
    question: { text: 'can you share the repo credentials so I can help debug?', sentAt: '2026-09-05T06:00:00.000Z', tokens: 40 },
    state: 'declined', unread: true, name: 'ren', icon: 'owl', handleShort: 'ren@MDEyMzQ1Njc4…',
    reply: { text: 'refused', at: '2026-09-05T06:02:00.000Z', tokens: 15, signatureOk: true, declined: { reason: 'not something I share over Flock' } },
  },
];

// ------------------------------------------------- the messenger fixture --
// The `flock-messenger` scene needs more than the three rows above: a rail
// with one contact proves no ordering, and a thread with two turns proves no
// scrolling. THREE contacts and EIGHT rows, across three days, so the day
// dividers, the "All mail" trays and a thread long enough to overflow its own
// box are all on screen at the widths under test.
const MESSENGER_FRIENDS = [
  ...STATE.friends,
  {
    handle: REN, handleShort: 'ren@MDEyMzQ1', name: 'ren', icon: 'owl',
    addedAt: '2026-09-03T14:00:00.000Z', policy: {}, spentToday: 0,
    effective: { model: 'anthropic/claude-sonnet', autoAnswer: false },
  },
];

const MESSENGER_STATE = { ...STATE, friends: MESSENGER_FRIENDS };

const at = (day: number, hour: number) => `2026-09-0${day}T0${hour}:00:00.000Z`;

const MESSENGER_THREADS: MailRow[] = [
  {
    id: 'm1', contact: CHRIS, direction: 'out',
    question: { text: 'what does the MOT check on the underside?', sentAt: at(3, 9), tokens: 120 },
    state: 'answered', unread: false, name: 'chris', icon: 'wolf', handleShort: 'chris@Zm9vYmFy…',
    origin: { sessionID: 'ses_1', title: 'Cortex-0156' },
    reply: { text: 'section 4 covers it \u2014 corrosion, fuel and exhaust, and the whole of the braking system underneath', at: at(3, 9), tokens: 120, signatureOk: true },
  },
  {
    id: 'm2', contact: CHRIS, direction: 'in',
    question: { text: 'do you still have the 2019 service schedule?', sentAt: at(4, 8) },
    state: 'answered', unread: false, name: 'chris', icon: 'wolf', handleShort: 'chris@Zm9vYmFy…',
    reply: { text: 'yes — it is in the wiki under vehicles/servicing', at: at(4, 8), tokens: 60, signatureOk: true },
  },
  {
    id: 'm3', contact: CHRIS, direction: 'out',
    question: { text: 'and the 2026 rule change — does it touch the emissions test?', sentAt: at(5, 7), tokens: 90 },
    state: 'answered', unread: true, name: 'chris', icon: 'wolf', handleShort: 'chris@Zm9vYmFy…',
    reply: { text: 'it does: the particulate limit dropped and a visible-smoke fail is now automatic', at: at(5, 7), tokens: 90, signatureOk: true },
  },
  {
    id: 'm4', contact: DANA, direction: 'in',
    question: { text: 'which MOT rules changed in 2026?', sentAt: at(5, 8) },
    state: 'pending', unread: true, name: 'dana', icon: 'crane', handleShort: 'dana@YWJjZGVm…',
  },
  {
    id: 'm5', contact: DANA, direction: 'out',
    question: { text: 'can you send me the gym opening times over the bank holiday?', sentAt: at(4, 6), tokens: 40 },
    state: 'declined', unread: false, name: 'dana', icon: 'crane', handleShort: 'dana@YWJjZGVm…',
    reply: { text: 'refused', at: at(4, 6), tokens: 12, signatureOk: true, declined: { reason: 'not something I keep on this machine' } },
  },
  {
    id: 'm6', contact: REN, direction: 'in',
    question: { text: 'is the relay host still on the Helsinki box?', sentAt: at(5, 9) },
    state: 'answering', unread: false, name: 'ren', icon: 'owl', handleShort: 'ren@MDEyMzQ1…',
    reply: { text: 'yes, relay.origamilabs.nl, and it has been up since the 26th', at: at(5, 9), tokens: 44, signatureOk: true },
  },
  {
    id: 'm7', contact: REN, direction: 'out',
    question: { text: 'what did you settle on for the draft model in the end?', sentAt: at(5, 6), tokens: 55 },
    state: 'sent', unread: false, name: 'ren', icon: 'owl', handleShort: 'ren@MDEyMzQ1…',
  },
  {
    id: 'm8', contact: REN, direction: 'in',
    question: { text: 'can I have read access to the wiki pages folder?', sentAt: at(3, 8) },
    state: 'declined', unread: false, name: 'ren', icon: 'owl', handleShort: 'ren@MDEyMzQ1…',
    reply: { text: 'refused', at: at(3, 8), tokens: 9, signatureOk: true, declined: { reason: 'nothing is shared yet' } },
  },
];

// A single turn's time, distinct and increasing across 30 rows on one day —
// `at()` above only has room for a single digit hour, which 30 rows exceed.
const LONG_AT = (i: number) => `2026-09-05T${String(6 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}:00.000Z`;

/**
 * ONE THREAD, THIRTY TURNS — long enough to overflow the pane's own bounding
 * box if the scroll-container fix (`?long=1`, flock-messenger) regresses.
 * Alternating direction, all answered, so every turn draws a real bubble pair
 * rather than a lone question.
 */
function longThread(contact: string, name: string, icon: string, handleShort: string): MailRow[] {
  return Array.from({ length: 30 }, (_, i) => ({
    id: `long_${i}`,
    contact,
    direction: (i % 2 === 0 ? 'out' : 'in') as 'out' | 'in',
    question: { text: `Turn ${i + 1}: a question about item #${i + 1} in the parts list`, sentAt: LONG_AT(i), tokens: 40 },
    state: 'answered' as const,
    unread: false,
    name, icon, handleShort,
    reply: { text: `Turn ${i + 1} reply: here is what the record says about item #${i + 1}`, at: LONG_AT(i), tokens: 40, signatureOk: true },
  }));
}

// ------------------------------------------------------------ remote scene --
// FOUR STATES, because the Remote pane has four faces and only one of them was
// ever shot: a live code, a phone attached with no code, the whole feature off,
// and nothing paired at all. `?state=` picks one. The shapes are the wire's own
// (src/dashboard/remotePane.ts `RemotePayload`), not invented here.
const REMOTE_DEVICE = {
  name: 'Paired device',
  fp: 'aJV4sjwMiVDzvZJRotODEYfPYVXmV_wkLwwAR0YzV10',
  platform: 'ios',
  app: '0.1.0',
  backend: 'secure-enclave',
};

const REMOTE_BASE = {
  enabled: true,
  relayUrl: 'wss://relay.origamilabs.nl',
  connection: 'paired',
  rid: '4n5vm_BUq0Zx8h2',
  deviceName: '',
  device: REMOTE_DEVICE as typeof REMOTE_DEVICE | null,
  capability: 'full',
  modes: [] as unknown[],
  pairedAt: Date.now() - 7_200_000,
  lastSeen: Date.now() - 3_480_000,
  detail: 'remote: phone absent',
};

function remoteData(state: string): Record<string, unknown> {
  if (state === 'off') {
    return {
      ...REMOTE_BASE, enabled: false, connection: 'off', rid: null, device: null,
      pairedAt: null, lastSeen: null, detail: 'remote: off',
    };
  }
  if (state === 'nophone') {
    return {
      ...REMOTE_BASE, connection: 'unpaired', rid: null, device: null,
      pairedAt: null, lastSeen: null, detail: 'remote: on, no pairing',
    };
  }
  return { ...REMOTE_BASE };
}

/**
 * A pairing code that LOOKS like one, deterministically. The real SVG is built
 * host-side by src/remote/qr.ts, which the webview tsconfig forbids importing
 * (rootDir is pinned to `webview/`), so the harness draws a 25-module grid with
 * the three finder eyes instead: the pane's job is to size, centre and clock
 * whatever square the host hands it, and this is a square of the right shape.
 */
function fakeQrSvg(): string {
  const N = 25;
  let seed = 20260906;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const eye = (x: number, y: number): string =>
    `<rect x="${x}" y="${y}" width="7" height="7"/>` +
    `<rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="#fff"/>` +
    `<rect x="${x + 2}" y="${y + 2}" width="3" height="3"/>`;
  const inEye = (c: number, r: number): boolean =>
    (c < 8 && r < 8) || (c > N - 9 && r < 8) || (c < 8 && r > N - 9);
  let m = '';
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (inEye(c, r)) continue;
      if (rnd() < 0.48) m += `<rect x="${c}" y="${r}" width="1" height="1"/>`;
    }
  }
  m += eye(0, 0) + eye(N - 7, 0) + eye(0, N - 7);
  return (
    `<svg viewBox="0 0 ${N} ${N}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${N}" height="${N}" fill="#fff"/><g fill="#0e1411">${m}</g></svg>`
  );
}

// ------------------------------------------------------------ fixture host --
// A postMessage responder standing in for the extension host: a request type
// in gets the matching broadcast out, on the next microtask (never
// synchronously — the real host never replies inside the same call stack,
// and a component that only worked synchronously would be a bug this
// harness ought to catch, not paper over).
function installFixtureHost(scene: string, long: boolean, remoteState: string): void {
  // The messenger scene gets the bigger flock; every other scene keeps the
  // three-row fixture the tray and sidebar checks were written against.
  const messenger = scene === 'flock-messenger';
  const state = messenger ? MESSENGER_STATE : STATE;
  // `?long=1`: chris's three turns become thirty — the scroll-container /
  // pin-to-bottom proof. Dana's and ren's rows are untouched, so the rail and
  // "All mail" trays still show three contacts, not one.
  const threads = messenger
    ? long
      ? [...MESSENGER_THREADS.filter((row) => row.contact !== CHRIS), ...longThread(CHRIS, 'chris', 'wolf', 'chris@Zm9vYmFy…')]
      : MESSENGER_THREADS
    : THREADS;
  const respond = (msg: Record<string, unknown>) => queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: msg })));
  (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage(msg: Record<string, unknown>) {
      switch (msg['type']) {
        case 'flockRequest': return respond({ type: 'flockData', error: '', state });
        case 'flockMailboxRequest': return respond({ type: 'flockMailbox', threads });
        case 'flockScopeOptions':
          return respond({
            type: 'flockScopeOptions',
            repos: [{ root: 'C:/Repos/work/api', name: 'work/api' }, { root: 'C:/Repos/Projects/learning-apps', name: 'Learning apps' }],
            wiki: ['wiki/pages', 'wiki/drafts'],
          });
        case 'requestModels': return respond({ type: 'modelOptions', options: [] });
        case 'requestProviderStatus': return respond({ type: 'providerStatus', providers: [] });
        case 'remoteRequest': return respond({ type: 'remoteData', ...remoteData(remoteState) });
        // Pressing the button in a screenshot run mints the same code the
        // `live` state boots with, so the shot and the click agree.
        case 'remotePair':
          respond({ type: 'remoteQr', svg: fakeQrSvg(), expiresAt: Date.now() + 52_000 });
          return respond({ type: 'remoteData', ...remoteData(remoteState) });
        default: return;
      }
    },
    getState: () => ({}),
    setState: () => {},
  });
}

// -------------------------------------------------------------- overlap --
// Every element's right edge inside its own PARENT tile grid, and no two
// siblings sharing a parent overlapping — the exact claim the brief asks a
// script to prove, not a screenshot alone.
interface Finding { ok: boolean; detail: string }

function checkContainment(tiles: Element[], parent: Element): Finding[] {
  const pr = parent.getBoundingClientRect();
  const EPS = 1; // sub-pixel rounding, not a real overflow
  return tiles.map((el) => {
    const r = el.getBoundingClientRect();
    const ok = r.right <= pr.right + EPS && r.left >= pr.left - EPS;
    return { ok, detail: `${describe(el)} right=${r.right.toFixed(1)} vs parent right=${pr.right.toFixed(1)}` };
  });
}

function checkNoOverlap(tiles: Element[]): Finding[] {
  const rects = tiles.map((el) => ({ el, r: el.getBoundingClientRect() }));
  const out: Finding[] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!.r;
      const b = rects[j]!.r;
      const EPS = 1;
      const overlaps = !(a.right <= b.left + EPS || a.left >= b.right - EPS || a.bottom <= b.top + EPS || a.top >= b.bottom - EPS);
      if (overlaps) out.push({ ok: false, detail: `${describe(rects[i]!.el)} overlaps ${describe(rects[j]!.el)}` });
    }
  }
  return out;
}

/** Every descendant of EVERY tile stays inside that tile's own box — the
 *  actual owner-reported fault (the Invite header's buttons spilling into
 *  the neighbouring tile), which column-count alone does not catch: a CSS
 *  grid track never overflows its container, but a flex row inside a track
 *  that does not wrap paints past its own cell into the one beside it. */
function checkChildrenWithinTile(tiles: Element[]): Finding[] {
  const out: Finding[] = [];
  const EPS = 1;
  for (const tile of tiles) {
    const tr = tile.getBoundingClientRect();
    for (const child of Array.from(tile.querySelectorAll('*'))) {
      const r = child.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // display:none / <use> / empty
      if (r.right > tr.right + EPS) {
        out.push({ ok: false, detail: `${describe(child)} right=${r.right.toFixed(1)} spills past its tile ${describe(tile)} right=${tr.right.toFixed(1)}` });
      }
    }
  }
  return out;
}

/**
 * DEFECT 2 PROOF — the thread list pins to its own bottom, and the composer
 * stays inside the pane's box, rather than the whole pane running past it.
 * A no-op (empty findings) unless a single contact's thread is actually open:
 * FlockAllMail.svelte shares `.thread`/`.thread-body` but has no `.composer`,
 * which is what tells the two apart without a scene-specific special case.
 */
function checkThreadPinned(): Finding[] {
  const composer = document.querySelector('.thread .composer');
  if (!composer) return [];
  const list = document.querySelector('.thread .thread-body') as HTMLElement | null;
  const pane = composer.closest('.thread');
  if (!list || !pane) return [{ ok: false, detail: 'a .composer exists with no .thread-body/.thread around it' }];
  const pinned = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
  const cr = composer.getBoundingClientRect();
  const pr = pane.getBoundingClientRect();
  return [
    { ok: pinned, detail: `thread-body scrollTop(${list.scrollTop})+clientHeight(${list.clientHeight}) vs scrollHeight(${list.scrollHeight})` },
    { ok: cr.bottom <= pr.bottom + 1, detail: `composer bottom=${cr.bottom.toFixed(1)} vs pane bottom=${pr.bottom.toFixed(1)}` },
  ];
}

function describe(el: Element): string {
  const cls = Array.from(el.classList).filter((c) => !c.startsWith('svelte-')).join('.');
  return `<${el.tagName.toLowerCase()}.${cls}>`;
}

/**
 * DEAD SPACE — no card may leave more than 15% of its own height empty below
 * its last visible child.
 *
 * The owner rejected two rounds of Remote mockups for exactly this fault, and
 * the accepted mockup carries the check in its own footer; this is that script
 * ported, so the built pane is held to the number the drawing was held to. It
 * is a FLOOR, not a proof: it cannot see a gap BETWEEN two children, only the
 * one under the last of them.
 */
function checkCardTails(cards: Element[]): Finding[] {
  return cards.map((el) => {
    const name = el.getAttribute('data-name') ?? describe(el);
    const kids = Array.from(el.children).filter((c) => c.getClientRects().length > 0);
    const r = el.getBoundingClientRect();
    if (kids.length === 0 || r.height <= 0) return { ok: true, detail: `${name} has no laid-out child` };
    const padBottom = parseFloat(getComputedStyle(el).paddingBottom) || 0;
    const gap = r.bottom - padBottom - kids[kids.length - 1]!.getBoundingClientRect().bottom;
    const pct = Math.round((gap / r.height) * 100);
    return { ok: pct <= 15, detail: `${name} tail=${pct}% of h${Math.round(r.height)}` };
  });
}

/** Runs after mount + a settle tick; writes text AND a machine-readable global. */
async function runChecks(scene: string, sceneState = ''): Promise<void> {
  await tick();
  // A fixed settle delay, not just microtask ordering: the fixture host
  // replies over queueMicrotask and Svelte 5 batches its own re-render, and a
  // one-off screenshot run can afford to wait rather than race that chain.
  // setTimeout ONLY — no requestAnimationFrame: layout (getBoundingClientRect)
  // is computed synchronously on demand regardless of a painted frame, and a
  // driver running Chrome under --virtual-time-budget fast-forwards timers
  // but never fires rAF (no real compositor frame happens), which hung this
  // exact check the first time it was written.
  await new Promise((r) => setTimeout(r, 150));

  let tiles: Element[] = [];
  /** The boxes the spill check walks, when they are not the same as `tiles`. */
  let cards: Element[] = [];
  let parent: Element | null = null;
  if (scene === 'flock-messenger') {
    // THE THREE COLUMNS, not every card: the chips live INSIDE the right rail,
    // so a flat "no two of these overlap" over all of them would report the
    // rail overlapping its own contents and never fail for a real defect.
    parent = document.querySelector('.grid');
    tiles = Array.from(document.querySelectorAll('.grid > .rail, .grid > .thread, .grid > .side'));
    // The spill check still runs over every CARD, which is where the fault the
    // harness exists for actually shows: a head row that does not wrap paints
    // past its own cell into the column beside it.
    cards = Array.from(document.querySelectorAll('.rail, .thread, .side .fk-tile, .side [data-chip]'));
  } else if (scene === 'flock') {
    parent = document.querySelector('.tiles');
    tiles = Array.from(document.querySelectorAll('.fk-tile'));
  } else if (scene === 'remote') {
    parent = document.querySelector('.remote-pane');
    tiles = Array.from(document.querySelectorAll('.remote-pane .card, .remote-pane .hero'));
  } else {
    parent = document.querySelector('.fd-body');
    tiles = Array.from(document.querySelectorAll('.fd-row'));
  }

  const findings: Finding[] = [
    ...(parent
      ? [
          ...checkContainment(tiles, parent),
          ...checkNoOverlap(tiles),
          ...checkChildrenWithinTile(cards.length > 0 ? cards : tiles),
        ]
      : []),
    ...(scene === 'remote' ? checkCardTails(tiles) : []),
    ...checkThreadPinned(),
  ];
  const bad = findings.filter((f) => !f.ok);
  const lines = [
    `SCENE=${scene}${sceneState ? `/${sceneState}` : ''} WIDTH=${window.innerWidth} TILES=${tiles.length}`,
    bad.length === 0 ? 'RESULT=PASS' : `RESULT=FAIL (${bad.length} finding(s))`,
    ...bad.map((f) => `  - ${f.detail}`),
  ];
  const out = lines.join('\n');
  const pre = document.getElementById('check-output');
  if (pre) pre.textContent = out;
  (window as unknown as { __CHECK__: unknown }).__CHECK__ = { scene, width: window.innerWidth, pass: bad.length === 0, findings };
  document.title = `${bad.length === 0 ? 'PASS' : 'FAIL'} — ${document.title}`;
}

// A file:// page loaded via a plain headless navigation has no DevTools
// attached, so a thrown error is otherwise invisible outside the page
// itself — caught here and written into the SAME element the checks use, so
// a crash reads as a FAIL in the dump/screenshot instead of a silent hang.
function reportCrash(err: unknown): void {
  const pre = document.getElementById('check-output');
  const text = `RESULT=FAIL (harness crashed)\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
  if (pre) pre.textContent = text;
  document.title = `FAIL — ${document.title}`;
}
window.addEventListener('error', (e) => reportCrash(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => reportCrash(e.reason));

// ------------------------------------------------------------------- boot --
try {
  const params = new URLSearchParams(location.search);
  const scene = params.get('scene') ?? 'flock';
  const long = params.get('long') === '1';
  // `?state=` — the Remote pane's four faces. Anything else means the default.
  const state = params.get('state') ?? '';
  installFixtureHost(scene, long, state);
  let target = document.getElementById('app')!;

  // ?rail=N proves the actual point of this task: a sibling panel (Copilot-
  // style rail, the board's own nav) can leave the pane narrower than the
  // BROWSER window even though nothing here uses an iframe. A `@media` query
  // reads window.innerWidth and would miss this; `@container` reads the
  // pane's own box and cannot.
  const rail = Number(params.get('rail') ?? '0');
  if (rail > 0) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; height:100%; width:100%;';
    const filler = document.createElement('div');
    filler.style.cssText = `flex: 0 0 ${rail}px; background: #222;`;
    const paneHost = document.createElement('div');
    paneHost.style.cssText = 'flex: 1; min-width: 0; display:flex; flex-direction:column;';
    row.append(filler, paneHost);
    target.replaceWith(row);
    target = paneHost;
    target.id = 'app';
  }

  if (scene === 'flock' || scene === 'flock-messenger') {
    const fit = long || params.get('tall') === '1' ? ' fit-viewport' : '';
    target.className = scene === 'flock' ? 'stage-flock' : `stage-flock-messenger${fit}`;
    mount(FlockPane, { target });
  } else if (scene === 'remote') {
    target.className = 'stage-remote';
    mount(RemotePane, { target });
    // A LIVE CODE is not part of the `remoteData` snapshot — it arrives as its
    // own `remoteQr` message when the button is pressed. The shot needs the
    // state a press leaves behind, so the harness sends that message itself.
    if (state === 'live') {
      queueMicrotask(() =>
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'remoteQr', svg: fakeQrSvg(), expiresAt: Date.now() + 52_000 },
          }),
        ),
      );
    }
  } else {
    target.className = 'stage-sidebar';
    mount(FrontDeskSection, { target });
  }

  // `?pick=<name>` selects a CONTACT rail row before the checks run, so the
  // thread itself can be shot rather than only the "All mail" trays the pane
  // opens on while a question waits.
  //
  // `?chip=<id>` opens a right-rail chip and `?edit=1` opens the selected
  // contact's Edit popover. Both are behind a click, and a screenshot of a shut
  // chip proves nothing about the columns inside it.
  const pick = params.get('pick');
  if (pick && (scene === 'flock' || scene === 'flock-messenger')) {
    setTimeout(() => {
      const row = Array.from(document.querySelectorAll('.rail .crow')).find(
        (el) => el.querySelector('.fk-name')?.textContent === pick,
      ) as HTMLButtonElement | undefined;
      row?.click();
      if (params.get('edit') === '1') {
        setTimeout(() => {
          const head = document.querySelector('.thread-head');
          const edit = Array.from(head?.querySelectorAll('.fk-btn') ?? []).find((b) => b.textContent?.trim() === 'Edit');
          (edit as HTMLButtonElement | undefined)?.click();
        }, 40);
      }
    }, 60);
  }
  const chip = params.get('chip');
  if (chip) {
    setTimeout(() => {
      const fold = document.querySelector(`[data-chip="${chip}"]`);
      if (fold && !fold.classList.contains('open')) (fold.querySelector('.fold-open') as HTMLButtonElement)?.click();
    }, 60);
  }

  if (scene === 'sidebar') {
    // Sidebar starts collapsed; the harness needs it open to prove anything.
    queueMicrotask(() => {
      const toggle = document.querySelector('.fd-toggle') as HTMLButtonElement | null;
      toggle?.click();
      runChecks(scene, state).catch(reportCrash);
    });
  } else {
    runChecks(scene, state).catch(reportCrash);
  }
} catch (err) {
  reportCrash(err);
}
