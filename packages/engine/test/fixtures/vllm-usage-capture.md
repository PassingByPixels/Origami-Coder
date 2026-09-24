# Raw vLLM usage capture — t-ffziaz

Server: `http://192.0.2.10:8000/v1`, model `Qwen/Qwen3.8-Flash-Next`,
`system_fingerprint: vllm-0.29.0-tp2-f44e938d`, `max_model_len` 262144.
Captured 2026-09-16 with `urllib` (no proxy, no client library in the way).
Nothing is redacted; these responses carry no secrets.

The question: does this server report `prompt_tokens_details.cached_tokens`, so the
engine can read it into `cache.read`?

**Answer: no. This build never emits `prompt_tokens_details` at all, on any of the
four request shapes below, even on a request the server's own metrics record as an
11,312-token prefix-cache hit.**

## Capture A — streaming, `stream_options: {include_usage: true}`

Body: system message = a 3,260-token repeated sentence, user = "Reply with the single
word OK.", `max_tokens: 8`, `temperature: 0`. Sent twice, byte-identical.

Request 1, final SSE chunk before `data: [DONE]`:

```json
{
  "id": "chatcmpl-b332e811b65c4317",
  "object": "chat.completion.chunk",
  "created": 1789588651,
  "model": "Qwen/Qwen3.8-Flash-Next",
  "choices": [],
  "usage": {
    "prompt_tokens": 3260,
    "total_tokens": 3268,
    "completion_tokens": 8,
    "completion_tokens_details": {
      "reasoning_tokens": 8
    }
  },
  "system_fingerprint": "vllm-0.29.0-tp2-f44e938d"
}
```

Request 2 (identical prefix, one second later — the cache-hit case):

```json
{
  "id": "chatcmpl-b4e615222e9fc03e",
  "object": "chat.completion.chunk",
  "created": 1789588652,
  "model": "Qwen/Qwen3.8-Flash-Next",
  "choices": [],
  "usage": {
    "prompt_tokens": 3260,
    "total_tokens": 3268,
    "completion_tokens": 8,
    "completion_tokens_details": {
      "reasoning_tokens": 8
    }
  },
  "system_fingerprint": "vllm-0.29.0-tp2-f44e938d"
}
```

`completion_tokens_details` IS present. `prompt_tokens_details` is absent from the
object — not null, not zero: the key does not exist.

## Capture B — streaming, NO `stream_options`

Same body with `stream_options` removed. 5 SSE data lines, and no chunk carries a
`usage` object at all:

```
NO usage in any tail chunk; scanning all: False
```

So `stream_options: {include_usage: true}` is required for any usage on this server.
The native runtime already sends it: `packages/llm/src/protocols/openai-chat.ts:447`.

## Capture C — non-streaming

```json
{
  "prompt_tokens": 3260,
  "total_tokens": 3268,
  "completion_tokens": 8,
  "prompt_tokens_details": null,
  "completion_tokens_details": {
    "reasoning_tokens": 8
  }
}
```

Here the key exists and is explicitly `null`. That is the decisive line: the server
serialises the field and has nothing to put in it.

## Capture D — prefix-cache hit proven against `/metrics`

Same shape, a 14,456-token prompt, non-streaming, sent twice. `/metrics` read
immediately before and after each call:

```
metrics before:  prefix_cache_queries_total 1.33732472e+08  prefix_cache_hits_total 1.17552688e+08
call A usage:    {"prompt_tokens": 14456, "total_tokens": 14460, "completion_tokens": 4,
                  "prompt_tokens_details": null, "completion_tokens_details": {"reasoning_tokens": 4}}
metrics after A: prefix_cache_queries_total 1.33746928e+08  prefix_cache_hits_total 1.17554304e+08
call B usage:    {"prompt_tokens": 14456, "total_tokens": 14460, "completion_tokens": 4,
                  "prompt_tokens_details": null, "completion_tokens_details": {"reasoning_tokens": 4}}
metrics after B: prefix_cache_queries_total 1.33761384e+08  prefix_cache_hits_total 1.17565616e+08
```

Call B: queries +14,456, hits **+11,312** — a 78% prefix-cache hit on that one
request, while the response it returned says `prompt_tokens_details: null`.

The response's other optional carriers are empty too — `metrics`, `kv_transfer_params`,
`service_tier` and `prompt_logprobs` all came back `null` on the same call, so there is
no second place the figure is hiding.

## What this means for the engine

The engine reads the field correctly on both runtimes; nothing in the chain drops it:

| hop | file | behaviour when `cached_tokens` is present |
| --- | --- | --- |
| native wire schema | `packages/llm/src/protocols/openai-chat.ts:130` | `prompt_tokens_details.cached_tokens` is declared |
| native usage map | `packages/llm/src/protocols/openai-chat.ts:475-487` | `cacheReadInputTokens: cached` |
| AI-SDK provider | `@ai-sdk/openai-compatible@2.0.41` dist line 68 | `cacheRead = prompt_tokens_details?.cached_tokens ?? 0` |
| AI-SDK core | `ai@6.0.168` dist line 2429/2443 | flattens to `inputTokenDetails.cacheReadTokens` / `cachedInputTokens` |
| engine AI-SDK bridge | `packages/engine/src/session/llm/ai-sdk.ts:197` | `cacheReadInputTokens: inputTokenDetails?.cacheReadTokens ?? cachedInputTokens` |
| engine usage | `packages/engine/src/session/session.ts:560,589` | `cache.read = cacheReadInputTokens` |

The owner's `vllm` provider is declared `"npm": "@ai-sdk/openai-compatible"` in
`~/.config/origami/origami.json`, and `packages/engine/src/session/llm/native-route.ts`
has `"openai-compatible": true` in `DEFAULTS`, so that provider runs on the NATIVE
runtime. Both runtimes are covered by the tests in
`packages/engine/test/session/cache-read-usage.test.ts`.

`cache.read = 0` on every step against this server is therefore the server's silence,
not an engine defect. It cannot be fixed inside the engine. Fixing it means either a
vLLM build that fills `prompt_tokens_details.cached_tokens` from its `num_cached_tokens`,
or a server-side flag on the owner's Spark lane — neither is an engine change and
neither is in this lane's scope.
