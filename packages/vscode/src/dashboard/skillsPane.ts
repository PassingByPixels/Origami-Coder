// Skills pane — host side. Lifted out of DashboardPanel.ts's message switch,
// which sat two lines under its cap, and lifted HERE rather than folded into
// pluginsPane.ts because the two panes read different engine methods and are
// shown separately.
//
// It is the same `extMethod` seam pluginsPane.ts and toolsPane.ts use: the
// ENGINE owns skill discovery, so this process only asks and forwards.
//
// The one thing it does NOT copy from those two is how it finds the session to
// ask. They each resolve one inline at the dispatch line; this resolves it
// through activeSession.ts, because the resolution is what was broken (W8-L1 —
// see that file for the corpse this pane reported as "Open a chat first" with
// two healthy chats open).

import { liveActiveSession } from './activeSession';

export const SKILLS_PANE_MESSAGE_TYPES = new Set(['listSkills']);

export interface SkillsPaneClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** One entry of the host's session map, as far as this pane is concerned. */
export interface SkillsPaneSession {
  /** Null until the ACP client is constructed; absent on a session that failed to start. */
  client?: SkillsPaneClient | null;
}

export interface SkillsPaneHost {
  /**
   * Every session this window HOLDS. A disposed one is already gone from it —
   * which is exactly why the active id below cannot be trusted on its own.
   */
  sessions(): ReadonlyMap<string, SkillsPaneSession>;
  /** The session the user is looking at. MAY name one that has been deleted. */
  activeSessionId(): string | null;
  post(message: Record<string, unknown>): void;
}

export async function handleSkillsPaneMessage(
  host: SkillsPaneHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  if (m.type !== 'listSkills') return;
  const session = liveActiveSession(host.sessions(), host.activeSessionId());
  if (!session?.client) {
    host.post({ type: 'skillsData', skills: [], error: 'Open a chat first — listing skills needs an active session.' });
    return;
  }
  try {
    // `refresh` only when the user actually hit the button. The engine scans
    // skills ONCE per instance, so without this the button re-read an
    // unchangeable cache — a skill added mid-session never showed up until the
    // window was reloaded.
    const rescan = m.refresh === true;
    const resp = await session.client.extMethod('list_skills', rescan ? { refresh: true } : {});
    host.post({
      type: 'skillsData',
      skills: Array.isArray(resp['skills']) ? resp['skills'] : [],
      problems: Array.isArray(resp['problems']) ? resp['problems'] : [],
    });
  } catch (e) {
    host.post({ type: 'skillsData', skills: [], error: e instanceof Error ? e.message : String(e) });
  }
}
