// The sidebar's FRONT DESK section — asserted through the real launcher, and
// only on what jsdom can see: which elements are mounted, and what is posted.
// Whether the badge LOOKS right still needs a human eye; no <style> reaches
// this DOM (vitest.config.mts does not set css:true).
//
// The claims, and why each is worth a test:
//   - the section is BELOW Collabs and starts SHUT, which is the whole reason
//     the count is on the header rather than in the body;
//   - the badge is the number waiting and DISAPPEARS at zero — a badge reading
//     0 is a badge that says "look" for nothing;
//   - and it sits IMMEDIATELY after the label, with the chevron ahead of both.
//     jsdom cannot see the 12px of padding that used to hold it away from the
//     word (no <style> reaches this DOM), so what is pinned here is the order
//     and the adjacency that CSS was written to serve;
//   - Answer/Decline post `flockDecide` naming the THREAD, because an inbound
//     question is a mailbox row now and not a parked permission;
//   - it reads the MAILBOX alone (`flockMailboxRequest`), not `flockRequest`,
//     which is what keeps a thirty-second poll from dragging a whole
//     `flock_state` read behind it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import SidebarLauncher from '../../chat/SidebarLauncher.svelte';

const posts = () =>
  globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;
const typesPosted = () => posts().map((p) => p['type']);
const send = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
// The section's own header button and badge are gone (change 1): the DOCK
// opens it and the DOCK carries the count. Both are read off the dock item.
const toggle = (c: HTMLElement) => c.querySelector('.dock-item[aria-label="Front Desk"]') as HTMLButtonElement;
const badge = (c: HTMLElement) => toggle(c).querySelector('.dock-badge');

const DANA = 'dana@YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5MDE';
const ROBIN = 'robin@Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG0';

const question = (id: string, contact: string, name: string, text: string) => ({
  id,
  contact,
  direction: 'in' as const,
  question: { text, sentAt: '2026-09-05T08:00:00.000Z' },
  state: 'pending' as const,
  unread: true,
  name,
  icon: 'crane',
  handleShort: `${name}@abcdef…`,
});

const QUESTIONS = [
  question('thr_1', DANA, 'dana', 'which tax rules changed in 2026?'),
  question('thr_2', ROBIN, 'robin', 'how do I read a payslip?'),
];

