// collabActions — the board mutations extracted out of CollabPane.svelte.
// The pane's own suite already drives these end to end; what is asserted here
// is what only the leaf can state cheaply: the cap's three values stay apart,
// nothing is sent before the pane has an identity, and each mutation re-polls.

import { describe, expect, it } from 'vitest';
import { makeCollabActions } from './collabActions';

function harness(collabId = 'collab-1') {
  const sent: Record<string, unknown>[] = [];
  let polls = 0;
  const actions = makeCollabActions({
    post: (m) => sent.push(m),
    collabId: () => collabId,
    poll: () => { polls += 1; },
  });
  return { actions, sent, polls: () => polls };
}

describe('makeCollabActions', () => {
  it('stamps the collab id on every message and re-polls after it', () => {
    const h = harness();
    h.actions.addTask('write the plan');
    expect(h.sent).toEqual([{ type: 'collabTaskAdd', title: 'write the plan', collabId: 'collab-1' }]);
    expect(h.polls()).toBe(1);
  });

  it('carries a task update with its action and note', () => {
    const h = harness();
    h.actions.updateTask('task-3', 'reopen', { note: 'not done' });
    expect(h.sent[0]).toEqual({ type: 'collabTaskUpdate', taskId: 'task-3', action: 'reopen', note: 'not done', collabId: 'collab-1' });
  });

  // null / 0 / N are not a spectrum: 0 means the loop breaker is OFF, and
  // `cap || default` would quietly re-arm a breaker the user disabled.
  it.each([[null], [0], [12]])('sends cap %s verbatim', (cap) => {
    const h = harness();
    h.actions.setCap(cap as number | null);
    expect(h.sent).toEqual([{ type: 'collabSetCap', collabId: 'collab-1', cap }]);
  });

  it('the cap does NOT re-poll — collabCapSet comes back and triggers one of its own', () => {
    const h = harness();
    h.actions.setCap(4);
    expect(h.polls()).toBe(0);
  });

  // W5. The dispatch width is NOT the cap: it has no null, and the ENGINE can
  // refuse it (a member that can still write files). It therefore rides the
  // op-result path, which carries a refusal back — so this one re-polls, and
  // the room can never sit showing a width the engine did not accept.
  it('sends the dispatch width and re-polls, so a refused one snaps back', () => {
    const h = harness();
    h.actions.setConcurrency(3);
    expect(h.sent).toEqual([{ type: 'collabSetConcurrency', collabId: 'collab-1', concurrency: 3 }]);
    expect(h.polls()).toBe(1);
  });

  it('the ledger is asked for without a re-poll — it answers on its own message', () => {
    const h = harness();
    h.actions.loadLedger();
    expect(h.sent).toEqual([{ type: 'requestCollabLedger', collabId: 'collab-1' }]);
    expect(h.polls()).toBe(0);
  });

  // W3 (report 2.4). `collabStop` takes the WHOLE room and spends its budget;
  // `collabStopAgent` takes one member and leaves the rest running. The two are
  // one word apart on the wire, and confusing them is invisible in a screenshot.
  it('stops ONE agent on the narrow message, naming that agent', () => {
    const h = harness();
    h.actions.stopAgent('collab-heron');
    expect(h.sent).toEqual([{ type: 'collabStopAgent', agentSlug: 'collab-heron', collabId: 'collab-1' }]);
    expect(h.polls()).toBe(1);
  });

  it('addresses a redirect to one agent, with its text', () => {
    const h = harness();
    h.actions.redirect('collab-crane', 'use the other table');
    expect(h.sent[0]).toEqual({
      type: 'collabRedirect', agentSlug: 'collab-crane', text: 'use the other table', collabId: 'collab-1',
    });
  });

  // The engine refuses a reject with no reason, and an empty note sent as `''`
  // would be a reason it then has to refuse for a second time.
  it('carries a verdict, omitting a note there is none of', () => {
    const h = harness();
    h.actions.review('clbt_1', 'reject', 'the index is missing');
    h.actions.review('clbt_2', 'approve');
    expect(h.sent[0]).toMatchObject({ type: 'collabReview', taskId: 'clbt_1', verdict: 'reject', note: 'the index is missing' });
    expect(h.sent[1]).not.toHaveProperty('note');
  });

  // The pane is seeded with its identity on mount, so every one of these can be
  // reached before there is a collab to act on.
  it('sends nothing at all before the pane has an identity', () => {
    const h = harness('');
    h.actions.send({ type: 'collabStop' });
    h.actions.setCap(0);
    h.actions.setConcurrency(2);
    h.actions.addTask('x');
    h.actions.updateTask('t', 'accept', {});
    h.actions.loadLedger();
    h.actions.stopAgent('collab-crane');
    h.actions.redirect('collab-crane', 'x');
    h.actions.review('clbt_1', 'approve');
    expect(h.sent).toEqual([]);
    expect(h.polls()).toBe(0);
  });
});
