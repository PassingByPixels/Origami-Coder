// Regression guard for the Context tracker removal (Passing: "i want to ditch
// context manager"). The cross-session token tracker — the collapsible
// Context section, its picker + monitored-chat rows — is GONE from the
// sidebar launcher; the per-chat context gauge inside ChatPane is a
// different, load-bearing feature and is untouched (not exercised here).
//
// These are NOT echo tests: they break if the Context section (or any of its
// classes/handlers) reappears, and they pin down that removing it did not
// take the rest of the launcher (Settings/Chats/Memory, New chat) with it.

import { render, screen, fireEvent, cleanup, within } from '@testing-library/svelte';
import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tick } from 'svelte';
import SidebarLauncher from './SidebarLauncher.svelte';

afterEach(() => {
  cleanup();
  globalThis.__vscodeApiMock.postMessage.mockClear();
});

/** Drive the launcher the way the host does — a window message — and let Svelte
 *  flush. The launcher has no props; every input it has arrives on this wire. */
async function post(data: unknown): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
}

/** The host's mount handshake reply. Each row is titled with its own id, so the
 *  rendered order can be read back off the DOM without guessing at numbering. */
function sessionList(...ids: string[]): unknown {
  return {
    type: 'sessionList',
    sessions: ids.map((id, n) => ({ id, number: n + 1, agentName: 'Tsuru', title: id })),
  };
}

function posts(): unknown[] {
  return globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]);
}

/** The chat ids in the order they are actually painted. */
function rowIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.session-name')).map(
    (n) => (n.textContent ?? '').replace('Tsuru: ', ''),
  );
}

function ringStates(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('.session-ring')).map((r) => r.getAttribute('data-state'));
}

describe('SidebarLauncher — Context tracker removed', () => {
  it('renders no Context section, toggle, or ctx-* elements', () => {
    const { container } = render(SidebarLauncher);
    expect(container.querySelector('.context-section')).toBeNull();
    expect(container.querySelector('[class*="ctx-"]')).toBeNull();
    expect(screen.queryByText(/Show context/i)).toBeNull();
    expect(screen.queryByText('Context')).toBeNull();
  });

  it('the component source carries none of the removed Context state/handlers', () => {
    const src = readFileSync(join(__dirname, 'SidebarLauncher.svelte'), 'utf-8');
    expect(src).not.toMatch(/showContext|ctxBySession|toggleMonitor|monitoredSessions|monitoredCount|pickerOpen|ctxTotals/);
    expect(src).not.toMatch(/from '\.\.\/shared\/contextStats'/);
  });

  it('Settings / Chats / Memory sections and New chat still work — the removal did not take them with it', async () => {
    const { container } = render(SidebarLauncher);
    // Collabs was added between Chats and Memory; Context is still gone.
    const labels = Array.from(container.querySelectorAll('.section-label')).map((l) => l.textContent);
    expect(labels).toEqual(['Settings', 'Chats', 'Collabs', 'Memory']);
    expect(container.querySelector('.memory-section')).not.toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: /New chat/ }));
    expect(posts()).toContainEqual({ type: 'newSession' });
  });
});

