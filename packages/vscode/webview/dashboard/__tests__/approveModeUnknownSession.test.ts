// setApproveMode (DashboardPanel.ts, the InputBar / phone / sidebar YOLO toggle
// write) used to answer an unknown `sid` with a silent `break` — no `system`
// line, no reply to whoever sent it. A caller naming a session the desk has
// already lost track of (a stale phone target, a race with the chat closing)
// got no feedback at all: the toggle looked like it worked and did nothing.
// The `catch` two lines down DOES post a `system` line on a real write
// failure (`setConfigOption` throwing) — this guards that the SAME feedback
// now exists on the "no such session" path, which the catch cannot reach
// (the throw never happens; `approveSession` is undefined before the `try`).
// Source-guarded like questionRouting.test.ts's S7.1 block: this branch runs
// inside a VS Code extension host message handler with no seam a unit test
// can drive directly.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('DashboardPanel setApproveMode — an unknown sid is answered, not silently dropped', () => {
  const src = readFileSync(
    join(__dirname, '..', '..', '..', 'src', 'dashboard', 'DashboardPanel.ts'),
    'utf-8',
  );

  it('a sid PRESENT but not in this.sessions posts a system "no such chat" line and breaks before touching approveSession.client', () => {
    expect(src).toMatch(
      /if \(sid && !approveSession\) \{ postApproveModeFailure\(\(m\) => this\.post\(m\), sid, mode, `no such chat: \$\{sid\}`\); break; \}\s*\n\s*if \(!approveSession\?\.client\) break;/,
    );
  });

  it('a sid ABSENT still falls back to the active session (unchanged) — the guard above only fires when sid is a real, unmatched id', () => {
    expect(src).toMatch(/const approveSession = sid \? this\.sessions\.get\(sid\) : this\.getActiveSession\(\);\s*\n\s*if \(sid && !approveSession\)/);
  });
});
