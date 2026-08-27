// Collab grouping and member lanes. The failures worth catching here are all
// failures of HONESTY: a collab that swallows the only way to reach a member's
// own run, a lane roster that slides out of step with the lanes under it, and
// an agent placed on a lane the payload never put it on.

import { describe, expect, it } from 'vitest';
import {
  COLLAB_PREFIX, collabCwd, collabIdOf, collabIndex, memberLanes, type CollabRow,
} from '../components/labyrinthCollabIndex';
import { swimLaneCount, swimLayout } from '../components/labyrinthSwim';

const row = (over: Partial<CollabRow> & { sessionId: string }): CollabRow => ({
  title: `run ${over.sessionId}`, folder: 'origami-coder', cwd: 'C:/repos/origami-coder',
  updatedAt: '2026-08-06T10:00:00.000Z', ...over,
});
const COLLAB = { collabId: 'c1', collabTitle: 'Ship the labyrinth' };

describe('collabIndex — a collab is ONE entry, without losing its members', () => {
  it('collapses rows sharing a collabId under a single pickable header', () => {
    const groups = collabIndex([
      row({ sessionId: 's1', ...COLLAB, agentSlug: 'heron' }),
      row({ sessionId: 's2', ...COLLAB, agentSlug: 'crane' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.pickId).toBe('collab:c1');
    expect(groups[0]!.title).toBe('Ship the labyrinth');
    expect(groups[0]!.subtitle).toBe('2 agents');
    expect(groups[0]!.members.map((m) => m.agentSlug)).toEqual(['heron', 'crane']);
  });

  it('keeps every member individually pickable — grouping adds a way in, never removes one', () => {
    const groups = collabIndex([row({ sessionId: 's1', ...COLLAB }), row({ sessionId: 's2', ...COLLAB })]);
    // The member rows carry their OWN session ids, so the pane still asks for
    // the ordinary single-run map when one is clicked.
    expect(groups[0]!.members.map((m) => m.sessionId)).toEqual(['s1', 's2']);
  });

  it('leaves an ordinary run completely untouched — same id, no collab furniture', () => {
    const groups = collabIndex([row({ sessionId: 'ses_a' })]);
    expect(groups).toEqual([{
      pickId: 'ses_a', title: 'run ses_a', subtitle: '', collab: false,
      folder: 'origami-coder', updatedAt: '2026-08-06T10:00:00.000Z', members: [],
    }]);
  });

  it('a lone member still reads as a collab, and says "1 agent" rather than "1 agents"', () => {
    const groups = collabIndex([row({ sessionId: 's1', ...COLLAB })]);
    expect(groups[0]!.collab).toBe(true);
    expect(groups[0]!.subtitle).toBe('1 agent');
  });

  it('holds the collab where its FIRST member was listed, so the host ordering survives', () => {
    const groups = collabIndex([
      row({ sessionId: 'plain1' }),
      row({ sessionId: 's1', ...COLLAB }),
      row({ sessionId: 'plain2' }),
      row({ sessionId: 's2', ...COLLAB }),
    ]);
    expect(groups.map((g) => g.pickId)).toEqual(['plain1', 'collab:c1', 'plain2']);
  });

  it('the header shows the collab\'s LATEST activity, not the first row\'s', () => {
    const groups = collabIndex([
      row({ sessionId: 's1', ...COLLAB, updatedAt: '2026-08-01T00:00:00.000Z' }),
      row({ sessionId: 's2', ...COLLAB, updatedAt: '2026-08-05T00:00:00.000Z' }),
    ]);
    // Grouping must not make a live collab look stale.
    expect(groups[0]!.updatedAt).toBe('2026-08-05T00:00:00.000Z');
  });

  it('an unparseable timestamp never wins the newest slot', () => {
    const groups = collabIndex([
      row({ sessionId: 's1', ...COLLAB, updatedAt: '2026-08-05T00:00:00.000Z' }),
      row({ sessionId: 's2', ...COLLAB, updatedAt: 'not a date' }),
    ]);
    expect(groups[0]!.updatedAt).toBe('2026-08-05T00:00:00.000Z');
  });

  it('falls back to the member title when the host sent no collabTitle', () => {
    const groups = collabIndex([row({ sessionId: 's1', collabId: 'c1' })]);
    expect(groups[0]!.title).toBe('run s1');
  });

  it('separate collabs stay separate', () => {
    const groups = collabIndex([
      row({ sessionId: 's1', collabId: 'c1' }),
      row({ sessionId: 's2', collabId: 'c2' }),
    ]);
    expect(groups.map((g) => g.pickId)).toEqual(['collab:c1', 'collab:c2']);
  });

  it('an empty list is an empty index, not a crash', () => {
    expect(collabIndex([])).toEqual([]);
  });
});

describe('collabIdOf / collabCwd — the pick id round-trips, and asks under a real cwd', () => {
  it('reads the collab id back out of a header pick', () => {
    expect(collabIdOf(`${COLLAB_PREFIX}c1`)).toBe('c1');
  });

  it('an ordinary session id is NOT a collab — it must keep taking requestRunSteps', () => {
    expect(collabIdOf('ses_a')).toBeNull();
    // A session whose id merely CONTAINS the word is still not a header.
    expect(collabIdOf('ses_collab:9')).toBeNull();
  });

  it('a bare prefix names no collab', () => {
    expect(collabIdOf(COLLAB_PREFIX)).toBeNull();
  });

  it('takes the cwd from the first member that recorded one, skipping those that did not', () => {
    const rows = [
      row({ sessionId: 's1', collabId: 'c1', cwd: undefined }),
      row({ sessionId: 's2', collabId: 'c1', cwd: 'C:/repos/spark' }),
    ];
    expect(collabCwd(rows, 'c1')).toBe('C:/repos/spark');
  });

  it('a collab nobody recorded a cwd for yields empty, never undefined', () => {
    expect(collabCwd([row({ sessionId: 's1', collabId: 'c1', cwd: undefined })], 'c1')).toBe('');
    expect(collabCwd([], 'c1')).toBe('');
  });
});

describe('memberLanes — a lane per member, aligned with the roster that labels it', () => {
  const s = (agent?: string) => ({ agent });

  it('puts each member on its OWN lane, in roster order', () => {
    const { lane } = memberLanes([s('heron'), s('crane'), s('heron')], ['heron', 'crane']);
    expect(lane).toEqual([0, 1, 0]);
  });

  it('interleaved members keep their separate lanes — the defect branchModel could not avoid', () => {
    const steps = [s('a'), s('b'), s('c'), s('a'), s('b'), s('c')];
    expect(memberLanes(steps, ['a', 'b', 'c']).lane).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('a member that never STARTED keeps its slot, so labels stay aligned with lanes', () => {
    // 'crane' contributed no steps; 'ibis' must still land on lane 2, not lane 1.
    const { lane, names } = memberLanes([s('heron'), s('ibis')], ['heron', 'crane', 'ibis']);
    expect(names).toEqual(['heron', 'crane', 'ibis']);
    expect(lane).toEqual([0, 2]);
  });

  it('with no roster it uses the slugs the steps carry, in first-seen order', () => {
    const { lane, names } = memberLanes([s('crane'), s('heron'), s('crane')]);
    expect(names).toEqual(['crane', 'heron']);
    expect(lane).toEqual([0, 1, 0]);
  });

  it('a step naming no member of a SHORT roster gets no lane, rather than a borrowed one', () => {
    const { lane } = memberLanes([s('heron'), s('stranger'), s(undefined)], ['heron', 'crane']);
    expect(lane).toEqual([0, -1, -1]);
  });

  it('past the cap, a folded member lands on the LAST lane — the host keeps its real slug', () => {
    // The host sends 8 labels for 10 members: 7 real, then '+3 more'. The steps
    // still carry m7/m8/m9, which are absent from that roster.
    const roster = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', '+3 more'];
    const { lane } = memberLanes([s('m0'), s('m6'), s('m7'), s('m9')], roster);
    expect(lane).toEqual([0, 6, 7, 7]);
  });

  it('no steps is no lanes, not a crash', () => {
    expect(memberLanes([], ['heron']).lane).toEqual([]);
    expect(memberLanes([]).names).toEqual([]);
  });
});

describe('why this module exists — the branch ledger cannot lane collab members', () => {
  // Collab member steps as the host stamps them: depth 1, distinct negative
  // parentOrdinals, interleaved by clock. This is the measurement the module's
  // header cites; if a future change makes branchModel able to lane these, the
  // first expectation here fails and the override can be reconsidered.
  const steps = ['heron', 'crane', 'ibis', 'heron', 'crane', 'ibis'].map((agent, i) => ({
    ordinal: i + 1, kind: 'tool' as const, title: `t${i}`, agent, depth: 1,
    parentOrdinal: -(['heron', 'crane', 'ibis'].indexOf(agent) + 1),
    startedAt: (i + 1) * 1000, endedAt: (i + 1) * 1000 + 100,
  }));

  it('WITHOUT the roster all three members collapse onto one lane', () => {
    expect(swimLaneCount(steps)).toBe(1);
    expect(new Set(swimLayout(steps).map((p) => p.y)).size).toBe(1);
  });

  it('WITH the roster each member gets its own lane', () => {
    const members = ['heron', 'crane', 'ibis'];
    expect(swimLaneCount(steps, members)).toBe(3);
    expect(new Set(swimLayout(steps, members).map((p) => p.y)).size).toBe(3);
  });
});
