// Device group — host side, a leaf beside remotePane.ts (which routes to it, so
// the panel keeps ONE remote entry point). Nothing here reaches the engine: the
// group secret is the OS keychain's, the roster is globalState's, and the links
// belong to the GroupController `activateRemote` owns.
//
// Every write re-reads and re-posts, the same rule the remote pane follows: a
// failed keychain write must not leave a device list on screen that the host
// does not believe.

import { writeNestsEnabled } from '../remote/nestsSetting';
import { groupPayload } from './groupPayload'; // the groupData shape (t-s9jr6u split)
import { onGroupChange, groupForget, groupMarkMotherBase, groupRemoveDevice, groupRenameDevice } from '../remote/groupControl';
import { groupAnswerJoin, groupCancelInvite, groupInvite, groupJoin } from '../remote/groupJoinControl';

export const GROUP_PANE_MESSAGE_TYPES = new Set([
  'groupRequest',
  'groupInvite',
  'groupJoin',
  'groupSetMotherBase',
  'groupRenameDevice',
  'groupRemoveDevice',
  'groupForget',
  // t-s9jr6u: the Nests view's hard switch, `origamicoder.nests.enabled`.
  'groupSetEnabled',
  'groupCancelInvite',
  // t-sj32zl: the inviting desk's Accept / Decline for a desk that asked to join.
  'groupAnswerJoin',
]);

export interface GroupPaneHost {
  post(message: Record<string, unknown>): void;
}

function post(host: GroupPaneHost, error?: string): void {
  host.post(groupPayload(error));
}

function said(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function handleGroupPaneMessage(
  host: GroupPaneHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  const id = typeof m['id'] === 'string' ? m['id'] : '';
  switch (m.type) {
    case 'groupRequest':
      // From here on a join, a hello or a drop pushes a snapshot unasked, so the
      // Add a desk panel can close itself when the new desk arrives (round 4).
      onGroupChange(() => post(host));
      post(host);
      return;
    case 'groupSetEnabled':
      try {
        await writeNestsEnabled(m['enabled'] === true);
        post(host);
      } catch (e) {
        post(host, said(e));
      }
      return;
    case 'groupInvite':
      try {
        await groupInvite();
        post(host);
      } catch (e) {
        post(host, said(e));
      }
      return;
    case 'groupJoin':
      try {
        await groupJoin(m['key']);
        post(host);
      } catch (e) {
        // The parser's own words: they name the fix ("a group key starts with
        // ...") where a generic failure would send the owner back to the QR.
        post(host, said(e));
      }
      return;
    case 'groupSetMotherBase':
      await groupMarkMotherBase(id || null);
      post(host);
      return;
    case 'groupRenameDevice':
      await groupRenameDevice(id, m['name']);
      post(host);
      return;
    case 'groupRemoveDevice':
      await groupRemoveDevice(id);
      post(host);
      return;
    case 'groupAnswerJoin':
      try {
        await groupAnswerJoin(m['accept'] === true);
        post(host);
      } catch (e) {
        post(host, said(e));
      }
      return;
    case 'groupCancelInvite':
      groupCancelInvite();
      post(host);
      return;
    case 'groupForget':
      await groupForget();
      post(host);
      return;
  }
}
