import { AgentBroker } from "@/origami/agent-broker"
import { ServerAuth } from "@/server/auth"
import type { FlockCard } from "./card"
import { FlockStore } from "./store"
import { FlockPeer } from "./peer"

/**
 * How a window that does not hold the flock still asks a question.
 *
 * One VS Code workspace spawns several engines and `owner-lease.ts` lets exactly
 * ONE of them open the relay sockets. The lease record carries the owner's
 * loopback address, and the engines that stood down forward `flock_ask` and
 * `flock_who` to it over ordinary HTTP; the owner answers from the peer it
 * already holds, so nothing new is opened.
 *
 * LOOPBACK ONLY — the same boundary `tool/agents.ts` uses — asserted at the call
 * site as well as at the writer, because the lease is ordinary user-writable
 * JSON and a tampered record must not be able to aim a POST at a LAN address.
 * Credentials are this process's own: every engine on the machine was launched
 * by the same user with the same environment.
 *
 * ONE ROUTER, TWO HOSTS. `route()` is the whole contract — method, path, query,
 * body in; status and JSON out — wrapped once for the engine's Effect route and
 * once for `fetch`, so the shape crossing the process boundary is proved once.
 */

export const ASK_PATH = "/flock/ask"
export const WHO_PATH = "/flock/who"
/** The ANSWER half of the same problem: the owner decides in the window they
 *  have open, routinely not the one that won the lease, so the signed answer is
 *  forwarded exactly as a question is. The body names a THREAD, never a handle. */
export const REPLY_PATH = "/flock/reply"

/** How long a forwarded ask waits. It no longer waits for an ANSWER — the ask is
 *  fire-and-return on both sides — but stays generous on purpose: the holder may
 *  be opening a relay socket for a contact it has not talked to yet, and a
 *  forward that timed out there would say the question was never sent. */
export const ASK_TIMEOUT_MS = FlockPeer.REQUEST_TIMEOUT_MS + 5_000

/** A card is a file read on the far side, not a model turn. */
export const WHO_TIMEOUT_MS = 10_000

/** One contact's card, or the fact that they did not answer. */
export interface CardEntry {
  readonly handle: string
  readonly card?: FlockCard.Card
}

export interface AskBody {
  readonly to: readonly string[]
  readonly question: string
  /** The thread this question follows up on, so the pair stay threaded on the
   *  holder's store as well as on the pane that asked. */
  readonly followUpOf?: string
  /** THE CHAT THAT ASKED, forwarded with the question. The thread is filed on the
   *  HOLDER's store and the holder is routinely not the engine serving the chat,
   *  so a session id recorded only where the tool ran is recorded nowhere. */
  readonly origin?: FlockStore.ThreadOrigin
}

/** One contact the question went to: the thread it opened, or why it did not. */
export interface SentTo {
  readonly contact: string
  readonly thread?: string
  readonly error?: string
}

export interface AskResult {
  readonly sent: readonly SentTo[]
}

export interface ReplyBody {
  readonly thread: string
  readonly ok: boolean
  readonly text: string
  readonly tokens: number
  readonly reason?: string
}

/** A reply either went out or it did not; there is nothing to read back. */
export interface ReplyResult {
  readonly sent: true
}

export interface WhoResult {
  /** False ONLY when `to` named somebody this flock does not hold. */
  readonly found: boolean
  readonly cards: readonly CardEntry[]
  /** Why `found` is false, when the reason is not "nobody by that name": an
   *  AMBIGUOUS name. Without it a forwarded `flock_who` reported two contacts as
   *  nobody, which the asking engine cannot detect — it does not open the store
   *  (`Store.open()` mints a keypair), so only the holder can name the candidates. */
  readonly error?: string
}

export interface Reply {
  readonly status: number
  readonly body: unknown
}

/** What a caller gets back when the owner engine could not serve the request. */
export interface Failure {
  readonly error: string
}

/** Not an address this may be POSTed to. The security boundary, in one place. */
export function reachable(httpBase: string | undefined): httpBase is string {
  return typeof httpBase === "string" && AgentBroker.isLoopback(httpBase)
}

function bad(status: number, error: string): Reply {
  return { status, body: { error } satisfies Failure }
}

