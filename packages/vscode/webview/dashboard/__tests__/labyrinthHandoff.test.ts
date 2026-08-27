// Handoff edges on a collab map. The ONE rule worth a suite of its own: an edge
// is a claim that work passed from this member to that one, so it is drawn only
// where the run itself named the target. Everything else here is a way of NOT
// drawing one — an unnamed target, an ambiguous one, a target that never ran
// again, a clock that cannot say. The collab mark on the step still shows in
// every one of those cases; only the edge is withheld.
//
// THE FIXTURES BELOW MIRROR THE ENGINE'S ACTUAL PROJECTION, not a convenient
// invention. For a tool step the engine sets `title = state.title || part.tool`
// and `preview = preview(state.output)`, and the flock `handoff` tool returns
// ("handoff", `Handed to @<slug> - your turn ends here.`). So a real handoff's
// TITLE is the bare word "handoff" and only its PREVIEW names anyone.
//
// The sharp edge: a REFUSED handoff projects identically — same kind, same
// `completed` status — and the "no such agent" refusal lists the whole roster
// as bare comma-joined slugs. Matching bare slugs draws an edge out of a FAILED
// handoff, and with a two-member roster the "names more than one" guard does
// not catch it, because only one roster name is left after excluding self.
// Requiring the `@` is what makes that case safe; refusal text carries none.

import { describe, expect, it } from 'vitest';
import { handoffEdges, type HandoffStep } from '../components/labyrinthRails';

const MEMBERS = ['heron', 'crane', 'ibis'];
// One point per step; x spaced so an edge's path is readable in the assertions.
const pts = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i * 100, y: 10 }));

/** A succeeded handoff exactly as run-steps.ts projects one. (A REFUSED one
 *  carries the same `completed` status, which is why status is not read here.) */
const hand = (over: Partial<HandoffStep> = {}): HandoffStep => ({
  tool: 'handoff', collabTool: true, agent: 'heron',
  title: 'handoff', preview: 'Handed to @crane - your turn ends here.',
  startedAt: 1_000, endedAt: 2_000, ...over,
});
const work = (agent: string, startedAt: number): HandoffStep => ({ agent, title: 'work', startedAt });

