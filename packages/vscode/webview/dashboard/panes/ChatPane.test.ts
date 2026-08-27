// Origami U2 / M1 — ChatPane behaviour tests (Origami-native fixtures).
//
// These drive ChatPane through the SHIPPED host→webview message bridge
// (the `post()` shapes DashboardPanel emits after decoding origami/*
// events). NO donor recorded fixtures: every message below is authored
// fresh against the new contract. ChatPane takes no props — all state
// arrives via window `message` events, exactly as the extension host
// delivers them.

import { render, screen, waitFor, fireEvent } from '@testing-library/svelte';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tick } from 'svelte';
import ChatPane from './ChatPane.svelte';

const ACP_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PLAN_ID = 'P-ORIGAMI-1';

function postFromHost(data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function newSession() {
  postFromHost({
    type: 'sessionCreated',
    sessionId: ACP_UUID,
    sessionNumber: 1,
    agentName: 'Coder',
    agentArt: null,
  });
  postFromHost({ type: 'modelStatus', ok: true, modelName: 'qwen-coder' });
}

// Variant that creates a session WITHOUT reporting an online model, so the
// empty-state hint reflects the offline path.
function newSessionOffline() {
  postFromHost({
    type: 'sessionCreated',
    sessionId: ACP_UUID,
    sessionNumber: 1,
    agentName: 'Coder',
    agentArt: null,
  });
  postFromHost({ type: 'modelStatus', ok: false, reason: 'no model loaded' });
}

// Variant for a workspace that has never been through /firstfold — the
// extension tags sessionCreated with needsSetup:true (t-r7c757 round 2).
function newSessionNeedsSetup() {
  postFromHost({
    type: 'sessionCreated',
    sessionId: ACP_UUID,
    sessionNumber: 1,
    agentName: 'Coder',
    agentArt: null,
    needsSetup: true,
  });
  postFromHost({ type: 'modelStatus', ok: true, modelName: 'qwen-coder' });
}

describe('ChatPane — no phantom self-review banner (U2)', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
  });

  it('a stream whose only event is origami/turnEnd shows NO "Self-reviewing plan…" banner', async () => {
    render(ChatPane);
    newSession();
    // origami/turnEnd is decoded by the bridge into a planStatus with
    // status:'turn_end' (NEVER self_review). Feed exactly that.
    postFromHost({ type: 'planStatus', sessionId: ACP_UUID, status: 'turn_end', revisionCount: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/Self-reviewing plan/i)).toBeNull();
  });

  it('a trivial turn (turnEnd only, no plan) renders no plan banner at all', async () => {
    render(ChatPane);
    newSession();
    postFromHost({ type: 'agentText', sessionId: ACP_UUID, text: 'hello' });
    postFromHost({ type: 'planStatus', sessionId: ACP_UUID, status: 'turn_end', revisionCount: 0 });
    postFromHost({ type: 'turnDone', sessionId: ACP_UUID, stopReason: 'success' });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/Self-reviewing plan/i)).toBeNull();
    expect(screen.queryByText(/Drafting plan/i)).toBeNull();
  });
});

describe('ChatPane — M1 followable surface (arbiter decision + plan)', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
  });

  it('renders exactly one per-turn arbiter decision chip from origami/arbiterDecision', async () => {
    render(ChatPane);
    newSession();
    postFromHost({ type: 'arbiterDecision', sessionId: ACP_UUID, decision: 'done', reason: 'tests green' });
    const chip = await waitFor(() => screen.getByText('Done'));
    expect(chip).toBeInTheDocument();
    expect(screen.getByText('tests green')).toBeInTheDocument();

    // Wholesale replacement: a second decision replaces, does not stack.
    postFromHost({ type: 'arbiterDecision', sessionId: ACP_UUID, decision: 'continue', reason: 'more to do' });
    await waitFor(() => screen.getByText('Continue'));
    // The previous 'Done' chip is gone — exactly one decision shown.
    expect(screen.queryByText('Done')).toBeNull();
    expect(screen.getByText('more to do')).toBeInTheDocument();
  });

  it('renders a real plan (planReady) with an approvable plan panel', async () => {
    render(ChatPane);
    newSession();
    postFromHost({
      type: 'planReady',
      sessionId: ACP_UUID,
      planId: PLAN_ID,
      title: 'Build the parser',
      filePath: '/tmp/plan.md',
      status: 'awaiting_user',
      revisionCount: 0,
    });
    const approve = await waitFor(() => screen.getByTitle('Approve and execute the plan'));
    expect(approve).toBeInTheDocument();
    expect(screen.getByText('Build the parser')).toBeInTheDocument();
  });
});

describe('ChatPane — honest per-turn verdict (R2.3, the thesis headline)', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
  });

  // THE HEADLINE HONESTY FIX. A budget-walled / no-progress / errored
  // terminal must NOT render as the benign "Continue" — it gets a
  // distinct INCOMPLETE verdict. This test must FAIL if the mapping
  // ever regresses to collapsing error terminals onto Continue.
  it('an error_max_turns terminal renders INCOMPLETE, not Continue', async () => {
    render(ChatPane);
    newSession();
    // The bridge forwards origami/turnEnd's real stop_reason as a
    // `turnVerdict` host message (previously discarded).
    postFromHost({ type: 'turnVerdict', sessionId: ACP_UUID, stopReason: 'error_max_turns' });

    // The inline per-turn verdict row names the real failure...
    const verdict = await waitFor(() => screen.getByText(/Incomplete: error_max_turns/i));
    expect(verdict).toBeInTheDocument();
    // ...and the turn does NOT read as benign "Continue".
    expect(screen.queryByText(/^Continue$/)).toBeNull();
    expect(screen.queryByText(/Verified done/i)).toBeNull();
  });

  it('error_no_progress also renders INCOMPLETE, not Continue', async () => {
    render(ChatPane);
    newSession();
    postFromHost({ type: 'turnVerdict', sessionId: ACP_UUID, stopReason: 'error_no_progress' });
    await waitFor(() => screen.getByText(/Incomplete: error_no_progress/i));
    expect(screen.queryByText(/^Continue$/)).toBeNull();
  });

  it('a success terminal renders the verified-done verdict (not incomplete)', async () => {
    render(ChatPane);
    newSession();
    postFromHost({ type: 'turnVerdict', sessionId: ACP_UUID, stopReason: 'success' });
    await waitFor(() => screen.getByText(/Verified done/i));
    expect(screen.queryByText(/Incomplete/i)).toBeNull();
  });

  // The arbiter chip's unknown default no longer silently masks an
  // unrecognised decision as the benign "Continue".
  it('an unrecognised arbiter decision is NOT masked as Continue', async () => {
    render(ChatPane);
    newSession();
    postFromHost({ type: 'arbiterDecision', sessionId: ACP_UUID, decision: 'weird_new_label', reason: 'r' });
    await waitFor(() => screen.getByText('Ended'));
    expect(screen.queryByText('Continue')).toBeNull();
  });
});

describe('ChatPane — dead-hack removal does not break plan flow (U2)', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
  });

  it('approve posts a normal plan_action verb (no resume hack needed)', async () => {
    render(ChatPane);
    newSession();
    postFromHost({
      type: 'planReady',
      sessionId: ACP_UUID,
      planId: PLAN_ID,
      title: 'Build the parser',
      filePath: '/tmp/plan.md',
      status: 'awaiting_user',
      revisionCount: 0,
    });
    const approve = await waitFor(() => screen.getByTitle('Approve and execute the plan'));
    await fireEvent.click(approve);

    // The webview's job is to fire the verb; the bridge drives execution
    // (the "Begin execution" resume re-prompt was deleted). Assert the
    // normal approve verb is posted with the ACP session id + plan id.
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'planAction',
        action: 'approve',
        sessionId: ACP_UUID,
        planId: PLAN_ID,
      }),
    );
  });
});

