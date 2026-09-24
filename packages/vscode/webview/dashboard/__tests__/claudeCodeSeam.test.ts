// claudeCodeSeam.test.ts — the manager: what the webview sends, what the child
// gets, and what comes back.
//
// This is the layer the driver tests cannot reach. A permission answer travels
// webview → DashboardPanel's one dispatch line → this manager → the driver →
// stdin, and every one of those hops can silently drop it. The deny test below
// drives the WHOLE path with the message ChatPane actually posts.
//
// ROUND 2 — the ids are ENGINE CELL ids now, minted by the host's `createCell`,
// because that is the only kind of id anything in this extension can draw a
// chat for. `describe('the surface')` below is the regression guard for the
// UAT that proved it; the rest of this file is unchanged behaviour under the
// new ids.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_MESSAGE_TYPES, CLAUDE_CODE_RESUME_KEY, DEFAULT_CLAUDE_CODE_MODEL, PASSTHROUGH_KIND,
  __resetClaudeCodeForTests, claudeCodeKind, claudeCodeModelOf, claudeCodeOwns, handleClaudeCodeMessage,
  modeFromApprove, type ClaudeCodeHost,
} from '../../../src/dashboard/claudeCodeManager';
import { dividerText } from '../../../src/dashboard/claudeCodeCell';
import { RESUME_RUN, type ResumeStore } from '../../../src/dashboard/claudeCodeResume';
import type { SpawnChild } from '../../../src/claudeCode/driver';
import { isQuestionShaped } from '../components/permissionOptions';
import { FakeChild, canUseTool } from './claudeCodeFakeChild';
import { RUN1_RESULT, RUN1_SYSTEM_INIT, RUN1_TEXT_DELTA } from './claudeCodeFixtures';

const CWD = 'C:\\repo';
const SESSION = 'c6bab4a9-9d8a-4bf1-855d-9d7e146f884a';
/** The id the fake host mints — see `createCell` below for why it has this shape. */
const CELL = 'session-1';

interface Seam {
  host: ClaudeCodeHost;
  posts: Array<Record<string, unknown>>;
  logs: string[];
  store: { value: ResumeStore | undefined };
  /** Cell ids the host was asked to create, in order. */
  created: string[];
  /** Messages handed BACK to the panel's own dispatch. */
  redispatched: Array<Record<string, unknown>>;
  child(): FakeChild;
  postsOf(type: string): Array<Record<string, unknown>>;
}

function seam(resume?: ResumeStore): Seam {
  const posts: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const store: { value: ResumeStore | undefined } = { value: resume };
  const children: FakeChild[] = [];
  const created: string[] = [];
  const redispatched: Array<Record<string, unknown>> = [];
  const spawn: SpawnChild = () => { const c = new FakeChild(); children.push(c); return c; };
  const host: ClaudeCodeHost = {
    post: (m) => posts.push(m),
    cwd: CWD,
    read: () => store.value,
    write: (next) => { store.value = next; },
    log: (l) => logs.push(l),
    // Mirrors DashboardPanel.createSession, which is what the real host wires
    // this to. VERBATIM from src/dashboard/DashboardPanel.ts:
    //     const sessionId = `session-${sessionNum}`;
    //     …
    //     this.sessions.set(sessionId, session);
    // The id SHAPE is not the point; the point is that the id comes from the
    // panel's own map, because openSessionInEditor refuses every other id.
    createCell: async () => { const id = `session-${created.length + 1}`; created.push(id); return id; },
    redispatch: (m) => redispatched.push(m),
    cli: async () => ({ binary: 'C:\\claude.exe', version: '2.1.198', source: 'native-install' }),
    spawn,
  };
  return { host, posts, logs, store, created, redispatched, child: () => children[children.length - 1]!, postsOf: (t) => posts.filter((p) => p.type === t) };
}

const create = async (s: Seam) => { await handleClaudeCodeMessage(s.host, { type: 'newClaudeCodeSession' }); return s.created[s.created.length - 1]!; };
/** Create AND take a turn. The child is spawned lazily on the first prompt —
 *  a chat cell nobody has typed into must not cost a process — so any test
 *  that talks to the child has to send first. */