describe('handoffEdges — drawn only where the run NAMED the target', () => {
  it('links the handoff to the first step on the named member\'s lane after it ended', () => {
    const steps = [hand(), work('crane', 3_000), work('crane', 4_000)];
    const edges = handoffEdges(pts(3), steps, MEMBERS);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.from).toBe(0);
    expect(edges[0]!.to).toBe(1);
    expect(edges[0]!.target).toBe('crane');
  });

  it('skips the target\'s EARLIER steps — an edge points forward, at what it caused', () => {
    const steps = [work('crane', 100), hand(), work('crane', 3_000)];
    const edges = handoffEdges(pts(3), steps, MEMBERS);
    expect(edges.map((e) => e.to)).toEqual([2]);
  });

  it('names NO member -> NO edge (the mark on the step still carries the fact)', () => {
    const steps = [hand({ preview: 'passing this on' }), work('crane', 3_000)];
    expect(handoffEdges(pts(2), steps, MEMBERS)).toEqual([]);
  });

  it('names TWO members -> NO edge, because guessing which is the point of failure', () => {
    const steps = [hand({ preview: 'Handed to @crane - or was it @ibis' }), work('crane', 3_000), work('ibis', 3_500)];
    expect(handoffEdges(pts(3), steps, MEMBERS)).toEqual([]);
  });

  it('the target never ran again -> NO edge, rather than an edge to nowhere', () => {
    const steps = [hand(), work('ibis', 3_000)];
    expect(handoffEdges(pts(2), steps, MEMBERS)).toEqual([]);
  });

  it('no endedAt -> NO edge: without a clock there is no "after" to point at', () => {
    const steps = [hand({ endedAt: undefined }), work('crane', 3_000)];
    expect(handoffEdges(pts(2), steps, MEMBERS)).toEqual([]);
  });

  it('a target step with no startedAt cannot be the landing point', () => {
    const steps = [hand(), { agent: 'crane', title: 'work' }];
    expect(handoffEdges(pts(2), steps, MEMBERS)).toEqual([]);
  });

  it('reads the target out of the PREVIEW — the real title is only the tool name', () => {
    const steps = [hand(), work('crane', 3_000)];
    // The fixture's title is the bare word "handoff", exactly as projected.
    expect(steps[0]!.title).toBe('handoff');
    expect(handoffEdges(pts(2), steps, MEMBERS).map((e) => e.target)).toEqual(['crane']);
  });

  it('does not match a slug buried inside a longer word', () => {
    // '@crane' inside '@cranefly' is not a mention of crane.
    const steps = [hand({ preview: 'Handed to @cranefly - your turn ends here.' }), work('crane', 3_000)];
    expect(handoffEdges(pts(2), steps, MEMBERS)).toEqual([]);
  });

  it('a member naming ITSELF is not a handoff to anyone', () => {
    const steps = [hand({ agent: 'crane', preview: 'Handed to @crane - your turn ends here.' }), work('crane', 3_000)];
    expect(handoffEdges(pts(2), steps, MEMBERS)).toEqual([]);
  });

  it('only a `handoff` TOOL draws one — an ordinary step mentioning a member does not', () => {
    const steps = [hand({ tool: 'ask' }), work('crane', 3_000)];
    expect(handoffEdges(pts(2), steps, MEMBERS)).toEqual([]);
    const plain = [{ ...hand(), collabTool: undefined }, work('crane', 3_000)];
    expect(handoffEdges(pts(2), plain, MEMBERS)).toEqual([]);
  });

  it('an ORDINARY run draws none at all — no roster, no collab, no edges', () => {
    const steps = [hand(), work('crane', 3_000)];
    expect(handoffEdges(pts(2), steps)).toEqual([]);
    expect(handoffEdges(pts(2), steps, [])).toEqual([]);
  });

  it('the path really joins the two points it claims to', () => {
    const steps = [hand(), work('crane', 3_000)];
    const points = [{ x: 5, y: 10 }, { x: 250, y: 128 }];
    expect(handoffEdges(points, steps, MEMBERS)[0]!.d).toBe('M 5 10 L 250 128');
  });
});

describe('handoffEdges — a REFUSED handoff draws nothing, though it looks identical', () => {
  // The engine projects a refusal exactly like a success: kind 'tool', tool
  // 'handoff', status 'completed'. Only the text differs, and the "no such
  // agent" refusal quotes the ENTIRE ROSTER back as bare comma-joined slugs.
  const refusal = (roster: string) =>
    `There is no "zebra" in this collab - on the roster: ${roster}.`;

  it('does not draw an edge to every member the refusal happens to list', () => {
    const steps = [hand({ preview: refusal('crane, heron, ibis') }), work('crane', 3_000), work('ibis', 3_500)];
    expect(handoffEdges(pts(3), steps, MEMBERS)).toEqual([]);
  });

  it('and not on a TWO-member roster either, where only one name survives self-exclusion', () => {
    // THE trap: excluding the handing agent leaves exactly one roster name, so
    // a "names more than one" guard passes it through. Only requiring `@` stops
    // an edge being drawn out of a handoff that FAILED.
    const two = ['crane', 'heron'];
    const steps = [hand({ agent: 'crane', preview: refusal('crane, heron') }), work('heron', 3_000)];
    expect(handoffEdges(pts(2), steps, two)).toEqual([]);
  });

  it('the self-handoff and hops-spent refusals name nobody at all', () => {
    for (const preview of ['You cannot hand off to yourself.', 'This chain has spent its hops.']) {
      expect(handoffEdges(pts(2), [hand({ preview }), work('crane', 3_000)], MEMBERS)).toEqual([]);
    }
  });

  it('a succeeded handoff still draws — the rule refuses refusals, not handoffs', () => {
    const steps = [hand(), work('crane', 3_000)];
    expect(handoffEdges(pts(2), steps, MEMBERS).map((e) => e.target)).toEqual(['crane']);
  });
});
