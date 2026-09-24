// THE COST OF A RECONNECT.
//
// A phone that reconnected used to be served every open chat's WHOLE
// transcript, three times per socket, plus the model catalogue and the activity
// feed. Three chats of a working day is 256,575 bytes of JSON before the
// envelope, and the relay's 2 MiB/min limiter cut the socket — so the phone
// reconnected, and paid it again.
//
// This file measures both halves of the answer with the REAL sealer:
//   1. the remote replay is a compressed TAIL, under 60 KB sealed for 3 chats;
//   2. the SIDEBAR replay is untouched — asserted against a fixture captured
//      from the tree before the change, message for message.
//
// COMPRESSION IS DECLARED, NOT ASSUMED (`src/remote/phoneCaps.ts`). A page with
// no arm for `restoreMessagesZ` ignores it and paints an EMPTY transcript over
// the owner's chat, and the shipped iOS app carries its own copy of the phone
// web layer — so the envelope is sent ONLY to a phone whose `remote/hello`
// named `restoreZ`, and every other phone gets the plain 80-row tail. Both
// roads are measured here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

vi.mock('vscode', () => ({
  Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.join('/') }) },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: <T>(_k: string, d: T) => d, inspect: () => undefined }),
  },
  window: { activeTextEditor: undefined },
}));

// broadcastModelStatus's `engineUrl` is `resolveEngineUrl() ?? settings.apiBase`
// (DashboardPanel.ts:5001). resolveEngineUrl() reads process.env.ORIGAMI_API_BASE
// directly, and settings.apiBase comes from WorkspaceReader's readSettings(), which
// reads ~/.origami/settings.toml straight off disk. This suite must never take its
// answer from either — the fixture below is a golden capture and has to be
// deterministic on every machine, not just one whose env var or settings.toml
// happens to hold the value it was captured against. node:os is redirected to a
// home no settings.toml lives under; node:fs is redirected only for a path ending
// in settings.toml, and answers with the fixture's own engineUrl (192.0.2.10) so
// the SAME code path (the apiBase fallback) is still exercised.
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => 'C:/fakehome-remote-hydrate' };
});
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const isSettingsToml = (p: unknown) => String(p).endsWith('settings.toml');
  return {
    ...actual,
    existsSync: ((p: unknown) => (isSettingsToml(p) ? true : actual.existsSync(p as never))) as typeof actual.existsSync,
    readFileSync: ((p: unknown, enc?: unknown) =>
      isSettingsToml(p) ? 'api_base = "http://192.0.2.10:1234/v1"\n' : actual.readFileSync(p as never, enc as never)) as typeof actual.readFileSync,
  };
});

import { RemoteView } from '../../../src/remote/remoteView';
import { RESTORE_Z_CAP, helloCaps, markCaps, remoteAcceptsZ } from '../../../src/remote/phoneCaps';
import { OutboundPipe } from '../../../src/remote/pipes';
import { deriveKey } from '../../../src/remote/crypto';
import { desktopCodec, registerRemoteSeq, resetRemoteSeq, type SeqMemento } from '../../../src/remote/seqStore';
import {
  REMOTE_TAIL_MESSAGES,
  REMOTE_TOOL_CONTENT_CHARS,
  remoteTail,
} from '../../../src/remote/remoteTranscript';
import { expandRestore } from '../../remote/inflate';
import { makePanelHarness, type HarnessSession } from './remotePanelHarness';

// resolveEngineUrl() checks this env var BEFORE settings.apiBase, so a host that
// happens to export it (a real local engine setup) would otherwise override the
// node:fs fixture above and reintroduce the same non-determinism from the other
// side. Cleared for every test here, restored after, same as the CLAUDE_CONFIG_DIR
// isolation claudeProjects.test.ts already does for its own env seam.
const savedApiBase = process.env.ORIGAMI_API_BASE;
beforeEach(() => { delete process.env.ORIGAMI_API_BASE; });
afterEach(() => {
  if (savedApiBase === undefined) delete process.env.ORIGAMI_API_BASE;
  else process.env.ORIGAMI_API_BASE = savedApiBase;
});