describe('ChatPane — chat empty state (crane + rotating tip, t-r7c757)', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
    // Pins the rotation's random start to tip 0 (the classic hint) so these
    // tests assert a known string rather than "one of eleven".
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const TIP_0 = 'Ready — ask Tsuru to make a change. Type below to jump in.';
  const TIP_1 = 'Run /wrap to close out a session — it writes the handoff and updates the wiki.';

  // The empty state must render the brand crane (the shared CraneMark
  // component) AND the rotating tip while no real conversation exists.
  // Catches a regression where the empty state is dropped or the crane is
  // inlined again instead of reusing CraneMark.
  it('shows the crane + the seeded tip when the session has no user/assistant turns', async () => {
    const { container } = render(ChatPane);
    newSession();
    await new Promise((r) => setTimeout(r, 0));

    // The CraneMark renders an aria-hidden <svg> with the 64-unit viewBox.
    // Scoped to .chat-empty-crane (not the whole pane): a session with no
    // conversation ALSO carries a tab in the strip (t-q41knp), which now
    // renders its own crane too — this asserts the EMPTY STATE's crane
    // specifically, unaffected by how many others exist elsewhere.
    const cranes = container.querySelectorAll('.chat-empty-crane svg[viewBox="0 0 64 64"]');
    expect(cranes.length).toBe(1);
    const tip = container.querySelector('.chat-empty-tip');
    expect(tip?.textContent).toBe(TIP_0);
  });

  // Honest online/offline branching. The tip text is fixed, owner-reviewed
  // wording (t-r7c757) — it no longer interpolates `agentName` the way the
  // old static hint did, so this is unaffected by which agent the session names.
  it('renders the ONLINE rotating tip when a model is loaded', async () => {
    render(ChatPane);
    newSession(); // posts modelStatus ok:true, agentName 'Coder'
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText(TIP_0)).toBeInTheDocument();
    // The offline directive must NOT show when a model is loaded.
    expect(screen.queryByText(/Load your model/i)).toBeNull();
  });

  // Honest dynamic hint: OFFLINE/no model points the user at the Setup panel.
  // Unaffected by the tip rotation — the offline branch never rotates.
  it('renders the OFFLINE "Load your model" hint when no model is loaded', async () => {
    render(ChatPane);
    newSessionOffline();
    await new Promise((r) => setTimeout(r, 0));
    expect(
      screen.getByText('New here? Load your first model in the Setup panel.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Ready —/i)).toBeNull();
  });

  // The headline behaviour: the empty state is REPLACED by the real thread
  // once the first user turn lands; the crane + hint disappear and the
  // message renders. Breaks if the gating ever keys on the wrong predicate
  // (e.g. messages.length, which the system "Connected…" line would trip).
  it('replaces the empty state with the thread once a real user turn arrives', async () => {
    render(ChatPane);
    newSession();
    // A system "Connected…" line is scaffolding — it must NOT dismiss the
    // empty state.
    postFromHost({ type: 'system', sessionId: ACP_UUID, text: 'Connected. Session ready.' });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText(TIP_0)).toBeInTheDocument();

    // The first real user turn flips it off. (getAllByText: the text now renders
    // twice — the real message row + the persistent pinned mirror, tweak 2.)
    postFromHost({ type: 'echoUser', sessionId: ACP_UUID, text: 'add a button' });
    await waitFor(() => expect(screen.getAllByText('add a button').length).toBeGreaterThan(0));
    expect(screen.queryByText(TIP_0)).toBeNull();
  });

  // t-r7c757 — the rotation timer must not merely be hidden by the first
  // message; ChatEmptyState.svelte actually UNMOUNTS (ChatPane's own
  // {#if !hasConversation}), so its $effect teardown fires and nothing
  // keeps firing after. Fake timers pin this down as a real teardown, not
  // a coincidence of the test finishing before the next tick would land.
  it('stops the tip rotation timer for good once the first message lands (no leak)', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    render(ChatPane);
    newSession();
    await tick();
    expect(document.querySelector('.chat-empty-tip')).not.toBeNull();

    postFromHost({ type: 'echoUser', sessionId: ACP_UUID, text: 'add a button' });
    await tick();
    expect(document.querySelector('.chat-empty-tip')).toBeNull();
    expect(clearSpy).toHaveBeenCalled();

    // Advancing well past several rotation intervals must not resurrect it —
    // proof the timer is truly gone, not merely hidden behind another element.
    vi.advanceTimersByTime(30000);
    await tick();
    expect(document.querySelector('.chat-empty-tip')).toBeNull();
  });

  // t-r7c757 — the actual advance: waiting the rotation interval swaps the
  // rendered tip to the NEXT one in the list (not a re-roll).
  it('advances to the next tip after ~8s', async () => {
    vi.useFakeTimers();
    render(ChatPane);
    newSession();
    await tick();
    expect(screen.getByText(TIP_0)).toBeInTheDocument();

    vi.advanceTimersByTime(8000);
    await tick();
    expect(screen.getByText(TIP_1)).toBeInTheDocument();
    expect(screen.queryByText(TIP_0)).toBeNull();
  });

  // The composer (InputBar) must remain present in the empty state — the
  // empty state occupies the thread area ABOVE it, it does not replace it.
  it('keeps the composer present in the empty state', async () => {
    render(ChatPane);
    newSession();
    await new Promise((r) => setTimeout(r, 0));
    // The empty state is up...
    expect(screen.getByText(TIP_0)).toBeInTheDocument();
    // ...and the InputBar's textarea is still mounted at the bottom.
    expect(document.querySelector('textarea')).not.toBeNull();
  });
});

describe('ChatPane — un-set-up workspace: pinned firstfold tip (t-r7c757 round 2)', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const SETUP_TIP = "This workspace isn't folded yet — run /firstfold to set up AGENTS.md, HANDOFF and the wiki.";
  const TIP_0 = 'Ready — ask Tsuru to make a change. Type below to jump in.';
  const TIP_1 = 'Run /wrap to close out a session — it writes the handoff and updates the wiki.';

  it('sessionCreated{needsSetup:true} renders the pinned tip, not the rotation, and it does not advance after 8s', async () => {
    vi.useFakeTimers();
    render(ChatPane);
    newSessionNeedsSetup();
    await tick();
    expect(screen.getByText(SETUP_TIP)).toBeInTheDocument();
    expect(screen.queryByText(TIP_0)).toBeNull();

    vi.advanceTimersByTime(8000);
    await tick();
    expect(screen.getByText(SETUP_TIP)).toBeInTheDocument();
  });

  it('firstfoldDone{needsSetup:false} flips the pinned tip to the live rotation, no reload', async () => {
    vi.useFakeTimers();
    render(ChatPane);
    newSessionNeedsSetup();
    await tick();
    expect(screen.getByText(SETUP_TIP)).toBeInTheDocument();

    postFromHost({ type: 'firstfoldDone', sessionId: ACP_UUID, needsSetup: false });
    await tick();
    expect(screen.getByText(TIP_0)).toBeInTheDocument();
    expect(screen.queryByText(SETUP_TIP)).toBeNull();

    // And the rotation is now genuinely live — it advances on schedule.
    vi.advanceTimersByTime(8000);
    await tick();
    expect(screen.getByText(TIP_1)).toBeInTheDocument();
  });

  it('is workspace-wide: firstfoldDone on ONE session also flips a DIFFERENT open session', async () => {
    const SID_B = 'bbbbbbbb-2222-3333-4444-555555555555';
    render(ChatPane);
    // Session A, then session B — both un-set-up. Creating B makes it active.
    newSessionNeedsSetup();
    postFromHost({ type: 'sessionCreated', sessionId: SID_B, sessionNumber: 2, agentName: 'Coder', agentArt: null, needsSetup: true });
    postFromHost({ type: 'modelStatus', ok: true, modelName: 'qwen-coder' });
    await tick();
    expect(screen.getByText(SETUP_TIP)).toBeInTheDocument(); // B, the active tab

    // firstfoldDone names A's sessionId, not B's — the fix must still flip B.
    postFromHost({ type: 'firstfoldDone', sessionId: ACP_UUID, needsSetup: false });
    await tick();

    // Switch to B's tab (single layout mounts only the active cell) and
    // confirm B rotates now too, not just A.
    const tabs = document.querySelectorAll('.session-tab');
    expect(tabs.length).toBe(2);
    await fireEvent.click(tabs[1]!);
    await tick();
    expect(screen.getByText(TIP_0)).toBeInTheDocument();
    expect(screen.queryByText(SETUP_TIP)).toBeNull();
  });
});

// #4 REGRESSION GATE — the split bootstrap must leave the opened chat on a
// live session (ChatPane + empty-state), NEVER the bare "No session" stub.
// In the split layout the config view can resolve FIRST and bootstrap the
// session before the chat webview's wire exists; DashboardPanel.attachView
// then REPLAYS `sessionCreated` to the freshly-attached chat view. These
// tests model exactly that replay (a sessionCreated arriving after mount)
// and assert the chat lands on the empty-state, not "No session".
describe('ChatPane — #4 no-session regression (split bootstrap replay)', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
  });

  it('shows the bare "No session" stub ONLY before any session is replayed', async () => {
    render(ChatPane);
    await new Promise((r) => setTimeout(r, 0));
    // With zero sessions (no replay yet) the stub is the resting state.
    expect(screen.getByText('No session')).toBeInTheDocument();
    // ...and the ChatPane empty-state is NOT shown (there is no cell).
    expect(screen.queryByText('Type below to jump straight in.')).toBeNull();
  });

  it('a replayed sessionCreated bootstraps the ChatPane + empty-state, not "No session"', async () => {
    render(ChatPane);
    // Simulate the attachView replay: a sessionCreated for the already-live
    // host session arriving after this view mounted.
    postFromHost({
      type: 'sessionCreated',
      sessionId: ACP_UUID,
      sessionNumber: 1,
      agentName: 'Tsuru',
      agentArt: null,
    });
    postFromHost({ type: 'restoreActiveSession', sessionId: ACP_UUID });
    postFromHost({ type: 'modelStatus', ok: false, reason: 'no model loaded' });
    await new Promise((r) => setTimeout(r, 0));

    // The "No session" stub is GONE — a real cell with the empty-state
    // composer hint took over.
    expect(screen.queryByText('No session')).toBeNull();
    expect(screen.getByText('New here? Load your first model in the Setup panel.')).toBeInTheDocument();
    // The composer is mounted, so the user can type straight away.
    expect(document.querySelector('textarea')).not.toBeNull();
  });
});