const armed = async (s: Seam) => { await create(s); await handleClaudeCodeMessage(s.host, { type: 'send', text: 'go', sessionId: CELL }); };

beforeEach(() => __resetClaudeCodeForTests());

describe('ownership — which messages this feature answers', () => {
  it('claims its three entry types and nothing else', () => {
    // t-463pb6 added `openClaudeHistory` — a History pick, which is a NEW cell
    // seeded to resume a CLI conversation, never a message to an existing one.
    expect(CLAUDE_CODE_MESSAGE_TYPES).toEqual(new Set(['requestClaudeCodeStatus', 'newClaudeCodeSession', 'openClaudeHistory']));
    expect(claudeCodeOwns({ type: 'newClaudeCodeSession' })).toBe(true);
    expect(claudeCodeOwns({ type: 'send', sessionId: 'session-3' })).toBe(false);
    expect(claudeCodeOwns({ type: 'newSession' })).toBe(false);
  });

  it('claims a per-session message only once that session exists', async () => {
    const s = seam();
    expect(claudeCodeOwns({ type: 'send', sessionId: CELL })).toBe(false);
    await create(s);
    expect(claudeCodeOwns({ type: 'send', sessionId: CELL })).toBe(true);
    await handleClaudeCodeMessage(s.host, { type: 'closeSession', sessionId: CELL });
    // Closed: the engine path must get its own ids back.
    expect(claudeCodeOwns({ type: 'send', sessionId: CELL })).toBe(false);
  });
});

// THE UAT REGRESSION (round 2). Phase 1 shipped fully green with this exact
// feature broken on the real surface: the sidebar listed "#4 Claude Code" and
// no chat pane ever drew a cell for it. Every phase-1 test asserted the SHAPE of
// the posts this manager makes and none of them asked the question the surface
// asks — is this an id anything can open?
//
// It cannot be answered by looking at a post. In DashboardPanel.ts the engine's
// new-chat flow ends:
//
//     if (session.kind !== 'agent') { void DashboardPanel.openSessionInEditor(this.context, sessionId); … }
//
// and openSessionInEditor's own guard is:
//
//     const session = host.sessions.get(sessionId);
//     if (!session) {
//       vscode.window.showInformationMessage('Origami: that chat is no longer open.');
//       return;
//     }
//
// `replaySessionsTo`, which seeds a freshly attached tab, walks the same map.
// So an id that map does not hold has no tab, no cell, and no way to get one —
// which is precisely what a private `claude-N` id was. The invariant below is
// the one that was broken, stated so it can only hold one way.
describe('the surface — every id this feature uses is one the panel can open', () => {
  it('asks the HOST for a cell instead of minting an id of its own', async () => {
    const s = seam();
    await handleClaudeCodeMessage(s.host, { type: 'newClaudeCodeSession' });
    expect(s.created, 'no cell was created — a private id has no tab and no pane').toHaveLength(1);
    const id = s.created[0]!;
    // Not a shape assertion: this is the whole defect. Any sessionId this
    // feature posts that the host did not create is an id openSessionInEditor
    // refuses and replaySessionsTo skips.
    const posted = new Set(s.posts.map((p) => p.sessionId).filter((v) => typeof v === 'string' && v));
    expect([...posted]).toEqual([id]);
  });

  it('binds the cell it was HANDED when the pick comes from a chat', async () => {
    const s = seam();
    // The picker posts against a cell that already exists — the manager must
    // never create a second one behind it.
    await handleClaudeCodeMessage(s.host, { type: 'setModel', modelId: 'claude-code/opus', sessionId: 'session-7' });
    expect(s.created).toEqual([]);
    expect(claudeCodeOwns({ type: 'send', sessionId: 'session-7' })).toBe(true);
  });

  it('never leaves a cell created but unbound when the CLI is missing', async () => {
    const s = seam();
    const host = { ...s.host, cli: async () => null };
    await handleClaudeCodeMessage(host, { type: 'newClaudeCodeSession' });
    // An empty chat cell the user did not ask for is worse than the error alone.
    expect(s.created).toEqual([]);
    expect(String(s.postsOf('error')[0]!.message)).toContain('not found');
  });
});

