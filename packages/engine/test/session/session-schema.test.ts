import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ProjectV2 } from "@origami/core/project"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"

const info = {
  id: SessionID.descending(),
  slug: "test-session",
  projectID: ProjectV2.ID.global,
  workspaceID: undefined,
  directory: "/tmp/origami",
  parentID: undefined,
  summary: undefined,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  share: undefined,
  title: "Test session",
  version: "1.0.0",
  time: {
    created: 1,
    updated: 2,
    compacting: undefined,
    archived: undefined,
  },
  permission: undefined,
  revert: undefined,
} satisfies Session.Info

describe("Session schema", () => {
  test("encodes undefined optional session fields as omitted keys", () => {
    const encoded = Schema.encodeUnknownSync(Session.Info)(info) as Record<string, unknown>

    for (const key of ["workspaceID", "parentID", "summary", "share", "permission", "revert"]) {
      expect(Object.hasOwn(encoded, key)).toBe(false)
    }
    expect(Object.hasOwn(encoded.time as Record<string, unknown>, "compacting")).toBe(false)
    expect(Object.hasOwn(encoded.time as Record<string, unknown>, "archived")).toBe(false)
    expect(JSON.stringify(encoded)).not.toContain("parentID")
  })

  test("encodes undefined optional global session project fields as omitted keys", () => {
    const encoded = Schema.encodeUnknownSync(Session.GlobalInfo)({
      ...info,
      project: {
        id: ProjectV2.ID.global,
        name: undefined,
        worktree: "/tmp/origami",
      },
    }) as Record<string, unknown>

    expect(Object.hasOwn(encoded, "parentID")).toBe(false)
    expect(Object.hasOwn(encoded.project as Record<string, unknown>, "name")).toBe(false)
  })

  test("encodes nested undefined optional session fields as omitted keys", () => {
    const encoded = Schema.encodeUnknownSync(Session.Info)({
      ...info,
      summary: {
        additions: 1,
        deletions: 2,
        files: 3,
        diffs: undefined,
      },
      revert: {
        messageID: MessageID.ascending(),
        partID: undefined,
        snapshot: undefined,
        diff: undefined,
      },
    }) as Record<string, unknown>

    expect(Object.hasOwn(encoded.summary as Record<string, unknown>, "diffs")).toBe(false)
    for (const key of ["partID", "snapshot", "diff"]) {
      expect(Object.hasOwn(encoded.revert as Record<string, unknown>, key)).toBe(false)
    }
  })
})

// t-kgtr6c — the per-chat vision profile rides the session row's shared
// `metadata` bag, the same way subagentModel and compactionThreshold do. The
// bag is SHARED, so the two rules worth a test are: a write keeps every other
// key, and a clear removes the key rather than blanking it.
describe("Session vision-profile metadata helpers", () => {
  test("reads a slug back, and treats a blank as no profile", () => {
    expect(Session.visionProfile({ metadata: { visionProfile: "vision-eye" } })).toBe("vision-eye")
    expect(Session.visionProfile({ metadata: {} })).toBeUndefined()
    expect(Session.visionProfile({ metadata: undefined })).toBeUndefined()
    // A blank would name an agent called "", and the tool would refuse every
    // turn citing a profile nobody chose.
    expect(Session.visionProfile({ metadata: { visionProfile: "   " } })).toBeUndefined()
    // A non-string on the row is corruption, not a profile.
    expect(Session.visionProfile({ metadata: { visionProfile: 7 } })).toBeUndefined()
  })

  test("writing the profile carries every other metadata key through", () => {
    const next = Session.withVisionProfile({ compactionThreshold: { kind: "percent", value: 0.6 } }, "vision-eye")
    expect(next).toEqual({ compactionThreshold: { kind: "percent", value: 0.6 }, visionProfile: "vision-eye" })
  })

  test("clearing removes the key and leaves the rest of the bag alone", () => {
    const cleared = Session.withVisionProfile({ visionProfile: "vision-eye", subagentModel: { providerID: "p", modelID: "m" } }, undefined)
    expect(Object.hasOwn(cleared, "visionProfile")).toBe(false)
    expect(cleared).toEqual({ subagentModel: { providerID: "p", modelID: "m" } })
  })
})
