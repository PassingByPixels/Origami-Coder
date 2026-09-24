// Origami Remote — the DESKTOP half of the browser round trip, as a process.
//
// Run by `bun`, because it imports the extension's real TypeScript modules
// (src/remote/*) rather than a re-implementation of them. The point of the
// round trip is that a real Chromium runs the real phone shell against the
// real desktop code over the real relay, so nothing here may re-derive the
// wire format — it drives RemoteController and nothing else.
//
//   bun run remote-desktop-driver.mjs <ws://host:port>
//
// Protocol on stdio, one JSON-ish line each:
//   stdout  QR <url>            the pairing URL, once
//           IN <json>           a phone message that reached the host seam
//           ST <text>           a controller status line
//   stdin   POST <json>         post this message to the phone
//
// Loopback only. Nothing is written to disk; the pairing lives in a Map.

import { RemoteController } from '../../../src/remote/remoteController';

const [, , relayUrl] = process.argv;
if (!relayUrl) {
  console.error('usage: bun run remote-desktop-driver.mjs <ws://host:port>');
  process.exit(2);
}

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TS = 1756800000000;

// The recorded hydration, shapes lifted from DashboardPanel's own post() calls
// and kept identical to webview/remote/e2e/remote-phone-e2e.mjs so the two
// harnesses are comparing the same transcript.
const HYDRATION = [
  { type: 'modelStatus', sessionId: SID, ok: true, modelName: 'qwen3-coder-30b', contextWindow: 131072, providerLabel: 'LM Studio', providerIsLocal: true, state: 'ready' },
  { type: 'sessionCreated', sessionId: SID, sessionNumber: 1, agentName: 'Tsuru', title: 'remote interop check', agentArt: null, needsSetup: false },
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

const say = (tag, value) => process.stdout.write(`${tag} ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

/** Node's global WebSocket onto the transport's injected socket interface. */
function connect(url) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const shim = {
    binaryType: 'arraybuffer',
    send: (data) => ws.send(data),
    close: (code, reason) => (code === undefined ? ws.close() : ws.close(code, reason)),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.addEventListener('open', () => shim.onopen?.());
  ws.addEventListener('message', (ev) => shim.onmessage?.({ data: ev.data }));
  ws.addEventListener('close', (ev) => shim.onclose?.({ code: ev.code, reason: ev.reason }));
  ws.addEventListener('error', () => shim.onerror?.({}));
  return shim;
}

const store = new Map();
let post = () => {};
let subscription = null;

const controller = new RemoteController({
  config: () => ({ enabled: true, relayUrl, capability: 'full' }),
  secrets: {
    get: (k) => Promise.resolve(store.get(k)),
    store: (k, v) => (store.set(k, v), Promise.resolve()),
    delete: (k) => (store.delete(k), Promise.resolve()),
  },
  deps: { connect, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h) },
  deviceName: 'interop-desktop',
  onStatus: (s) => say('ST', s),
  // Stands in for DashboardPanel.attachView: rewire, then replay what a
  // freshly attached chat view is sent.
  attach: (host) => {
    subscription?.dispose();
    subscription = host.webview.onDidReceiveMessage((m) => say('IN', m));
    post = (m) => void host.webview.postMessage(m);
    for (const m of HYDRATION) void host.webview.postMessage(m);
  },
});

const offer = await controller.pair();
say('QR', offer.qr);

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line.startsWith('POST ')) {
      try {
        post(JSON.parse(line.slice(5)));
      } catch (e) {
        say('ST', `driver: bad POST (${e.message})`);
      }
    } else if (line === 'QUIT') {
      controller.dispose();
      process.exit(0);
    }
  }
});