const here = path.dirname(fileURLToPath(import.meta.url));

/** Three chats of 150 entries at ~500 chars each — the owner's working day. */
export function threeBigChats(): HarnessSession[] {
  return [1, 2, 3].map((n) => ({
    id: `chat-${n}`,
    number: n,
    title: `chat ${n}`,
    log: Array.from({ length: 150 }, (_, i) => ({
      kind: i % 2 === 0 ? 'user' : 'agent',
      text: `line ${i} of chat ${n} — ${'the quick brown fox jumps over the lazy dog. '.repeat(11)}`,
      timestamp: 1_700_000_000_000 + i,
    })),
  }));
}

/** A webview that only records. `attachView` touches exactly these members. */
function recorder(): { host: unknown; posted: object[] } {
  const posted: object[] = [];
  const webview = {
    options: { enableScripts: true },
    html: '',
    cspSource: '',
    onDidReceiveMessage: () => ({ dispose: () => undefined }),
    postMessage: (m: object) => { posted.push(m); return Promise.resolve(true); },
    asWebviewUri: (u: unknown) => u,
  };
  return {
    host: {
      webview,
      onDidDispose: () => ({ dispose: () => undefined }),
      reveal: () => undefined,
      dispose: () => undefined,
    },
    posted,
  };
}

/** Attach the PRODUCTION `RemoteView` and collect what the phone is told.
 *  `caps` is what that phone's `remote/hello` declared — the controller stamps
 *  it on the view before it hydrates, and this is that same stamp. */
function attachPhone(
  harness: ReturnType<typeof makePanelHarness>,
  caps: readonly string[] = [RESTORE_Z_CAP],
): object[] {
  const sent: object[] = [];
  const view = new RemoteView({ send: (m) => void sent.push(m as object) });
  markCaps(view.webview, caps);
  harness.panel.attachView(view.host, 'chat');
  return sent;
}

describe('the SIDEBAR replay is not what changed', () => {
  it('posts exactly the message sequence the pre-change tree posted', () => {
    const harness = makePanelHarness(threeBigChats(), 'chat-2');
    const view = recorder();
    harness.panel.attachView(view.host, 'chat');
    const fixture = JSON.parse(
      readFileSync(path.join(here, 'remoteHydrateBudget.fixture.json'), 'utf8'),
    ) as unknown;
    // Captured by running this same attach on master (d28c901b43) — the whole
    // messageLog, the agent art, the effort/mode selectors, modelStatus and all.
    expect(view.posted).toEqual(fixture);
  });
});