// The ring answers one question at a glance: is this chat still thinking, or is
// it waiting on me? The states are only meaningful if they track the host's real
// turn lifecycle and stay pinned to the RIGHT chat, so that is what is asserted —
// never "the element exists".
describe('SidebarLauncher — per-chat activity ring', () => {
  it('a chat with no activity this session shows no ring state — it does not claim to be waiting on you', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b'));
    expect(ringStates(container)).toEqual(['idle', 'idle']);
  });

  it('the turn a user sent goes to working, and back to ready when the host reports it done', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b'));

    // echoUser is the host echoing the accepted prompt — the start-of-turn
    // broadcast an ordinary chat produces (`busy` is the /loop path alone).
    // A PLAIN echoUser (no `replay`) still flips the ring — see the
    // replay-tagged case below for the one that must not.
    await post({ type: 'echoUser', text: 'hello', sessionId: 'a' });
    expect(ringStates(container)).toEqual(['working', 'idle']);

    await post({ type: 'turnDone', stopReason: 'end_turn', sessionId: 'a' });
    expect(ringStates(container)).toEqual(['ready', 'idle']);
  });

  // The reported bug: a recalled chat's onUserMessageChunk (fed only by ACP
  // loadSession history replay) posts one echoUser per historical user turn,
  // with no turnDone ever following — so the ring spun amber forever. The
  // fix tags that ONE post site `replay: true`; a restored chat must stay
  // idle, while an ordinary live send (no `replay`) still spins the ring.
  it('a replay-tagged echoUser (history restore) leaves the ring idle — no turn is actually in flight', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b'));
    await post({ type: 'echoUser', text: 'restored turn 1', sessionId: 'a', replay: true });
    await post({ type: 'echoUser', text: 'restored turn 2', sessionId: 'a', replay: true });
    expect(ringStates(container)).toEqual(['idle', 'idle']);
  });

  it('a plain echoUser still spins the ring even after a replay-tagged one on the same session', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a'));
    await post({ type: 'echoUser', text: 'restored turn', sessionId: 'a', replay: true });
    expect(ringStates(container)).toEqual(['idle']);
    await post({ type: 'echoUser', text: 'a live send', sessionId: 'a' });
    expect(ringStates(container)).toEqual(['working']);
  });

  // /firstfold is shell-only (never reaches the engine) and ends in
  // 'firstfoldDone', not 'turnDone' — without a case for it the ring spun
  // forever after every /firstfold run.
  it('firstfoldDone settles the ring, same as turnDone', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a'));
    await post({ type: 'echoUser', text: '/firstfold', sessionId: 'a' });
    expect(ringStates(container)).toEqual(['working']);
    await post({ type: 'firstfoldDone', sessionId: 'a' });
    expect(ringStates(container)).toEqual(['ready']);
  });

  it('a /loop scheduled run (which nobody typed) also spins — that path posts busy, not echoUser', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b'));
    await post({ type: 'busy', sessionId: 'b' });
    expect(ringStates(container)).toEqual(['idle', 'working']);
  });

  it('every terminal stopReason settles the ring — an error or a block is still the turn coming back to you', async () => {
    const { container } = render(SidebarLauncher);
    for (const stopReason of ['error', 'blocked', 'idle', 'loop_run', 'max_tokens']) {
      await post(sessionList('a'));
      await post({ type: 'echoUser', text: 'go', sessionId: 'a' });
      expect(ringStates(container)).toEqual(['working']);
      await post({ type: 'turnDone', stopReason, sessionId: 'a' });
      expect(ringStates(container), `stopReason ${stopReason} left the ring spinning`).toEqual(['ready']);
    }
  });

  it('activity for an unknown or absent session changes nothing — no ring lights on the wrong chat', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b'));
    await post({ type: 'echoUser', text: 'x', sessionId: 'ghost' });
    await post({ type: 'turnDone', stopReason: 'end_turn' });          // no sessionId at all
    await post({ type: 'busy', sessionId: undefined });
    expect(ringStates(container)).toEqual(['idle', 'idle']);
  });

  it('a re-sent session list keeps a live ring — a mid-turn chat does not lose its state to the reorder echo', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b'));
    await post({ type: 'echoUser', text: 'x', sessionId: 'a' });
    await post({ type: 'turnDone', stopReason: 'end_turn', sessionId: 'b' });

    // The host echoes the settled order back after a reorder — same rows, new order.
    await post(sessionList('b', 'a'));
    expect(rowIds(container)).toEqual(['b', 'a']);
    expect(ringStates(container)).toEqual(['ready', 'working']);
  });

  it('a newly created chat starts with no ring', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a'));
    await post({ type: 'echoUser', text: 'x', sessionId: 'a' });
    await post({ type: 'sessionCreated', sessionId: 'b', sessionNumber: 2, agentName: 'Tsuru' });
    expect(ringStates(container)).toEqual(['working', 'idle']);
  });
});

