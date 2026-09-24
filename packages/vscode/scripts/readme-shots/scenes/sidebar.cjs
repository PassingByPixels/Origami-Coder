// The sidebar: connections, the dock, and the chats (Here | Nest).
const F = require('../fixtures.cjs');

const W = 380;
const sidebar = (height = 560, claude = F.claudeSubscriptionOff) => ({
  width: W,
  height,
  responders: {
    requestProviderStatus: F.providerStatus,
    requestClaudeCodeStatus: F.claudeCodeStatus,
    requestClaudeSubscriptionStatus: claude,
    requestSessions: F.sessionList,
    requestNestIndex: F.nestIndex,
    refreshModelLists: { type: 'modelListsRefreshed', ok: true },
  },
});

module.exports = [
  {
    // Refresh beside Connections, with its tooltip.
    name: 'connections-refresh',
    out: 'whats-new/shots/connections-refresh.png',
    view: sidebar(300),
    act: async (page) => { await page.hover('[aria-label^="Refresh model lists"]'); await page.waitForTimeout(900); },
    clip: { x: 0, y: 0, width: W, height: 150 },
  },
  {
    // The Claude (subscription, experimental) tile opened: its card says Ready.
    name: 'claude-sub-card',
    out: 'whats-new/shots/claude-sub-card.png',
    view: sidebar(420, F.claudeSubscription),
    act: async (page) => { await page.click('[aria-label="Claude (subscription)"]'); await page.mouse.move(2, 400); await page.waitForTimeout(400); },
    clip: { x: 0, y: 0, width: W, height: 230 },
  },
  {
    // Here | Nest with Nest selected: chats on the other desks, running first.
    name: 'nest-tab',
    out: 'whats-new/shots/nest-tab.png',
    view: sidebar(520),
    act: async (page) => { await page.click('button[role="tab"]:has-text("Nest")'); await page.mouse.move(2, 500); await page.waitForTimeout(400); },
  },
];
