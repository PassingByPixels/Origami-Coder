#!/usr/bin/env bun
// verify-comment-only.ts — proves a git diff changed ONLY comments and whitespace.
//
// Gate for comment-hygiene lanes: compares base vs head for every changed
// .ts/.tsx/.svelte file by tokenising both with the TypeScript compiler API
// and diffing the token streams (comments and whitespace are trivia, so the
// full-fidelity AST walk never sees them — only real code tokens land in the
// stream). Any added/deleted/renamed/untracked file, or a modified file of
// any other type, fails immediately. Any real token difference fails naming
// the first mismatch.
//
// Usage: bun scripts/verify-comment-only.ts [--base <ref>=master] [--dir <worktree>=.]

import * as ts from "typescript"
import * as path from "path"
import { execFileSync } from "child_process"
import { readFileSync } from "fs"

const USAGE = "Usage: bun scripts/verify-comment-only.ts [--base <ref>=master] [--dir <worktree>=.]"

// `git show <base>:<path>` returns the blob as stored (this repo's
// core.autocrlf normalises storage to LF) while the working-tree file is
// CRLF. Left alone, a multi-line token that embeds a literal line break in
// its own text — a JSDoc block, a multi-line template literal chunk — would
// carry different raw bytes on each side for identical content, and fail
// the gate on line endings alone. Normalising both sides to LF right after
// reading, before anything else touches the text, makes every downstream
// offset (script-block spans, masking, line/col) consistent by
// construction — there is no separate remapping step to keep in sync.
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n")
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// CLI args

interface Args {
  base: string
  dir: string
}

function parseArgs(argv: string[]): Args {
  let base = "master"
  let dir = "."
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--base") {
      const value = argv[++i]
      if (value === undefined) fail(`--base needs a value\n${USAGE}`)
      base = value
    } else if (arg === "--dir") {
      const value = argv[++i]
      if (value === undefined) fail(`--dir needs a value\n${USAGE}`)
      dir = value
    } else {
      fail(`unknown argument: ${arg}\n${USAGE}`)
    }
  }
  return { base, dir }
}

// ---------------------------------------------------------------------------
// git plumbing

function runGit(dir: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8" })
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string }
    const detail = typeof e.stderr === "string" ? e.stderr : e.stderr instanceof Buffer ? e.stderr.toString("utf8") : (e.message ?? String(err))
    fail(`git ${args.join(" ")} failed: ${detail}`)
  }
}

interface DiffEntry {
  status: string // single letter: A, M, D, R, C, T, U
  path: string
  oldPath?: string
}

function parseNameStatus(output: string): DiffEntry[] {
  const entries: DiffEntry[] = []
  for (const raw of output.split("\n")) {
    const line = raw.trimEnd()
    if (!line) continue
    const parts = line.split("\t")
    const statusField = parts[0] ?? ""
    const letter = statusField.charAt(0)
    if (letter === "R" || letter === "C") {
      entries.push({ status: letter, oldPath: parts[1] ?? "", path: parts[2] ?? "" })
    } else {
      entries.push({ status: letter, path: parts[1] ?? "" })
    }
  }
  return entries
}

function gitShow(dir: string, base: string, filePath: string): string {
  try {
    return execFileSync("git", ["show", `${base}:${filePath}`], { cwd: dir, encoding: "utf8" })
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string }
    const detail = typeof e.stderr === "string" ? e.stderr : e.stderr instanceof Buffer ? e.stderr.toString("utf8") : (e.message ?? String(err))
    fail(`git show ${base}:${filePath} failed: ${detail}`)
  }
}

// ---------------------------------------------------------------------------
// TS/TSX tokenising — full-fidelity leaf-token walk.
//
// Why not the raw scanner loop: ts.createScanner alone does not track parse
// context, so telling a regex literal from a divide, or a template
// substitution's closing `}` from an ordinary brace, needs the parser's
// grammar. ts.createSourceFile already resolves that; walking the resulting
// tree down to its leaves (nodes with no children) and reading
// node.getText() — which starts at getStart(), skipping the node's leading
// trivia — yields exactly the real code tokens, with comments and
// whitespace never appearing at all.

interface Token {
  kind: number
  text: string
  line: number
  col: number
  start: number
  end: number
}

