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
 * The sidebar's Zen preset wrote its block under `opencode-zen`, but the baked
 * catalog names that provider `opencode` and every Zen feature gate keys off
 * `ProviderV2.ID.opencode`, so a key connected through the sidebar silently
 * missed the Zen-only features. This folds over the blocks already on disk.
 *
 * Conservative: it renames the KEY TOKEN ONLY, as one offset-based edit, so
 * comments, key order and line endings survive byte-for-byte; it does nothing
 * if a `provider["opencode"]` already exists in ANY candidate file, because the
 * user's explicit block should stand; it backs the file up to
 * `<file>.zen-provider.bak` and never overwrites an existing backup; and it is
 * best-effort, since an unreadable config directory must not fail the load.
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

/** Rewrite `provider["opencode-zen"]`'s KEY to `"opencode"`, leaving every other
 *  byte alone. `undefined` when there is nothing to rename. */
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
