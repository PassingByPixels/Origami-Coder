// Origami Remote — phone-shell end-to-end proof.
//
// Loads the REAL out/remote/index.html (which loads the REAL out/webview/chat.js)
// in Chromium at 390x844, against a fake in-page relay that speaks the wire
// format from `remote_wire_spec_v1.md`.
//
// The relay's crypto is written INDEPENDENTLY here, from the spec text, not
// imported from webview/remote/crypto.ts. That is the point: a round trip
// against your own encoder proves only that you are self-consistent.
//
// NOT run by any gate — vitest cannot do this. vitest.config.mts sets no
// css:true, so no stylesheet ever reaches the jsdom DOM and every layout
// assertion here would assert nothing. Run it by hand after touching
// webview/remote/*:
//
//   cd packages/vscode && npm run build
//   copy this file into any folder that has Playwright installed, then:
//   ORIGAMI_REPO=<path to this repo's checkout> node remote-phone-e2e.mjs
//   (optional: SHOTS_DIR=<folder for the screenshots>; default is a temp folder)
//
// It caught two defects that were green in all 133 unit tests: the composer
// floating mid-screen (a forced flex layout broke the grid stretch), and an
// opaque PIN backdrop that hid the transcript the user was approving for.
import { chromium } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = process.env.ORIGAMI_REPO;
if (!REPO) {
  console.error('Set ORIGAMI_REPO to the root of an Origami Code checkout (the folder that holds packages/).');
  process.exit(2);
}
const OUT = path.join(REPO, 'packages/vscode/out/remote');
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'origami-remote-phone-e2e');
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

fs.mkdirSync(SHOTS, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.map': 'application/json' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(OUT, rel);
  if (!file.startsWith(path.resolve(OUT)) || !fs.existsSync(file)) {
    res.writeHead(404).end('no');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// --- Ks and the base64url the QR fragment carries -------------------------
const KS = Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 7) & 0xff);
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// --- The recorded hydration ------------------------------------------------
// Shapes lifted from the extension's own sources and test fixtures:
//   modelStatus            src/dashboard/DashboardPanel.ts:5185
//   sessionCreated         src/dashboard/DashboardPanel.ts:5946
//   restoreMessages        src/dashboard/DashboardPanel.ts:5961 (RestoredEntry,
//                          webview/dashboard/panes/chatRestore.ts:19)
//   contextUpdate          src/dashboard/DashboardPanel.ts:5969
//   effortOptions          src/dashboard/configSelectors.ts:53
//   restoreActiveSession   src/dashboard/DashboardPanel.ts:5989
// The order is broadcastModelStatus() then replaySessionsTo(), per attachView.
const TS = 1756800000000;
const HYDRATION = [
  { type: 'modelStatus', sessionId: SID, ok: true, modelName: 'qwen3-coder-30b', contextWindow: 131072, providerLabel: 'LM Studio', providerIsLocal: true, state: 'ready' },
  { type: 'sessionCreated', sessionId: SID, sessionNumber: 1, agentName: 'Tsuru', title: 'remote phone check', agentArt: null, needsSetup: false },
  {
    type: 'restoreMessages',
    sessionId: SID,
    messages: [
      { kind: 'user', text: 'hi who are you', timestamp: TS },
      { kind: 'agent', text: 'I am Tsuru. Reading packages/vscode/webview/remote/shim.ts now.', timestamp: TS + 1000 },
      { kind: 'tool', text: 'read', timestamp: TS + 2000, tool: { call: { name: 'read', args: { path: 'packages/vscode/webview/remote/shim.ts' } }, result: { output: 'installShim(...)' } } },
      { kind: 'agent', text: 'The shim seals every postMessage into a wire frame.', timestamp: TS + 3000 },
    ],
  },
  { type: 'contextUpdate', sessionId: SID, tokensUsed: 4210, contextWindow: 131072 },
  { type: 'effortOptions', current: '', options: [], sessionId: SID },
  { type: 'restoreActiveSession', sessionId: SID },
];

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await ctx.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

