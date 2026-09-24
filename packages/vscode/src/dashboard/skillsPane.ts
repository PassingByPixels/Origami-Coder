// Skills pane — host side, lifted out of DashboardPanel.ts's message switch (same seam
// pluginsPane.ts and toolsPane.ts use: the engine owns discovery, this only asks and forwards).
// Unlike those two, session resolution goes through activeSession.ts rather than an inline resolve
// — that resolution was the actual bug (see activeSession.ts for the corpse this pane reported as
// "Open a chat first" with two healthy chats open).

import * as os from 'os';
import { liveActiveSession } from './activeSession';
import { classifyScope, scanRoots } from './skillScope';

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
  /** Every session this window holds — a disposed one is already gone, which is why the active id
   *  alone can't be trusted. */
  sessions(): ReadonlyMap<string, SkillsPaneSession>;
  /** The session the user is looking at. MAY name one that has been deleted. */
  activeSessionId(): string | null;
  post(message: Record<string, unknown>): void;
  /** The open workspace folder (DashboardPanel's own `cwd`) — the boundary a skill's
   *  `location` is tested against for the Local/Global filter (t-7vslix). */
  cwd(): string;
  /** t-sh7cog: the window's host engine (hostEngine.ts), asked only when no chat has a client. */
  hostClient?: () => SkillsPaneClient | undefined;
}

export async function handleSkillsPaneMessage(
  host: SkillsPaneHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  if (m.type !== 'listSkills') return;
  // `scanRoots` rides EVERY answer, the good one and both failures (t-fisfs5
  // R11): the empty state names the directories it looked in (t-7vslix), and an
  // error that names none reads as a dead end rather than a diagnostic. It is
  // computed host-side from the cwd and the home directory, so it is known even
  // when the engine call never happened.
  const roots = scanRoots(host.cwd(), os.homedir());
  const client = liveActiveSession(host.sessions(), host.activeSessionId())?.client ?? host.hostClient?.();
  if (!client) {
    host.post({
      type: 'skillsData',
      skills: [],
      error: 'Open a chat first — listing skills needs an active session.',
      scanRoots: roots,
    });
    return;
  }
  try {
    // `refresh` only when the user hits the button: the engine scans skills once per instance, so a
    // skill added mid-session wouldn't show up otherwise.
    const rescan = m.refresh === true;
    const resp = await client.extMethod('list_skills', rescan ? { refresh: true } : {});
    const rawSkills = Array.isArray(resp['skills']) ? resp['skills'] : [];
    const cwd = host.cwd();
    const skills = rawSkills.map((s) =>
      s && typeof s === 'object' && typeof (s as Record<string, unknown>)['location'] === 'string'
        ? { ...s, scope: classifyScope((s as Record<string, unknown>)['location'] as string, cwd) }
        : s,
    );
    host.post({
      type: 'skillsData',
      skills,
      problems: Array.isArray(resp['problems']) ? resp['problems'] : [],
      scanRoots: roots,
    });
  } catch (e) {
    host.post({ type: 'skillsData', skills: [], error: e instanceof Error ? e.message : String(e), scanRoots: roots });
  }
}
