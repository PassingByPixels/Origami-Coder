// A fictional chat in the harbor-weather repo, as the host streams it to the
// chat pane (the same message types DashboardPanel posts for a live turn).
const F = require('./fixtures.cjs');

const SID = 's1';
// Windows paths: most users are on Windows, and a POSIX path draws its leading
// '/' at the end of the right-to-left path label on a tool card.
const ROOT = 'D:\\work\\harbor-weather';
const P = (rel) => ROOT + '\\' + rel.split('/').join('\\');
const MODEL = 'qwen3-coder-30b';

const LOCAL = { model: MODEL, provider: 'lmstudio', label: 'LM Studio', local: true, engineUrl: 'http://127.0.0.1:1234/v1' };
const CLAUDE = { model: 'claude-sonnet-5', provider: 'claude-subscription', label: 'Claude (subscription)', local: false };

function session(sid = SID, title = F.CHATS[0].title, extra = {}, m = LOCAL) {
  return [
    { type: 'sessionCreated', sessionId: sid, sessionNumber: 1, agentName: 'Tsuru', title, agentArt: null, ...extra },
    { type: 'modelStatus', sessionId: sid, ok: true, modelName: m.model, providerLabel: m.label, providerIsLocal: m.local, providerId: m.provider, isVlm: false, visionState: 'auto-off', ...(m.engineUrl ? { engineUrl: m.engineUrl } : {}) },
    { type: 'sessionModels', models: { [sid]: `${m.provider}/${m.model}` } },
  ];
}

const tool = (sid, id, call, result) => [
  { type: 'toolCall', sessionId: sid, toolCallId: id, status: 'in_progress', ...call },
  { type: 'toolResult', sessionId: sid, toolCallId: id, status: 'completed', toolName: call.toolName, title: call.title, path: call.path, ...result },
];

const OLD = `export function StationBanner({ station }: Props) {
  return <Header name={station.name} />;
}`;
const NEW = `export function StationBanner({ station, tides }: Props) {
  const next = nextHighTide(tides);
  return (
    <>
      <Header name={station.name} />
      {next && next.height > TIDE_ALERT_M && <TideAlert tide={next} />}
    </>
  );
}`;

/** One finished turn: read, search, edit, test, answer. */
function tideTurn(sid = SID) {
  return [
    { type: 'echoUser', sessionId: sid, text: 'Add a tide alert to the station page. Show a banner when the next high tide is above 2.4 m.' },
    { type: 'agentThought', sessionId: sid, text: 'The station page renders StationBanner. The tide data is already loaded by useTides. I need nextHighTide from src/forecast/tides.ts and a threshold constant.' },
    ...tool(sid, 't1', { toolName: 'read', kind: 'read', title: 'src/stations/StationBanner.tsx', path: P('src/stations/StationBanner.tsx'), rawInput: { filePath: P('src/stations/StationBanner.tsx') } },
      { content: OLD, rawOutputMeta: { display: { type: 'file', lineStart: 1, lineEnd: 38 } } }),
    ...tool(sid, 't2', { toolName: 'grep', kind: 'search', title: 'nextHighTide', rawInput: { pattern: 'nextHighTide', path: 'src' } },
      { content: 'src/forecast/tides.ts:42: export function nextHighTide(tides: TidePoint[]): TidePoint | undefined {' }),
    ...tool(sid, 't3', { toolName: 'edit', kind: 'edit', title: 'src/stations/StationBanner.tsx', path: P('src/stations/StationBanner.tsx') },
      { content: '', diff: { path: P('src/stations/StationBanner.tsx'), oldText: OLD, newText: NEW } }),
    ...tool(sid, 't4', { toolName: 'bash', kind: 'execute', title: 'npm test -- tides', rawInput: { command: 'npm test -- tides', explanation: 'Run the tide tests' } },
      { content: ' PASS  src/forecast/tides.test.ts\n PASS  src/stations/StationBanner.test.tsx\n\nTests: 14 passed, 14 total', rawInput: { command: 'npm test -- tides', explanation: 'Run the tide tests' }, rawOutputMeta: { exit: 0, state: 'foreground', startedAt: F.NOW - 4200, lastOutputAt: F.NOW - 300 } }),
    { type: 'agentText', sessionId: sid, messageId: 'm-answer', text:
      'The station page now shows a tide alert.\n\n' +
      '- `StationBanner` reads the next high tide with `nextHighTide`.\n' +
      '- The banner shows when the tide is above `TIDE_ALERT_M` (2.4 m).\n' +
      '- Two new tests cover a tide just below and just above the limit.\n\n' +
      '| Station | Next high tide | Alert |\n|---|---|---|\n| North Pier | 2.61 m at 14:20 | yes |\n| Old Harbour | 2.18 m at 14:05 | no |\n\n' +
      'All 14 tide tests pass.' },
    { type: 'usageUpdate', sessionId: sid, used: 41200, size: 131072, cost: { amount: 0, currency: 'USD' }, prefill: 38100, read: 30200, write: 3100, cacheWrite: 0 },
    { type: 'contextUpdate', sessionId: sid, turns: 1, contextWindow: 131072 },
    { type: 'cacheState', sessionId: sid, state: 'warm', until: F.NOW + 240000, ttlSeconds: 300 },
    { type: 'turnDone', sessionId: sid },
  ];
}

