// CollabInviteList — the invite candidates as a MULTI-SELECT list (report 1.3),
// shared by the roster's `+` popover and the setup card.
//
// The friction it removes: building a three-agent room was click `+`, pick,
// click `+`, pick, click `+`, pick — the popover closed after every single
// pick. So the behaviour under test is that a pick does NOT commit; only the
// Invite button does, once, with every slug picked.
//
// It also carries the readiness verdict (report 1.4). The two states that must
// stay apart on screen are the same two collabHealth keeps apart: an UNPINNED
// agent (the shipped seeds' ordinary state) is invitable and merely needs a
// model, while a DEAD provider is a warning.

import { render, screen, fireEvent } from '@testing-library/svelte';
import { beforeEach, describe, expect, it } from 'vitest';
import CollabInviteList from './CollabInviteList.svelte';
import { FS_ONLY_REASON, type InviteCandidate } from './collabInvite';

const candidate = (over: Partial<InviteCandidate> & { slug: string }): InviteCandidate => ({
  displayName: over.slug,
  disabled: false,
  model: null,
  health: { kind: 'unpinned', provider: '' },
  ...over,
});

const CRANE = candidate({ slug: 'collab-crane', displayName: 'Crane', model: 'lmstudio/qwen3.5-35b', health: { kind: 'live', provider: 'lmstudio' } });
const HERON = candidate({ slug: 'collab-heron', displayName: 'Heron', model: 'openrouter/laguna', health: { kind: 'dead', provider: 'openrouter' } });
const WREN = candidate({ slug: 'collab-wren', displayName: 'Wren' });

