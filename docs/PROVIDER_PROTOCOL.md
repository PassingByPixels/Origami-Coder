# Custom providers: declare the protocol

A custom provider in `origami.json` needs two facts: the wire protocol it speaks
and the base URL of its endpoint. Set the protocol with the `protocol` key.

Origami does not download provider packages. The client for each protocol is
part of the build. An `npm` value that is not one of the packages in the build
now fails when the model loads. The error names the `protocol` key and the
accepted values.

## Accepted values

| `protocol`           | The API the server must speak                            |
| -------------------- | -------------------------------------------------------- |
| `openai-chat`        | OpenAI Chat Completions (`POST <base>/chat/completions`) |
| `openai-responses`   | OpenAI Responses (`POST <base>/responses`)               |
| `anthropic-messages` | Anthropic Messages (`POST <base>/messages`)              |
| `gemini`             | Google Gemini generateContent                            |
| `bedrock-converse`   | AWS Bedrock Converse                                     |

## Where to put it

Put `protocol` on the provider block. All models of that provider then use it.
Put `protocol` in a model's `provider` block to override the provider value for
that one model.

Do not set `protocol` and `npm` in the same block. That is a config error.

## The base URL

Give the endpoint with `api` on the provider block, or with `options.baseURL`.
`options.baseURL` wins. Each model can also set `provider.api` for its own URL.

## Authentication

Set the key with `options.apiKey`, or name the environment variables in `env`.
Each protocol sends the key the way its API expects it:

- `openai-chat` and `openai-responses` send `Authorization: Bearer <key>`.
- `anthropic-messages` sends `x-api-key: <key>`.
- `gemini` sends the Google key header.
- `bedrock-converse` sends a bearer token from `options.apiKey`. AWS SigV4
  signing from a credential chain (profile, IAM role, web identity) belongs to
  the built-in `amazon-bedrock` provider. A provider with your own id does not
  get it.

## Examples

One example for each protocol. Change the URL, the key and the model id.

```json
{
  "provider": {
    "my-vllm": {
      "name": "My vLLM server",
      "protocol": "openai-chat",
      "api": "http://127.0.0.1:8000/v1",
      "options": { "apiKey": "sk-local" },
      "models": {
        "qwen3-32b": { "limit": { "context": 131072, "output": 8192 } }
      }
    },

    "my-openai-proxy": {
      "name": "My OpenAI proxy",
      "protocol": "openai-responses",
      "api": "https://proxy.example.com/v1",
      "env": ["MY_PROXY_KEY"],
      "models": { "gpt-5.2": { "limit": { "context": 400000, "output": 128000 } } }
    },

    "my-claude-gateway": {
      "name": "My Claude gateway",
      "protocol": "anthropic-messages",
      "api": "https://gateway.example.com/v1",
      "env": ["MY_GATEWAY_KEY"],
      "models": { "claude-sonnet-4-6": { "limit": { "context": 200000, "output": 64000 } } }
    },

    "my-gemini": {
      "name": "My Gemini endpoint",
      "protocol": "gemini",
      "api": "https://generativelanguage.googleapis.com/v1beta",
      "env": ["GOOGLE_GENERATIVE_AI_API_KEY"],
      "models": { "gemini-3-pro": { "limit": { "context": 1000000, "output": 65536 } } }
    },

    "my-bedrock": {
      "name": "My Bedrock account",
      "protocol": "bedrock-converse",
      "options": { "region": "eu-central-1", "apiKey": "my-bedrock-bearer-token" },
      "models": {
        "anthropic.claude-sonnet-4-6": { "limit": { "context": 200000, "output": 64000 } }
      }
    }
  }
}
```

A model can speak a different protocol from its provider:

```json
{
  "provider": {
    "my-gateway": {
      "protocol": "openai-chat",
      "api": "https://gateway.example.com/v1",
      "models": {
        "claude-sonnet-4-6": { "provider": { "protocol": "anthropic-messages" } }
      }
    }
  }
}
```

## Old configurations

`npm` is still accepted, so a configuration that names a package that is part of
the build keeps working. Any other package now fails at model load. Replace it
with the `protocol` key for the API that server speaks.

Three providers in the shipped catalog name a package that is not in the build.
They no longer load:

- `aihubmix` (`@aihubmix/ai-sdk-provider`)
- `sap-ai-core` (`@jerome-benoit/sap-ai-provider-v2`)
- `merge-gateway` (`merge-gateway-ai-sdk-provider`)

If one of these endpoints speaks an API in the table above, declare it as a
custom provider with `protocol` and the endpoint URL.