// #3 — multiple concurrent chat INSTANCES. The new-chat (+) path calls
// DashboardPanel.addSession → createSession → a second `sessionCreated`
// broadcast. ChatPane must register it as an ADDITIONAL session (its own
// tab + thread), switch focus to it, and let the user switch back to #1.
describe('ChatPane — #3 concurrent instances (new-chat / addSession)', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
  });

  it('a second sessionCreated spawns a distinct concurrent instance with its own tab', async () => {
    render(ChatPane);
    const SID1 = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
    const SID2 = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb';

    postFromHost({ type: 'sessionCreated', sessionId: SID1, sessionNumber: 1, agentName: 'Tsuru', agentArt: null });
    postFromHost({ type: 'modelStatus', ok: true, modelName: 'qwen-coder' });
    await new Promise((r) => setTimeout(r, 0));

    // The new-chat (+) command fires a SECOND sessionCreated (addSession).
    postFromHost({ type: 'sessionCreated', sessionId: SID2, sessionNumber: 2, agentName: 'Tsuru', agentArt: null });
    await new Promise((r) => setTimeout(r, 0));

    // BOTH session tabs exist concurrently — #1 and #2, each an independent
    // Tsuru instance (the "agent 2/3" the owner means).
    const tabs = Array.from(document.querySelectorAll('.session-tab')) as HTMLElement[];
    expect(tabs.length).toBe(2);
    expect(tabs.some((t) => /#1\s+Tsuru/.test(t.textContent ?? ''))).toBe(true);
    expect(tabs.some((t) => /#2\s+Tsuru/.test(t.textContent ?? ''))).toBe(true);

    // Focus moved to the new instance...
    const active2 = document.querySelector('.session-tab.active') as HTMLElement | null;
    expect(active2?.textContent).toMatch(/#2\s+Tsuru/);

    // ...and the user can switch back to #1.
    const tab1 = tabs.find((t) => /#1\s+Tsuru/.test(t.textContent ?? ''))!;
    await fireEvent.click(tab1);
    const activeNow = document.querySelector('.session-tab.active') as HTMLElement | null;
    expect(activeNow?.textContent).toMatch(/#1\s+Tsuru/);
  });
});

// Tweak 1 — a shell/execute permission ask must SHOW the literal command the
// user is approving, verbatim, not just a bare title/workdir. Display-only: the
// approve/deny options are untouched.
describe('ChatPane — bash permission shows the literal command (tweak 1)', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
  });

  it('renders the shell command verbatim on the permission bar, options unchanged', async () => {
    render(ChatPane);
    newSession();
    postFromHost({
      type: 'requestPermission',
      sessionId: ACP_UUID,
      toolCallId: 'tc-1',
      title: 'bash',
      kind: 'execute',
      target: 'C:/work/repo',
      command: 'git status --porcelain && npm run build',
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const cmd = await waitFor(() => screen.getByText('git status --porcelain && npm run build'));
    expect(cmd).toBeInTheDocument();
    // Approve/deny semantics are display-only here: the option buttons remain.
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });
});

// Tweak 2 (0.2.176) — the last user message is mirrored as a sticky header pinned
// to the top of the transcript. It PERSISTS from send through the response (no
// longer gated on inFlight) and only changes when a NEW user message replaces it.
// Send-echo UAT (0.4.18) narrowed WHEN it starts: it mirrors output scrolling
// under it, so with nothing under it there is nothing to mirror — the real row is
// right there, and a copy one line above it is the reported "appears TWICE".
describe('ChatPane — last user message stays pinned (tweak 2)', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
  });

  it('keeps the pin after the turn settles and swaps it only when a new user message arrives', async () => {
    const { container } = render(ChatPane);
    newSession();
    postFromHost({ type: 'echoUser', sessionId: ACP_UUID, text: 'add a logout button' });
    postFromHost({ type: 'busy', sessionId: ACP_UUID });
    await new Promise((r) => setTimeout(r, 0));
    // Nothing under it yet ⇒ no mirror, and the ask appears exactly once.
    expect(container.querySelector('.pinned-user')).toBeNull();

    // The agent starts answering: now the ask can scroll away, so it is pinned,
    // carrying the full text as a tooltip.
    postFromHost({ type: 'agentText', sessionId: ACP_UUID, text: 'Adding it.' });
    const pinned = await waitFor(() => {
      const el = container.querySelector('.pinned-user') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    expect(pinned.textContent).toContain('add a logout button');
    expect(pinned.getAttribute('title')).toBe('add a logout button');

    // It PERSISTS once the turn settles (the inFlight gate is gone).
    postFromHost({ type: 'turnDone', sessionId: ACP_UUID, stopReason: 'success' });
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('.pinned-user')?.textContent).toContain('add a logout button');

    // A NEW user message takes the pin over as soon as it has output under it.
    postFromHost({ type: 'echoUser', sessionId: ACP_UUID, text: 'now add signup' });
    postFromHost({ type: 'agentText', sessionId: ACP_UUID, text: 'Signup too.' });
    await waitFor(() =>
      expect(container.querySelector('.pinned-user')?.textContent).toContain('now add signup'),
    );
    expect(container.querySelector('.pinned-user')?.textContent).not.toContain('add a logout button');
  });
});

// Tweak 1 (0.2.176) — the live todo overlay is a SIDE DRAWER: its pull-tab slides
// the panel off toward the edge (items stay MOUNTED, never dropped) and pulls it
// back; the per-session collapsed flag drives the strip's .collapsed state.
describe('ChatPane — run-time todo overlay is a side drawer (tweak 1)', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
  });

  it('collapses and reopens the live todo overlay via its tab, keeping items mounted', async () => {
    const { container } = render(ChatPane);
    newSession();
    postFromHost({
      type: 'todoUpdate',
      sessionId: ACP_UUID,
      source: 'model_write',
      todos: [
        { id: 1, content: 'wire the endpoint', activeForm: 'Wiring the endpoint', status: 'in_progress' },
        { id: 2, content: 'add a test', activeForm: 'Adding a test', status: 'pending' },
      ],
    });
    postFromHost({ type: 'busy', sessionId: ACP_UUID });

    // Overlay is up, expanded, with its items.
    expect(await screen.findByText('wire the endpoint')).toBeInTheDocument();
    const strip = () => container.querySelector('.todo-strip') as HTMLElement;
    expect(strip().classList.contains('collapsed')).toBe(false);

    // Collapse via the tab — the panel slides off, but the items stay MOUNTED.
    await fireEvent.click(screen.getByRole('button', { name: /hide task list/i }));
    await waitFor(() => expect(strip().classList.contains('collapsed')).toBe(true));
    expect(screen.getByText('wire the endpoint')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show task list/i }).getAttribute('aria-expanded')).toBe('false');

    // Reopen — same items, strip no longer collapsed.
    await fireEvent.click(screen.getByRole('button', { name: /show task list/i }));
    await waitFor(() => expect(strip().classList.contains('collapsed')).toBe(false));
    expect(screen.getByText('wire the endpoint')).toBeInTheDocument();
  });
});

// --- M4.4. `need()` asserts INSIDE waitFor: a bare
// `waitFor(() => container.querySelector(x))` resolves immediately with null,
// because returning null does not throw — a trap that makes a real regression
// look like a null-dereference in the test rather than a failure in the pane.
const need = <T extends Element>(container: HTMLElement, sel: string): Promise<T> =>
  waitFor(() => {
    const el = container.querySelector(sel) as T | null;
    expect(el).not.toBeNull();
    return el!;
  });
const clickLabel = async (container: HTMLElement, label: string) => {
  const b = Array.from(container.querySelectorAll('button')).find((x) => x.textContent?.trim() === label);
  expect(b, `no button labelled ${label}`).toBeDefined();
  await fireEvent.click(b!);
};

