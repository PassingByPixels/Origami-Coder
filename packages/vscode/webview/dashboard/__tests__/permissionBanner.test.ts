// The sticky permission-mode banner USED to poll a `get_permission_mode`
// ext-method the engine never implemented: every call threw, the catch kept the
// last cached value, and the banner silently froze on whatever it booted with —
// so a user in /bypass saw no warning. It now follows the live mode stream.
//
// These are not echo tests. Each breaks on a specific regression:
//   1. The banner stops following mode updates (freezes on its seed value).
//   2. It follows a BACKGROUND chat's mode instead of the focused tab's.
//   3. A stale config-option beats a mode write that already landed (the /plan
//      case — setSessionMode does not refresh configOptions).
//   4. A non-escalating engine mode (`build`, a custom agent) renders a warning.
import { describe, expect, it } from 'vitest';
import { PermissionBannerState, toPermissionMode } from '../../../src/dashboard/permissionBanner';

const A = 'session-a';
const B = 'session-b';

describe('permission banner — follows the mode stream, never a poll', () => {
  it('the banner state FOLLOWS a simulated sequence of mode updates', () => {
    const s = new PermissionBannerState();
    // Boot: nothing tracked, engine reports the default build agent.
    expect(s.modeFor(A, 'build')).toBe('default');
    // A run of mode updates arrives on the live stream. Each one must move the
    // banner — this is the assertion the old polling implementation failed.
    for (const [modeId, expected] of [
      ['plan', 'plan'],
      ['bypass', 'bypass'],
      ['auto', 'auto'],
      ['build', 'default'],
      ['endeavour', 'default'],
    ] as const) {
      s.set(A, modeId);
      expect(s.modeFor(A, 'build')).toBe(expected);
    }
  });

  it('a mode update that already landed BEATS the engine config-option', () => {
    // The /plan slash path calls setSessionMode, which does NOT refresh
    // configOptions — so the config-option still reads "build" while the
    // session is genuinely in plan. Trusting it would hide the banner.
    const s = new PermissionBannerState();
    s.set(A, 'plan');
    expect(s.modeFor(A, 'build')).toBe('plan');
  });

  it('the banner reads the FOCUSED session, not a background one', () => {
    const s = new PermissionBannerState();
    s.set(A, 'bypass');
    s.set(B, 'default');
    expect(s.modeFor(B)).toBe('default'); // B focused: no warning from A's bypass
    expect(s.modeFor(A)).toBe('bypass');
    expect(s.modeFor(null)).toBe('default'); // no session focused at all
  });

  it('a closed session cannot leak its mode onto a recycled id', () => {
    const s = new PermissionBannerState();
    s.set(A, 'bypass');
    s.forget(A);
    expect(s.modeFor(A)).toBe('default');
    // ...and a fresh session on that id falls back to its OWN engine mode.
    expect(s.modeFor(A, 'plan')).toBe('plan');
  });

  it('only real permission escalations render a banner', () => {
    // `build` and custom primary agents are not escalations — a warning bar for
    // them would be permanent chrome the user learns to ignore.
    expect(toPermissionMode('build')).toBe('default');
    expect(toPermissionMode('cartographer')).toBe('default');
    expect(toPermissionMode(undefined)).toBe('default');
    expect(toPermissionMode('')).toBe('default');
    expect(toPermissionMode('plan')).toBe('plan');
    expect(toPermissionMode('bypass')).toBe('bypass');
  });
});

// 0.3.24 UAT (verbatim): "Put plan mode on Tsuru 2 and Tsuru 3 is missing all the
// action buttons below the chat pane and has a plan mode warning its a seperate
// chat it shouldnt be taking that from Tsuru 2", and "Im somehow stuck in plan
// mode as i closed the plan mode chat panel and the others have lost their Chat
// commands".
//
// The banner is ONE div per webview, and every chat popped into its own editor
// tab is its own webview. Whichever session that view is for, the banner it
// boots with must come from THAT session — not from "the last mode this panel
// happened to paint", which is what stamped plan onto every chat opened after
// Tsuru 2 entered it. These cases fail against a panel-global seed.
describe('permission banner — a VIEW speaks for its own session, never the panel', () => {
  it('a solo view for B shows nothing while A is in plan (a separate chat is separate)', () => {
    const s = new PermissionBannerState();
    s.set(A, 'plan');
    // The popped-out tab for B. B has never entered plan and its engine reports
    // the normal build agent: it must show no banner at all.
    expect(s.modeForView(B, A, 'build')).toBe('default');
    // ...and A's own tab still tells the truth, whichever chat is focused.
    expect(s.modeForView(A, B)).toBe('plan');
  });

  it('a FRESH view for a session with no tracked mode reads its OWN engine mode', () => {
    const s = new PermissionBannerState();
    s.set(A, 'plan');
    // Session C bootstraps: nothing tracked yet, so its own config-option is
    // authoritative. A's plan must not leak in as the seed.
    expect(s.modeForView('session-c', A, 'build')).toBe('default');
    expect(s.modeForView('session-c', A, 'plan')).toBe('plan');
  });

  it('the sidebar (no solo session) follows the FOCUSED chat', () => {
    const s = new PermissionBannerState();
    s.set(A, 'bypass');
    s.set(B, 'default');
    expect(s.modeForView(null, A)).toBe('bypass');
    expect(s.modeForView(null, B)).toBe('default');
    // An empty solo id is the sidebar too (the shell ships '' for "not solo").
    expect(s.modeForView('', B)).toBe('default');
    expect(s.modeForView(undefined, null)).toBe('default');
  });

  it('closing the plan chat leaves NO residue for the views that survive it', () => {
    // The reported strand: the plan chat is closed, focus moves to B, and the
    // banner must go with the session that owned it.
    const s = new PermissionBannerState();
    s.set(A, 'plan');
    s.forget(A);
    expect(s.modeForView(null, B)).toBe('default');
    // ...and a NEW chat that lands on the recycled id starts clean, seeded by
    // its own engine mode rather than the dead session's.
    expect(s.modeForView(A, A, 'build')).toBe('default');
  });

  it('a STALE tracked plan self-heals the moment that session reports build', () => {
    // Recovery path: nothing here is persisted to disk, but a retained webview
    // holds its last painted banner for its whole lifetime. Whatever stale value
    // stranded the user must be overridden by the next real mode report — not
    // require hand-editing state.
    const s = new PermissionBannerState();
    s.set(A, 'plan');
    expect(s.modeForView(A, A)).toBe('plan');
    s.set(A, 'build');
    expect(s.modeForView(A, A, 'plan')).toBe('default');
  });
});