// A THIRD ring state: 'waiting' — the engine is parked on the user, either a
// tool-permission ask or an agent question is open (both land on the wire as
// the same `requestPermission` ask; see sessionRowState.ts's file header for
// why they are not told apart here). It beats 'working': an ask mid-turn is
// not the engine moving, it is the engine stopped and waiting on you.
describe('SidebarLauncher — the waiting-for-user ring state', () => {
  it('a requestPermission for a chat sets its ring to waiting — an approval is open', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b'));
    await post({
      type: 'requestPermission', toolCallId: 't1', title: 'Run a command', kind: 'execute', sessionId: 'a',
      options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }, { optionId: 'allow_always', name: 'Always', kind: 'allow_always' }, { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }],
    });
    expect(ringStates(container)).toEqual(['waiting', 'idle']);
  });

  it('a question-shaped requestPermission (no allow_always) also sets the ring to waiting — one semantic state either way', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a'));
    await post({
      type: 'requestPermission', toolCallId: 't2', title: 'Which approach?', kind: 'other', sessionId: 'a',
      options: [{ optionId: 'opt1', name: 'A', kind: 'option' }, { optionId: 'opt2', name: 'B', kind: 'option' }],
    });
    expect(ringStates(container)).toEqual(['waiting']);
  });

  it('waiting beats working — an approval mid-turn parks the ring, it does not keep spinning', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a'));
    await post({ type: 'echoUser', text: 'go', sessionId: 'a' });
    expect(ringStates(container)).toEqual(['working']);
    await post({ type: 'requestPermission', toolCallId: 't3', title: 'Write a file', sessionId: 'a', options: [] });
    expect(ringStates(container)).toEqual(['waiting']);
  });

  // The host posts a `permissionAudit` action:'requested' entry for the activity
  // feed RIGHT AFTER the `requestPermission` broadcast itself (DashboardPanel.ts,
  // onPermissionRequest) — that must not be mistaken for the resolution audit
  // ('approved'/'denied') that actually clears the ask, or the ring would flash
  // waiting for one tick and drop straight back.
  it('the host\'s own "requested" audit entry does not clear the waiting ring', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a'));
    await post({ type: 'requestPermission', toolCallId: 't4', title: 'Run a command', sessionId: 'a', options: [] });
    await post({ type: 'permissionAudit', toolCallId: 't4', title: 'Run a command', kind: 'execute', action: 'requested', timestamp: '10:00' });
    expect(ringStates(container)).toEqual(['waiting']);
  });

  it('answering the ask (permissionAudit approved) clears the waiting ring', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a'));
    await post({ type: 'requestPermission', toolCallId: 't5', title: 'x', sessionId: 'a', options: [] });
    expect(ringStates(container)).toEqual(['waiting']);
    await post({ type: 'permissionAudit', toolCallId: 't5', action: 'approved', optionId: 'allow_once', timestamp: '10:00' });
    expect(ringStates(container)).toEqual(['idle']);
  });

  it('answering the ask (permissionAudit denied) clears the waiting ring too', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a'));
    await post({ type: 'requestPermission', toolCallId: 't5b', title: 'x', sessionId: 'a', options: [] });
    await post({ type: 'permissionAudit', toolCallId: 't5b', action: 'denied', optionId: 'cancelled', timestamp: '10:00' });
    expect(ringStates(container)).toEqual(['idle']);
  });

  // Cancel/Stop answers every queued ask host-side without necessarily emitting
  // its own permissionAudit for each one (DashboardPanel.ts drains
  // pendingPermissions directly on 'cancel'); the turnDone that always follows
  // (the in-flight prompt() settling) is the belt-and-braces backstop that must
  // still drop a stale waiting ring.
  it('turnDone clears a still-open waiting ring too — the Cancel backstop', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a'));
    await post({ type: 'echoUser', text: 'go', sessionId: 'a' });
    await post({ type: 'requestPermission', toolCallId: 't6', title: 'x', sessionId: 'a', options: [] });
    expect(ringStates(container)).toEqual(['waiting']);
    await post({ type: 'turnDone', stopReason: 'cancelled', sessionId: 'a' });
    expect(ringStates(container)).toEqual(['ready']);
  });

  it('a permissionAudit for a toolCallId nobody is waiting on changes nothing', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b'));
    await post({ type: 'requestPermission', toolCallId: 't7', title: 'x', sessionId: 'a', options: [] });
    await post({ type: 'permissionAudit', toolCallId: 'ghost-toolcall', action: 'approved', optionId: 'allow_once', timestamp: '10:00' });
    expect(ringStates(container)).toEqual(['waiting', 'idle']);
  });

  it('a re-sent session list (the reorder echo) keeps a waiting ring too, same as a working one', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b'));
    await post({ type: 'requestPermission', toolCallId: 't8', title: 'x', sessionId: 'a', options: [] });
    expect(ringStates(container)).toEqual(['waiting', 'idle']);

    await post(sessionList('b', 'a'));
    expect(rowIds(container)).toEqual(['b', 'a']);
    expect(ringStates(container)).toEqual(['idle', 'waiting']);
  });

  // t-q41knp — a `requestPermission` posted before this webview's listener
  // registers (a real boot race: a session created — and immediately asked —
  // before the sidebar's Svelte app finished mounting) used to be lost
  // forever: `prior` starts empty, and nothing ever re-sent that ONE message.
  // The mount-time handshake now carries the host's own pending-ask ground
  // truth (`pendingAskIds`), so the very FIRST sessionList reply recovers it —
  // simulated here with NO requestPermission ever seen live by this component.
  it('recovers a waiting ring from the FIRST sessionList reply alone — the ask never had to be seen live', async () => {
    const { container } = render(SidebarLauncher);
    await post({
      type: 'sessionList',
      sessions: [
        { id: 'a', number: 1, agentName: 'Tsuru', pendingAskIds: ['t9'] },
        { id: 'b', number: 2, agentName: 'Tsuru', pendingAskIds: [] },
      ],
    });
    expect(ringStates(container)).toEqual(['waiting', 'idle']);
  });

  it('a sessionList with no pendingAskIds field (an older host reply) does not clear an ask already tracked live', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a'));
    await post({ type: 'requestPermission', toolCallId: 't10', title: 'x', sessionId: 'a', options: [] });
    expect(ringStates(container)).toEqual(['waiting']);
    await post({ type: 'sessionList', sessions: [{ id: 'a', number: 1, agentName: 'Tsuru' }] });
    expect(ringStates(container)).toEqual(['waiting']);
  });
});

// The ring moved from a small dot beside the row to a border wrapping the
// WHOLE pill. jsdom cannot render the actual conic-gradient/mask CSS, so what
// is asserted is what IS observable: (1) the ring has no child elements in
// any state — the sweep is a background on the ring node itself, not a
// rotating overlay that could outgrow it — and (2) the source genuinely
// wires the required colours, the @property-driven angle animation and the
// reduced-motion branch, rather than trusting a description of intent.
//
// There used to be an oversized rotating child (.session-ring-sweep,
// inset:-50%, transform: rotate()) here. It was removed: its bounding box
// grew as it rotated and could escape clipping up the ancestor chain,
// intermittently widening the scrollable area (the reported flicker). The
// replacement animates the conic-gradient's own start-angle via a registered
// <angle> custom property, so nothing with its own box ever moves.
describe('SidebarLauncher — activity border presentation', () => {
  it('no row ever renders a child inside the ring, in any state — the sweep cannot outgrow the ring\'s own box', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b', 'c'));
    await post({ type: 'echoUser', text: 'x', sessionId: 'a' });        // a -> working
    await post({ type: 'turnDone', stopReason: 'end_turn', sessionId: 'b' }); // b -> ready
    // c stays idle

    const rings = container.querySelectorAll('.session-ring');
    expect(Array.from(rings).map((r) => r.getAttribute('data-state'))).toEqual(['working', 'ready', 'idle']);
    for (const ring of Array.from(rings)) {
      expect(ring.children).toHaveLength(0);
    }
  });

  // The remaining source-regex checks (ring positioning CSS, the @property
  // angle, colours + reduced-motion) moved to ChatsList.test.ts at t-kgserq —
  // the ring CSS itself moved there when the Chats half was extracted, so a
  // test still reading THIS file's source would be checking the wrong file.
});

