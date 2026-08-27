/**
 * Structural repair for model-emitted tool arguments.
 *
 * The dominant tool-call failure is not a bad value, it is a bad SHAPE: the
 * model wraps the real arguments in `{"arguments": {...}}` (sometimes twice),
 * hands the payload back as a JSON string, or renames a camelCase key to
 * snake_case. Every rule below rearranges what the model already sent — none
 * of them invents content.
 *
 * Syntactic repair of malformed or truncated JSON is deliberately NOT done,
 * for any tool. A "repaired" shell command that happens to satisfy the schema
 * is a wrong command handed to a shell, so unparseable input is reported back
 * to the model instead of guessed at.
 *
 * The caller is Tool.wrap, and it is the ONLY validation seam either runtime
 * has: the AI SDK builds tools with `jsonSchema(plainObject)`, whose `validate`
 * is undefined, so it rejects unparseable JSON and passes every shape error
 * through untouched (test/tool/normalize.test.ts measures this).
 */

export type Options = {
  /**
   * Top-level property names the tool declares, from `parameterKeys`. A key is
   * renamed only when its canonical form matches exactly one of these, so
   * aliasing can never introduce a key the tool does not accept — and never a
   * key that belongs to some other tool. Absent means alias nothing: a rename
   * decided without the tool's own parameters is a guess.
   */
  keys?: readonly string[]
}

const WRAPPER_KEY = "arguments"
// Observed nesting is one or two deep; the bound just stops a pathological payload.
const MAX_UNWRAP = 4

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * The comparison form of a key name: separators dropped, case folded, so
 * `x_labels`, `x-labels`, `X Labels` and `xlabels` all reduce to `xlabels`.
 * Renames are decided on THIS against the tool's declared names. Matching on
 * the underscore alone closed one spelling of the mistake and left the rest —
 * a kebab or run-together rename reached the decoder unaliased, and for a tool
 * whose fields are optional it was then dropped in silence.
 */
function canonical(key: string) {
  return key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()
}

/**
 * canonical form → the ONE name that owns it. A form two names share owns
 * nothing: a rename with two candidates is a guess, so it is not made.
 */
function byCanonical(names: readonly string[]) {
  const owners = new Map<string, string | undefined>()
  for (const name of names) {
    const form = canonical(name)
    owners.set(form, owners.has(form) ? undefined : name)
  }
  return owners
}

function unwrap(input: Record<string, unknown>) {
  let current = input
  for (let depth = 0; depth < MAX_UNWRAP; depth++) {
    const names = Object.keys(current)
    // Sole key only: merging a wrapper with sibling keys would be a guess.
    if (names.length !== 1 || names[0] !== WRAPPER_KEY) return current
    const inner = current[WRAPPER_KEY]
    const next = isRecord(inner) ? inner : typeof inner === "string" ? parseObject(inner) : undefined
    if (!next) return current
    current = next
  }
  return current
}

function unalias(input: Record<string, unknown>, keys: readonly string[]) {
  const declared = byCanonical(keys)
  // Two sent keys reducing to one declared name would silently overwrite each
  // other, and which one survived would be an accident of key order — so that
  // form claims neither of them.
  const claimants = byCanonical(Object.keys(input))
  let changed = false
  const entries = Object.entries(input).map(([key, value]) => {
    const target = declared.get(canonical(key))
    // Never overwrite a key the model actually sent under its real name, and
    // never rename while a second sent key is competing for the same target.
    if (target === undefined || target === key || target in input || claimants.get(canonical(key)) !== key)
      return [key, value] as const
    changed = true
    return [target, value] as const
  })
  // fromEntries defines own properties, so a literal `__proto__` key survives
  // as data instead of reassigning the prototype and vanishing.
  return changed ? Object.fromEntries(entries) : input
}

/**
 * Returns the same reference when there is nothing to repair, so callers can
 * test `result === args` to learn whether normalisation changed anything.
 */
export function normalizeToolInput(args: unknown, opts: Options = {}): unknown {
  if (typeof args === "string") {
    const parsed = parseObject(args)
    return parsed ? normalizeToolInput(parsed, opts) : args
  }
  if (!isRecord(args)) return args
  const keys = opts.keys ?? []
  // A tool that really declares an `arguments` parameter is not being wrapped.
  return unalias(keys.includes(WRAPPER_KEY) ? args : unwrap(args), keys)
}

