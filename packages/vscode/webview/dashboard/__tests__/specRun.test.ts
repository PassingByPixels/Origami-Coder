// Folds board — the SPEC flow (contract §11 item 3). The claims that matter here
// are the ones a passing wrapper test would miss: the agent is told the ticket's
// ABSOLUTE path (its cwd is the repo root, so a relative one is a guess), the
// chat is in front of the user BEFORE the prompt goes out, and the ticket only
// moves to Todo when the FILE really gained acceptance criteria — never on the
// session merely ending. The "speccing…" mark is process state, so every exit
// (completion, refusal, a session that never came up) has to clear it.
//
// The host is faked exactly like the other agentManager suites; the manager-level
// test drives the REAL AgentManager so the amTicketSpec dispatch and the TicketRow
// projection are proved, not assumed.

import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentManager, type ManagerHost } from '../../../src/dashboard/agentManager/manager';
import type { RunContext } from '../../../src/dashboard/agentManager/run';
import { isSpecActive, resetSpecRuns, runSpec, specBrief } from '../../../src/dashboard/agentManager/specRun';
import {
  boardTickets, parseTicket, readTicket, resetTicketWatch, scalar, ticketPath,
} from '../../../src/dashboard/agentManager/tickets';

const made: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
});
beforeEach(() => { resetTicketWatch(); resetSpecRuns(); });

/** A raw Triage ticket — no acceptance section yet, which is the whole point. */
const RAW = [
  '---',
  'id: t-8k2fq1',
  'title: Scroll block needs a max-width',
  'status: triage',
  'priority: normal',
  'labels: [ui]',
  "assignee: ''",
  'created: 2026-08-06T10:00:00Z',
  'updated: 2026-08-06T10:00:00Z',
  "fold: ''",
  "branch: ''",
  'owner: passing',
  '---',
  '',
  'The scroll block runs edge to edge on a wide window.',
  '',
  '## Log',
  '',
  '- 2026-08-06T10:05:00Z passing: created via quick-add',
  '',
].join('\n');

/** A repo the board will accept (actionRoot only asks whether .git exists) with
 *  one seeded ticket. No git subprocess: the spec flow provisions no worktree. */
function seedRepo(prefix: string, text = RAW): { repo: string; id: string } {
  const repo = tempDir(prefix);
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const file = ticketPath(repo, 't-8k2fq1');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { repo, id: 't-8k2fq1' };
}

interface FakeHost extends ManagerHost {
  posts: Array<Record<string, unknown>>;
  calls: string[];
  prompts: string[];
  pinned: string[];
}

function makeHost(repo: string, over: Partial<ManagerHost> = {}): FakeHost {
  const host: FakeHost = {
    posts: [], calls: [], prompts: [], pinned: [],
    repoRoot: () => repo,
    knownRepos: () => [],
    saveKnownRepos: () => undefined,
    pickRepoFolder: async () => undefined,
    repoDisplayNames: () => ({}),
    saveRepoDisplayNames: () => undefined,
    autoApprove: () => true,
    setAutoApprove: () => undefined,
    createAgentSession: async (cwd) => { host.calls.push(`create:${cwd}`); return 'session-1'; },
    promptSession: async (_id, text) => { host.calls.push('prompt'); host.prompts.push(text); return 'end_turn'; },
    cancelSession: async () => undefined,
    closeSession: () => undefined,
    sessionAlive: () => true,
    openChat: () => { host.calls.push('openChat'); },
    post: (msg) => { host.posts.push(msg as Record<string, unknown>); },
    openTerminal: () => undefined,
    setSessionModel: async (_id, model) => { host.calls.push('pin'); host.pinned.push(model); },
    agentModes: () => null,
    setSessionAgentMode: async () => undefined,
    agentTypes: () => [],
    saveAgentTypes: () => undefined,
    archetypeMarker: () => ({ get: () => true, set: () => undefined }),
    harvestAnySessionModes: () => null,
    openCrossDiff: () => undefined,
    engineSessionId: () => undefined,
    reopenAgentSession: async () => 'session-2',
    openFileDiff: () => undefined,
    info: () => undefined,
    openConflicted: () => undefined,
    openFile: () => undefined,
    ...over,
  };
  return host;
}

/** The narrow window runSpec drives — the same one run.ts takes. */
function makeCtx(host: ManagerHost, broadcasts: { n: number }): RunContext {
  return {
    host,
    runtime: new Map(),
    busy: new Set(),
    cancelRequested: new Set(),
    reopening: new Set(),
    patch: () => undefined,
    broadcast: () => { broadcasts.n++; },
    record: () => undefined,
  };
}

const errors = (host: FakeHost) => host.posts.filter((p) => p.type === 'amError').map((p) => String(p.message));

