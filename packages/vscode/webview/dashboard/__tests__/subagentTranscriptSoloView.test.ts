// t-tydjkm. The owner's report on 0.4.170: in a chat with many sub-agents,
// opening a sub-agent's transcript showed "Loading transcript…" for ever.
//
// Cause: 0.4.169 (t-tc2rlo #9, 49672d0f4c) routed every post() through
// DeltaFanout, which dropped a per-session message for a popped-out chat tab
// (a SOLO view) whenever its `sessionId` was not the tab's own chat. The reply
// to `requestSubagentTranscript` is keyed on the CHILD's session id, which is
// never the tab's chat, so the tab that asked never got its answer.
//
// This drives the REAL DashboardPanel handler over its own prototype (the
// remotePanelHarness pattern), with a solo view pinned to the parent chat and
// a fake engine client that answers at once. What it asserts is what the solo
// view's webview actually receives.

import { describe, expect, it, vi } from 'vitest';

// The handler reads the page-size setting; 0 = the whole transcript.
vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => 0 }) },
}));

import { DashboardPanel } from '../../../src/dashboard/DashboardPanel';
import { DeltaFanout } from '../../../src/dashboard/deltaFanout';

type Post = Record<string, unknown>;

function panelWithSoloTab() {
  const primary: Post[] = [];
  const solo: Post[] = [];
  const p = Object.create(DashboardPanel.prototype) as Record<string, unknown>;
  Object.defineProperty(p, 'cwd', { value: process.cwd() });
  const client = {
    getSubagentTranscript: async (sessionId: string) => ({
      sessionId, found: true, running: false, truncated: false,
      entries: [{ type: 'text', role: 'assistant', messageId: 'msg_1', text: 'benchmark done' }],
    }),
  };
  const sessions = new Map<string, unknown>();
  for (const id of ['ses_parent', 'ses_other_chat']) {
    sessions.set(id, { id, number: 1, agentName: 'Tsuru', messageLog: [], turnBusy: false, pendingPermissions: new Map(), client });
  }
  const soloView = { postMessage: (m: Post) => { solo.push(m); return Promise.resolve(true); } };
  p['sessions'] = sessions;
  p['activeSessionId'] = 'ses_parent';
  p['panel'] = { webview: { postMessage: (m: Post) => { primary.push(m); return Promise.resolve(true); } } };
  p['extraViews'] = [soloView];
  // The popped-out tab: openSessionInEditor -> attachView(host, 'chat', sessionId).
  p['viewSolo'] = new Map([[soloView, 'ses_parent']]);
  p['viewWiring'] = new Map();
  // Object.create skips field initializers; this is the production one.
  p['deltaFanout'] = new DeltaFanout((id) => sessions.has(id));
  p['pendingQuestionPermissions'] = new Map();
  const handle = (m: Post) => (p['handleWebviewMessage'] as (m: Post) => Promise<void>).call(p, m);
  const post = (m: Post) => (p['post'] as (m: Post) => void).call(p, m);
  return { primary, solo, handle, post };
}

describe('sub-agent transcript reply reaches a popped-out chat tab', () => {
  it('the solo tab that asked gets subagentTranscriptData for the CHILD id', async () => {
    const h = panelWithSoloTab();
    await h.handle({ type: 'requestSubagentTranscript', sessionId: 'ses_child_t3' });

    const reply = h.solo.find((m) => m.type === 'subagentTranscriptData');
    expect(reply, 'the popped-out tab never got its answer: "Loading transcript…" for ever').toBeDefined();
    expect(reply!.sessionId).toBe('ses_child_t3');
    expect(reply!.found).toBe(true);
    expect(h.primary.some((m) => m.type === 'subagentTranscriptData')).toBe(true);
  });

  it('the solo tab still does NOT receive another open chat\'s traffic', () => {
    const h = panelWithSoloTab();
    h.post({ type: 'toolCall', sessionId: 'ses_other_chat', toolCallId: 't1' });
    expect(h.solo.some((m) => m.type === 'toolCall')).toBe(false);
    expect(h.primary.some((m) => m.type === 'toolCall')).toBe(true);
  });
});
