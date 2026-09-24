// Agent Manager board scenes for the 0.4.175 Marketplace README: Folds, Bots,
// Schedules (Crons + Loops tabs), Settings, Artifacts.
const B = require('../fixtures-board-a.cjs'); // scenes/ -> readme-shots/fixtures-board-a.cjs

function board(viewId, responders, extra) {
  return { height: 820, globals: { __ORIGAMI_BOARD__: true }, state: { 'origami.board.view': viewId }, responders, ...extra };
}

module.exports = [
  // 1. Folds — flock (a.k.a. "Git" board view id 'flock' is AgentManagerPane).
  {
    name: 'folds',
    out: 'images/folds.png',
    view: board('flock', {
      amRequestState: B.amState(),
      requestModels: B.modelOptions,
      requestProviderStatus: B.providerStatus,
      amRepoWorktrees: {
        type: 'amWorktrees', root: '$req:root',
        worktrees: [{ name: 'harbor-weather', branch: 'main', path: '/work/harbor-weather', primary: true, fold: false }],
        branches: ['main'],
      },
    }),
  },

  // 2. Bots — collabagents.
  {
    name: 'bots',
    out: 'images/bots.png',
    view: board('collabagents', {
      listCollabAgentDefs: B.collabAgentDefs,
      requestModels: B.modelOptions,
      requestProviderStatus: B.providerStatus,
      toolsRequest: B.toolsData,
    }),
  },

  // 3. Schedules — Crons tab (default).
  {
    name: 'schedules',
    out: 'images/schedules.png',
    view: board('schedules', {
      listCrons: B.cronsData,
      requestModels: B.modelOptions,
      requestProviderStatus: B.providerStatus,
    }),
  },
  // 3b. Schedules — Loops tab.
  {
    name: 'schedules-loops',
    out: 'images/schedules-loops.png',
    view: board('schedules', { listLoopSchedules: B.loopSchedulesData }, {
      globals: { __ORIGAMI_BOARD__: true, __ORIGAMI_SCHEDULE_TAB__: 'loops' },
    }),
  },

  // 4. Settings.
  {
    name: 'settings',
    out: 'images/settings.png',
    view: board('settings', {
      requestSubagentLimit: B.subagentLimitData,
      requestBrowserViewport: B.browserViewportUpdate,
      requestCacheWarming: B.cacheWarmingData,
      requestChatBackdrop: B.chatBackdropData,
    }, { height: 700 }),
  },

  // 5. Artifacts (README, Harbour theme).
  {
    name: 'artifacts',
    out: 'images/artifacts.png',
    view: board('artifacts', {
      artifactsRequest: B.artifactsData,
      artifactVersionsRequest: B.artifactVersions,
    }, { theme: 'harbour' }),
  },
  // 5b. Artifacts pane, What's-new: one artifact's version list open.
  {
    name: 'artifacts-pane',
    out: 'whats-new/shots/artifacts-pane.png',
    view: { ...board('artifacts', {
      artifactsRequest: B.artifactsData,
      artifactVersionsRequest: B.artifactVersions,
    }), width: 900, height: 700 },
    act: async (page) => {
      await page.click('.af-rowbtn');
      await page.waitForTimeout(200);
    },
    clip: '.af-pane',
  },
];