describe('creating a passthrough chat', () => {
  // ONE system row for the bind, not two. A bind used to post its own "Claude
  // Code <version> — a new session in <cwd>…" line as well as the divider, so a
  // new chat carried THREE system rows before its first answer (divider, bind
  // line, then the connected line) and two of them repeated the same sentence
  // about settings and MCP servers. The bind line also could not name the model
  // or the roster — the child had not spoken yet — so the facts it lacked and
  // the clause it carried BOTH belong on the connected line. It fires on
  // `system/init`, which is why nothing but the divider is here.
  it('flips the cell to the passthrough kind and says so in ONE transcript line', async () => {
    const s = seam();
    const id = await create(s);
    expect(s.postsOf('sessionKind')[0]).toMatchObject({ sessionId: id, kind: PASSTHROUGH_KIND });
    expect(s.postsOf('sessionTitle')[0]).toMatchObject({ sessionId: id, title: 'Claude Code' });
    expect(s.postsOf('system').map((p) => String(p.text))).toEqual([dividerText(DEFAULT_CLAUDE_CODE_MODEL, '')]);
  });

  it('says so plainly when the CLI is not installed, and creates nothing', async () => {
    const s = seam();
    const host = { ...s.host, cli: async () => null };
    await handleClaudeCodeMessage(host, { type: 'newClaudeCodeSession' });
    expect(s.postsOf('sessionKind')).toEqual([]);
    expect(String(s.postsOf('error')[0]!.message)).toContain('not found');
    expect(claudeCodeOwns({ type: 'send', sessionId: CELL })).toBe(false);
  });

  it('answers a detection probe with the version the CLI reported', async () => {
    const s = seam();
    await handleClaudeCodeMessage(s.host, { type: 'requestClaudeCodeStatus' });
    expect(s.postsOf('claudeCodeStatus')[0]).toEqual({
      type: 'claudeCodeStatus', installed: true, version: '2.1.198', binary: 'C:\\claude.exe', source: 'native-install',
      tooltip: 'Claude Code 2.1.198 — passthrough (C:\\claude.exe, via native install); click to open a Claude Code chat',
    });
  });

  // The work-PC round: a pill that cannot say what it looked for cannot be
  // debugged from another machine. The trail has to survive the hop from the
  // probe to the webview, not just exist inside discovery.ts.
  it('carries the PROBE TRAIL into the status post when nothing was found', async () => {
    const s = seam();
    const host = { ...s.host, cli: undefined, discovery: async () => ({
      probes: [
        { source: 'path' as const, path: 'claude', result: 'missing' as const, detail: 'where claude exit 1' },
        { source: 'vscode-extension' as const, path: 'C:\\ext\\claude.exe', result: 'version-failed' as const, detail: 'timed out after 5s' },
      ],
    }) };
    await handleClaudeCodeMessage(host, { type: 'requestClaudeCodeStatus' });
    const post = s.postsOf('claudeCodeStatus')[0]!;
    expect(post.installed).toBe(false);
    expect(String(post.tooltip)).toContain('Probed: PATH (missing), VS Code extension (version-failed)');
    expect(String(post.tooltip)).toContain('origamicoder.claudeCode.path');
  });
});