describe('spec flow — refusals', () => {
  it('refuses a missing or malformed ticket, creates no session and rewrites nothing', async () => {
    const { repo } = seedRepo('origami-spec-bad-');
    const junk = 'this file has no frontmatter at all\n';
    fs.writeFileSync(ticketPath(repo, 't-broken'), junk);
    const host = makeHost(repo);
    const b = { n: 0 };

    await runSpec(makeCtx(host, b), repo, 't-nope', '', '');
    await runSpec(makeCtx(host, b), repo, 't-broken', '', '');

    expect(host.calls).toEqual([]); // no engine child for either
    expect(errors(host)).toHaveLength(2);
    expect(errors(host)[1]).toContain('does not parse');
    expect(fs.readFileSync(ticketPath(repo, 't-broken'), 'utf8')).toBe(junk); // no log line stamped onto it
    expect(isSpecActive(repo, 't-broken')).toBe(false);
    expect(b.n).toBe(0); // nothing transitioned, so nothing to broadcast
  });

  it('refuses a SECOND spec session on a ticket that already has one open', async () => {
    const { repo, id } = seedRepo('origami-spec-dup-');
    let release: (v: string) => void = () => undefined;
    const host = makeHost(repo, { promptSession: () => new Promise<string>((r) => { release = r; }) });
    const b = { n: 0 };

    const first = runSpec(makeCtx(host, b), repo, id, '', '');
    await new Promise((r) => setImmediate(r));
    expect(isSpecActive(repo, id)).toBe(true);

    await runSpec(makeCtx(host, b), repo, id, '', '');
    expect(errors(host)[0]).toContain('already has a spec session open');
    expect(host.calls.filter((c) => c.startsWith('create:'))).toHaveLength(1); // one engine child, not two

    release('end_turn');
    await first;
    expect(isSpecActive(repo, id)).toBe(false);
  });
});

describe('spec flow — the brief and the session', () => {
  it('runs at the REPO ROOT, opens the chat BEFORE prompting, and pins the model it was given', async () => {
    const { repo, id } = seedRepo('origami-spec-brief-');
    const host = makeHost(repo);
    await runSpec(makeCtx(host, { n: 0 }), repo, id, 'architect', 'qwen3-coder');

    // Order is the claim: a background run may prompt into a hidden session; a
    // spec conversation must be in front of the user when the first question lands.
    expect(host.calls).toEqual([`create:${repo}`, 'pin', 'openChat', 'prompt']);
    expect(host.pinned).toEqual(['qwen3-coder']);
    expect(fs.existsSync(path.join(repo, '.origami', 'worktrees'))).toBe(false); // no fold provisioned
  });

  it('the brief carries the ticket verbatim, its ABSOLUTE path and the acceptance instruction', async () => {
    const { repo, id } = seedRepo('origami-spec-text-');
    const host = makeHost(repo);
    await runSpec(makeCtx(host, { n: 0 }), repo, id, '', '');

    const brief = host.prompts[0];
    const abs = path.resolve(ticketPath(repo, id));
    expect(path.isAbsolute(abs)).toBe(true);
    expect(brief).toContain(abs);
    expect(brief).toContain('Scroll block needs a max-width');
    expect(brief).toContain('owner: passing'); // the FULL file, unknown frontmatter keys included
    expect(brief).toContain('The scroll block runs edge to edge on a wide window.');
    expect(brief).toContain('`- [ ]` lines under a `## Acceptance` heading');
    expect(brief).toContain('edit ONLY that file');
    expect(brief.toLowerCase()).toContain('talk to the user');
    // Exactly what the exported leaf builds from the file AS IT WAS at prompt
    // time (the settle has since appended a log line) — no second wording to drift.
    expect(specBrief(parseTicket(RAW, ticketPath(repo, id)), abs)).toBe(brief);
  });

  it('pins nothing when neither the picker nor the repo named a model', async () => {
    const { repo, id } = seedRepo('origami-spec-nopin-');
    const host = makeHost(repo);
    await runSpec(makeCtx(host, { n: 0 }), repo, id, '', '');
    expect(host.calls).toEqual([`create:${repo}`, 'openChat', 'prompt']);
    expect(host.pinned).toEqual([]);
  });
});

