// Fictional fixtures for board-b's reference-view scenes: Skills, Tools, MCP,
// Plugins, Insights, Labyrinth, the memory graph and the repo map. All data is
// the same harbor-weather world fixtures.cjs already uses; nothing here reads
// any real user/workspace data.
const path = require('node:path');
const F = require('./fixtures.cjs');

const NOW = F.NOW;
const MIN = F.MIN;
const ago = F.ago;

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
const SKILLS = [
  {
    name: 'tide-data-import', tier: 'base', ownerAgents: [], tags: ['tides', 'data'], immutable: false,
    category: 'Data', location: '.origami/skills/tide-data-import/SKILL.md', scope: 'global',
    description: 'Pull the harbour authority tide CSV and normalize it into src/forecast/tides.ts fixtures.',
    contentPreview: '# Tide data import\n\nDownload the daily CSV from the harbour authority feed, parse the\nhigh/low columns, and write normalized TideReading rows...',
  },
  {
    name: 'release-notes', tier: 'base', ownerAgents: [], tags: ['release', 'changelog'], immutable: false,
    category: 'Release', location: '.origami/skills/release-notes/SKILL.md', scope: 'global',
    description: 'Draft the CHANGELOG entry for a harbor-weather release from the merged PR list.',
  },
  {
    name: 'ui-review', tier: 'optin', ownerAgents: [], tags: ['ui', 'review'], immutable: false,
    category: 'Review', location: '.origami/skills/ui-review/SKILL.md', scope: 'global',
    description: 'Review a chart or dashboard screenshot against the WindChart design checklist before merge.',
  },
  {
    name: 'test-first', tier: 'base', ownerAgents: [], tags: ['testing'], immutable: true,
    category: 'Testing', location: '.origami/skills/test-first/SKILL.md', scope: 'global',
    description: 'Write the failing test for a bug report before touching the fix.',
  },
  {
    name: 'changelog', tier: 'agentspecific', ownerAgents: ['release-bot'], tags: ['release'], immutable: false,
    category: 'Release', location: '.origami/skills/changelog/SKILL.md', scope: 'global',
    description: 'Roll the last release\'s CHANGELOG section into the docs site.',
  },
  {
    name: 'buoy-health-check', tier: 'base', ownerAgents: [], tags: ['stations', 'ops'], immutable: false,
    category: 'Ops', location: '.origami/skills/buoy-health-check/SKILL.md', scope: 'global',
    description: 'Ping every station in src/stations/buoys.ts and report ones that stopped reporting.',
  },
];