// --- M4.4 sub-agent drawer. A fan-out puts N children to work and their only
// trace is N tool cards that scroll away, so "is anything still running?" had no
// answer short of scrolling back and reading statuses one at a time. Everything
// it draws is DERIVED from those cards — no second wire to disagree with them.
describe('ChatPane — the sub-agent drawer', () => {
  beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockReset(); });

  const startChild = (id: string, title: string) => postFromHost({
    type: 'toolCall', sessionId: ACP_UUID, toolCallId: 'tc-' + id,
    title, kind: 'other', toolName: 'task', status: 'in_progress', taskSessionId: id,
  });

  it('draws nothing at all — not even a tab — when no sub-agent is out', async () => {
    const { container } = render(ChatPane);
    newSession();
    postFromHost({ type: 'agentChunk', sessionId: ACP_UUID, text: 'just talking\n' });
    await need(container, '.cell-messages');
    expect(container.querySelector('.sa-drawer')).toBeNull();
    expect(container.querySelector('.sa-tab')).toBeNull();
  });

  it('appears COLLAPSED (drawer AND the row list) when a task starts, listing the child once expanded', async () => {
    const { container } = render(ChatPane);
    newSession();
    startChild('child-a', 'task: audit the bundle');
    const drawer = await need(container, '.sa-drawer');
    // Collapsed by default: a roster is consulted, not imposed over the reply.
    expect(drawer.classList.contains('collapsed')).toBe(true);
    // ...and the tab is there to pull it out with.
    expect(container.querySelector('.sa-tab')).not.toBeNull();
    // t-kgryh1 — the LIST'S OWN fold: the header/count reads immediately, but
    // no row (and so no row title) renders until it is asked to expand.
    expect(drawer.textContent).toContain('1 running');
    expect(container.querySelector('.sa-row')).toBeNull();

    await fireEvent.click(await need(container, '.sa-head'));
    await need(container, '.sa-row');
    expect(drawer.textContent).toContain('task: audit the bundle');
  });

  it('the tab opens and closes it', async () => {
    const { container } = render(ChatPane);
    newSession();
    startChild('child-a', 'task: audit the bundle');
    const tab = await need(container, '.sa-tab');

    await fireEvent.click(tab);
    await waitFor(() => expect(container.querySelector('.sa-drawer')!.classList.contains('collapsed')).toBe(false));
    await fireEvent.click(container.querySelector('.sa-tab')!);
    await waitFor(() => expect(container.querySelector('.sa-drawer')!.classList.contains('collapsed')).toBe(true));
  });

  // CONTRACT CHANGE. This used to assert that a finished child left the drawer
  // and that the drawer vanished with the last one. It now MOVES to Complete
  // and stays readable: a sub-agent's output is only worth reading once it has
  // finished, so emptying the drawer at that moment threw away the answer.
  it('moves a child to Complete when it finishes, and keeps the drawer', async () => {
    const { container } = render(ChatPane);
    newSession();
    startChild('child-a', 'task: audit the bundle');
    startChild('child-b', 'task: check the tests');
    await waitFor(() => expect(container.querySelector('.sa-drawer')?.textContent).toContain('2 running'));
    await fireEvent.click(await need(container, '.sa-head')); // expand the list once — persists across the updates below

    postFromHost({
      type: 'toolResult', sessionId: ACP_UUID, toolCallId: 'tc-child-a',
      status: 'completed', content: 'done', taskSessionId: 'child-a',
    });
    await waitFor(() => expect(container.querySelector('.sa-drawer')?.textContent).toContain('1 running'));
    // Still listed — under Complete now, not gone.
    const bandOf = (name: string) => [...container.querySelectorAll('.sa-group')]
      .find((g) => g.textContent?.includes(name))?.querySelector('.sa-group-label')?.textContent;
    expect(bandOf('audit the bundle')).toBe('Complete');
    expect(bandOf('check the tests')).toBe('Running');

    postFromHost({
      type: 'toolResult', sessionId: ACP_UUID, toolCallId: 'tc-child-b',
      status: 'completed', content: 'done', taskSessionId: 'child-b',
    });
    await waitFor(() => expect(container.querySelector('.sa-drawer')?.textContent).toContain('0 running'));
    expect(bandOf('check the tests')).toBe('Complete');
    expect(container.querySelectorAll('.sa-group')).toHaveLength(1);
  });

  // The lifecycle this feature exists for. The extension always launches the
  // engine with background sub-agents ON, so the launcher call returns — and
  // its card completes — moments after the SPAWN, while the child works on for
  // minutes. Retiring on that status is what emptied the drawer mid-fan-out.
  it('a BACKGROUND child outlives its launcher card, showing its model and what it is doing', async () => {
    const { container } = render(ChatPane);
    newSession();
    postFromHost({
      type: 'toolCall', sessionId: ACP_UUID, toolCallId: 'tc-child-a',
      title: 'task: audit the bundle', kind: 'other', toolName: 'task', status: 'in_progress',
      taskSessionId: 'child-a', taskBackground: true, taskModel: 'openrouter/qwen3-coder',
    });
    postFromHost({
      type: 'toolResult', sessionId: ACP_UUID, toolCallId: 'tc-child-a',
      status: 'completed', content: 'started in the background',
      taskSessionId: 'child-a', taskBackground: true, taskModel: 'openrouter/qwen3-coder',
    });

    const drawer = await need(container, '.sa-drawer');
    await fireEvent.click(await need(container, '.sa-head'));
    await waitFor(() => expect(drawer.textContent).toContain('1 running'));
    // WHICH model — a sub-agent routinely runs on a different one from the chat.
    expect(drawer.textContent).toContain('openrouter/qwen3-coder');

    // Live activity from the child lands in ITS row, so "is it stuck?" has an
    // answer without opening the transcript.
    postFromHost({
      type: 'subagentChunk', sessionId: ACP_UUID, childSessionId: 'child-a',
      text: '> read: a.ts\n> bash: npm test\n',
    });
    await waitFor(() =>
      expect(container.querySelector('.sa-activity')?.textContent).toContain('> bash: npm test'),
    );

    // Only the engine's terminal marker ends it — and ending it means moving to
    // Complete, not disappearing (see the contract note above).
    postFromHost({ type: 'subagentDone', sessionId: ACP_UUID, taskSessionId: 'child-a', state: 'completed' });
    await waitFor(() => expect(drawer.textContent).toContain('0 running'));
    expect(container.querySelector('.sa-group-label')?.textContent).toBe('Complete');
  });

  // A spawn the user DENIED, or one naming an agent type that does not exist:
  // the engine fails both before a child session exists (src/tool/task.ts), so
  // the card never carries a `taskSessionId`. The drawer used to show nothing
  // at all for them — a fan-out of two with one denied said "1 running" and
  // gave no sign the second had ever been asked for.
  it('lists a spawn that FAILED before it had a session id, beside the one that ran', async () => {
    const { container } = render(ChatPane);
    newSession();
    startChild('child-a', 'task: audit the bundle');
    postFromHost({
      type: 'toolCall', sessionId: ACP_UUID, toolCallId: 'tc-denied',
      title: 'task: rewrite the config', kind: 'other', toolName: 'task', status: 'in_progress',
    });
    const drawer = await need(container, '.sa-drawer');
    await fireEvent.click(await need(container, '.sa-head'));
    // Anonymous and still in flight: one row, the child that really started.
    await waitFor(() => expect(drawer.textContent).toContain('1 running'));
    expect(drawer.textContent).not.toContain('rewrite the config');

    postFromHost({
      type: 'toolResult', sessionId: ACP_UUID, toolCallId: 'tc-denied',
      status: 'failed', content: 'The user rejected this request',
    });
    await waitFor(() => expect(drawer.textContent).toContain('1 failed'));
    expect(drawer.textContent).toContain('1 running');
    expect(drawer.textContent).toContain('task: rewrite the config');
    expect(container.querySelector('.sa-dot.sa-failed')).not.toBeNull();
  });

  // t-kgryh1 — a failed spawn never settles on its own (subagentEntry.ts), so
  // it needs an explicit way out: a dismiss (x) that clears the DRAWER row
  // without touching the transcript's own permanent record of the refusal.
  it('a dismiss (x) on a failed row drops it from the roster, leaving the transcript card untouched', async () => {
    const { container } = render(ChatPane);
    newSession();
    postFromHost({
      type: 'toolCall', sessionId: ACP_UUID, toolCallId: 'tc-denied',
      title: 'task: rewrite the config', kind: 'other', toolName: 'task', status: 'in_progress',
    });
    postFromHost({
      type: 'toolResult', sessionId: ACP_UUID, toolCallId: 'tc-denied',
      status: 'failed', content: 'The user rejected this request',
    });
    const drawer = await need(container, '.sa-drawer');
    await waitFor(() => expect(drawer.textContent).toContain('1 failed'));
    await fireEvent.click(await need(container, '.sa-head'));
    const dismiss = await need(container, '.sa-dismiss');

    await fireEvent.click(dismiss);
    await waitFor(() => expect(container.querySelector('.sa-drawer')).toBeNull());
    // The tool call's own card (ToolCard.svelte) is a separate, permanent
    // record — dismissing the roster row must not erase it.
    expect(container.querySelector('.tool-card.failed')).not.toBeNull();
  });

  // t-kgryh1 — the OTHER half of "failed rows currently linger forever": a
  // fresh turn sweeps whatever failures are still showing from the LAST one.
  // Chosen over clearing at turnDone — see handleSendForSession's own
  // comment for why — so this test pins BOTH halves of that choice: turnDone
  // alone changes nothing, the next SEND does.
  it('auto-clears a failed row at the START of the next turn, NOT at turnDone', async () => {
    const { container } = render(ChatPane);
    newSession();
    postFromHost({
      type: 'toolCall', sessionId: ACP_UUID, toolCallId: 'tc-denied',
      title: 'task: rewrite the config', kind: 'other', toolName: 'task', status: 'in_progress',
    });
    postFromHost({
      type: 'toolResult', sessionId: ACP_UUID, toolCallId: 'tc-denied',
      status: 'failed', content: 'The user rejected this request',
    });
    const drawer = await need(container, '.sa-drawer');
    await waitFor(() => expect(drawer.textContent).toContain('1 failed'));

    postFromHost({ type: 'turnDone', sessionId: ACP_UUID });
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('.sa-drawer')?.textContent).toContain('1 failed');

    const box = container.querySelector('textarea.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: 'try again' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(container.querySelector('.sa-drawer')).toBeNull());
  });
});

