// Fictional fixtures for the Agent Manager board-a scenes (Folds, Bots,
// Schedules, Settings, Artifacts). Extends fixtures.cjs's harbor-weather
// world; nothing here comes from a real user.
const F = require('./fixtures.cjs');

const { ago, PROJECT, ROOT, DESKS } = F;

// ---------------- Folds (flock) ----------------

const foldRows = [
  {
    id: 'f1', name: 'harbor-weather-1', branch: 'ticket/tide-alerts', path: `${ROOT}-1`,
    orphan: false, state: 'working', agentName: 'Tsuru', model: 'anthropic/claude-sonnet-4',
    stopReason: '', errorDetail: '', setupNote: '', startedAt: ago(12), hasSession: true,
    ahead: 3, adds: 128, dels: 14, queuedPrompt: '', mergedAt: 0, groupId: '',
    ticketId: 'tk-3', ticketTitle: 'Add tide alerts to the station page',
    activity: 'Running vitest for src/forecast/tides.ts', needsYou: null,
  },
  {
    id: 'f2', name: 'harbor-weather-2', branch: 'ticket/wind-chart', path: `${ROOT}-2`,
    orphan: false, state: 'queued', agentName: '', model: 'qwen3-coder-30b',
    stopReason: '', errorDetail: '', setupNote: '', startedAt: 0, hasSession: false,
    ahead: 0, adds: 0, dels: 0, queuedPrompt: 'Add a wind chart to the dashboard', mergedAt: 0, groupId: '',
    ticketId: 'tk-2', ticketTitle: 'Add wind chart to dashboard', activity: '', needsYou: null,
  },
  {
    id: 'f3', name: 'harbor-weather-3', branch: 'ticket/buoy-polling', path: `${ROOT}-3`,
    orphan: false, state: 'error', agentName: 'Tsuru', model: 'gpt-5-mini',
    stopReason: 'needs-answer', errorDetail: '', setupNote: '', startedAt: ago(90), hasSession: true,
    ahead: 1, adds: 22, dels: 3, queuedPrompt: '', mergedAt: 0, groupId: '',
    ticketId: '', ticketTitle: 'Refactor buoy polling loop', activity: '',
    needsYou: { kind: 'question', preview: 'Which chart library should the wind chart use — Chart.js or a hand-rolled canvas?' },
  },
  {
    id: 'f4', name: 'harbor-weather-4', branch: 'ticket/tz-fix', path: `${ROOT}-4`,
    orphan: false, state: 'idle', agentName: 'Tsuru', model: 'anthropic/claude-sonnet-4',
    stopReason: 'done', errorDetail: '', setupNote: '', startedAt: ago(240), hasSession: true,
    ahead: 2, adds: 41, dels: 6, queuedPrompt: '', mergedAt: 0, groupId: '',
    ticketId: '', ticketTitle: 'Fix timezone bug in tide table', activity: '', needsYou: null,
  },
];

const foldTickets = [
  {
    id: 'tk-1', title: 'Add station map search', status: 'triage', priority: 'normal',
    labels: ['ui'], assignee: '', acceptance: { done: 0, total: 0 }, updatedAt: ago(30), fold: '', branch: '',
  },
  {
    id: 'tk-2b', title: 'Write acceptance for buoy alerts', status: 'todo', priority: 'high',
    labels: ['backend'], assignee: 'crane', acceptance: { done: 2, total: 4 }, updatedAt: ago(60), fold: '', branch: '',
  },
  // Absorbed into f1's card (fold set) — draws once, not twice.
  {
    id: 'tk-3', title: 'Add tide alerts to the station page', status: 'in_progress', priority: 'high',
    labels: ['ui'], assignee: 'Tsuru', acceptance: { done: 2, total: 3 }, updatedAt: ago(12), fold: 'f1', branch: 'ticket/tide-alerts',
  },
  {
    id: 'tk-4', title: 'Bump weather API client version', status: 'merged', priority: 'low',
    labels: [], assignee: '', acceptance: { done: 3, total: 3 }, updatedAt: ago(500), fold: '', branch: '',
  },
];

const foldRepo = {
  root: ROOT, name: PROJECT, workspace: true, missing: false,
  defaultModel: 'anthropic/claude-sonnet-4', rows: foldRows,
  map: { status: 'ready' }, tickets: foldTickets, primary: ROOT, groupId: 'g1', branch: 'main',
};

