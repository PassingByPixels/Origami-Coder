// flockPane.test.ts — the Flock rail view, both halves.
//
// Host side (src/dashboard/flockPane.ts): each pane message becomes the right
// ACP call with the right params, and a `null` survives the trip — clearing a
// per-friend budget and not touching it are different intentions, and the one
// that gets dropped is the one that makes a cap impossible to remove.
//
// Webview side (panes/FlockPane.svelte + its leaves): rendered from a fixture
// with an identity, two friends — one of them carrying the owner's own display
// name — and one waiting question, asserting what each control POSTS.
//
// SINCE THE MESSENGER WAVE the pane is a contacts rail, one thread and a right
// rail of chips, so the locators changed even where the behaviour did not: a
// contact is a `.crow` in the rail, its Edit/Revoke live in the thread head,
// and Identity/Invite/Permissions are `[data-chip]` folds. jsdom has no layout
// engine, so nothing here reads a computed style: the grid's own geometry is
// proven by the headless-Chrome shots, not here.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';

const { fake } = vi.hoisted(() => ({
  fake: {
    errors: [] as string[], infos: [] as string[],
    settings: {} as Record<string, unknown>, updateThrows: false,
  },
}));

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: (m: string) => void fake.errors.push(m),
    showInformationMessage: (m: string) => void fake.infos.push(m),
    state: { focused: true }, // focused = notifyFlockMailbox's toast stays a no-op here; see notifyEvents.test.ts for the gate itself
  },
  workspace: {
    getConfiguration: () => ({
      get: <T,>(k: string, d: T) => (k in fake.settings ? (fake.settings[k] as T) : d),
      update: (k: string, v: unknown) => {
        if (fake.updateThrows) throw new Error('settings file is read-only');
        fake.settings[k] = v;
        return Promise.resolve();
      },
    }),
  },
  ConfigurationTarget: { Global: 1 },
}));

import { FLOCK_PANE_MESSAGE_TYPES, handleFlockPaneMessage } from '../../../src/dashboard/flockPane';
import { resetHolderPidForTest } from '../../../src/dashboard/flockRoute';
import FlockPane from '../panes/FlockPane.svelte';

// A 43-character base64url fingerprint, as `FlockIdentity.fingerprint` now
// produces. The pane never truncates it itself — the engine sends both forms.
const ROBIN = 'robin@Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG0';
const DANA = 'dana@YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5MDE';
const JANE = 'jane@QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5';

const STATE = {
  transport: 'relay' as const,
  identity: {
    handle: JANE,
    handleShort: 'jane@QUJDREVG',
    name: 'jane',
    icon: 'fox',
    fingerprint: JANE.split('@')[1],
    signPublicKey: 'sign-pub',
    boxPublicKey: 'box-pub',
  },
  friends: [
    {
      handle: ROBIN,
      handleShort: 'robin@Zm9vYmFy',
      name: 'robin',
      icon: 'wolf',
      addedAt: '2026-08-30T11:00:00.000Z',
      policy: { autoAnswer: true },
      spentToday: 1200,
      budget: 5000,
      effective: { model: 'anthropic/claude-sonnet', autoAnswer: true },
    },
    {
      handle: DANA,
      handleShort: 'dana@YWJjZGVm',
      name: 'dana',
      // The owner's own label, so every row assertion has to keep both names
      // apart: three friends called "dana" is the reason this field exists.
      displayName: 'Dana from the gym',
      addedAt: '2026-09-01T09:30:00.000Z',
      policy: {},
      spentToday: 0,
      effective: { model: 'anthropic/claude-sonnet', autoAnswer: false },
    },
  ],
  frontDesk: { model: 'anthropic/claude-sonnet', dailyBudgetTokens: 5000, scope: { repos: ['work/api'] }, autoAnswer: false },
  frontDeskPath: 'C:\\Users\\dev\\.config\\origami\\origami.json',
  specialties: ['WordPress', 'UK tax rules'],
  availability: 'answers on approval, up to 5000 tokens/day',
  answers: [
    { at: '2026-09-02T08:15:00.000Z', from: ROBIN, question: 'how do I read a payslip?', tokens: 830, ok: true },
    { at: '2026-09-02T09:02:00.000Z', from: DANA, question: 'budget question', tokens: 0, ok: false },
  ],
};

/** One inbound question waiting on a decision — the row the Mail tile leads with. */
const QUESTION = {
  id: 'thr_in_1',
  contact: DANA,
  direction: 'in',
  question: { text: 'which tax rules changed in 2026?', sentAt: '2026-09-05T08:00:00.000Z' },
  state: 'pending',
  unread: true,
  name: 'dana',
  icon: 'crane',
  handleShort: 'dana@YWJjZGVm…',
};

/** One reply of theirs, unread: the other kind of row, with four other doors. */
const REPLY = {
  id: 'thr_out_1',
  contact: ROBIN,
  direction: 'out',
  question: { text: 'what does the tax form cover?', sentAt: '2026-09-05T07:00:00.000Z', tokens: 120 },
  state: 'answered',
  reply: { text: 'section 4 covers it', at: '2026-09-05T07:05:00.000Z', tokens: 120, signatureOk: true },
  unread: true,
  name: 'robin',
  icon: 'crane',
  handleShort: 'robin@MDEyMzQ1…',
};

// ----------------------------------------------------------------- host --

interface Call {
  method: string;
  params: Record<string, unknown>;
}

/** The engine connection serving ONE chat. A delivery goes to it rather than to
 *  whichever engine the pane happened to read, so the two are separate fakes. */
function chatClient(calls: Call[]) {
  return {
    extMethod: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params: params ?? {} });
      return { ok: true } as Record<string, unknown>;
    },
  };
}

function fakeHost(results: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const posts: Array<Record<string, unknown>> = [];
  return {
    calls,
    posts,
    host: {
      post: (m: Record<string, unknown>) => void posts.push(m),
      client: {
        extMethod: async (method: string, params?: Record<string, unknown>) => {
          calls.push({ method, params: params ?? {} });
          if (method === 'flock_state') return { ...STATE } as unknown as Record<string, unknown>;
          if (method === 'flock_mailbox') return { threads: [QUESTION] } as unknown as Record<string, unknown>;
          return (results[method] as Record<string, unknown>) ?? { ok: true };
        },
      },
    },
  };
}

const methodsOf = (calls: Call[]) => calls.map((c) => c.method);

beforeEach(() => {
  fake.errors.length = 0;
  fake.infos.length = 0;
  fake.settings = {};
  fake.updateThrows = false;
  resetHolderPidForTest(); // the holder-pid cache is a module singleton across every test in this file
});
afterEach(() => cleanup());