/** An agent publishes a page as an artifact; the chat shows its card. */
function artifactTurn(sid = SID) {
  const link = '[Tide alert design](origami://artifact/art_7d2e41?v=1)';
  return [
    { type: 'echoUser', sessionId: sid, text: 'Make a one-page design for the tide alert banner, so I can review it before we build it.' },
    ...tool(sid, 'a1', { toolName: 'artifact_publish', kind: 'other', title: 'Tide alert design', rawInput: { title: 'Tide alert design', kind: 'page' } },
      { content: `Published version 1 of ${link}.\nFiles: index.html, styles.css, banner.svg (38 KB).` }),
    { type: 'agentText', sessionId: sid, messageId: 'm-art', text:
      `I made the design as a page: ${link}\n\n` +
      'It shows the banner in three states: no alert, alert, and alert with a storm warning. ' +
      'Each state uses the station colours from `src/ui/theme.ts`. Tell me what to change and I will publish version 2.' },
    { type: 'contextUpdate', sessionId: sid, turns: 3, contextWindow: 131072 },
    { type: 'turnDone', sessionId: sid },
  ];
}

/** Three sub-agents check the importers; one is still running. */
function subagentTurn(sid = SID) {
  const kid = (n, desc, status, result) => tool(sid, `k${n}`,
    { toolName: 'task', kind: 'other', title: desc, taskSessionId: `child-${n}`, taskModel: `lmstudio/${MODEL}`,
      rawInput: { description: desc, subagent_type: 'explore', prompt: `${desc}. Report the file and line of any timestamp that is parsed without a time zone.` } },
    { status, content: result, taskSessionId: `child-${n}`, taskModel: `lmstudio/${MODEL}`,
      rawInput: { description: desc, subagent_type: 'explore' },
      taskTokens: { input: 18200 + n * 900, output: 1400 + n * 120, reasoning: 600, cacheRead: 12000 } });
  return [
    { type: 'echoUser', sessionId: sid, text: 'Some tide times are one hour off. Check the three station importers for a time zone bug.' },
    ...kid(1, 'Check the buoy importer', 'completed', 'src/stations/buoys.ts:88 parses "2026-03-29 14:20" with new Date() and no zone. The feed is in UTC.'),
    ...kid(2, 'Check the tide gauge importer', 'completed', 'No problem found. src/stations/gauges.ts uses parseISO with an explicit offset.'),
    ...kid(3, 'Check the weather radar importer', 'in_progress', ''),
    { type: 'subagentChunk', sessionId: sid, childSessionId: 'child-3', text: 'Reading src/stations/radar.ts' },
    { type: 'contextUpdate', sessionId: sid, turns: 2, contextWindow: 131072 },
  ];
}

/** /firstfold part way through: the narration and the live todo list. */
function firstFold(sid = SID) {
  const steps = [
    ['Scan the workspace', 'Scanning the workspace'],
    ['Write AGENTS.md', 'Writing AGENTS.md'],
    ['Create projects/ scripts/ crons/', 'Creating the workspace folders'],
    ['Seed the wiki', 'Seeding the wiki'],
    ['Create HANDOFF.md', 'Creating HANDOFF.md'],
    ['Seed commands & skills', 'Seeding commands & skills'],
  ];
  const todos = steps.map(([content, activeForm], i) => ({ id: i, content, activeForm, status: i < 3 ? 'completed' : i === 3 ? 'in_progress' : 'pending' }));
  const say = (text) => ({ type: 'system', sessionId: sid, text });
  return [
    { type: 'echoUser', sessionId: sid, text: '/firstfold' },
    { type: 'firstfoldStart', sessionId: sid },
    say('Looking for build tooling \u2014 package.json, Cargo.toml, pyproject, go.mod\u2026'),
    say('\u2192 Node project \u2014 4 command(s) detected.'),
    say('Writing AGENTS.md \u2014 the guide the agent reads first every session.'),
    say('\u2192 Created AGENTS.md (how-to-work, coding discipline, action safety, wiki primer).'),
    say('Creating the workspace folders.'),
    say('\u2192 Created projects/, scripts/, crons/.'),
    say('Seeding wiki/ with an index primer (one topic per page, [[links]], workspace-relative paths).'),
    { type: 'todoUpdate', sessionId: sid, source: 'firstfold', todos },
  ];
}

/** A chat that was continued on another desk. */
function awayIndex(sid = SID) {
  return { ...F.nestIndex, away: [{ id: sid, desk: F.DESKS.home.id, at: F.ago(25) }] };
}

/** Replies for the composer's repo and branch pills. */
const repoHost = (sids = [SID]) => ({
  repoPickerOptions: { type: 'repoPickerOptions', repos: [{ name: 'harbor-weather', root: ROOT }], defaultRoot: ROOT,
    cwdBySession: Object.fromEntries(sids.map((x) => [x, ROOT])) },
  repoPickerBranches: { type: 'repoPickerBranches', root: ROOT, branches: [{ branch: 'feature/tide-alerts', path: ROOT }, { branch: 'main', path: `${ROOT}-main` }] },
  requestWorktreeState: { type: 'worktreeState', root: '$req:root', state: { dirty: 1, ahead: 2, behind: 0 } },
});

module.exports = { SID, MODEL, LOCAL, CLAUDE, ROOT, P, session, tideTurn, artifactTurn, subagentTurn, firstFold, awayIndex, tool, repoHost };