describe('the PHONE replay is a tail, compressed, with the fan-out cut', () => {
  it('sends no agentArt, no model catalogue and no modelStatus', () => {
    const sent = attachPhone(makePanelHarness(threeBigChats(), 'chat-2'));
    const types = sent.map((m) => (m as { type: string }).type);
    expect(types).not.toContain('modelStatus');
    expect(types).not.toContain('modelOptions');
    expect(types).not.toContain('effortOptions');
    expect(types).not.toContain('modeOptions');
    expect(types).not.toContain('restoreMessages');
    expect(types.filter((t) => t === 'restoreMessagesZ')).toHaveLength(3);
    for (const m of sent.filter((x) => (x as { type: string }).type === 'sessionCreated')) {
      expect((m as { agentArt: unknown }).agentArt).toBeNull();
    }
    expect(types).toContain('restoreActiveSession');
  });

  it('inflates on the phone into the last 80 rows, and says how many are hidden', async () => {
    const sent = attachPhone(makePanelHarness(threeBigChats(), 'chat-2'));
    const z = sent.find((m) => (m as { type: string }).type === 'restoreMessagesZ');
    // `expandRestore` is the PHONE's own inflater (webview/remote/inflate.ts).
    const plain = (await expandRestore(z)) as {
      type: string; sessionId: string; messages: unknown[]; truncated: boolean; omitted: number;
    };
    expect(plain.type).toBe('restoreMessages');
    expect(plain.messages).toHaveLength(REMOTE_TAIL_MESSAGES);
    expect(plain.truncated).toBe(true);
    expect(plain.omitted).toBe(150 - REMOTE_TAIL_MESSAGES);
    // The TAIL, not the head: the newest row of the log is the last one here.
    expect((plain.messages[REMOTE_TAIL_MESSAGES - 1] as { text: string }).text).toContain('line 149');
  });

  it('round-trips astral characters and quotes, byte for byte', async () => {
    // deflate works on UTF-8 BYTES and the phone decodes with a TextDecoder, so
    // a surrogate pair cannot be cut the way the chunker's own splitter could.
    const text = 'a "quoted" turn — 🚀 and an accent, café';
    const harness = makePanelHarness(
      [{ id: 'chat-u', number: 1, log: [{ kind: 'agent', text, timestamp: 1 }] }],
      'chat-u',
    );
    const z = attachPhone(harness).find((m) => (m as { type: string }).type === 'restoreMessagesZ');
    const plain = (await expandRestore(z)) as { messages: Array<{ text: string }> };
    expect(plain.messages[0].text).toBe(text);
  });

  it('sends the PLAIN tail to a phone that declared no caps — the shipped iOS app', () => {
    // The regression this gate exists to stop: the app has no arm for
    // `restoreMessagesZ`, so an envelope it cannot open reads as an empty chat.
    const sent = attachPhone(makePanelHarness(threeBigChats(), 'chat-2'), []);
    const types = sent.map((m) => (m as { type: string }).type);
    expect(types).not.toContain('restoreMessagesZ');
    expect(types.filter((t) => t === 'restoreMessages')).toHaveLength(3);
    // ...and it is still the TAIL, so the app keeps most of the saving.
    const plain = sent.find((m) => (m as { type: string }).type === 'restoreMessages') as {
      messages: unknown[]; truncated: boolean; omitted: number;
    };
    expect(plain.messages).toHaveLength(REMOTE_TAIL_MESSAGES);
    expect(plain.truncated).toBe(true);
    expect(plain.omitted).toBe(150 - REMOTE_TAIL_MESSAGES);
  });

  it('drops a tool result’s screenshots, so one picture cannot blow the budget', async () => {
    // A `browser` screenshot is a `data:` URI of hundreds of KB on
    // `tool.result.images`. The phone has no cell for it (`browserSnapshot` is
    // dropped outright) and a hydration is UPLOADED, so it must not ride along.
    const shot = `data:image/png;base64,${'A'.repeat(400_000)}`;
    const log = [{
      kind: 'tool' as const,
      text: 'browser',
      timestamp: 1,
      tool: {
        call: { toolCallId: 't1', toolName: 'browser' },
        result: { toolCallId: 't1', content: 'took a screenshot', images: [shot] },
      },
    }];
    const sent = attachPhone(makePanelHarness([{ id: 'chat-p', number: 1, log }], 'chat-p'));
    const z = sent.find((m) => (m as { type: string }).type === 'restoreMessagesZ');
    const plain = (await expandRestore(z)) as { messages: Array<{ tool?: { result?: object } }> };
    const result = plain.messages[0].tool?.result as Record<string, unknown>;
    expect('images' in result).toBe(false);
    expect(result.content).toBe('took a screenshot');
    // The whole envelope is now smaller than the ONE picture it dropped.
    expect(Buffer.byteLength(JSON.stringify(z))).toBeLessThan(shot.length);
    // NEVER in place: the sidebar replays this same array.
    expect(log[0].tool.result.images).toEqual([shot]);
  });

  it('cuts a tool payload to the phone cap and leaves the log alone', () => {
    const log = [{
      kind: 'tool' as const,
      text: 'bash',
      timestamp: 1,
      tool: { call: { toolCallId: 't1' }, result: { toolCallId: 't1', content: 'x'.repeat(9000) } },
    }];
    const tail = remoteTail(log);
    const cut = tail.messages[0].tool?.result?.content as string;
    expect(cut).toHaveLength(REMOTE_TOOL_CONTENT_CHARS);
    // NEVER in place: the sidebar replays the same array right after this.
    expect(log[0].tool.result.content).toHaveLength(9000);
  });
});

