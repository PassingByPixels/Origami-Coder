// origami_change (t-qdc718): the two cross-process caches a new chat now TRUSTS instead
// of rebuilding - the provider catalog (t-hca1vv) and the agent registry - exercised over
// the REAL ACP wire, in a real subprocess, which is the tier the harness could not assert.
//
// The method in every test here is the same, and it is the only one that proves a cache
// was actually READ: run one engine process so the cache file gets written, kill it, edit
// the file on disk to say something the live build could never produce, and start a second
// process. A sentinel that reaches `configOptions` can only have come off the disk.
//
// Killing the first process before editing matters: on a hit each route re-builds the real
// answer after 5 s and rewrites the file, so a still-running process would erase the edit.
import { describe, expect } from "bun:test"
import fs from "fs"
import path from "path"
import { Effect } from "effect"
import { cliIt, type AcpHandle, type CliFixture } from "../lib/cli-process"
import { createAcpClient as createJsonRpcAcpClient, flattenSelectOptions } from "../cli/acp/acp-test-client"
import { expectSelectOption, initialize, newSession, verifierConfig } from "../cli/acp/helpers"

const cacheDir = (home: string) => path.join(home, ".local", "share", "origami", "cache")

function cacheFiles(home: string, prefix: string) {
  const dir = cacheDir(home)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => path.join(dir, name))
}

/** The one cache file of this kind, asserted to be exactly one so a test can never
 *  silently edit a leftover from an earlier run in the same home. */
function onlyCacheFile(home: string, prefix: string) {
  const files = cacheFiles(home, prefix)
  expect(files.length).toBe(1)
  return files[0]!
}

/** One engine process: initialize, `session/new`, then stdin EOF and a wait for the exit,
 *  so nothing is left alive to rewrite the cache under the next step. */
function sessionOptions(fixture: Pick<CliFixture, "home" | "llm" | "origami">) {
  return Effect.gen(function* () {
    const handle: AcpHandle = yield* fixture.origami.acp({
      env: { ORIGAMI_CONFIG_CONTENT: JSON.stringify(verifierConfig(fixture.llm.url)) },
    })
    const acp = createJsonRpcAcpClient(handle)
    yield* initialize(acp)
    const session = yield* newSession(acp, fixture.home)
    handle.close()
    yield* Effect.promise(() => handle.exited)
    return session.configOptions ?? []
  })
}

describe("acp start caches", () => {
  // Acceptance item: `session/new` answers `configOptions` from a primed cache FILE,
  // with no provider build. The sentinel model is not in the config any process reads,
  // so a live build cannot invent it - if the model picker lists it, the answer came
  // off disk.
  cliIt.live(
    "newSession answers configOptions from a primed provider-catalog cache file",
    (fixture) =>
      Effect.gen(function* () {
        yield* sessionOptions(fixture)

        const file = onlyCacheFile(fixture.home, "provider-catalog-")
        const payload = JSON.parse(fs.readFileSync(file, "utf8"))
        const provider = payload.catalog.providers[0]
        provider.models["cached-only-model"] = {
          ...provider.models["test-model"],
          id: "cached-only-model",
          name: "Cached Only Model",
        }
        fs.writeFileSync(file, JSON.stringify(payload))

        const model = expectSelectOption(yield* sessionOptions(fixture), "model")
        expect(flattenSelectOptions(model).map((option) => option.value)).toContain("test/cached-only-model")
      }),
    120_000,
  )

  // Acceptance item, both halves: the agent snapshot is SERVED from the cache, and a
  // change to an agent definition file INVALIDATES it. The mode picker is built from
  // the agent registry (`Directory.modeOptionsFrom`), so it is where a cached agent
  // shows up.
  cliIt.live(
    "the agent snapshot is served from cache and invalidated when an agent file changes",
    (fixture) =>
      Effect.gen(function* () {
        const first = expectSelectOption(yield* sessionOptions(fixture), "mode")
        expect(flattenSelectOptions(first).map((option) => option.value)).not.toContain("cached-only-agent")

        const file = onlyCacheFile(fixture.home, "agent-snapshot-")
        const payload = JSON.parse(fs.readFileSync(file, "utf8"))
        payload.agents.push({
          name: "cached-only-agent",
          description: "Only ever present in the cache file.",
          mode: "primary",
          permission: [],
          options: {},
        })
        fs.writeFileSync(file, JSON.stringify(payload))

        const served = expectSelectOption(yield* sessionOptions(fixture), "mode")
        expect(flattenSelectOptions(served).map((option) => option.value)).toContain("cached-only-agent")

        // An agent DEFINITION FILE appears. Its content is merged into the config the
        // key hashes, so the tampered snapshot must no longer be reachable and the new
        // agent must be listed.
        const agentDir = path.join(fixture.home, ".config", "origami", "agent")
        fs.mkdirSync(agentDir, { recursive: true })
        fs.writeFileSync(
          path.join(agentDir, "file-defined-agent.md"),
          ["---", "description: Defined by a file on disk.", "mode: primary", "---", "", "Be useful.", ""].join("\n"),
        )

        const after = expectSelectOption(yield* sessionOptions(fixture), "mode")
        const values = flattenSelectOptions(after).map((option) => option.value)
        expect(values).toContain("file-defined-agent")
        expect(values).not.toContain("cached-only-agent")
      }),
    180_000,
  )

  // No behaviour change: the same configOptions reach a session with and without the
  // caches. Run one process with the cache directory emptied, one with it primed, and
  // compare the whole answer - not just the legs the caches touch.
  cliIt.live(
    "configOptions are identical with and without the caches",
    (fixture) =>
      Effect.gen(function* () {
        yield* sessionOptions(fixture)
        fs.rmSync(cacheDir(fixture.home), { recursive: true, force: true })

        const uncached = yield* sessionOptions(fixture)
        const cached = yield* sessionOptions(fixture)
        expect(cached).toEqual(uncached)
      }),
    180_000,
  )
})
