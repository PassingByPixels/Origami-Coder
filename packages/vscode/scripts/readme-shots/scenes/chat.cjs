// The chat: the sidebar beside a chat tab (README), and close-ups (What's new).
const F = require('../fixtures.cjs');
const C = require('../fixtures-chat.cjs');

const SIDE_HOST = {
  requestProviderStatus: F.providerStatus,
  requestClaudeCodeStatus: F.claudeCodeStatus,
  requestClaudeSubscriptionStatus: F.claudeSubscriptionOff,
  requestSessions: F.sessionList,
  requestNestIndex: F.nestIndex,
};

/** The chat tab: one solo session, with its own host replies. */
const main = (messages, responders = {}) => ({
  globals: { __ORIGAMI_SOLO_SESSION__: C.SID },
  responders: { ...SIDE_HOST, ...C.repoHost(), ...responders },
  messages,
});

/** README layout: the Origami sidebar beside a chat tab, 960 CSS px in all. */
const split = (chat, side = {}, height = 780) => ({
  height,
  sideWidth: 380,
  frames: {
    side: { responders: { ...SIDE_HOST, ...(side.responders || {}) }, messages: side.messages || [] },
    main: chat,
  },
});

/** What's-new layout: the chat tab alone. */
const solo = (chat, height = 900) => ({ width: 820, height, ...chat });

const branches = { type: 'repoPickerBranches', root: C.ROOT, branches: [{ branch: 'feature/tide-alerts', path: C.ROOT }, { branch: 'main', path: `${C.ROOT}-main` }] };
const tide = [...C.session(), ...C.tideTurn()];
const restoring = [...C.session(), branches, { type: 'historyState', sessionId: C.SID, restoring: true, lazy: true, hasMore: false, cursor: null, total: 1240 }];
const lazyTide = [...tide, branches, { type: 'historyState', sessionId: C.SID, restoring: false, lazy: true, cursor: 'c-40', hasMore: true, total: 186, loadedIds: ['m-answer'] }];
const hits = {
  historySearch: {
    type: 'historySearchResult', sessionId: '$req:sessionId', query: '$req:query', done: true,
    hits: [
      { messageId: 'm-answer', partId: 'p1', role: 'assistant', kind: 'text', toolCallId: null, time: F.ago(1), fromEnd: 0, snippet: 'reads the next high tide with nextHighTide', matchStart: 14, matchLength: 9 },
      { messageId: 'm-old-1', partId: 'p2', role: 'user', kind: 'text', toolCallId: null, time: F.ago(2900), fromEnd: 140, snippet: 'where do we read the high tide from the gauge feed', matchStart: 27, matchLength: 9 },
      { messageId: 'm-old-2', partId: 'p3', role: 'assistant', kind: 'text', toolCallId: null, time: F.ago(3000), fromEnd: 151, snippet: 'the high tide table comes from the gauge importer', matchStart: 4, matchLength: 9 },
    ],
  },
};

/** Opens find (Ctrl+F over the chat), switches to ALL and types a query. */
async function findAll(page, frameName) {
  const f = frameName ? page.frame({ name: frameName }) : page.mainFrame();
  // Focus the chat's frame with a click on empty transcript space, as a reader would.
  const box = await f.locator('.cell-messages').boundingBox();
  await f.locator('.cell-messages').click({ position: { x: box.width - 12, y: box.height - 12 } });
  await page.keyboard.press('Control+f');
  await f.waitForSelector('.cf-input');
  await f.click('.cf-mode');
  await f.fill('.cf-input', 'high tide');
  await page.waitForTimeout(900);
  await page.mouse.move(2, 2);
}

const leave = async (page) => { await page.mouse.move(2, 400); await page.waitForTimeout(400); };

module.exports = [
  // ---- README ----
  { name: 'chat', out: 'images/chat.png', view: split(main([...tide, branches])) },
  {
    name: 'connections',
    out: 'images/connections.png',
    view: split(main(C.session(C.SID, 'New chat', { needsSetup: true }))),
    act: async (page, { frame }) => {
      const f = frame('side');
      await f.click('[aria-label="Add connection"]'); await page.waitForTimeout(300);
      await f.locator('.provider-group-header', { hasText: 'Labs' }).first().click();
      await leave(page);
    },
  },
  {
    name: 'claude-subscription',
    out: 'images/claude-subscription.png',
    view: split(main([...C.session(C.SID, F.CHATS[0].title, {}, C.CLAUDE), ...C.tideTurn(), branches], { requestClaudeSubscriptionStatus: F.claudeSubscription }),
      { responders: { requestClaudeSubscriptionStatus: F.claudeSubscription } }),
    act: async (page, { frame }) => { await frame('side').click('[aria-label="Claude (subscription)"]'); await leave(page); },
  },
  { name: 'loading-crane-readme', out: 'images/loading.png', view: split(main(restoring)) },
  {
    name: 'fork-and-find',
    out: 'images/fork-and-find.png',
    view: split(main(lazyTide, hits)),
    act: async (page) => {
      await findAll(page, 'main');
      await page.frame({ name: 'main' }).hover('[aria-label="Fork chat"]');
      await page.waitForTimeout(900);
    },
  },
  { name: 'artifact-chat', out: 'images/artifact-card.png', view: split(main([...C.session(), ...C.artifactTurn(), branches])) },
  {
    name: 'sub-agents',
    out: 'images/sub-agents.png',
    view: split(main([...C.session(), ...C.subagentTurn(), branches, { type: 'openSubagentDrawer', sessionId: C.SID }])),
    act: async (page, { frame }) => {
      const done = frame('main').locator('text=COMPLETE').first();
      if (await done.count()) { await done.click(); await page.waitForTimeout(300); }
      await leave(page);
    },
  },
  { name: 'first-fold', out: 'images/first-fold.png', view: split(main([...C.session(C.SID, 'New chat', { needsSetup: true }), ...C.firstFold(), branches])) },
  {
    name: 'nest-continued',
    out: 'images/nest-chats.png',
    view: split(main([...tide, branches], { requestNestIndex: C.awayIndex() }), { responders: { requestNestIndex: C.awayIndex() } }),
    act: async (page, { frame }) => { await frame('side').click('button[role="tab"]:has-text("Nest")'); await leave(page); },
  },

  // ---- What's new ----
  { name: 'loading-crane', out: 'whats-new/shots/loading-crane.png', view: solo(main(restoring), 560) },
  {
    name: 'fork-button',
    out: 'whats-new/shots/fork-button.png',
    view: solo(main([...tide, branches])),
    act: async (page) => { await page.hover('[aria-label="Fork chat"]'); await page.waitForTimeout(900); },
    clip: { x: 0, y: 700, width: 820, height: 200 },
  },
  {
    name: 'find-all',
    out: 'whats-new/shots/find-all.png',
    view: solo(main(lazyTide, hits), 700),
    act: (page) => findAll(page),
  },
  { name: 'artifact-card', out: 'whats-new/shots/artifact-card.png', view: solo(main([...C.session(), ...C.artifactTurn(), branches]), 620) },
  {
    name: 'continued-on',
    out: 'whats-new/shots/continued-on.png',
    view: solo(main([...tide, branches], { requestNestIndex: C.awayIndex() }), 700),
  },
];