// getChildren() attaches a declaration's JSDoc (`/** ... */`) as a real
// child subtree (Node.jsDoc), so without this check its structured tags and
// text nodes would walk down to "leaf tokens" of their own — turning a
// comment into code for comparison purposes. A JSDoc block IS a comment, so
// it and everything under it is skipped outright, never recursed into and
// never pushed as a token; it falls into the gap between the surrounding
// real tokens instead, where collectCommentLines picks it up as ordinary
// trivia (correct — that's what it is).
function isJSDocNode(kind: ts.SyntaxKind): boolean {
  return (kind >= ts.SyntaxKind.FirstJSDocNode && kind <= ts.SyntaxKind.LastJSDocNode) || kind === ts.SyntaxKind.JSDoc
}

function collectLeafTokens(sourceFile: ts.SourceFile): Token[] {
  const tokens: Token[] = []
  function visit(node: ts.Node): void {
    if (isJSDocNode(node.kind)) return
    const children = node.getChildren(sourceFile)
    if (children.length === 0) {
      if (node.kind === ts.SyntaxKind.EndOfFileToken) return
      const start = node.getStart(sourceFile)
      const end = node.getEnd()
      const pos = sourceFile.getLineAndCharacterOfPosition(start)
      tokens.push({ kind: node.kind, text: node.getText(sourceFile), line: pos.line + 1, col: pos.character + 1, start, end })
      return
    }
    for (const child of children) visit(child)
  }
  visit(sourceFile)
  return tokens
}

function lineStartOffset(text: string, offset: number): number {
  const idx = text.lastIndexOf("\n", offset - 1)
  return idx === -1 ? 0 : idx + 1
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") line++
  }
  return line
}

function markCommentRange(text: string, range: ts.CommentRange, lines: Set<number>): void {
  const lineStart = lineStartOffset(text, range.pos)
  const before = text.slice(lineStart, range.pos)
  const startsLine = /^[ \t]*$/.test(before)
  const startLine = lineNumberAt(text, range.pos)
  if (range.kind === ts.SyntaxKind.SingleLineCommentTrivia) {
    if (startsLine) lines.add(startLine)
    return
  }
  // Multi-line block comment: the opening line counts only if the comment
  // is the first non-whitespace thing on it (spec: "trimmed text starts
  // with /*"); every interior/closing line counts unconditionally (spec:
  // "sits inside a block comment").
  if (startsLine) lines.add(startLine)
  const endLine = lineNumberAt(text, Math.max(range.pos, range.end - 1))
  for (let ln = startLine + 1; ln <= endLine; ln++) lines.add(ln)
}

function collectCommentLines(text: string, tokens: Token[]): Set<number> {
  const lines = new Set<number>()
  let prevEnd = 0
  for (const t of tokens) {
    if (t.start > prevEnd) {
      const ranges = ts.getLeadingCommentRanges(text, prevEnd)
      if (ranges) for (const r of ranges) markCommentRange(text, r, lines)
    }
    prevEnd = t.end
  }
  if (text.length > prevEnd) {
    const ranges = ts.getLeadingCommentRanges(text, prevEnd)
    if (ranges) for (const r of ranges) markCommentRange(text, r, lines)
  }
  return lines
}

interface Analysis {
  tokens: Token[]
  commentLines: Set<number>
}

function analyzeTs(text: string, scriptKind: ts.ScriptKind): Analysis {
  const sourceFile = ts.createSourceFile("verify-comment-only.ts", text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, scriptKind)
  const tokens = collectLeafTokens(sourceFile)
  const commentLines = collectCommentLines(text, tokens)
  return { tokens, commentLines }
}

// First index where the two token streams diverge, or null if identical.
function findFirstDiff(a: Token[], b: Token[]): number | null {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const ta = a[i]!
    const tb = b[i]!
    if (ta.kind !== tb.kind || ta.text !== tb.text) return i
  }
  if (a.length !== b.length) return len
  return null
}

function reportTokenMismatch(file: string, baseTokens: Token[], headTokens: Token[], index: number): never {
  const baseTok = baseTokens[index]
  const headTok = headTokens[index]
  const baseSide = baseTok ? `${baseTok.line}:${baseTok.col} ${JSON.stringify(baseTok.text)}` : `(end of file — head has ${headTokens.length - baseTokens.length} extra token(s))`
  const headSide = headTok ? `${headTok.line}:${headTok.col} ${JSON.stringify(headTok.text)}` : `(end of file — base has ${baseTokens.length - headTokens.length} extra token(s))`
  fail(`${file}\n  base ${baseSide}\n  head ${headSide}`)
}

