// claudeCodeTranslator.test.ts — CLI events → the webview messages ChatPane
// already reduces.
//
// The whole captured turn is replayed in order at the bottom, which is the
// assertion that matters most: the CLI sends each content block TWICE (as
// stream deltas, then whole in an `assistant` event), so a translator that
// renders both would print every answer twice. A per-event test cannot see
// that; a replay of the real sequence can.

import { describe, expect, it } from 'vitest';
import { parseLine } from '../../../src/claudeCode/protocol';
import { newTranslatorState, toolKind, toolTitle, translate } from '../../../src/claudeCode/translator';
import type { WebviewPost } from '../../../src/claudeCode/translator';
import {
  RUN1_ASSISTANT_TEXT_BLOCK, RUN1_ASSISTANT_THINKING_BLOCK, RUN1_BLOCK_START_TEXT,
  RUN1_BLOCK_START_THINKING, RUN1_MESSAGE_DELTA, RUN1_MESSAGE_START, RUN1_MESSAGE_STOP,
  RUN1_RATE_LIMIT_EVENT, RUN1_RESULT, RUN1_SIGNATURE_DELTA, RUN1_STDOUT_LINES, RUN1_SYSTEM_INIT,
  RUN1_SYSTEM_STATUS_BEFORE_INIT, RUN1_SYSTEM_STATUS_REQUESTING, RUN1_TEXT_DELTA,
  RUN1_THINKING_DELTA_1, RUN1_THINKING_DELTA_2, RUN1_THINKING_TOKENS,
  RUN2_ASSISTANT_TOOL_USE, RUN2_BLOCK_START_TOOL_USE, RUN2_INPUT_JSON_DELTA_CLOSE,
  RUN2_INPUT_JSON_DELTA_CONTENT, RUN2_INPUT_JSON_DELTA_EMPTY, RUN2_INPUT_JSON_DELTA_PATH,
  RUN2_RESULT_MAX_TURNS, RUN2_USER_TOOL_RESULT,
  DENY_RATE_LIMIT_EVENT, PROBE_INITIALIZE_RESPONSE, PROBE_RATE_LIMIT_EVENT, PROBE_SYSTEM_INIT,
} from './claudeCodeFixtures';

// An API-KEY session. DERIVED, and it has to be: neither live run was on a key,
// because this machine authenticates from ~/.claude. Exactly ONE field of the
// real line is substituted, the same technique the sub-agent and failed-tool
// cases below use, and the substitution is asserted to have bitten.
const API_KEY_INIT = RUN1_SYSTEM_INIT.replace('"apiKeySource":"none"', '"apiKeySource":"user"');

const SID = 'claude-1';
const run = (line: string, st = newTranslatorState(SID)): WebviewPost[] => translate(parseLine(line)!, st);

describe('system events', () => {
  it('turns system/init into ONE line saying what the user inherited', () => {
    const posts = run(RUN1_SYSTEM_INIT);
    expect(posts[0]!.type).toBe('system');
    expect(posts[0]!.sessionId).toBe(SID);
    const text = String(posts[0]!.text);
    expect(text).toContain('Claude Code 2.1.198 connected');
    expect(text).toContain('claude-haiku-4-5-20251001');
    expect(text).toContain('MCP servers');
    // memory_paths is present on every real init, so the line says so: the
    // owner asked whether his memories ride along, and they do.
    expect(text).toContain('memory');
  });

  it('never presents a SKILL COUNT as this session\'s roster', () => {
    // The bug this pins: `init.skills` (25 on the probe) is a strict SUBSET of
    // `init.slash_commands` (53) — the social-posts* plugin pages are in the
    // second and not the first — so a headline "25 skills" sends a user hunting
    // for one that was there all along. The line counts only what the `/`
    // palette is about to SHOW.
    const text = String(run(PROBE_SYSTEM_INIT)[0]!.text);
    expect(text).toContain('53 commands on /');
    expect(text).not.toMatch(/\bskills\b/);
    expect(text).not.toContain('25');
  });

  it('counts nothing on / when the setting is off', () => {
    const text = String(run(PROBE_SYSTEM_INIT, newTranslatorState(SID, false))[0]!.text);
    expect(text).toContain('Claude Code 2.1.198 connected');
    expect(text).not.toContain('commands on /');
  });

  it('renders nothing for the system subtypes we do not model', () => {
    // Both are real lines from the captured turn. Tolerating them silently is
    // the requirement: `status` even arrived BEFORE the initialize response.
    expect(run(RUN1_SYSTEM_STATUS_BEFORE_INIT)).toEqual([]);
    expect(run(RUN1_SYSTEM_STATUS_REQUESTING)).toEqual([]);
    expect(run(RUN1_THINKING_TOKENS)).toEqual([]);
  });

  it('drops an event type it has never seen rather than failing', () => {
    expect(translate({ type: 'some_future_event', session_id: 'x' }, newTranslatorState(SID))).toEqual([]);
  });
});

