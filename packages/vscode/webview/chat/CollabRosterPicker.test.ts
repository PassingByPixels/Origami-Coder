// CollabRosterPicker — the roster's own Invite `+` popover.
//
// The picker is now only the TRIGGER and the popover shell; the rows, the
// selection and the commit live in CollabInviteList.svelte (shared with the
// setup card). So what is asserted here is the thing only the shell owns: WHEN
// the popover closes.
//
// Report 1.3 is exactly a closing bug — the popover shut after every single
// pick, so a three-agent room cost six clicks and three re-openings. A pick
// must leave it open; only the commit closes it.
//
// The disabled-row case is kept: a live UAT report showed a user staring at a
// greyed-out row with no way to read the tooltip, so the reason must be DOM
// text reachable through this popover, not only a title attribute.

import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import CollabRosterPicker from './CollabRosterPicker.svelte';
import { FS_ONLY_REASON, type InviteCandidate } from './collabInvite';

const candidate = (over: Partial<InviteCandidate> & { slug: string }): InviteCandidate => ({
  displayName: over.slug,
  disabled: false,
  model: null,
  health: { kind: 'unpinned', provider: '' },
  ...over,
});

const CRANE = candidate({ slug: 'collab-crane', displayName: 'Crane' });
const HERON = candidate({ slug: 'collab-heron', displayName: 'Heron' });

const openPopover = () => fireEvent.click(screen.getByRole('button', { name: /Invite an agent/i }));

describe('CollabRosterPicker — the popover stays open across picks', () => {
  it('two picks and one Invite click: the popover survives the picks and commits both', async () => {
    const calls: string[][] = [];
    render(CollabRosterPicker, { props: { candidates: [CRANE, HERON], onInvite: (s: string[]) => calls.push(s) } });
    await openPopover();

    await fireEvent.click(screen.getByRole('checkbox', { name: /Crane/ }));
    // Still open, and nothing sent — the old picker closed and invited here.
    expect(screen.getByRole('checkbox', { name: /Heron/ })).toBeInTheDocument();
    expect(calls).toEqual([]);

    await fireEvent.click(screen.getByRole('checkbox', { name: /Heron/ }));
    expect(screen.getByRole('checkbox', { name: /Crane/ })).toBeInTheDocument();
    expect(calls).toEqual([]);

    await fireEvent.click(screen.getByRole('button', { name: /^Invite \(/ }));
    expect(calls).toEqual([['collab-crane', 'collab-heron']]);
  });

  it('the commit closes the popover — the picks are done with', async () => {
    render(CollabRosterPicker, { props: { candidates: [CRANE], onInvite: () => {} } });
    await openPopover();
    await fireEvent.click(screen.getByRole('checkbox', { name: /Crane/ }));
    await fireEvent.click(screen.getByRole('button', { name: /^Invite \(/ }));

    expect(screen.queryByRole('checkbox', { name: /Crane/ })).toBeNull();
  });

  it('the `+` trigger toggles the popover shut again without inviting anyone', async () => {
    const calls: string[][] = [];
    render(CollabRosterPicker, { props: { candidates: [CRANE], onInvite: (s: string[]) => calls.push(s) } });
    await openPopover();
    expect(screen.getByRole('checkbox', { name: /Crane/ })).toBeInTheDocument();

    await openPopover();
    expect(screen.queryByRole('checkbox', { name: /Crane/ })).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('CollabRosterPicker — disabled-row reason', () => {
  it('a disabled candidate renders its reason as DOM text, not just a title attribute', async () => {
    render(CollabRosterPicker, {
      props: {
        candidates: [candidate({ slug: 'collab-new', displayName: 'New Agent', disabled: true, reason: FS_ONLY_REASON })],
        onInvite: () => {},
      },
    });
    await openPopover();
    expect(await screen.findByText(FS_ONLY_REASON)).toBeInTheDocument();
  });

  it('an enabled candidate renders no reason sublabel', async () => {
    render(CollabRosterPicker, { props: { candidates: [HERON], onInvite: () => {} } });
    await openPopover();

    await screen.findByText('collab-heron');
    expect(screen.queryByText(FS_ONLY_REASON)).toBeNull();
  });

  it('clicking a disabled row still does not invite (mechanics unchanged)', async () => {
    const calls: string[][] = [];
    render(CollabRosterPicker, {
      props: {
        candidates: [candidate({ slug: 'collab-new', displayName: 'New Agent', disabled: true, reason: FS_ONLY_REASON })],
        onInvite: (s: string[]) => calls.push(s),
      },
    });
    await openPopover();

    const row = (await screen.findByText(FS_ONLY_REASON)).closest('button')!;
    expect(row).toBeDisabled();
    await fireEvent.click(row);
    expect(calls).toEqual([]);
  });
});