function amState() {
  return {
    type: 'amState', repos: [foldRepo], noRepo: false, autoApprove: true,
    agentTypes: [{ id: 'default', name: 'Default' }], displayNames: {},
  };
}

const modelOptions = {
  type: 'modelOptions',
  options: [
    { value: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', configured: true },
    { value: 'qwen3-coder-30b', name: 'Qwen3 Coder 30B', configured: true },
    { value: 'gpt-5-mini', name: 'GPT-5 mini', configured: true },
  ],
};
const providerStatus = {
  type: 'providerStatus',
  providers: [
    { id: 'anthropic', name: 'Anthropic', live: true },
    { id: 'lmstudio', name: 'LM Studio', live: true, flavor: 'lmstudio' },
    { id: 'openai', name: 'OpenAI', live: true },
  ],
};

// ---------------- Bots (collabagents) ----------------

const collabAgentDefs = {
  type: 'collabAgentDefs',
  defs: [
    {
      slug: 'crane', description: 'Builds the thing the room agreed on.', model: 'qwen3-coder-30b',
      glyph: 'crane', persona: 'You are Crane, the build agent for harbor-weather.', preset: 'worker',
      customPermission: '', tools: ['bash', 'edit'], steps: '40', vision: false, visionProfile: false,
      bot: { tier: 'standard', memory: true }, legacySeed: false,
    },
    {
      slug: 'heron', description: 'Reads screenshots and station photos for layout review.', model: 'anthropic/claude-sonnet-4',
      glyph: 'heron', persona: 'You are Heron, the visual review agent.', preset: 'worker',
      customPermission: '', tools: ['bash', 'edit', 'browser'], steps: '60', vision: true, visionProfile: false,
      bot: { tier: 'open', memory: true }, legacySeed: false,
    },
    {
      slug: 'scout', description: 'Read-only recon: finds files and answers questions, never edits.', model: 'gpt-5-mini',
      glyph: 'scout', persona: 'You are Scout, read-only recon.', preset: 'observer',
      customPermission: '', tools: ['read'], steps: '20', vision: false, visionProfile: false,
      bot: { tier: 'strict', memory: false }, legacySeed: false,
    },
    {
      slug: 'egret', description: 'Writes release notes from the merged tickets.', model: 'gpt-5-mini',
      glyph: '', persona: 'You are Egret, the release notes writer for harbor-weather.', preset: 'worker',
      customPermission: '', tools: ['read', 'edit'], steps: '30', vision: false, visionProfile: false,
      bot: { tier: 'standard', memory: true }, legacySeed: false,
    },
  ],
  visionDefs: [],
  archetypes: [],
  memoryFacts: { crane: 3, heron: 5, scout: 0, egret: 1 },
  error: '',
};

const toolsData = { type: 'toolsData', tools: [{ id: 'bash' }, { id: 'edit' }, { id: 'browser' }, { id: 'read' }] };

// ---------------- Schedules (crons + loops) ----------------

const cronsData = {
  type: 'cronsData',
  crons: [
    {
      id: 'c1', name: 'Nightly dependency check',
      prompt: 'Check for outdated dependencies in harbor-weather and open a ticket if any are stale.',
      scheduleLabel: 'daily at 02:00', agent: 'scout', model: 'anthropic/claude-sonnet-4', enabled: true,
      taskName: '\\Origami\\c1', logPath: '.origami\\cron-logs\\c1.log', scriptPath: '.origami\\crons\\c1.cmd',
      nextRunAt: new Date(F.NOW + 10 * 3600_000).toISOString(), lastOutputAt: ago(23 * 60),
      runs: 18, runsExact: true, lastOutcome: 'ok', lastExitCode: 0,
      schedule: { kind: 'daily', time: '02:00' },
    },
    {
      id: 'c2', name: 'Weekly release notes draft',
      prompt: 'Draft the release notes for this week\'s harbor-weather changes.',
      scheduleLabel: 'weekly, Monday at 08:00', agent: 'crane', model: 'gpt-5-mini', enabled: true,
      taskName: '\\Origami\\c2', logPath: '.origami\\cron-logs\\c2.log', scriptPath: '.origami\\crons\\c2.cmd',
      nextRunAt: new Date(F.NOW + 3 * 86400_000).toISOString(), lastOutputAt: ago(7 * 24 * 60),
      runs: 6, runsExact: true, lastOutcome: 'ok', lastExitCode: 0,
      schedule: { kind: 'weekly', days: ['mon'], time: '08:00' },
    },
    {
      id: 'c3', name: 'Morning build status',
      prompt: 'Post a short summary of last night\'s build and test run.',
      scheduleLabel: 'daily at 07:30', agent: '', model: 'qwen3-coder-30b', enabled: false,
      taskName: '\\Origami\\c3', logPath: '.origami\\cron-logs\\c3.log', scriptPath: '.origami\\crons\\c3.cmd',
      nextRunAt: null, lastOutputAt: ago(20 * 60), runs: 42, runsExact: true, lastOutcome: 'failed', lastExitCode: 1,
      schedule: { kind: 'daily', time: '07:30' },
    },
  ],
  invalid: [],
  drift: { missingRegistration: [], strayRegistration: [] },
  workspace: ROOT,
  backendAvailable: true,
  backendReason: '',
};

const loopSchedulesData = {
  type: 'loopSchedulesData',
  schedules: [
    {
      sessionId: 'ses_loop_1', number: 1, agentName: 'Tsuru', title: 'triage CI',
      intervalLabel: '30m', prompt: 'Check for newly failing tests in harbor-weather.',
      runs: 3, persistent: true, headless: false, nextRunAt: F.NOW + 12 * 60_000, lastRunAt: ago(18), lastOutcome: 'ok',
    },
    {
      sessionId: 'ses_loop_2', number: 2, agentName: 'Heron', title: 'watch deploy',
      intervalLabel: '15m', prompt: 'Poll the staging deploy for the wind chart branch.',
      runs: 9, persistent: false, headless: true, nextRunAt: null, lastRunAt: ago(4), lastOutcome: 'ok',
    },
  ],
  needsAttention: [],
};

// ---------------- Artifacts ----------------

function deskChip(id) {
  const d = DESKS[id];
  const { self, ...chip } = d;
  return chip;
}

const artifactsData = {
  type: 'artifactsData',
  artifacts: [
    {
      id: 'a1', title: 'Tide alert design', latest: 4, updated: ago(20),
      ownerDevice: DESKS.self.name, here: true, sessionID: 'ses_41', project: PROJECT, unopened: false,
    },
    {
      id: 'a2', title: 'Station map prototype', latest: 1, updated: ago(180),
      ownerDevice: DESKS.self.name, here: true, sessionID: 'ses_39', project: PROJECT, unopened: false,
    },
    {
      id: 'a3', title: 'Release 2.0 plan', latest: 2, updated: ago(60 * 6),
      ownerDevice: DESKS.home.name, here: false, sessionID: 'ses_35', project: PROJECT, unopened: true,
      desk: deskChip('home'),
    },
    {
      id: 'a4', title: 'Wind chart report', latest: 1, updated: ago(60 * 30),
      ownerDevice: DESKS.travel.name, here: false, sessionID: 'ses_30', project: PROJECT, unopened: false,
      desk: deskChip('travel'),
    },
  ],
  homeDevice: DESKS.self.name,
  motherBase: { self: false, name: DESKS.home.name },
  error: '',
};

const artifactVersions = {
  type: 'artifactVersions',
  artifactId: '$req:artifactId',
  versions: [
    { number: 1, digest: 'a1c02f', created: ago(1440), device: DESKS.self.name },
    { number: 2, digest: 'b93e17', created: ago(600), device: DESKS.self.name },
    { number: 3, digest: 'c4471a', created: ago(90), device: DESKS.self.name },
    { number: 4, digest: 'd5aa02', created: ago(20), device: DESKS.self.name },
  ],
  error: '',
};

// ---------------- Settings ----------------

const subagentLimitData = { type: 'subagentLimitData', hours: 6, min: 0.5, default: 4, stored: true, error: null };
const browserViewportUpdate = { type: 'browserViewportUpdate', width: 1280, height: 800, beside: true, reveal: 'first' };
const cacheWarmingData = { type: 'cacheWarmingData', enabled: true, error: null };
const chatBackdropData = { type: 'chatBackdropData', enabled: false, error: null };

module.exports = {
  amState, modelOptions, providerStatus,
  collabAgentDefs, toolsData,
  cronsData, loopSchedulesData,
  artifactsData, artifactVersions,
  subagentLimitData, browserViewportUpdate, cacheWarmingData, chatBackdropData,
};
