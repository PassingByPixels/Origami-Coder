import { Effect, Schema } from "effect"
import { ServerAuth } from "@/server/auth"
import { AgentBroker } from "@/origami/agent-broker"
import { AgentMailbox } from "@/origami/agent-mailbox"
import {
  claimPeerMessage,
  peerMessageId,
  peerMessageMetadata,
  PEER_DEDUPE_WINDOW_MS,
  releasePeerMessage,
} from "@/session/peer-message"
import { AgentPost } from "@/session/agent-post"
import * as Tool from "./tool"

/**
 * Cross-session agent messaging — the two tools over the broker. Discovery and
 * delivery are separate calls: an agent has to look before it speaks, and the
 * reply address it gets back is the same string it passes to `to`.
 *
 * Delivery needs no queue: a prompt posted to a peer's
 * `/session/:id/prompt_async` is admitted durably, so an idle peer starts a turn
 * on it and a busy peer re-reads its inbox between tool calls.
 */

/** Peer calls are same-user, same-machine. Anything slower than this is dead. */
const PEER_TIMEOUT_MS = 2_000

/** A handoff is a summary. The cap stops an agent pasting a transcript or a file
 *  into a peer's context, which would cost the receiver its context window. */
const DEFAULT_MESSAGE_CHARS = 2_000
const MAX_MESSAGE_CHARS = 10_000

type AgentsMetadata = {
  peers?: number
  /** t-w2txb2: stopped (parked) chats listed, or `true` when a send was kept for one. */
  parked?: number | boolean
  probed?: boolean
  to?: string
  sessionID?: string
  delivered?: boolean
}