function askBody(body: unknown): AskBody | undefined {
  if (!body || typeof body !== "object") return undefined
  const input = body as { to?: unknown; question?: unknown }
  const to = Array.isArray(input.to) ? input.to.filter((handle) => typeof handle === "string") : undefined
  if (!to || to.length === 0 || typeof input.question !== "string" || !input.question) return undefined
  const followUpOf = (input as { followUpOf?: unknown }).followUpOf
  return {
    to,
    question: input.question,
    ...(typeof followUpOf === "string" && followUpOf ? { followUpOf } : {}),
    ...(originOf((input as { origin?: unknown }).origin) ?? {}),
  }
}

/** The origin a forwarded ask carried, validated. Anything else is no origin —
 *  a session id this engine invented would deliver a reply into a stranger. */
function originOf(raw: unknown): { origin: FlockStore.ThreadOrigin } | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as { sessionID?: unknown; title?: unknown }
  if (typeof value.sessionID !== "string" || !value.sessionID) return undefined
  const title = typeof value.title === "string" && value.title ? value.title : undefined
  return { origin: { sessionID: value.sessionID, ...(title ? { title } : {}) } }
}

function replyBody(body: unknown): ReplyBody | undefined {
  if (!body || typeof body !== "object") return undefined
  const input = body as { thread?: unknown; ok?: unknown; text?: unknown; tokens?: unknown; reason?: unknown }
  if (typeof input.thread !== "string" || !input.thread) return undefined
  if (typeof input.ok !== "boolean" || typeof input.text !== "string" || typeof input.tokens !== "number") {
    return undefined
  }
  return {
    thread: input.thread,
    ok: input.ok,
    text: input.text,
    tokens: input.tokens,
    ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
  }
}

/** THE WHOLE OWNER-SIDE CONTRACT: given the request and the peer this engine
 *  holds, produce the status and the JSON body. A 503 rather than a 404 when
 *  there is no peer — the route exists on every engine, and "not the holder right
 *  now" changes on its own within a heartbeat, unlike "no such route". */
export async function route(
  input: { method: string; pathname: string; query: URLSearchParams; body: unknown },
  peer: FlockPeer.Peer | undefined,
): Promise<Reply> {
  if (input.pathname === ASK_PATH && input.method === "POST") {
    if (!peer) return bad(503, "this engine does not hold the flock connection")
    const parsed = askBody(input.body)
    if (!parsed) return bad(400, "expected a body of { to: string[], question: string }")
    // FIRE AND RETURN, on this side too. The thread is recorded on the HOLDER's
    // store — which is the same `flock.json` the forwarding engine reads — so
    // the row the owner sees is the same row whichever window asked.
    const posted = await peer.postMany(parsed.to, parsed.question, parsed.followUpOf, parsed.origin)
    return { status: 200, body: { sent: posted } satisfies AskResult }
  }
  if (input.pathname === REPLY_PATH && input.method === "POST") {
    if (!peer) return bad(503, "this engine does not hold the flock connection")
    const parsed = replyBody(input.body)
    if (!parsed) {
      return bad(400, "expected a body of { thread: string, ok: boolean, text: string, tokens: number }")
    }
    try {
      await peer.reply(parsed)
    } catch (error) {
      // 409 rather than 500: every failure `Peer.reply` can produce is about the
      // THREAD (unknown id, wrong direction, a contact revoked since) and is a
      // sentence the clicking owner has to read, not a fault in this engine.
      return bad(409, error instanceof Error ? error.message : String(error))
    }
    return { status: 200, body: { sent: true } satisfies ReplyResult }
  }
  if (input.pathname === WHO_PATH && input.method === "GET") {
    if (!peer) return bad(503, "this engine does not hold the flock connection")
    // `to` is a COMMA-SEPARATED list, and omitting it means every contact. The
    // asking engine must not have to open the store to know who is in the flock:
    // `Store.open()` mints a keypair on first use.
    const wanted = (input.query.get("to") ?? "")
      .split(",")
      .map((handle) => handle.trim())
      .filter(Boolean)
    const handles: string[] = []
    for (const handle of wanted) {
      const found = peer.lookup(handle)
      // AMBIGUITY STOPS THE WHOLE CALL rather than quietly dropping one name: a
      // card list that silently omitted the contact the owner asked about is how
      // "flock_who says they are not there" got reported for a contact who was.
      if (found.kind === "many") {
        return { status: 200, body: { found: false, cards: [], error: FlockStore.ambiguous(handle, found.candidates) } satisfies WhoResult }
      }
      if (found.kind === "one") handles.push(found.friend.handle)
    }
    if (!wanted.length) handles.push(...peer.contacts())
    if (wanted.length && handles.length === 0) {
      return { status: 200, body: { found: false, cards: [] } satisfies WhoResult }
    }
    const cards: CardEntry[] = []
    for (const handle of handles) {
      const card = await peer.who(handle).catch(() => undefined)
      cards.push({ handle, ...(card ? { card } : {}) })
    }
    return { status: 200, body: { found: true, cards } satisfies WhoResult }
  }
  return bad(404, `no flock route for ${input.method} ${input.pathname}`)
}