// Reordering is only useful if it STICKS, so the two halves both matter: the list
// repaints immediately (no round-trip lag under the pointer) and the host is told
// the full new order (it owns persistence).
describe('SidebarLauncher — drag to reorder chats', () => {
  async function dragRowOnto(container: HTMLElement, from: number, to: number) {
    const rows = container.querySelectorAll('.session-row');
    await fireEvent.dragStart(rows[from]);
    await fireEvent.dragOver(rows[to]);
    await fireEvent.drop(rows[to]);
  }

  it('dropping a chat onto an earlier row moves it there and posts the whole new order', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b', 'c'));
    expect(rowIds(container)).toEqual(['a', 'b', 'c']);

    await dragRowOnto(container, 2, 0);

    expect(rowIds(container)).toEqual(['c', 'a', 'b']);
    expect(posts()).toContainEqual({ type: 'reorderSessions', order: ['c', 'a', 'b'] });
  });

  it('dropping onto a later row moves it down', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b', 'c'));
    await dragRowOnto(container, 0, 2);
    expect(rowIds(container)).toEqual(['b', 'c', 'a']);
    expect(posts()).toContainEqual({ type: 'reorderSessions', order: ['b', 'c', 'a'] });
  });

  it('the posted order carries EVERY chat, not just the moved one — the host rebuilds from it', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b', 'c', 'd'));
    await dragRowOnto(container, 3, 1);
    const reorder = posts().find((p) => (p as { type: string }).type === 'reorderSessions');
    expect(reorder).toEqual({ type: 'reorderSessions', order: ['a', 'd', 'b', 'c'] });
  });

  it('dropping a chat back on itself is a no-op — no order posted for a drag that changed nothing', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b', 'c'));
    await dragRowOnto(container, 1, 1);
    expect(rowIds(container)).toEqual(['a', 'b', 'c']);
    expect(posts().filter((p) => (p as { type: string }).type === 'reorderSessions')).toEqual([]);
  });

  it('a drop with no drag in progress is ignored — a file dragged in from outside cannot shuffle the list', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b', 'c'));
    await fireEvent.drop(container.querySelectorAll('.session-row')[0]);
    expect(rowIds(container)).toEqual(['a', 'b', 'c']);
    expect(posts().filter((p) => (p as { type: string }).type === 'reorderSessions')).toEqual([]);
  });

  it('the drop indicator marks the edge the row would land on, and clears when the drag ends', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b', 'c'));
    const rows = () => container.querySelectorAll('.session-row');

    await fireEvent.dragStart(rows()[2]);
    await fireEvent.dragOver(rows()[0]);           // moving UP -> land above row 0
    expect(rows()[0].className).toContain('drop-above');
    expect(rows()[0].className).not.toContain('drop-below');
    expect(rows()[2].className).toContain('dragging');

    await fireEvent.dragEnd(rows()[2]);
    expect(container.querySelector('.drop-above')).toBeNull();
    expect(container.querySelector('.dragging')).toBeNull();
  });

  it('dragging DOWN marks the lower edge instead', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b', 'c'));
    const rows = container.querySelectorAll('.session-row');
    await fireEvent.dragStart(rows[0]);
    await fireEvent.dragOver(rows[2]);
    expect(rows[2].className).toContain('drop-below');
    expect(rows[2].className).not.toContain('drop-above');
  });

  it('a row being renamed is not draggable — the drag must not fight text selection', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b'));
    expect(container.querySelectorAll('.session-row[draggable="true"]')).toHaveLength(2);

    await fireEvent.click(screen.getAllByRole('button', { name: 'Rename chat' })[0]);
    const rows = container.querySelectorAll('.session-row');
    expect(rows[0].getAttribute('draggable')).toBe('false');
    expect(rows[1].getAttribute('draggable')).toBe('true');
  });
});

// Collabs went LIVE at M1: the half now lists real collabs, creates one, and
// opens it in its own editor tab. The placeholder tests that used to live here
// (no controls, "No collabs yet" verbatim) were the correct assertions for a
// section that promised nothing, and are deliberately gone with it.
//
// What is pinned down instead is the wire, because that is what the host and
// the engine lane both build against: which messages leave, with which fields,
// and that nothing appears in the list that a `collab_list` did not return.
function collabList(...titles: string[]): unknown {
  return { type: 'collabList', collabs: titles.map((t, n) => ({ id: `c${n + 1}`, title: t, createdAt: '', loopBreakerCap: null })) };
}
function collabRowTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.collab-row .session-name')).map((n) => n.textContent ?? '');
}