describe('streaming', () => {
  it('streams thinking deltas into the thought block, verbatim', () => {
    const st = newTranslatorState(SID);
    expect(run(RUN1_BLOCK_START_THINKING, st)).toEqual([]);
    expect(run(RUN1_THINKING_DELTA_1, st)).toEqual([{ type: 'agentThought', text: 'The', sessionId: SID }]);
    const second = run(RUN1_THINKING_DELTA_2, st)[0]!;
    expect(second.type).toBe('agentThought');
    expect(String(second.text)).toContain('Do not use any tools.');
    // A signature is cryptographic provenance, not prose.
    expect(run(RUN1_SIGNATURE_DELTA, st)).toEqual([]);
  });

  it('streams text deltas as agent prose and arms NO rewind anchor', () => {
    const st = newTranslatorState(SID);
    expect(run(RUN1_BLOCK_START_TEXT, st)).toEqual([]);
    const posts = run(RUN1_TEXT_DELTA, st);
    expect(posts).toEqual([{ type: 'agentText', text: 'PONG', sessionId: SID }]);
    // messageId is the "Rewind here" anchor. A passthrough turn cannot be
    // reverted, so the field must be ABSENT, not empty.
    expect(posts[0]).not.toHaveProperty('messageId');
  });

  it('says nothing for message_start / message_delta / message_stop', () => {
    const st = newTranslatorState(SID);
    expect(run(RUN1_MESSAGE_START, st)).toEqual([]);
    expect(st.model).toBe('claude-haiku-4-5-20251001');
    expect(run(RUN1_MESSAGE_DELTA, st)).toEqual([]);
    expect(run(RUN1_MESSAGE_STOP, st)).toEqual([]);
  });

  it('never re-renders a completed block that already streamed', () => {
    expect(run(RUN1_ASSISTANT_THINKING_BLOCK)).toEqual([]);
    expect(run(RUN1_ASSISTANT_TEXT_BLOCK)).toEqual([]);
  });
});

describe('sub-agent traffic is dropped, and so is its usage', () => {
  // DERIVED: one field of a real line is substituted, because the captured turn
  // spawned no sub-agent. Both the text and the RESULT are checked — dropping
  // the prose but counting the tokens would silently double the context meter.
  const asChild = (line: string) => line.replace('"parent_tool_use_id":null', '"parent_tool_use_id":"toolu_01ABC"');

  it('renders no row for a child event', () => {
    expect(run(asChild(RUN1_TEXT_DELTA))).toEqual([]);
    expect(run(asChild(RUN1_ASSISTANT_TEXT_BLOCK))).toEqual([]);
  });

  it('excludes a child result from the context meter and the turn close', () => {
    const child = `${RUN1_RESULT.slice(0, -1)},"parent_tool_use_id":"toolu_01ABC"}`;
    expect(run(child)).toEqual([]);
    // The same line WITHOUT the marker still closes the turn — proving the drop
    // is the marker's doing and not the shape of the fixture.
    expect(run(RUN1_RESULT).map((p) => p.type)).toContain('turnDone');
  });
});

