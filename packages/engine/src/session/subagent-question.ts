import { AgentBroker } from "@/origami/agent-broker"
import { renderPeerMessage } from "@/tool/agents"
import { AgentPost } from "./agent-post"
import { peerMessageId, peerMessageMetadata } from "./peer-message"

/**
 * A SUB-AGENT'S QUESTION, ROUTED TO THE MAIN AGENT (t-po041k).
 *
 * A child session has no window of its own. Its `question` call used to reach
 * `acp/question.ts`, miss the ACP session store (a child is never registered
 * there) and return, so the ask parked on a Deferred nobody could ever answer
 * and the parent's `task` call froze behind it. The child was silent and the
 * user saw a spinner.
 *
 * The fix routes the question UP, not out: it lands in the parent chat as the
 * same peer-message envelope a handoff arrives in, tagged `sub-agent question`,
 * and the parent's model answers it (or asks the user first, which is what the
 * instruction sentence tells it to do). The user is never asked by a child.
 *
 * IT IS THE EXISTING ENVELOPE, EXTENDED. Same `prompt_async` wire, same
 * `<peer_message>` frame with one more attribute, same `origami_peer` rider with
 * one more field — so a client that knows none of this still renders the message
 * and the model still reads who is speaking. `flock/deliver.ts` made the same
 * trade for the same reason; a second frame would be a second thing to keep in
 * step with PeerMessageRow.svelte.
 *
 * WHERE IT LANDS. The immediate parent is usually right but not always: a
 * grandchild's parent is itself a child with no chat attached. The caller hands
 * in the ancestor chain, nearest first, and the first one an engine has open
 * wins — the same "nobody would read it" rule `flock/deliver.ts` enforces.
 */

/** The row's own words while its question is open. Kept here, beside the
 *  envelope, so the drawer line and the message cannot drift apart. */
export const ASKING_LINE = "asking the main agent"

/** The frame attribute and the badge text. One string, two readers. */
export const QUESTION_KIND = "sub-agent question"

export interface Identity {
  /** The agent type the parent asked for (`Explore`, `general-purpose`, ...). */
  readonly agentType?: string | undefined
  /** This parent's 1-based spawn-order number for the child. 0 = unnumbered. */
  readonly ordinal: number
  /** The parent's own 3-5 word description of the job. */
  readonly description?: string | undefined
}

/**
 * `<type> · T<n> · <description>`, a missing part DROPPED rather than padded.
 *
 * MIRRORS `packages/vscode/webview/dashboard/panes/subagentLabel.ts`
 * (`subagentLabel`/`subagentShort`) — the extension cannot import from the
 * engine, and the envelope has to name the child the same way the drawer row
 * beside it does or the user is told about an agent they cannot find.
 * `test/session/subagent-question.test.ts` asserts the two agree.
 */
export function subagentLabel(identity: Identity): string {
  const short = identity.ordinal >= 1 ? `T${identity.ordinal}` : "T?"
  return [identity.agentType, short, identity.description].filter(Boolean).join(" · ")
}

export interface EnvelopeInput {
  readonly label: string
  /** The child's session id — the origin the parent's reply is aimed at. */
  readonly sessionID: string
  /** The pending question the reply tool resolves. */
  readonly requestID: string
  /** Each question, in the order the child asked them. */
  readonly questions: ReadonlyArray<{ readonly question: string; readonly options?: ReadonlyArray<string> }>
}

/** One question as the parent reads it: the text, then what the child will
 *  accept. The options are named because the reply is matched against them. */
function questionLines(input: EnvelopeInput): string {
  return input.questions
    .map((q, index) => {
      const head = input.questions.length > 1 ? `${index + 1}. ${q.question}` : q.question
      return q.options?.length ? `${head}\n   options: ${q.options.join(" | ")}` : head
    })
    .join("\n")
}

/** The sentence after the frame. It has to say three things a peer handoff does
 *  not: that a CHILD of this chat is waiting, that the child cannot hear this
 *  transcript, and which tool releases it. Without the last one the model
 *  answers into the chat and the child waits for ever. */
function instruction(input: EnvelopeInput): string {
  const count = input.questions.length
  return (
    `This is a QUESTION from ${input.label}, one of this chat's own sub-agents — not from the user.` +
    ` It is blocked until you answer, and it cannot read this transcript.` +
    ` Answer it yourself when you know the answer; ask the user first only when the decision is theirs to make.` +
    ` To release it, call question_reply with request_id "${input.requestID}" and one answer per question` +
    ` (${count} answer${count > 1 ? "s" : ""}, in order).`
  )
}

/** The whole message the parent chat receives. */
export function renderSubagentQuestion(input: EnvelopeInput): string {
  return renderPeerMessage({
    from: input.label,
    // The child's session is the address, so a reader can point at the row that
    // is waiting. It is NOT a send_message address: the instruction below names
    // the tool that actually reaches the child.
    replyTo: input.sessionID,
    kind: QUESTION_KIND,
    text: questionLines(input),
    instruction: instruction(input),
  })
}

export type Outcome =
  | { readonly ok: true; readonly sessionID: string }
  | { readonly ok: false; readonly reason: string }

export interface DeliverInput extends EnvelopeInput {
  /** The child's ancestors, NEAREST FIRST. The first with a chat open wins. */
  readonly ancestors: ReadonlyArray<string>
}

/**
 * Put one child's question into the nearest ancestor chat that can read it.
 *
 * REFUSES RATHER THAN HANGS. A chain with nobody attached is reported back, and
 * `tool/question.ts` turns that into an answer the child can act on — the same
 * choice the permission timeout made: a refusal is a result, an unanswerable
 * wait is not.
 */
export async function deliver(input: DeliverInput, deps: AgentPost.PostDeps = {}): Promise<Outcome> {
  const locate = deps.locate ?? AgentPost.locateSession
  const text = renderSubagentQuestion(input)
  for (const sessionID of input.ancestors) {
    if (!sessionID) continue
    const entry = await locate(sessionID)
    if (!entry) continue
    if (!AgentBroker.isLoopback(entry.httpBase)) continue
    const id = peerMessageId({ from: `subagent:${input.sessionID}`, to: sessionID, text })
    const posted = await (deps.post ?? AgentPost.postPrompt)({
      url: AgentPost.promptUrl(entry, sessionID),
      body: JSON.stringify({
        parts: [
          {
            type: "text",
            text,
            metadata: peerMessageMetadata({
              from: input.label,
              replyTo: input.sessionID,
              id,
              subagent: { label: input.label, requestID: input.requestID, sessionID: input.sessionID },
            }),
          },
        ],
      }),
    })
    if (posted) return { ok: true, sessionID }
  }
  return {
    ok: false,
    reason: "no parent chat is open to read it",
  }
}

export * as SubagentQuestion from "./subagent-question"
