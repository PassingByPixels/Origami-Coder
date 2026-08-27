// launchdBackend.ts — the macOS SchedulerBackend: user LaunchAgents driven
// through `launchctl`, the counterpart of schedulerBackend.ts's windowsBackend.
//
// A job is a plist in ~/Library/LaunchAgents/<label>.plist bootstrapped into
// the user's gui domain. launchctl is invoked through execFile with an ARGUMENT
// ARRAY and no shell — the same no-second-quoting rule the schtasks side lives
// by. `run` and the plist directory are injectable so tests drive the full
// register/unregister/query logic against a fake launchctl and a temp dir;
// only the extension host ever constructs the real thing.
//
// The half-registration covenant holds here too: register writes the plist
// FIRST and deletes it again if bootstrap fails, so a cron either exists in
// both places (file + launchd) or in neither — never a plist launchd has never
// heard of, which reconcile would report as drift forever.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BackendResult, RegisterRequest, SchedulerBackend } from './schedulerBackend';
import { parseLaunchctlList, plistFor } from './cronPosix';

export type LaunchctlRun = (args: string[]) => Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;

const realRun: LaunchctlRun = (args) =>
  new Promise((resolve) => {
    execFile('launchctl', args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || stdout || err.message || '').trim();
        resolve({ ok: false, error: detail || 'launchctl failed' });
        return;
      }
      resolve({ ok: true, stdout: stdout ?? '' });
    });
  });

export function defaultLaunchAgentsDir(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

/** `launchctl bootout` on a job that is not loaded is the desired end state —
 *  the idempotent-delete rule windowsBackend applies to schtasks /Delete. */
function alreadyGone(error: string): boolean {
  return /no such process|could not find|not find service/i.test(error);
}

export function launchdBackend(
  run: LaunchctlRun = realRun,
  plistDir: string = defaultLaunchAgentsDir(),
  uid: number = os.userInfo().uid,
): SchedulerBackend {
  const domain = `gui/${uid}`;
  const plistPath = (label: string) => path.join(plistDir, `${label}.plist`);

  return {
    available: true,
    async register(req: RegisterRequest): Promise<BackendResult> {
      // req.command is the launcher SCRIPT PATH (cronLauncher.taskCommand's
      // darwin form) — launchd takes an argv, so it is never shell-quoted.
      const file = plistPath(req.taskName);
      try {
        fs.mkdirSync(plistDir, { recursive: true });
        fs.writeFileSync(file, plistFor(req.taskName, req.command, req.schedule), 'utf8');
      } catch (e) {
        return { ok: false, error: `could not write ${file}: ${e instanceof Error ? e.message : e}` };
      }
      // An edit re-registers under the same label; the old job must go first
      // (bootstrap refuses a loaded label). Failure here is fine — usually
      // "no such process" for a brand-new cron.
      await run(['bootout', `${domain}/${req.taskName}`]);
      const boot = await run(['bootstrap', domain, file]);
      if (!boot.ok) {
        try { fs.unlinkSync(file); } catch { /* never half-register */ }
        return { ok: false, error: boot.error };
      }
      return { ok: true };
    },
    async unregister(taskName: string): Promise<BackendResult> {
      const res = await run(['bootout', `${domain}/${taskName}`]);
      if (!res.ok && !alreadyGone(res.error)) return { ok: false, error: res.error };
      try { fs.unlinkSync(plistPath(taskName)); } catch { /* already gone */ }
      return { ok: true };
    },
    async runNow(taskName: string): Promise<BackendResult> {
      const res = await run(['kickstart', `${domain}/${taskName}`]);
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    },
    /** One step, unlike schtasks: `launchctl list` enumerates the whole domain
     *  in one call and succeeds whether or not any of ours exist, so an empty
     *  result unambiguously means no crons and a failure means the query failed. */
    async query() {
      const res = await run(['list']);
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, taskNames: parseLaunchctlList(res.stdout) };
    },
  };
}