describe('result closes the turn and feeds both meters', () => {
  it('emits contextUpdate + usageUpdate + turnDone with the CLI\'s own numbers', () => {
    // An API-KEY session: the dollar figure is real money and must survive.
    const st = newTranslatorState(SID);
    run(API_KEY_INIT, st);
    const posts = run(RUN1_RESULT, st);
    expect(posts.map((p) => p.type)).toEqual(['contextUpdate', 'usageUpdate', 'turnDone']);
    expect(posts[0]).toMatchObject({ sessionId: SID, tokensUsed: 36362, contextUsed: 36362, contextTotal: 200000, contextWindow: 200000 });
    expect(posts[1]).toMatchObject({ used: 36362, size: 200000, cost: { amount: 0.073633 } });
    // The turn-closing post carries the CLI's OWN split counts, which is what
    // the transcript mirror stores on the engine row (claudeCodeMirror.ts). A
    // measurement, not a price: `usageUpdate` above is the only cost claim, and
    // it is gated on this being an API-key session.
    expect(posts[2]).toEqual({
      type: 'turnDone', stopReason: 'end_turn', sessionId: SID,
      tokens: { input: 10, output: 62, cacheRead: 0, cacheWrite: 36352 },
    });
  });

  it('surfaces a REAL errored result as an error row before closing the turn', () => {
    // Not derived: the second live run hit --max-turns 1 mid tool call, so this
    // is a genuine is_error result off the wire.
    const st = newTranslatorState(SID);
    run(API_KEY_INIT, st);
    const posts = run(RUN2_RESULT_MAX_TURNS, st);
    expect(posts.map((p) => p.type)).toEqual(['error', 'contextUpdate', 'usageUpdate', 'turnDone']);
    // t-d94nra: the ERROR half of the CLI's `result` union carries `errors[]` and NO `result`
    // string (verified against this very fixture: it has
    // `"errors":["Reached maximum number of turns (1)"]` and no `result` key). Reading `ev.result`
    // alone threw that sentence away and showed the bare stop_reason, `tool_use`, instead.
    expect(String(posts[0]!.message)).toContain('Reached maximum number of turns (1)');
    expect(posts.at(-1)).toMatchObject({ type: 'turnDone', stopReason: 'tool_use', sessionId: SID });
  });
});

describe('a subscription turn is never priced', () => {
  // THE GATE. `total_cost_usd` on a plan is the API-equivalent list price of a
  // turn the month already paid for; posting it paints a bill in the composer
  // that will never be sent. `apiKeySource` is the only thing that separates the
  // two cases, and both sides of it are asserted here.
  it('drops the usageUpdate entirely when apiKeySource is none', () => {
    const st = newTranslatorState(SID);
    run(RUN1_SYSTEM_INIT, st);           // the REAL line: "apiKeySource":"none"
    const posts = run(RUN1_RESULT, st);  // the REAL line: total_cost_usd 0.073633
    expect(posts.map((p) => p.type)).toEqual(['contextUpdate', 'turnDone']);
    expect(JSON.stringify(posts)).not.toContain('cost');
    // The context meter is untouched — only the MONEY claim is withdrawn.
    expect(posts[0]).toMatchObject({ contextUsed: 36362, contextWindow: 200000 });
  });

  it('keeps the dollar figure when a KEY paid for the turn', () => {
    expect(API_KEY_INIT).not.toBe(RUN1_SYSTEM_INIT); // the substitution bit
    const st = newTranslatorState(SID);
    run(API_KEY_INIT, st);
    expect(run(RUN1_RESULT, st).map((p) => p.type)).toContain('usageUpdate');
  });

  it('treats an init it never saw as a plan, not as a key', () => {
    // Fail towards the recoverable error: a hidden real figure costs the user a
    // number /usage still has, while a shown notional one is a false bill.
    expect(run(RUN1_RESULT).map((p) => p.type)).toEqual(['contextUpdate', 'turnDone']);
  });

  it('tells the composer which of the two readouts is honest', () => {
    const meter = run(RUN1_SYSTEM_INIT).find((p) => p.type === 'passthroughMeter');
    expect(meter).toMatchObject({ sessionId: SID, subscription: true, pillPct: -1 });
    const keyed = run(API_KEY_INIT).find((p) => p.type === 'passthroughMeter');
    expect(keyed).toMatchObject({ subscription: false });
  });
});