describe('SidebarLauncher — Collabs half', () => {
  // M3: create is title-only now — the agent roster is the collab PANE's
  // concern (its own Invite popover), not this half's. This half's handshake
  // shrank to match: it never sends requestCollabAgents at all any more.
  it('asks the host for the collab list on mount — never the agent roster, which moved to the collab pane', () => {
    render(SidebarLauncher);
    expect(posts()).toContainEqual({ type: 'requestCollabs' });
    expect(posts().filter((p) => (p as { type: string }).type === 'requestCollabAgents')).toEqual([]);
  });

  // The handshake can land before the engine has a session, and `collab_list`
  // then answers "open a chat first". Nothing else would ever ask again, so
  // that message would sit in the Collabs half forever on a fresh window.
  it('retries the handshake when a session finally appears, and clears the stale no-engine message', async () => {
    const { container } = render(SidebarLauncher);
    await post({ type: 'collabList', collabs: [], error: 'Open a chat first — this needs a live engine connection.' });
    expect(container.querySelector('.collab-error')).not.toBeNull();

    globalThis.__vscodeApiMock.postMessage.mockClear();
    await post({ type: 'sessionCreated', sessionId: 'a', sessionNumber: 1, agentName: 'Tsuru' });
    expect(posts()).toContainEqual({ type: 'requestCollabs' });

    await post(collabList('Storm plan'));
    expect(container.querySelector('.collab-error')).toBeNull();
    expect(collabRowTitles(container)).toEqual(['Storm plan']);
  });

  it('an ordinary new chat costs no extra round trip once collabs are already answered', async () => {
    render(SidebarLauncher);
    await post({ type: 'collabList', collabs: [] });
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await post({ type: 'sessionCreated', sessionId: 'a', sessionNumber: 1, agentName: 'Tsuru' });
    expect(posts().filter((p) => (p as { type: string }).type === 'requestCollabs')).toEqual([]);
  });

  it('renders one row per collab returned, in the order the engine sent them', async () => {
    const { container } = render(SidebarLauncher);
    await post(collabList('Storm plan', 'Wire review'));
    expect(collabRowTitles(container)).toEqual(['Storm plan', 'Wire review']);
    expect(container.querySelector('.collabs-empty')).toBeNull();
  });

  it('an empty list shows the empty state, not a blank half', async () => {
    const { container } = render(SidebarLauncher);
    await post({ type: 'collabList', collabs: [] });
    expect(container.querySelector('.collabs-empty')).not.toBeNull();
    expect(collabRowTitles(container)).toEqual([]);
  });

  it('a collab with no usable id is dropped rather than rendered as a nameless row', async () => {
    const { container } = render(SidebarLauncher);
    await post({ type: 'collabList', collabs: [{ title: 'ghost' }, { id: 'c9', title: 'real' }] });
    expect(collabRowTitles(container)).toEqual(['real']);
  });

  it('clicking a collab asks the host to open ITS tab, carrying the id and the title', async () => {
    const { container } = render(SidebarLauncher);
    await post(collabList('Storm plan'));
    await fireEvent.click(container.querySelector('.collab-row .session-open') as HTMLElement);
    expect(posts()).toContainEqual({ type: 'openCollab', collabId: 'c1', title: 'Storm plan' });
  });

  // M3 (Slack model, owner's call): create is TITLE-ONLY. No roster to pick
  // here at all — the room opens with nobody in it and agents join afterward
  // from the collab's own pane (its Invite popover, see CollabPane.test.ts).
  it('creating a collab posts the typed title with an empty agentSlugs — no roster to wait on or pick from', async () => {
    const { container } = render(SidebarLauncher);
    await fireEvent.click(screen.getByRole('button', { name: /New collab/ }));
    const input = container.querySelector('.collab-new input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '  Storm plan  ' } });
    await fireEvent.keyDown(input, { key: 'Enter' });

    expect(posts()).toContainEqual({ type: 'newCollab', title: 'Storm plan', agentSlugs: [] });
  });

  it('an empty title creates nothing — Enter on a blank input closes the form and posts no newCollab', async () => {
    const { container } = render(SidebarLauncher);
    await fireEvent.click(screen.getByRole('button', { name: /New collab/ }));
    const input = container.querySelector('.collab-new input') as HTMLInputElement;
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(posts().filter((p) => (p as { type: string }).type === 'newCollab')).toEqual([]);
    expect(container.querySelector('.collab-new')).toBeNull();
  });

  it('Escape abandons the form without creating anything', async () => {
    const { container } = render(SidebarLauncher);
    await fireEvent.click(screen.getByRole('button', { name: /New collab/ }));
    const input = container.querySelector('.collab-new input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'Nope' } });
    await fireEvent.keyDown(input, { key: 'Escape' });
    expect(posts().filter((p) => (p as { type: string }).type === 'newCollab')).toEqual([]);
    expect(container.querySelector('.collab-new')).toBeNull();
  });

  it('a refused create is SHOWN — the user is never left staring at a list that silently did not grow', async () => {
    const { container } = render(SidebarLauncher);
    await post({ type: 'collabCreated', collab: null, error: 'no collab-capable agents' });
    expect(container.querySelector('.collab-error')!.textContent).toContain('no collab-capable agents');
  });

  it('a successful create announces nothing on its own — the list broadcast that follows is the confirmation', async () => {
    const { container } = render(SidebarLauncher);
    await post({ type: 'collabCreated', collab: { id: 'c1', title: 'Storm plan', createdAt: '', loopBreakerCap: null } });
    expect(container.querySelector('.collab-error')).toBeNull();
    // Nothing is spliced in locally: until a collabList arrives, the half is empty.
    expect(collabRowTitles(container)).toEqual([]);
    await post(collabList('Storm plan'));
    expect(collabRowTitles(container)).toEqual(['Storm plan']);
  });

  it('chat rows and collab rows stay in their own halves', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b'));
    await post(collabList('Storm plan'));
    const chatsHalf = container.querySelector('.chats-half')!;
    const collabsHalf = container.querySelector('.collabs-half')!;
    expect(chatsHalf.querySelectorAll('.collab-row')).toHaveLength(0);
    expect(collabsHalf.querySelectorAll('.session-row')).toHaveLength(1);
    expect(collabsHalf.querySelectorAll('.collab-row')).toHaveLength(1);
  });
});

// M2 — the half gained an archive flow, a History subsection and per-row
// activity rings, and moved into CollabsList.svelte to pay for them under the
// launcher's architecture cap. It is still driven entirely through the
// launcher here, so these assert the SHIPPED surface, not the child in isolation.
describe('SidebarLauncher — archiving a collab', () => {
  const rowClose = (c: HTMLElement) => c.querySelector('.collab-row .session-close') as HTMLElement;

  it('the x asks first — no collabArchive goes out until the confirm is taken', async () => {
    const { container } = render(SidebarLauncher);
    await post(collabList('Storm plan'));
    await fireEvent.click(rowClose(container));
    expect(posts().filter((p) => (p as { type: string }).type === 'collabArchive')).toEqual([]);
    expect(container.querySelector('.collab-confirm')!.textContent).toContain('Storm plan');

    await fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(posts()).toContainEqual({ type: 'collabArchive', collabId: 'c1' });
  });

  it('Cancel archives nothing and closes the confirm', async () => {
    const { container } = render(SidebarLauncher);
    await post(collabList('Storm plan'));
    await fireEvent.click(rowClose(container));
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(posts().filter((p) => (p as { type: string }).type === 'collabArchive')).toEqual([]);
    expect(container.querySelector('.collab-confirm')).toBeNull();
  });

  it('an archived collab leaves the live list for History, and is still openable there', async () => {
    const { container } = render(SidebarLauncher);
    await post({
      type: 'collabList',
      collabs: [
        { id: 'c1', title: 'Storm plan' },
        { id: 'c2', title: 'Old room', archivedAt: '2026-08-04T09:00:00.000Z' },
      ],
    });
    // The live list holds only the live one; History is collapsed until asked for.
    expect(collabRowTitles(container)).toEqual(['Storm plan']);
    expect(container.querySelector('.collab-history')).toBeNull();

    // Scoped to the Collabs half on purpose: the Chats half has its own
    // History control, and a test that could not tell them apart would pass
    // just as happily if this button were wired to the wrong list.
    const collabsHalf = container.querySelector('.collabs-half')!;
    await fireEvent.click(within(collabsHalf).getByRole('button', { name: /History/ }));
    // The archived list is the shared HistoryDropdown now — same rooms, same
    // open path, drawn by the component the Chats half already uses.
    const archivedRows = within(collabsHalf as HTMLElement).getAllByRole('button', { name: /Old room/ });
    expect(archivedRows.map((n) => n.querySelector('.history-title')?.textContent)).toEqual(['Old room']);

    await fireEvent.click(archivedRows[0]!);
    expect(posts()).toContainEqual({ type: 'openCollab', collabId: 'c2', title: 'Old room' });
  });

  it('no History control at all when nothing is archived — an empty drawer is not worth a button', async () => {
    const { container } = render(SidebarLauncher);
    await post(collabList('Storm plan'));
    const collabsHalf = container.querySelector('.collabs-half')!;
    expect(within(collabsHalf).queryByRole('button', { name: /History/ })).toBeNull();
    expect(container.querySelector('.collab-history')).toBeNull();
  });

  it('a refused archive is SHOWN rather than leaving the row looking closed', async () => {
    const { container } = render(SidebarLauncher);
    await post(collabList('Storm plan'));
    await post({ type: 'collabOpResult', op: 'collabArchive', collabId: 'c1', ok: false, error: 'collab is already archived' });
    expect(container.querySelector('.collab-error')!.textContent).toContain('already archived');
  });
});

// The ring rides the collab PANE's poll replies, which the host fans out to
// every view. That is the whole design: no second timer in the sidebar, and no
// ring at all for a collab nobody has open.
describe('SidebarLauncher — collab activity rings', () => {
  const ringOf = (c: HTMLElement) => (c.querySelector('.collab-ring') as HTMLElement).getAttribute('data-state');

  const stateFor = (id: string, states: string[]) => ({
    type: 'collabStateData',
    collabId: id,
    sinceSeq: 0,
    agents: states.map((state, i) => ({ slug: `a${i}`, state })),
  });

  it('a collab nobody has open draws no ring state', async () => {
    const { container } = render(SidebarLauncher);
    await post(collabList('Storm plan'));
    expect(ringOf(container)).toBe('idle');
  });

  it('any agent working lights the ring; everyone idle AFTER that settles it to ready', async () => {
    const { container } = render(SidebarLauncher);
    await post(collabList('Storm plan'));

    await post(stateFor('c1', ['idle', 'running']));
    expect(ringOf(container)).toBe('working');

    await post(stateFor('c1', ['idle', 'idle']));
    expect(ringOf(container)).toBe('ready');
  });

  it('queued counts as working — an agent waiting its turn is not finished', async () => {
    const { container } = render(SidebarLauncher);
    await post(collabList('Storm plan'));
    await post(stateFor('c1', ['queued']));
    expect(ringOf(container)).toBe('working');
  });

  it('an all-idle payload with no prior activity does NOT claim to be waiting on you', async () => {
    const { container } = render(SidebarLauncher);
    await post(collabList('Storm plan'));
    await post(stateFor('c1', ['idle', 'idle']));
    expect(ringOf(container)).toBe('idle');
  });

  it('a payload for another collab cannot light this row — the host fans every reply out to every view', async () => {
    const { container } = render(SidebarLauncher);
    await post(collabList('Storm plan'));
    await post(stateFor('c-other', ['running']));
    expect(ringOf(container)).toBe('idle');
  });
});

// Chats and Collabs used to be one stacked list (Collabs directly under the
// last chat row); UAT asked for a dedicated half each so a long chat list can
// no longer push the (still-empty, but real) Collabs section off-screen. This
// pins down the actual split: two named halves sharing one parent, a divider
// between them at the midline, and Memory left OUTSIDE the split so it is
// never swallowed by either half.
describe('SidebarLauncher — Chats/Collabs 50/50 split', () => {
  it('Chats and Collabs are two halves of one split container, divided at the midline', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a'));

    const split = container.querySelector('.chats-collabs-split');
    const chatsHalf = container.querySelector('.chats-half');
    const collabsHalf = container.querySelector('.collabs-half');
    const divider = container.querySelector('.section-divider');
    expect(split).not.toBeNull();
    expect(chatsHalf).not.toBeNull();
    expect(collabsHalf).not.toBeNull();
    expect(divider).not.toBeNull();

    // All three are direct children of the split, in top-half / divider / bottom-half order.
    const children = Array.from(split!.children);
    expect(children[0]).toBe(chatsHalf);
    expect(children[1]).toBe(divider);
    expect(children[2]).toBe(collabsHalf);
    expect(children).toHaveLength(3);
  });

  it('the Chats half holds the toolbar and the session list; the Collabs half holds its own empty state', async () => {
    const { container } = render(SidebarLauncher);
    await post(sessionList('a', 'b'));

    const chatsHalf = container.querySelector('.chats-half')!;
    const collabsHalf = container.querySelector('.collabs-half')!;
    expect(chatsHalf.querySelector('.chats-toolbar')).not.toBeNull();
    expect(chatsHalf.querySelectorAll('.session-row')).toHaveLength(2);
    expect(collabsHalf.querySelector('.collabs-empty')).not.toBeNull();
    // Not cross-contaminated: a chat row is not also findable inside Collabs.
    expect(collabsHalf.querySelectorAll('.session-row')).toHaveLength(0);
  });

  it('Memory sits below the split, reachable, not swallowed into either half', async () => {
    const { container } = render(SidebarLauncher);
    const split = container.querySelector('.chats-collabs-split')!;
    const memory = container.querySelector('.memory-section');
    expect(memory).not.toBeNull();
    expect(split.contains(memory)).toBe(false);
    // Memory follows the split as a sibling, not the other way round.
    const launcherChildren = Array.from(container.querySelector('.launcher')!.children);
    expect(launcherChildren.indexOf(memory as Element)).toBeGreaterThan(launcherChildren.indexOf(split));
  });

  it('each half is set up as its own independent scroll region, not one shared scroll with the split', () => {
    const src = readFileSync(join(__dirname, 'SidebarLauncher.svelte'), 'utf-8');
    expect(src).toMatch(/\.chats-half,\s*\.collabs-half\s*\{[^}]*flex:\s*1 1 0;[^}]*overflow-y:\s*auto;/);
  });

  // The reported flicker was a HORIZONTAL scrollbar appearing/disappearing.
  // Each half clips horizontally too, so nothing inside it (long titles, the
  // activity ring, etc.) can ever widen the sidebar's scrollable area.
  it('each half also clips horizontally, so nothing inside it can open a horizontal scrollbar', () => {
    const src = readFileSync(join(__dirname, 'SidebarLauncher.svelte'), 'utf-8');
    expect(src).toMatch(/\.chats-half,\s*\.collabs-half\s*\{[^}]*overflow-y:\s*auto;[^}]*overflow-x:\s*hidden;/);
  });
});

