// G1 (t-w2qb1x): every module-level store in src is classified.
//
// A store that lives in process memory and feeds the request bytes is lost on a
// restart, and a restarted engine then sends different bytes (a lost prompt
// cache). This test reads src at test time, finds every module-level
// `new Map` / `new Set` / `new WeakMap` / `new WeakSet` declaration and every
// module-level `let`, and fails on one that is not in the table below, and on
// a table row whose store no longer exists. Adding a store means deciding,
// here, which class it is:
//
//   persisted  feeds the request bytes; written to SQLite (or its own file) and
//              loaded on a miss. Cleared by EngineProcessMemory.resetForTest,
//              so the restart tests prove the load.
//   reset      per-session memory that does not feed the request bytes.
//              Cleared by EngineProcessMemory.resetForTest.
//   busy       exists only while a turn, tool call or background job runs. An
//              engine holding it is not idle, and option D stops only idle
//              engines (scope C section 6).
//   process    process machinery that holds no request input: listeners,
//              locks, servers, OAuth flows, id counters, memos of pure
//              functions, caches of data read again at start.
//   constant   never written after the module loads.
//
// Layer-scoped state (inside a service's Layer.effect) is not module-level and
// not scanned: a new runtime rebuilds it. The one such store that feeds the
// bytes, the `tool_search` loaded set, is persisted (tool/tool-search.ts).

import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

type Class = "persisted" | "reset" | "busy" | "process" | "constant"

const SRC = path.join(import.meta.dir, "..", "src")

const C = "constant" as const

