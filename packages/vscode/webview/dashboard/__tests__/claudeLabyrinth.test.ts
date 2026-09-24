// claudeLabyrinth.test.ts — a Claude Code transcript drawn as a Labyrinth run
// (t-47bk8j): the steps it yields, the sub-agent runs hanging off it, and the
// bound that stops a 257 MB file being read whole.
//
// EVERY FIXTURE IS A REAL FILE IN A REAL TEMP DIRECTORY, for claudeHistory.
// test.ts's reason: the thing under test is a streaming read of a foreign file
// format, and a mocked fs would only assert that this module calls the
// functions this module calls. The real `~/.claude` is never touched — `root`
// is injected in every call and never allowed to default to the home directory.
//
// The directory name is built by a SECOND implementation of the CLI's sanitise
// rule, not by `projectKey`: normalising both sides with the function under
// test would pass however wrong that function was.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeRunId, claudeStepsPayload, parseClaudeRunId } from '../../../src/dashboard/claudeLabyrinth';

/** The CLI's own rule, from the evidence in claudeHistory.ts's header. */
const sanitisedByTheCli = (cwd: string): string => cwd.replace(/[\\/: ]/g, '-');

const FOLDER = 'C:\\ws\\lab';
const SESSION = 'sess-0001';
let root = '';

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-cc-lab-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

