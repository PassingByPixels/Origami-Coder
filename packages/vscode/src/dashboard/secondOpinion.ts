// Second opinion — host side. One webview message in, up to two out: a `pending` answer lands
// immediately so the user sees the request was accepted, then an `ok`/`error` answer when the model
// finishes; `id` correlates the two so two reviews in one chat don't collide.
// A refusal is always an error card, never a silent drop.

/** The engine's own review-only one-shot (`packages/engine/src/acp/second-opinion.ts`). */
const EXT_METHOD = 'second_opinion';

export const SECOND_OPINION_MESSAGE_TYPES = new Set(['secondOpinion']);

export interface SecondOpinionClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The engine's id for this chat, what `second_opinion` reads the turn from; null before the
   *  session exists. */
  readonly currentSessionId: string | null;
  /** The model this chat runs, named in the review instruction so the reviewer knows whose work it
   *  judges. */
  getModelOption(): { current?: string } | null | undefined;
}

/** One entry of the host's session map, as far as this feature is concerned. */
export interface SecondOpinionSession {
  /** Null until the ACP client is constructed; absent on a failed start. */
  client?: SecondOpinionClient | null;
  /** The directory this chat runs in — an agent chat may be in another repo. */
  cwd?: string;
}

export interface SecondOpinionHost {
  /** The posting panel's session, resolved by the caller — grid-safe, since a grid shows many
   *  chats. */
  session(sessionId: string | undefined): SecondOpinionSession | undefined;
  post(message: Record<string, unknown>): void;
}

let seq = 0;

/** Correlation id, monotonic per window rather than random: two reviews in the same millisecond
 *  must not collide. */
function nextId(): string {
  seq += 1;
  return `so-${Date.now()}-${seq}`;
}

export async function handleSecondOpinionMessage(
  host: SecondOpinionHost,
  m: { type?: string; sessionId?: string; [k: string]: unknown },
): Promise<void> {
  if (m.type !== 'secondOpinion') return;
  const sessionId = typeof m.sessionId === 'string' ? m.sessionId : '';
  const modelId = String(m.modelId ?? '');
  const modelLabel = String(m.modelLabel ?? '') || bareModelName(modelId);
  const id = nextId();
  const base = { type: 'secondOpinionResult', id, sessionId, modelId, modelLabel };

  const fail = (error: string) => host.post({ ...base, state: 'error', error });

  if (!modelId) {
    fail('No model was picked for the second opinion.');
    return;
  }
  // The picker's value is "<provider>/<id>"; split on the FIRST slash only, since OpenRouter ids
  // carry slashes of their own.
  const slash = modelId.indexOf('/');
  if (slash <= 0 || slash === modelId.length - 1) {
    fail(`"${modelId}" is not a <provider>/<model> id — the second opinion needs both halves.`);
    return;
  }
  const providerID = modelId.slice(0, slash);
  const modelID = modelId.slice(slash + 1);

  const session = host.session(sessionId);
  const client = session?.client;
  if (!client) {
    fail('This chat has no engine connection — open or reload the chat and try again.');
    return;
  }
  const engineSessionId = client.currentSessionId;
  if (!engineSessionId) {
    fail('This chat has not started a session yet — send a message first.');
    return;
  }

  host.post({ ...base, state: 'pending' });
  try {
    const answer = await client.extMethod(EXT_METHOD, {
      sessionId: engineSessionId,
      providerID,
      modelID,
      currentModelLabel: currentLabel(client),
      ...(session?.cwd ? { cwd: session.cwd } : {}),
    });
    // The engine answers `{ ok: false, message }` for every refusal it owns (no turn, unknown
    // model, provider declines) — read as an answer, not thrown, so its wording reaches the user.
    if (answer['ok'] === true && typeof answer['text'] === 'string' && answer['text']) {
      host.post({ ...base, state: 'ok', text: answer['text'] });
      return;
    }
    fail(typeof answer['message'] === 'string' && answer['message']
      ? answer['message']
      : `${modelLabel} returned no review.`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

/** How the chat names the model that did the work — bare name, read inside a sentence. */
function currentLabel(client: SecondOpinionClient): string {
  return bareModelName(client.getModelOption()?.current ?? '');
}

function bareModelName(value: string): string {
  const slash = value.indexOf('/');
  return slash > 0 ? value.slice(slash + 1) : value;
}
