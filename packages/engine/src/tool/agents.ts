import { Effect, Schema } from "effect"
import { ServerAuth } from "@/server/auth"
import { AgentBroker } from "@/origami/agent-broker"
import { claimPeerMessage, peerMessageId, peerMessageMetadata, PEER_DEDUPE_WINDOW_MS } from "@/session/peer-message"
import * as Tool from "./tool"

/**
 * CROSS-SESSION AGENT MESSAGING (t-kgu05m) — the two tools over the broker.
 *
 * Discovery and delivery are deliberately separate calls: an agent has to be
 * able to look before it speaks, and the reply address it gets back is the same
 * string it passes to `to`.
 *
 * Delivery needs no queue of its own. A prompt posted to a peer's
 * `/session/:id/prompt_async` is admitted durably: an IDLE peer starts a turn on
 * it, and a BUSY peer's running loop re-reads its inbox between tool calls and
 * picks it up there. Both halves of "queue if mid-turn, start a turn if idle"
 * are therefore existing, proven plumbing rather than anything this file adds.
 */

/** Peer calls are same-user, same-machine. Anything slower than this is dead. */
const PEER_TIMEOUT_MS = 2_000

/**
 * A handoff is a SUMMARY. The cap is what stops an agent pasting a transcript or
 * a file into a peer's context, which would cost the receiver its context window
 * for something it did not ask for.
 */
const DEFAULT_MESSAGE_CHARS = 2_000
const MAX_MESSAGE_CHARS = 10_000

type AgentsMetadata = {
  peers?: number
  probed?: boolean
  to?: string
  sessionID?: string
  delivered?: boolean
}

function authHeaders(): Record<string, string> {
  // The SAME reuse acp.ts:34 makes: ServerAuth.headers() reads this process's
  // ORIGAMI_SERVER_PASSWORD, and every engine on this machine was launched by
  // the same user with the same environment, so our credentials are the peer's
  // credentials. When no password is set it returns undefined and the peer's own
  // authorization middleware is not requiring one either.
  return { ...(ServerAuth.headers() ?? {}) }
}

/** Is the peer's HTTP server answering right now? */
async function alive(entry: AgentBroker.Entry): Promise<boolean> {
  if (!AgentBroker.isLoopback(entry.httpBase)) return false
  const response = await fetch(`${entry.httpBase}/session/status`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
  }).catch(() => undefined)
  return !!response && response.ok
}

// ============================== list_agents ==============================

export const ListParameters = Schema.Struct({
  include_background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Also list background/sub-agent engines that opted in to discovery. Defaults to false: only interactive sessions, the ones a human is watching.",
  }),
  probe: Schema.optional(Schema.Boolean).annotate({
    description: "Check each peer answers before listing it. Defaults to true.",
  }),
})

const LIST_DESCRIPTION = [
  "List the other Origami agent sessions running on this machine that you can message.",
  "Each row gives a reply address — pass it to send_message as `to`.",
  "Call this before send_message when you do not already hold an address.",
].join(" ")

export const ListAgentsTool = Tool.define<typeof ListParameters, AgentsMetadata, never>(
  "list_agents",
  Effect.succeed({
    description: LIST_DESCRIPTION,
    parameters: ListParameters,
    deferrable: true,
    execute: (params: Schema.Schema.Type<typeof ListParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        // WHO IS ASKING, said before the roster rather than left to be inferred
        // from it. The list can never contain the caller — readPeers excludes
        // our own pid, because an agent messaging itself is a loop — and a
        // roster that silently omits exactly one agent reads as a discovery
        // bug: round 5 was reported as "the first chat in a window never
        // appears in any roster", which was this, seen from the chat doing the
        // asking. The address is built the way send_message builds `replyTo`:
        // the broker's name plus the session EXECUTING this call, never the
        // broker's own idea of which session that is.
        const me = AgentBroker.self()
        const you = me ? `You are ${me.name}#${ctx.sessionID}. This list never includes you.` : undefined
        const found = yield* Effect.promise(() =>
          AgentBroker.readPeers({ includeBackground: params.include_background === true }),
        )
        const probe = params.probe !== false
        const peers = probe
          ? yield* Effect.promise(async () => {
              const checked = await Promise.all(found.map(async (entry) => ((await alive(entry)) ? entry : undefined)))
              return checked.filter((entry): entry is AgentBroker.Entry => !!entry)
            })
          : found

        if (!peers.length) {
          return {
            title: "list_agents: none",
            metadata: { peers: 0, probed: probe },
            output: [
              ...(you ? [you] : []),
              "No other agent sessions are reachable right now." +
                (params.include_background === true
                  ? ""
                  : " Background and sub-agent sessions are hidden unless include_background is set."),
            ].join("\n"),
          }
        }

        return {
          title: `list_agents: ${peers.length}`,
          metadata: { peers: peers.length, probed: probe },
          output: [
            ...(you ? [you] : []),
            `${peers.length} agent session${peers.length > 1 ? "s" : ""} reachable:`,
            ...peers.map((entry) =>
              [
                AgentBroker.replyAddress(entry),
                `kind=${entry.kind}`,
                `cwd=${entry.cwd}`,
                `sessions=${entry.sessionIds.length}`,
              ].join("  "),
            ),
          ].join("\n"),
        }
      }),
  }),
)