describe('rate limits are surfaced once per change, not once per event', () => {
  it('warns on the first non-allowed LEVEL and never repeats that line', () => {
    const st = newTranslatorState(SID);
    const first = run(RUN1_RATE_LIMIT_EVENT, st);
    expect(first.map((p) => p.type)).toEqual(['passthroughMeter', 'system']);
    expect(String(first[1]!.text)).toContain('allowed warning');
    expect(String(first[1]!.text)).toContain('7d');
    expect(String(first[1]!.text)).toContain('80%');
    // Three REAL readings of the SAME level, captured on three different days:
    // 0.80, 0.87, 0.90. The badge must track all three; the transcript must not
    // gain a line for any of them.
    for (const later of [RUN1_RATE_LIMIT_EVENT, DENY_RATE_LIMIT_EVENT, PROBE_RATE_LIMIT_EVENT]) {
      expect(run(later, st).map((p) => p.type)).toEqual(['passthroughMeter']);
    }
    expect(run(PROBE_RATE_LIMIT_EVENT, st)[0]).toMatchObject({ pillPct: 90, pillWindow: '7d' });
  });

  it('builds a badge small enough to sit beside the context gauge', () => {
    expect(run(RUN1_RATE_LIMIT_EVENT)[0]).toMatchObject({ type: 'passthroughMeter', pillPct: 80, pillWindow: '7d', pillResetsAt: 1788195600 * 1000, subscription: true });
    expect(run(DENY_RATE_LIMIT_EVENT)[0]).toMatchObject({ pillPct: 87, pillWindow: '7d' });
    const title = String(run(PROBE_RATE_LIMIT_EVENT)[0]!.pillTitle);
    expect(title).toContain('90% of your 7d limit');
    expect(title).toContain('no per-turn charge');
  });

  it('names a limit window it has never seen rather than dropping it', () => {
    // DERIVED from the real line: a window type this build has no word for must
    // still reach the badge — silence would read as "no limit".
    const odd = RUN1_RATE_LIMIT_EVENT.replace('"rateLimitType":"seven_day"', '"rateLimitType":"lunar_cycle"');
    expect(run(odd)[0]).toMatchObject({ pillWindow: 'lunar cycle', pillPct: 80 });
  });

  it('says nothing at all while the status is plain allowed', () => {
    const ok = RUN1_RATE_LIMIT_EVENT.replace('"status":"allowed_warning"', '"status":"allowed"');
    expect(run(ok)).toEqual([]);
  });

  it('CLEARS a standing badge when the window resets', () => {
    // A badge that can only ever appear would sit there reading "7d 90%" for
    // the rest of the session. DERIVED from the real line by the one field that
    // says the plan recovered.
    const ok = RUN1_RATE_LIMIT_EVENT.replace('"status":"allowed_warning"', '"status":"allowed"');
    const st = newTranslatorState(SID);
    run(RUN1_RATE_LIMIT_EVENT, st);
    expect(run(ok, st)).toEqual([{ type: 'passthroughMeter', sessionId: SID, subscription: true, pillPct: -1, pillResetsAt: 0, pillWindow: '', pillTitle: '', windows: [] }]);
    // Cleared once, not on every subsequent allowed frame.
    expect(run(ok, st)).toEqual([]);
    // ...and the next warning is a level change again, so it earns its ONE line.
    expect(run(PROBE_RATE_LIMIT_EVENT, st).map((p) => p.type)).toEqual(['passthroughMeter', 'system']);
  });
});

