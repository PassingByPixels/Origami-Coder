import { describe, expect, it } from 'vitest';
import { MODEL_REFRESH_DEBOUNCE_MS, createModelRefreshGate } from '../../../src/dashboard/modelRefreshGate';

describe('model refresh gate', () => {
  it('lets the FIRST picker open through — a list nobody ever asked for is the bug', () => {
    expect(createModelRefreshGate({ now: () => 0 }).shouldRefresh()).toBe(true);
  });

  it('a second open inside the window does not poke the engine again', () => {
    // The regression: `requestModels` fires on every dropdown mount, so a user
    // comparing two models opened three engine refreshes in a few seconds —
    // and each one is what puts the account credential on the wire.
    let clock = 0;
    const gate = createModelRefreshGate({ debounceMs: 10_000, now: () => clock });
    expect(gate.shouldRefresh()).toBe(true);
    clock = 1_000;
    expect(gate.shouldRefresh()).toBe(false);
    clock = 9_999;
    expect(gate.shouldRefresh()).toBe(false);
  });

  it('past the window it goes again — a model added to the account still arrives', () => {
    let clock = 0;
    const gate = createModelRefreshGate({ debounceMs: 10_000, now: () => clock });
    expect(gate.shouldRefresh()).toBe(true);
    clock = 10_000;
    expect(gate.shouldRefresh()).toBe(true);
    clock = 19_999;
    expect(gate.shouldRefresh()).toBe(false);
  });

  it('the window restarts from the last PASS, not the last ask', () => {
    let clock = 0;
    const gate = createModelRefreshGate({ debounceMs: 1_000, now: () => clock });
    gate.shouldRefresh();
    clock = 900;
    expect(gate.shouldRefresh()).toBe(false);
    // A refused ask at 900 must not push the next allowed one out to 1900.
    clock = 1_000;
    expect(gate.shouldRefresh()).toBe(true);
  });

  it('a clock that answers 0 is not read as "already refreshed"', () => {
    const gate = createModelRefreshGate({ now: () => 0 });
    expect(gate.shouldRefresh()).toBe(true);
    expect(gate.shouldRefresh()).toBe(false);
  });

  it('two gates are independent — one panel does not mute another', () => {
    const a = createModelRefreshGate({ now: () => 0 });
    const b = createModelRefreshGate({ now: () => 0 });
    expect(a.shouldRefresh()).toBe(true);
    expect(b.shouldRefresh()).toBe(true);
  });

  it('the default window is the one DashboardPanel relies on', () => {
    expect(MODEL_REFRESH_DEBOUNCE_MS).toBe(10_000);
  });
});