describe('a turn, end to end', () => {
  it('marks the composer busy, spawns, and renders the child\'s output', async () => {
    const s = seam();
    await create(s);
    await handleClaudeCodeMessage(s.host, { type: 'send', text: '  hello  ', sessionId: CELL });
    expect(s.postsOf('busy')).toHaveLength(1);
    expect(s.child().frames().at(-1)).toMatchObject({ type: 'user', message: { content: [{ type: 'text', text: 'hello' }] } });
    s.child().say(`${RUN1_TEXT_DELTA}\n${RUN1_RESULT}\n`);
    expect(s.postsOf('agentText')[0]).toMatchObject({ text: 'PONG', sessionId: CELL });
    expect(s.postsOf('turnDone')[0]).toMatchObject({ stopReason: 'end_turn' });
  });

  it('ignores an empty send instead of burning a turn on it', async () => {
    const s = seam();
    await create(s);
    await handleClaudeCodeMessage(s.host, { type: 'send', text: '   ', sessionId: CELL });
    expect(s.postsOf('busy')).toEqual([]);
  });

  it('interrupts and closes the turn on cancel', async () => {
    const s = seam();
    await create(s);
    await handleClaudeCodeMessage(s.host, { type: 'send', text: 'go', sessionId: CELL });
    await handleClaudeCodeMessage(s.host, { type: 'cancel', sessionId: CELL });
    expect(s.child().frames().at(-1)).toMatchObject({ request: { subtype: 'interrupt' } });
    expect(s.postsOf('turnDone')[0]).toMatchObject({ stopReason: 'cancelled' });
  });
});

describe('the permission round trip — the whole path, not just the driver', () => {
  it('asks through the existing permission BAR, and a Deny reaches the child', async () => {
    const s = seam();
    await create(s);
    await handleClaudeCodeMessage(s.host, { type: 'send', text: 'write a file', sessionId: CELL });
    s.child().say(`${canUseTool('req_1', 'Write', { file_path: 'a.txt' })}\n`);

    const ask = s.postsOf('requestPermission')[0]!;
    expect(ask).toMatchObject({ sessionId: CELL, toolCallId: 'req_1', title: 'Write: a.txt' });
    // The bar, not the question modal: permissionOptions.isQuestionShaped picks
    // by the presence of an allow_always. This asserts against the SHIPPED rule.
    expect(isQuestionShaped(ask.options as Array<{ kind: string }>)).toBe(false);

    // Exactly the message ChatPane posts when the user clicks Deny.
    await handleClaudeCodeMessage(s.host, { type: 'permission', toolCallId: 'req_1', optionId: 'reject_once', sessionId: CELL });
    expect(s.child().frames().at(-1)).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req_1', response: { behavior: 'deny', message: 'User declined tool execution.' } },
    });
    expect(s.postsOf('permissionAudit').at(-1)).toMatchObject({ action: 'denied', optionId: 'reject_once' });
  });

  it('treats a cancelled bar as a deny — a blocked child is never left waiting', async () => {
    const s = seam();
    await armed(s);
    s.child().say(`${canUseTool('req_2', 'Bash', {})}\n`);
    await handleClaudeCodeMessage(s.host, { type: 'permission', toolCallId: 'req_2', optionId: null, sessionId: CELL });
    expect(s.child().frames().at(-1)).toMatchObject({ response: { response: { behavior: 'deny' } } });
  });

  it('"always allow" answers the NEXT ask for that tool without asking again', async () => {
    const s = seam();
    await armed(s);
    s.child().say(`${canUseTool('req_3', 'Read', { file_path: 'a' })}\n`);
    await handleClaudeCodeMessage(s.host, { type: 'permission', toolCallId: 'req_3', optionId: 'allow_always', sessionId: CELL });
    expect(s.child().frames().at(-1)).toMatchObject({ response: { response: { behavior: 'allow' } } });

    s.child().say(`${canUseTool('req_4', 'Read', { file_path: 'b' })}\n`);
    expect(s.postsOf('requestPermission')).toHaveLength(1); // no second ask
    expect(s.child().frames().at(-1)).toMatchObject({ response: { request_id: 'req_4', response: { behavior: 'allow', updatedInput: { file_path: 'b' } } } });

    // …and it is per SESSION, not persisted anywhere.
    expect(JSON.stringify(s.store.value ?? {})).not.toContain('Read');
  });

  it('ignores an answer to an ask that was never made', async () => {
    const s = seam();
    await armed(s);
    const before = s.child().written.length;
    await handleClaudeCodeMessage(s.host, { type: 'permission', toolCallId: 'ghost', optionId: 'allow_once', sessionId: CELL });
    expect(s.child().written.length).toBe(before);
  });
});