function skillsData() {
  return { type: 'skillsData', skills: SKILLS, problems: [], scanRoots: { local: ['.origami/skills'], global: ['~/.origami/skills'] } };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const TOOLS = [
  { id: 'read', description: 'Read a file from the workspace.', deferred: false, disabled: false, source: 'builtin', hardRequired: true },
  { id: 'edit', description: 'Make an exact string replacement in a file.', deferred: false, disabled: false, source: 'builtin', hardRequired: false },
  { id: 'grep', description: 'Search file contents with a regular expression.', deferred: false, disabled: false, source: 'builtin', hardRequired: false },
  { id: 'bash', description: 'Run a shell command.', deferred: false, disabled: false, source: 'builtin', hardRequired: false },
  { id: 'tide_alert_scaffold', description: 'Scaffold a new tide-alert rule file under src/forecast/.', deferred: true, disabled: false, source: 'user-file', location: '.origami/tool/tide_alert_scaffold.ts', hardRequired: false },
  { id: 'buoy_ping', description: 'Ping one weather station and return its last reading.', deferred: true, disabled: false, source: 'user-file', location: '.origami/tool/buoy_ping.ts', hardRequired: false },
  { id: 'deploy_dashboard', description: 'Publish the built dashboard to the staging bucket.', deferred: false, disabled: true, source: 'user-file', location: '.origami/tool/deploy_dashboard.ts', hardRequired: false },
  { id: 'wipe_station_cache', description: 'Clear the cached station readings on disk.', deferred: false, disabled: true, source: 'user-file', location: '.origami/tool/wipe_station_cache.ts', hardRequired: false },
];

function toolsData() {
  return {
    type: 'toolsData', tools: TOOLS, problems: [],
    settings: { enabled: true, mcp: true, defer: ['tide_alert_scaffold', 'buoy_ping'], always: [] },
    subagents: [
      { agent: 'explore', tools: {} },
      { agent: 'general-purpose', tools: {} },
    ],
    codeMode: false,
  };
}

// ---------------------------------------------------------------------------
// MCP + Web MCP
// ---------------------------------------------------------------------------
function mcpData() {
  return {
    type: 'mcpData',
    servers: [
      {
        name: 'docs-search', source: 'config', shadowed: false, type: 'remote', enabled: true,
        url: 'https://docs.harbor-weather.dev/mcp', status: { status: 'connected' }, supportsOAuth: true, auth: 'authenticated',
      },
      {
        name: 'weather-api', source: 'plugin', shadowed: false, type: 'local', enabled: true,
        command: ['node', '.origami/plugins/weather-tools/mcp-server.js'], status: { status: 'connected' }, supportsOAuth: false,
      },
    ],
  };
}
function webmcpData() {
  return { type: 'webmcpData', sites: [{ url: 'https://docs.harbor-weather.dev', name: 'harbor-weather docs', purpose: 'Search the public API reference' }] };
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------
function pluginsData() {
  return {
    type: 'pluginsData',
    plugins: [
      {
        name: 'weather-tools', version: '1.3.0', mode: 'strict', root: '.origami/plugins/weather-tools',
        spec: 'agent-plugins.org/weather-tools@1.3.0', enabled: true,
        skillFiles: ['skills/tide-data-import/SKILL.md', 'skills/buoy-health-check/SKILL.md'],
        mcp: [{ name: 'weather-api', type: 'local', status: { status: 'connected' } }],
        warnings: [],
      },
      {
        name: 'changelog-kit', version: '0.4.1', mode: 'lenient', root: '.origami/plugins/changelog-kit',
        spec: 'agent-plugins.org/changelog-kit@0.4.1', enabled: false,
        skillFiles: ['skills/changelog/SKILL.md'], mcp: [], warnings: ['No maintainer email in the manifest.'],
      },
    ],
    problems: [],
  };
}

// ---------------------------------------------------------------------------
// Insights (instructions + cache + prompt capture)
// ---------------------------------------------------------------------------
function instructionsData() {
  const entries = [
    { path: '.origami/agent/base-prompt.md', source: 'config', chars: 2400, bytes: 2400, tokensApprox: 600 },
    { path: 'AGENTS.md', source: 'project', chars: 3120, bytes: 3120, tokensApprox: 780 },
    { path: '.origami/memory/project_harbor_weather.md', source: 'memory', chars: 1860, bytes: 1860, tokensApprox: 465 },
    { path: '.origami/skills/tide-data-import/SKILL.md', source: 'project', chars: 940, bytes: 940, tokensApprox: 235 },
    { path: 'https://docs.harbor-weather.dev/style-guide', source: 'url', chars: 610, bytes: 610, tokensApprox: 153 },
  ];
  const totalChars = entries.reduce((n, e) => n + e.chars, 0);
  return { type: 'instructionsData', entries, totalChars, totalTokensApprox: Math.round(totalChars / 4), tokensApproxMethod: 'chars/4' };
}
function cacheStatsData() {
  return {
    type: 'cacheStatsData',
    current: { input: 1800, output: 640, cacheRead: 21400, cacheWrite: 2600 },
    lifetime: { input: 96000, output: 38200, cacheRead: 1180000, cacheWrite: 154000 },
    sessionCount: 42,
  };
}
function promptCaptureData() {
  return {
    type: 'promptCaptureData',
    error: null,
    capture: {
      capturedAt: '14:32:08', model: 'qwen3-coder-30b', tokensApproxMethod: 'chars/4',
      labeledParts: [
        { label: 'base-or-agent-prompt', chars: 2400, tokensApprox: 600, delivery: 'system', text: 'You are Origami, working in the harbor-weather workspace...' },
        { label: 'instructions', chars: 3120, tokensApprox: 780, delivery: 'system', text: '# harbor-weather\n\nA small TypeScript weather dashboard...' },
        { label: 'user-system', chars: 480, tokensApprox: 120, delivery: 'tail', text: 'Remember: tide alert thresholds live in src/forecast/tides.ts, not the UI layer.' },
      ],
      finalSystem: [
        { chars: 5520, tokensApprox: 1380, text: '[combined system block 1 — base prompt + instructions]' },
        { chars: 480, tokensApprox: 120, text: '[combined system block 2 — memory tail]' },
      ],
      tools: [
        { name: 'read', descriptionChars: 62, schemaBytes: 210, description: 'Read a file from the workspace.' },
        { name: 'edit', descriptionChars: 118, schemaBytes: 340, description: 'Make an exact string replacement in a file.' },
        { name: 'grep', descriptionChars: 96, schemaBytes: 410, description: 'Search file contents with a regular expression.' },
        { name: 'bash', descriptionChars: 74, schemaBytes: 260, description: 'Run a shell command.' },
        { name: 'buoy_ping', descriptionChars: 88, schemaBytes: 0, description: 'Ping one weather station and return its last reading.' },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Labyrinth
// ---------------------------------------------------------------------------
const RUNS = [
  { sessionId: 'run-tide-alerts', title: 'Add tide alerts to the station page', folder: 'harbor-weather', cwd: F.ROOT, updatedAt: new Date(ago(40)).toISOString(), kind: 'origami' },
  { sessionId: 'run-buoy-outage', title: 'Investigate buoy-14 going silent', folder: 'harbor-weather', cwd: F.ROOT, updatedAt: new Date(ago(180)).toISOString(), kind: 'origami' },
  { sessionId: 'run-windchart-fix', title: 'Fix WindChart legend overlap on narrow screens', folder: 'harbor-weather', cwd: F.ROOT, updatedAt: new Date(ago(1440)).toISOString(), kind: 'origami' },
];

function historyList() { return { type: 'historyList', sessions: RUNS }; }

function runStatsData() {
  return {
    type: 'runStatsData',
    stats: [
      { sessionId: 'run-tide-alerts', requests: 18, tokens: { input: 4200, cacheRead: 96000 } },
      { sessionId: 'run-buoy-outage', requests: 26, tokens: { input: 12400, cacheRead: 118000 } },
      { sessionId: 'run-windchart-fix', requests: 11, tokens: { input: 3100, cacheRead: 41000 } },
    ],
  };
}

function labyrinthColumns() { return { type: 'labyrinthColumns', indexWidthPx: 300, inspectWidthPx: 340, inspectCollapsed: false }; }
function labyrinthPrices() { return { type: 'labyrinthPrices', prices: { 'qwen3-coder-30b': { in: 0.3, out: 0.9 }, 'gpt-5-mini': { in: 0.25, out: 2 } } }; }

/** Steps for run-tide-alerts. `tokens.cache` is the numeric read/write ledger;
 *  the top-level `cache` field is the ENGINE-recorded fact for that step —
 *  present (with no `cause`) on a hit, and with a `cause` on a miss. Ordinal 0
 *  is a `cold` miss, 3 a `model` miss, 7 a `compaction` miss (right after the
 *  ordinal-6 compaction event) and 9 an `idle` miss — the causes the 0.4.160
 *  changelog calls out for the Flight cache panel, plus two clean hits (5, 8)
 *  so the run does not read as cache permanently broken. */
const MODEL = 'qwen3-coder-30b';
const TIDE_STEPS = [
  { kind: 'prompt', ordinal: 0, title: 'Add tide alerts to the station page', startedAt: ago(38), model: MODEL, tokens: { input: 4200, output: 0, cache: { read: 0, write: 4200 } }, cache: { cause: 'cold' } },
  { kind: 'reply', ordinal: 1, title: 'Plan: read tides.ts, add threshold check, wire buoys.ts', startedAt: ago(37), endedAt: ago(37), durationMs: 1800, model: MODEL, tokens: { input: 0, output: 210, cache: { read: 4100, write: 0 } } },
  { kind: 'tool', tool: 'read', ordinal: 2, title: 'src/forecast/tides.ts', startedAt: ago(37), endedAt: ago(37), durationMs: 90, tokens: { input: 0, output: 0, cache: { read: 4300, write: 0 } } },
  { kind: 'tool', tool: 'edit', ordinal: 3, title: 'src/forecast/tides.ts — add TideAlertRule', startedAt: ago(36), endedAt: ago(36), durationMs: 140, model: 'gpt-5-mini', tokens: { input: 1600, output: 40, cache: { read: 0, write: 1600 } }, cache: { cause: 'model' } },
  { kind: 'tool', tool: 'grep', ordinal: 4, title: 'buoys.ts usages of TideReading', startedAt: ago(35), endedAt: ago(35), durationMs: 60, tokens: { input: 0, output: 0, cache: { read: 5200, write: 0 } } },
  // depth 0: the spawn call itself sits on the trunk — branchModel() opens its
  // OWN branch column for a `kind: 'subagent'` step; giving it depth > 0 too
  // double-opens a branch at the same index (a Svelte each_key_duplicate).
  { kind: 'subagent', ordinal: 5, agent: 'explore', title: 'Locate every WindChart tide prop', startedAt: ago(34), endedAt: ago(33), durationMs: 32000, model: MODEL, tokens: { input: 2100, output: 340, cache: { read: 2000, write: 100 } }, cache: {} },
  { kind: 'compaction', ordinal: 6, title: 'Context compacted', startedAt: ago(32), compaction: { trigger: 'auto', contextBefore: 118000, summaryTokens: 2200 } },
  { kind: 'tool', tool: 'edit', ordinal: 7, title: 'src/stations/buoys.ts — emit tide alert event', startedAt: ago(31), endedAt: ago(31), durationMs: 120, model: MODEL, tokens: { input: 2600, output: 60, cache: { read: 0, write: 2600 } }, cache: { cause: 'compaction' } },
  { kind: 'tool', tool: 'bash', ordinal: 8, title: 'npm test -- tides', startedAt: ago(30), endedAt: ago(30), durationMs: 4200, model: MODEL, tokens: { input: 1200, output: 0, cache: { read: 1200, write: 0 } }, cache: {} },
  { kind: 'reply', ordinal: 9, title: 'Resumed after a break', startedAt: ago(6), endedAt: ago(6), durationMs: 900, model: MODEL, tokens: { input: 3400, output: 180, cache: { read: 0, write: 3400 } }, cache: { cause: 'idle', idleMs: 24 * 60 * 1000, ttlSeconds: 300 } },
  { kind: 'reply', ordinal: 10, title: 'Tide alerts wired end to end; tests green', startedAt: ago(5), endedAt: ago(5), durationMs: 600, model: MODEL, tokens: { input: 0, output: 260, cache: { read: 9800, write: 0 } } },
];

// Every step names its agent and (except a compaction) its model, as the engine records them;
// without them Labyrinth groups the spend under "unknown".
const STEPS = TIDE_STEPS.map((st) => ({ agent: 'build', ...(st.kind === 'compaction' || st.model ? {} : { model: MODEL }), ...st }));

function runStepsData(sessionId) {
  return { type: 'runStepsData', sessionId, steps: STEPS, members: [], truncated: false, total: STEPS.length, error: null };
}

// ---------------------------------------------------------------------------
// Memory graph
// ---------------------------------------------------------------------------
const WIKI_PAGES = [
  { id: 'project_harbor_weather', title: 'harbor-weather', namespace: 'projects', updated: new Date(ago(60)).toISOString(), snippet: 'Small TypeScript weather dashboard: tides, buoy stations, a wind chart.', tags: ['weather', 'dashboard'], content: 'Small TypeScript weather dashboard.', links: ['tide_alerts', 'station_health'] },
  { id: 'tide_alerts', title: 'Tide alert thresholds', namespace: 'wiki', updated: new Date(ago(70)).toISOString(), snippet: 'Where tide-alert thresholds live and how they are tuned.', tags: ['tides', 'alerts'], content: 'Thresholds live in src/forecast/tides.ts.', links: ['project_harbor_weather', 'windchart_legend'] },
  { id: 'station_health', title: 'Buoy station health checks', namespace: 'wiki', updated: new Date(ago(90)).toISOString(), snippet: 'How the buoy-health-check skill pings every station.', tags: ['stations', 'ops'], content: 'Pings every station in buoys.ts.', links: ['project_harbor_weather', 'buoy_outage_2026_08'] },
  { id: 'buoy_outage_2026_08', title: 'Buoy-14 outage, August', namespace: 'wiki', updated: new Date(ago(200)).toISOString(), snippet: 'Buoy 14 stopped reporting for six hours; root cause was a firmware clock drift.', tags: ['stations', 'incident'], content: 'Root cause: firmware clock drift.', links: ['station_health'] },
  { id: 'windchart_legend', title: 'WindChart legend layout', namespace: 'wiki', updated: new Date(ago(30)).toISOString(), snippet: 'Legend overlap on narrow screens and the fix.', tags: ['ui', 'charts'], content: 'Legend now wraps under 480px.', links: ['tide_alerts', 'ui_review_checklist'] },
  { id: 'ui_review_checklist', title: 'UI review checklist', namespace: 'wiki', updated: new Date(ago(45)).toISOString(), snippet: 'What the ui-review skill checks before a chart merges.', tags: ['ui', 'review'], content: 'Contrast, legend wrap, empty states.', links: ['windchart_legend'] },
  { id: 'release_process', title: 'Release process', namespace: 'wiki', updated: new Date(ago(15)).toISOString(), snippet: 'Cutting a harbor-weather release and writing the changelog.', tags: ['release'], content: 'Tag, changelog, publish.', links: ['project_harbor_weather'] },
  { id: 'forecast_pipeline', title: 'Forecast pipeline', namespace: 'wiki', updated: new Date(ago(100)).toISOString(), snippet: 'How raw station readings become a forecast.', tags: ['forecast', 'data'], content: 'Buoy readings -> smoothing -> forecast.', links: ['station_health', 'tide_alerts'] },
  { id: 'api_docs_site', title: 'Public API docs site', namespace: 'wiki', updated: new Date(ago(50)).toISOString(), snippet: 'docs-search MCP server indexes this site.', tags: ['docs', 'mcp'], content: 'https://docs.harbor-weather.dev', links: ['project_harbor_weather'] },
  { id: 'onboarding', title: 'New contributor onboarding', namespace: 'wiki', updated: new Date(ago(20)).toISOString(), snippet: 'Local setup for harbor-weather.', tags: ['onboarding'], content: 'npm install, npm run dev.', links: ['project_harbor_weather'] },
  { id: 'test_strategy', title: 'Test strategy', namespace: 'wiki', updated: new Date(ago(65)).toISOString(), snippet: 'Unit tests for forecast math, integration tests for the station feed.', tags: ['testing'], content: 'Vitest + one integration suite.', links: ['forecast_pipeline'] },
  { id: 'incident_response', title: 'Incident response', namespace: 'wiki', updated: new Date(ago(210)).toISOString(), snippet: 'Steps for a station-outage incident.', tags: ['ops', 'incident'], content: 'Page on-call, check buoy_outage log.', links: ['buoy_outage_2026_08'] },
  { id: 'design_tokens', title: 'Chart design tokens', namespace: 'wiki', updated: new Date(ago(80)).toISOString(), snippet: 'Colour + spacing tokens shared across charts.', tags: ['ui'], content: 'og-chat, og-warning, og-accent.', links: ['windchart_legend'] },
  { id: 'data_retention', title: 'Station data retention', namespace: 'wiki', updated: new Date(ago(120)).toISOString(), snippet: 'How long raw buoy readings are kept.', tags: ['data', 'ops'], content: '90 days raw, 2 years aggregated.', links: ['forecast_pipeline'] },
  { id: 'mobile_app_notes', title: 'Mobile companion notes', namespace: 'wiki', updated: new Date(ago(25)).toISOString(), snippet: 'Early notes on a mobile tide-alert companion.', tags: ['mobile', 'ideas'], content: 'Push notification on threshold cross.', links: ['tide_alerts'] },
  { id: 'perf_notes', title: 'Dashboard load performance', namespace: 'wiki', updated: new Date(ago(55)).toISOString(), snippet: 'Why the dashboard first paint was slow and the fix.', tags: ['performance', 'ui'], content: 'Lazy-load the chart bundle.', links: ['windchart_legend'] },
  { id: 'station_naming', title: 'Station naming convention', namespace: 'wiki', updated: new Date(ago(140)).toISOString(), snippet: 'buoy-<n> naming for new stations.', tags: ['stations', 'convention'], content: 'buoy-01 through buoy-24.', links: ['station_health'] },
];

function workspaceData() { return { type: 'workspaceData', data: { wikiPages: WIKI_PAGES } }; }

// ---------------------------------------------------------------------------
// Repo map — the REAL layoutMap() from src/dashboard/agentManager/isoLayout.ts,
// built on the fly with esbuild (already a project devDependency) so the
// geometry is the production algorithm's output, not a hand-rolled guess.
// ---------------------------------------------------------------------------
function buildLayoutMap() {
  const esbuild = require('esbuild');
  const entry = path.join(__dirname, '..', '..', 'src', 'dashboard', 'agentManager', 'isoLayout.ts');
  const result = esbuild.buildSync({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['vscode'],
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', '__dirname', result.outputFiles[0].text)(mod, mod.exports, require, path.dirname(entry));
  return mod.exports.layoutMap;
}

const REPO_MAP = {
  version: 2,
  builtAt: { sha: 'a1b2c3d4e5f60718', branch: 'main', at: NOW - 3 * 24 * 60 * MIN },
  name: 'harbor-weather',
  summary: 'A small TypeScript weather dashboard: tide forecasts, buoy station health, and a wind chart UI.',
  nodes: [
    { id: 'cli', name: 'dev CLI', pillar: 1, kind: 'entrypoint', path: 'src/cli.ts', summary: 'npm run dev entry point' },
    { id: 'api', name: 'Forecast API', pillar: 1, kind: 'endpoint', path: 'src/api/forecast.ts', summary: 'HTTP endpoint the dashboard polls' },
    { id: 'tides', name: 'Tide forecaster', pillar: 2, kind: 'service', path: 'src/forecast/tides.ts', summary: 'Computes tide predictions and alert thresholds' },
    { id: 'buoys', name: 'Buoy station feed', pillar: 2, kind: 'service', path: 'src/stations/buoys.ts', summary: 'Polls each station and normalizes readings' },
    { id: 'smoothing', name: 'Reading smoother', pillar: 2, kind: 'processor', path: 'src/forecast/smoothing.ts', summary: 'Smooths noisy station readings before forecasting' },
    { id: 'schema', name: 'Reading schema gate', pillar: 3, kind: 'validator', path: 'src/stations/schema.ts', summary: 'Rejects a malformed station reading before it reaches storage' },
    { id: 'alertRules', name: 'Alert rule check', pillar: 3, kind: 'validator', path: 'src/forecast/alertRules.ts', summary: 'Confirms a tide alert crosses its configured threshold' },
    { id: 'db', name: 'Reading store', pillar: 4, kind: 'database', path: 'src/db/readings.ts', summary: 'SQLite store for station readings', section: 'Storage' },
    { id: 'stationApi', name: 'Harbour authority feed', pillar: 4, kind: 'external', summary: 'Third-party tide-table API the forecaster calls', section: 'External' },
    { id: 'windchart', name: 'WindChart', pillar: 5, kind: 'ui', path: 'src/ui/WindChart.tsx', summary: 'Renders wind speed + direction over time', section: 'UI' },
    { id: 'dashboardBuild', name: 'Dashboard bundle', pillar: 5, kind: 'build', summary: 'Vite production build of the dashboard', section: 'Output' },
    { id: 'stationPage', name: 'Station status page', pillar: 5, kind: 'ui', path: 'src/ui/StationPage.tsx', summary: 'Shows every buoy and its last reading', section: 'UI' },
  ],
  edges: [
    { from: 'cli', to: 'api', label: 'serves' },
    { from: 'api', to: 'tides', label: 'calls' },
    { from: 'api', to: 'buoys', label: 'calls' },
    { from: 'buoys', to: 'schema', label: 'validates via' },
    { from: 'buoys', to: 'smoothing', label: 'feeds' },
    { from: 'smoothing', to: 'db', label: 'writes' },
    { from: 'tides', to: 'alertRules', label: 'checks via' },
    { from: 'tides', to: 'stationApi', label: 'fetches from' },
    { from: 'tides', to: 'db', label: 'reads' },
    { from: 'windchart', to: 'api', label: 'polls' },
    { from: 'stationPage', to: 'api', label: 'polls' },
    { from: 'dashboardBuild', to: 'windchart', label: 'bundles' },
    { from: 'dashboardBuild', to: 'stationPage', label: 'bundles' },
  ],
  flows: [
    {
      id: 'tide-alert', name: 'Tide alert crosses threshold', description: 'A fetched tide reading becomes a station-page alert.',
      steps: [
        { node: 'cli', note: 'dev server starts' },
        { node: 'tides', note: 'fetches the next tide table' },
        { node: 'stationApi', note: 'harbour authority responds' },
        { node: 'alertRules', note: 'checks the configured threshold' },
        { node: 'stationPage', note: 'shows the alert' },
      ],
    },
    {
      id: 'station-reading', name: 'Station reading to chart', description: 'A buoy reading is validated, smoothed, stored and charted.',
      steps: [
        { node: 'buoys', note: 'polls the station' },
        { node: 'schema', note: 'rejects a malformed reading' },
        { node: 'smoothing', note: 'smooths the series' },
        { node: 'db', note: 'writes the reading' },
        { node: 'windchart', note: 'renders it' },
      ],
    },
  ],
  keyFiles: [
    { path: 'src/forecast/tides.ts', why: 'the only place a tide-alert threshold is evaluated' },
    { path: 'src/stations/schema.ts', why: 'the one gate a malformed station reading cannot pass' },
  ],
  conventions: ['one API endpoint per data source', 'validators live beside the service they gate'],
};

module.exports = {
  skillsData, toolsData, mcpData, webmcpData, pluginsData,
  instructionsData, cacheStatsData, promptCaptureData,
  historyList, runStatsData, labyrinthColumns, labyrinthPrices, runStepsData, RUNS,
  workspaceData, WIKI_PAGES,
  buildLayoutMap, REPO_MAP,
};