beforeEach(() => {
  globalThis.__vscodeApiMock.postMessage.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Every render below passes flockEnabled: true — origamicoder.flock.enabled
// defaults OFF now (t-5nmeez), so this file (which is entirely about the
// Front Desk section's CONTENT once mounted) opts it in explicitly. The
// off-by-default mount gate itself is proven in flockKillSwitch.test.ts.
describe('SidebarLauncher — the Front Desk section', () => {
  it('sits BELOW Collabs and starts collapsed', async () => {
    const { container } = render(SidebarLauncher, { props: { flockEnabled: true } });
    await tick();

    expect(toggle(container).getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('.fd-body')).toBeNull();

    // Order matters: it is the third section, under Chats and Collabs.
    const html = container.innerHTML;
    expect(html.indexOf('collabs-half')).toBeLessThan(html.indexOf('fd-section'));
  });

  it('asks the host for the QUEUE alone on mount, never the whole flock state', async () => {
    render(SidebarLauncher, { props: { flockEnabled: true } });
    await tick();
    expect(typesPosted()).toContain('flockMailboxRequest');
    expect(typesPosted()).not.toContain('flockRequest');
  });

  it('MUTATION PROOF — the badge is the number waiting, and there is none at zero', async () => {
    const { container } = render(SidebarLauncher, { props: { flockEnabled: true } });
    await tick();
    // Nothing has answered yet: no badge, not a zero.
    expect(badge(container)).toBeNull();

    send({ type: 'flockMailbox', threads: QUESTIONS });
    await tick();
    expect(badge(container)!.textContent).toBe('2');
    expect(badge(container)!.getAttribute('aria-label')).toBe('2 waiting');

    send({ type: 'flockMailbox', threads: [QUESTIONS[0]] });
    await tick();
    expect(badge(container)!.textContent).toBe('1');

    // Back to empty: the badge GOES. A count rendered unconditionally passes
    // every assertion above and then sits there saying 0 for ever.
    send({ type: 'flockMailbox', threads: [] });
    await tick();
    expect(badge(container)).toBeNull();
  });

  it('the badge rides the Front Desk dock item, not some other one', async () => {
    const { container } = render(SidebarLauncher, { props: { flockEnabled: true } });
    await tick();
    send({ type: 'flockMailbox', threads: QUESTIONS });
    await tick();

    // Exactly one badge in the whole dock, and it is on Front Desk. A badge
    // drawn on every item would satisfy a per-item assertion and read as noise.
    expect(container.querySelectorAll('.dock-badge')).toHaveLength(1);
    expect(badge(container)!.textContent).toBe('2');
  });

  it('expanding shows each waiting question, and Answer/Decline post flockDecide', async () => {
    const { container } = render(SidebarLauncher, { props: { flockEnabled: true } });
    await tick();
    send({ type: 'flockMailbox', threads: QUESTIONS });
    await tick();
    await fireEvent.click(toggle(container));
    await tick();

    const rows = Array.from(container.querySelectorAll('.fd-row'));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('.mk-bubble')!.textContent).toBe('which tax rules changed in 2026?');
    // The FULL handle is on the tooltip; the row shows the contact's name.
    expect(rows[0]!.querySelector('.fd-from')!.getAttribute('title')).toBe(QUESTIONS[0].contact);

    // The THREAD id, not a permission id: the two are different things now, and
    // a header that still posted `flockAnswer` would reply to a queue nothing
    // parks on any more — silently, because the host would ignore the message.
    await fireEvent.click(rows[0]!.querySelector('.fd-btn.primary')!);
    expect(posts().at(-1)).toEqual({ type: 'flockDecide', thread: 'thr_1', action: 'answer' });

    await fireEvent.click(Array.from(rows[1]!.querySelectorAll('.fd-btn'))[1]!);
    expect(posts().at(-1)).toEqual({ type: 'flockDecide', thread: 'thr_2', action: 'decline' });
  });

  it('an empty queue says so when opened, rather than an empty box', async () => {
    const { container } = render(SidebarLauncher, { props: { flockEnabled: true } });
    await tick();
    await fireEvent.click(toggle(container));
    await tick();
    expect(container.querySelector('.fd-empty')!.textContent).toContain('Nothing waiting');
  });

  it('Open Flock opens the board AND names the view it should land on', async () => {
    const { container } = render(SidebarLauncher, { props: { flockEnabled: true } });
    await tick();
    await fireEvent.click(toggle(container));
    await tick();
    await fireEvent.click(container.querySelector('.fd-link')!);

    // Two messages, one intent. The section request survives a board that has
    // not attached yet: its own boardReady handshake replays it.
    expect(posts().slice(-2)).toEqual([
      { type: 'openAgentManager' },
      { type: 'openBoardSection', section: 'friends' },
    ]);
  });

  it('ignores a permission event — a question is a mailbox row, not a parked permission', async () => {
    render(SidebarLauncher, { props: { flockEnabled: true } });
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    // It USED to recount here, because a flock question was a parked
    // `Permission.ask` and the broadcast that carried one was a free "something
    // changed". Nothing parks one now, so recounting on every permission in the
    // window would be a mailbox read per tool call for a queue that never moved.
    send({ type: 'requestPermission', toolCallId: 'tc_1', title: 'read', kind: 'other' });
    await tick();
    expect(typesPosted()).toEqual([]);
  });

  it('takes the mailbox the PANE was posted, so deciding over there updates this header', async () => {
    const { container } = render(SidebarLauncher, { props: { flockEnabled: true } });
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    // The pane's own read is broadcast to every webview, so the header needs no
    // wire of its own for a row decided in the FLO pane.
    send({ type: 'flockMailbox', threads: QUESTIONS });
    await tick();
    expect(badge(container)!.textContent).toBe('2');
    expect(typesPosted()).toEqual([]);
  });

  it('polls the queue while the sidebar is open, and stops when it goes away', async () => {
    vi.useFakeTimers();
    const { unmount } = render(SidebarLauncher, { props: { flockEnabled: true } });
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    vi.advanceTimersByTime(60_000);
    expect(typesPosted()).toEqual(['flockMailboxRequest']);
    vi.advanceTimersByTime(60_000);
    expect(typesPosted()).toHaveLength(2);

    // A timer that outlives the sidebar posts into a dead webview for ever.
    unmount();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    vi.advanceTimersByTime(90_000);
    expect(typesPosted()).toEqual([]);
  });
});