// --- The fake relay, installed before any page script runs -----------------
await page.addInitScript(
  ({ ksArr }) => {
    const KSB = new Uint8Array(ksArr);
    const te = new TextEncoder();
    const td = new TextDecoder();
    const buf = (u8) => u8.slice().buffer;

    // Spec, "Keys and ids": HKDF-SHA256, empty salt, the two info strings.
    async function hkdf(info, len) {
      const base = await crypto.subtle.importKey('raw', buf(KSB), 'HKDF', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) }, base, len * 8);
      return new Uint8Array(bits);
    }
    const b64u = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const relay = {
      sent: [],        // messages the phone sealed and sent, opened by us
      sentRaw: [],     // the raw frames, so the test can check the header
      sockets: [],
      desktopSeq: 0,
      ready: null,
    };
    window.__RELAY__ = relay;

    relay.ready = (async () => {
      relay.rid = b64u(await hkdf('origami-remote/v1/rid', 16));
      const raw = await hkdf('origami-remote/v1/key', 32);
      relay.key = await crypto.subtle.importKey('raw', buf(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
    })();

    // Spec, "Frame": AAD = utf8(rid) || header[0..6).
    function aad(header) {
      const r = te.encode(relay.rid);
      const out = new Uint8Array(r.length + 6);
      out.set(r, 0);
      out.set(header.subarray(0, 6), r.length);
      return out;
    }

    // Spec, "Frame": plaintext = uint32BE len || utf8 JSON || zeros to 1024.
    async function seal(role, seq, msg) {
      const body = te.encode(JSON.stringify(msg));
      const total = Math.ceil((4 + body.length) / 1024) * 1024;
      const plain = new Uint8Array(total);
      new DataView(plain.buffer).setUint32(0, body.length, false);
      plain.set(body, 4);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const header = new Uint8Array(18);
      header[0] = 1;
      header[1] = role;
      new DataView(header.buffer).setUint32(2, seq, false);
      header.set(nonce, 6);
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce), additionalData: buf(aad(header)) }, relay.key, buf(plain)));
      const frame = new Uint8Array(18 + ct.length);
      frame.set(header, 0);
      frame.set(ct, 18);
      return frame;
    }

    async function open(frame) {
      if (frame[0] !== 1) throw new Error('version');
      const header = frame.subarray(0, 18);
      const plain = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(header.subarray(6, 18)), additionalData: buf(aad(header)) }, relay.key, buf(frame.subarray(18))),
      );
      const len = new DataView(plain.buffer).getUint32(0, false);
      return { role: header[1], seq: new DataView(frame.buffer, frame.byteOffset).getUint32(2, false), message: JSON.parse(td.decode(plain.subarray(4, 4 + len))) };
    }

    relay.push = async (msg) => {
      const frame = await seal(1, ++relay.desktopSeq, msg);
      for (const s of relay.sockets) s.__deliver(frame);
    };

    class FakeSocket extends EventTarget {
      constructor(url) {
        super();
        this.url = url;
        this.readyState = 0;
        this.binaryType = 'blob';
        relay.sockets.push(this);
        relay.ready.then(() => {
          this.readyState = 1;
          this.onopen && this.onopen({});
        });
      }
      async send(data) {
        const bytes = new Uint8Array(data);
        relay.sentRaw.push([...bytes]);
        try {
          const opened = await open(bytes);
          relay.sent.push(opened);
          // The desktop answers a snapshot request with the hydration replay.
          if (opened.message && opened.message.type === 'remote/snapshot' && window.__HYDRATION__) {
            for (const m of window.__HYDRATION__) await relay.push(m);
          }
        } catch (err) {
          relay.sent.push({ error: String(err) });
        }
      }
      __deliver(frame) {
        const ab = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
        this.onmessage && this.onmessage({ data: ab });
      }
      close() {
        this.readyState = 3;
      }
    }
    FakeSocket.OPEN = 1;
    window.WebSocket = FakeSocket;
  },
  { ksArr: [...KS] },
);

await page.addInitScript(({ h }) => {
  window.__HYDRATION__ = h;
}, { h: HYDRATION });

// The rid the desktop would put in the QR — derived the same way, in node.
const { subtle } = globalThis.crypto;
const hk = await subtle.importKey('raw', KS.slice().buffer, 'HKDF', false, ['deriveBits']);
const ridBits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('origami-remote/v1/rid') }, hk, 128);
const RID = b64url(new Uint8Array(ridBits));

// ===========================================================================
// 1. Pairing: land on the QR URL.
// ===========================================================================
await page.goto(`${BASE}/index.html#v1.${RID}.${b64url(KS)}`);
await page.waitForFunction(() => window.__ORIGAMI_REMOTE_READY__ !== undefined);
await page.evaluate(() => window.__ORIGAMI_REMOTE_READY__);

check('fragment scrubbed from the URL after pairing', !page.url().includes('#'), page.url().replace(BASE, ''));
const stored = await page.evaluate((rid) => localStorage.getItem(`origami-remote/ks/${rid}`), RID);
check('Ks stored in localStorage keyed by rid', stored === b64url(KS));