const TABLE: Record<string, readonly [Class, string]> = {
  // --- persisted: feeds the request bytes ---------------------------------
  "session/tool-aging.ts store": ["persisted", "aging rewrites + reprieves -> session_request_memory"],
  "session/degrade.ts rejected": ["persisted", "refused knobs -> session_request_memory"],
  "session/image-cap.ts caps": ["persisted", "learned image cap -> session_request_memory"],
  "session/window-fit.ts ratios": ["persisted", "window-fit ratio (max_tokens) -> session_request_memory"],
  "provider/effort-demotion.ts store": ["persisted", "demoted effort tiers, per model, in effort-demotions.json"],

  // --- reset: per-session, not a request input ----------------------------
  "session/request-memory-rows.ts staged": ["reset", "rows not yet written; the stores hold the values"],
  "session/window-fit.ts pending": ["reset", "estimate of the request in flight, read by its own reply"],
  "session/prompt-capture.ts bigBytes": ["reset", "transparency capture, computed after the send"],
  "session/prompt-capture.ts captures": ["reset", "transparency capture"],
  "session/prompt-capture.ts compactions": ["reset", "transparency capture"],
  "session/prompt-capture.ts drafts": ["reset", "transparency capture"],
  "session/prompt-capture.ts history": ["reset", "transparency capture"],
  "session/prompt-capture.ts prefixes": ["reset", "transparency capture: prefix digests for the step-finish"],
  "session/prompt-capture.ts requests": ["reset", "transparency capture: cache facts"],
  "session/prompt-capture.ts restored": ["reset", "restore seed, read once per session from the persisted step-finish"],
  "session/prompt-capture.ts rewrites": ["reset", "transparency capture: divergence source"],
  "session/effort-tier.ts lastSent": ["reset", "tier the last request carried, read by the retry policy"],
  "session/effort-tier.ts demotedOnce": ["reset", "one demotion per session, a retry decision"],
  "session/cache-warm.ts sessions": ["reset", "warm timers; a warm re-sends the prefix, it does not change it"],
  "session/cache-warm.ts clock": ["reset", "test clock"],
  "session/cache-warm.ts lastRequest": ["reset", "when the last real request went out (idle report; t-w2qlop)"],
  "session/cache-state.ts sessions": ["reset", "composer cache badge"],
  "session/cache-state.ts clock": ["reset", "test clock"],
  "session/cache-state.ts listeners": ["reset", "badge subscribers"],
  "session/peer-message.ts delivered": ["reset", "dedupe of incoming peer prompts; stored history is not changed"],

  // --- busy: only while a turn or job runs ----------------------------------
  "session/goal.ts inFlight": ["busy", "a goal check in flight"],
  "session/side-quest-budget.ts spent": ["busy", "keyed by turn: one side quest per turn"],
  "session/task-result.ts pendingResults": ["busy", "sub-agent results waiting to be injected (D3 precondition)"],
  "session/task-result.ts draining": ["busy", "injection in progress"],
  "session/task-result.ts injectLocks": ["busy", "injection lock"],
  "tool/edit.ts locks": ["busy", "per-file edit lock"],
  "tool/board-store.ts locks": ["busy", "per-board write lock"],
  "storage/nests-handover.ts heldLeases": ["busy", "a Nests run lease held (idle report nest-lease; t-w2qlop)"],

  // --- process: machinery, no request input --------------------------------
  // t-w2qlop (E2): the elastic class, the OS calls and the owners' probes. Classified by t-w2txb2,
  // whose base merged E1's guard with E2's stores for the first time.
  "elastic/activity.ts probes": ["process", "live-state probes the owners register (idle report)"],
  "elastic/idle.ts applies": ["process", "count of OS class applies"],
  "elastic/idle.ts installed": ["process", "class listener installed once"],
  "elastic/idle.ts last": ["process", "last OS apply result"],
  "elastic/os.ts current": ["process", "the OS module in use (test seam)"],
  "elastic/os.ts excluded": ["process", "pids left out of priority and trim (the detached WebMCP browser tree)"],
  "acp/elastic.ts pending": ["process", "park/unpark calls in flight, serialised (t-wdybz9)"],
  "acp/elastic.ts serial": ["process", "park/unpark serialisation chain"],
  "elastic/idle.ts childWalk": ["process", "deferred child-process priority walk timer"],
  "origami/agent-broker.ts parked": ["process", "this engine's park state (stand-ins written)"],
  "origami/agent-broker.ts withdrawn": ["process", "peer entry withdrawn while parking"],
  "origami/agent-mailbox.ts admitter": ["process", "the route that admits mailbox bodies"],
  "elastic/spare.ts adoption":["process", "warm spare adoption run (t-w2u2ki), once per process"],
  "elastic/spare.ts held": ["process", "warm spare peer start held until adoption"],
  "elastic/spare.ts adoptionEnded": ["process", "the adoption's held work ended; calls stop waiting for it (t-y4x518)"],
  "elastic/state.ts requested": ["process", "class the extension asked for"],
  "elastic/state.ts busy": ["process", "busy reader"],
  "elastic/state.ts published": ["process", "effective class"],
  "elastic/state.ts wasWorking": ["process", "turn edge detector for the trim guard"],
  "elastic/state.ts lastWorkEnd": ["process", "when the last turn ended (trim guard)"],
  "elastic/state.ts listeners": ["process", "class change listeners"],
  "acp/provider-auth.ts inflight": ["process", "auth flow in flight"],
  "artifact/events.ts listeners": ["process", "event subscribers"],
  "artifact/instance.ts opening": ["process", "store open promise"],
  "artifact/nest-sync.ts prepared": ["process", "stores already prepared"],
  "browser/bridge.ts handler": ["process", "browser bridge handler"],
  "bus/global.ts sseSubscribers": ["process", "SSE subscriber count"],
  "cli/cmd/run/trace.ts state": ["process", "CLI trace"],
  "cli/heap.ts armed": ["process", "heap snapshot trigger"],
  "cli/heap.ts lock": ["process", "heap snapshot trigger"],
  "cli/heap.ts timer": ["process", "heap snapshot trigger"],
  "cli/tui/worker.ts server": ["process", "TUI worker server"],
  "cli/ui.ts blank": ["process", "CLI output state"],
  "control-plane/adapters/index.ts state": ["process", "workspace adapter registry"],
  "control-plane/dev/debug-workspace-plugin.ts PORT": ["process", "dev plugin port"],
  "effect/instance-registry.ts disposers": ["process", "instance disposers"],
  "flock/peer.ts counter": ["process", "flock message counter"],
  "flock/service.ts currentCode": ["process", "flock link state, rebuilt from flock.json at start"],
  "flock/service.ts currentKind": ["process", "flock link state"],
  "flock/service.ts currentLease": ["process", "flock link state"],
  "flock/service.ts currentPeer": ["process", "flock link state"],
  "flock/service.ts currentRefresh": ["process", "flock link state"],
  "flock/service.ts currentRoutes": ["process", "flock link state"],
  "flock/service.ts currentTransport": ["process", "flock link state"],
  "flock/transport.ts current": ["process", "flock transport"],
  "flock/watch.ts listeners": ["process", "flock file watchers"],
  "id/id.ts counter": ["process", "id generation; ids are not in the request body"],
  "id/id.ts lastTimestamp": ["process", "id generation"],
  "lsp/server.ts roslynLanguageServerInstall": ["process", "install promise"],
  "mcp/index.ts pendingOAuthTransports": ["process", "MCP OAuth flow"],
  "mcp/oauth-callback.ts currentPath": ["process", "OAuth callback server"],
  "mcp/oauth-callback.ts currentPort": ["process", "OAuth callback server"],
  "mcp/oauth-callback.ts mcpNameToState": ["process", "OAuth flow"],
  "mcp/oauth-callback.ts pendingAuths": ["process", "OAuth flow"],
  "mcp/oauth-callback.ts server": ["process", "OAuth callback server"],
  "origami/agent-broker.ts live": ["process", "engine presence heartbeat"],
  "origami/agent-broker.ts sessions": ["process", "engine presence source"],
  "origami/agent-broker.ts writes": ["process", "presence write chain"],
  "plugin/digitalocean.ts oauthServer": ["process", "OAuth flow"],
  "plugin/digitalocean.ts pendingOAuth": ["process", "OAuth flow"],
  "plugin/github-copilot/copilot.ts sessionTokens": ["process", "auth tokens (headers, not the body)"],
  "plugin/openai/codex.ts liveServed": ["process", "models the account lists; the picker, not a request"],
  "plugin/openai/codex.ts oauthServer": ["process", "OAuth flow"],
  "plugin/openai/codex.ts pendingOAuth": ["process", "OAuth flow"],
  "plugin/snowflake-cortex.ts oauthServer": ["process", "OAuth flow"],
  "plugin/snowflake-cortex.ts oauthServerPort": ["process", "OAuth flow"],
  "plugin/snowflake-cortex.ts pendingOAuth": ["process", "OAuth flow"],
  "plugin/tui/runtime.ts dir": ["process", "TUI plugin runtime"],
  "plugin/tui/runtime.ts loaded": ["process", "TUI plugin runtime"],
  "plugin/tui/runtime.ts runtime": ["process", "TUI plugin runtime"],
  "plugin/xai.ts oauthServer": ["process", "OAuth flow"],
  "plugin/xai.ts pendingOAuth": ["process", "OAuth flow"],
  "provider/claude-subscription.ts checking": ["process", "CLI readiness probe"],
  "provider/claude-subscription.ts current": ["process", "CLI readiness"],
  "provider/claude-subscription.ts memo": ["process", "CLI info memo"],
  "provider/concurrency.ts providerSemaphores": ["process", "per-provider request permits"],
  "provider/discovery.ts cache": ["process", "model lists read from the server; read again at start"],
  "provider/discovery.ts inflight": ["process", "discovery in flight"],
  "provider/reauth.ts refused": ["process", "providers whose credential was refused"],
  "server/mdns.ts bonjour": ["process", "mDNS"],
  "server/mdns.ts currentPort": ["process", "mDNS"],
  "server/routes/instance/httpapi/lifecycle.ts disposeAfterResponse": ["process", "HTTP lifecycle"],
  "server/server.ts url": ["process", "server address"],
  "server/shared/ui.ts embeddedUIPromise": ["process", "embedded UI load"],
  "session/prompt-capture.ts settleScheduled": ["process", "capture settle flag; cleared when the settle runs"],
  "session/provider-queue.ts listeners": ["process", "queue subscribers"],
  "session/turn-end.ts listeners": ["process", "turn-end subscribers"],
  "snapshot/git-runner.ts answerTimeout": ["process", "how long a run waits for the Worker to start git (test seam, t-w1r73y)"],
  "snapshot/git-runner.ts answers": ["busy", "answer clocks of Worker runs not yet started (t-w1r73y)"],
  "snapshot/git-runner.ts broken": ["process", "snapshot git Worker state (t-w2r1kf); hashes are not request bytes"],
  "snapshot/git-runner.ts brokenLogged": ["process", "snapshot git Worker state"],
  "snapshot/git-runner.ts current": ["process", "snapshot git Worker handle"],
  "snapshot/git-runner.ts idleTimer": ["process", "snapshot git Worker idle stop"],
  "snapshot/git-runner.ts mode": ["process", "snapshot git Worker test mode"],
  "snapshot/git-runner.ts nextId": ["process", "snapshot git Worker call ids"],
  "snapshot/git-runner.ts startedAt": ["process", "when the Worker started (slow-run log, t-woacbl)"],
  "snapshot/git-runner.ts pending":["busy", "git calls the Worker still owes; run inline if it dies"],
  "snapshot/git-runner.ts workerUrl": ["process", "snapshot git Worker script (test seam)"],
  "snapshot/git-worker.ts running": ["busy", "git processes running inside the Worker"],
  "storage/read-runner.ts workerUrl": ["process", "storage read Worker script (test seam)"],
  "storage/nests-handover.ts waiting": ["process", "handover waiters"],
  "storage/nests.ts sizes": ["process", "session size memo for storage"],
  "tool/flock.ts cached": ["process", "flock transport memo"],
  "tool/json-schema.ts cache": ["process", "memo of a pure schema conversion"],
  "webmcp/browser-launch.ts running": ["process", "launched browsers"],

  // --- constant -------------------------------------------------------------
  "acp/run-steps.ts CACHE_CAUSES": [C, ""],
  "acp/run-steps.ts DIVERGENCE_SOURCES": [C, ""],
  "acp/run-steps.ts STOPPED_HALVES": [C, ""],
  "acp/run-steps.ts STRUCTURAL_PARTS": [C, ""],
  "acp/run-steps.ts SUBAGENT_TOOLS": [C, ""],
  "acp/service.ts ROW_WRITING_CONFIG": [C, ""],
  "agent-plugins/manifest.ts KNOWN_KEYS": [C, ""],
  "agent-plugins/manifest.ts LENIENT_KEYS": [C, ""],
  "collab/runner.ts ROUTING_TOOLS": [C, ""],
  "config/managed.ts PLIST_META": [C, ""],
  "effect/runtime-flags.ts FALSE_WORDS": [C, ""],
  "flock/health.ts HEALTH_STATUS": [C, ""],
  "flock/service.ts RECHECKABLE": [C, ""],
  "plugin/openai/codex.ts ALLOWED_MODELS": [C, ""],
  "plugin/openai/codex.ts DISALLOWED_MODELS": [C, ""],
  "plugin/tui/runtime.ts ScopedKeymapMethods": [C, ""],
  "plugin/xai.ts CORS_ALLOWED_ORIGINS": [C, ""],
  "provider/error.ts SECRET_HEADER_NAMES": [C, ""],
  "provider/reauth.ts REFUSED": [C, ""],
  "provider/transform.ts OPENAI_TOOL_SEARCH_COLLISION_NPM": [C, ""],
  "provider/transform.ts RETENTION_24H_FAMILIES": [C, ""],
  "server/proxy-util.ts hop": [C, ""],
  "server/routes/instance/httpapi/middleware/compression.ts STREAMING_PATHS": [C, ""],
  "server/routes/instance/httpapi/middleware/fence.ts ignoredMethods": [C, ""],
  "server/shared/public-ui.ts PUBLIC_UI_PATHS": [C, ""],
  "session/child-todo-nudge.ts CLOSED": [C, ""],
  "session/llm/native-runtime.ts CLOSES_CONTENT": [C, ""],
  "session/llm/native-runtime.ts COMPATIBLE_VERBATIM_EXCLUDED": [C, ""],
  "session/llm/native-runtime.ts OAUTH_FAMILIES": [C, ""],
  "session/llm/native-runtime.ts ROUTED_NPM": [C, ""],
  "session/processor.ts TTFT_CONTENT_EVENTS": [C, ""],
  "session/prompt-capture.ts REPAIR_ONLY_TOOLS": [C, ""],
  "session/prompt.ts SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES": [C, ""],
  "session/reminders.ts TODO_CLOSED": [C, ""],
  "session/tool-aging.ts AGEABLE_TOOLS": [C, ""],
  "session/tool-aging.ts BUILTIN_TOOLS": [C, ""],
  "session/tool-aging.ts EMPTY_REWRITES": [C, ""],
  "session/tool-aging.ts SUPERSEDING_VERBS": [C, ""],
  "session/tools.ts SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES": [C, ""],
  "tool/read.ts SUPPORTED_IMAGE_MIMES": [C, ""],
  "tool/shell.ts CMD_FILES": [C, ""],
  "tool/shell.ts CWD": [C, ""],
  "tool/shell.ts FILES": [C, ""],
  "tool/shell.ts FLAGS": [C, ""],
  "tool/shell.ts SWITCHES": [C, ""],
  "tool/shell/id.ts shellKinds": [C, ""],
  "tool/shell/prompt.ts CMD": [C, ""],
  "tool/shell/prompt.ts PS": [C, ""],
  "tool/show-image.ts SUPPORTED_MIMES": [C, ""],
  "tool/tool-search.ts CORE": [C, ""],
  "tool/tool-search.ts TASK_COMPANIONS": [C, ""],
  "tool/vision-request.ts SUPPORTED_IMAGE_MIMES": [C, ""],
}