describe('flockPane host — the message table', () => {
  it('names every message the pane and the sidebar send, the scope leaf\'s included', () => {
    expect([...FLOCK_PANE_MESSAGE_TYPES].sort()).toEqual([
      'flockAccept',
      'flockBrowseFolder',
      // The MAIL MANAGER's seven, owned by flockMailbox.ts. `flockAnswer` and
      // `flockPendingRequest` are gone with the permission queue they served:
      // an inbound question is a thread now, and the sidebar's badge reads the
      // same mailbox the pane does rather than a queue of its own.
      'flockDecide',
      'flockDeliver',
      'flockFollowUp',
      'flockFrontDesk',
      'flockInvite',
      'flockMailboxRequest',
      'flockMark',
      'flockOpenChat',
      'flockRequest',
      'flockRevoke',
      'flockScopeOptions',
      'flockSend',
      // The master switch — origamicoder.flock.enabled, written Global.
      'flockSetEnabled',
      // The owner's own display name and sigil. One message for the pair,
      // because the tile has one Save on it.
      'flockSetIdentity',
      'flockSetPolicy',
      'flockSetSpecialties',
    ]);
  });

  it('the mailbox-only read asks the engine for the mailbox and NOTHING else', async () => {
    const { host, calls, posts } = fakeHost();
    await handleFlockPaneMessage(host, { type: 'flockMailboxRequest' });
    // A badge refreshed every thirty seconds must not drag a whole `flock_state`
    // read behind it — the rule the retired `flock_pending` poll established.
    expect(methodsOf(calls)).toEqual(['flock_mailbox']);
    expect(posts.map((p) => p['type'])).toEqual(['flockMailbox', 'flockSessions']);
  });

  it('a refresh reads BOTH the state and the mailbox, and posts the switch state too', async () => {
    const { host, calls, posts } = fakeHost();
    await handleFlockPaneMessage(host, { type: 'flockRequest' });

    expect(methodsOf(calls)).toEqual(['flock_state', 'flock_mailbox']);
    // The trailing `flockEnabled` is how a pane mounting late learns the
    // switch state without a second read of the window global.
    expect(posts.map((p) => p['type'])).toEqual(['flockData', 'flockMailbox', 'flockEnabled']);
    expect((posts[0] as { state: unknown }).state).toMatchObject({ identity: { handle: JANE } });
    expect(posts.at(-1)).toEqual({ type: 'flockEnabled', enabled: false });
  });

  it('flockSetEnabled writes Global and posts flockEnabled back to every view', async () => {
    const { host, posts } = fakeHost();
    await handleFlockPaneMessage(host, { type: 'flockSetEnabled', enabled: false });
    expect(fake.settings['enabled']).toBe(false);
    expect(posts).toEqual([{ type: 'flockEnabled', enabled: false }]);
  });

  it('a throwing update posts the READ-BACK value with an error, not the value it failed to write', async () => {
    fake.updateThrows = true;
    const { host, posts } = fakeHost();
    await handleFlockPaneMessage(host, { type: 'flockSetEnabled', enabled: true });
    // Nothing was written, so flockEnabled() still reads the default (false) —
    // not `true`, which would tell the owner the write had gone through.
    expect(posts).toEqual([{ type: 'flockEnabled', enabled: false, error: 'settings file is read-only' }]);
  });

  // ONE ENGINE PER CHAT: the lease can name a pid that is a SIBLING chat in
  // THIS window, not another window at all. These prove the reroute-and-relabel
  // and the write-routing that fixes both the false banner and the silent
  // decide/send no-op.
  it('OURS — the holder pid is a sibling chat here: state is re-read through it and shown as `relay`', async () => {
    const activeCalls: Call[] = [];
    const holderCalls: Call[] = [];
    const posts: Array<Record<string, unknown>> = [];
    const holderClient = {
      extMethod: async (method: string, params?: Record<string, unknown>) => {
        holderCalls.push({ method, params: params ?? {} });
        if (method === 'flock_state') return { ...STATE, transport: 'other-engine', holder: { pid: 555, httpBase: 'http://127.0.0.1:1' } };
        return { threads: [] };
      },
    };
    const host = {
      post: (m: Record<string, unknown>) => void posts.push(m),
      client: {
        extMethod: async (method: string, params?: Record<string, unknown>) => {
          activeCalls.push({ method, params: params ?? {} });
          if (method === 'flock_state') return { ...STATE, transport: 'other-engine', holder: { pid: 555, httpBase: 'http://127.0.0.1:1' } };
          return { threads: [] };
        },
      },
      sessions: () => [{ id: 'local-1', label: 'chat 1', pid: 555 }],
      chat: (localId: string) => (localId === 'local-1' ? { client: holderClient, pid: 555 } : undefined),
    };
    await handleFlockPaneMessage(host, { type: 'flockRequest' });

    // The active client's own read learned who holds it; the SECOND read for
    // the page content, AND the mailbox read that follows it (same cached
    // pid), both went to that sibling chat's engine rather than a repeat call
    // on the active one.
    expect(methodsOf(activeCalls)).toEqual(['flock_state']);
    expect(methodsOf(holderCalls)).toEqual(['flock_state', 'flock_mailbox']);
    const data = posts.find((p) => p['type'] === 'flockData') as { state: { transport: string } };
    // The banner must not show: the pane's own condition is `transport === 'other-engine'`.
    expect(data.state.transport).toBe('relay');
  });

  // t-vbj03h: the window's HOST engine (no chat, so not in sessions()) held the
  // lease on the owner's machine. It must count as ours, for reads and writes.
  it('OURS — the holder is the window\'s host engine: read through it, shown as `relay`, and writes go there', async () => {
    const hostCalls: Call[] = [];
    const posts: Array<Record<string, unknown>> = [];
    const hostClient = {
      extMethod: async (method: string, params?: Record<string, unknown>) => {
        hostCalls.push({ method, params: params ?? {} });
        if (method === 'flock_state') return { ...STATE, transport: 'relay', holder: { pid: 35304, httpBase: 'http://127.0.0.1:4096' } };
        return method === 'flock_mailbox' ? { threads: [] } : { ok: true };
      },
    };
    const chatClient = {
      extMethod: async (method: string) =>
        method === 'flock_state' ? { ...STATE, transport: 'other-engine', holder: { pid: 35304, httpBase: 'http://127.0.0.1:4096' } } : { threads: [] },
    };
    const host = {
      post: (m: Record<string, unknown>) => void posts.push(m),
      client: chatClient,
      sessions: () => [{ id: 'local-1', label: 'chat 1', pid: 54788 }],
      chat: () => ({ client: chatClient, pid: 54788 }),
      hostEngine: () => ({ client: hostClient, pid: 35304 }),
    };
    await handleFlockPaneMessage(host, { type: 'flockRequest' });
    expect((posts.find((p) => p['type'] === 'flockData') as { state: { transport: string } }).state.transport).toBe('relay');
    await handleFlockPaneMessage(host, { type: 'flockRevoke', handle: ROBIN });
    expect(hostCalls.some((c) => c.method === 'flock_revoke')).toBe(true);
  });

  it('NOT OURS — the holder pid matches no session here: today\'s banner and behaviour are unchanged', async () => {
    const { host, calls, posts } = fakeHost({});
    host.client.extMethod = async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params: params ?? {} });
      // A LIVE pid that is none of ours (this test runner): a dead one is no other window (t-vbj03h).
      if (method === 'flock_state') return { ...STATE, transport: 'other-engine', holder: { pid: process.pid, httpBase: 'http://127.0.0.1:1' } };
      return { threads: [] };
    };
    await handleFlockPaneMessage(host, { type: 'flockRequest' });
    // No second engine to route to (no `sessions`/`chat` on this host at all):
    // exactly one flock_state call, and the banner's own condition still holds.
    expect(methodsOf(calls)).toEqual(['flock_state', 'flock_mailbox']);
    const data = posts.find((p) => p['type'] === 'flockData') as { state: { transport: string } };
    expect(data.state.transport).toBe('other-engine');
  });

  it('a WRITE routes to the cached holder\'s client when it is ours, not the active one', async () => {
    const activeCalls: Call[] = [];
    const holderCalls: Call[] = [];
    const holderClient = {
      extMethod: async (method: string, params?: Record<string, unknown>) => {
        holderCalls.push({ method, params: params ?? {} });
        if (method === 'flock_state') return { ...STATE, transport: 'relay' };
        if (method === 'flock_mailbox') return { threads: [] };
        return { ok: true };
      },
    };
    const host = {
      post: () => {},
      client: {
        extMethod: async (method: string, params?: Record<string, unknown>) => {
          activeCalls.push({ method, params: params ?? {} });
          if (method === 'flock_state') return { ...STATE, transport: 'other-engine', holder: { pid: 777, httpBase: 'http://127.0.0.1:1' } };
          return { threads: [] };
        },
      },
      sessions: () => [{ id: 'local-1', label: 'chat 1', pid: 777 }],
      chat: (localId: string) => (localId === 'local-1' ? { client: holderClient, pid: 777 } : undefined),
    };
    // Warm the cache — a mount always reads state before any button exists.
    await handleFlockPaneMessage(host, { type: 'flockRequest' });
    activeCalls.length = 0;
    holderCalls.length = 0;

    await handleFlockPaneMessage(host, { type: 'flockRevoke', handle: ROBIN });
    // The revoke itself went to the HOLDER's client...
    expect(holderCalls[0]).toEqual({ method: 'flock_revoke', params: { handle: ROBIN } });
    // ...and the active client was never asked to do it (only re-read after).
    expect(activeCalls.some((c) => c.method === 'flock_revoke')).toBe(false);
  });

  it('with no session it says so instead of rendering an empty flock as the truth', async () => {
    const posts: Array<Record<string, unknown>> = [];
    await handleFlockPaneMessage({ post: (m) => void posts.push(m) }, { type: 'flockRequest' });
    expect(posts[0]).toMatchObject({ type: 'flockData' });
    expect((posts[0] as { error: string }).error).toContain('Open a chat first');
  });

  it('a mailbox read that fails empties the mailbox and carries the reason', async () => {
    const posts: Array<Record<string, unknown>> = [];
    const host = {
      post: (m: Record<string, unknown>) => void posts.push(m),
      client: {
        extMethod: async (method: string) => {
          if (method === 'flock_mailbox') throw new Error('engine went away');
          return { ...STATE } as unknown as Record<string, unknown>;
        },
      },
    };
    await handleFlockPaneMessage(host, { type: 'flockRequest' });
    // A row whose buttons no longer work is worse than no row: the owner would
    // think they had answered somebody. The trailing `flockEnabled` (item 1 of
    // this switch) rides behind it regardless.
    expect(posts.at(-2)).toMatchObject({ type: 'flockMailbox', threads: [], error: 'engine went away' });
    expect(posts.at(-1)).toMatchObject({ type: 'flockEnabled' });
  });

  it('creating an invite posts the string AND its QR straight to the pane, then re-reads', async () => {
    const { host, calls, posts } = fakeHost({ flock_invite: { ok: true, invite: 'origami://flock/invite#v2.x.y.z.t.u' } });
    await handleFlockPaneMessage(host, { type: 'flockInvite' });

    expect(methodsOf(calls)).toEqual(['flock_invite', 'flock_state', 'flock_mailbox']);
    const made = posts.find((p) => p['type'] === 'flockInviteMade') as { invite: string; qr: string };
    expect(made.invite).toBe('origami://flock/invite#v2.x.y.z.t.u');
    expect(made.qr).toContain('<svg');
  });

  it('an invite too long to encode still arrives, with an EMPTY qr rather than a throw', async () => {
    // The encoder tops out at QR version 10. A long enough name pushes an
    // invite past it, and an invite you can still copy beats no invite at all.
    const huge = `origami://flock/invite#v2.${'x'.repeat(900)}`;
    const { host, posts } = fakeHost({ flock_invite: { ok: true, invite: huge } });
    await handleFlockPaneMessage(host, { type: 'flockInvite' });
    expect(posts.find((p) => p['type'] === 'flockInviteMade')).toMatchObject({ invite: huge, qr: '' });
  });

  it('accepting sends the trimmed invite; a blank one never reaches the engine', async () => {
    const { host, calls } = fakeHost();
    await handleFlockPaneMessage(host, { type: 'flockAccept', invite: '  origami://flock/invite#v2.a  ' });
    expect(calls[0]).toEqual({ method: 'flock_accept', params: { invite: 'origami://flock/invite#v2.a' } });

    const blank = fakeHost();
    await handleFlockPaneMessage(blank.host, { type: 'flockAccept', invite: '   ' });
    expect(blank.calls).toEqual([]);
    expect(fake.errors.at(-1)).toContain('Paste the invite');
  });

  it('MUTATION PROOF — revoke names the handle and the list is re-read from the engine after it', async () => {
    const { host, calls, posts } = fakeHost();
    await handleFlockPaneMessage(host, { type: 'flockRevoke', handle: ROBIN });

    // The FULL handle, never the label the row shows: a write addressed by the
    // short form would name nobody the engine holds.
    expect(calls[0]).toEqual({ method: 'flock_revoke', params: { handle: ROBIN } });
    // The re-read is the half that makes the row disappear. A revoke that only
    // called the engine would leave the removed friend on screen until the next
    // manual refresh, and the owner would believe they were still shared with.
    expect(methodsOf(calls)).toEqual(['flock_revoke', 'flock_state', 'flock_mailbox']);
    expect(posts.at(-2)).toMatchObject({ type: 'flockData' });
  });

  it("an engine refusal is shown in the engine's own words and the pane is still re-read", async () => {
    const { host, calls } = fakeHost({ flock_revoke: { ok: false, message: 'ghost@0000 is not in this flock' } });
    await handleFlockPaneMessage(host, { type: 'flockRevoke', handle: 'ghost@0000' });

    expect(fake.errors).toEqual(['ghost@0000 is not in this flock']);
    expect(methodsOf(calls)).toContain('flock_state');
  });

  it('a policy write carries only the fields the pane sent — and `null` survives', async () => {
    const { host, calls } = fakeHost();
    await handleFlockPaneMessage(host, {
      type: 'flockSetPolicy',
      handle: 'dana@5e6f7a8b',
      dailyBudgetTokens: null,
    });
    expect(calls[0]).toEqual({
      method: 'flock_set_policy',
      params: { handle: 'dana@5e6f7a8b', dailyBudgetTokens: null },
    });

    const second = fakeHost();
    await handleFlockPaneMessage(second.host, { type: 'flockSetPolicy', handle: 'dana@5e6f7a8b', autoAnswer: true });
    expect(second.calls[0]!.params).toEqual({ handle: 'dana@5e6f7a8b', autoAnswer: true });
  });

  it('the front-desk write passes model, budget, scope and the auto-answer default through', async () => {
    const { host, calls } = fakeHost();
    await handleFlockPaneMessage(host, {
      type: 'flockFrontDesk',
      model: 'anthropic/claude-sonnet',
      dailyBudgetTokens: 5000,
      scope: { repos: ['work/api'], wiki: [], skills: [] },
      autoAnswer: true,
    });
    expect(calls[0]).toEqual({
      method: 'flock_front_desk',
      params: {
        model: 'anthropic/claude-sonnet',
        dailyBudgetTokens: 5000,
        scope: { repos: ['work/api'], wiki: [], skills: [] },
        autoAnswer: true,
      },
    });
  });

  it('specialties are filtered to strings; a non-array never reaches the engine', async () => {
    const { host, calls } = fakeHost();
    await handleFlockPaneMessage(host, { type: 'flockSetSpecialties', specialties: ['WordPress', 7, 'tax'] });
    expect(calls[0]!.params).toEqual({ specialties: ['WordPress', 'tax'] });

    const bad = fakeHost();
    await handleFlockPaneMessage(bad.host, { type: 'flockSetSpecialties', specialties: 'WordPress' });
    expect(bad.calls).toEqual([]);
  });

  it('a decision names the thread and the action, and sends guidance only when there is some', async () => {
    const { host, calls } = fakeHost();
    await handleFlockPaneMessage(host, { type: 'flockDecide', thread: 'thr_in_1', action: 'answer' });
    // NOT `guidance: ''`. An empty box is "no guidance", and a blank guidance
    // block above a stranger's question is an instruction that says nothing.
    expect(calls[0]).toEqual({ method: 'flock_decide', params: { thread: 'thr_in_1', action: 'answer' } });
    expect(methodsOf(calls)).toContain('flock_mailbox');

    const steered = fakeHost();
    await handleFlockPaneMessage(steered.host, {
      type: 'flockDecide',
      thread: 'thr_in_1',
      action: 'decline',
      reason: '  not something I share  ',
    });
    expect(steered.calls[0]!.params).toEqual({ thread: 'thr_in_1', action: 'decline', reason: 'not something I share' });

    // An action the engine does not have is dropped here rather than sent.
    const bad = fakeHost();
    await handleFlockPaneMessage(bad.host, { type: 'flockDecide', thread: 'thr_in_1', action: 'always' });
    expect(bad.calls).toEqual([]);
  });

  it('sending passes the owner\'s edit when they made one, and nothing when they did not', async () => {
    const { host, calls } = fakeHost();
    await handleFlockPaneMessage(host, { type: 'flockSend', thread: 'thr_in_1' });
    expect(calls[0]).toEqual({ method: 'flock_send', params: { thread: 'thr_in_1' } });

    const edited = fakeHost();
    await handleFlockPaneMessage(edited.host, { type: 'flockSend', thread: 'thr_in_1', text: 'my words' });
    expect(edited.calls[0]!.params).toEqual({ thread: 'thr_in_1', text: 'my words' });
  });

  it('a follow-up posts the contact, the question and the thread it follows', async () => {
    const { host, calls } = fakeHost();
    await handleFlockPaneMessage(host, {
      type: 'flockFollowUp',
      to: ROBIN,
      question: 'and what about 2027?',
      thread: 'thr_out_1',
    });
    expect(calls[0]).toEqual({
      method: 'flock_post',
      params: { to: ROBIN, question: 'and what about 2027?', followUpOf: 'thr_out_1' },
    });
  });

  // THE ENGINE WRITES THE MESSAGE, and the call goes to the engine that owns
  // the CHAT. Neither door posts a `send`: a user turn worded as a sentence
  // about the row is what made a model believe the owner had said it.
  it('OPENING a reply in a new chat calls flock_deliver on that chat\'s own engine', async () => {
    const { host } = fakeHost();
    const chatCalls: Call[] = [];
    const opened: Array<string | undefined> = [];
    await handleFlockPaneMessage(
      {
        ...host,
        openChat: async (recall?: string) => { opened.push(recall); return 'session-4'; },
        chat: () => ({ client: chatClient(chatCalls), engineId: 'ses_engine_4' }),
      },
      { type: 'flockOpenChat', thread: 'thr_out_1' },
    );
    expect(opened).toEqual([undefined]);
    expect(chatCalls[0]).toEqual({
      method: 'flock_deliver',
      params: { thread: 'thr_out_1', sessionID: 'ses_engine_4' },
    });
    // No user turn anywhere on the path.
    expect(JSON.stringify(chatCalls)).not.toContain('send');
  });

  it('RECALLING the chat that asked reopens that engine session, then delivers into it', async () => {
    const { host } = fakeHost();
    const chatCalls: Call[] = [];
    const opened: Array<string | undefined> = [];
    await handleFlockPaneMessage(
      {
        ...host,
        openChat: async (recall?: string) => { opened.push(recall); return 'session-5'; },
        chat: () => ({ client: chatClient(chatCalls), engineId: 'ses_engine_7' }),
      },
      { type: 'flockOpenChat', thread: 'thr_out_1', recall: 'ses_engine_7' },
    );
    expect(opened).toEqual(['ses_engine_7']);
    expect(chatCalls[0]!.params).toEqual({ thread: 'thr_out_1', sessionID: 'ses_engine_7' });
  });

  it('a chat that never opened delivers NOTHING rather than claiming it was delivered', async () => {
    const { host, calls } = fakeHost();
    const chatCalls: Call[] = [];
    await handleFlockPaneMessage(
      { ...host, openChat: async () => undefined, chat: () => ({ client: chatClient(chatCalls), engineId: 'x' }) },
      { type: 'flockOpenChat', thread: 'thr_out_1' },
    );
    expect(chatCalls).toEqual([]);
    expect(methodsOf(calls)).toEqual(['flock_mailbox']);
  });

  it('DELIVERING to a running chat calls flock_deliver with that chat\'s ENGINE id', async () => {
    const { host } = fakeHost();
    const chatCalls: Call[] = [];
    const asked: string[] = [];
    await handleFlockPaneMessage(
      {
        ...host,
        chat: (localId: string) => { asked.push(localId); return { client: chatClient(chatCalls), engineId: 'ses_engine_3' }; },
      },
      { type: 'flockDeliver', thread: 'thr_out_1', sessionID: 'session-3' },
    );
    // The picker names a LOCAL id; the wire carries the ENGINE one.
    expect(asked).toEqual(['session-3']);
    expect(chatCalls[0]).toEqual({
      method: 'flock_deliver',
      params: { thread: 'thr_out_1', sessionID: 'ses_engine_3' },
    });
  });

  it('a chat with no live engine session yet is a message, not a silent no-op', async () => {
    const { host, calls } = fakeHost();
    await handleFlockPaneMessage({ ...host, chat: () => ({ engineId: undefined }) }, {
      type: 'flockDeliver',
      thread: 'thr_out_1',
      sessionID: 'session-3',
    });
    expect(fake.errors.join(' ')).toContain('no live engine session yet');
    expect(methodsOf(calls)).toEqual(['flock_mailbox']);
  });
});

