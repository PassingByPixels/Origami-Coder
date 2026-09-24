// Scripted host for the README screenshots. Opens host.html (the real built
// webview bundle, out/webview/chat.js + chat.css) in Chromium, with the globals
// the extension host injects and a stub acquireVsCodeApi. The stub answers the
// webview's requests from a table of canned host messages. All sample data is
// fictional (see fixtures.cjs).
//
// Playwright: set PLAYWRIGHT_CORE to a playwright-core folder if it is not
// resolvable from here, and CHROME_PATH to a Chromium binary if no
// ms-playwright Chromium is installed.
const path = require('node:path');
const fs = require('node:fs');

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_CORE, 'playwright-core', 'playwright'].filter(Boolean);
  for (const t of tries) {
    try { return require(t); } catch { /* next */ }
  }
  throw new Error('playwright-core not found: set PLAYWRIGHT_CORE to its folder');
}

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!fs.existsSync(root)) return undefined;
  const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
  for (const d of dirs) {
    const exe = path.join(root, d, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}

const url = (file) => 'file:///' + path.join(__dirname, file).replace(/\\/g, '/');

const BASE_GLOBALS = {
  __ORIGAMI_VERSION__: '0.4.175',
  __ORIGAMI_SOLO_SESSION__: '',
  __ORIGAMI_MEMORY__: false,
  __ORIGAMI_BOARD__: false,
  __ORIGAMI_RACE_COMPARE__: null,
  __ORIGAMI_REPO_MAP__: null,
  __ORIGAMI_COLLAB__: null,
  __ORIGAMI_REMOTE_ENABLED__: false,
  __ORIGAMI_FLOCK_ENABLED__: false,
  __ORIGAMI_CHAT_BACKDROP__: false,
  __ORIGAMI_CHAT_DENSITY_COMPACT__: false,
  __ORIGAMI_SCHEDULE_TAB__: 'crons',
};

/** Runs in every frame before the bundle: globals, vscode api stub, replies.
 *  In split.html each iframe reads its own entry from cfg.frames by ?pane=. */
function initScript(all) {
  const pane = new URLSearchParams(location.search).get('pane');
  const cfg = pane ? all.frames[pane] : all.single;
  if (!cfg) return;
  for (const [k, v] of Object.entries(cfg.globals)) window[k] = v;
  let state = cfg.state || {};
  window.__sent = [];
  const replies = cfg.responders || {};
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => {
      window.__sent.push(m);
      const out = replies[m && m.type];
      if (!out) return;
      const list = Array.isArray(out) ? out : [out];
      setTimeout(() => {
        for (const r of list) {
          // A reply field set to '$req:<field>' copies that field of the request.
          const msg = { ...r };
          for (const [k, v] of Object.entries(msg)) {
            if (typeof v === 'string' && v.startsWith('$req:')) msg[k] = m[v.slice(5)];
          }
          window.postMessage(msg, '*');
        }
      }, 0);
    },
    getState: () => state,
    setState: (s) => { state = s; },
  });
  // The theme comes from getState ('origami.theme'), as in a real webview.
}

async function launch() {
  const { chromium } = loadPlaywright();
  return chromium.launch({ executablePath: chromePath() });
}

function frameCfg(theme, f) {
  return {
    globals: { ...BASE_GLOBALS, ...(f.globals || {}) },
    state: { 'origami.theme': theme, ...(f.state || {}) },
    responders: f.responders || {},
  };
}

/**
 * Opens one view. view: { theme, width, height, scale, settle, and EITHER
 * globals/state/responders/messages (one webview) OR frames: { side, main }
 * (split.html, each with its own globals/state/responders/messages; sideWidth) }.
 * Returns { ctx, page, errors, frame(name) }.
 */
async function openView(browser, view) {
  const theme = view.theme || 'meadow';
  const ctx = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: view.scale || 1,
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const all = view.frames
    ? { frames: Object.fromEntries(Object.entries(view.frames).map(([k, f]) => [k, frameCfg(theme, f)])) }
    : { single: frameCfg(theme, view) };
  await page.addInitScript(initScript, all);
  if (view.frames) {
    await page.goto(url('split.html'));
    if (view.sideWidth) await page.evaluate((w) => document.body.style.setProperty('--side-w', w + 'px'), view.sideWidth);
  } else {
    await page.goto(url('host.html'));
  }
  const frame = (name) => (name ? page.frame({ name }) : page.mainFrame());
  await page.waitForTimeout(200);
  if (view.frames) {
    for (const [name, f] of Object.entries(view.frames)) await post(frame(name), f.messages || []);
  } else {
    await post(page.mainFrame(), view.messages || []);
  }
  await page.waitForTimeout(view.settle ?? 300);
  return { ctx, page, errors, frame };
}

/** Posts host messages into a frame, in order. */
async function post(frame, messages) {
  for (const m of messages) {
    await frame.evaluate((mm) => window.postMessage(mm, '*'), m);
    await frame.waitForTimeout(15);
  }
}

module.exports = { launch, openView, post, url, BASE_GLOBALS };
