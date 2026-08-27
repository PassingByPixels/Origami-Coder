// t-kgtr6c — the per-chat VISION PROFILE write, as a leaf.
//
// The slug of the agent a chat hands an attached image to when its own model
// cannot see one; `''` turns it off. It is an authoritative ACP write, the same
// shape the approve preset takes: the engine stores it on the session ROW, so
// the prompt loop reads it and it survives an engine restart.
//
// It lives out here rather than inline in DashboardPanel.ts's switch because
// that file sat AT its 6298-line cap. Only the irreducible `case` stays there;
// the client call, the optimistic-echo rules and the failure wording are all
// here, with no `vscode` import, so every branch is exercised against a fake.

/** The two things this write needs from the panel, and nothing else. */
export interface VisionProfileHost {
  post(msg: Record<string, unknown>): void;
  setConfigOption(configId: string, value: string): Promise<unknown>;
}

/**
 * Write the profile and echo the result.
 *
 * The echo on FAILURE is `''`, not the attempted slug, and that is the point of
 * having a function at all: the button is optimistic, so a refused write that
 * echoed the slug back would leave the eye lit for a profile the engine never
 * accepted — the user would believe images were being described and get silence.
 * Clearing it puts the button back where the engine actually is.
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
