// remoteLiveness.ts - the rule DashboardPanel.sessionModelStatus applies to
// decide whether ONE chat's provider is reachable, and whether a re-probe is
// worth kicking for it. Pure, so it is asserted here directly; the same rule is
// exercised end to end through the real panel in pillsMountRace.test.ts.

import { describe, expect, it } from 'vitest';
import { remoteLiveness, LIVENESS_STALE_MS } from '../../../src/dashboard/remoteLiveness';

const NOW = 1_000_000;

describe('remoteLiveness', () => {
  it('a local chat is judged by the local probe, and never queues a remote re-probe', () => {
    expect(remoteLiveness({ isRemote: false, known: true, row: undefined, localOk: true, now: NOW })).toEqual({ ok: true, probe: false });
    expect(remoteLiveness({ isRemote: false, known: true, row: undefined, localOk: false, now: NOW })).toEqual({ ok: false, probe: false });
  });

  it('a KNOWN remote provider with no cache row is not live yet, and is queued', () => {
    expect(remoteLiveness({ isRemote: true, known: true, row: undefined, localOk: true, now: NOW })).toEqual({ ok: false, probe: true });
  });

  it('a fresh cache row is the verdict, and needs no re-probe', () => {
    expect(remoteLiveness({ isRemote: true, known: true, row: { live: true, at: NOW - 1000 }, localOk: false, now: NOW })).toEqual({ ok: true, probe: false });
    expect(remoteLiveness({ isRemote: true, known: true, row: { live: false, at: NOW - 1000 }, localOk: true, now: NOW })).toEqual({ ok: false, probe: false });
  });

  it('a STALE row still answers, but asks for a refresh', () => {
    // Stale is not "offline": the last thing we actually observed is better
    // evidence than nothing, and the kicked probe replaces it a moment later.
    const row = { live: true, at: NOW - LIVENESS_STALE_MS - 1 };
    expect(remoteLiveness({ isRemote: true, known: true, row, localOk: false, now: NOW })).toEqual({ ok: true, probe: true });
  });

  it('an UNKNOWN provider is not reported offline, and is never queued', () => {
    // broadcastProviderStatus probes exactly the ids the global origami.json
    // lists. A model naming a provider that file does not hold - an engine-side
    // catalog the extension cannot see - can therefore never get a cache row.
    // Reading that permanent absence as "not live" raised an alarm about a
    // server nobody asked about, and re-queued the id on every single
    // broadcast: a kick that can never change its own answer.
    expect(remoteLiveness({ isRemote: true, known: false, row: undefined, localOk: false, now: NOW })).toEqual({ ok: true, probe: false });
  });
});