function properties(schema: unknown) {
  return isRecord(schema) && isRecord(schema.properties) ? schema.properties : undefined
}

function required(schema: unknown): string[] {
  if (!isRecord(schema) || !Array.isArray(schema.required)) return []
  return schema.required.filter((name): name is string => typeof name === "string")
}

/**
 * The tool's own top-level parameter names, for `Options.keys`. Reading them
 * from the tool being called is what keeps aliasing correct per tool: chart
 * gets `x_labels` → `xLabels`, and bash — which declares no camelCase key —
 * gets no rename at all. Empty when the schema describes no properties.
 */
export function parameterKeys(schema: unknown): readonly string[] {
  return Object.keys(properties(schema) ?? {})
}

/**
 * Top-level keys of a payload the tool does not declare, for a tool that wants
 * to refuse rather than let the decoder drop them. Empty when there is nothing
 * to judge — a non-object payload, or a tool whose parameters could not be read
 * — because refusing against an unknown key list would refuse every call.
 */
export function unrecognisedKeys(args: unknown, keys: readonly string[]): readonly string[] {
  if (!isRecord(args) || keys.length === 0) return []
  return Object.keys(args).filter((key) => !keys.includes(key))
}

/**
 * The declared key an unrecognised one probably meant: the single declared name
 * whose canonical form contains, or is contained by, the one sent. `labels`
 * finds `xLabels`; a form that matches two declared names, or none, suggests
 * nothing rather than guessing.
 */
function nearest(name: string, declared: readonly string[]): string | undefined {
  const form = canonical(name)
  if (form.length < 3) return undefined
  const hits = declared.filter((candidate) => {
    const other = canonical(candidate)
    return other.includes(form) || form.includes(other)
  })
  return hits.length === 1 ? hits[0] : undefined
}

/**
 * The corrective message handed back to the model when a call cannot be
 * rescued. It names the tool, the exact flat key names it expects, and which
 * of them are missing or unrecognised — enough to fix the call on the next
 * attempt. Returns "" when the schema carries no properties to describe.
 *
 * `received` is the payload AS THE DECODER SAW IT, never as it arrived: the
 * wrapper is gone and the aliases are applied by then, so counting on the
 * payload as sent reports keys the model got right as missing (`{"arguments":
 * {filePath, content}}` named both of them missing and `arguments`
 * unrecognised) and a JSON-string payload as carrying no keys at all. An
 * unrecognised key is still quoted in the model's own spelling, because
 * aliasing only ever produces a key the tool DECLARES — so a key that reaches
 * this list was never renamed.
 */
export function describeExpectedInput(tool: string, schema: unknown, received: unknown): string {
  const props = properties(schema)
  if (!props || Object.keys(props).length === 0) return ""
  const req = new Set(required(schema))
  const names = Object.keys(props)
  const expected = Object.entries(props).map(([name, property]) => {
    const type = isRecord(property) && typeof property.type === "string" ? `${property.type}, ` : ""
    return `${name} (${type}${req.has(name) ? "required" : "optional"})`
  })
  const sent = isRecord(received) ? Object.keys(received) : []
  const missing = [...req].filter((name) => !sent.includes(name))
  const unexpected = sent.filter((name) => !(name in props))
  const guesses = unexpected
    .map((name) => [name, nearest(name, names)] as const)
    .filter((pair): pair is readonly [string, string] => pair[1] !== undefined)
  return [
    `The ${tool} tool expects its arguments as flat top-level JSON keys: ${expected.join(", ")}.`,
    missing.length > 0 ? ` Missing required keys: ${missing.join(", ")}.` : "",
    unexpected.length > 0 ? ` Unrecognised keys: ${unexpected.join(", ")}.` : "",
    guesses.length > 0
      ? ` Did you mean ${guesses.map(([name, target]) => `${target} instead of ${name}`).join(", ")}?`
      : "",
    ` Send each key at the top level under the exact name above; do not wrap them in an "arguments" object and do not rename them.`,
  ].join("")
}

export * as ToolNormalize from "./normalize"
