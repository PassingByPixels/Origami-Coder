// The sticky permission-mode banner's STATE, kept pure so "does the banner
// follow the engine's mode stream?" is answerable without a webview host.
//
// It used to be answered by POLLING: `refreshPermissionMode()` called the
// `get_permission_mode` ext-method on every bootstrap / mode write / tab focus.
// The engine implements no ext-methods, so that call always threw into a
// swallow-and-keep-the-cached-value catch — the banner could only ever show
// whatever it was last told, which was nothing. There is no poll now: the mode
// arrives on the live `current_mode_update` stream (AcpClient.onModeChanged)
// and from the mode writes the extension issues itself (slash /plan /default
// /auto /bypass, the InputBar toggle, the optimistic revert), and this object
// is where those land.

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
   * The mode the banner should display.
   *
   * `engineMode` is the session's live ACP `mode` config-option — authoritative
   * at bootstrap, before any mode event has fired for this session. It is only
   * consulted when nothing has been tracked yet: once a mode event or write has
   * landed it wins, because `setSessionMode` (the slash-command path) does NOT
   * refresh configOptions, so the config-option would be stale after a /plan.
   */
  modeFor(sessionId: string | null | undefined, engineMode?: string): PermissionMode {
    if (!sessionId) return 'default';
    return this.bySession.get(sessionId) ?? toPermissionMode(engineMode);
  }

  /**
   * The mode a given WEBVIEW must show. Each chat popped into its own editor tab
   * is a separate webview with its own banner, so a solo view speaks for ITS OWN
   * session and the multi-session sidebar for whichever chat is focused.
   * Deliberately NOT "the last mode this panel painted": that panel-global value
   * was stamped into every webview rendered after it, so entering plan on one
   * chat put a sticky plan banner on every chat opened later — a brand new one
   * with zero turns included (0.3.24 UAT).
   */
  modeForView(solo: string | null | undefined, activeSessionId: string | null, engineMode?: string): PermissionMode {
    return this.modeFor(solo || activeSessionId, engineMode);
  }

  /** Drop a closed session so its mode can't leak onto a recycled id. */
  forget(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