describe('what the phone said it can open', () => {
  it('reads the caps a hello declares, and treats a malformed one as none', () => {
    expect(helloCaps({ type: 'remote/hello', caps: ['restoreZ'] })).toEqual(['restoreZ']);
    // Every road to "this page cannot inflate" must end at the plain tail: a
    // hello with no caps, a caps field that is not a list, a list of junk, and
    // no message at all are the four ways a page says nothing.
    expect(helloCaps({ type: 'remote/hello' })).toEqual([]);
    expect(helloCaps({ type: 'remote/hello', caps: 'restoreZ' })).toEqual([]);
    expect(helloCaps({ type: 'remote/hello', caps: [1, null, { restoreZ: true }] })).toEqual([]);
    expect(helloCaps(null)).toEqual([]);
  });

  it('a webview nobody marked accepts nothing', () => {
    // The default has to be the safe one: an unmarked view is a page the desk
    // never heard a hello from, and it gets the envelope every page can read.
    expect(remoteAcceptsZ({})).toBe(false);
    expect(remoteAcceptsZ(null)).toBe(false);
    const webview: Record<string, unknown> = {};
    markCaps(webview, ['somethingElse']);
    expect(remoteAcceptsZ(webview)).toBe(false);
    markCaps(webview, [RESTORE_Z_CAP]);
    expect(remoteAcceptsZ(webview)).toBe(true);
  });
});

describe('what a reconnect costs on the wire', () => {
  it('three 150-row chats hydrate the phone in under 60 KB sealed', async () => {
    const raw = new Map<string, unknown>();
    const machine: SeqMemento = {
      get: <T,>(k: string, d: T): T => (raw.has(k) ? (raw.get(k) as T) : d),
      update: (k, v) => Promise.resolve(void raw.set(k, v)),
    };
    registerRemoteSeq(machine);
    try {
      const key = await deriveKey(new Uint8Array(32).fill(7));
      const codec = desktopCodec(key, 'budget-rid');
      let sealed = 0;
      // The REAL outbound pipe: real chunker, real sealFrame, real 1 KiB pad.
      const pipe = new OutboundPipe(codec, { send: (f) => { sealed += f.byteLength; } }, () => undefined);
      const view = new RemoteView({ send: (m) => void pipe.send(m) });
      markCaps(view.webview, [RESTORE_Z_CAP]);
      const harness = makePanelHarness(threeBigChats(), 'chat-2');
      harness.panel.attachView(view.host, 'chat');
      // Every seal rides the pipe's own tail, so one more send resolves after
      // the whole hydration is on the wire.
      await pipe.send({ type: 'remote/flush' });
      const plain = JSON.parse(
        readFileSync(path.join(here, 'remoteHydrateBudget.fixture.json'), 'utf8'),
      ) as Array<{ type: string }>;
      const before = plain
        .filter((m) => m.type === 'restoreMessages')
        .reduce((a, m) => a + Buffer.byteLength(JSON.stringify(m)), 0);
      // The number this whole lane exists for. Printed so a regression says BY
      // HOW MUCH rather than just "over".
      console.log(`hydration: ${before} B of transcript JSON -> ${sealed} B sealed`);
      expect(sealed).toBeLessThan(60_000);
      expect(before).toBeGreaterThan(200_000);
    } finally {
      resetRemoteSeq();
    }
  });
});
