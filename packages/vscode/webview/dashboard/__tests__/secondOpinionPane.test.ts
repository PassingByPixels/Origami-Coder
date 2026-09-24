// secondOpinion host — the round trip between the composer's scales and the
// engine's review-only one-shot.
//
// Shape borrowed from skillsPane.test.ts: a fake client that RECORDS what it
// was asked, so "it reached the engine with the right arguments" is asserted as
// a call rather than inferred from the absence of an error.
//
// The failures worth pinning are the quiet ones:
//   · the <provider>/<model> split cut at the LAST slash instead of the first,
//     which breaks every OpenRouter id ("openrouter/anthropic/claude-sonnet-4")
//     while looking perfect on "lmstudio/devstral";
//   · a refusal that posts nothing, leaving a pressed button with no card and
//     no explanation;
//   · the ENGINE's session id vs the webview's panel id — they are different
//     strings, and swapping them reviews nothing while failing plausibly.

import { describe, expect, it, beforeEach } from 'vitest';
import {
  SECOND_OPINION_MESSAGE_TYPES,
  handleSecondOpinionMessage,
  type SecondOpinionHost,
  type SecondOpinionSession,
} from '../../../src/dashboard/secondOpinion';

let posts: Array<Record<string, unknown>> = [];
let asked: Array<[string, Record<string, unknown> | undefined]> = [];

