// The per-chat VISION PROFILE write, as a leaf: the slug of the agent a chat hands an attached
// image to when its own model can't see one; '' turns it off. An authoritative ACP write — the
// engine stores it on the session row, so it survives an engine restart.
// Lives out here, not inline in DashboardPanel.ts's switch, because that file sat at its line cap;
// only the irreducible `case` stays there.

/** The two things this write needs from the panel, and nothing else. */
export interface VisionProfileHost {
  post(msg: Record<string, unknown>): void;
  setConfigOption(configId: string, value: string): Promise<unknown>;
}

/**
 * Write the profile and echo the result. On FAILURE the echo is `''`, not
 * the attempted slug — the button is optimistic, and echoing the slug back
 * would leave the eye lit for a profile the engine never accepted.
 */
export async function applyVisionProfile(
  host: VisionProfileHost,
  input: { profile: string; sessionId: string },
): Promise<void> {
  try {
    await host.setConfigOption('visionProfile', input.profile);
    host.post({ type: 'visionUpdate', profile: input.profile, sessionId: input.sessionId });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    host.post({ type: 'visionUpdate', profile: '', sessionId: input.sessionId });
    host.post({
      type: 'system',
      text: `Couldn't set the vision profile "${input.profile}" — ${err}`,
      sessionId: input.sessionId,
    });
  }
}
