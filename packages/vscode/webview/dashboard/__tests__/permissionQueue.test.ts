// Sub-agent stall — the webview half. A sub-agent has no ACP session of its own, so
// the engine forwards its permission ask under the nearest registered ANCESTOR
// (packages/engine/src/acp/permission.ts). N concurrent children therefore all land
// on ONE chat session, and ChatPane had exactly ONE permission slot: `s.permission =
// {...}` overwrote whatever was on the bar. Last writer won, the displaced asks were
// never re-posted, and N-1 children hung at zero tokens forever (observed live: 3
// background children, 1 finished, 2 hung 32 minutes).
//
// These render the REAL ChatPane and drive it through the real `requestPermission`
// message it receives from the extension, then click the real buttons. They assert
// what the user gets: every ask reachable, an honest count of what is still waiting,
// and no duplicate stacking. Revert to a single slot and 1, 2, 4 and 5 go red.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { HOLD_MS } from '../components/holdToStop';
import ChatPane from '../panes/ChatPane.svelte';

const SESSION = 'sess-1';

function post(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

/** The extension's real `requestPermission` post (DashboardPanel.onPermissionRequest). */
function ask(toolCallId: string, title: string): void {
  post({
    type: 'requestPermission',
    sessionId: SESSION,
    askSessionId: SESSION,
    toolCallId,
    title,
    kind: 'execute',
    options: [
      { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  });
}

const posts = () =>
  globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;
const permissionPosts = () => posts().filter((p) => p.type === 'permission');

const bar = (c: HTMLElement) => c.querySelector('.permission-bar');
const barTitle = (c: HTMLElement) => bar(c)?.querySelector('.permission-title span')?.textContent?.trim() ?? null;
const queueChip = (c: HTMLElement) => bar(c)?.querySelector('.perm-queue')?.textContent?.replace(/\s+/g, ' ').trim() ?? null;

async function allowOnce(c: HTMLElement): Promise<void> {
  const button = Array.from(bar(c)!.querySelectorAll('button')).find((b) => b.textContent?.includes('Allow once'))!;
  await fireEvent.click(button);
  await tick();
}

async function mountWithSession(): Promise<HTMLElement> {
  const { container } = render(ChatPane, { props: {} });
  post({ type: 'sessionCreated', sessionId: SESSION, sessionNumber: 1, agentName: 'Tsuru' });
  await tick();
  return container as HTMLElement;
}

describe('ChatPane permission queue — concurrent sub-agent asks', () => {
  beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());
  afterEach(() => cleanup());

  it('1 — four concurrent asks are ALL answerable; none is lost', async () => {
    const c = await mountWithSession();
    for (const n of [1, 2, 3, 4]) ask(`tc${n}`, `ask ${n}`);
    await tick();

    // Only one bar is ever shown, and it shows the FIRST ask (not the last writer).
    expect(c.querySelectorAll('.permission-bar')).toHaveLength(1);
    expect(barTitle(c)).toBe('ask 1');

    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(barTitle(c)!);
      await allowOnce(c);
    }
    expect(seen).toEqual(['ask 1', 'ask 2', 'ask 3', 'ask 4']);

    // Every ask got its own answer on the wire — the engine deferred that never got
    // one is precisely the hang.
    expect(permissionPosts().map((p) => p.toolCallId)).toEqual(['tc1', 'tc2', 'tc3', 'tc4']);
    expect(permissionPosts().every((p) => p.optionId === 'once')).toBe(true);
    expect(bar(c)).toBeNull(); // bar gone once the queue drains
  });

  it('2 — answering the head SURFACES the next one, without a further message', async () => {
    const c = await mountWithSession();
    ask('tc1', 'first');
    ask('tc2', 'second');
    await tick();
    expect(barTitle(c)).toBe('first');

    await allowOnce(c);
    expect(barTitle(c)).toBe('second'); // promoted from the queue, nothing re-posted
    expect(permissionPosts()).toHaveLength(1);
  });

  it('3 — a duplicate toolCallId never stacks a second copy', async () => {
    const c = await mountWithSession();
    ask('tc1', 'first');
    ask('tc1', 'first (re-delivered)');
    ask('tc2', 'second');
    ask('tc2', 'second (re-delivered)');
    await tick();

    expect(barTitle(c)).toBe('first');
    expect(queueChip(c)).toBe('1 of 2'); // two distinct asks, not four
    await allowOnce(c);
    expect(barTitle(c)).toBe('second');
    await allowOnce(c);
    expect(bar(c)).toBeNull();
    expect(permissionPosts().map((p) => p.toolCallId)).toEqual(['tc1', 'tc2']);
  });

  it('4 — the bar SAYS how many are waiting, and the count counts down', async () => {
    const c = await mountWithSession();
    ask('tc1', 'a');
    await tick();
    expect(queueChip(c)).toBeNull(); // a lone ask carries no count

    ask('tc2', 'b');
    ask('tc3', 'c');
    ask('tc4', 'd');
    await tick();
    expect(queueChip(c)).toBe('1 of 4'); // three invisible prompts behind this one is the bug

    await allowOnce(c);
    expect(queueChip(c)).toBe('1 of 3');
    await allowOnce(c);
    expect(queueChip(c)).toBe('1 of 2');
    await allowOnce(c);
    expect(queueChip(c)).toBeNull();
  });

  it('5 — cancel releases EVERY parked ask, not just the visible one', async () => {
    const c = await mountWithSession();
    // A parked ask means a tool is waiting inside a RUNNING turn, which is the
    // only state the composer offers a stop in (there is no Cancel at rest any
    // more). The host's own `busy` frame is what puts the chat there.
    post({ type: 'busy', sessionId: SESSION });
    for (const n of [1, 2, 3]) ask(`tc${n}`, `ask ${n}`);
    await tick();

    // The COMPOSER's cancel, selected exactly. This used to search every button
    // for /stop|cancel/i in its text OR its title, which matched the first
    // button whose TOOLTIP happened to mention stopping — M4.4's YOLO button
    // ("…and stop asking in this chat") sits on the permission bar, above the
    // composer, so the loose search clicked that instead and the test failed
    // for a reason that had nothing to do with the queue. Same assertion, same
    // intent, no longer hostage to another control's prose.
    // Send and Stop are ONE control now, and stopping is a 600ms HOLD so a
    // stray click cannot kill a turn (CHANGES.md round 2, change 25). The
    // assertion is unchanged: the composer's own stop releases the queue.
    const stop = c.querySelector('button.action-btn[data-busy]') as HTMLButtonElement | null;
    expect(stop, 'ChatPane must expose a stop/cancel control').toBeTruthy();
    await fireEvent.pointerDown(stop!, { button: 0, pointerId: 1 });
    await new Promise((r) => setTimeout(r, HOLD_MS + 20));
    await tick();

    // A queued ask left unanswered is a tool call hanging on a prompt nobody can reach.
    expect(permissionPosts().map((p) => p.toolCallId)).toEqual(['tc1', 'tc2', 'tc3']);
    expect(permissionPosts().every((p) => p.optionId === null)).toBe(true);
    expect(bar(c)).toBeNull();
  });
});

// A phone's signed approve, or a signed YOLO that flips the session into
// bypass and releases every ask parked on it (attention.ts's
// releaseBypassedPermissions), resolves an ask this pane never clicked. The
// host tells every webview the same way it tells the sidebar row
// (sessionRowState.ts): a `permissionAudit` with NO sessionId. Before this,
// ChatPane had no handler at all — the bar sat on an ask someone else had
// already answered until the owner clicked it too.
describe('ChatPane permission queue — settled from elsewhere (permissionAudit)', () => {
  beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());
  afterEach(() => cleanup());

  /** The host's resolution post — DashboardPanel.ts's onPermissionRequest
   *  (a local OR phone-delivered click) and releaseBypassedPermissions both
   *  post this shape, and neither carries a sessionId. */
  function audit(toolCallId: string, action: 'approved' | 'denied' = 'approved'): void {
    post({ type: 'permissionAudit', toolCallId, action, optionId: 'once', timestamp: '10:00' });
  }

  it('1 — an audit for the BAR\'s ask promotes the queued one, with no reply on the wire', async () => {
    const c = await mountWithSession();
    ask('tc1', 'first');
    ask('tc2', 'second');
    await tick();
    expect(barTitle(c)).toBe('first');

    audit('tc1');
    await tick();
    expect(barTitle(c)).toBe('second'); // promoted, exactly as a click would
    expect(permissionPosts()).toHaveLength(0); // settling is NOT answering — no reply posted
  });

  it('2 — an audit for a QUEUED ask leaves the bar alone and shortens the queue', async () => {
    const c = await mountWithSession();
    ask('tc1', 'first');
    ask('tc2', 'second');
    ask('tc3', 'third');
    await tick();
    expect(queueChip(c)).toBe('1 of 3');

    audit('tc2'); // the middle one, still queued
    await tick();
    expect(barTitle(c)).toBe('first'); // bar unchanged
    expect(queueChip(c)).toBe('1 of 2'); // one shorter
  });

  it('3 — a local click then the audit for the SAME id does not double-promote', async () => {
    const c = await mountWithSession();
    ask('tc1', 'first');
    ask('tc2', 'second');
    ask('tc3', 'third');
    await tick();

    await allowOnce(c); // clicks 'first' — promotes to 'second'; 'third' still queued
    expect(barTitle(c)).toBe('second');
    expect(queueChip(c)).toBe('1 of 2'); // as after the click alone: two asks remain
    expect(permissionPosts()).toHaveLength(1);

    audit('tc1'); // the audit for the ask the click already resolved, arriving late
    await tick();
    expect(barTitle(c)).toBe('second'); // unchanged — no second promotion
    expect(queueChip(c)).toBe('1 of 2'); // unchanged — queue length as after the click alone
    expect(permissionPosts()).toHaveLength(1); // still just the one real reply, from the click
  });

  it('4 — an audit for an id nobody is holding changes nothing', async () => {
    const c = await mountWithSession();
    ask('tc1', 'first');
    ask('tc2', 'second');
    await tick();
    expect(queueChip(c)).toBe('1 of 2');

    audit('ghost-toolcall');
    await tick();
    expect(barTitle(c)).toBe('first');
    expect(queueChip(c)).toBe('1 of 2'); // unchanged
  });

  it('5 — a DENIED audit settles the same as an approved one', async () => {
    const c = await mountWithSession();
    ask('tc1', 'first');
    ask('tc2', 'second');
    await tick();

    audit('tc1', 'denied');
    await tick();
    expect(barTitle(c)).toBe('second'); // promoted regardless of which way it was resolved
  });

  it('6 — the OTHER permissionAudit (action:"requested", the activity-feed entry for a fresh ask) is not a resolution and settles nothing', async () => {
    const c = await mountWithSession();
    ask('tc1', 'first');
    ask('tc2', 'second');
    await tick();

    post({ type: 'permissionAudit', toolCallId: 'tc1', title: 'first', kind: 'execute', action: 'requested', timestamp: '10:00' });
    await tick();
    expect(barTitle(c)).toBe('first'); // unchanged — 'requested' is not approved/denied
    expect(queueChip(c)).toBe('1 of 2');
  });
});