// ---------------------------------------------------------------------------
// Svelte — script blocks compared as TS above; the rest compared after
// stripping <!-- --> and collapsing whitespace runs to one space.
//
// Both halves are masked rather than sliced: the unwanted region is
// replaced by same-length whitespace (newlines preserved) so every offset
// the TS scanner or our own line counter reports lands on the ORIGINAL
// file's line:col, with no separate offset-remapping step to get wrong.

interface ScriptBlock {
  outerStart: number
  outerEnd: number
  contentStart: number
  contentEnd: number
}

const SCRIPT_BLOCK_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
const OPEN_TAG_RE = /^<script\b[^>]*>/i

function findScriptBlocks(text: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = []
  SCRIPT_BLOCK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SCRIPT_BLOCK_RE.exec(text))) {
    const whole = m[0]
    const content = m[1] ?? ""
    const openTag = OPEN_TAG_RE.exec(whole)?.[0] ?? whole
    const outerStart = m.index
    const outerEnd = outerStart + whole.length
    const contentStart = outerStart + openTag.length
    blocks.push({ outerStart, outerEnd, contentStart, contentEnd: contentStart + content.length })
  }
  return blocks
}

function blankRanges(text: string, ranges: Array<{ start: number; end: number }>): string {
  const out = new Array<string>(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text[i]!
  for (const r of ranges) {
    for (let i = r.start; i < r.end && i < text.length; i++) {
      const c = text[i]!
      out[i] = c === "\n" || c === "\r" ? c : " "
    }
  }
  return out.join("")
}

function keepOnly(text: string, start: number, end: number): string {
  return blankRanges(text, [
    { start: 0, end: start },
    { start: end, end: text.length },
  ])
}

interface MarkupNorm {
  norm: string
  offsets: number[] // offsets[i] = original-file offset the i-th normalized char came from
}

function normalizeMarkup(text: string): MarkupNorm {
  let i = 0
  let norm = ""
  const offsets: number[] = []
  while (i < text.length) {
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4)
      i = end === -1 ? text.length : end + 3
      continue
    }
    const ch = text[i]!
    if (/\s/.test(ch)) {
      let j = i
      while (j < text.length && /\s/.test(text[j]!)) j++
      if (norm.length > 0 && !norm.endsWith(" ")) {
        norm += " "
        offsets.push(i)
      }
      i = j
      continue
    }
    norm += ch
    offsets.push(i)
    i++
  }
  if (norm.endsWith(" ")) {
    norm = norm.slice(0, -1)
    offsets.pop()
  }
  return { norm, offsets }
}

function firstStringDiffIndex(a: string, b: string): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return i
  return len
}

function snippet(text: string, offset: number, span = 24): string {
  return text.slice(Math.max(0, offset), Math.max(0, offset) + span).replace(/\s+/g, " ")
}

function countMarkupCommentLines(rest: string): number {
  const lines = new Set<number>()
  const re = /<!--[\s\S]*?-->/g
  let m: RegExpExecArray | null
  while ((m = re.exec(rest))) {
    const startLine = lineNumberAt(rest, m.index)
    const endLine = lineNumberAt(rest, m.index + m[0].length - 1)
    for (let ln = startLine; ln <= endLine; ln++) lines.add(ln)
  }
  return lines.size
}

interface FileResult {
  path: string
  commentsBefore: number
  commentsAfter: number
}