describe('approve presets — and the bypass that is deliberately not honoured', () => {
  it('maps Origami\'s three presets, clamping bypass', () => {
    // PHASE 2: the rail gained `acceptEdits`, and 'auto' stopped being an alias
    // for it. Before, both presets produced the same CLI mode, and the middle
    // level — pre-approve edits, still ask about everything else — was
    // unreachable from the composer. approveButtonState.actionsRowOptions is
    // the webview mirror of this list; approveOptions.test.ts reads both.
    expect(modeFromApprove('default')).toEqual({ mode: 'supervised', clamped: false });
    expect(modeFromApprove('acceptEdits')).toEqual({ mode: 'acceptEdits', clamped: false });
    expect(modeFromApprove('auto')).toEqual({ mode: 'auto', clamped: false });
    expect(modeFromApprove('bypass')).toEqual({ mode: 'acceptEdits', clamped: true });
  });

  it('tells the user bypass is unavailable rather than silently pretending', async () => {
    const s = seam();
    await create(s);
    await handleClaudeCodeMessage(s.host, { type: 'setApproveMode', mode: 'bypass', sessionId: CELL });
    // Clamps to the notch it actually landed on, so the rail's dot matches the
    // mode the child was given rather than naming a level above it.
    expect(s.postsOf('approveUpdate').at(-1)).toMatchObject({ mode: 'acceptEdits' });
    expect(String(s.postsOf('system').at(-1)!.text)).toContain('Bypass is not available');
  });

  it('never builds a vector carrying a bypass flag, whatever the preset', async () => {
    const s = seam();
    await create(s);
    await handleClaudeCodeMessage(s.host, { type: 'setApproveMode', mode: 'bypass', sessionId: CELL });
    await handleClaudeCodeMessage(s.host, { type: 'send', text: 'go', sessionId: CELL });
    const spawnLog = s.logs.find((l) => l.includes('spawned'))!;
    expect(spawnLog).toContain('acceptEdits');
    expect(spawnLog).not.toContain('bypassPermissions');
    expect(spawnLog).not.toContain('dangerously');
  });
});

