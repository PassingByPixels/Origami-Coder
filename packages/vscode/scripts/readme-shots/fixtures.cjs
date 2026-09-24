// The one fictional world every screenshot uses. Nothing here comes from a
// real user: a made-up weather-dashboard repo, three made-up desks, made-up
// chats. Times are relative to "now" so the ages read naturally.
const NOW = Date.now();
const MIN = 60_000;
const ago = (m) => NOW - m * MIN;

const PROJECT = 'harbor-weather';
const ROOT = '/work/harbor-weather';

const DESKS = {
  self: { id: 'desk-studio', name: 'studio-pc', os: 'windows', self: true, online: true, motherBase: false, lastSeen: NOW },
  home: { id: 'desk-home', name: 'home-server', os: 'linux', self: false, online: true, motherBase: true, lastSeen: ago(1) },
  travel: { id: 'desk-travel', name: 'travel-mac', os: 'macos', self: false, online: false, motherBase: false, lastSeen: ago(180) },
};

/** groupData: the Nests view snapshot (src/remote/groupController.ts shape). */
function groupData(extra = {}) {
  return {
    type: 'groupData',
    nestsEnabled: true,
    devices: [DESKS.self, DESKS.home, DESKS.travel],
    self: { name: DESKS.self.name, os: 'windows' },
    relayUrl: 'wss://relay.origamilabs.nl',
    tail: { running: false, desks: { [DESKS.travel.id]: { tailed: 3, behind: 0 } } },
    ...extra,
  };
}

const GB = 1073741824;
const MB = 1048576;
const nestStorage = {
  type: 'nestStorageData',
  stats: { classes: { chats: 1.4 * GB, subagents: 620 * MB, toolOutput: 310 * MB, journal: 95 * MB, artifacts: 18 * MB }, journalEventsPerPart: 1 },
  measuredAt: ago(2),
  retention: { windows: { chats: 30, subagents: 14, toolOutput: 7, artifacts: 90 } },
};

/** Connections: the host's providerStatus rows (DashboardPanel probe shape). */
const providerStatus = {
  type: 'providerStatus',
  providers: [
    { id: 'lmstudio', name: 'LM Studio', live: true, kind: 'local', baseURL: 'http://127.0.0.1:1234/v1', primary: true, flavor: 'lmstudio' },
    { id: 'ollama', name: 'Ollama', live: true, kind: 'local', baseURL: 'http://127.0.0.1:11434/v1', primary: false, flavor: 'ollama' },
    { id: 'openrouter', name: 'OpenRouter', live: true, kind: 'remote', baseURL: 'https://openrouter.ai/api/v1', primary: false, flavor: 'other' },
    { id: 'openai', name: 'OpenAI', live: true, kind: 'remote', primary: false, flavor: 'other' },
  ],
};
const claudeCodeStatus = { type: 'claudeCodeStatus', installed: true, version: '2.1.270', binary: '/usr/local/bin/claude', tooltip: 'Claude Code 2.1.270' };
// The Claude subscription connection is off by default; only its own shots turn it on.
const claudeSubscriptionOff = { type: 'claudeSubscriptionStatus', enabled: false, ready: false, label: '', fixLine: '', cli: '' };
const claudeSubscription = {
  type: 'claudeSubscriptionStatus', enabled: true, ready: true, label: 'Ready', fixLine: '',
  cli: 'Uses Claude Code 2.1.270 at /usr/local/bin/claude.',
};

/** The chats open in this window. */
const CHATS = [
  { id: 's1', number: 1, agentName: 'Tsuru', title: 'Add tide alerts to the station page' },
  { id: 's2', number: 2, agentName: 'Tsuru', title: 'Fix the wind chart legend' },
  { id: 's3', number: 3, agentName: 'Tsuru', title: 'Plan the 2.0 release notes' },
  { id: 's4', number: 4, agentName: 'Tsuru', title: 'Review the buoy data importer' },
];
const sessionList = { type: 'sessionList', sessions: CHATS };

/** The Nest tab: chats on the other two desks. */
function nestRow(id, title, desk, state, minsAgo) {
  return { id, title, desk: desk.id, deskName: desk.name, state, owner: desk.id, lastAt: ago(minsAgo), size: 1000, seq: 1 };
}
const nestIndex = {
  type: 'origami/nestIndex',
  desks: [DESKS.self, DESKS.home, DESKS.travel].map(({ self, ...d }) => d),
  rows: [
    nestRow('n1', 'Nightly import of buoy readings', DESKS.home, 'running', 0),
    nestRow('n2', 'Station map prototype', DESKS.home, 'open', 12),
    nestRow('n3', 'Offline cache for forecasts', DESKS.travel, 'open', 190),
    nestRow('n4', 'Tide table parser tests', DESKS.home, 'closed', 1500),
    nestRow('n5', 'Dark mode for the dashboard', DESKS.travel, 'closed', 2900),
    nestRow('n6', 'Upgrade the chart library', DESKS.home, 'closed', 5800),
  ],
};

module.exports = {
  NOW, MIN, ago, PROJECT, ROOT, DESKS, groupData, nestStorage,
  providerStatus, claudeCodeStatus, claudeSubscription, claudeSubscriptionOff, CHATS, sessionList, nestIndex,
};