function compareSvelte(filePath: string, baseText: string, headText: string): FileResult {
  const baseBlocks = findScriptBlocks(baseText)
  const headBlocks = findScriptBlocks(headText)
  if (baseBlocks.length !== headBlocks.length) {
    fail(`${filePath}\n  script block count differs: base has ${baseBlocks.length}, head has ${headBlocks.length}`)
  }

  let commentsBefore = 0
  let commentsAfter = 0

  for (let i = 0; i < baseBlocks.length; i++) {
    const b = baseBlocks[i]!
    const h = headBlocks[i]!
    const baseMasked = keepOnly(baseText, b.contentStart, b.contentEnd)
    const headMasked = keepOnly(headText, h.contentStart, h.contentEnd)
    const baseA = analyzeTs(baseMasked, ts.ScriptKind.TS)
    const headA = analyzeTs(headMasked, ts.ScriptKind.TS)
    const diffIdx = findFirstDiff(baseA.tokens, headA.tokens)
    if (diffIdx !== null) reportTokenMismatch(filePath, baseA.tokens, headA.tokens, diffIdx)
    commentsBefore += baseA.commentLines.size
    commentsAfter += headA.commentLines.size
  }

  const baseRestMasked = blankRanges(
    baseText,
    baseBlocks.map((b) => ({ start: b.outerStart, end: b.outerEnd })),
  )
  const headRestMasked = blankRanges(
    headText,
    headBlocks.map((b) => ({ start: b.outerStart, end: b.outerEnd })),
  )
  const baseNorm = normalizeMarkup(baseRestMasked)
  const headNorm = normalizeMarkup(headRestMasked)
  if (baseNorm.norm !== headNorm.norm) {
    const diffIdx = firstStringDiffIndex(baseNorm.norm, headNorm.norm)
    const baseOff = diffIdx < baseNorm.offsets.length ? baseNorm.offsets[diffIdx]! : baseText.length
    const headOff = diffIdx < headNorm.offsets.length ? headNorm.offsets[diffIdx]! : headText.length
    const baseLine = lineNumberAt(baseText, baseOff)
    const headLine = lineNumberAt(headText, headOff)
    const baseCol = baseOff - lineStartOffset(baseText, baseOff) + 1
    const headCol = headOff - lineStartOffset(headText, headOff) + 1
    fail(
      `${filePath} (markup)\n  base ${baseLine}:${baseCol} ${JSON.stringify(snippet(baseText, baseOff))}\n  head ${headLine}:${headCol} ${JSON.stringify(snippet(headText, headOff))}`,
    )
  }

  commentsBefore += countMarkupCommentLines(baseRestMasked)
  commentsAfter += countMarkupCommentLines(headRestMasked)

  return { path: filePath, commentsBefore, commentsAfter }
}

// ---------------------------------------------------------------------------
// main

function printSuccessTable(results: FileResult[]): void {
  const headers = ["file", "comments before", "comments after", "code"]
  const rows = results.map((r) => [r.path, String(r.commentsBefore), String(r.commentsAfter), "equal"])
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ")
  console.log(fmt(headers))
  console.log(widths.map((w) => "-".repeat(w)).join("  "))
  for (const row of rows) console.log(fmt(row))
  console.log(`\ntotal: ${results.length} file${results.length === 1 ? "" : "s"}, code: equal`)
}

function main(): void {
  const { base, dir } = parseArgs(process.argv.slice(2))

  const nameStatusOut = runGit(dir, ["diff", "--name-status", "-M", base])
  const untrackedOut = runGit(dir, ["ls-files", "--others", "--exclude-standard"])

  const entries = parseNameStatus(nameStatusOut)
  const untracked = untrackedOut
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)

  for (const e of entries) {
    switch (e.status) {
      case "A":
        fail(`added file: ${e.path}`)
        break
      case "D":
        fail(`deleted file: ${e.path}`)
        break
      case "R":
        fail(`renamed file: ${e.oldPath} -> ${e.path}`)
        break
      case "C":
        fail(`copied file: ${e.oldPath} -> ${e.path}`)
        break
      case "M":
        break
      default:
        fail(`unsupported change (${e.status || "?"}): ${e.path}`)
    }
    if (e.status === "M") {
      const ext = path.extname(e.path)
      if (ext !== ".ts" && ext !== ".tsx" && ext !== ".svelte") {
        fail(`modified non-source file (${ext || "no extension"}): ${e.path}`)
      }
    }
  }
  for (const f of untracked) fail(`untracked file: ${f}`)

  const results: FileResult[] = []
  for (const e of entries.filter((x) => x.status === "M")) {
    const baseText = normalizeEol(gitShow(dir, base, e.path))
    const headText = normalizeEol(readFileSync(path.join(dir, e.path), "utf8"))
    const ext = path.extname(e.path)

    if (ext === ".ts" || ext === ".tsx") {
      const scriptKind = ext === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      const baseA = analyzeTs(baseText, scriptKind)
      const headA = analyzeTs(headText, scriptKind)
      const diffIdx = findFirstDiff(baseA.tokens, headA.tokens)
      if (diffIdx !== null) reportTokenMismatch(e.path, baseA.tokens, headA.tokens, diffIdx)
      results.push({ path: e.path, commentsBefore: baseA.commentLines.size, commentsAfter: headA.commentLines.size })
    } else {
      results.push(compareSvelte(e.path, baseText, headText))
    }
  }

  printSuccessTable(results)
  process.exit(0)
}

main()