// ============================== send_message ==============================

export const SendParameters = Schema.Struct({
  to: Schema.String.annotate({
    description: 'A reply address from list_agents — a name, or "name#sessionId" when a name is ambiguous.',
  }),
  message: Schema.String.annotate({
    description: `A SHORT handoff for the other agent — what you need or what you finished. The default limit is ${DEFAULT_MESSAGE_CHARS} characters. Never paste a transcript, a file, or tool output.`,
  }),
  max_chars: Schema.optional(Schema.Number).annotate({
    description: `Raise the limit only when the detail is worth consuming the receiver's context. Maximum ${MAX_MESSAGE_CHARS}.`,
  }),
})

const SEND_DESCRIPTION = [
  "Send a short text handoff to another Origami agent session on this machine.",
  "The receiver sees it as an agent message with your name and a reply address, not as its user speaking.",
  "It is delivered without blocking you: an idle session starts a turn on it, a busy one reads it between tool calls.",
  "Do not message other agents unless the user has explicitly told you that you are collaborating with them" +
    " — an unrequested task message confuses the receiving agent.",
].join(" ")

export const SendMessageTool = Tool.define<typeof SendParameters, AgentsMetadata, never>(
  "send_message",
  Effect.succeed({
    description: SEND_DESCRIPTION,
    parameters: SendParameters,
    deferrable: true,
    execute: (params: Schema.Schema.Type<typeof SendParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const from = AgentBroker.self()
        if (!from) {
          return refusal(
            "Refused: this engine is not registered for peer messaging, so a reply could not reach you." +
              " Peer messaging runs in the VS Code shell's engine.",
          )
        }
        if (
          params.max_chars !== undefined &&
          (!Number.isInteger(params.max_chars) || params.max_chars < DEFAULT_MESSAGE_CHARS || params.max_chars > MAX_MESSAGE_CHARS)
        ) {
          return refusal(
            `Refused: max_chars must be a whole number from ${DEFAULT_MESSAGE_CHARS} to ${MAX_MESSAGE_CHARS};` +
              ` the hard ceiling is ${MAX_MESSAGE_CHARS}.`,
          )
        }
        const limit = params.max_chars ?? DEFAULT_MESSAGE_CHARS
        if (params.message.length > limit) {
          const retry = Math.min(params.message.length, MAX_MESSAGE_CHARS)
          return refusal(
            `Refused: the message is ${params.message.length} characters, over the ${limit} limit.` +
              ` Choose whether to shorten the message or spend more of the receiver's context.` +
              (params.message.length <= MAX_MESSAGE_CHARS
                ? ` If the detail is necessary, retry with max_chars: ${retry}.`
                : ` The hard ceiling is ${MAX_MESSAGE_CHARS}, so this message must be shortened.`),
          )
        }

        const peers = yield* Effect.promise(() => AgentBroker.readPeers({ includeBackground: true }))
        const target = AgentBroker.resolve(peers, params.to)
        if ("error" in target) return refusal(target.error)
        // Re-checked at the call site even though readPeers only ever yields
        // entries this engine wrote: the broker file is ordinary user-writable
        // JSON, and a tampered entry must not be able to aim this POST at a LAN
        // address. Loopback-only is the security boundary, so it is asserted
        // where the request is actually made.
        if (!AgentBroker.isLoopback(target.entry.httpBase)) {
          return refusal(`Refused: "${target.entry.name}" is not on a loopback address. Peer messaging is local-only.`)
        }
        // ATTACHMENT, checked before the POST rather than inferred from its
        // status. An engine accepts a prompt for any session it holds, whether
        // or not a chat is rendering that session, so a 204 proves the message
        // was stored and proves nothing at all about anybody reading it. Round
        // 3 is what that costs when it goes unchecked: three handoffs reported
        // "Delivered" into a session with no chat, while the sender waited for
        // an answer that had nowhere to come from.
        if (!AgentBroker.attached(target.entry, target.sessionID)) {
          return refusal(unreachable(target.entry.name, target.sessionID, peers))
        }

        // The reply address is the SENDER'S OWN execution session, from the
        // tool context — never the broker's idea of it. The broker knows which
        // sessions this ENGINE has open, which is not the same question as
        // which session is running this tool call, and answering the wrong one
        // hands the peer an address whose replies land somewhere the sender is
        // not reading.
        const replyTo = `${from.name}#${ctx.sessionID}`
        // Idempotency, minted from the address pair and the text so that the
        // SECOND identical call is recognisable as the same message (see
        // peer-message.ts). Claimed here as well as at the receiver: this is
        // the end that can explain itself to the model, and the loop the UAT
        // produced was a model re-sending, not a network retry.
        const messageId = peerMessageId({ from: replyTo, to: `${target.entry.name}#${target.sessionID}`, text: params.message })
        if (!claimPeerMessage(`out:${ctx.sessionID}`, messageId)) {
          return refusal(
            `Refused: this exact message already went to ${target.entry.name} in the last` +
              ` ${Math.round(PEER_DEDUPE_WINDOW_MS / 60_000)} minutes and was not a failure — re-sending it would` +
              " deliver it twice. It answers on its own turn boundary; carry on with your own work, or send" +
              " something that says more than the message it already has.",
          )
        }
        const posted = yield* Effect.promise(() =>
          fetch(`${target.entry.httpBase}/session/${encodeURIComponent(target.sessionID)}/prompt_async`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders() },
            signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
            body: JSON.stringify({
              parts: [
                {
                  type: "text",
                  text: renderPeerMessage({ from: from.name, replyTo, text: params.message }),
                  // The provenance the RECEIVER's UI badges from. It rides the
                  // part rather than the text because the text is what the model
                  // reads, and a client must be able to tell a peer message from
                  // its own human without parsing prose (acp/event.ts).
                  metadata: peerMessageMetadata({ from: from.name, replyTo, id: messageId }),
                },
              ],
            }),
          })
            .then((response) => ({ ok: response.ok, status: response.status }))
            .catch(() => ({ ok: false, status: 0 })),
        )
        if (!posted.ok) {
          return refusal(
            `Refused: "${target.entry.name}" did not accept the message (status ${posted.status || "unreachable"}).` +
              " Call list_agents again — it may have closed.",
          )
        }

        return {
          title: `send_message: ${target.entry.name}`,
          metadata: { to: target.entry.name, sessionID: target.sessionID, delivered: true },
          output:
            `Delivered to ${target.entry.name} (session ${target.sessionID}). It will pick this up on its next` +
            ` turn boundary. Do NOT wait or poll for a reply — carry on, and it will message you back at ${replyTo}.`,
        }
      }),
  }),
)