// THE CROSS-CHAT CONTAMINATION REGRESSION. Phase 1 stored `{ <cwd>: <session> }`
// — ONE entry per workspace folder — so every passthrough chat in that folder
// spawned `--resume` on the same Claude conversation. The user's evidence: a
// brand-new chat opened with "resuming your last session in <cwd>", the
// connected line's tool count moved 49 → 80 between turns, and the model
// answered "already covered this above" about a message sent in a DIFFERENT
// chat. The key is the CELL now; cwd is only a validity guard.
describe('resume', () => {
  const spawnOf = (s: Seam) => s.logs.filter((l) => l.includes('spawned'));

  it('remembers the CLI\'s session id against the CELL, with cwd as a guard', async () => {
    const s = seam();
    await armed(s);
    s.child().say(`${RUN1_SYSTEM_INIT}\n`);
    expect(s.store.value![CELL]).toMatchObject({ cwd: CWD, session: SESSION });
    // Nothing is filed under the folder any more — that key WAS the bug.
    expect(s.store.value![CWD]).toBeUndefined();
    expect(CLAUDE_CODE_RESUME_KEY).toBe('origami.claudeCode.resume');
  });

  // THE MUTATION PROOF for this fix. Restore the cwd key and this goes red:
  // the second cell inherits the first cell's conversation.
  it('never lets a SECOND chat in the same folder join the first chat\'s session', async () => {
    const s = seam();
    await armed(s);                                   // cell 1 …
    s.child().say(`${RUN1_SYSTEM_INIT}\n`);           // … adopts SESSION
    const second = await create(s);                   // a brand-new chat, same cwd
    await handleClaudeCodeMessage(s.host, { type: 'send', text: 'hello', sessionId: second });
    expect(second).not.toBe(CELL);
    expect(spawnOf(s).at(-1)!).not.toContain('--resume');
    // …and it says so in the transcript, which is the line the user saw lie.
    // The clause now rides the CONNECTED line (sessionFacts.connectedLine), so
    // the second cell has to reach its own `system/init` before it can say it.
    s.child().say(`${RUN1_SYSTEM_INIT.replace(/"session_id":"[^"]*"/, '"session_id":"other-session"')}\n`);
    const systems = s.posts.filter((p) => p.type === 'system' && p.sessionId === second).map((p) => String(p.text));
    expect(systems.some((t) => t.includes(`new session in ${CWD}`))).toBe(true);
    expect(systems.some((t) => t.includes('resuming your last session'))).toBe(false);
  });

  it('does not resume an entry belonging to a DIFFERENT folder', async () => {
    const s = seam({ [CELL]: { cwd: 'C:\\somewhere-else', session: SESSION, run: RESUME_RUN } });
    await create(s);
    await handleClaudeCodeMessage(s.host, { type: 'send', text: 'fresh', sessionId: CELL });
    expect(spawnOf(s).at(-1)!).not.toContain('--resume');
  });

  // `session-<n>` is minted from a counter that restarts at 0 in every extension
  // host, so an entry the LAST window wrote for its own `session-1` must not be
  // handed to this window's first chat. The run stamp is what stops it.
  it('does not resume an entry written by an earlier window run', async () => {
    const s = seam({ [CELL]: { cwd: CWD, session: SESSION, run: 'a-previous-run' } });
    await create(s);
    await handleClaudeCodeMessage(s.host, { type: 'send', text: 'fresh', sessionId: CELL });
    expect(spawnOf(s).at(-1)!).not.toContain('--resume');
  });

  it('discards a phase-1 cwd-keyed entry instead of reading it as a session id', async () => {
    // The literal shape workspaceState still holds on an upgraded install.
    const s = seam({ [CWD]: SESSION } as unknown as ResumeStore);
    await create(s);
    await handleClaudeCodeMessage(s.host, { type: 'send', text: 'fresh', sessionId: CELL });
    expect(spawnOf(s).at(-1)!).not.toContain('--resume');
    // And the first write retires it — no migration step, no growing store.
    s.child().say(`${RUN1_SYSTEM_INIT}\n`);
    expect(Object.keys(s.store.value!)).toEqual([CELL]);
  });

  it('still resumes THIS cell after a park — an idle child or a settings change', async () => {
    const s = seam();
    await armed(s);
    s.child().say(`${RUN1_SYSTEM_INIT}\n`);
    // A model re-point parks the child; the next prompt respawns it resumed.
    await handleClaudeCodeMessage(s.host, { type: 'setModel', modelId: 'claude-code/haiku', sessionId: CELL });
    await handleClaudeCodeMessage(s.host, { type: 'send', text: 'carry on', sessionId: CELL });
    expect(spawnOf(s).at(-1)!).toContain(`"--resume","${SESSION}"`);
  });
});

describe('unsupported controls are swallowed, never forwarded', () => {
  for (const type of ['compactContext', 'revertToMessage', 'setSubagentModel', 'secondOpinion']) {
    it(`${type} on a passthrough chat does nothing but log`, async () => {
      const s = seam();
      await create(s);
      const before = s.posts.length;
      // Claimed AND swallowed. A bound cell now has a real engine session under
      // it, so a leaked gate would otherwise act on a chat the user cannot see.
      expect(claudeCodeOwns({ type, sessionId: CELL })).toBe(true);
      await handleClaudeCodeMessage(s.host, { type, sessionId: CELL });
      expect(s.posts.length).toBe(before);
      expect(s.redispatched).toEqual([]);
      expect(s.logs.at(-1)).toContain(`ignoring '${type}'`);
    });
  }

  // The other half of the same rule, and the one an exclusion list would have
  // got wrong: a bound cell is an ORDINARY chat for everything this feature has
  // no opinion about. Swallowing these would break the cell's own editor tab.
  for (const type of ['popOutSession', 'exportSession', 'requestSessions']) {
    it(`${type} on a bound cell is left to the panel that owns it`, async () => {
      const s = seam();
      await create(s);
      expect(claudeCodeOwns({ type, sessionId: CELL })).toBe(false);
    });
  }
});