describe('CollabInviteList — multi-select', () => {
  it('picking two candidates commits BOTH on one Invite click', async () => {
    const calls: string[][] = [];
    render(CollabInviteList, { props: { candidates: [CRANE, HERON, WREN], onInvite: (s: string[]) => calls.push(s) } });

    await fireEvent.click(screen.getByRole('checkbox', { name: /Crane/ }));
    await fireEvent.click(screen.getByRole('checkbox', { name: /Wren/ }));
    // Not committed yet — a pick is a pick, never a send.
    expect(calls).toEqual([]);

    await fireEvent.click(screen.getByRole('button', { name: /^Invite/ }));
    expect(calls).toEqual([['collab-crane', 'collab-wren']]);
  });

  it('every row stays on screen across picks — the list does not collapse after one', async () => {
    render(CollabInviteList, { props: { candidates: [CRANE, HERON, WREN], onInvite: () => {} } });
    await fireEvent.click(screen.getByRole('checkbox', { name: /Crane/ }));

    expect(screen.getByRole('checkbox', { name: /Crane/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('checkbox', { name: /Heron/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('checkbox', { name: /Wren/ })).toBeInTheDocument();
  });

  it('a pick can be taken back before it is committed', async () => {
    const calls: string[][] = [];
    render(CollabInviteList, { props: { candidates: [CRANE, WREN], onInvite: (s: string[]) => calls.push(s) } });

    await fireEvent.click(screen.getByRole('checkbox', { name: /Crane/ }));
    await fireEvent.click(screen.getByRole('checkbox', { name: /Wren/ }));
    await fireEvent.click(screen.getByRole('checkbox', { name: /Crane/ }));
    await fireEvent.click(screen.getByRole('button', { name: /^Invite/ }));

    expect(calls).toEqual([['collab-wren']]);
  });

  it('the selection is cleared after a commit, so a second Invite cannot resend the first pick', async () => {
    const calls: string[][] = [];
    render(CollabInviteList, { props: { candidates: [CRANE, WREN], onInvite: (s: string[]) => calls.push(s) } });

    await fireEvent.click(screen.getByRole('checkbox', { name: /Crane/ }));
    await fireEvent.click(screen.getByRole('button', { name: /^Invite/ }));
    expect(screen.getByRole('checkbox', { name: /Crane/ })).toHaveAttribute('aria-checked', 'false');
    expect(calls).toEqual([['collab-crane']]);
  });

  it('the Invite button states its own precondition rather than being silently inert', async () => {
    render(CollabInviteList, { props: { candidates: [CRANE], onInvite: () => {} } });
    const invite = screen.getByRole('button', { name: /^Invite/ });
    // The M3 scar: a button that refuses a click with nothing on screen saying
    // why. The cause here is one click away and is spelled out in the title.
    expect(invite).toBeDisabled();
    expect(invite.getAttribute('title')).toMatch(/pick/i);

    await fireEvent.click(screen.getByRole('checkbox', { name: /Crane/ }));
    expect(screen.getByRole('button', { name: /^Invite/ })).toBeEnabled();
  });
});

// W8: the setup card's own Next commits the selection, so the card mounts this
// list WITHOUT its button — two buttons for one wire is the duplication this
// shared list exists to remove. The popover, which has no Next, keeps its own,
// which is why the flag defaults ON.
describe('CollabInviteList — the commit button is optional', () => {
  it('draws the Invite button by default', () => {
    render(CollabInviteList, { props: { candidates: [CRANE], onInvite: () => {} } });
    expect(screen.getByRole('button', { name: /^Invite/ })).toBeInTheDocument();
  });

  it('drops it when the mounting surface commits for itself', () => {
    render(CollabInviteList, { props: { candidates: [CRANE], onInvite: () => {}, showInvite: false } });
    expect(screen.queryByRole('button', { name: /^Invite/ })).toBeNull();
  });

  // Dropping the button must not drop the LIST or the escape hatch with it.
  it('keeps the rows pickable and the Bots link alive without it', async () => {
    render(CollabInviteList, { props: { candidates: [CRANE], onInvite: () => {}, showInvite: false } });
    await fireEvent.click(screen.getByRole('checkbox', { name: /Crane/ }));
    expect(screen.getByRole('checkbox', { name: /Crane/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: /Manage bots/i })).toBeInTheDocument();
  });
});

describe('CollabInviteList — model and provider health', () => {
  it("shows each candidate's pinned model", async () => {
    render(CollabInviteList, { props: { candidates: [CRANE], onInvite: () => {} } });
    expect(await screen.findByText('lmstudio/qwen3.5-35b')).toBeInTheDocument();
  });

  it('marks a candidate whose provider is unreachable, naming the provider', async () => {
    render(CollabInviteList, { props: { candidates: [HERON], onInvite: () => {} } });
    expect(await screen.findByText('openrouter unreachable')).toBeInTheDocument();
  });

  it('an UNPINNED candidate says it needs a model and is still pickable', async () => {
    const calls: string[][] = [];
    render(CollabInviteList, { props: { candidates: [WREN], onInvite: (s: string[]) => calls.push(s) } });
    expect(await screen.findByText('needs a model')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('checkbox', { name: /Wren/ }));
    await fireEvent.click(screen.getByRole('button', { name: /^Invite/ }));
    expect(calls).toEqual([['collab-wren']]);
  });

  it('a live pin carries no warning marker at all', () => {
    render(CollabInviteList, { props: { candidates: [CRANE], onInvite: () => {} } });
    expect(screen.queryByText(/unreachable|needs a model/)).toBeNull();
  });
});

describe('CollabInviteList — unloadable defs', () => {
  it('a disabled candidate prints its reason as DOM text and cannot be picked', async () => {
    const calls: string[][] = [];
    const broken = candidate({ slug: 'collab-broken', displayName: 'Broken', disabled: true, reason: FS_ONLY_REASON });
    render(CollabInviteList, { props: { candidates: [broken, CRANE], onInvite: (s: string[]) => calls.push(s) } });

    expect(await screen.findByText(FS_ONLY_REASON)).toBeInTheDocument();
    const row = screen.getByRole('checkbox', { name: /Broken/ });
    expect(row).toBeDisabled();
    await fireEvent.click(row);
    await fireEvent.click(screen.getByRole('checkbox', { name: /Crane/ }));
    await fireEvent.click(screen.getByRole('button', { name: /^Invite/ }));
    expect(calls).toEqual([['collab-crane']]);
  });

  it('an empty candidate list says so instead of drawing an empty box', () => {
    render(CollabInviteList, { props: { candidates: [], onInvite: () => {} } });
    expect(screen.getByText(/No bots available to invite/i)).toBeInTheDocument();
  });
});

// S9 — the DEAD END. This list is where a user finds out a room has no bot
// worth inviting, and until now nothing on it said where a bot comes from. The
// link is not an inline editor: it opens the board's Bots section, which is the
// one place these files are written.
describe('CollabInviteList — the way out to the Bots section', () => {
  const manage = () => screen.getByRole('button', { name: /Manage bots/i });
  const posted = () =>
    globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => (c[0] as { type?: string })?.type);
  beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());

  it('opens the board AND asks it for the Bots section', async () => {
    render(CollabInviteList, { props: { candidates: [CRANE], onInvite: () => {} } });
    await fireEvent.click(manage());
    // BOTH: the first opens or reveals the board tab, the second asks it to
    // land on Bots. One without the other is half a dead end.
    expect(posted()).toContain('openAgentManager');
    expect(posted()).toContain('openBotsSection');
  });

  // The sharpest case, and the reason the link sits OUTSIDE the list's own
  // {#if}: an EMPTY roster is exactly when a user needs to be told where bots
  // come from, and it is the branch a link beside the Invite button misses.
  it('is offered when there is NOTHING to invite, which is when it matters most', async () => {
    render(CollabInviteList, { props: { candidates: [], onInvite: () => {} } });
    await fireEvent.click(manage());
    expect(posted()).toContain('openBotsSection');
  });

  // A room is where bots WORK. Building one here would be a second writer of
  // the same def files, and the pane it links to is the first.
  it('offers no inline editor — it is a way OUT, not a second editing surface', () => {
    const { container } = render(CollabInviteList, { props: { candidates: [], onInvite: () => {} } });
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('input[type="text"]')).toBeNull();
  });
});