describe('spec flow — what the FILE says at the end', () => {
  it('acceptance criteria written -> status todo + "spec complete"', async () => {
    const { repo, id } = seedRepo('origami-spec-done-');
    // The agent's real work: it edits the ticket file during its turn.
    const host = makeHost(repo, {
      promptSession: async () => {
        const file = ticketPath(repo, id);
        fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\n## Acceptance\n\n- [ ] block never exceeds 720px\n- [ ] centred at every width\n`);
        return 'end_turn';
      },
    });
    const b = { n: 0 };
    await runSpec(makeCtx(host, b), repo, id, '', '');

    const row = boardTickets(repo)[0];
    expect(row.status).toBe('todo');
    expect(row.acceptance).toEqual({ done: 0, total: 2 });
    expect(row.spec).toBeUndefined(); // the mark is gone the moment the turn ends
    const after = fs.readFileSync(ticketPath(repo, id), 'utf8');
    expect(after).toContain('folds: spec complete');
    expect(after).toContain('owner: passing'); // the stamp kept the unknown key
    expect(errors(host)).toEqual([]);
    expect(b.n).toBe(2); // marked, then settled
  });

  it('no acceptance criteria -> stays in Triage and SAYS the session ended without them', async () => {
    const { repo, id } = seedRepo('origami-spec-empty-');
    const host = makeHost(repo); // the fake never writes acceptance
    await runSpec(makeCtx(host, { n: 0 }), repo, id, '', '');

    const t = readTicket(repo, id)!;
    expect(scalar(t.fm, 'status')).toBe('triage');
    expect(t.body).toContain('folds: spec session ended without acceptance');
    expect(isSpecActive(repo, id)).toBe(false);
  });

  it('a session that never comes up clears the mark and reports it', async () => {
    const { repo, id } = seedRepo('origami-spec-dead-');
    const host = makeHost(repo, { createAgentSession: async () => { throw new Error('engine did not start'); } });
    const b = { n: 0 };
    await runSpec(makeCtx(host, b), repo, id, '', '');

    expect(isSpecActive(repo, id)).toBe(false);
    expect(errors(host)[0]).toContain('engine did not start');
    expect(scalar(readTicket(repo, id)!.fm, 'status')).toBe('triage'); // nothing stamped
    expect(b.n).toBe(2); // marked, then cleared — the chip cannot outlive the session
  });

  it('a model pin failure is fatal — no prompt goes out and the mark clears', async () => {
    const { repo, id } = seedRepo('origami-spec-pin-');
    const host = makeHost(repo, { setSessionModel: async () => { throw new Error('no such model'); } });
    await runSpec(makeCtx(host, { n: 0 }), repo, id, '', 'ghost-model');

    expect(host.prompts).toEqual([]);
    expect(errors(host)[0]).toContain('model pin failed');
    expect(isSpecActive(repo, id)).toBe(false);
  });
});

describe('amTicketSpec through the real manager', () => {
  it('routes the message, paints TicketRow.spec while the chat runs, and clears it after', async () => {
    const { repo, id } = seedRepo('origami-spec-mgr-');
    let release: (v: string) => void = () => undefined;
    const host = makeHost(repo, {
      promptSession: () => new Promise<string>((r) => {
        release = (v) => {
          const file = ticketPath(repo, id);
          fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\n## Acceptance\n\n- [ ] block never exceeds 720px\n`);
          r(v);
        };
      }),
    });
    const mgr = new AgentManager(host);
    const lastTickets = () => {
      const s = [...host.posts].reverse().find((p) => p.type === 'amState') as
        { repos: Array<{ root: string; tickets: Array<Record<string, unknown>> }> } | undefined;
      return s?.repos.find((r) => r.root === repo)?.tickets ?? [];
    };
    try {
      const done = mgr.handle({ type: 'amTicketSpec', root: repo, id, agentName: '', model: '' });
      await new Promise((r) => setImmediate(r));

      expect(host.calls).toEqual([`create:${repo}`, 'openChat']); // prompt still in flight
      expect(lastTickets()[0]).toMatchObject({ id, status: 'triage', spec: true });

      release('end_turn');
      await done;

      const row = lastTickets()[0];
      expect(row).toMatchObject({ id, status: 'todo' });
      expect(row.spec).toBeUndefined();
      expect(host.posts.some((p) => p.type === 'amError')).toBe(false);
    } finally {
      mgr.dispose();
    }
  });

  it('a spec on a repo the board does not know is an amError, not a session', async () => {
    const { repo, id } = seedRepo('origami-spec-scope-');
    const host = makeHost(repo);
    const mgr = new AgentManager(host);
    try {
      await mgr.handle({ type: 'amTicketSpec', root: path.join(repo, 'nope'), id, agentName: '', model: '' });
      expect(errors(host)[0]).toContain('Repository not available');
      expect(host.calls).toEqual([]);
    } finally {
      mgr.dispose();
    }
  });
});

describe('the spec log write is a targeted edit, not a rebuild', () => {
  it('leaves the file parseable with its unknown keys and its LF endings intact', async () => {
    const { repo, id } = seedRepo('origami-spec-rt-');
    const host = makeHost(repo);
    await runSpec(makeCtx(host, { n: 0 }), repo, id, '', '');
    const text = fs.readFileSync(ticketPath(repo, id), 'utf8');
    const t = parseTicket(text, ticketPath(repo, id));
    expect(t.malformed).toBe(false);
    expect(scalar(t.fm, 'owner')).toBe('passing');
    expect(t.body).toContain('The scroll block runs edge to edge on a wide window.');
    expect(text).not.toContain('\r');
  });
});