/** Module level = column 0. A declaration inside a function or a layer is
 *  indented, so it is not matched. */
const COLLECTION =
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b[^=]*=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\b/
const MUTABLE = /^(?:export\s+)?(?:let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return files(full)
    return name.endsWith(".ts") && !name.endsWith(".d.ts") ? [full] : []
  })
}

function scan(): string[] {
  const found = new Set<string>()
  for (const file of files(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join("/")
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const name = COLLECTION.exec(line)?.[1] ?? MUTABLE.exec(line)?.[1]
      if (name) found.add(rel + " " + name)
    }
  }
  return [...found].sort()
}

test("G1: every module-level store in src is classified", () => {
  const found = scan()
  const unclassified = found.filter((key) => !(key in TABLE))
  const stale = Object.keys(TABLE).filter((key) => !found.includes(key))
  expect(unclassified, "new module-level stores: classify each in TABLE").toEqual([])
  expect(stale, "TABLE rows whose store is gone: remove them").toEqual([])
})

test("G1: every persisted or reset store's module is reset by EngineProcessMemory.resetForTest", () => {
  const seam = readFileSync(path.join(SRC, "engine-process-memory.ts"), "utf8")
  const missing = Object.entries(TABLE)
    .filter(([, [cls]]) => cls === "persisted" || cls === "reset")
    .map(([key]) => key.split(" ")[0]!.replace(/\.ts$/, ""))
    .filter((module) => !seam.includes(`from "@/${module}"`))
  expect([...new Set(missing)]).toEqual([])
})