function projectDir(folder = FOLDER): string {
  const dir = path.join(root, sanitisedByTheCli(folder));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function write(file: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

const at = (n: number): string => new Date(Date.UTC(2026, 8, 9, 12, 0, n)).toISOString();

const user = (content: unknown, second: number, sidechain = false) =>
  ({ type: 'user', sessionId: SESSION, isSidechain: sidechain, timestamp: at(second), message: { role: 'user', content } });

const assistant = (id: string, content: unknown[], second: number, usage?: Record<string, unknown>, model = 'claude-opus-5') =>
  ({ type: 'assistant', sessionId: SESSION, isSidechain: false, timestamp: at(second),
     message: { role: 'assistant', id, model, content, ...(usage ? { usage } : {}) } });

const USAGE = {
  input_tokens: 12, output_tokens: 340,
  cache_read_input_tokens: 32035, cache_creation_input_tokens: 24656,
  output_tokens_details: { thinking_tokens: 0 },
};

const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const toolResult = (id: string, content: string, isError = false) =>
  ({ type: 'tool_result', tool_use_id: id, content, is_error: isError });

// --- one conversation's steps ---------------------------------------------

describe('a transcript with three tool calls', () => {
  //  msg_1 makes two calls in one message (the CLI writes one RECORD per block);
  //  msg_2 makes a third whose result never arrived.
  function seed(): string {
    const dir = projectDir();
    write(path.join(dir, `${SESSION}.jsonl`), [
      user('Fix the banding in the terrain shader', 0),
      assistant('msg_1', [{ type: 'text', text: 'I will read the shader first.\nThen patch it.' }], 1, USAGE),
      assistant('msg_1', [toolUse('t1', 'Read', { file_path: 'C:\\ws\\lab\\terrain.gdshader' })], 1, USAGE),
      assistant('msg_1', [toolUse('t2', 'Bash', { command: 'git status --porcelain', description: 'Show working tree status' })], 1, USAGE),
      user([toolResult('t1', 'shader source here')], 4),
      user([toolResult('t2', 'fatal: not a git repository', true)], 6),
      assistant('msg_2', [toolUse('t3', 'Write', { file_path: 'C:\\ws\\lab\\out.txt' })], 8,
        { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 }),
    ]);
    return dir;
  }

  it('makes one step per tool call, titled with the tool and its input', async () => {
    seed();
    const { steps } = await claudeStepsPayload(claudeRunId(SESSION), FOLDER, { root });
    const tools = steps.filter((s) => s.kind === 'tool');

    expect(tools.map((s) => s.title)).toEqual([
      'Read — C:\\ws\\lab\\terrain.gdshader',
      'Bash — git status --porcelain',
      'Write — C:\\ws\\lab\\out.txt',
    ]);
  });

  it('times each call from its own record to the record that answered it', async () => {
    seed();
    const { steps } = await claudeStepsPayload(claudeRunId(SESSION), FOLDER, { root });
    const read = steps.find((s) => s.tool === 'Read')!;

    expect(read.startedAt).toBe(Date.parse(at(1)));
    expect(read.endedAt).toBe(Date.parse(at(4)));
    expect(read.durationMs).toBe(3000);
    expect(read.status).toBe('completed');
  });

  it('carries the failure off is_error, and says `no result` for a call nothing answered', async () => {
    seed();
    const { steps } = await claudeStepsPayload(claudeRunId(SESSION), FOLDER, { root });
    const bash = steps.find((s) => s.tool === 'Bash')!;
    const write3 = steps.find((s) => s.tool === 'Write')!;

    expect(bash.status).toBe('error');
    expect(bash.error).toBe('fatal: not a git repository');
    // An open call has no end and no duration — it never finished.
    expect(write3.status).toBe('running');
    expect(write3.error).toBe('no result');
    expect(write3.endedAt).toBeUndefined();
    expect(write3.durationMs).toBeUndefined();
  });

  it('attaches one message\u2019s usage ONCE, to the LAST step that message produced', async () => {
    seed();
    const { steps } = await claudeStepsPayload(claudeRunId(SESSION), FOLDER, { root });
    // msg_1 produced a reply and two tool steps; only the Bash call carries the
    // tokens. Summing every step must give msg_1's usage exactly once.
    const withTokens = steps.filter((s) => s.tokens);
    expect(withTokens.map((s) => s.title)).toEqual(['Bash — git status --porcelain', 'Write — C:\\ws\\lab\\out.txt']);
    expect(steps.reduce((n, s) => n + (s.tokens?.output ?? 0), 0)).toBe(USAGE.output_tokens + 9);
    expect(withTokens[0]!.tokens).toEqual({ input: 12, output: 340, cache: { read: 32035, write: 24656 } });
    // thinking_tokens is 0 on this message, so no reasoning field is invented.
    expect(withTokens[0]!.tokens!.reasoning).toBeUndefined();
  });

  it('puts the model on every step of its message, and no cost on any of them', async () => {
    seed();
    const { steps } = await claudeStepsPayload(claudeRunId(SESSION), FOLDER, { root });

    expect(steps.filter((s) => s.kind !== 'prompt').every((s) => s.model === 'claude-opus-5')).toBe(true);
    // The transcript records tokens, never money — the price table does the rest.
    expect(steps.some((s) => s.cost !== undefined)).toBe(false);
  });

  it('draws a text-only assistant message as a tool-less `reply`, the way the engine does', async () => {
    seed();
    const { steps } = await claudeStepsPayload(claudeRunId(SESSION), FOLDER, { root });
    const reply = steps.find((s) => s.kind === 'reply')!;

    expect(reply.tool).toBeUndefined();
    expect(reply.title).toBe('I will read the shader first.'); // first line, not the whole text
    expect(reply.preview).toContain('Then patch it.');
    expect(steps[0]).toMatchObject({ ordinal: 0, kind: 'prompt', title: 'Fix the banding in the terrain shader' });
  });

  it('reports the whole run: every step, in one ordinal sequence, untruncated', async () => {
    seed();
    const payload = await claudeStepsPayload(claudeRunId(SESSION), FOLDER, { root });

    expect(payload.truncated).toBe(false);
    expect(payload.total).toBe(payload.steps.length);
    expect(payload.members).toEqual([]);
    expect(payload.steps.map((s) => s.ordinal)).toEqual(payload.steps.map((_, i) => i));
  });

  it('says so rather than throwing when the folder, the id or the file is wrong', async () => {
    seed();
    await expect(claudeStepsPayload(claudeRunId(SESSION), '', { root })).resolves.toMatchObject({ steps: [], error: expect.stringContaining('folder') });
    await expect(claudeStepsPayload(claudeRunId('gone'), FOLDER, { root })).resolves.toMatchObject({ steps: [], error: expect.stringContaining('not on this machine') });
    await expect(claudeStepsPayload(claudeRunId(SESSION), 'C:\\ws\\other', { root })).resolves.toMatchObject({ steps: [], error: expect.stringContaining('not on this machine') });
  });

  it('refuses an id whose halves could climb out of the session folder', () => {
    expect(parseClaudeRunId('claude:..')).toBeNull();
    expect(parseClaudeRunId('claude:sess#../../etc/passwd')).toBeNull();
    expect(parseClaudeRunId('claude:sess#a#b')).toBeNull();
    expect(parseClaudeRunId('engine-session-id')).toBeNull();
    expect(parseClaudeRunId('claude:sess#agent-a1')).toEqual({ session: 'sess', child: 'agent-a1' });
  });
});

// --- sub-agents -----------------------------------------------------------

describe('a spawn and the sub-agent transcript it made', () => {
  const STEM = 'agent-a2569b709208722fe';
  const SPAWN_ID = 'toolu_01MsddSWNW8Lx9h3EFPhAbpW';

  function seed(meta: Record<string, unknown> = { agentType: 'general-purpose', name: 'dflash2-recon', toolUseId: SPAWN_ID }): void {
    const dir = projectDir();
    write(path.join(dir, `${SESSION}.jsonl`), [
      user('Investigate the DFlash2 claim', 0),
      assistant('msg_1', [toolUse(SPAWN_ID, 'Agent', { description: 'Investigate DFlash2 Spark claim', run_in_background: true })], 1, USAGE),
      user([toolResult(SPAWN_ID, 'The claim does not hold.')], 30),
      assistant('msg_2', [{ type: 'text', text: 'Reporting back.' }], 31, USAGE),
    ]);
    const sub = path.join(dir, SESSION, 'subagents');
    write(path.join(sub, `${STEM}.jsonl`), [
      user('Investigate DFlash2 Spark claim', 2, true),
      { type: 'assistant', sessionId: SESSION, isSidechain: true, timestamp: at(3),
        message: { role: 'assistant', id: 'kid_1', model: 'claude-sonnet-5', content: [toolUse('k1', 'Grep', { pattern: 'DFlash2' })] } },
      user([toolResult('k1', 'no matches')], 5, true),
    ]);
    fs.writeFileSync(path.join(sub, `${STEM}.meta.json`), JSON.stringify(meta), 'utf8');
  }

  it('hangs the child under its spawn and projects the child\u2019s own steps there', async () => {
    seed();
    const { steps } = await claudeStepsPayload(claudeRunId(SESSION), FOLDER, { root });
    const spawn = steps.find((s) => s.kind === 'subagent')!;
    const kids = steps.filter((s) => s.parentOrdinal === spawn.ordinal);

    expect(spawn.childSessionId).toBe(claudeRunId(SESSION, STEM));
    expect(spawn.background).toBe(true);
    expect(spawn.agent).toBe('dflash2-recon');
    // The child's steps come DIRECTLY after the spawn, in one ordinal sequence.
    expect(kids.map((s) => s.ordinal)).toEqual([spawn.ordinal + 1, spawn.ordinal + 2]);
    expect(kids.map((s) => s.title)).toEqual(['Investigate DFlash2 Spark claim', 'Grep — DFlash2']);
    expect(kids.every((s) => s.depth === 1 && s.agent === 'dflash2-recon')).toBe(true);
    // ...and the parent's own later step is still after them, not swallowed.
    expect(steps[steps.length - 1]!.title).toBe('Reporting back.');
  });

  it('opens the child on its own id, as the map does on a click-through', async () => {
    seed();
    const payload = await claudeStepsPayload(claudeRunId(SESSION, STEM), FOLDER, { root });

    expect(payload.error).toBeUndefined();
    expect(payload.steps.map((s) => s.title)).toEqual(['Investigate DFlash2 Spark claim', 'Grep — DFlash2']);
    // Read on its own, a child is a run in its own right — no nesting fields.
    expect(payload.steps.some((s) => s.depth !== undefined)).toBe(false);
  });

  it('leaves a sub-agent that no tool_use spawned OFF the map rather than guessing a parent', async () => {
    // A `workflow-subagent` sidecar carries no toolUseId — 278 of the 966 on
    // this machine. Attaching it by time window would hang it off whichever
    // call happened to be open, which for a background spawn is a coin toss.
    seed({ agentType: 'workflow-subagent', spawnDepth: 1 });
    const { steps } = await claudeStepsPayload(claudeRunId(SESSION), FOLDER, { root });
    const spawn = steps.find((s) => s.kind === 'subagent')!;

    expect(spawn.childSessionId).toBeUndefined();
    expect(steps.some((s) => s.parentOrdinal !== undefined)).toBe(false);
    expect(steps.some((s) => s.title === 'Grep — DFlash2')).toBe(false);
  });
});

// --- what the file can throw at the reader --------------------------------

describe('a transcript that is awkward rather than large', () => {
  it('keeps a multi-byte character whole across the 64 KB read boundary', async () => {
    const dir = projectDir();
    // Pad past the chunk size, so the text below is decoded from bytes that
    // certainly straddle an edge. This reader is a SECOND implementation of
    // claudeHistory.ts's loop, so it owes its own proof.
    const filler = Array.from({ length: 900 }, (_, i) => assistant(`m${i}`, [toolUse(`t${i}`, 'Bash', { command: 'echo padding padding padding' })], 1, USAGE));
    const TEXT = 'Zeekapitein \u2014 schildpad \u{1F422} in de mist';
    write(path.join(dir, `${SESSION}.jsonl`), [...filler, assistant('last', [{ type: 'text', text: TEXT }], 2, USAGE)]);
    const { steps } = await claudeStepsPayload(claudeRunId(SESSION), FOLDER, { root });
    const reply = steps[steps.length - 1]!;

    expect(reply.title).toBe(TEXT);
    expect(reply.title).not.toContain('\uFFFD');
  });

  it('says a message recorded NO usage rather than substituting zeros', async () => {
    const dir = projectDir();
    write(path.join(dir, `${SESSION}.jsonl`), [
      assistant('msg_1', [toolUse('t1', 'Read', { file_path: 'a.ts' })], 1), // no usage bag at all
      user([toolResult('t1', 'ok')], 2),
    ]);
    const { steps } = await claudeStepsPayload(claudeRunId(SESSION), FOLDER, { root });

    expect(steps[0]!.usageMissing).toBe(true);
    expect(steps[0]!.tokens).toBeUndefined();
  });

  it('survives a torn last line and a line that is not JSON at all', async () => {
    const dir = projectDir();
    fs.writeFileSync(
      path.join(dir, `${SESSION}.jsonl`),
      `${JSON.stringify(user('Half a file', 0))}\nnot json at all\n{"type":"assist`,
      'utf8',
    );
    const { steps } = await claudeStepsPayload(claudeRunId(SESSION), FOLDER, { root });

    expect(steps.map((st) => st.title)).toEqual(['Half a file']);
  });

  // t-5nmtva: one workspace can have TWO transcript directories, because the
  // CLI has spelled the name both ways (`_` kept, `_` folded). The run is in
  // exactly one of them, so a resolver that stopped at the first NAME that
  // matched would report a live conversation as gone.
  it('finds the run in the SECOND directory that matches the folded key', async () => {
    const folder = 'C:\\ws\\lab_two';
    fs.mkdirSync(path.join(root, 'C--ws-lab-two'), { recursive: true }); // the other spelling, empty
    write(path.join(root, 'C--ws-lab_two', `${SESSION}.jsonl`), [user('Found anyway', 0)]);

    const { steps, error } = await claudeStepsPayload(claudeRunId(SESSION), folder, { root });

    expect(error).toBeUndefined();
    expect(steps.map((st) => st.title)).toEqual(['Found anyway']);
  });

  // t-5yejvo: the file-presence check stays, but it now READS the listing the
  // match already made instead of opening a conversation file in every
  // candidate directory to discover it is not there.
  it('never opens the conversation file in a directory whose listing does not hold it', async () => {
    const folder = 'C:\\ws\\lab_two';
    const empty = path.join(root, 'C--ws-lab-two');
    fs.mkdirSync(empty, { recursive: true });
    const decoy = path.join(empty, 'other-session.jsonl');
    fs.writeFileSync(decoy, '{}\n', 'utf8'); // a real file, the WRONG one
    const mine = path.join(root, 'C--ws-lab_two', `${SESSION}.jsonl`);
    write(mine, [user('Found anyway', 0)]);
    // The wrong directory is the NEWER one, so it is tried first: without the
    // presence check its (absent) conversation file would be opened to find out.
    fs.utimesSync(mine, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'));
    fs.utimesSync(decoy, new Date('2026-09-09T00:00:00Z'), new Date('2026-09-09T00:00:00Z'));
    const opened: string[] = [];
    const realOpen = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(((f: never, m: never) => {
      opened.push(String(f));
      return realOpen(f, m);
    }) as typeof fs.promises.open);

    const { steps } = await claudeStepsPayload(claudeRunId(SESSION), folder, { root });

    expect(steps.map((st) => st.title)).toEqual(['Found anyway']);
    expect(opened.filter((f) => f.includes(`C--ws-lab-two${path.sep}${SESSION}`))).toEqual([]);
  });

  it('answers an EMPTY transcript with no steps and no error — that is a real state, not a failure', async () => {
    const dir = projectDir();
    fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), '', 'utf8');

    await expect(claudeStepsPayload(claudeRunId(SESSION), FOLDER, { root }))
      .resolves.toEqual({ sessionId: claudeRunId(SESSION), steps: [], members: [], truncated: false, total: 0 });
  });
});

// --- the bound ------------------------------------------------------------

describe('a transcript too large to read whole', () => {
  const LINES = 100_000;

  beforeEach(async () => {
    const dir = projectDir();
    const out = fs.createWriteStream(path.join(dir, `${SESSION}.jsonl`));
    out.write(`${JSON.stringify(user('A very long night shift', 0))}\n`);
    for (let i = 0; i < LINES; i++) {
      out.write(`${JSON.stringify(assistant(`m${i}`, [toolUse(`t${i}`, 'Bash', { command: `echo ${i}` })], 1, USAGE))}\n`);
      out.write(`${JSON.stringify(user([toolResult(`t${i}`, 'ok')], 2))}\n`);
    }
    // AWAITED: a stream still flushing is a file the read sees as empty, which
    // fails as "no steps" and reads like a bug in the projection.
    await new Promise<void>((resolve, reject) => { out.on('close', resolve); out.on('error', reject); out.end(); });
  });

  it('stops at the byte budget and SAYS the run is truncated, instead of loading 200k lines', async () => {
    const payload = await claudeStepsPayload(claudeRunId(SESSION), FOLDER, { root, maxBytes: 64 * 1024 });

    // The prompt is at the top, so it is still the first step…
    expect(payload.steps[0]!.title).toBe('A very long night shift');
    // …but only a slice of the calls was read, and the payload admits it. A
    // reader that had slurped the file would report all LINES and truncated
    // false — this is the assertion that pins the streaming path.
    expect(payload.truncated).toBe(true);
    expect(payload.steps.length).toBeGreaterThan(0);
    expect(payload.steps.length).toBeLessThan(LINES / 10);
    // `total` is what was projected — a floor. It is never an invented remainder.
    expect(payload.total).toBe(payload.steps.length);
  });

  it('projects the whole file when the budget allows it, one ordinal per call', async () => {
    const payload = await claudeStepsPayload(claudeRunId(SESSION), FOLDER, { root, maxBytes: 256 * 1024 * 1024 });

    expect(payload.truncated).toBe(false);
    expect(payload.steps.filter((s) => s.tool === 'Bash')).toHaveLength(LINES);
    expect(payload.total).toBe(payload.steps.length);
    expect(payload.steps[payload.steps.length - 1]!.ordinal).toBe(payload.steps.length - 1);
  });
});
