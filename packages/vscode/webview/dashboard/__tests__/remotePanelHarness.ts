// A REAL DashboardPanel, minus the extension host.
//
// The hydration the phone gets is not something these tests may re-describe:
// it is whatever `DashboardPanel.attachView` -> `broadcastModelStatus` +
// `replaySessionsTo` post, in that order, and the ORDER is the bug (the active
// session is named LAST). So the harness builds the real class over its own
// prototype and supplies only the fields those two methods read.
//
// STUBBED ON PURPOSE, and only these:
//   - `renderHtmlFor` — its output is assigned to `webview.html`, which
//     `RemoteView` stores as a byte count and never reads (the phone loads the
//     real bundle from the relay). It pulls in the extension's packageJSON,
//     nonces and a dozen Uri joins for a string nothing under test consumes.
//   - `modelInfo` / `providerStatusCache` — the engine probe's cache, which
//     `broadcastModelStatus` reads. A fixed "online" verdict here keeps the
//     hydration deterministic; what it proves is that modelStatus REACHES the
//     phone, not what it says.
// Everything else on the path — the wiring, the per-session replay, the
// message log, the active-session pointer — is the production code.

import { DashboardPanel } from '../../../src/dashboard/DashboardPanel';
import { PermissionBannerState } from '../../../src/dashboard/permissionBanner';
import { DeltaFanout } from '../../../src/dashboard/deltaFanout';
import { EngineGate } from '../../../src/dashboard/engineGate';

/** The gate of a chat whose engine is UP — every real Session has one (t-v5qn37), and the
 *  panel's session calls wait on it. Ready one microtask after this returns. */
function readyGate(): EngineGate {
  const gate = new EngineGate(() => {});
  void gate.start(() => Promise.resolve());
  return gate;
}

export interface HarnessSession {
  id: string;
  number: number;
  title?: string;
  /** The host's replay log — `replaySessionsTo` sends it as `restoreMessages`. */
  log: Array<{ kind: string; text: string; timestamp: number }>;
}

function session(s: HarnessSession): unknown {
  return {
    id: s.id,
    number: s.number,
    agentName: 'Tsuru',
    title: s.title,
    botGlyph: undefined,
    messageLog: s.log,
    turnBusy: false,
    gate: readyGate(),
    pendingPermissions: new Map(),
    modelWindow: 0,
    modelWindowFor: '',
    client: {
      peerName: undefined,
      // A HOST THAT CAN ACTUALLY APPLY THE WRITE. Without it the panel's
      // `setApproveMode` case threw on a missing method and answered with
      // `postApproveModeFailure` — an unsigned `remote/set-mode` telling the
      // phone to go back to Ask. That was invisible while the page ignored the
      // frame; a page that honours it (modeState.ts) had its YOLO revoked a
      // moment after every tap, so the fixture was testing a broken desktop.
      setConfigOption: () => Promise.resolve(),
      getModelOption: () => undefined,
      getModeOption: () => undefined,
      getEffortOption: () => undefined,
      getPermissionOption: () => undefined,
    },
  };
}

export interface Harness {
  /** The real panel — call `attachView(host, 'chat')` on it. */
  panel: { attachView(host: unknown, bundle: string): void };
  /** Every message the phone sent INTO the host, in order. */
  inbound: unknown[];
  /** Broadcast to every attached view, as a live turn does. */
  stream(msg: object): void;
  /** Add a chat AFTER the first attach, as `newSession` does. */
  addSession(s: HarnessSession): void;
  setActive(id: string): void;
}

export function makePanelHarness(sessions: HarnessSession[], activeId: string): Harness {
  const panel = Object.create(DashboardPanel.prototype) as Record<string, unknown>;
  Object.defineProperty(panel, 'cwd', { value: process.cwd() });
  const map = new Map<string, unknown>();
  for (const s of sessions) map.set(s.id, session(s));
  panel['sessions'] = map;
  panel['activeSessionId'] = activeId;
  panel['pendingQuestionPermissions'] = new Map();
  // The sticky mode banner a successful approve-mode write repaints.
  panel['permBanner'] = new PermissionBannerState();
  panel['viewWiring'] = new Map();
  panel['extraViews'] = [];
  panel['viewSolo'] = new Map();
  // post() routes every message through this (t-tc2rlo #9) — Object.create
  // skips the class's own field initializer, same as every other Map above.
  panel['deltaFanout'] = new DeltaFanout((id) => map.has(id));
  panel['context'] = {
    extensionUri: { fsPath: process.cwd() },
    extension: { packageJSON: { version: 'harness' } },
    globalState: { get: <T>(_k: string, d: T) => d, update: () => Promise.resolve() },
    // The phone's mounted ChatPane posts its own boot messages back (collabs,
    // chat sections); they are not under test, but they must not throw.
    workspaceState: { get: <T>(_k: string, d: T) => d, update: () => Promise.resolve() },
  };
  panel['renderHtmlFor'] = () => '<html>the phone never reads this</html>';
  panel['modelInfo'] = { ok: true, modelId: 'harness-model', contextLength: 128_000, reason: null };
  panel['providerStatusCache'] = new Map();
  panel['panel'] = { webview: { postMessage: () => Promise.resolve(true) } };
  // Record what the phone posts, then let the REAL handler run: the mounted
  // ChatPane boots by asking the host for things (collabs, chat sections) that
  // this harness has no state for, and a throw there would look like a failure
  // of the thing under test.
  //
  // `handleWebviewMessage` is ASYNC, so a throw inside it is a rejected promise
  // and the try/catch below never sees it — it surfaced as an unhandled
  // rejection that failed the whole file (`closeSession` wants a permission
  // banner and a live ACP client, neither of which this panel has). Swallow the
  // rejection too, for the same reason and no wider one: what the harness
  // proves is that a message REACHED the production handler.
  const inbound: unknown[] = [];
  const realHandle = panel['handleWebviewMessage'] as (m: unknown) => unknown;
  panel['handleWebviewMessage'] = function (msg: unknown) {
    inbound.push(msg);
    try {
      const out = realHandle.call(this, msg);
      return out instanceof Promise ? out.catch(() => undefined) : out;
    } catch {
      return undefined;
    }
  };
  return {
    panel: panel as unknown as Harness['panel'],
    inbound,
    stream: (msg) => (panel['post'] as (m: object) => void).call(panel, msg),
    addSession: (s) => void map.set(s.id, session(s)),
    setActive: (id) => void (panel['activeSessionId'] = id),
  };
}