// t-w2u5vf: a closed chat's entries are freed (EngineProcessMemory.evictSession,
// called by ACP session/close). Every persisted or reset store is either
// emptied for the session there, or named here with the reason it stays.
const KEPT_ON_CLOSE: Record<string, string> = {
  "provider/effort-demotion.ts store": "per model, not per session",
  "session/request-memory-rows.ts staged": "rows not written yet: the only copy; a reopen reads them back",
  "session/peer-message.ts delivered": "dedupe must span a close and reopen; bounded 64 x 64",
  "session/prompt-capture.ts bigBytes": "keyed by string fingerprint, not by session; bounded 4096",
  "session/cache-warm.ts clock": "test clock",
  "session/cache-warm.ts lastRequest": "one timestamp for the whole process (idle report), not per session",
  "session/cache-state.ts clock": "test clock",
  "session/cache-state.ts listeners": "badge subscribers, not per session",
}

test("G1: every persisted or reset per-session store is emptied for a closed session", () => {
  const seam = readFileSync(path.join(SRC, "engine-process-memory.ts"), "utf8")
  const evictSession = seam.slice(seam.indexOf("export function evictSession"))
  const problems: string[] = []
  for (const [key, [cls]] of Object.entries(TABLE)) {
    if (cls !== "persisted" && cls !== "reset") continue
    if (key in KEPT_ON_CLOSE) continue
    const [file, store] = key.split(" ") as [string, string]
    const module = file.replace(/\.ts$/, "")
    const name = seam.match(new RegExp(`import \\{ (\\w+) \\} from "@/${module}"`))?.[1]
    if (!name || !evictSession.includes(`${name}.evict(sessionID)`)) {
      problems.push(`${key}: evictSession does not call its module's evict`)
      continue
    }
    const source = readFileSync(path.join(SRC, file), "utf8")
    const start = source.indexOf("export function evict(")
    const body = start < 0 ? "" : source.slice(start, source.indexOf("\n}", start))
    if (!body.includes(`${store}.delete(sessionID)`)) problems.push(`${key}: evict does not delete the session`)
  }
  const stale = Object.keys(KEPT_ON_CLOSE).filter((key) => !(key in TABLE))
  expect(problems).toEqual([])
  expect(stale).toEqual([])
})