function client(answer: Record<string, unknown> | Error, over: Partial<{ engineId: string | null; current: string }> = {}) {
  return {
    currentSessionId: over.engineId === undefined ? 'ses_engine_1' : over.engineId,
    getModelOption: () => ({ current: over.current ?? 'lmstudio/qwen3-coder-30b' }),
    extMethod: async (method: string, params?: Record<string, unknown>) => {
      asked.push([method, params]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const host = (session?: SecondOpinionSession): SecondOpinionHost => ({
  session: () => session,
  post: (msg) => { posts.push(msg); },
});

const REVIEW = { ok: true, text: 'The bound is still wrong. Verdict: CONCERNS', trimmed: [] };

const request = (over: Record<string, unknown> = {}) => ({
  type: 'secondOpinion',
  sessionId: 'chat-7',
  modelId: 'openrouter/anthropic/claude-sonnet-4',
  modelLabel: 'Claude Sonnet 4',
  ...over,
});

const results = () => posts.filter((p) => p['type'] === 'secondOpinionResult');
const last = () => results()[results().length - 1];

beforeEach(() => { posts = []; asked = []; });

describe('what it claims', () => {
  it('claims secondOpinion and nothing else, and ignores a message that is not its own', async () => {
    expect([...SECOND_OPINION_MESSAGE_TYPES]).toEqual(['secondOpinion']);
    await handleSecondOpinionMessage(host({ client: client(REVIEW) }), { type: 'listSkills' });
    expect(posts).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe('the happy round trip', () => {
  it('answers PENDING first, then the review — so a card can appear before the model has', async () => {
    await handleSecondOpinionMessage(host({ client: client(REVIEW) }), request());

    expect(results().map((r) => r['state'])).toEqual(['pending', 'ok']);
    expect(results()[0]['modelLabel']).toBe('Claude Sonnet 4');
    expect(last()['text']).toBe('The bound is still wrong. Verdict: CONCERNS');
  });

  it('correlates both answers with ONE id, so a second review cannot fill this card', async () => {
    await handleSecondOpinionMessage(host({ client: client(REVIEW) }), request());
    const [pending, done] = results();
    expect(pending['id']).toBeTruthy();
    expect(done['id']).toBe(pending['id']);
  });

  it('gives two requests different ids, even back to back', async () => {
    const h = host({ client: client(REVIEW) });
    await handleSecondOpinionMessage(h, request());
    await handleSecondOpinionMessage(h, request({ modelId: 'lmstudio/devstral-small' }));
    const ids = new Set(results().map((r) => r['id']));
    expect(ids.size).toBe(2);
  });

  it('asks the ENGINE session id, never the webview panel id', async () => {
    await handleSecondOpinionMessage(host({ client: client(REVIEW) }), request());
    expect(asked[0][0]).toBe('second_opinion');
    expect(asked[0][1]!['sessionId']).toBe('ses_engine_1');
    expect(asked[0][1]!['sessionId']).not.toBe('chat-7');
  });

  it('names the model that DID the work, bare, for the review instruction', async () => {
    await handleSecondOpinionMessage(host({ client: client(REVIEW) }), request());
    expect(asked[0][1]!['currentModelLabel']).toBe('qwen3-coder-30b');
  });

  it("passes the chat's own cwd when it has one, and omits it when it does not", async () => {
    await handleSecondOpinionMessage(host({ client: client(REVIEW), cwd: 'C:\\Repos\\other' }), request());
    expect(asked[0][1]!['cwd']).toBe('C:\\Repos\\other');

    asked = [];
    await handleSecondOpinionMessage(host({ client: client(REVIEW) }), request());
    expect(asked[0][1]).not.toHaveProperty('cwd');
  });
});

describe('the provider/model split', () => {
  it('cuts at the FIRST slash — an OpenRouter id carries slashes of its own', async () => {
    await handleSecondOpinionMessage(host({ client: client(REVIEW) }), request());
    expect(asked[0][1]!['providerID']).toBe('openrouter');
    // Cutting at the last slash would send providerID "openrouter/anthropic",
    // which no provider answers to — and the plain "lmstudio/devstral" case
    // would still have passed.
    expect(asked[0][1]!['modelID']).toBe('anthropic/claude-sonnet-4');
  });

  it('handles a plain two-part id too', async () => {
    await handleSecondOpinionMessage(host({ client: client(REVIEW) }), request({ modelId: 'lmstudio/devstral-small' }));
    expect(asked[0][1]!['providerID']).toBe('lmstudio');
    expect(asked[0][1]!['modelID']).toBe('devstral-small');
  });

  it('refuses an id with no provider half, and never calls the engine', async () => {
    await handleSecondOpinionMessage(host({ client: client(REVIEW) }), request({ modelId: 'bare-id' }));
    expect(asked).toEqual([]);
    expect(last()['state']).toBe('error');
    expect(last()['error']).toContain('<provider>/<model>');
  });

  it('refuses a trailing-slash id the same way', async () => {
    await handleSecondOpinionMessage(host({ client: client(REVIEW) }), request({ modelId: 'lmstudio/' }));
    expect(asked).toEqual([]);
    expect(last()['state']).toBe('error');
  });
});

describe('every refusal produces a card, never silence', () => {
  it('says so when no model was picked', async () => {
    await handleSecondOpinionMessage(host({ client: client(REVIEW) }), request({ modelId: '' }));
    expect(last()['state']).toBe('error');
    expect(last()['error']).toContain('No model');
  });

  it('says so when the chat has no engine connection', async () => {
    await handleSecondOpinionMessage(host({ client: null }), request());
    expect(asked).toEqual([]);
    expect(last()['error']).toContain('no engine connection');
  });

  it('says so when the panel holds no such session at all', async () => {
    await handleSecondOpinionMessage(host(undefined), request());
    expect(last()['state']).toBe('error');
  });

  it('says so when the chat has not started an engine session yet', async () => {
    await handleSecondOpinionMessage(host({ client: client(REVIEW, { engineId: null }) }), request());
    expect(asked).toEqual([]);
    expect(last()['error']).toContain('send a message first');
  });

  it("surfaces the ENGINE's own refusal verbatim — it is the only text that says what to do", async () => {
    const refusal = { ok: false, message: 'This chat has no completed turn to review yet — send a message and let it finish first.' };
    await handleSecondOpinionMessage(host({ client: client(refusal) }), request());
    // A refusal is an ANSWER, not an exception: the pending card still went out
    // first, and the error fills it rather than appearing from nowhere.
    expect(results().map((r) => r['state'])).toEqual(['pending', 'error']);
    expect(last()['error']).toBe(refusal.message);
  });

  it('surfaces a thrown transport failure the same way', async () => {
    await handleSecondOpinionMessage(host({ client: client(new Error('engine is down')) }), request());
    expect(results().map((r) => r['state'])).toEqual(['pending', 'error']);
    expect(last()['error']).toBe('engine is down');
  });

  it('treats an empty review as a failure, not as a review that said nothing', async () => {
    await handleSecondOpinionMessage(host({ client: client({ ok: true, text: '' }) }), request());
    expect(last()['state']).toBe('error');
  });

  it('falls back to the bare model id for the label when the webview sent none', async () => {
    await handleSecondOpinionMessage(host({ client: null }), request({ modelLabel: undefined }));
    expect(last()['modelLabel']).toBe('anthropic/claude-sonnet-4');
  });
});
