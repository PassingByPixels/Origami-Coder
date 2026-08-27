import path from "path"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { applyEdits, findNodeAtLocation, parseTree, type ParseError } from "jsonc-parser"

/** The id the VS Code sidebar used to write for an OpenCode Zen connection. */
const LEGACY_ID = "opencode-zen"
/** The id the engine's baked models.dev catalog actually uses for that provider. */
const CATALOG_ID = "opencode"

/** Global config candidates, in `Config.loadGlobal`'s merge order (later wins). */
const CANDIDATES = ["config.json", "origami.json", "origami.jsonc"]

const BACKUP_SUFFIX = ".zen-provider.bak"

/**
 * Fold a legacy `provider["opencode-zen"]` block over to `provider["opencode"]`.
 *
 * WHY: the sidebar's Zen preset used to write its block under the id
 * `opencode-zen`, but the engine's baked catalog names that provider `opencode`
 * and every Zen feature gate keys off `ProviderV2.ID.opencode`. A key connected
 * through the sidebar therefore chatted fine and silently missed the Zen-only
 * features (web search, small-model selection) — the id never met the gate.
 * The extension now writes `opencode`; this folds over the blocks already on
 * disk so existing users get the features without re-pasting a key.
 *
 * Conservative in four ways:
 *
 *  - It renames the KEY TOKEN ONLY, as a single offset-based edit. The value
 *    block is never re-serialized, so comments, key order, indentation, blank
 *    lines, trailing commas, CRLF — all survive byte-for-byte. Round-tripping
 *    the value through `JSON.stringify` would have eaten every comment in it.
 *  - It does nothing at all if a `provider["opencode"]` already exists in ANY
 *    candidate file. Two definitions of one provider is a worse state than the
 *    one being fixed, and which of them wins depends on merge order the user
 *    cannot see. Their explicit `opencode` block is the one that should stand.
 *  - It backs the file up to `<file>.zen-provider.bak` before writing, and
 *    never overwrites an existing backup — so a second run cannot destroy the
 *    copy taken by the first.
 *  - It is best-effort. A config directory that cannot be read or written is
 *    not a reason to fail the load; the caller's merge still reads what is
 *    actually on disk, and an unmigrated block is exactly today's behaviour.
 *
 * Returns a log line per file changed, or `undefined` when nothing was touched.
 */
export function migrateZenProviderId(dir: string): string | undefined {
  try {
    const files = CANDIDATES.map((name) => path.join(dir, name)).filter((file) => existsSync(file))
    const sources = new Map<string, string>()
    for (const file of files) sources.set(file, readFileSync(file, "utf8"))

    // Their own `opencode` block wins outright — anywhere in the merge.
    for (const text of sources.values()) if (hasProvider(text, CATALOG_ID)) return undefined

    const messages: string[] = []
    for (const [file, text] of sources) {
      const next = renameProviderKey(text)
      if (!next) continue
      const backup = file + BACKUP_SUFFIX
      if (!existsSync(backup)) writeFileSync(backup, text)
      writeFileSync(file, next)
      messages.push(`renamed provider "${LEGACY_ID}" to "${CATALOG_ID}" in ${file} (backup: ${backup})`)
    }
    return messages.length ? messages.join("; ") : undefined
  } catch {
    return undefined
  }
}

/** Parse `text` as JSONC, or `undefined` if it is malformed. Never guesses. */
function tree(text: string) {
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { allowTrailingComma: true })
  if (errors.length) return undefined
  return root
}

function hasProvider(text: string, id: string): boolean {
  const root = tree(text)
  return !!root && !!findNodeAtLocation(root, ["provider", id])
}

/**
 * Rewrite `provider["opencode-zen"]`'s KEY to `"opencode"`, leaving every other
 * byte alone. `undefined` when there is nothing to rename.
 */
function renameProviderKey(text: string): string | undefined {
  const root = tree(text)
  if (!root) return undefined
  const value = findNodeAtLocation(root, ["provider", LEGACY_ID])
  // `value.parent` is the property node; its first child is the key token, and
  // a string node's offset/length span the surrounding quotes.
  const key = value?.parent?.children?.[0]
  if (!key || key.type !== "string") return undefined
  return applyEdits(text, [{ offset: key.offset, length: key.length, content: JSON.stringify(CATALOG_ID) }])
}