// --- The Chats half's History panel is HistoryDropdown.svelte now (the same
// component the Collabs half draws its archive with). What stays HERE is the
// filter: a chat is findable by its FOLDER as well as its title, which the
// collabs half has no equivalent of. An extraction that quietly dropped that
// would leave the panel looking identical and finding less.
describe('SidebarLauncher — the Chats History panel', () => {
  const HISTORY = {
    type: 'historyList',
    sessions: [
      { sessionId: 'h1', title: 'Storm plan', folder: 'aetheron', updatedAt: '2026-08-05T09:00:00.000Z' },
      { sessionId: 'h2', title: 'Parser rewrite', folder: 'origami', updatedAt: '2026-08-04T09:00:00.000Z' },
    ],
  };

  async function openHistory(container: HTMLElement): Promise<HTMLElement> {
    const chatsHalf = container.querySelector('.chats-half') as HTMLElement;
    await fireEvent.click(within(chatsHalf).getByRole('button', { name: /History/ }));
    return chatsHalf;
  }
  const titles = (c: HTMLElement) =>
    Array.from(c.querySelectorAll('.history-row .history-title')).map((n) => n.textContent);

  it('asks the host for the list and shows every past chat with its folder and date', async () => {
    const { container } = render(SidebarLauncher);
    const chatsHalf = await openHistory(container as HTMLElement);
    expect(posts()).toContainEqual({ type: 'requestHistory' });
    // Until the reply lands it says it is loading, rather than "no past chats".
    expect(chatsHalf.querySelector('.history-empty')!.textContent).toBe('Loading…');

    await post(HISTORY);
    expect(titles(chatsHalf)).toEqual(['Storm plan', 'Parser rewrite']);
    expect(chatsHalf.querySelector('.history-meta')!.textContent).toContain('aetheron');
  });

  it('filters on the FOLDER as well as the title — the rule this half owns', async () => {
    const { container } = render(SidebarLauncher);
    const chatsHalf = await openHistory(container as HTMLElement);
    await post(HISTORY);

    const search = chatsHalf.querySelector('.history-search') as HTMLInputElement;
    await fireEvent.input(search, { target: { value: 'origami' } });
    await tick();
    // 'origami' appears in no title — only in the folder.
    expect(titles(chatsHalf)).toEqual(['Parser rewrite']);
  });

  it('says "no matches" when the filter empties the list, and "none yet" when there were none', async () => {
    const { container } = render(SidebarLauncher);
    const chatsHalf = await openHistory(container as HTMLElement);
    await post(HISTORY);

    await fireEvent.input(chatsHalf.querySelector('.history-search') as HTMLInputElement, { target: { value: 'zzz' } });
    await tick();
    expect(chatsHalf.querySelector('.history-empty')!.textContent).toBe('No matches.');

    await post({ type: 'historyList', sessions: [] });
    expect(chatsHalf.querySelector('.history-empty')!.textContent).toBe('No past chats yet.');
  });

  it('picking one recalls THAT session and closes the panel', async () => {
    const { container } = render(SidebarLauncher);
    const chatsHalf = await openHistory(container as HTMLElement);
    await post(HISTORY);

    await fireEvent.click(chatsHalf.querySelectorAll('.history-row')[1] as HTMLElement);
    await tick();
    expect(posts()).toContainEqual({ type: 'recallSession', sessionId: 'h2' });
    expect(chatsHalf.querySelector('.history-dropdown')).toBeNull();
  });
});