describe('this session\'s own / commands reach the palette', () => {
  it('carries every name init lists, grouped under one category', () => {
    const st = newTranslatorState(SID);
    run(PROBE_INITIALIZE_RESPONSE, st); // prose first, as it arrived on the wire
    const rows = run(PROBE_SYSTEM_INIT, st).find((p) => p.type === 'passthroughCommands')!
      .commands as Array<{ name: string; description: string; category: string }>;
    expect(rows).toHaveLength(53);
    expect(new Set(rows.map((r) => r.category))).toEqual(new Set(['Claude Code']));
    expect(rows.map((r) => r.name)).toContain('/review-code');
    // The names carry the leading slash the palette inserts verbatim.
    expect(rows.every((r) => r.name.startsWith('/'))).toBe(true);
  });

  it('fills descriptions from the initialize frame, in EITHER arrival order', () => {
    const withProse = (order: string[]) => {
      const st = newTranslatorState(SID);
      let rows: Array<{ name: string; description: string }> = [];
      for (const line of order) {
        for (const post of run(line, st)) {
          if (post.type === 'passthroughCommands') rows = post.commands as typeof rows;
        }
      }
      return rows.find((r) => r.name === '/make-asset')!.description;
    };
    // control_response BEFORE init is the captured order; the reverse must work
    // too, or a slower CLI would leave every row blank.
    expect(withProse([PROBE_INITIALIZE_RESPONSE, PROBE_SYSTEM_INIT])).toContain('Create one game asset');
    expect(withProse([PROBE_SYSTEM_INIT, PROBE_INITIALIZE_RESPONSE])).toContain('Create one game asset');
  });

  it('cuts a paragraph-long description down to one line', () => {
    const st = newTranslatorState(SID);
    run(PROBE_INITIALIZE_RESPONSE, st);
    const rows = run(PROBE_SYSTEM_INIT, st).find((p) => p.type === 'passthroughCommands')!
      .commands as Array<{ name: string; description: string }>;
    const desc = rows.find((r) => r.name === '/make-asset')!.description;
    // The fixture's is 309 characters; the dropdown gives it a single line.
    expect(desc.length).toBeLessThanOrEqual(111);
    expect(desc.endsWith('\u2026')).toBe(true);
  });

  it('still lists a command the initialize frame said nothing about', () => {
    const rows = run(PROBE_SYSTEM_INIT).find((p) => p.type === 'passthroughCommands')!
      .commands as Array<{ name: string; description: string }>;
    expect(rows.find((r) => r.name === '/review-code')!.description).toBe('');
  });

  it('sends no palette rows at all when the setting is off', () => {
    const st = newTranslatorState(SID, false);
    run(PROBE_INITIALIZE_RESPONSE, st);
    expect(run(PROBE_SYSTEM_INIT, st).map((p) => p.type)).toEqual(['system', 'passthroughMeter']);
  });
});