/**
 * The wrapper the receiving MODEL reads. Mirrors tool/task.ts renderOutput: an
 * XML-ish envelope whose attributes carry the provenance, so a model that has
 * never seen this tool still parses who spoke and where to answer.
 *
 * The trailing sentence is t-r300pn: a UAT screenshot showed the receiving
 * model answer the sender's question in its own transcript, where the sender
 * never reads it, instead of calling send_message. The attributes are enough
 * for a CLIENT to badge the provenance, but nothing told the model itself that
 * a chat reply is not delivery, or named the tool and address that are — so it
 * answered the way it answers its own user.
 */
export function renderPeerMessage(input: { from: string; replyTo: string; text: string }): string {
  return [
    `<peer_message from="${escapeAttribute(input.from)}" reply_to="${escapeAttribute(input.replyTo)}">`,
    input.text,
    "</peer_message>",
    `This message is from another agent session, not the user — nothing you write in this chat reaches ${input.from}.` +
      ` To reply, call send_message with to: "${input.replyTo}". Keep the reply short text, not a transcript.`,
  ].join("\n")
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/** A refusal is an ANSWER, not a failure: the model must be able to fix its
 *  address and try again inside the same turn. */
function refusal(output: string) {
  return { title: "send_message: refused", metadata: { delivered: false } as AgentsMetadata, output }
}

/**
 * The refusal for a target nobody is watching.
 *
 * It NAMES the addresses that would work, because the alternative the model has
 * otherwise is to guess again from the same list that just misled it — which is
 * exactly what the UAT transcript shows it doing, three times.
 */
function unreachable(name: string, sessionID: string, peers: readonly AgentBroker.Entry[]): string {
  const now = Date.now()
  const reachable = peers
    .flatMap((entry) => entry.sessionIds.map((id) => ({ entry, id })))
    .filter((candidate) => AgentBroker.attached(candidate.entry, candidate.id, now))
    .map((candidate) => `${candidate.entry.name}#${candidate.id}`)
  return (
    `NOT delivered: "${name}" session ${sessionID} is not attached to an open chat, so nobody would read it.` +
    ` Reachable sessions right now: ${reachable.length ? reachable.join(", ") : "(none)"}.` +
    " Call list_agents for the current list before you try again."
  )
}