/** `route()` behind a `fetch` handler, for any host that speaks web Request and
 *  Response. The engine's own server has an Effect route, but both share `route`. */
export function fetchHandler(peer: () => FlockPeer.Peer | undefined): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url)
    const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined
    const reply = await route(
      { method: request.method, pathname: url.pathname, query: url.searchParams, body },
      peer(),
    )
    return Response.json(reply.body, { status: reply.status })
  }
}

// ------------------------------- the client -------------------------------

/** What a forward produced: the owner's own answers, or the sentence to print. */
export type Forwarded<T> = { readonly value: T } | { readonly error: string }

async function call<T>(input: {
  httpBase: string
  path: string
  method: "GET" | "POST"
  body?: unknown
  timeoutMs: number
}): Promise<Forwarded<T>> {
  // Re-asserted HERE as well as where the lease is written. The record is
  // ordinary user-writable JSON, so loopback-only is checked where the request
  // is actually made.
  if (!reachable(input.httpBase)) return { error: `${input.httpBase} is not a loopback address` }
  const response = await fetch(`${input.httpBase}${input.path}`, {
    method: input.method,
    headers: {
      ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(ServerAuth.headers() ?? {}),
    },
    signal: AbortSignal.timeout(input.timeoutMs),
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
  if (response instanceof Error) return { error: response.message }
  const payload = (await response.json().catch(() => undefined)) as { error?: string } | undefined
  if (!response.ok) return { error: payload?.error ?? `HTTP ${response.status}` }
  if (!payload) return { error: "the answer was not JSON" }
  return { value: payload as T }
}

export function askOwner(input: {
  httpBase: string
  to: readonly string[]
  question: string
  followUpOf?: string
  origin?: FlockStore.ThreadOrigin
  timeoutMs?: number
}): Promise<Forwarded<AskResult>> {
  return call<AskResult>({
    httpBase: input.httpBase,
    path: ASK_PATH,
    method: "POST",
    body: {
      to: [...input.to],
      question: input.question,
      ...(input.followUpOf ? { followUpOf: input.followUpOf } : {}),
      ...(input.origin?.sessionID ? { origin: input.origin } : {}),
    } satisfies AskBody,
    timeoutMs: input.timeoutMs ?? ASK_TIMEOUT_MS,
  })
}

/** A signed answer or decline, forwarded to the engine holding the flock. */
export function replyOwner(input: {
  httpBase: string
  thread: string
  ok: boolean
  text: string
  tokens: number
  reason?: string
  timeoutMs?: number
}): Promise<Forwarded<ReplyResult>> {
  const { httpBase, timeoutMs, ...body } = input
  return call<ReplyResult>({
    httpBase,
    path: REPLY_PATH,
    method: "POST",
    body: body satisfies ReplyBody,
    // A send is one frame, not a model turn: it fails fast or it worked.
    timeoutMs: timeoutMs ?? WHO_TIMEOUT_MS,
  })
}

export function whoOwner(input: {
  httpBase: string
  to?: string
  timeoutMs?: number
}): Promise<Forwarded<WhoResult>> {
  const query = input.to ? `?to=${encodeURIComponent(input.to)}` : ""
  return call<WhoResult>({
    httpBase: input.httpBase,
    path: `${WHO_PATH}${query}`,
    method: "GET",
    timeoutMs: input.timeoutMs ?? WHO_TIMEOUT_MS,
  })
}

export * as FlockOwnerHttp from "./owner-http"
