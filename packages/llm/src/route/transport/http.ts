import { Effect, Stream } from "effect"
import { Headers, HttpClientRequest } from "effect/unstable/http"
import { Auth } from "../auth"
import { render as renderEndpoint } from "../endpoint"
import { Framing, type Framing as FramingDef } from "../framing"
import type { Transport, TransportPrepareInput } from "./index"
import * as ProviderShared from "../../protocols/shared"
import { mergeJsonRecords, type LLMRequest } from "../../schema"

export type JsonRequestInput<Body> = TransportPrepareInput<Body>

export interface JsonRequestParts<Body = unknown> {
  readonly url: string
  readonly jsonBody: Body | Record<string, unknown>
  readonly bodyText: string
  readonly headers: Headers.Headers
}

export interface HttpPrepared<Frame> {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly framing: FramingDef<Frame>
}

const applyQuery = (url: string, query: Record<string, string> | undefined) => {
  if (!query) return url
  const next = new URL(url)
  Object.entries(query).forEach(([key, value]) => next.searchParams.set(key, value))
  return next.toString()
}

// The body fields a protocol OWNS are per protocol AND per request: a key is
// owned only when the protocol that is actually sending this request lists it
// as structure (`ProtocolBody.structure`) AND wrote it into the body it just
// built. An overlay naming an owned key would rewrite the request's structure,
// so it still fails loudly.
//
// A key the protocol did not write this time is NOT owned even if it is in the
// protocol's vocabulary: `thinking` is Anthropic structure, but on an
// OpenAI-compatible server it is just an extra a GLM/zai block sets, and even
// on Anthropic it is free when reasoning is off. One global denylist refused it
// everywhere, which broke those blocks on every prompt.
//
// Deliberately never structure: the sampling knobs (temperature, top_p, top_k,
// frequency_penalty, presence_penalty, seed, stop, ...) and any server extra
// (chat_template_kwargs, repetition_penalty, min_p, ...). A provider block on
// this box sets `frequency_penalty: 0` on its vLLM models, and the AI SDK path
// always passed such keys through verbatim - the overlay spread AFTER the
// standard settings, so a configured knob won. Refusing them took the whole
// OpenAI-compatible family down on the first turn. The overlay therefore wins
// on a sampling key, exactly as before the cutover.
const ownedBodyKeys = (body: unknown, structure: ReadonlyArray<string>) => {
  const written = ProviderShared.isRecord(body) ? body : {}
  return new Set(structure.filter((key) => written[key] !== undefined))
}

const forbiddenBodyOverlayKeys = (overlay: Record<string, unknown>, owned: ReadonlySet<string>) =>
  Object.keys(overlay).filter((key) => owned.has(key))

const bodyWithOverlay = <Body>(
  body: Body,
  request: LLMRequest,
  encodeBody: (body: Body) => string,
  structure: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    if (request.http?.body === undefined) return { jsonBody: body, bodyText: encodeBody(body) }
    const forbiddenKeys = forbiddenBodyOverlayKeys(request.http.body, ownedBodyKeys(body, structure))
    if (forbiddenKeys.length > 0)
      return yield* ProviderShared.invalidRequest(
        `http.body cannot overlay protocol-owned field(s): ${forbiddenKeys.join(", ")}`,
      )
    if (ProviderShared.isRecord(body)) {
      const overlaid = mergeJsonRecords(body, request.http.body) ?? {}
      return { jsonBody: overlaid, bodyText: ProviderShared.encodeJson(overlaid) }
    }
    return yield* ProviderShared.invalidRequest("http.body can only overlay JSON object request bodies")
  })

export const jsonRequestParts = <Body>(input: JsonRequestInput<Body>) =>
  Effect.gen(function* () {
    const url = applyQuery(
      renderEndpoint(input.endpoint, { request: input.request, body: input.body }).toString(),
      input.request.http?.query,
    )
    const body = yield* bodyWithOverlay(input.body, input.request, input.encodeBody, input.bodyStructure)
    const headers = yield* Auth.toEffect(input.auth)({
      request: input.request,
      method: "POST",
      url,
      body: body.bodyText,
      headers: Headers.fromInput({
        ...input.headers?.({ request: input.request }),
        ...input.request.http?.headers,
      }),
    })
    return { url, jsonBody: body.jsonBody, bodyText: body.bodyText, headers }
  })

export interface HttpJsonInput<_Body, Frame> {
  readonly framing: FramingDef<Frame>
}

export type HttpJsonPatch<Body, Frame> = Partial<HttpJsonInput<Body, Frame>>

export interface HttpJsonTransport<Body, Frame> extends Transport<Body, HttpPrepared<Frame>, Frame> {
  readonly with: (patch: HttpJsonPatch<Body, Frame>) => HttpJsonTransport<Body, Frame>
}

export const httpJson = <Body, Frame>(input: HttpJsonInput<Body, Frame>): HttpJsonTransport<Body, Frame> => ({
  id: "http-json",
  with: (patch) => httpJson({ ...input, ...patch }),
  prepare: (prepareInput) =>
    jsonRequestParts({
      ...prepareInput,
    }).pipe(
      Effect.map((parts) => ({
        request: ProviderShared.jsonPost({ url: parts.url, body: parts.bodyText, headers: parts.headers }),
        framing: input.framing,
      })),
    ),
  frames: (prepared, request, runtime) =>
    Stream.unwrap(
      runtime.http
        .execute(prepared.request)
        .pipe(
          Effect.map((response) =>
            prepared.framing.frame(
              response.stream.pipe(
                Stream.mapError((error) =>
                  ProviderShared.eventError(
                    `${request.model.provider}/${request.model.route.id}`,
                    `Failed to read ${request.model.provider}/${request.model.route.id} stream`,
                    ProviderShared.errorText(error),
                  ),
                ),
              ),
            ),
          ),
        ),
    ),
})

export const sseJson = {
  id: "http-json/sse",
  with: <Body>() => httpJson<Body, string>({ framing: Framing.sse }),
} as const