// ------------------------------------------------------------ the wire --

// THE ONE THING NEITHER SIDE'S OWN TESTS CAN SEE: a method name that does not
// match. The host asserts it sends `flock_state`; the engine asserts its
// handler answers `flock_state`; a typo in either makes both suites green and
// the pane permanently empty, with an error that says only "Method not found".
// So this reads the ENGINE's dispatch and requires a case for every name the
// host sends — the same drift check mcpWireShape.test.ts makes between the
// host types and the pane.
describe('flock ACP wire — every method the host calls has an engine handler', () => {
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const engineAgent = nodePath.resolve(here, '..', '..', '..', '..', 'engine', 'src', 'acp', 'agent.ts');
  const hostPane = nodePath.resolve(here, '..', '..', '..', 'src', 'dashboard', 'flockPane.ts');

  it('is reading the two real files (guards the paths, not just the regexes)', () => {
    expect(existsSync(engineAgent), `${engineAgent} not found`).toBe(true);
    expect(existsSync(hostPane), `${hostPane} not found`).toBe(true);
  });

  it('the engine dispatches every flock_* method the host sends', () => {
    // Every `'flock_*'` literal in the host modules, not only the ones that sit
    // directly on an `extMethod(` call: most go through the shared `write()`
    // helper, and a regex that missed those would have checked a quarter of the
    // surface while reading as if it checked all of it.
    //
    // BOTH FILES. flockPane.ts alone left the whole MAILBOX half unguarded —
    // `flock_mailbox`, `flock_decide`, `flock_send`, `flock_mark`, `flock_post`
    // and now `flock_deliver` are all sent from flockMailbox.ts, and a typo in
    // any of them would have made both suites green and the button dead.
    const hostMail = nodePath.resolve(here, '..', '..', '..', 'src', 'dashboard', 'flockMailbox.ts');
    expect(existsSync(hostMail), `${hostMail} not found`).toBe(true);
    const sent = [hostPane, hostMail].flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/'(flock_[a-z_]+)'/g)].map((m) => m[1]),
    );
    const handled = new Set(
      [...readFileSync(engineAgent, 'utf8').matchAll(/case "(flock_[a-z_]+)":/g)].map((m) => m[1]),
    );
    expect(sent.length, 'flockPane.ts calls no flock_* method — the regex has drifted').toBeGreaterThan(5);
    const missing = [...new Set(sent)].filter((name) => !handled.has(name));
    expect(missing, `acp/agent.ts has no case for ${missing.join(', ')}`).toEqual([]);
  });

  // SHAPE, not just the name. A method that exists and a field it does not
  // read fail the SAME way: `flock_set_policy` takes what it is given, copies
  // the keys it knows into the friend's overrides and drops the rest without a
  // word, so a host that sent `budget` instead of `dailyBudgetTokens` would
  // post, succeed, re-read and show the old value — the shape of every Flock
  // defect found so far. The names test above passes that scenario.
  it('every FIELD flockPane.ts sends is declared on the engine request type', () => {
    const engineFlock = nodePath.resolve(here, '..', '..', '..', '..', 'engine', 'src', 'acp', 'flock.ts');
    expect(existsSync(engineFlock), `${engineFlock} not found`).toBe(true);
    const engine = readFileSync(engineFlock, 'utf8');
    const host = readFileSync(hostPane, 'utf8');

    /** `export type X = A & B & { readonly f?: T ... }` -> its own field names. */
    const own = (name: string): { fields: string[]; parents: string[] } => {
      const decl = new RegExp(`export type ${name} =([^=]*?)\\n(?=export |\\n)`, 's').exec(engine);
      expect(decl, `engine acp/flock.ts declares no ${name}`).not.toBeNull();
      const body = decl![1]!;
      const brace = body.indexOf('{');
      const head = brace < 0 ? body : body.slice(0, brace);
      return {
        parents: [...head.matchAll(/\b([A-Z]\w*Request)\b/g)].map((m) => m[1]!),
        fields: [...body.matchAll(/readonly\s+(\w+)\??\s*:/g)].map((m) => m[1]!),
      };
    };
    const fieldsOf = (name: string): Set<string> => {
      const { fields, parents } = own(name);
      const out = new Set(fields);
      for (const parent of parents) for (const f of fieldsOf(parent)) out.add(f);
      return out;
    };

    // The engine type each ext method takes, read off its `export function`
    // signature so a renamed type fails here rather than drifting quietly.
    const METHODS: ReadonlyArray<[string, string]> = [
      ['flock_invite', 'invite'],
      ['flock_accept', 'accept'],
      ['flock_revoke', 'revoke'],
      ['flock_set_identity', 'setIdentity'],
      ['flock_set_policy', 'setPolicy'],
      ['flock_front_desk', 'frontDesk'],
      ['flock_set_specialties', 'setSpecialties'],
      
    ];

    for (const [method, fn] of METHODS) {
      const sig = new RegExp(`(?:export function|export const) ${fn}\\b[^\\n]*?input:?\\s*(\\w+Request)`).exec(engine);
      expect(sig, `engine acp/flock.ts has no ${fn}(input: …Request)`).not.toBeNull();
      const declared = fieldsOf(sig![1]!);

      // ONLY the params argument: `write(host, '<method>', <params>, onOk?)`.
      // The optional fourth argument is a callback that posts to the WEBVIEW,
      // and swallowing it would read `type`/`invite`/`qr` as request fields.
      const at = host.indexOf(`'${method}'`);
      expect(at, `flockPane.ts never sends ${method}`).toBeGreaterThan(-1);
      const from = host.indexOf(',', at + method.length) + 1;
      let depth = 0;
      let end = from;
      for (let i = from; i < host.length; i++) {
        const ch = host[i]!;
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) { if (depth === 0) { end = i; break; } depth--; }
        else if (ch === ',' && depth === 0) { end = i; break; }
      }
      const call = host.slice(from, end);
      const sends = new Set<string>([
        // `picked(m, ['a', 'b'])` names its fields as string literals; only
        // THOSE, so a `typeof x === 'string'` guard is not read as a field.
        ...[...call.matchAll(/picked\(m,\s*\[([^\]]*)\]/g)].flatMap((m) =>
          [...m[1]!.matchAll(/'(\w+)'/g)].map((k) => k[1]!),
        ),
        ...[...call.matchAll(/(?:^|[{,])\s*(\w+)\s*[:,}]/gm)].map((m) => m[1]!),
      ]);
      sends.delete('m');
      sends.delete('picked');
      const strangers = [...sends].filter((f) => !declared.has(f));
      expect(strangers, `${method} sends ${strangers.join(', ')}, which ${sig![1]} does not declare`).toEqual([]);
      expect(sends.size, `${method}: the regex read no fields at all`).toBeGreaterThan(0);
    }
  });
});

// -------------------------------------------------------------- webview --

function send(msg: Record<string, unknown>): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data: msg }));
  return tick();
}

const SCOPE_OPTIONS = {
  type: 'flockScopeOptions',
  repos: [
    { root: 'C:/Repos/acme/site', name: 'site' },
    { root: 'C:/Repos/Projects/demo-app', name: 'demo-app' },
  ],
  wiki: ['wiki/pages', 'wiki/drafts'],
};