// t-kgserq — the Chats/Collabs divider becomes draggable so the Collabs half
// can be shrunk. jsdom has no layout engine (getBoundingClientRect is always
// a zero DOMRect), so what is checkable here is the WIRING — a drag/keyboard
// gesture reaches clampCollabsHeight and its result is posted to the host —
// not the actual pixel math a real drag would produce; that needs a human
// eyeball (see WORKING_ON_ORIGAMI_CODER.md's jsdom-layout caveat).
describe('SidebarLauncher — draggable Chats/Collabs divider', () => {
  it('asks the host for the persisted height on mount', () => {
    render(SidebarLauncher);
    expect(posts()).toContainEqual({ type: 'requestCollabsHeight' });
  });

  it('a collabsHeight reply applies as an inline flex-basis on the Collabs half', async () => {
    const { container } = render(SidebarLauncher);
    await post({ type: 'collabsHeight', heightPx: 240 });
    const collabsHalf = container.querySelector('.collabs-half') as HTMLElement;
    expect(collabsHalf.style.flex).toBe('0 0 240px');
  });

  it('a null collabsHeight reply leaves the half on its default 50/50 flex (no inline override)', async () => {
    const { container } = render(SidebarLauncher);
    await post({ type: 'collabsHeight', heightPx: null });
    const collabsHalf = container.querySelector('.collabs-half') as HTMLElement;
    expect(collabsHalf.style.flex).toBe('');
  });

  it('a full pointer drag on the divider posts the settled height to the host', async () => {
    const { container } = render(SidebarLauncher);
    const divider = container.querySelector('.section-divider') as HTMLElement;

    await fireEvent.pointerDown(divider, { pointerId: 1, clientY: 300 });
    await fireEvent.pointerMove(window, { pointerId: 1, clientY: 250 });
    await fireEvent.pointerUp(window, { pointerId: 1 });

    const resize = posts().find((p) => p.type === 'resizeCollabsSection');
    expect(resize).toBeDefined();
    expect(typeof (resize as { heightPx: unknown }).heightPx).toBe('number');
  });

  it('pointer movement before pointerdown (nothing being dragged) posts nothing', async () => {
    render(SidebarLauncher);
    await fireEvent.pointerMove(window, { pointerId: 1, clientY: 250 });
    await fireEvent.pointerUp(window, { pointerId: 1 });
    expect(posts().filter((p) => p.type === 'resizeCollabsSection')).toEqual([]);
  });

  it('ArrowUp/ArrowDown on the focused divider also resize and post — a keyboard path, not pointer-only', async () => {
    const { container } = render(SidebarLauncher);
    const divider = container.querySelector('.section-divider') as HTMLElement;

    await fireEvent.keyDown(divider, { key: 'ArrowUp' });
    expect(posts().filter((p) => p.type === 'resizeCollabsSection')).toHaveLength(1);

    await fireEvent.keyDown(divider, { key: 'ArrowDown' });
    expect(posts().filter((p) => p.type === 'resizeCollabsSection')).toHaveLength(2);

    // A key this control does not own is ignored — no phantom resize on every keystroke.
    await fireEvent.keyDown(divider, { key: 'Tab' });
    expect(posts().filter((p) => p.type === 'resizeCollabsSection')).toHaveLength(2);
  });

  it('the divider is a real keyboard target — role=separator and tabindex=0', () => {
    const { container } = render(SidebarLauncher);
    const divider = container.querySelector('.section-divider') as HTMLElement;
    expect(divider.getAttribute('role')).toBe('separator');
    expect(divider.getAttribute('tabindex')).toBe('0');
  });
});