// ===========================================================================
// 2. Handshake: hello + snapshot, sealed, opened by the relay with Ks.
// ===========================================================================
await page.waitForFunction(() => window.__RELAY__.sent.length >= 2, null, { timeout: 10000 });
const handshake = await page.evaluate(() => window.__RELAY__.sent.map((s) => s.message));
check('phone sends remote/hello first', handshake[0]?.type === 'remote/hello', JSON.stringify(handshake[0]));
check('phone then asks for remote/snapshot', handshake[1]?.type === 'remote/snapshot');
const roles = await page.evaluate(() => window.__RELAY__.sent.map((s) => s.role));
check('every phone frame carries role = 2', roles.every((r) => r === 2), `roles=${roles}`);
const seqs = await page.evaluate(() => window.__RELAY__.sent.map((s) => s.seq));
check('seq strictly increases', seqs.every((s, i) => i === 0 || s > seqs[i - 1]), `seq=${seqs}`);
const url0 = await page.evaluate(() => window.__RELAY__.sockets[0].url);
check('socket url is /r/<rid>?role=phone&after=0', url0.endsWith(`/r/${RID}?role=phone&after=0`), url0);

// ===========================================================================
// 3. The real chat bundle mounts and renders the recorded transcript.
// ===========================================================================
await page.waitForSelector('.row.user', { timeout: 15000 });
await page.waitForSelector('.row.agent', { timeout: 15000 });
const rows = await page.$$eval('.row', (els) => els.map((e) => [e.className.split(' ')[1], (e.querySelector('.text')?.textContent ?? '').slice(0, 60)]));
check('transcript rendered from the recorded hydration', rows.length >= 3, JSON.stringify(rows));
check('user row carries the recorded text', rows.some(([k, t]) => k === 'user' && t.includes('hi who are you')));
check('agent row carries the recorded text', rows.some(([k, t]) => k === 'agent' && t.includes('I am Tsuru')));
check('no "No session" sentinel', (await page.$$('.empty')).length === 0);
check('solo session pinned to the recorded id', (await page.evaluate(() => window.__ORIGAMI_SOLO_SESSION__)) === SID);

// ===========================================================================
// 4. Phone layout at 390x844.
// ===========================================================================
const layout = await page.evaluate(() => {
  const ta = document.querySelector('textarea.input');
  const r = ta?.getBoundingClientRect();
  const cells = document.querySelectorAll('.chat-cell');
  const widest = [...document.querySelectorAll('body *')].reduce((m, e) => Math.max(m, e.getBoundingClientRect().right), 0);
  return {
    docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
    bodyScrollW: document.body.scrollWidth,
    widest: Math.round(widest),
    composer: r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), fontSize: getComputedStyle(ta).fontSize } : null,
    cells: cells.length,
    cellWidth: cells[0] ? Math.round(cells[0].getBoundingClientRect().width) : 0,
    statusVisible: !!document.getElementById('remoteStatus')?.offsetHeight,
    status: document.getElementById('remoteStatus')?.getAttribute('data-state'),
  };
});
check('no horizontal scroll', layout.docScrollW <= layout.docClientW && layout.bodyScrollW <= layout.docClientW, JSON.stringify({ docScrollW: layout.docScrollW, docClientW: layout.docClientW, bodyScrollW: layout.bodyScrollW }));
check('nothing painted past the right edge', layout.widest <= 390, `widest right edge = ${layout.widest}px`);
check('composer visible', !!layout.composer && layout.composer.width > 0, JSON.stringify(layout.composer));
check('composer pinned to the bottom of the 844px viewport', !!layout.composer && layout.composer.bottom <= 844 && layout.composer.bottom > 700, JSON.stringify(layout.composer));
check('composer font >= 16px (no iOS zoom-on-focus)', parseFloat(layout.composer?.fontSize ?? '0') >= 16, layout.composer?.fontSize);
check('single column: exactly one chat cell, full width', layout.cells === 1 && layout.cellWidth >= 360, JSON.stringify({ cells: layout.cells, w: layout.cellWidth }));
check('status strip shows the socket is open', layout.status === 'open', layout.status);

// Feature gates.
const gates = await page.evaluate(() => {
  const pe = (sel) => [...document.querySelectorAll(sel)].map((e) => getComputedStyle(e).pointerEvents);
  const disp = (sel) => [...document.querySelectorAll(sel)].map((e) => getComputedStyle(e).display);
  return {
    toolPath: pe('.tool-path'),
    fileLink: pe('.row .text a.file-link'),
    popout: disp('.tab-popout'),
    exportBtn: disp('.mode-row button[title="Export this conversation as markdown"]'),
    toolCards: document.querySelectorAll('.tool-card').length,
    toolResults: document.querySelectorAll('.tool-result').length,
  };
});
check('tool-path is not tappable', gates.toolPath.length === 0 || gates.toolPath.every((v) => v === 'none'), JSON.stringify(gates.toolPath));
check('file-link is not tappable', gates.fileLink.length === 0 || gates.fileLink.every((v) => v === 'none'), JSON.stringify(gates.fileLink));
check('tab-popout hidden', gates.popout.every((v) => v === 'none'), JSON.stringify(gates.popout));
check('Export hidden', gates.exportBtn.every((v) => v === 'none'), JSON.stringify(gates.exportBtn));
check('tool cards render collapsed', gates.toolCards > 0 && gates.toolResults === 0, JSON.stringify({ cards: gates.toolCards, expanded: gates.toolResults }));