function authHeaders(): Record<string, string> {
  // Every engine on this machine was launched by the same user with the same
  // environment, so this process's ORIGAMI_SERVER_PASSWORD is the peer's
  // credential too. Unset, it returns undefined and the peer requires none.
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
        // Who is asking, said before the roster: readPeers excludes our own pid,
        // and a roster that silently omits exactly one agent reads as a discovery
        // bug. Built like send_message's `replyTo` — the broker's name plus the
        // session executing this call.
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
        // t-w2txb2: a chat whose engine the extension stopped after a long idle.
        // It stays addressable: a message to it starts it again. An address a
        // live engine also holds is left out, because the live engine wins it.
        const parked = (yield* Effect.promise(() => AgentBroker.readParked()))
          .filter((standIn) => params.include_background === true || standIn.kind === "interactive")
          .filter(
            (standIn) =>
              !found.some((entry) => entry.name === standIn.name && entry.sessionIds.includes(standIn.sessionId)),
          )

        if (!peers.length && !parked.length) {
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
          title: `list_agents: ${peers.length + parked.length}`,
          metadata: { peers: peers.length, probed: probe, ...(parked.length ? { parked: parked.length } : {}) },
          output: [
            ...(you ? [you] : []),
            `${peers.length} agent session${peers.length === 1 ? "" : "s"} reachable:`,
            ...peers.map((entry) =>
              [
                AgentBroker.replyAddress(entry),
                `kind=${entry.kind}`,
                `cwd=${entry.cwd}`,
                `sessions=${entry.sessionIds.length}`,
              ].join("  "),
            ),
            ...(parked.length
              ? [
                  `${parked.length} stopped chat${parked.length === 1 ? "" : "s"} (stopped to save memory;` +
                    " send_message starts it again to read the message):",
                  ...parked.map((standIn) =>
                    [
                      AgentBroker.parkedAddress(standIn),
                      `kind=${standIn.kind}`,
                      `cwd=${standIn.cwd}`,
                      "status=stopped",
                    ].join("  "),
                  ),
                ]
              : []),
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
        if ("error" in target) {
          // t-w2txb2: no live engine holds this address. A PARKED chat does not
          // refuse: the message is kept in its mailbox and the chat starts again.
          const parked = yield* Effect.promise(() => AgentBroker.readParked())
          const sleeping = AgentBroker.resolveParked(peers, parked, params.to)
          if (!sleeping) return refusal(target.error)
          if ("error" in sleeping) return refusal(sleeping.error)
          return yield* keepForParked({ standIn: sleeping.standIn, from: from.name, text: params.message, ctx })
        }
        // Security boundary: loopback-only, asserted where the request is made.
        // The broker file is ordinary user-writable JSON, so a tampered entry
        // must not be able to aim this POST at a LAN address.
        if (!AgentBroker.isLoopback(target.entry.httpBase)) {
          return refusal(`Refused: "${target.entry.name}" is not on a loopback address. Peer messaging is local-only.`)
        }
        // Attachment, checked before the POST rather than inferred from it: an
        // engine accepts a prompt for any session it holds, so a 204 proves the
        // message was stored and nothing about anybody reading it.
        if (!AgentBroker.attached(target.entry, target.sessionID)) {
          return refusal(unreachable(target.entry.name, target.sessionID, peers))
        }

        // The sender's own execution session, from the tool context — never the
        // broker's idea of it. The broker knows which sessions this engine has
        // open, not which is running this call, and the wrong answer hands the
        // peer an address the sender is not reading.
        const replyTo = `${from.name}#${ctx.sessionID}`
        // Idempotency, minted from the address pair and the text (peer-message.ts).
        // Claimed here as well as at the receiver: this is the end that can
        // explain itself to the model.
        const messageId = peerMessageId({ from: replyTo, to: `${target.entry.name}#${target.sessionID}`, text: params.message })
        if (!claimPeerMessage(`out:${ctx.sessionID}`, messageId)) return refusal(alreadySent(target.entry.name))
        const posted = yield* Effect.promise(() =>
          fetch(`${target.entry.httpBase}/session/${encodeURIComponent(target.sessionID)}/prompt_async`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders() },
            signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
            body: promptBody({ from: from.name, replyTo, text: params.message, id: messageId }),
          })
            .then((response) => ({ ok: response.ok, status: response.status }))
            .catch(() => ({ ok: false, status: 0 })),
        )
        if (!posted.ok) {
          // origami_change (t-wdybz9): nothing arrived, so the claim goes back
          // (a retry is not "already went"). The engine may have parked and
          // exited since we read its entry: then its stand-in is the address.
          releasePeerMessage(`out:${ctx.sessionID}`, messageId)
          const standIn = yield* Effect.promise(() => AgentPost.locateParked(target.sessionID))
          if (standIn) return yield* keepForParked({ standIn, from: from.name, text: params.message, ctx })
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
 * The wrapper the receiving model reads: an XML-ish envelope whose attributes
 * carry the provenance, so a model that has never seen this tool still parses
 * who spoke and where to answer. The trailing sentence is load-bearing — the
 * attributes let a client badge the provenance, but nothing else tells the model
 * that a chat reply is not delivery, and it would answer where nobody reads.
 */
export function renderPeerMessage(input: {
  from: string
  replyTo: string
  text: string
  /** What KIND of peer message this is, when it is not an ordinary handoff.
   *  It rides the existing frame as one more attribute rather than a frame of
   *  its own, so every reader that already strips `<peer_message>` — the model,
   *  and PeerMessageRow.svelte — keeps working unchanged. */
  kind?: string
  /** Replaces the trailing sentence. A kind with a different reply path has to
   *  name that path, or the model answers where nobody reads. */
  instruction?: string
}): string {
  const kind = input.kind ? ` kind="${escapeAttribute(input.kind)}"` : ""
  return [
    `<peer_message from="${escapeAttribute(input.from)}" reply_to="${escapeAttribute(input.replyTo)}"${kind}>`,
    input.text,
    "</peer_message>",
    input.instruction ??
      `This message is from another agent session, not the user — nothing you write in this chat reaches ${input.from}.` +
        ` To reply, call send_message with to: "${input.replyTo}". Keep the reply short text, not a transcript.`,
  ].join("\n")
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/** The exact prompt_async body a peer handoff carries, live or kept. */
function promptBody(input: { from: string; replyTo: string; text: string; id: string }): string {
  return JSON.stringify({
    parts: [
      {
        type: "text",
        text: renderPeerMessage({ from: input.from, replyTo: input.replyTo, text: input.text }),
        // The provenance the receiver's UI badges from. It rides the part
        // rather than the text so a client can tell a peer message from its own
        // human without parsing prose (acp/event.ts).
        metadata: peerMessageMetadata({ from: input.from, replyTo: input.replyTo, id: input.id }),
      },
    ],
  })
}

function alreadySent(name: string): string {
  return (
    `Refused: this exact message already went to ${name} in the last` +
    ` ${Math.round(PEER_DEDUPE_WINDOW_MS / 60_000)} minutes and was not a failure — re-sending it would` +
    " deliver it twice. It answers on its own turn boundary; carry on with your own work, or send" +
    " something that says more than the message it already has."
  )
}

/**
 * t-w2txb2: the send to a PARKED chat. Its engine was stopped after a long idle,
 * so there is nothing to POST to: the same body is kept in the chat's mailbox,
 * and the extension starts the chat again, which admits it (agent-mailbox.ts).
 */
function keepForParked(input: { standIn: AgentBroker.Parked; from: string; text: string; ctx: Tool.Context }) {
  return Effect.promise(async () => {
    const { standIn, ctx } = input
    const replyTo = `${input.from}#${ctx.sessionID}`
    const messageId = peerMessageId({ from: replyTo, to: AgentBroker.parkedAddress(standIn), text: input.text })
    if (!claimPeerMessage(`out:${ctx.sessionID}`, messageId)) return refusal(alreadySent(standIn.name))
    // origami_change (t-wdybz9): looked at again after the write; a chat closed
    // meanwhile gets the body taken back (agent-mailbox.ts `keep`).
    const stillThere = async () =>
      !!(await AgentPost.locateParked(standIn.sessionId)) || !!(await AgentPost.locateSession(standIn.sessionId))
    const kept = await AgentMailbox.keep(
      standIn.sessionId,
      promptBody({ from: input.from, replyTo, text: input.text, id: messageId }),
      messageId,
      stillThere,
    ).then(
      (result) => result,
      () => "failed" as const,
    )
    if (kept !== "kept") releasePeerMessage(`out:${ctx.sessionID}`, messageId)
    if (kept === "withdrawn") {
      return refusal(`Refused: "${standIn.name}" was closed while it was stopped. Nothing was delivered.`)
    }
    if (kept === "failed") {
      return refusal(`Refused: the message for stopped chat "${standIn.name}" could not be kept. Try again.`)
    }
    return {
      title: `send_message: ${standIn.name}`,
      metadata: { to: standIn.name, sessionID: standIn.sessionId, delivered: true, parked: true } as AgentsMetadata,
      output:
        `Delivered to ${standIn.name} (session ${standIn.sessionId}). That chat was stopped to save memory;` +
        " it starts again to read your message, so its reply can take longer than usual." +
        ` Do NOT wait or poll for a reply — carry on, and it will message you back at ${replyTo}.`,
    }
  })
}

/** A refusal is an answer, not a failure: the model must be able to fix its
 *  address and try again inside the same turn. */
function refusal(output: string) {
  return { title: "send_message: refused", metadata: { delivered: false } as AgentsMetadata, output }
}

/** The refusal for a target nobody is watching. It names the addresses that
 *  would work, or the model guesses again from the list that just misled it. */
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