// Round 2's entry point: the model picker. A `claude-code/*` pick binds the cell
// it came from; anything else parks the binding and lets the SAME message carry
// on to the engine, which is what keeps one setModel path instead of two.
describe('picking a model flips the cell, both ways', () => {
  const pick = (s: Seam, modelId: string, sessionId = CELL) =>
    handleClaudeCodeMessage(s.host, { type: 'setModel', modelId, sessionId });

  it('routes a claude-code pick here BEFORE the engine, whatever cell it names', () => {
    expect(claudeCodeOwns({ type: 'setModel', modelId: 'claude-code/opus', sessionId: 'session-9' })).toBe(true);
    // …and leaves an ordinary pick on an unbound cell entirely alone.
    expect(claudeCodeOwns({ type: 'setModel', modelId: 'lmstudio/qwen3-30b', sessionId: 'session-9' })).toBe(false);
  });

  it('binds the cell, gates it, and never hands the pick to the engine', async () => {
    const s = seam();
    await pick(s, 'claude-code/opus');
    expect(claudeCodeKind(CELL)).toBe(PASSTHROUGH_KIND);
    expect(claudeCodeModelOf(CELL)).toBe('claude-code/opus');
    expect(s.postsOf('sessionKind').at(-1)).toMatchObject({ sessionId: CELL, kind: PASSTHROUGH_KIND });
    expect(s.postsOf('system')[0]).toMatchObject({ text: 'Claude Code passthrough — claude-code/opus' });
    expect(s.redispatched).toEqual([]);
  });

  it('spawns the child on the ALIAS the CLI understands, not the picker value', async () => {
    const s = seam();
    await pick(s, 'claude-code/opus');
    await handleClaudeCodeMessage(s.host, { type: 'send', text: 'go', sessionId: CELL });
    const spawnLog = s.logs.find((l) => l.includes('spawned'))!;
    expect(spawnLog).toContain('"--model","opus"');
    expect(spawnLog).not.toContain('claude-code/');
  });

  it('re-points a bound cell without a second binding', async () => {
    const s = seam();
    await pick(s, 'claude-code/opus');
    await pick(s, 'claude-code/haiku');
    expect(claudeCodeModelOf(CELL)).toBe('claude-code/haiku');
    expect(s.postsOf('system').at(-1)).toMatchObject({ text: 'Claude Code passthrough — claude-code/haiku' });
    // A re-point is a setting change on the cell the pick came from: no second
    // cell behind it, and no engine round trip.
    expect(s.created).toEqual([]);
    expect(s.redispatched).toEqual([]);
  });

  it('an engine model PARKS the binding and lets the same pick continue', async () => {
    const s = seam();
    await pick(s, 'claude-code/opus');
    await handleClaudeCodeMessage(s.host, { type: 'send', text: 'go', sessionId: CELL });
    s.child().say(`${RUN1_SYSTEM_INIT}\n`);        // the CLI's own session id lands in the resume map
    await pick(s, 'lmstudio/qwen3-30b');

    expect(claudeCodeKind(CELL)).toBeUndefined();  // the gates come off
    expect(s.postsOf('sessionKind').at(-1)).toMatchObject({ sessionId: CELL, kind: '' });
    expect(String(s.postsOf('system').at(-1)!.text)).toContain('parked, not closed');
    // PARKED, not discarded: the child is dead, the conversation is not.
    expect(s.child().killed).toBe(1);
    // Under THIS cell's id, so only this cell can pick the conversation up again.
    expect(s.store.value).toEqual({ [CELL]: { cwd: CWD, session: SESSION, run: RESUME_RUN } });
    // The cell is handed back whole — the engine never lost its session, and the
    // pick reaches it unchanged rather than being swallowed here.
    // Two entries, and the first one is the AUTO-TITLE: naming the chat after
    // its first line goes through the panel's own `renameSession` now, because
    // a bare `sessionTitle` post never reached the sidebar row or the engine
    // (claudeCodeManager.titleFromFirstLine). 'go' is that first line.
    expect(s.redispatched).toEqual([
      { type: 'renameSession', sessionId: CELL, title: 'Go' },
      { type: 'setModel', modelId: 'lmstudio/qwen3-30b', sessionId: CELL },
    ]);
    expect(claudeCodeOwns({ type: 'send', sessionId: CELL })).toBe(false);
  });

  it('re-binding the parked cell resumes the SAME Claude conversation', async () => {
    const s = seam();
    await pick(s, 'claude-code/opus');
    await handleClaudeCodeMessage(s.host, { type: 'send', text: 'go', sessionId: CELL });
    s.child().say(`${RUN1_SYSTEM_INIT}\n`);
    await pick(s, 'lmstudio/qwen3-30b');
    await pick(s, 'claude-code/opus');
    await handleClaudeCodeMessage(s.host, { type: 'send', text: 'carry on', sessionId: CELL });
    expect(s.logs.filter((l) => l.includes('spawned')).at(-1)!).toContain(`"--resume","${SESSION}"`);
  });
});

