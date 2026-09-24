// Origami Remote — the FULL round trip, with no fake anywhere.
//
// remote-phone-e2e.mjs proves the phone shell against a fake in-page relay and
// a hand-written encoder. This one removes both: a real `origami relay` child
// process serves /app AND carries the frames, a real RemoteController runs the
// desktop half in a `bun` child process (remote-desktop-driver.mjs), and real
// Chromium loads the shell from the relay's own /app. Every byte between the
// browser and the extension code crosses a real socket.
//
// NOT run by any gate — it needs Chromium and a Bun on PATH. Run it by hand
// after touching webview/remote/*, src/remote/* or the relay:
//
//   cd packages/vscode && npm run build
//   copy this file and remote-desktop-driver.mjs into a checkout that has
//   Playwright installed (C:/Repos/Origami Folio/origami-webmcp), then:
//   node remote-interop-e2e.mjs
//
// Loopback only (127.0.0.1), ephemeral port, no TLS.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'C:/Repos/Origami Coder/origami-coder.wt/remote-integration';
const VSCODE = `${REPO}/packages/vscode`;
const SHOTS = 'C:/Users/dev/AppData/Local/Temp/claude/c--Users-dev-Desktop-Workspace/86d82c38-23ee-4d0d-87e9-b6a9d26d7537/scratchpad/remote-integration';
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const waitFor = async (pred, what, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

// --- 1. the real relay, serving the real phone shell -----------------------
const relay = spawn('bun', ['run', `${REPO}/packages/engine/src/index.ts`, 'relay', '--port', '0', '--hostname', '127.0.0.1', '--app-dir', `${VSCODE}/out/remote`], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let relayOut = '';
relay.stdout.setEncoding('utf8');
relay.stdout.on('data', (d) => (relayOut += d));
relay.stderr.setEncoding('utf8');
relay.stderr.on('data', (d) => (relayOut += d));
const port = Number((await waitFor(() => /listening on [^:]+:(\d+)/.exec(relayOut), `the relay to listen (${relayOut})`, 30000))[1]);
const BASE = `http://127.0.0.1:${port}`;
check('relay child listening on loopback', port > 0, BASE);
check('relay /healthz answers ok', (await (await fetch(`${BASE}/healthz`)).text()) === 'ok');
check('relay serves the phone shell at /app/', (await fetch(`${BASE}/app/`)).status === 200);

// --- 2. the real desktop, in a bun child process --------------------------
const desk = spawn('bun', ['run', `${VSCODE}/webview/remote/e2e/remote-desktop-driver.mjs`, `ws://127.0.0.1:${port}`], {
  cwd: VSCODE,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const deskIn = [];
const deskStatus = [];
let deskQr = null;
let deskErr = '';
let deskBuf = '';
desk.stdout.setEncoding('utf8');
desk.stdout.on('data', (chunk) => {
  deskBuf += chunk;
  let nl;
  while ((nl = deskBuf.indexOf('\n')) >= 0) {
    const line = deskBuf.slice(0, nl).trim();
    deskBuf = deskBuf.slice(nl + 1);
    if (line.startsWith('QR ')) deskQr = line.slice(3);
    else if (line.startsWith('IN ')) deskIn.push(JSON.parse(line.slice(3)));
    else if (line.startsWith('ST ')) deskStatus.push(line.slice(3));
  }
});
desk.stderr.setEncoding('utf8');
desk.stderr.on('data', (d) => (deskErr += d));
const postToPhone = (msg) => desk.stdin.write(`POST ${JSON.stringify(msg)}\n`);

await waitFor(() => deskQr, `the desktop to publish a QR (stderr: ${deskErr})`, 30000);
check('desktop published a pairing QR on the relay origin', deskQr.startsWith(`${BASE}/app/#v1.`), deskQr.slice(0, 60) + '...');
await waitFor(() => deskStatus.some((s) => s.includes('open')), 'the desktop socket to open');

// --- 3. Chromium loads the shell FROM THE RELAY ---------------------------
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(deskQr);
await page.waitForFunction(() => window.__ORIGAMI_REMOTE_READY__ !== undefined);
await page.evaluate(() => window.__ORIGAMI_REMOTE_READY__);
check('secret fragment scrubbed from the address bar', !page.url().includes('#'), page.url().replace(BASE, ''));

await waitFor(() => deskStatus.some((s) => s.includes('phone paired')), 'the desktop to accept the phone hello');
check('desktop accepted the phone hello over the real relay', true);

// --- 4. the transcript hydrates from the REAL desktop ---------------------
await page.waitForSelector('.row.user', { timeout: 20000 });
await page.waitForSelector('.row.agent', { timeout: 20000 });
const rows = await page.$$eval('.row', (els) => els.map((e) => [e.className.split(' ')[1], (e.querySelector('.text')?.textContent ?? '').slice(0, 60)]));
check('transcript rendered from the desktop hydration', rows.length >= 3, JSON.stringify(rows));
check('user row carries the recorded text', rows.some(([k, t]) => k === 'user' && t.includes('hi who are you')));
check('agent row carries the recorded text', rows.some(([k, t]) => k === 'agent' && t.includes('I am Tsuru')));
check('solo session pinned to the desktop session id', (await page.evaluate(() => window.__ORIGAMI_SOLO_SESSION__)) === SID);
check('status strip shows the relay socket open', (await page.getAttribute('#remoteStatus', 'data-state')) === 'open');
check('no horizontal scroll at 390x844', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
await page.screenshot({ path: path.join(SHOTS, '01-hydrated-from-real-desktop.png') });

// --- 5. THIS PAGE IS A BROWSER, SO IT MAY ONLY WATCH ----------------------
// A relay-served page holds no device key. Since 2026-09-06 the desktop treats
// one as `watch`: the composer send is dropped, and the page says so in one
// line rather than looking as though it worked.
const TEXT = 'restart the dev server please';
await page.fill('textarea.input', TEXT);
await page.click('button.btn.send');
await page.waitForSelector('#remoteWatch[data-open="true"]', { timeout: 15000 });
check('the page says it can only watch', (await page.textContent('#remoteWatch')).includes('Use the app to send or approve'));
await page.waitForTimeout(1500);
check('the send never reached the desktop host', !deskIn.some((m) => m?.type === 'send'), JSON.stringify(deskIn));
await page.screenshot({ path: path.join(SHOTS, '02-watch-only.png') });

// --- 6. it is still ASKED, and its DENY is still honoured -----------------
// Refusing authority is free at every envelope, so the one thing a keyless page
// may do with a permission is say no. There is no PIN sheet: that road is gone.
postToPhone({ type: 'requestPermission', toolCallId: 'tc-e2e', kind: 'execute', title: 'bash', command: 'npm run dev' });
await page.waitForTimeout(750); // let the ask cross the relay and reach the shim
check('no PIN sheet exists on the page at all', (await page.locator('#pinSheet').count()) === 0);

await page.evaluate(() => window.acquireVsCodeApi().postMessage({ type: 'permission', toolCallId: 'tc-e2e', optionId: 'allow' }));
await page.waitForTimeout(1500);
check('an APPROVE from a keyless page never reaches the host', !deskIn.some((m) => m?.type === 'permission'), JSON.stringify(deskIn));
await page.screenshot({ path: path.join(SHOTS, '03-approve-dropped.png') });

await page.evaluate(() => window.acquireVsCodeApi().postMessage({ type: 'permission', toolCallId: 'tc-e2e', optionId: null }));
const denied = await waitFor(() => deskIn.find((m) => m?.type === 'permission'), 'the deny to reach the desktop host');
check('a DENY is honoured', denied.toolCallId === 'tc-e2e' && denied.optionId === null, JSON.stringify(denied));
await page.screenshot({ path: path.join(SHOTS, '04-deny-honoured.png') });

check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 400));

// --- teardown -------------------------------------------------------------
desk.stdin.write('QUIT\n');
await browser.close();
desk.kill();
relay.kill();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
