// The sticky permission-mode banner's STATE, kept pure so "does the banner follow the engine's mode
// stream?" is testable without a webview host.
//
// No poll: the engine implements no get_permission_mode ext-method, so the mode arrives only on the
// live current_mode_update stream and from the mode writes the extension issues itself, and this
// object is where those land.

/** The modes the banner knows how to render. Anything else the engine reports
 *  (`build`, a custom primary agent) is not a permission escalation, so it
 *  normalises to `default` = banner hidden. */
export type PermissionMode = 'default' | 'plan' | 'auto' | 'bypass';

/** Normalise any engine/slash mode id onto the banner's vocabulary. */
export function toPermissionMode(modeId: string | undefined): PermissionMode {
  switch (modeId) {
    case 'plan':
    case 'auto':
    case 'bypass':
      return modeId;
    default:
      return 'default';
  }
}

/** Phase C2 (bypass) + t-dih1p7 (auto) — banner copy. Empty for `default`,
 *  `bypass` and now `auto` too: `/auto` and `/bypass` ride `MODE_COMMANDS`
 *  (DashboardPanel.ts) through `setSessionMode`, which posts `modeUpdate` and
 *  lands in InputBar.svelte's `permissionMode`, rendering its own
 *  `mode-badge` (InputBar.svelte ~819) — so that badge is already the
 *  on-screen signal and a full-width banner saying the same thing was a
 *  duplicate. Only `plan` has no other chrome, so it still renders. */
export function permBannerCopy(mode: PermissionMode): string {
  return mode === 'plan' ? '🟦 PLAN MODE — sticky. Every turn enters plan-mode. Type /default to exit.' : '';
}
/** Per-session mode tracking. Per-session because the banner must follow the
 *  FOCUSED tab — a workspace singleton would show a background chat's plan
 *  mode over the chat the user is actually typing into. */
export class PermissionBannerState {
  private readonly bySession = new Map<string, PermissionMode>();

  /** Record a session's mode. Returns the normalised value. */
  set(sessionId: string, modeId: string | undefined): PermissionMode {
    const mode = toPermissionMode(modeId);
    this.bySession.set(sessionId, mode);
    return mode;
  }

  /**
   * The mode the banner should display. `engineMode` (the session's live ACP mode config-option) is
   *  consulted only when nothing has been tracked yet — once a mode event or write has landed it
   *  wins, since the slash-command path does not refresh configOptions.
   */
  modeFor(sessionId: string | null | undefined, engineMode?: string): PermissionMode {
    if (!sessionId) return 'default';
    return this.bySession.get(sessionId) ?? toPermissionMode(engineMode);
  }

  /**
   * The mode a given WEBVIEW must show. Each popped-out chat is a separate webview speaking for its
   *  own session; deliberately NOT "the last mode this panel painted", since that stamped a sticky
   *  plan banner onto every later-opened chat including brand new ones.
   */
  modeForView(solo: string | null | undefined, activeSessionId: string | null, engineMode?: string): PermissionMode {
    return this.modeFor(solo || activeSessionId, engineMode);
  }

  /** Drop a closed session so its mode can't leak onto a recycled id. */
  forget(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