describe('the tool path, from the second live run', () => {
  const TOOL_ID = 'toolu_01Tam2qmJwK1fMj1GQHUYkSF';

  it('opens the card the moment the model commits to the tool, with no arguments yet', () => {
    const posts = run(RUN2_BLOCK_START_TOOL_USE);
    expect(posts).toEqual([{
      type: 'toolCall', sessionId: SID, toolCallId: TOOL_ID,
      toolName: 'Write', title: 'Write', kind: 'edit', status: 'in_progress',
    }]);
  });

  it('never renders a half-parsed argument fragment', () => {
    const st = newTranslatorState(SID);
    run(RUN2_BLOCK_START_TOOL_USE, st);
    // The middle fragment is literally `{"file_path": "C:\\tmp\\…smoke.txt` —
    // unparseable JSON. Reassembling it is monocode's problem, not ours: the
    // `assistant` event below re-sends the same input whole and already parsed.
    for (const frag of [RUN2_INPUT_JSON_DELTA_EMPTY, RUN2_INPUT_JSON_DELTA_PATH, RUN2_INPUT_JSON_DELTA_CONTENT, RUN2_INPUT_JSON_DELTA_CLOSE]) {
      expect(run(frag, st)).toEqual([]);
    }
  });

  it('fills the card from the assistant event, keeping it in progress', () => {
    const posts = run(RUN2_ASSISTANT_TOOL_USE);
    expect(posts).toEqual([{
      type: 'toolResult', sessionId: SID, toolCallId: TOOL_ID, toolName: 'Write',
      title: 'Write: C:\\tmp\\origami-cc-smoke\\smoke.txt', status: 'in_progress', content: '',
      rawInput: { file_path: 'C:\\tmp\\origami-cc-smoke\\smoke.txt', content: 'hello' },
    }]);
  });

  it('completes the card from the CLI\'s tool_result echo', () => {
    const st = newTranslatorState(SID);
    run(RUN2_BLOCK_START_TOOL_USE, st); // so the remembered tool name rides the update
    const posts = run(RUN2_USER_TOOL_RESULT, st);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ type: 'toolResult', toolCallId: TOOL_ID, status: 'completed', toolName: 'Write' });
    expect(String(posts[0]!.content)).toContain('File created successfully');
  });

  it('marks a failed tool result failed, not completed', () => {
    // DERIVED from RUN2_USER_TOOL_RESULT: the live call succeeded, so the one
    // field that distinguishes a failure is added to the real line.
    const failed = RUN2_USER_TOOL_RESULT.replace('"type":"tool_result"', '"type":"tool_result","is_error":true');
    expect(run(failed)[0]).toMatchObject({ status: 'failed' });
  });

  it('routes a TodoWrite call to the todo strip as well as a card', () => {
    // DERIVED from RUN2_ASSISTANT_TOOL_USE: the same real frame with the tool
    // name and input swapped, because neither live run wrote a todo list.
    const todo = RUN2_ASSISTANT_TOOL_USE
      .replace('"name":"Write"', '"name":"TodoWrite"')
      .replace('"input":{"file_path":"C:\\\\tmp\\\\origami-cc-smoke\\\\smoke.txt","content":"hello"}',
        '"input":{"todos":[{"content":"ship it","activeForm":"shipping it","status":"in_progress"}]}');
    expect(todo).not.toBe(RUN2_ASSISTANT_TOOL_USE);
    const posts = run(todo);
    expect(posts[0]).toMatchObject({ type: 'todoUpdate', sessionId: SID, source: 'claude-code' });
    // Row shape is acpTodoWrite.todosFromUpdate's — reused, not re-implemented,
    // so the passthrough strip and the engine strip cannot drift apart.
    expect(posts[0]!.todos).toEqual([{ id: 0, content: 'ship it', activeForm: 'shipping it', status: 'in_progress', depth: 0 }]);
    expect(posts[1]!.type).toBe('toolResult');
  });
});

describe('tool naming', () => {
  it('maps Claude tool names onto the kinds ToolCard renders', () => {
    expect(toolKind('Read')).toBe('read');
    expect(toolKind('Write')).toBe('edit');
    expect(toolKind('Bash')).toBe('execute');
    expect(toolKind('Grep')).toBe('search');
    // An MCP tool, or whatever the next release adds: a generic card, not a crash.
    expect(toolKind('mcp__board__board_tickets')).toBe('other');
  });

  it('puts the thing the user scans for in the card label', () => {
    expect(toolTitle('Read', { file_path: 'C:\\repo\\a.ts' })).toBe('Read: C:\\repo\\a.ts');
    expect(toolTitle('Bash', { command: 'npm test' })).toBe('Bash: npm test');
    expect(toolTitle('TodoWrite', {})).toBe('TodoWrite');
  });
});

describe('the whole captured turn, replayed in order', () => {
  it('produces one thought stream, one PONG, and one turn close', () => {
    const st = newTranslatorState(SID);
    const posts = RUN1_STDOUT_LINES.flatMap((line) => {
      const ev = parseLine(line);
      return ev ? translate(ev, st) : [];
    });
    expect(posts.map((p) => p.type)).toEqual([
      'system',                              // system/init
      'passthroughMeter',                    // ... and what funds this cell
      'passthroughCommands',                 // ... and its own / rows
      'passthroughMeter', 'system',          // rate_limit_event: badge, then ONE line
      'agentThought', 'agentThought',        // the two thinking_delta lines in the fixture set
      'agentText',
      'contextUpdate', 'turnDone',           // no usageUpdate: this run was on a PLAN
    ]);
    // Exactly ONE 'PONG': the assistant echo of the completed block must not
    // print it a second time.
    expect(posts.filter((p) => p.type === 'agentText').map((p) => p.text)).toEqual(['PONG']);
    expect(st.providerSessionId).toBe('c6bab4a9-9d8a-4bf1-855d-9d7e146f884a');
  });
});
