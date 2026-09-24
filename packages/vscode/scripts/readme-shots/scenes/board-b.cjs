// Reference-view scenes for the 0.4.175 Marketplace README: Skills, Tools,
// MCP, Plugins, Insights, Labyrinth, the memory graph and the repo map. All
// sample data is the fictional harbor-weather world (fixtures.cjs +
// fixtures-board-b.cjs) — nothing here reads any real workspace or user data.
const F = require('../fixtures.cjs');
const B = require('../fixtures-board-b.cjs');

/** One Agents-board view, same pattern as scenes/nests.cjs. */
const board = (viewId, responders, extra = {}) => ({
  height: 800,
  globals: { __ORIGAMI_BOARD__: true },
  state: { 'origami.board.view': viewId },
  responders,
  ...extra,
});

const layoutMap = B.buildLayoutMap();

module.exports = [
  // --- Skills ---------------------------------------------------------
  {
    name: 'skills',
    out: 'images/skills.png',
    view: board('skills', { listSkills: B.skillsData() }),
    act: async (page) => {
      await page.locator('.skill-card', { hasText: 'tide-data-import' }).first().click();
    },
    wait: 300,
  },

  // --- Tools ------------------------------------------------------------
  {
    name: 'tools',
    out: 'images/tools.png',
    view: board('tools', { toolsRequest: B.toolsData() }),
  },

  // --- MCP ----------------------------------------------------------------
  {
    name: 'mcp',
    out: 'images/mcp.png',
    view: board('mcp', { mcpRequest: B.mcpData(), webmcpRequest: B.webmcpData() }),
  },

  // --- Plugins ----------------------------------------------------------
  {
    name: 'plugins',
    out: 'images/plugins.png',
    view: board('plugins', { pluginsRequest: B.pluginsData() }),
  },

  // --- Insights -----------------------------------------------------------
  {
    name: 'insights',
    out: 'images/insights.png',
    view: board('instructions', {
      listInstructions: B.instructionsData(),
      promptCapture: B.promptCaptureData(),
      cacheStats: B.cacheStatsData(),
    }, { height: 820 }),
  },
  {
    name: 'insights-payload',
    out: 'images/insights-payload.png',
    view: board('instructions', {
      listInstructions: B.instructionsData(),
      promptCapture: B.promptCaptureData(),
      cacheStats: B.cacheStatsData(),
    }, { height: 900 }),
    act: async (page) => {
      // Expand the first assembled part and one tool's schema row, then bring
      // "What the model actually received" fully into view.
      const lists = page.locator('.pc-list');
      await lists.nth(0).locator('.pc-row-head').first().click();
      await lists.nth(2).locator('.pc-row-head', { hasText: 'edit' }).click();
      await page.locator('.pc-block').scrollIntoViewIfNeeded();
    },
    wait: 300,
  },

  // --- Labyrinth ------------------------------------------------------
  {
    name: 'labyrinth',
    out: 'images/labyrinth.png',
    view: board('labyrinth', {
      requestHistory: B.historyList(),
      requestRunStats: B.runStatsData(),
      // A narrower index rail so the thread map gets enough width to draw
      // without needing a horizontal scroll the screenshot can't show.
      requestLabyrinthColumns: { type: 'labyrinthColumns', indexWidthPx: 240, inspectWidthPx: null, inspectCollapsed: true },
      requestLabyrinthPrices: B.labyrinthPrices(),
      requestRunSteps: { ...B.runStepsData('$req:sessionId'), sessionId: '$req:sessionId' },
    }),
    act: async (page) => {
      await page.locator('button.lab-run', { hasText: 'Add tide alerts' }).first().click();
      await page.waitForTimeout(400);
      // Fit scales the drawing to the available width instead of scrolling it.
      await page.locator('.lab-toggle', { hasText: 'Fit' }).click();
      await page.waitForTimeout(200);
      await page.locator('g.node').nth(3).click();
      await page.mouse.move(700, 1100);
    },
    wait: 300,
  },
  {
    name: 'labyrinth-causes',
    out: 'whats-new/shots/labyrinth-causes.png',
    view: {
      ...board('labyrinth', {
        requestHistory: B.historyList(),
        requestRunStats: B.runStatsData(),
        // Narrower index rail + inspector collapsed from the start: at 900px
        // wide with the default column widths, the toolbar's own buttons
        // overflow into the inspector column's stacking area and a click
        // meant for a toolbar button lands on the inspector's empty state
        // instead (a real layout squeeze — see report).
        requestLabyrinthColumns: { type: 'labyrinthColumns', indexWidthPx: 180, inspectWidthPx: null, inspectCollapsed: true },
        requestLabyrinthPrices: B.labyrinthPrices(),
        requestRunSteps: { ...B.runStepsData('$req:sessionId'), sessionId: '$req:sessionId' },
      }, { height: 700 }),
      width: 900,
    },
    act: async (page) => {
      await page.locator('button.lab-run', { hasText: 'Add tide alerts' }).first().click();
      await page.waitForTimeout(400);
      await page.locator('.lab-mode', { hasText: 'Flight' }).click();
      await page.waitForTimeout(300);
    },
    wait: 300,
    clip: '.fl-cache',
  },

  // --- Memory graph (editor tab) ---------------------------------------
  {
    name: 'memory-graph',
    out: 'images/memory-graph.png',
    view: {
      height: 800,
      globals: { __ORIGAMI_MEMORY__: true },
      responders: { requestWorkspaceData: B.workspaceData() },
      settle: 500,
    },
    act: async (page) => {
      // Let the force-directed layout settle (SETTLE_ITERS = 300 rAF frames).
      await page.waitForTimeout(5500);
      // Fit the whole settled cloud into view before opening a page — the
      // spiral seed spreads nodes wider than the canvas as they repel apart.
      await page.locator('.zoom-btn', { hasText: '⌂' }).click();
      await page.waitForTimeout(200);
      await page.fill('.search-input', 'Tide alert thresholds');
      await page.locator('.search-card').first().click();
      // Clear the query: `selectedResult` (the open preview) is independent of
      // it, but a non-empty query hides every node that doesn't match — the
      // full settled graph is the point of this shot, not the search filter.
      await page.fill('.search-input', '');
      await page.waitForTimeout(300);
    },
    wait: 300,
  },

  // --- Repo map (editor tab) --------------------------------------------
  {
    name: 'repo-map',
    out: 'images/repo-map.png',
    view: {
      height: 820,
      globals: {
        __ORIGAMI_REPO_MAP__: { root: '/work/harbor-weather', name: 'harbor-weather', map: B.REPO_MAP, layout: layoutMap(B.REPO_MAP) },
      },
    },
    act: async (page) => {
      // Pick a box, then move the pointer off the map so its hover card closes.
      await page.locator('g.node').first().click();
      await page.mouse.move(470, 790);
      await page.waitForTimeout(300);
    },
    wait: 300,
  },
];