async function mount(state: unknown = STATE, threads: unknown[] = [QUESTION, REPLY]) {
  const rendered = render(FlockPane);
  await send({ type: 'flockData', state });
  await send({ type: 'flockMailbox', threads });
  await send(SCOPE_OPTIONS);
  // The three right-rail chips start SHUT over this fixture, because it has all
  // three things set — flockChips.test.ts owns that rule and proves it. Every
  // test below is about what a control POSTS, so they are opened once here
  // rather than three lines at a time in fifteen places.
  for (const id of ['identity', 'invite', 'permissions']) {
    const fold = rendered.container.querySelector(`[data-chip="${id}"]`);
    if (fold && !fold.classList.contains('open')) {
      await fireEvent.click(fold.querySelector('.fold-open')!);
      await tick();
    }
  }
  return rendered;
}

/** One right-rail chip, by the id FlockChip stamps on it. By id and not by its
 *  title because one of the three titles is the owner's own display name. */
function chip(container: HTMLElement, id: string): HTMLElement {
  const found = container.querySelector(`[data-chip="${id}"]`);
  if (!found) throw new Error(`no chip called ${id}`);
  return found as HTMLElement;
}

/** The rail's CONTACT rows. The first `.crow` is "All mail" and is not one. */
const railRows = (container: HTMLElement) => Array.from(container.querySelectorAll('.rail .crow')).slice(1);

/** Select a rail row by the name it leads with, and hand back the thread. */
async function openThread(container: HTMLElement, name: string): Promise<HTMLElement> {
  const row = railRows(container).find((el) => el.querySelector('.fk-name')!.textContent === name);
  if (!row) throw new Error(`no rail row for ${name}`);
  await fireEvent.click(row);
  await tick();
  return container.querySelector('.thread') as HTMLElement;
}

/** Select "All mail" — the three trays across everybody — and hand it back. */
async function openAllMail(container: HTMLElement): Promise<HTMLElement> {
  await fireEvent.click(container.querySelector('.rail .crow')!);
  await tick();
  return container.querySelector('.thread') as HTMLElement;
}

/** One tile by the small-caps title in its head row. */
function tile(container: HTMLElement, title: string): HTMLElement {
  const found = Array.from(container.querySelectorAll('.fk-tile')).find((el) =>
    el.querySelector(':scope > .fk-tile-head > .fk-caps')?.textContent?.startsWith(title),
  );
  if (!found) throw new Error(`no tile called ${title}`);
  return found as HTMLElement;
}

/**
 * Open ONE contact's Edit popover from their thread head, and hand it back.
 *
 * This replaced a fold at the bottom of the Permissions chip. The rail row has
 * to be selected first, which is the point of the redesign: what one contact
 * may see is decided where the owner is already reading that contact.
 */
async function editPopover(container: HTMLElement, name: string): Promise<HTMLElement> {
  await openThread(container, name);
  const head = container.querySelector('.thread-head') as HTMLElement;
  const edit = Array.from(head.querySelectorAll('.fk-btn')).find((b) => b.textContent!.trim() === 'Edit');
  await fireEvent.click(edit as HTMLButtonElement);
  await tick();
  const popover = container.querySelector('.thread-head .cs');
  if (!popover) throw new Error(`no Edit popover for ${name}`);
  return popover as HTMLElement;
}

/** One tick pill's checkbox inside an open Edit popover, by the label it
 *  draws (the `default` tag, if any, is a second span and not part of it). */
