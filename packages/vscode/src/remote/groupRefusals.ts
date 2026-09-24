// The DEVICE GROUP pane's verbs, named as refused for the phone (t-rz1b14).
//
// A leaf of its own rather than seven more rows in remoteRefusalsTable.ts,
// which is at its cap — the rule that file's own header states: extract, do not
// raise. Same job, same contract: not consulted at runtime (default-deny needs
// no deny-list), listed so remoteVerbsCoverage.test.ts can see the refusal was
// a DECISION and not an omission.
//
// Why every one of them is refused: the invitation CARRIES THE GROUP SECRET. A
// phone that could ask for one could add a machine to the owner's group; a
// phone that could mark the mother base would be moving where the sessions
// live; a phone that could forget the group would cut the desks apart. The
// group is desk-to-desk. The phone reads through a desk, never into it.

import { NEST_GROUP_VERBS } from './nestWire';
import { GROUP_ROSTER } from './groupGossip';

export const GROUP_REFUSALS: readonly string[] = [
  'groupRequest',
  'groupInvite',
  'groupJoin',
  'groupSetMotherBase',
  'groupRenameDevice',
  'groupRemoveDevice',
  'groupForget',
  // t-s9k0q6: the sidebar's "Continue here" moves a chat from another desk to
  // this one (or forks it). Same reason: it moves where a session lives.
  'nestContinue',
  // t-s9jr6u, Nests: the hard switch dials the relay for the whole group, and a
  // Keep window deletes bodies on the desk. Both are desk decisions.
  'groupSetEnabled',
  'groupCancelInvite',
  'nestRetentionSet',
  // t-sc093o: a plain click on a Nest row pulls a chat's body into this
  // desk's store; and the four desk-to-desk nest verbs (nestWire.ts).
  'nestOpenRead',
  ...NEST_GROUP_VERBS,
  // t-sfyata: the desk-to-desk roster gossip. A phone that could send one could add or remove a desk.
  GROUP_ROSTER,
  // t-sj32zl: Accept is what sends Kg to a new desk. The owner answers at the desk.
  'groupAnswerJoin',
];
