// engineTimeline.test.ts — t-xq22sx: the Engines settings chart, one example
// chat after you leave it. Each case is a claim the chart makes to the user
// about when the tracker acts (activityClass.ts, activityTracker.ts,
// parkPolicy.ts, elasticWindow.ts readElasticSettings).
import { describe, expect, it } from 'vitest';
import { engineTimeline, TIMED_CACHE_MINUTES } from './engineTimeline';

const base = { enabled: true, idleAfterMinutes: 5, trimAfterMinutes: 0, retrimMinutes: 10, parkAfterMinutes: 20, parkUntimedAfterMinutes: 20 }; // t-ze0hwh defaults

describe('engineTimeline', () => {
  it('defaults: idle at 5, trim at the 2-minute floor rule, both stops at 20 (t-ze0hwh)', () => {
    const t = engineTimeline(base);
    expect(t.idleAt).toBe(5);
    expect(t.trimAt).toBe(5);
    expect(t.parkTimedAt).toBe(20);
    expect(t.parkUntimedAt).toBe(20);
    expect(t.span).toBeGreaterThanOrEqual(20);
  });

  it('a trim is never asked within 2 minutes of the last turn', () => {
    expect(engineTimeline({ ...base, idleAfterMinutes: 1 }).trimAt).toBe(2);
    expect(engineTimeline({ ...base, trimAfterMinutes: 7 }).trimAt).toBe(12);
  });

  it('the no-cache-life stop is never before the other stop (reader takes the max)', () => {
    expect(engineTimeline({ ...base, parkAfterMinutes: 90, parkUntimedAfterMinutes: 30 }).parkUntimedAt).toBe(90);
  });

  it('t-z6ytkw: a timed provider stops at the Park-after time, not after its cache life', () => {
    expect(engineTimeline({ ...base, idleAfterMinutes: 1, parkAfterMinutes: 1 }).parkTimedAt).toBe(1);
  });

  it('t-z6ytkw: with warming on, a warm due after the stop is a wake-to-warm blip (one per cache life, as the live engine)', () => {
    // Anthropic warms at 80% of the cache life: 4 min (5-min cache), 48 min (1-hour cache).
    expect(engineTimeline({ ...base, parkAfterMinutes: 10, warming: true }).warmBlips).toEqual([48]);
    expect(engineTimeline({ ...base, idleAfterMinutes: 1, parkAfterMinutes: 2, warming: true }).warmBlips).toEqual([0.8 * TIMED_CACHE_MINUTES, 48]);
    // A warm before the stop is sent by the live engine: no wake.
    expect(engineTimeline({ ...base, parkAfterMinutes: 60, warming: true }).warmBlips).toEqual([]);
  });

  it('t-z6ytkw: no blips with warming off or unset (off by default since 0.4.184), parking off or elastic off', () => {
    expect(engineTimeline({ ...base, parkAfterMinutes: 10, warming: false }).warmBlips).toEqual([]);
    expect(engineTimeline({ ...base, parkAfterMinutes: 10 }).warmBlips).toEqual([]);
    expect(engineTimeline({ ...base, parkAfterMinutes: 0, warming: true }).warmBlips).toEqual([]);
    expect(engineTimeline({ ...base, enabled: false, warming: true }).warmBlips).toEqual([]);
  });

  it('a stop never comes before the chat is idle', () => {
    const t = engineTimeline({ ...base, idleAfterMinutes: 30, parkAfterMinutes: 10, parkUntimedAfterMinutes: 20 });
    expect(t.parkTimedAt).toBe(30);
    expect(t.parkUntimedAt).toBe(30);
  });

  it('park 0 removes both stop markers', () => {
    const t = engineTimeline({ ...base, parkAfterMinutes: 0 });
    expect(t.parkTimedAt).toBeNull();
    expect(t.parkUntimedAt).toBeNull();
    expect(t.span).toBeGreaterThan(t.idleAt);
  });

  it('elastic off: no background, idle, trim or stop at all', () => {
    const t = engineTimeline({ ...base, enabled: false });
    expect([t.idleAt, t.trimAt, t.parkTimedAt, t.parkUntimedAt]).toEqual([null, null, null, null]);
  });

  it('re-trims repeat every retrimMinutes until the engine stops', () => {
    const t = engineTimeline({ ...base, parkAfterMinutes: 30, parkUntimedAfterMinutes: 30 });
    expect(t.retrims).toEqual([15, 25]);
  });
});