describe('closing', () => {
  it('kills the child, then lets the CELL close itself the ordinary way', async () => {
    const s = seam();
    await create(s);
    await handleClaudeCodeMessage(s.host, { type: 'send', text: 'go', sessionId: CELL });
    await handleClaudeCodeMessage(s.host, { type: 'closeSession', sessionId: CELL });
    expect(s.child().killed).toBe(1);
    // The binding is gone AND the close continues to the panel — swallowing it
    // here would kill the child and leave the engine session and its tab behind.
    expect(claudeCodeOwns({ type: 'send', sessionId: CELL })).toBe(false);
    // The auto-title rides the same channel — see the note on the model-park
    // test above. The close is still the LAST thing handed back.
    expect(s.redispatched).toEqual([
      { type: 'renameSession', sessionId: CELL, title: 'Go' },
      { type: 'closeSession', sessionId: CELL },
    ]);
  });
});

// 0.4.69 UAT round. The composer's two passthrough-only readouts are POSTS, so
// the seam owns their lifecycle: they must arrive when the CLI says something,
// and be RETRACTED when the cell goes back to the engine. A badge that outlives
// its binding is the same lie in the other direction - an engine turn spends
// real money, and its commands are not Claude's.
describe('the passthrough-only readouts are retracted, not left to decay', () => {
  it('carries the funding and the / rows once the CLI has spoken', async () => {
    const s = seam();
    await armed(s);
    s.child().say(`${RUN1_SYSTEM_INIT}\n`);
    expect(s.postsOf('passthroughMeter').at(-1)).toMatchObject({ sessionId: CELL, subscription: true });
    expect(s.postsOf('passthroughCommands').at(-1)!.commands).toHaveLength(3); // the fixture's trimmed list
  });

  it('withdraws BOTH when an engine model takes the cell back', async () => {
    const s = seam();
    await armed(s);
    s.child().say(`${RUN1_SYSTEM_INIT}\n`);
    await handleClaudeCodeMessage(s.host, { type: 'setModel', modelId: 'lmstudio/qwen3-30b', sessionId: CELL });
    expect(s.postsOf('passthroughMeter').at(-1)).toMatchObject({ sessionId: CELL, subscription: false, pillPct: -1 });
    expect(s.postsOf('passthroughCommands').at(-1)!.commands).toEqual([]);
  });

  it('sends no / rows at all when the slashSkills setting is off', async () => {
    const s = seam();
    const host = { ...s.host, slashSkills: () => false };
    await handleClaudeCodeMessage(host, { type: 'newClaudeCodeSession' });
    await handleClaudeCodeMessage(host, { type: 'send', text: 'go', sessionId: CELL });
    s.child().say(`${RUN1_SYSTEM_INIT}\n`);
    expect(s.postsOf('passthroughCommands')).toEqual([]);
    // The meter is NOT gated by that setting — funding truth is not optional.
    expect(s.postsOf('passthroughMeter').length).toBeGreaterThan(0);
  });

  it('treats a host that never heard of the setting as ON, which is its default', async () => {
    const s = seam();          // the default fake host declares no slashSkills
    await armed(s);
    s.child().say(`${RUN1_SYSTEM_INIT}\n`);
    expect(s.postsOf('passthroughCommands').length).toBeGreaterThan(0);
  });
});