await page.screenshot({ path: path.join(SHOTS, '01-transcript-390x844.png'), fullPage: false });

// ===========================================================================
// 5. Sending from the composer produces a sealed frame the relay can open.
// ===========================================================================
const before = await page.evaluate(() => window.__RELAY__.sent.length);
await page.fill('textarea.input', 'restart the dev server please');
await page.click('button.btn.send');
await page.waitForFunction((n) => window.__RELAY__.sent.length > n, before, { timeout: 10000 });
const sentMsgs = await page.evaluate(() => window.__RELAY__.sent.map((s) => s.message));
const send = sentMsgs.find((m) => m && m.type === 'send');
check('composer send arrives at the relay, sealed, and opens with Ks', !!send && send.text === 'restart the dev server please' && send.sessionId === SID, JSON.stringify(send));
const frameHdr = await page.evaluate(() => {
  const f = window.__RELAY__.sentRaw[window.__RELAY__.sentRaw.length - 1];
  return { version: f[0], role: f[1], len: f.length, allZeroNonce: f.slice(6, 18).every((b) => b === 0) };
});
check('frame header is v1 / role 2 / padded / random nonce', frameHdr.version === 1 && frameHdr.role === 2 && frameHdr.len === 18 + 1024 + 16 && !frameHdr.allZeroNonce, JSON.stringify(frameHdr));
check('frame is under the relay 65,536-byte cap', frameHdr.len <= 65536, `${frameHdr.len} bytes`);
// The user row is drawn locally on send (ChatPane.svelte:617), so it must appear
// without any desktop round-trip.
await page.waitForFunction(() => [...document.querySelectorAll('.row.user .text')].some((e) => e.textContent.includes('restart the dev server')), null, { timeout: 5000 });
check('sent message appears in the transcript', true);
await page.screenshot({ path: path.join(SHOTS, '02-after-send.png') });

// ===========================================================================
// 6. Replay rejection: the desktop re-sends a seq we already accepted.
// ===========================================================================
const rowsBefore = await page.$$eval('.row', (e) => e.length);
await page.evaluate(async () => {
  const r = window.__RELAY__;
  r.desktopSeq = 2; // re-seal at a seq already delivered (sessionCreated's)
  await r.push({ type: 'agentText', sessionId: window.__ORIGAMI_SOLO_SESSION__, text: 'REPLAYED — must not appear' });
});
await page.waitForTimeout(400);
const replayed = await page.$$eval('.row .text', (els) => els.some((e) => e.textContent.includes('REPLAYED')));
check('a replayed seq never reaches the webview', !replayed, `rows ${rowsBefore} -> ${await page.$$eval('.row', (e) => e.length)}`);

// ===========================================================================
// 7. The watch-only line. This page holds no device key, so the desktop drops
//    anything it tries to DO, and the page has to say so — a send that vanishes
//    with the composer clearing is the worst of the two failures.
// ===========================================================================
check('no PIN sheet exists on the page at all', (await page.locator('#pinSheet').count()) === 0);
check('the watch line starts closed', (await page.getAttribute('#remoteWatch', 'data-open')) === null);

const beforeWatch = await page.evaluate(() => window.__RELAY__.sent.length);
await page.evaluate(() => window.acquireVsCodeApi().postMessage({ type: 'send', text: 'ls', sessionId: window.__ORIGAMI_SOLO_SESSION__ }));
await page.waitForSelector('#remoteWatch[data-open="true"]', { timeout: 5000 });
check('the watch line names the app as the way to send', (await page.textContent('#remoteWatch')).includes('Use the app to send or approve'));
// The message is still SENT: the desktop is the one authority on what it acts
// on, and a page that refused locally would be a second copy of that rule.
check('the send still left the page', (await page.evaluate(() => window.__RELAY__.sent.length)) > beforeWatch);
await page.screenshot({ path: path.join(SHOTS, '03-watch-only.png') });

// A DENY is free at every envelope, so it must NOT raise the line.
await page.evaluate(() => window.acquireVsCodeApi().postMessage({ type: 'permission', toolCallId: 'req-1', optionId: null }));
await page.waitForTimeout(200);
check('a deny is not reported as refused', (await page.textContent('#remoteWatch')).includes('Use the app to send or approve'));
await page.screenshot({ path: path.join(SHOTS, '04-deny-allowed.png') });

// ===========================================================================
// 8. Console hygiene + a landscape sanity pass.
// ===========================================================================
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(300);
const landscape = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
check('no horizontal scroll in landscape either', landscape.w <= landscape.c, JSON.stringify(landscape));
await page.screenshot({ path: path.join(SHOTS, '05-landscape.png') });

check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 400));

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
