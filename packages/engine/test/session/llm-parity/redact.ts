/**
 * Body redaction shared by every recorder that writes an engine cassette (the
 * parity server and the native recorded test).
 *
 * A body is often not plain JSON: a response is an SSE stream of `data:` lines,
 * and a JSON document can sit escaped inside a string of another one. So the
 * match is on the text, and the quotes around a key and its value may carry any
 * number of backslashes, as long as they carry the same number.
 */

const pair = (keys: string) => new RegExp(String.raw`(\\*")(${keys})\1(\s*:\s*)\1[^"\\]*\1`, "g")

/**
 * OpenAI and Copilot echo `safety_identifier` in every response event. Its value
 * is stable per account (OpenAI: `user-<id>`, Copilot: a hash of the account),
 * so every value is replaced, whatever its form.
 */
const SAFETY_IDENTIFIER = pair("safety_identifier")
const CREDENTIALS = pair("access|access_token|refresh|refresh_token|accountId|account_id")

export const redactRecordedBody = (body: string) =>
  body
    .replace(/wrk_[A-Z0-9]+/g, "wrk_redacted")
    .replace(SAFETY_IDENTIFIER, "$1$2$1$3$1user_redacted$1")
    .replace(CREDENTIALS, "$1$2$1$3$1redacted$1")