function pill(popover: HTMLElement, label: string): HTMLInputElement {
  const found = Array.from(popover.querySelectorAll('.fk-tick')).find(
    (el) => el.querySelector('span')?.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no pill called ${label}`);
  return found.querySelector('input') as HTMLInputElement;
}

/** The last thing the pane posted, so a click's WHOLE message can be asserted. */
function lastPost(): Record<string, unknown> {
  const calls = globalThis.__vscodeApiMock.postMessage.mock.calls;
  return calls[calls.length - 1]![0] as Record<string, unknown>;
}

describe('FlockPane (webview) — the messenger', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockClear();
  });

  it("asks for its state, the pickers' options AND the model catalog on mount", () => {
    render(FlockPane);
    const sent = globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type);
    // The catalog is a broadcast, not state: without pulling it the REQUIRED
    // front-desk model picker would open empty and be unsatisfiable. The scope
    // options are the same shape of problem for the three checklists.
    expect(sent).toEqual([
      'flockRequest',
      'flockScopeOptions',
      // The mailbox and the open chats move while nobody is editing anything,
      // so they are read beside the page rather than inside it.
      'flockMailboxRequest',
      'requestModels',
      'requestProviderStatus',
    ]);
  });

  it('renders the messenger: a contacts rail, one thread, and the right rail', async () => {
    const { container } = await mount();
    expect(container.querySelector('.rail')).not.toBeNull();
    expect(container.querySelector('.thread')).not.toBeNull();
    expect(container.querySelector('.side')).not.toBeNull();

    // "All mail" leads the rail, then one row per contact, newest thread first.
    // Without that first row, a question from a contact nobody has clicked is a
    // dot and nothing else, and "what waits on me" has no page at all.
    expect(Array.from(container.querySelectorAll('.rail .crow .fk-name')).map((el) => el.textContent)).toEqual([
      'All mail',
      'Dana from the gym',
      'robin',
    ]);

    // The right rail is the desk CARD - never folded, because a desk with no
    // model refuses every question - and then exactly three chips, in order.
    expect(container.querySelector('.side .fk-tile > .fk-tile-head > .fk-caps')!.textContent).toBe('Front desk');
    expect(Array.from(container.querySelectorAll('.side [data-chip]')).map((el) => el.getAttribute('data-chip')))
      .toEqual(['identity', 'invite', 'permissions']);
  });

  it('the rail picks the thread, and the thread is that contact and no other', async () => {
    const { container } = await mount();
    // Something waits, so the pane opens on All mail rather than on one contact.
    expect(container.querySelector('.rail .crow')!.classList.contains('sel')).toBe(true);
    expect(container.querySelector('.thread')!.textContent).toContain('All mail');

    const robin = await openThread(container, 'robin');
    expect(robin.querySelector('.thread-head .fk-name')!.textContent).toBe('robin');
    // ONE contact's mail, not everybody's: dana's question is not in here.
    expect(robin.textContent).toContain('what does the tax form cover?');
    expect(robin.textContent).not.toContain('which tax rules changed in 2026?');
    // And the rail says which row is showing.
    expect(railRows(container)[1]!.classList.contains('sel')).toBe(true);
    expect(railRows(container)[0]!.classList.contains('sel')).toBe(false);
  });

  it('the thread reads oldest-first, under a day divider, with the state chip and the time', async () => {
    const { container } = await mount();
    const robin = await openThread(container, 'robin');
    expect(Array.from(robin.querySelectorAll('.day')).map((el) => el.textContent)).toEqual(['2026-09-05']);
    // The owner asked, they answered: two bubbles, the owner's in the accent.
    const bubbles = Array.from(robin.querySelectorAll('.mk-bubble'));
    expect(bubbles[0]!.textContent!.trim()).toBe('what does the tax form cover?');
    expect(bubbles[0]!.classList.contains('mine')).toBe(true);
    expect(bubbles[1]!.textContent!.trim()).toBe('section 4 covers it');
    expect(bubbles[1]!.classList.contains('mine')).toBe(false);
    // The state chip is prose, not a state id, and the time sits beside it.
    expect(robin.querySelector('.foot .fk-chip')!.textContent).toBe('they answered');
    expect(robin.querySelector('.foot .fk-meta')!.textContent).toMatch(/^\d{2}:\d{2}$/);
  });

  // jsdom has no layout engine, so `scrollHeight`/`clientHeight` are stubbed
  // rather than produced by real content — this proves the WIRING (the scroll
  // listener toggles the affordance; the button re-pins), not the geometry
  // itself. The geometry is proven in Chromium by the screenshot harness.
  it('scrolled up from the bottom shows "jump to newest"; clicking it re-pins', async () => {
    const { container } = await mount();
    const robin = await openThread(container, 'robin');
    const body = robin.querySelector('.thread-body') as HTMLElement;
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 400 });

    // At the bottom already (the mount-time pin): no affordance.
    body.scrollTop = 600;
    await fireEvent.scroll(body);
    await tick();
    expect(container.querySelector('.jump-bottom')).toBeNull();

    // Scrolled up past the ~40px slack: the affordance appears.
    body.scrollTop = 0;
    await fireEvent.scroll(body);
    await tick();
    const jump = container.querySelector('.jump-bottom') as HTMLButtonElement;
    expect(jump).not.toBeNull();

    await fireEvent.click(jump);
    await tick();
    expect(body.scrollTop).toBe(1000); // re-pinned to the (stubbed) bottom
    expect(container.querySelector('.jump-bottom')).toBeNull();
  });

  it('the composer posts flock_post to the SELECTED contact, and clears itself', async () => {
    const { container } = await mount();
    const robin = await openThread(container, 'robin');
    const box = robin.querySelector('textarea[aria-label="Ask robin"]') as HTMLTextAreaElement;
    const ask = () =>
      Array.from(container.querySelectorAll('.composer .fk-btn')).find(
        (b) => b.textContent!.trim() === 'Ask',
      ) as HTMLButtonElement;

    // Nothing typed is nothing to send: a question with no words is a question
    // the contact's model would be asked to answer.
    expect(ask().disabled).toBe(true);

    await fireEvent.input(box, { target: { value: '  and what about 2027?  ' } });
    await tick();
    await fireEvent.click(ask());
    // The SAME message Follow up posts (ACP `flock_post`), minus the thread it
    // follows - asking and following up are one act with one wire.
    expect(lastPost()).toEqual({ type: 'flockFollowUp', to: ROBIN, question: 'and what about 2027?' });

    await tick();
    expect((container.querySelector('textarea[aria-label="Ask robin"]') as HTMLTextAreaElement).value).toBe('');

    // MUTATION PROOF - it addresses the contact the RAIL picked, not the first.
    const dana = await openThread(container, 'Dana from the gym');
    const danaBox = dana.querySelector('textarea[aria-label="Ask Dana from the gym"]') as HTMLTextAreaElement;
    await fireEvent.input(danaBox, { target: { value: 'and the plates?' } });
    await tick();
    await fireEvent.click(ask());
    expect(lastPost()).toEqual({ type: 'flockFollowUp', to: DANA, question: 'and the plates?' });
  });

  it('PLACEMENT - the specialty card is IN the identity chip, not a surface of its own', async () => {
    const { container } = await mount();
    const id = chip(container, 'identity');
    // The card's own field, inside the identity chip: they are one noun - who
    // this Origami is, and what it advertises being good at.
    expect(id.querySelector('input[aria-label="Specialties"]')).not.toBeNull();
    expect(id.textContent).toContain('Your specialty card');
    // And nowhere else. A card left behind elsewhere would pass the assertion
    // above the moment somebody rendered it twice.
    const owners = Array.from(container.querySelectorAll('[data-chip], .fk-tile')).filter((t) =>
      t.querySelector('input[aria-label="Specialties"]'),
    );
    expect(owners).toHaveLength(1);
    expect(owners[0]!.getAttribute('data-chip')).toBe('identity');
  });

  it('PLACEMENT - the auto-answer switch is the permissions chip HEAD, readable while it is shut', async () => {
    const { container } = await mount();
    const perms = chip(container, 'permissions');
    // The switch reads as the chip's state, so it is in the chip's HEAD beside
    // the toggle - never inside the toggle button, which would make every click
    // on it also fold the chip away.
    expect(perms.querySelector('.fold-head .sw input[aria-label="Answer without asking me"]')).not.toBeNull();
    expect(perms.querySelector('.fold-open .sw')).toBeNull();
    expect(perms.querySelector('.sp')).not.toBeNull();
    // THREE COLUMNS: Repos, Wiki, Folders. Skills is gone (a skill is not a
    // permission) and so is the per-contact fold — that decision now lives on
    // the contact, in their own thread head.
    expect(perms.textContent).toContain('Folders');
    expect(perms.textContent).not.toContain('Skills');
    expect(perms.textContent).not.toContain('Per-contact overrides');
    expect(perms.querySelector('details')).toBeNull();

    // Exactly one surface owns it, and it is NOT the front desk: the desk is
    // who answers and on what, this is what they may touch. Queried by its OWN
    // aria-label, not the bare `.sw` class — the desk now carries its own
    // switch too (the flock-switch lane's master on/off), a different control.
    const owners = Array.from(container.querySelectorAll('[data-chip], .fk-tile')).filter((t) =>
      t.querySelector('input[aria-label="Answer without asking me"]'),
    );
    expect(owners).toHaveLength(1);
    expect(owners[0]!.getAttribute('data-chip')).toBe('permissions');
    expect(tile(container, 'Front desk').querySelector('.sp')).toBeNull();

    // Shut, the body is GONE and the switch is still there. A chip that folded
    // the switch away would hide whether a stranger's question runs a model.
    await fireEvent.click(perms.querySelector('.fold-open')!);
    await tick();
    expect(chip(container, 'permissions').classList.contains('open')).toBe(false);
    expect(chip(container, 'permissions').querySelector('.sw input')).not.toBeNull();
    expect(chip(container, 'permissions').querySelector('.sp')).toBeNull();
    // And the shut line states the value rather than the noun.
    expect(chip(container, 'permissions').querySelector('.fold-sum')!.textContent).toBe('1 path shared by default');
  });

  it('the banner is the three stages and nothing else — the stale "Live today" fold is gone', async () => {
    const { container } = await mount();
    const banner = container.querySelector('.fk-banner')!;
    expect(Array.from(banner.querySelectorAll('.fk-step b')).map((b) => b.textContent)).toEqual([
      'You seal and sign',
      'A blind relay carries it',
      'Their desk answers',
    ]);
    // The fold said v1 was loopback-only and that the relay transport was
    // "next". The relay landed (`flock/relay-transport.ts`), so both sentences
    // became false while still reading as a considered caveat — which is worse
    // than no caveat, because the reader trusts it and is wrong.
    expect(banner.querySelector('details')).toBeNull();
    expect(banner.textContent).not.toContain('Live today');
    expect(banner.textContent).not.toContain('loopback');
  });

  it('the identity chip edits the display name, keeps the HANDLE label, and copies the full handle', async () => {
    const { container } = await mount();
    const id = chip(container, 'identity');

    // The name is a FIELD now: it is the owner's to change, and it is what
    // every contact sees.
    const name = id.querySelector('input[aria-label="Your display name"]') as HTMLInputElement;
    expect(name.value).toBe('jane');
    // The label under it is the HANDLE's own, not `name@`: the handle was
    // minted once and does not follow a rename, and a tile that composed the
    // two would show a string nobody stored.
    expect(id.querySelector('.fk-mono')!.textContent!.trim()).toBe('jane@QUJDREVG…');
    // A pane that only ever showed eight characters would teach that they were
    // the identity. The whole 43-character digest is on its own line.
    expect(id.querySelector('.fk-fp')!.textContent).toBe(JANE.split('@')[1]);
  });

  it('MUTATION PROOF — Save posts only what changed, and posts nothing while nothing has', async () => {
    const { container } = await mount();
    const id = () => chip(container, 'identity');
    const save = () => Array.from(id().querySelectorAll('.fk-btn')).find(
      (b) => b.textContent!.trim() === 'Save',
    ) as HTMLButtonElement;

    // Nothing typed, nothing picked: there is nothing to say, so the button is
    // dead rather than posting a write that re-states the engine's own value.
    expect(save().disabled).toBe(true);

    const name = id().querySelector('input[aria-label="Your display name"]') as HTMLInputElement;
    await fireEvent.input(name, { target: { value: '  Jane Doe  ' } });
    await tick();
    await fireEvent.click(save());
    // The ICON is absent, not repeated: an absent field means "leave it", and a
    // patch that echoed the unchanged one would make every rename a re-pick.
    expect(lastPost()).toEqual({ type: 'flockSetIdentity', name: 'Jane Doe' });

    // And the other way round: pick a sigil, send only that.
    const wolf = id().querySelector('button[aria-label="wolf"]') as HTMLButtonElement;
    await fireEvent.click(wolf);
    await tick();
    await fireEvent.click(save());
    expect(lastPost()).toEqual({ type: 'flockSetIdentity', name: 'Jane Doe', icon: 'wolf' });
  });

  it('the icon picker offers the drawn set, marks the one in force, and offers no upload', async () => {
    const { container } = await mount();
    const id = chip(container, 'identity');
    const picker = id.querySelector('[role="radiogroup"]')!;
    const options = Array.from(picker.querySelectorAll('button'));

    expect(options.length).toBeGreaterThan(8);
    // The owner's own id is the one checked, and exactly one is.
    expect(options.filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.getAttribute('aria-label')))
      .toEqual(['fox']);
    // Every option draws a glyph this build already holds. There is no file
    // input and no URL field anywhere on the tile: an icon a contact renders
    // is a choice from a drawn set, never an image somebody supplied.
    for (const option of options) expect(option.querySelector('svg, span')).not.toBeNull();
    expect(id.querySelector('input[type="file"]')).toBeNull();
  });

  it('MUTATION PROOF — the red no-model state is the tile edge, the pill AND the line', async () => {
    // enabled: true — the tile only reads "broken" while Flock is actually on
    // (FlockDeskTile.svelte); off, a missing model is moot. The setting
    // defaults off now (t-5nmeez), so this test opts in explicitly.
    (window as unknown as { __ORIGAMI_FLOCK_ENABLED__?: boolean }).__ORIGAMI_FLOCK_ENABLED__ = true;
    const { container } = await mount({ ...STATE, frontDesk: { ...STATE.frontDesk, model: undefined } });
    delete (window as unknown as { __ORIGAMI_FLOCK_ENABLED__?: boolean }).__ORIGAMI_FLOCK_ENABLED__;
    const desk = tile(container, 'Front desk');
    expect(desk.classList.contains('broken')).toBe(true);
    expect(desk.querySelector('.fk-pill.err')!.textContent).toContain('not set');
    expect(desk.querySelector('.fd-required')!.textContent).toContain('every inbound question is refused');
    expect(desk.querySelector('.fd-required')!.getAttribute('role')).toBe('alert');
    // An invite made now would buy a friend nothing but a refusal, so Create is
    // not offered until the model is picked.
    expect(chip(container, 'invite').querySelector('.fk-btn.primary')).toBeNull();

    // With a model set every one of those is GONE. Rendered unconditionally,
    // each passes the first half of this test and tells an owner they are
    // refusing questions they are in fact answering.
    cleanup();
    (window as unknown as { __ORIGAMI_FLOCK_ENABLED__?: boolean }).__ORIGAMI_FLOCK_ENABLED__ = true;
    const ok = await mount();
    delete (window as unknown as { __ORIGAMI_FLOCK_ENABLED__?: boolean }).__ORIGAMI_FLOCK_ENABLED__;
    const set = tile(ok.container, 'Front desk');
    expect(set.classList.contains('broken')).toBe(false);
    expect(set.classList.contains('ok')).toBe(true);
    expect(set.querySelector('.fk-pill.ok')!.textContent).toContain('answering');
    expect(set.querySelector('.fd-required')).toBeNull();
  });

  it('the pending count is the front desk card\'s one big number, and the All-mail pill', async () => {
    const { container } = await mount();
    expect(tile(container, 'Front desk').querySelector('.fk-display')!.textContent).toBe('1');
    expect(tile(container, 'Front desk').textContent).toContain('question waiting');
    // The pane opens on All mail while anything waits, and that card repeats it.
    expect(container.querySelector('.thread .fk-pill.wait')!.textContent).toContain('1 waiting');

    await send({ type: 'flockMailbox', threads: [] });
    expect(tile(container, 'Front desk').querySelector('.fk-display')!.textContent).toBe('0');
    // Zero waiting is no pill at all, anywhere: a badge that says 0 is a badge
    // that says "look".
    expect(container.querySelector('.fk-pill.wait')).toBeNull();
  });

  // ------------------------------------------------------------ contacts --

  it('a rail row shows THEIR icon, the leading name and the last line of the thread', async () => {
    const { container } = await mount();
    const rows = railRows(container);
    expect(rows).toHaveLength(2);
    // Newest thread first: dana asked at 08:00, robin's reply landed at 07:05.
    // robin has no label of the owner's, so the name he uses leads; dana has
    // one, and it leads instead.
    expect(rows.map((r) => r.querySelector('.fk-name')!.textContent)).toEqual(['Dana from the gym', 'robin']);

    // The second line is what was said LAST, whoever said it. A rail that led
    // with the owner's own question would hide the answer they waited for.
    expect(rows[0]!.querySelector('.last')!.textContent).toBe('which tax rules changed in 2026?');
    expect(rows[1]!.querySelector('.last')!.textContent).toBe('section 4 covers it');

    // Both rows have something wanting the owner, so both carry the dot.
    for (const row of rows) expect(row.querySelector('.unread-dot')).not.toBeNull();

    // The avatar is the mark THEY picked, drawn - not a two-letter hash of a
    // name this owner may have typed themselves.
    expect(rows[1]!.querySelector('.fk-avatar svg')).not.toBeNull();
    expect(rows[1]!.querySelector('.fk-avatar')!.textContent).toBe('');
    // dana's contact record names no icon, so it falls back to the brand mark
    // rather than an empty circle: an engine older than the field sends none.
    expect(rows[0]!.querySelector('.fk-avatar svg, .fk-avatar span')).not.toBeNull();

    // The FULL handle is the row's tooltip, and it is on the thread head as a
    // chip: it is who signed the envelope, and a surface showing only a local
    // nickname would let an owner believe they had answered someone they
    // had not.
    expect(rows[1]!.getAttribute('title')).toBe(ROBIN);
    const robin = await openThread(container, 'robin');
    expect(robin.querySelector('.thread-head .fk-chip')!.getAttribute('title')).toBe(ROBIN);
    // GONE: the row never repeated the name they call themselves under a label.
    expect(container.querySelector('.rail')!.textContent).not.toContain('calls themselves');
  });

  it('MUTATION PROOF - the rail search filters on the label, the name they use AND a handle prefix', async () => {
    const { container } = await mount();
    const box = container.querySelector('.rail input[aria-label="Filter contacts"]') as HTMLInputElement;
    const names = () => railRows(container).map((el) => el.querySelector('.fk-name')!.textContent);

    // The owner's own label - the whole point of the edit, and the one field a
    // filter over the engine's `name` alone would miss.
    await fireEvent.input(box, { target: { value: 'gym' } });
    expect(names()).toEqual(['Dana from the gym']);

    // The name they use, which no longer has a line of its own on the row - so
    // this is the assertion that keeps it searchable rather than lost.
    await fireEvent.input(box, { target: { value: 'dana' } });
    expect(names()).toEqual(['Dana from the gym']);

    // And the handle, from the START. A pass-through filter that returned every
    // contact would satisfy each assertion above except this pair.
    await fireEvent.input(box, { target: { value: 'robin@Zm9v' } });
    expect(names()).toEqual(['robin']);
    await fireEvent.input(box, { target: { value: 'Zm9vYmFy' } });
    expect(names()).toEqual([]);
    expect(container.querySelector('.rail .fk-empty')!.textContent).toContain('No contact matches');
    // "All mail" is NEVER filtered away: it is not a contact, and a search that
    // hid it would hide the only page that answers "what waits on me".
    expect(container.querySelector('.rail .crow .fk-name')!.textContent).toBe('All mail');

    // Cleared, the whole flock is back: a box that hid the list until it was
    // typed in would be a list that had been lost.
    await fireEvent.input(box, { target: { value: '   ' } });
    expect(names()).toEqual(['Dana from the gym', 'robin']);
    // The head count is the WHOLE flock, not the filtered view.
    expect(container.querySelector('.rail .fk-pill b')!.textContent).toBe('2');
  });

  it('MUTATION PROOF - Edit in the thread head posts the display name for THAT full handle, and empty clears it', async () => {
    const { container } = await mount();
    const head = async () => (await openThread(container, 'robin')).querySelector('.thread-head') as HTMLElement;
    const button = (el: HTMLElement, label: string) =>
      Array.from(el.querySelectorAll('.fk-btn')).find((b) => b.textContent!.trim() === label) as HTMLButtonElement;

    await fireEvent.click(button(await head(), 'Edit'));
    await tick();
    // The rename lives IN the Edit popover now, beside what this contact may
    // read. Edit used to be the rename and nothing else, so losing it in the
    // redesign of the same control is exactly what this asserts against.
    const input = container.querySelector('.thread-head .cs input[aria-label="Your name for robin"]') as HTMLInputElement;
    // Seeded EMPTY, not with the declared name: pre-filling "robin" and saving
    // would pin a label identical to the fallback and the head would look
    // edited when nothing had been decided.
    expect(input.value).toBe('');
    expect(input.placeholder).toContain('robin');

    await fireEvent.input(input, { target: { value: '  Robin the accountant  ' } });
    await fireEvent.click(button(container.querySelector('.thread-head .cs') as HTMLElement, 'Save name'));
    expect(lastPost()).toEqual({
      // The FULL handle. A write addressed by the label the head shows would
      // name nobody the engine holds.
      type: 'flockSetPolicy',
      handle: ROBIN,
      displayName: 'Robin the accountant',
    });

    // An emptied field is `null`, not '': only `null` removes the key, and a
    // stored '' would render a blank first line for ever.
    await fireEvent.click(button(container.querySelector('.thread-head') as HTMLElement, 'Edit'));
    await tick();
    await fireEvent.input(container.querySelector('.thread-head .cs input[aria-label="Your name for robin"]')!, {
      target: { value: '' },
    });
    await fireEvent.click(button(container.querySelector('.thread-head .cs') as HTMLElement, 'Save name'));
    expect(lastPost()).toEqual({ type: 'flockSetPolicy', handle: ROBIN, displayName: null });
  });

  it('the renamed contact leads with the label everywhere once the engine sends it back', async () => {
    const { container } = await mount();
    const renamed = {
      ...STATE,
      friends: [{ ...STATE.friends[0], displayName: 'Robin the accountant' }, STATE.friends[1]],
    };
    await send({ type: 'flockData', state: renamed });
    expect(railRows(container).map((el) => el.querySelector('.fk-name')!.textContent)).toEqual([
      'Dana from the gym',
      'Robin the accountant',
    ]);
    // The name robin uses is not repeated under the label. It is still
    // reachable - the search matches on it - and the handle beside it in the
    // thread head is what says who actually signed.
    const thread = await openThread(container, 'Robin the accountant');
    expect(thread.querySelector('.thread-head')!.textContent).not.toContain('calls themselves');
    expect(thread.querySelector('.thread-head .fk-chip')!.getAttribute('title')).toBe(ROBIN);
  });

  it('Revoke asks for a confirmation before it posts, and posts the full handle', async () => {
    const { container } = await mount();
    await openThread(container, 'robin');
    const button = (label: string) =>
      Array.from(container.querySelectorAll('.thread-head .fk-btn')).find(
        (b) => b.textContent!.trim() === label,
      ) as HTMLButtonElement;

    await fireEvent.click(button('Revoke'));
    await tick();
    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'flockRevoke' }),
    );

    await fireEvent.click(button('Confirm revoke'));
    expect(lastPost()).toEqual({ type: 'flockRevoke', handle: ROBIN });
  });

  // -------------------------------------------------------------- invite --

  it("the invite chip leads with two pills and the expiry chip, one pill per act", async () => {
    const { container } = await mount();
    const head = chip(container, 'invite').querySelector('.acts')!;
    // Two, equal, side by side: making one and taking one are the same size of
    // decision. A third button here would be a third thing to read first.
    expect(Array.from(head.querySelectorAll('.fk-btn')).map((b) => b.textContent!.trim())).toEqual([
      'Create invite',
      'Paste an invite',
    ]);
    // Both are BUTTONS, not links or divs dressed as pills.
    for (const pill of head.querySelectorAll('.fk-btn')) expect(pill.tagName).toBe('BUTTON');
    // How long one lasts belongs beside the button that makes it - and it is
    // also the chip's shut line, so the fact survives the chip being folded.
    expect(head.textContent!.replace(/\s+/g, ' ')).toContain('48 h · single use');
    expect(chip(container, 'invite').querySelector('.fold-sum')!.textContent).toBe('48 h · single use');
    // The pills press; the panels below are what appear. Nothing to type here.
    expect(head.querySelector('textarea')).toBeNull();

    // Whitespace-collapsed: the sentence wraps in the source, and the ONE thing
    // about this feature that surprises everyone is at the tile's floor, beside
    // the boxes — an invite you send lets THEM reach YOU.
    expect(chip(container, 'invite').textContent!.replace(/\s+/g, ' ')).toContain(
      'a contact link is two invites',
    );
  });

  it('Create invite posts flockInvite and the string AND the QR land in the panel below', async () => {
    const { container } = await mount();
    await fireEvent.click(chip(container, 'invite').querySelector('.fk-btn.primary')!);
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'flockInvite' });

    await send({ type: 'flockInviteMade', invite: 'origami://flock/invite#v2.abc', qr: '<svg id="q"></svg>' });
    const body = chip(container, 'invite').querySelector('.fold-body')!;
    expect((body.querySelector('textarea[aria-label="Your invite"]') as HTMLTextAreaElement).value).toBe(
      'origami://flock/invite#v2.abc',
    );
    expect(body.querySelector('.qr svg')).not.toBeNull();
  });

  it('the accept box is always open, takes the caret from the pill, and posts the TRIMMED string', async () => {
    const { container } = await mount();
    const invite = chip(container, 'invite');
    const box = invite.querySelector('textarea[aria-label="Accept an invite"]') as HTMLTextAreaElement;
    // Stacked, not behind a toggle: a contact link is two invites, and a page
    // that showed one box at a time taught the opposite.
    expect(box).not.toBeNull();
    expect(document.activeElement).not.toBe(box);

    // The pill cannot OPEN a box that is already open, so it takes the caret.
    const paste = Array.from(invite.querySelectorAll('.acts .fk-btn')).find(
      (b) => b.textContent!.trim() === 'Paste an invite',
    ) as HTMLButtonElement;
    await fireEvent.click(paste);
    await tick();
    expect(document.activeElement).toBe(box);

    // AND AGAIN. A latched boolean would already be true here and the second
    // press would do nothing at all.
    box.blur();
    expect(document.activeElement).not.toBe(box);
    await fireEvent.click(paste);
    await tick();
    expect(document.activeElement).toBe(box);

    await fireEvent.input(box, { target: { value: '  origami://flock/invite#v2.zzz  ' } });
    await fireEvent.click(
      Array.from(invite.querySelectorAll('.fk-btn')).find((b) => b.textContent!.trim() === 'Accept invite')!,
    );
    expect(lastPost()).toEqual({ type: 'flockAccept', invite: 'origami://flock/invite#v2.zzz' });
  });

  // ----------------------------------------------------------------- mail --

  /** The rows in the tray on screen, on the "All mail" card. Every mail test
   *  below is about the TRAYS, so each selects that rail row first. */
  const mailRows = (container: HTMLElement) => Array.from(container.querySelectorAll('.thread .row'));

  it('the Inbox tray carries BOTH kinds of row: a question to decide and a reply to read', async () => {
    const { container } = await mount();
    await openAllMail(container);
    const rows = mailRows(container);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('.mk-bubble')!.textContent).toBe('which tax rules changed in 2026?');
    // The state chip is prose, not a state id: "pending" is not a sentence a
    // person can act on and "waiting on you" is.
    expect(rows[0]!.textContent).toContain('waiting on you');
    expect(rows[1]!.textContent).toContain('they answered');
    expect(rows[1]!.querySelectorAll('.mk-bubble')[1]!.textContent!.trim()).toBe('section 4 covers it');
    // The FULL handle is the tooltip; the row leads with the name.
    expect(rows[0]!.querySelector('.who')!.getAttribute('title')).toBe(DANA);
  });

  it('a question posts a decision per button, and guidance goes through a box first', async () => {
    const { container } = await mount(STATE, [QUESTION]);
    await openAllMail(container);
    const row = mailRows(container)[0]!;
    await fireEvent.click(row.querySelector('.fk-btn.primary')!);
    expect(lastPost()).toEqual({ type: 'flockDecide', thread: 'thr_in_1', action: 'answer' });

    // "Answer with guidance" opens the box rather than deciding: an instruction
    // sent before it was typed is not the feature.
    const buttons = () => Array.from(mailRows(container)[0]!.querySelectorAll('.fk-btn'));
    await fireEvent.click(buttons()[1]!);
    const box = mailRows(container)[0]!.querySelector('textarea') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: 'only what is public' } });
    await fireEvent.click(mailRows(container)[0]!.querySelector('.fk-btn.primary')!);
    expect(lastPost()).toEqual({ type: 'flockDecide', thread: 'thr_in_1', action: 'answer', guidance: 'only what is public' });
  });

  it('a decline carries the reason the owner typed, which the asker will read', async () => {
    const { container } = await mount(STATE, [QUESTION]);
    await openAllMail(container);
    const buttons = () => Array.from(mailRows(container)[0]!.querySelectorAll('.fk-btn'));
    await fireEvent.click(buttons()[2]!);
    const box = mailRows(container)[0]!.querySelector('textarea') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: 'not something I share' } });
    await fireEvent.click(mailRows(container)[0]!.querySelector('.fk-btn.primary')!);
    expect(lastPost()).toEqual({ type: 'flockDecide', thread: 'thr_in_1', action: 'decline', reason: 'not something I share' });
  });

  it('a DRAFT offers Send, not an answer that has already gone', async () => {
    const drafted = {
      ...QUESTION,
      state: 'answering',
      reply: { text: 'section 4 covers it', at: '2026-09-05T08:10:00.000Z', tokens: 88, signatureOk: true },
    };
    const { container } = await mount(STATE, [drafted]);
    await openAllMail(container);
    const row = mailRows(container)[0]!;
    expect(row.textContent).toContain('drafted — review it');
    await fireEvent.click(row.querySelector('.fk-btn.primary')!);
    expect(lastPost()).toEqual({ type: 'flockSend', thread: 'thr_in_1' });
  });

  // A reply carries no prose from here any more: the ENGINE writes the envelope
  // (flock/deliver.ts), so the pane posts a row id and a destination.
  it('a reply offers New chat with no chats open, and posts no user turn', async () => {
    const { container } = await mount(STATE, [REPLY]);
    await openAllMail(container);
    const picker = mailRows(container)[0]!.querySelector('select') as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(['', 'new']);
    await fireEvent.change(picker, { target: { value: 'new' } });
    expect(lastPost()).toEqual({ type: 'flockOpenChat', thread: 'thr_out_1' });
    expect(JSON.stringify(lastPost())).not.toContain('text');
  });

  it('delivering to a running chat names the session the owner picked', async () => {
    const { container } = await mount(STATE, [REPLY]);
    await openAllMail(container);
    await send({ type: 'flockSessions', sessions: [{ id: 'session-3', label: 'Chat 3' }] });
    const picker = mailRows(container)[0]!.querySelector('select') as HTMLSelectElement;
    await fireEvent.change(picker, { target: { value: 'session-3' } });
    expect(lastPost()).toEqual({ type: 'flockDeliver', thread: 'thr_out_1', sessionID: 'session-3' });
  });

  it('a follow-up carries the thread it follows, so both sides stay threaded', async () => {
    const { container } = await mount(STATE, [REPLY]);
    await openAllMail(container);
    const buttons = () => Array.from(mailRows(container)[0]!.querySelectorAll('.fk-btn'));
    await fireEvent.click(buttons().find((b) => b.textContent!.trim() === 'Follow up')!);
    const box = mailRows(container)[0]!.querySelector('textarea') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: 'and what about 2027?' } });
    await fireEvent.click(mailRows(container)[0]!.querySelector('.fk-btn.primary')!);
    expect(lastPost()).toEqual({
      type: 'flockFollowUp',
      to: ROBIN,
      question: 'and what about 2027?',
      followUpOf: 'thr_out_1',
    });
  });

  it('the answered log shows the token cost, newest first, and names a refusal as one', async () => {
    const { container } = await mount();
    // A disclosure at the desk tile's floor now: it is the desk's own record.
    const rows = Array.from(tile(container, 'Front desk').querySelectorAll('.answered .log tr'));
    expect(rows[0]!.querySelector('.cost')!.textContent!.trim()).toBe('refused');
    expect(rows[1]!.querySelector('.cost')!.textContent!.trim()).toBe('830 tokens');
  });

  it('an empty mailbox says so rather than rendering nothing at all', async () => {
    const { container } = await mount(STATE, []);
    // With nothing waiting the pane opens on the newest CONTACT, not on the
    // trays - and that thread says what to do rather than showing a blank box.
    expect(container.querySelector('.thread .fk-empty')!.textContent).toContain('Nothing yet. Ask');

    const all = await openAllMail(container);
    expect(all.querySelector('.row')).toBeNull();
    expect(all.textContent).toContain('Nothing wants you');
  });

  // --------------------------------------------------------- permissions --

  it('the defaults switch posts the desk-wide auto-answer, not a friend\'s', async () => {
    const { container } = await mount();
    await fireEvent.click(chip(container, 'permissions').querySelector('.fold-head .sw input')!);
    expect(lastPost()).toEqual({ type: 'flockFrontDesk', autoAnswer: true });
  });

  it('the scope pickers are CHECKLISTS built from the host\'s lists', async () => {
    const { container } = await mount();
    const labels = Array.from(
      chip(container, 'permissions').querySelectorAll(':scope > .fold-body > .sp .fk-check span'),
    ).map((el) => el.textContent);
    // Repo DISPLAY names and wiki folders — and the repo already in the scope
    // but absent from this machine's registry survives as its own row. NO
    // skills: they were a third checklist until the owner ruled that a set of
    // instructions is not a secret, so there was never a meaningful "no".
    expect(labels).toEqual(['site', 'demo-app', 'work/api', 'wiki/pages', 'wiki/drafts']);
  });

  it('the chip\'s shut line counts folders — a folders-only desk does not read as "Nothing shared"', async () => {
    const { container } = await mount({
      ...STATE,
      frontDesk: { ...STATE.frontDesk, scope: { folders: ['D:/notes', 'E:/tax'] } },
    });
    // The shut line is the one thing an owner reads without opening anything,
    // and "Nothing shared" is the state it exists to name. Getting it wrong for
    // a folder is the same defect as getting it wrong for a repo.
    expect(chip(container, 'permissions').querySelector('.fold-sum')!.textContent).toBe('2 paths shared by default');
    // ...and the picker's own total agrees with it, because both count through
    // `scopeCount` rather than adding the lengths up twice.
    expect(chip(container, 'permissions').querySelector('.sp-total')!.textContent!.trim()).toBe('2 shared things.');
  });

  it('FOLDERS is a list with a Browse and an ×, not a checklist — there is no registry of folders', async () => {
    const { container } = await mount({
      ...STATE,
      frontDesk: { ...STATE.frontDesk, scope: { repos: ['work/api'], folders: ['D:/notes', 'E:/tax'] } },
    });
    const perms = chip(container, 'permissions');
    // Every folder renders whole (an absolute path is the only thing that
    // identifies it) and none of them is a checkbox.
    const rows = Array.from(perms.querySelectorAll('.fl-row .path')).map((el) => el.textContent);
    expect(rows).toEqual(['D:/notes', 'E:/tax']);
    expect(perms.querySelector('input[data-scope="defaults-folders"]')).toBeNull();

    const remove = perms.querySelector('[aria-label="Stop sharing D:/notes"]') as HTMLButtonElement;
    await fireEvent.click(remove);
    expect(lastPost()).toEqual({
      type: 'flockFrontDesk',
      scope: { repos: ['work/api'], wiki: [], folders: ['E:/tax'] },
    });
  });

  it('a browsed FOLDER lands on the folders list, and the pick names the picker that asked', async () => {
    const { container } = await mount();
    const browse = Array.from(
      chip(container, 'permissions').querySelectorAll(':scope > .fold-body > .sp .fk-btn'),
    ) as HTMLButtonElement[];
    await fireEvent.click(browse[2]!); // Repos, Wiki, then Folders
    expect(lastPost()).toEqual({ type: 'flockBrowseFolder', kind: 'folders', target: '' });

    await send({ type: 'flockScopePicked', kind: 'folders', path: 'D:/notes', target: '' });
    expect(lastPost()).toEqual({
      type: 'flockFrontDesk',
      scope: { repos: ['work/api'], wiki: [], folders: ['D:/notes'] },
    });
  });

  // WIRE SURVIVAL. `toEqual` reads straight through a Svelte 5 `$state` proxy,
  // so every assertion above passes on a payload the real webview can never
  // send: `acquireVsCodeApi().postMessage` structured-clones its argument, and
  // structuredClone throws DataCloneError on a proxy. The pane's `state` IS
  // `$state`, so `state.frontDesk.scope.repos` is a proxy array, and a picker
  // that forwards a list it did not itself rebuild puts one on the wire.
  // Same class as the W6 model-pin bug (CollabAgentsPane) and botsPane's
  // `structuredClone(lastPost('saveCollabAgentDef'))` guard.
  it('WIRE SURVIVAL — a ticked scope box posts a message structuredClone accepts', async () => {
    // ALL THREE lists populated on purpose: `toggle` rebuilds only the list it
    // changed and forwards the other two as it found them, so a scope with one
    // non-empty list hides the defect behind the one array that got rebuilt.
    const { container } = await mount({
      ...STATE,
      frontDesk: { ...STATE.frontDesk, scope: { repos: ['work/api'], wiki: ['wiki/pages'], folders: ['D:/notes'] } },
    });
    const boxes = Array.from(
      chip(container, 'permissions').querySelectorAll('input[data-scope="defaults-repos"]'),
    ) as HTMLInputElement[];
    await fireEvent.click(boxes[0]!);
    expect(() => structuredClone(lastPost())).not.toThrow();
  });

  it('WIRE SURVIVAL — a per-friend scope override posts a message structuredClone accepts', async () => {
    const { container } = await mount({
      ...STATE,
      frontDesk: { ...STATE.frontDesk, scope: { repos: ['work/api'], wiki: ['wiki/pages'], folders: ['D:/notes'] } },
    });
    const popover = await editPopover(container, 'robin');
    await fireEvent.click(pill(popover, 'wiki/pages'));
    expect(() => structuredClone(lastPost())).not.toThrow();
  });

  it('WIRE SURVIVAL — a browsed folder posts a message structuredClone accepts', async () => {
    const { container } = await mount();
    const browse = Array.from(chip(container, 'permissions').querySelectorAll(':scope > .fold-body > .sp .fk-btn')) as HTMLButtonElement[];
    await fireEvent.click(browse[1]!);
    await send({ type: 'flockScopePicked', kind: 'wiki', path: 'wiki/private', target: '' });
    expect(() => structuredClone(lastPost())).not.toThrow();
  });

  it('MUTATION PROOF — ticking a default repo posts an ARRAY of every list, not a comma string', async () => {
    const { container } = await mount();
    const boxes = Array.from(
      chip(container, 'permissions').querySelectorAll('input[data-scope="defaults-repos"]'),
    ) as HTMLInputElement[];
    await fireEvent.click(boxes[0]!);

    // A picker that joined its ticks back into 'work/api, C:/…' would pass a
    // "did it post" assertion and write a scope the engine matches as one
    // impossible path.
    expect(lastPost()).toEqual({
      type: 'flockFrontDesk',
      scope: { repos: ['work/api', 'C:/Repos/acme/site'], wiki: [], folders: [] },
    });
  });

  it('Browse… asks the host, and the folder it returns lands on the list that asked', async () => {
    const { container } = await mount();
    const browse = Array.from(chip(container, 'permissions').querySelectorAll(':scope > .fold-body > .sp .fk-btn')) as HTMLButtonElement[];
    await fireEvent.click(browse[1]!); // the WIKI list's button
    expect(lastPost()).toEqual({ type: 'flockBrowseFolder', kind: 'wiki', target: '' });

    await send({ type: 'flockScopePicked', kind: 'wiki', path: 'wiki/private', target: '' });
    expect(lastPost()).toEqual({
      type: 'flockFrontDesk',
      scope: { repos: ['work/api'], wiki: ['wiki/private'], folders: [] },
    });
  });

  it('a pick browsed FOR a contact is not applied to the desk defaults', async () => {
    // Two pickers are on screen at once now. Without the `target` echo, both
    // would take the same folder and the owner would have shared it with
    // everybody while meaning to share it with one person.
    const { container } = await mount();
    await editPopover(container, 'robin');
    await send({ type: 'flockScopePicked', kind: 'folders', path: 'D:/notes', target: ROBIN });
    expect(lastPost()).toEqual({
      type: 'flockSetPolicy',
      handle: ROBIN,
      scope: { repos: ['work/api'], wiki: [], folders: ['D:/notes'] },
    });
  });

  it('the per-contact fold is GONE from the Permissions chip — that decision lives on the contact', async () => {
    const { container } = await mount();
    const perms = chip(container, 'permissions');
    // It used to be a disclosure headed "N of M contacts override the defaults":
    // a decision about ONE person filed in the panel about EVERYONE.
    expect(perms.textContent).not.toContain('override the defaults');
    expect(perms.querySelector('.ov')).toBeNull();
    // ...and the Edit popover in a contact's own thread head is where it went.
    const popover = await editPopover(container, 'robin');
    expect(popover.getAttribute('data-contact-scope')).toBe(ROBIN);
  });

  it('the popover overlays the desk list with THIS contact\'s, and marks what differs', async () => {
    const { container } = await mount({
      ...STATE,
      frontDesk: { ...STATE.frontDesk, scope: { repos: ['work/api'], wiki: ['wiki/pages', 'wiki/drafts'] } },
      friends: [{ ...STATE.friends[0], policy: { autoAnswer: true, scope: { wiki: ['wiki/drafts'] } } }, STATE.friends[1]],
    });
    const popover = await editPopover(container, 'robin');

    // work/api and wiki/pages are desk defaults robin has been cut off from, so
    // they still RENDER — off, and marked. Without the mark, a reduced list is
    // indistinguishable from the default it replaced.
    expect(pill(popover, 'api').checked).toBe(false);
    expect(pill(popover, 'api').closest('.fk-tick')!.classList.contains('differs')).toBe(true);
    expect(pill(popover, 'wiki/drafts').checked).toBe(true);
    expect(pill(popover, 'wiki/drafts').closest('.fk-tick')!.classList.contains('differs')).toBe(false);
    // robin holds `autoAnswer: true` against a desk default of off.
    expect(pill(popover, 'Answer without asking').checked).toBe(true);
    expect(pill(popover, 'Answer without asking').closest('.fk-tick')!.classList.contains('differs')).toBe(true);
  });

  it('MUTATION PROOF — a pill ADDS or REDUCES for one contact, leaving the other defaults alone', async () => {
    const { container } = await mount({
      ...STATE,
      frontDesk: {
        ...STATE.frontDesk,
        scope: { repos: ['work/api'], wiki: ['wiki/pages', 'wiki/drafts'], folders: [] },
      },
    });
    const popover = await editPopover(container, 'robin');

    // A contact with no scope of their own opens on the DESK's list, every pill
    // on: the control has to show what applies to them, or reducing one entry
    // would silently drop every other default at the same time.
    expect(pill(popover, 'wiki/pages').checked).toBe(true);
    expect(pill(popover, 'wiki/drafts').checked).toBe(true);

    await fireEvent.click(pill(popover, 'wiki/pages'));
    // The whole scope, all three arrays, as THIS contact's own: the default
    // list minus the one entry. wiki/pages is gone; the other two are not.
    expect(lastPost()).toEqual({
      type: 'flockSetPolicy',
      handle: ROBIN,
      scope: { repos: ['work/api'], wiki: ['wiki/drafts'], folders: [] },
    });
  });

  it('the auto-answer pill overrides that one contact, and Reset gives every default back', async () => {
    const { container } = await mount();
    const popover = await editPopover(container, 'robin');

    // robin holds `autoAnswer: true` of his own; clicking it turns it off for
    // him while the desk default stands for everyone else.
    await fireEvent.click(pill(popover, 'Answer without asking'));
    expect(lastPost()).toEqual({ type: 'flockSetPolicy', handle: ROBIN, autoAnswer: false });

    // `null` on all three, not an empty scope: an empty one is "share nothing
    // with them", which is a different and much quieter answer than "use the
    // defaults", and a reset that left one override behind is a reset the owner
    // has to go looking for the rest of.
    const reset = Array.from(popover.querySelectorAll('.fk-btn')).find(
      (b) => b.textContent!.trim() === 'Reset to default',
    ) as HTMLButtonElement;
    await fireEvent.click(reset);
    expect(lastPost()).toEqual({
      type: 'flockSetPolicy',
      handle: ROBIN,
      scope: null,
      autoAnswer: null,
      dailyBudgetTokens: null,
    });
  });

  it('a contact following every default is offered no Reset — a button that does nothing is worse than none', async () => {
    const { container } = await mount();
    const popover = await editPopover(container, 'Dana from the gym');
    expect(Array.from(popover.querySelectorAll('.fk-btn')).map((b) => b.textContent!.trim())).not.toContain(
      'Reset to default',
    );
    expect(popover.textContent).toContain('Following every default');
  });

  it('a per-contact budget posts a number, and an emptied one posts null', async () => {
    const { container } = await mount();
    const popover = await editPopover(container, 'robin');
    const box = popover.querySelector('.budget') as HTMLInputElement;
    // The desk's own cap is the PLACEHOLDER, never the value: a pre-filled
    // inherited number becomes an override the moment anyone touches the box.
    expect(box.value).toBe('');
    expect(box.placeholder).toBe('5000 (default)');

    await fireEvent.input(box, { target: { value: '250' } });
    await fireEvent.blur(box);
    expect(lastPost()).toEqual({ type: 'flockSetPolicy', handle: ROBIN, dailyBudgetTokens: 250 });

    await fireEvent.input(box, { target: { value: '  ' } });
    await fireEvent.blur(box);
    expect(lastPost()).toEqual({ type: 'flockSetPolicy', handle: ROBIN, dailyBudgetTokens: null });
  });

  it('Browse… inside the popover names the contact it was opened for', async () => {
    const { container } = await mount();
    const popover = await editPopover(container, 'robin');
    const browse = Array.from(popover.querySelectorAll('.fk-btn')).find(
      (b) => b.textContent!.trim() === 'Browse…',
    ) as HTMLButtonElement;
    await fireEvent.click(browse);
    expect(lastPost()).toEqual({ type: 'flockBrowseFolder', kind: 'folders', target: ROBIN });
  });

  it('the All mail head has no Edit — there is no one contact to edit', async () => {
    const { container } = await mount();
    const all = container.querySelector('.thread') as HTMLElement;
    const labels = Array.from(all.querySelectorAll('.fk-btn')).map((b) => b.textContent!.trim());
    expect(labels).not.toContain('Edit');
    expect(labels).not.toContain('Revoke');
  });

  // ---------------------------------------------------------------- card --

  it('the card edits the specialties and posts them split and trimmed', async () => {
    const { container } = await mount();
    // The card is the identity tile's second half, so the field is named, not
    // "the first .fk-inp" — which is the owner's display name now.
    const card = chip(container, 'identity').querySelector('.fc-card')!;
    const input = card.querySelector('input[aria-label="Specialties"]') as HTMLInputElement;
    expect(input.value).toBe('WordPress, UK tax rules');

    await fireEvent.input(input, { target: { value: ' WordPress , , vehicle diagnostics ' } });
    await fireEvent.click(card.querySelector('.fk-btn')!);
    expect(lastPost()).toEqual({
      type: 'flockSetSpecialties',
      specialties: ['WordPress', 'vehicle diagnostics'],
    });
  });

  it('an engine error replaces the page rather than showing a stale flock beside it', async () => {
    const { container } = render(FlockPane);
    await send({ type: 'flockData', error: 'Open a chat first — your flock is read from a live engine connection.' });
    expect(container.querySelector('.err')!.textContent).toContain('Open a chat first');
    expect(container.querySelector('.fk-tile')).toBeNull();
    expect(container.querySelector('.rail')).toBeNull();
    expect(container.querySelector('.thread')).toBeNull();
  });
});

// THE MASTER SWITCH — Front Desk card, replacing the decorative glyph. Reads
// __ORIGAMI_FLOCK_ENABLED__ once at mount (the same global ChatView reads),
// then only the `flockEnabled` message moves it — no optimistic local state,
// same rule RemoteStory.svelte follows for its own switch.
describe('FlockPane (webview) — the enabled switch', () => {
  afterEach(() => {
    delete (window as unknown as { __ORIGAMI_FLOCK_ENABLED__?: boolean }).__ORIGAMI_FLOCK_ENABLED__;
  });

  it('reads OFF from the injected global, shows the off state and sentence, and posts flockSetEnabled on click', async () => {
    (window as unknown as { __ORIGAMI_FLOCK_ENABLED__?: boolean }).__ORIGAMI_FLOCK_ENABLED__ = false;
    const { container } = await mount();
    const sw = container.querySelector('.sw.big input') as HTMLInputElement;
    expect(sw.checked).toBe(false);
    expect(container.querySelector('.sw-label')!.textContent).toBe('Flock is off');
    expect(container.querySelector('.sw-state')!.textContent).toContain('Off by default: no relay connection for Flock');
    // The pill in the desk tile's own head reads "off" too, not the model's state.
    expect(tile(container, 'Front desk').querySelector('.fk-pill')!.textContent).toContain('off');

    await fireEvent.click(sw);
    expect(lastPost()).toEqual({ type: 'flockSetEnabled', enabled: true });
  });

  it('starts OFF when the host never posted the global, and a flockEnabled message flips it live, surfacing an error in the .err line', async () => {
    const { container } = await mount();
    const sw = () => container.querySelector('.sw.big input') as HTMLInputElement;
    expect(sw().checked).toBe(false);
    expect(container.querySelector('.sw-label')!.textContent).toBe('Flock is off');

    await send({ type: 'flockEnabled', enabled: true, error: 'settings file is read-only' });
    expect(sw().checked).toBe(true);
    expect(container.querySelector('.err')!.textContent).toBe('settings file is read-only');
  });
});

// MULTI-WINDOW. Two VS Code windows means two engines, and the relay allows one
// socket per role per rid — so exactly one engine holds the friend links. The
// pane said nothing about this at all before, which is why the owner saw a
// friends list that simply never answered.
describe('FlockPane — the flock is running in another window', () => {
  beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());

  it('says so in the words the state deserves, and offers no take-over', async () => {
    const { container } = render(FlockPane);
    await send({ type: 'flockData', state: { ...STATE, transport: 'other-engine' } });
    const banner = container.querySelector('.fk-elsewhere');
    expect(banner).not.toBeNull();
    expect(banner!.textContent!.replace(/\s+/g, ' ').trim()).toBe(
      'Flock is running in another window ' +
        'An engine of another window holds the links to your contacts. It is not an engine of this window, ' +
        'so this window does not ask or answer. Close the window that runs it. This window then takes over in a few seconds.',
    );
    // v1 has no button: the hand-over is automatic and costs one heartbeat.
    expect(banner!.querySelector('button')).toBeNull();
  });

  // t-vbj03h: the owner could not check the claim. The banner names the process.
  it('names the holder process by pid when flock_state carries one', async () => {
    const { container } = render(FlockPane);
    await send({ type: 'flockData', state: { ...STATE, transport: 'other-engine', holder: { pid: 35304, httpBase: 'http://127.0.0.1:4096' } } });
    const text = container.querySelector('.fk-elsewhere')!.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('Engine process 35304 (origami.exe) holds the links to your contacts.');
  });

  // MUTATION PROOF — a banner that renders in every state says nothing. The
  // two states that are NOT "another window" must show no banner at all.
  it('MUTATION PROOF — relay and none show no banner', async () => {
    const { container } = render(FlockPane);
    await send({ type: 'flockData', state: { ...STATE, transport: 'relay' } });
    expect(container.querySelector('.fk-elsewhere')).toBeNull();
    await send({ type: 'flockData', state: { ...STATE, transport: 'none' } });
    expect(container.querySelector('.fk-elsewhere')).toBeNull();
    await send({ type: 'flockData', state: { ...STATE, transport: 'other-engine' } });
    expect(container.querySelector('.fk-elsewhere')).not.toBeNull();
  });

  it('the rest of the page still renders: this window can still edit policy', async () => {
    const { container } = render(FlockPane);
    await send({ type: 'flockData', state: { ...STATE, transport: 'other-engine' } });
    expect(container.querySelectorAll('.fk-tile').length).toBeGreaterThan(0);
  });
});

// NOTHING ON THE FLOCK PATH POSTS A `send`.
//
// This is the defect the whole flow lane exists for, stated as a rule a file
// scan can hold. "Open in a new chat" used to post a USER turn worded as a
// sentence about the row — `Macbook replied to your question 'high': …. What do
// you want done with it?` — and the model read it as the person at the keyboard
// asking that question. The ENGINE writes the envelope now; every surface here
// posts a row id and a destination.
//
// A scan rather than a rendered assertion because the failure is one line
// anywhere in six files, and five of them would need a different render to
// reach. `type: 'send'` is the exact shape DashboardPanel routes to a prompt.
describe('the flock path produces no user turn', () => {
  const pkg = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const FILES = [
    'src/dashboard/flockMailbox.ts',
    'src/dashboard/flockMailboxRead.ts',
    'src/dashboard/flockPane.ts',
    'webview/dashboard/panes/flockDeliverTargets.ts',
    'webview/dashboard/panes/flockMail.ts',
    'webview/dashboard/panes/FlockPane.svelte',
    'webview/dashboard/panes/flockThread.ts',
    'webview/dashboard/components/FlockMail.svelte',
    'webview/dashboard/components/FlockAllMail.svelte',
    'webview/dashboard/components/FlockThread.svelte',
    'webview/dashboard/components/FlockRowActions.svelte',
    'webview/dashboard/components/FlockSide.svelte',
    'webview/chat/FrontDeskSection.svelte',
    'webview/chat/FrontDeskRows.svelte',
  ];

  it('reads the files it claims to (guards the scan itself)', () => {
    for (const rel of FILES) expect(existsSync(nodePath.join(pkg, rel)), rel).toBe(true);
    // The scan can only be trusted if the pattern it looks for exists somewhere.
    expect(readFileSync(nodePath.join(pkg, 'src/dashboard/DashboardPanel.ts'), 'utf8')).toMatch(/type: 'send'/);
  });

  it('no file on the path posts a send-type message', () => {
    for (const rel of FILES) {
      const src = readFileSync(nodePath.join(pkg, rel), 'utf8');
      expect(src, `${rel} posts a user turn`).not.toMatch(/type:\s*'send'/);
      expect(src, `${rel} posts a user turn`).not.toMatch(/"type":\s*"send"/);
    }
  });

  it('the host contract has no text-injection door left at all', () => {
    const src = readFileSync(nodePath.join(pkg, 'src/dashboard/flockMailbox.ts'), 'utf8');
    // `deliver(sessionID, text)` was the door that injected prose. It is gone;
    // what replaced it names a thread and lets the engine write the words.
    expect(src).not.toMatch(/deliver\?\(sessionID: string, text: string\)/);
    expect(src).toMatch(/'flock_deliver'/);
  });
});