// --- M4.4 YOLO + the free-text answer, from the pane's side: what actually
// leaves for the extension host.
describe('ChatPane — YOLO answers the ask AND stops the asking', () => {
  beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockReset(); });

  const posts = () =>
    globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;

  const askConsent = () => postFromHost({
    type: 'requestPermission', sessionId: ACP_UUID, toolCallId: 'tc-yolo',
    title: 'bash', kind: 'execute', command: 'rm -rf ./build',
    options: [
      { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  });

  it('flips the chat to bypass AND resolves the showing ask with allow_once', async () => {
    // Both halves are the feature: bypass only applies from the NEXT message,
    // so a button that set it alone would leave this prompt sitting there.
    const { container } = render(ChatPane);
    newSession();
    askConsent();
    const yolo = await need(container, '.perm-btn.yolo');
    await fireEvent.click(yolo);

    expect(posts()).toContainEqual({ type: 'setApproveMode', mode: 'bypass', sessionId: ACP_UUID });
    // allow_once, NOT allow_always — a yolo click must not quietly persist a
    // standing rule that pressing Approve would never have created.
    expect(posts()).toContainEqual({ type: 'permission', toolCallId: 'tc-yolo', optionId: 'once', sessionId: ACP_UUID });
    await waitFor(() => expect(container.querySelector('.permission-bar')).toBeNull());
  });

  it('takes allow_always only when the ask offers no allow_once', async () => {
    const { container } = render(ChatPane);
    newSession();
    postFromHost({
      type: 'requestPermission', sessionId: ACP_UUID, toolCallId: 'tc-always-only',
      title: 'external_directory', kind: 'other',
      options: [
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const yolo = await need(container, '.perm-btn.yolo');
    await fireEvent.click(yolo);
    // Never the REJECT option — a button pressed to say yes must not answer no.
    expect(posts()).toContainEqual({ type: 'permission', toolCallId: 'tc-always-only', optionId: 'always', sessionId: ACP_UUID });
  });

  it('promotes the NEXT queued ask rather than leaving the bar empty', async () => {
    // Sub-agents of one chat all ask through this bar. Answering one with yolo
    // must not strand the ones behind it — the mode only helps from the next
    // message, so an already-parked ask still needs an answer.
    const { container } = render(ChatPane);
    newSession();
    askConsent();
    postFromHost({
      type: 'requestPermission', sessionId: ACP_UUID, toolCallId: 'tc-second',
      title: 'write', kind: 'edit', target: 'src/main.ts',
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const yolo = await need(container, '.perm-btn.yolo');
    await fireEvent.click(yolo);
    await waitFor(() => expect(container.querySelector('.permission-title')?.textContent).toContain('write'));
  });

  it('a question-shaped ask opens the question modal and submits all answers at once', async () => {
    const { container } = render(ChatPane);
    newSession();
    postFromHost({
      type: 'requestPermission', sessionId: ACP_UUID, toolCallId: 'tc-q',
      title: 'Which fix?', kind: 'other',
      options: [
        { optionId: 'a', name: 'Rewrite the parser', kind: 'allow_once' },
        { optionId: 'other', name: 'Other', kind: 'allow_once' },
      ],
    });
    await need(container, '.qm-frame');
    expect(container.querySelector('.permission-bar')).toBeNull();

    // The "Other" option is not shown — free-text replaces it
    const optBtns = container.querySelectorAll('.opt-btn');
    expect(optBtns.length).toBe(1);
    expect(optBtns[0].textContent).toContain('Rewrite');

    // Select the option and click Submit
    await fireEvent.click(optBtns[0]);
    await clickLabel(container, 'Submit');

    expect(posts()).toContainEqual({
      type: 'permission', toolCallId: 'tc-q', optionId: 'a',
      sessionId: ACP_UUID,
    });
    // Modal closes after submit
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('.qm-frame')).toBeNull();
  });

  it('a question-shaped ask can be answered with free text and submitted', async () => {
    const { container } = render(ChatPane);
    newSession();
    postFromHost({
      type: 'requestPermission', sessionId: ACP_UUID, toolCallId: 'tc-q',
      title: 'Which fix?', kind: 'other',
      options: [
        { optionId: 'a', name: 'Rewrite the parser', kind: 'allow_once' },
        { optionId: 'other', name: 'Other', kind: 'allow_once' },
      ],
    });
    await need(container, '.qm-frame');

    const box = await need<HTMLInputElement>(container, 'input.free-text-input');
    await fireEvent.input(box, { target: { value: 'neither, revert it' } });
    await clickLabel(container, 'Submit');

    expect(posts()).toContainEqual({
      type: 'permission', toolCallId: 'tc-q', optionId: 'other',
      sessionId: ACP_UUID, answerText: 'neither, revert it',
    });
  });

  it('an ordinary approval carries NO answerText — the reply is unchanged', async () => {
    const { container } = render(ChatPane);
    newSession();
    askConsent();
    await need(container, '.permission-bar');
    await clickLabel(container, 'Allow once');
    expect(posts()).toContainEqual({ type: 'permission', toolCallId: 'tc-yolo', optionId: 'once', sessionId: ACP_UUID });
  });

  it('the REST of the turn runs bar-free after a YOLO click', async () => {
    // The pane's half of the round trip. `setApproveMode: bypass` now reaches the
    // running turn (the engine re-reads the session ruleset per tool call), so
    // the tool calls that follow arrive with no requestPermission at all. What
    // this pins on THIS side: the pane raises no bar of its own for them, sends
    // exactly one reply — for the ask that was actually on screen — and does not
    // re-post setApproveMode per tool call.
    //
    // The engine-side suppression itself is NOT provable here (jsdom never sees
    // the engine); it is pinned by the "bypass set MID-TURN" test in
    // packages/engine/test/session/prompt.test.ts.
    const { container } = render(ChatPane);
    newSession();
    askConsent();
    await fireEvent.click(await need(container, '.perm-btn.yolo'));
    await waitFor(() => expect(container.querySelector('.permission-bar')).toBeNull());

    // The turn carries on: a second tool call, start to finish, unprompted.
    postFromHost({
      type: 'toolCall', sessionId: ACP_UUID, toolCallId: 'tc-after-yolo',
      title: 'write', kind: 'edit', status: 'in_progress',
    });
    postFromHost({
      type: 'toolResult', sessionId: ACP_UUID, toolCallId: 'tc-after-yolo',
      status: 'completed', content: 'Wrote file successfully.',
    });
    postFromHost({ type: 'turnDone', sessionId: ACP_UUID, stopReason: 'success' });
    await new Promise((r) => setTimeout(r, 0));

    expect(container.querySelector('.permission-bar')).toBeNull();
    expect(container.querySelector('.perm-btn.yolo')).toBeNull();
    expect(posts().filter((p) => p.type === 'permission')).toHaveLength(1);
    expect(posts().filter((p) => p.type === 'setApproveMode')).toHaveLength(1);
  });

  // --- A BATCHED clarifying ask: ONE requestPermission carrying N questions.
  // The engine sends the whole set on `_meta.questions` (acp/question.ts) and
  // acpClient hands it over as `questions`. Before batching, the engine blocked
  // on each answer before sending the next question, so the modal could only
  // ever hold one and the counter permanently read "1 of 1".
  const askThree = () => postFromHost({
    type: 'requestPermission', sessionId: ACP_UUID, toolCallId: 'tc-batch',
    title: 'Which parser?', kind: 'other',
    options: [
      { optionId: '0', name: 'Rewrite it', kind: 'allow_once' },
      { optionId: '1', name: 'Patch it', kind: 'reject_once' },
      { optionId: '2', name: 'Other', kind: 'reject_once' },
    ],
    questions: [
      { title: 'Which parser?', options: [
        { optionId: '0', name: 'Rewrite it', kind: 'allow_once' },
        { optionId: '1', name: 'Patch it', kind: 'reject_once' },
        { optionId: '2', name: 'Other', kind: 'reject_once' },
      ] },
      { title: 'Which store?', options: [
        { optionId: '0', name: 'SQLite', kind: 'allow_once' },
        { optionId: '1', name: 'Postgres', kind: 'reject_once' },
        { optionId: '2', name: 'Other', kind: 'reject_once' },
      ] },
      { title: 'Which theme?', options: [
        { optionId: '0', name: 'Dark', kind: 'allow_once' },
        { optionId: '1', name: 'Light', kind: 'reject_once' },
        { optionId: '2', name: 'Other', kind: 'reject_once' },
      ] },
    ],
  });

  it('a 3-question ask shows "1 of 3" and steps through all three titles', async () => {
    const { container } = render(ChatPane);
    newSession();
    askThree();
    await need(container, '.qm-frame');

    // THE bug this whole change exists to fix: the counter must read the size
    // of the batch, not 1.
    expect(container.querySelector('.qm-counter')?.textContent).toBe('1 of 3');
    expect(container.querySelector('.qm-q-title')?.textContent).toContain('Which parser?');
    // One stepper square per question — the user can see there are three.
    expect(container.querySelectorAll('.qm-step').length).toBe(3);

    await clickLabel(container, 'Next');
    expect(container.querySelector('.qm-counter')?.textContent).toBe('2 of 3');
    expect(container.querySelector('.qm-q-title')?.textContent).toContain('Which store?');

    await clickLabel(container, 'Next');
    expect(container.querySelector('.qm-counter')?.textContent).toBe('3 of 3');
    expect(container.querySelector('.qm-q-title')?.textContent).toContain('Which theme?');
    // Last step offers Submit, not Next.
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Next')).toBe(false);
  });

  it('submits all three answers in ONE permission message, each mapped to its own question', async () => {
    const { container } = render(ChatPane);
    newSession();
    askThree();
    await need(container, '.qm-frame');

    // Q1 -> "Patch it" (option 1). Deliberately NOT index 0 on every question,
    // so an answer attached to the wrong question cannot pass.
    await fireEvent.click(container.querySelectorAll('.opt-btn')[1]!);
    await clickLabel(container, 'Next');
    // Q2 -> "SQLite" (option 0)
    await fireEvent.click(container.querySelectorAll('.opt-btn')[0]!);
    await clickLabel(container, 'Next');
    // Q3 -> free text, which must win over any option
    const box = await need<HTMLInputElement>(container, 'input.free-text-input');
    await fireEvent.input(box, { target: { value: 'solarised, actually' } });
    await clickLabel(container, 'Submit');

    const permissions = posts().filter((p) => p.type === 'permission');
    // ONE reply for ONE ask — three replies would be the old, broken shape.
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toEqual({
      type: 'permission', toolCallId: 'tc-batch', sessionId: ACP_UUID,
      // Head answer keeps the single-question wire shape.
      optionId: '1',
      answers: [
        { optionId: '1' },
        { optionId: '0' },
        { optionId: '2', answerText: 'solarised, actually' },
      ],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('.qm-frame')).toBeNull();
  });

  it('an answer changed by stepping BACK is the one submitted', async () => {
    const { container } = render(ChatPane);
    newSession();
    askThree();
    await need(container, '.qm-frame');

    await fireEvent.click(container.querySelectorAll('.opt-btn')[0]!); // Q1 -> Rewrite it
    await clickLabel(container, 'Next');
    await fireEvent.click(container.querySelectorAll('.opt-btn')[0]!); // Q2 -> SQLite
    await clickLabel(container, 'Back');
    await fireEvent.click(container.querySelectorAll('.opt-btn')[1]!); // Q1 -> Patch it instead
    await clickLabel(container, 'Next');
    await clickLabel(container, 'Next');
    await clickLabel(container, 'Submit');

    const reply = posts().filter((p) => p.type === 'permission')[0]!;
    expect((reply['answers'] as Array<{ optionId: string }>)[0]).toEqual({ optionId: '1' });
    expect(reply['optionId']).toBe('1');
  });

  it('CANCEL tells the engine, once, and clears the modal', async () => {
    const { container } = render(ChatPane);
    newSession();
    askThree();
    await need(container, '.qm-frame');

    // By SELECTOR, not label: InputBar also renders a "Cancel" button and it
    // comes first in document order.
    await fireEvent.click(await need(container, '.qm-cancel-btn'));

    const permissions = posts().filter((p) => p.type === 'permission');
    // Exactly ONE cancellation, carrying optionId null. Clearing the modal
    // WITHOUT this leaves the engine blocked on an answer that never comes —
    // which is precisely how Cancel used to hang the turn.
    expect(permissions).toEqual([
      { type: 'permission', toolCallId: 'tc-batch', optionId: null, sessionId: ACP_UUID },
    ]);
    await waitFor(() => expect(container.querySelector('.qm-frame')).toBeNull());
  });

  it('BACK-COMPAT: an ask with no `questions` still renders as one question', async () => {
    const { container } = render(ChatPane);
    newSession();
    // Exactly the pre-batching shape: title + options, no `questions`.
    postFromHost({
      type: 'requestPermission', sessionId: ACP_UUID, toolCallId: 'tc-old',
      title: 'Which fix?', kind: 'other',
      options: [
        { optionId: 'a', name: 'Rewrite the parser', kind: 'allow_once' },
        { optionId: 'other', name: 'Other', kind: 'allow_once' },
      ],
    });
    await need(container, '.qm-frame');
    expect(container.querySelector('.qm-counter')?.textContent).toBe('1 of 1');

    await fireEvent.click(container.querySelectorAll('.opt-btn')[0]!);
    await clickLabel(container, 'Submit');
    // No `answers` key — a one-question reply is byte-for-byte what it was.
    expect(posts()).toContainEqual({
      type: 'permission', toolCallId: 'tc-old', optionId: 'a', sessionId: ACP_UUID,
    });
  });
});

// Tab strip waiting-for-user colour — the SAME semantic as the sidebar ring
// (chat/sessionRowState.ts): a chat's tab lights up when it holds an open
// question batch OR a pending permission approval, because either one means
// the engine is parked on the user and the tab is where they answer it.
describe('ChatPane — tab strip waiting-for-user colour', () => {
  beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockReset(); });

  const SID_A = 'aaaaaaaa-tab1-tab1-tab1-aaaaaaaaaaaa';
  const SID_B = 'bbbbbbbb-tab2-tab2-tab2-bbbbbbbbbbbb';

  async function twoSessions() {
    postFromHost({ type: 'sessionCreated', sessionId: SID_A, sessionNumber: 1, agentName: 'Tsuru', agentArt: null });
    postFromHost({ type: 'modelStatus', ok: true, modelName: 'qwen-coder' });
    postFromHost({ type: 'sessionCreated', sessionId: SID_B, sessionNumber: 2, agentName: 'Tsuru', agentArt: null });
    postFromHost({ type: 'modelStatus', ok: true, modelName: 'qwen-coder' });
    await new Promise((r) => setTimeout(r, 0));
  }

  function tabFor(sid: string): HTMLElement {
    const tabs = Array.from(document.querySelectorAll('.session-tab')) as HTMLElement[];
    const t = tabs.find((el) => sid === SID_A ? /#1\s+Tsuru/.test(el.textContent ?? '') : /#2\s+Tsuru/.test(el.textContent ?? ''));
    expect(t, `no tab for ${sid}`).toBeDefined();
    return t!;
  }

  it('lights the tab when a question batch opens for that chat, and leaves the other tab alone', async () => {
    render(ChatPane);
    await twoSessions();
    postFromHost({
      type: 'requestPermission', sessionId: SID_A, toolCallId: 'tc-tab-q',
      title: 'Which fix?', kind: 'other',
      options: [
        { optionId: 'a', name: 'Rewrite the parser', kind: 'allow_once' },
        { optionId: 'other', name: 'Other', kind: 'allow_once' },
      ],
    });
    await waitFor(() => expect(tabFor(SID_A).classList.contains('tab-waiting')).toBe(true));
    expect(tabFor(SID_B).classList.contains('tab-waiting')).toBe(false);
  });

  it('lights the tab when a permission ask is pending for that chat', async () => {
    render(ChatPane);
    await twoSessions();
    postFromHost({
      type: 'requestPermission', sessionId: SID_A, toolCallId: 'tc-tab-p',
      title: 'bash', kind: 'execute', command: 'npm test',
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    await waitFor(() => expect(tabFor(SID_A).classList.contains('tab-waiting')).toBe(true));
    expect(tabFor(SID_B).classList.contains('tab-waiting')).toBe(false);
  });

  it('stays lit when a question batch AND a queued permission ask are open at once', async () => {
    const { container } = render(ChatPane);
    await twoSessions();
    // Single-chat layout mounts only the ACTIVE cell; twoSessions() leaves B
    // active, so A must be reselected for its modal/bar to render at all.
    await fireEvent.click(tabFor(SID_A));
    postFromHost({
      type: 'requestPermission', sessionId: SID_A, toolCallId: 'tc-tab-both-q',
      title: 'Which fix?', kind: 'other',
      options: [
        { optionId: 'a', name: 'Rewrite the parser', kind: 'allow_once' },
        { optionId: 'other', name: 'Other', kind: 'allow_once' },
      ],
    });
    await need(container, '.qm-frame');
    // A sub-agent under the SAME chat asks a real (non-question) permission
    // while the question batch is still open — both signals live on SID_A.
    postFromHost({
      type: 'requestPermission', sessionId: SID_A, toolCallId: 'tc-tab-both-p',
      title: 'bash', kind: 'execute', command: 'npm test',
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    await waitFor(() => expect(tabFor(SID_A).classList.contains('tab-waiting')).toBe(true));
  });

  it('clears once the question batch is answered', async () => {
    const { container } = render(ChatPane);
    await twoSessions();
    await fireEvent.click(tabFor(SID_A));
    postFromHost({
      type: 'requestPermission', sessionId: SID_A, toolCallId: 'tc-tab-clear-q',
      title: 'Which fix?', kind: 'other',
      options: [
        { optionId: 'a', name: 'Rewrite the parser', kind: 'allow_once' },
        { optionId: 'other', name: 'Other', kind: 'allow_once' },
      ],
    });
    await need(container, '.qm-frame');
    await waitFor(() => expect(tabFor(SID_A).classList.contains('tab-waiting')).toBe(true));
    await fireEvent.click(container.querySelectorAll('.opt-btn')[0]!);
    await clickLabel(container, 'Submit');
    await waitFor(() => expect(tabFor(SID_A).classList.contains('tab-waiting')).toBe(false));
  });

  it('clears once the pending permission ask is answered', async () => {
    const { container } = render(ChatPane);
    await twoSessions();
    await fireEvent.click(tabFor(SID_A));
    postFromHost({
      type: 'requestPermission', sessionId: SID_A, toolCallId: 'tc-tab-clear-p',
      title: 'bash', kind: 'execute', command: 'npm test',
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    await waitFor(() => expect(tabFor(SID_A).classList.contains('tab-waiting')).toBe(true));
    await clickLabel(container, 'Allow once');
    await waitFor(() => expect(tabFor(SID_A).classList.contains('tab-waiting')).toBe(false));
  });

  it('closing a chat with an open question clears the stale entry — reopening the same id does not resurrect the modal', async () => {
    const { container } = render(ChatPane);
    postFromHost({ type: 'sessionCreated', sessionId: SID_A, sessionNumber: 1, agentName: 'Tsuru', agentArt: null });
    postFromHost({ type: 'modelStatus', ok: true, modelName: 'qwen-coder' });
    postFromHost({
      type: 'requestPermission', sessionId: SID_A, toolCallId: 'tc-stale',
      title: 'Which fix?', kind: 'other',
      options: [
        { optionId: 'a', name: 'Rewrite the parser', kind: 'allow_once' },
        { optionId: 'other', name: 'Other', kind: 'allow_once' },
      ],
    });
    await need(container, '.qm-frame');

    postFromHost({ type: 'sessionClosed', sessionId: SID_A });
    await waitFor(() => expect(container.querySelector('.qm-frame')).toBeNull());

    // The same session id comes back (a recall/reopen) with NO fresh ask at
    // all. A stale questionAsks entry would resurrect the old batch here.
    postFromHost({ type: 'sessionCreated', sessionId: SID_A, sessionNumber: 1, agentName: 'Tsuru', agentArt: null });
    postFromHost({ type: 'modelStatus', ok: true, modelName: 'qwen-coder' });
    await new Promise((r) => setTimeout(r, 0));

    expect(container.querySelector('.qm-frame')).toBeNull();
  });

  // t-q41knp — the dot was replaced with the brand crane itself: every tab
  // carries ONE crane mark regardless of state, and only its colour (CSS on
  // `.tab-waiting`, not a swapped/added element) says "needs you". jsdom has
  // no layout engine, so it cannot compute the cascaded colour a real
  // browser would paint — the DOM checks below prove the glyph is present
  // and stays the SAME element across the state change; the source-text
  // check after them proves the colour rule exists in the stylesheet. Only
  // an eyeballed screenshot proves the pixel actually reads periwinkle-blue.
  it('every tab carries the crane mark, waiting or not', async () => {
    render(ChatPane);
    await twoSessions();
    for (const sid of [SID_A, SID_B]) {
      const crane = tabFor(sid).querySelector('.tab-crane svg.crane-mark');
      expect(crane, `no crane mark in the tab for ${sid}`).not.toBeNull();
    }
  });

  it('going waiting keeps the SAME crane element — colour is a class-driven CSS switch, not a swap', async () => {
    render(ChatPane);
    await twoSessions();
    const craneBefore = tabFor(SID_A).querySelector('.tab-crane');
    postFromHost({
      type: 'requestPermission', sessionId: SID_A, toolCallId: 'tc-tab-crane',
      title: 'Which fix?', kind: 'other',
      options: [
        { optionId: 'a', name: 'Rewrite the parser', kind: 'allow_once' },
        { optionId: 'other', name: 'Other', kind: 'allow_once' },
      ],
    });
    await waitFor(() => expect(tabFor(SID_A).classList.contains('tab-waiting')).toBe(true));
    const tabsNow = tabFor(SID_A);
    expect(tabsNow.querySelectorAll('.tab-crane').length).toBe(1);
    expect(tabsNow.querySelector('.tab-crane')).toBe(craneBefore);
  });

  it('the stylesheet tints .tab-crane (not a ::before dot) on .tab-waiting', () => {
    const src = readFileSync(join(__dirname, 'ChatPane.svelte'), 'utf-8');
    expect(src).toMatch(/\.session-tab\.tab-waiting\s+\.tab-crane\s*\{\s*color:\s*var\(--og-status-waiting\)/);
    expect(src).not.toMatch(/\.tab-waiting::before/);
  });
});

// --- The todo list is a SCRATCHBOOK, not a per-turn banner.
//
// THE DEFECT (owner report: "todo is more solid now but it kind of gets dropped
// more often now — this isn't the intended design of a scratchbook style").
// The engine's list is durable (0.3.88: TodoTable persists, origami/todoSnapshot
// replays it on load). The PANE threw it away three times over: the overlay was
// gated on `inFlight || linger`, the post-turn linger cleared `todos` outright,
// and the next send cleared them again. A session that fans work out to
// BACKGROUND sub-agents ends a turn every couple of minutes while the work runs
// on for half an hour — so the list the user is trying to follow blinked out
// 1.8s after every turn and did not come back until the model happened to write
// it again.
//
// The rule these pin: the list stays on screen while it has OPEN WORK, across
// turn boundaries and across a reattach; it settles into the transcript as a
// collapsed one-liner only once every row is completed.
describe('ChatPane — the todo overlay is a scratchbook across turn boundaries', () => {
  beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockReset(); });

  const OPEN_TODOS = [
    { id: 1, content: 'write the hero guide', activeForm: 'Writing the hero guide', status: 'in_progress' },
    { id: 2, content: 'write the unit guide', activeForm: 'Writing the unit guide', status: 'pending' },
  ];
  const DONE_TODOS = OPEN_TODOS.map((t) => ({ ...t, status: 'completed' }));

  const writeTodos = (todos: unknown[], source = 'model_write') =>
    postFromHost({ type: 'todoUpdate', sessionId: ACP_UUID, source, todos });

  const overlay = (c: HTMLElement) => c.querySelector('.todo-overlay');
  const summary = (c: HTMLElement) => c.querySelector('.todo-summary-msg');
  /** Past the 1800ms post-turn linger, so what remains is what genuinely persists.
   *  REAL timers on purpose: the overlay leaves via a Svelte outro that settles on
   *  microtasks (see setup.ts's Animation stub), and faking the clock would let the
   *  assertion run while the element is still mid-exit. */
  const pastLinger = async () => { await new Promise((r) => setTimeout(r, 2300)); await tick(); };

  // THE headline. The export that prompted this (a 6-way background fan-out)
  // ends a turn immediately after each spawn: `task` returns "started in the
  // background" and the model stops talking, while the children work for
  // minutes. Under the old gate the checklist for that very work vanished.
  it('a turn that ENDS while a background sub-agent still runs keeps the list on screen', async () => {
    const { container } = render(ChatPane);
    newSession();
    writeTodos(OPEN_TODOS);
    postFromHost({ type: 'busy', sessionId: ACP_UUID });
    // A background child: its launcher card completes at once, the child runs on.
    postFromHost({
      type: 'toolCall', sessionId: ACP_UUID, toolCallId: 'tc-hero',
      title: 'task: write the hero guide', kind: 'other', toolName: 'task',
      status: 'in_progress', taskSessionId: 'child-hero', taskBackground: true,
    });
    postFromHost({
      type: 'toolResult', sessionId: ACP_UUID, toolCallId: 'tc-hero',
      status: 'completed', content: 'started in the background',
      taskSessionId: 'child-hero', taskBackground: true,
    });
    await tick();
    expect(overlay(container)).not.toBeNull();

    // The turn ends — but the WORK has not.
    postFromHost({ type: 'turnDone', sessionId: ACP_UUID, stopReason: 'success' });
    await pastLinger();

    expect(overlay(container), 'the list vanished once the turn ended').not.toBeNull();
    expect(overlay(container)!.textContent).toContain('write the hero guide');
    expect(overlay(container)!.textContent).toContain('write the unit guide');
  });

  // Reattach / window reload. The engine replays its durable list as an
  // `origami/todoSnapshot` with source `session_restore` (acpClient.ts) and the
  // pane already stored it — it simply refused to DRAW it, because a recalled
  // session is neither in flight nor lingering. Recoverable state that cannot
  // be seen is not recoverable.
  it('a session_restore snapshot renders with NO new turn (reattach)', async () => {
    const { container } = render(ChatPane);
    newSession();
    writeTodos(OPEN_TODOS, 'session_restore');
    await tick();
    expect(overlay(container), 'a replayed list needs a fresh turn to become visible').not.toBeNull();
    expect(overlay(container)!.textContent).toContain('write the hero guide');
  });

  // The second half of the drop: even if the user prompts again, the pane wiped
  // the list at send, so a turn that reports on the sub-agents WITHOUT rewriting
  // its todos (the common case — the model narrates rather than calling
  // todowrite) showed nothing at all.
  it('a NEW turn that writes no todos still shows the list it inherited', async () => {
    const { container } = render(ChatPane);
    newSession();
    writeTodos(OPEN_TODOS);
    postFromHost({ type: 'busy', sessionId: ACP_UUID });
    postFromHost({ type: 'turnDone', sessionId: ACP_UUID, stopReason: 'success' });
    await tick();

    const box = container.querySelector('textarea.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: 'any progress?' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    await tick();

    expect(overlay(container), 'sending a message wiped the scratchbook').not.toBeNull();
    expect(overlay(container)!.textContent).toContain('write the unit guide');
  });

  // A mid-turn failure must not take the plan with it: the engine still holds
  // the list, and the user needs to see what was outstanding when it broke.
  it('an error mid-turn does not wipe the list', async () => {
    const { container } = render(ChatPane);
    newSession();
    writeTodos(OPEN_TODOS);
    postFromHost({ type: 'busy', sessionId: ACP_UUID });
    postFromHost({ type: 'error', sessionId: ACP_UUID, message: 'stream closed' });
    await tick();
    expect(overlay(container)).not.toBeNull();
    expect(overlay(container)!.textContent).toContain('write the hero guide');
  });

  // THE COUNTERWEIGHT, and the reason this is "open work" and not "always on":
  // a FINISHED list must still retire, or every idle recalled session would wear
  // a stale green checklist forever. Completion — not the turn boundary — is
  // what settles it into the transcript.
  it('a list whose rows are ALL completed still retires into the transcript one-liner', async () => {
    const { container } = render(ChatPane);
    newSession();
    writeTodos(OPEN_TODOS);
    postFromHost({ type: 'busy', sessionId: ACP_UUID });
    await tick();
    expect(overlay(container)).not.toBeNull();

    writeTodos(DONE_TODOS);
    postFromHost({ type: 'turnDone', sessionId: ACP_UUID, stopReason: 'success' });
    await pastLinger();

    expect(overlay(container), 'a fully completed list stayed up forever').toBeNull();
    // ...and it is not LOST — the collapsed snapshot is in the transcript.
    // It reads as a one-liner by design (TodoStrip `interactive` opens on
    // click), so the record to assert is the header and its full count.
    expect(summary(container), 'the finished list left no record behind').not.toBeNull();
    expect(summary(container)!.textContent).toContain('2/2 done');
  });

  // The escape hatch. Persistence must not become a list nobody can put down:
  // a `todowrite` with an EMPTY array is the model abandoning the plan, and the
  // pane replaces wholesale, so the overlay must go with it.
  it('an emptied list clears the overlay (the model can still put the scratchbook down)', async () => {
    const { container } = render(ChatPane);
    newSession();
    writeTodos(OPEN_TODOS);
    postFromHost({ type: 'busy', sessionId: ACP_UUID });
    await tick();
    expect(overlay(container)).not.toBeNull();

    writeTodos([]);
    postFromHost({ type: 'turnDone', sessionId: ACP_UUID, stopReason: 'success' });
    await pastLinger();
    expect(overlay(container)).toBeNull();
  });

  // Open work must NOT spam the transcript with a duplicate snapshot on every
  // turn end — the live overlay is the record while the work is outstanding.
  it('an unfinished list leaves no transcript snapshot at turn end (no per-turn spam)', async () => {
    const { container } = render(ChatPane);
    newSession();
    writeTodos(OPEN_TODOS);
    postFromHost({ type: 'busy', sessionId: ACP_UUID });
    postFromHost({ type: 'turnDone', sessionId: ACP_UUID, stopReason: 'success' });
    await pastLinger();
    postFromHost({ type: 'busy', sessionId: ACP_UUID });
    postFromHost({ type: 'turnDone', sessionId: ACP_UUID, stopReason: 'success' });
    await pastLinger();

    expect(container.querySelectorAll('.todo-summary-msg').length).toBe(0);
    expect(overlay(container)).not.toBeNull();
  });
});

// THE END-TO-END PASS for the image lightbox. The component tests beside it
// prove each piece in isolation — the strip reports a click, the row reports a
// click, the overlay opens and closes. None of them prove the pieces are
// CONNECTED, which is the failure this feature is most likely to ship with:
// every part green, and clicking an image in a real chat does nothing because
// the pane never passed a handler down or never mounted the overlay.
//
// So this drives the SHIPPED host->webview bridge (an `echoUser` carrying
// `images`, exactly as DashboardPanel posts it), clicks the picture that
// reaches the DOM, and asserts the enlarged copy appears in the pane. It also
// covers the pane-level rule the isolated tests structurally cannot: ONE
// backdrop, whatever is clicked.
describe('ChatPane — a click on a chat image opens it enlarged', () => {
  const IMG = 'data:image/png;base64,AAAA';
  const IMG2 = 'data:image/png;base64,BBBB';
  const lightbox = (c: HTMLElement) => c.querySelector('.il-backdrop');
  const enlarged = (c: HTMLElement) => c.querySelector('.il-image') as HTMLImageElement | null;

  function userMessageWithImages(images: string[]) {
    postFromHost({ type: 'echoUser', sessionId: ACP_UUID, text: 'look at this', images });
  }

  it('is shut until an image is clicked, then shows THAT image', async () => {
    const { container } = render(ChatPane);
    newSession();
    userMessageWithImages([IMG]);
    await tick();

    expect(lightbox(container), 'no lightbox before any click').toBeNull();
    const thumb = container.querySelector('img.chat-image') as HTMLImageElement;
    expect(thumb, 'the transcript should render the attached image').not.toBeNull();

    await fireEvent.click(thumb);
    expect(enlarged(container)?.getAttribute('src')).toBe(IMG);
  });

  it('shows the image that was clicked, not merely the first one', async () => {
    const { container } = render(ChatPane);
    newSession();
    userMessageWithImages([IMG, IMG2]);
    await tick();

    const thumbs = container.querySelectorAll('img.chat-image');
    expect(thumbs.length).toBe(2);
    await fireEvent.click(thumbs[1]);
    expect(enlarged(container)?.getAttribute('src')).toBe(IMG2);
  });

  // One pane, one veil. A per-row or per-cell mount would stack backdrops,
  // which no screenshot of a single open lightbox would reveal.
  it('mounts exactly ONE backdrop no matter how many images the chat holds', async () => {
    const { container } = render(ChatPane);
    newSession();
    userMessageWithImages([IMG, IMG2]);
    userMessageWithImages([IMG]);
    await tick();

    await fireEvent.click(container.querySelectorAll('img.chat-image')[0]);
    expect(container.querySelectorAll('.il-backdrop').length).toBe(1);
  });

  it('closes again on Escape, leaving the transcript untouched', async () => {
    const { container } = render(ChatPane);
    newSession();
    userMessageWithImages([IMG]);
    await tick();

    await fireEvent.click(container.querySelector('img.chat-image')!);
    expect(lightbox(container)).not.toBeNull();

    await fireEvent.keyDown(window, { key: 'Escape' });
    await tick();
    expect(lightbox(container), 'Escape should shut the lightbox').toBeNull();
    expect(container.querySelectorAll('img.chat-image').length).toBe(1);
  });

  it('closes on a backdrop click', async () => {
    const { container } = render(ChatPane);
    newSession();
    userMessageWithImages([IMG]);
    await tick();

    await fireEvent.click(container.querySelector('img.chat-image')!);
    await fireEvent.click(container.querySelector('.il-backdrop')!);
    await tick();
    expect(lightbox(container)).toBeNull();
  });
});
