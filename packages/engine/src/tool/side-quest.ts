import path from "path"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { FSUtil } from "@origami/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
// The frontmatter split/read helpers, and the per-path write mutex, are the
// board's only because that is where they were first needed. Reused rather than
// re-implemented: a second frontmatter parser in this repo would be a second
// thing to keep in step with the files on disk.
import { fmGet, repoLock, splitDoc } from "./board-store"
import { claim } from "@/session/side-quest-budget"
import * as Tool from "./tool"

/** The folder a workspace's side quests live in. One file per quest. */
export function sidequestsDir(worktree: string): string {
  return path.join(worktree, ".origami", "sidequests")
}

/** At most this many OPEN quests per chat. Enforced here, not in the wording:
 *  a cap a model is merely asked to respect is a request, not a cap. */
export const MAX_OPEN_PER_CHAT = 5

/** Title comparison key for the duplicate check. Case, punctuation and spacing
 *  do not make a second quest a different one. Unicode letters and digits are
 *  KEPT (`\p{L}`, not `a-z`): stripping them would collapse every non-ASCII
 *  title to the same empty key and refuse the second one as a duplicate.
 *
 *  t-fijy8a F9. A title made only of symbols - an emoji, an arrow - has no
 *  letters or digits at all and collapsed to "", which made EVERY such title
 *  the same title and refused the second one. When the key would be empty the
 *  title itself (folded and space-collapsed) is the key, so two different
 *  symbols stay two quests and the same symbol twice is still one. */
export function normalizeTitle(title: string): string {
  const key = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
  return key || title.toLowerCase().replace(/\s+/g, " ").trim()
}

/** `SQ-<n>` for a file name, or undefined when the name is not one of ours. */
export function questId(filename: string): number | undefined {
  const match = filename.match(/^SQ-(\d+)\.md$/)
  return match ? Number(match[1]) : undefined
}

/** Highest existing number + 1, per workspace. Numbers are never reused: a
 *  dismissed SQ-3 keeps its id so an exported file still names the right one. */
export function nextNumber(filenames: readonly string[]): number {
  return filenames.reduce((high, name) => Math.max(high, questId(name) ?? 0), 0) + 1
}

/** A fresh quest file. LF and UTF-8 — the shared contract with the drawer. */
export function questFile(input: {
  id: string
  title: string
  summary: string
  rationale?: string
  instructions: string
  created: string
  session: string
}): string {
  return [
    "---",
    `id: ${input.id}`,
    `title: ${input.title}`,
    "status: open",
    `created: ${input.created}`,
    `session: ${input.session}`,
    "---",
    "",
    "## Summary",
    "",
    input.summary,
    "",
    ...(input.rationale ? ["## Rationale", "", input.rationale, ""] : []),
    "## Instructions",
    "",
    input.instructions,
    "",
  ].join("\n")
}

/**
 * Claim the next free `SQ-<n>.md` in `dir` and write it, EXCLUSIVELY.
 *
 * t-fijy8a F9. The number came from one read of the directory and the file was
 * written with a plain write, under a lock that is only process-local. Two
 * engines open on one workspace - a second window, a CLI run - both read the
 * same highest number and the second write SILENTLY replaced the first quest.
 *
 * `wx` fails instead of overwriting, so the loser of the race learns it lost
 * and re-reads the directory for a new number. `attempts` bounds the retry: a
 * folder being filled by something else must end in an error, not a spin.
 */
export function claimQuestFile(
  dir: string,
  render: (id: string) => string,
  attempts = 8,
): Effect.Effect<{ id: string; file: string }> {
  return Effect.promise(async () => {
    await mkdir(dir, { recursive: true })
    for (let attempt = 0; attempt < attempts; attempt++) {
      const names = await readdir(dir).catch(() => [] as string[])
      const id = `SQ-${nextNumber(names)}`
      const file = path.join(dir, `${id}.md`)
      try {
        await writeFile(file, render(id), { flag: "wx" })
        return { id, file }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error
      }
    }
    throw new Error(`could not claim a side quest number in ${dir} after ${attempts} attempts`)
  })
}

/**
 * Which TURN this call belongs to: the id of the user message the turn answers.
 * `ctx.messageID` cannot stand in — session/prompt.ts writes a NEW assistant
 * message per step, so a per-message budget would allow one quest per step and
 * a long turn could file a dozen. Falls back to the message when the transcript
 * carries no user message at all (a synthetic caller), which is stricter, not
 * looser.
 */
export function turnKey(ctx: Pick<Tool.Context, "messageID" | "messages">): string {
  return ctx.messages.findLast((message) => message.info.role === "user")?.info.id ?? ctx.messageID
}

// t-ffjau8. The words "sidequest" and "side quest" are in the text on purpose:
// this is the tool a model looks for by that name, and a config that defers it
// leaves only this description for `tool_search` to match on.
const DESCRIPTION = [
  "Record a side quest (sidequest): a well-scoped piece of FOLLOW-UP work you noticed that is NOT your current job,",
  "for the owner to review later.",
  "Use this RARELY, and only when the work is specific enough that a fresh agent could start from your instructions alone.",
  "Not for questions, not for blockers, not for small things you should just do now.",
  "At most one call per turn.",
  "This starts nothing and blocks nothing: nobody is asked, no session is spawned, no work begins.",
  "A side quest is RECORDED for the owner, never run: never spawn a sub-agent to launch a sidequest - this tool IS how you raise one.",
  "Record it and carry straight on with your own task - do not wait for it and do not refer back to it.",
].join(" ")

export const Parameters = Schema.Struct({
  title: Schema.String.annotate({ description: "One line naming the follow-up work." }),
  summary: Schema.String.annotate({ description: "One to three sentences: what the work is." }),
  instructions: Schema.String.annotate({
    description: "The brief a fresh agent would start from - scope, files, and what done looks like.",
  }),
  rationale: Schema.optional(Schema.String).annotate({
    description: "Optional. Why you think this is worth doing, to help the owner triage it quickly.",
  }),
})

type SideQuestMetadata = {
  id?: string
  file?: string
  open?: number
  refused?: "arguments" | "turn" | "cap" | "duplicate"
}

const refuse = (reason: NonNullable<SideQuestMetadata["refused"]>, output: string, open?: number) => ({
  title: "side_quest: refused",
  metadata: { refused: reason, ...(open === undefined ? {} : { open }) },
  output,
})

export const SideQuestTool = Tool.define<typeof Parameters, SideQuestMetadata, FSUtil.Service>(
  "side_quest",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const title = params.title?.replace(/\s+/g, " ").trim()
          const summary = params.summary?.trim()
          const instructions = params.instructions?.trim()
          if (!title || !summary || !instructions) {
            return refuse(
              "arguments",
              "Refused: title, summary and instructions are all required - a quest a fresh agent cannot start from" +
                " is not worth the owner's attention.",
            )
          }

          // CLAIMED, not spent at the end: two tool calls the model made in
          // parallel would both be past this line before either had written a
          // file, so the budget is taken here, synchronously, before any I/O.
          // A refused call still spends the turn - the cap is one CALL, and a
          // model that just had one refused should carry on, not retry.
          const turn = turnKey(ctx)
          if (!claim(ctx.sessionID, turn)) {
            return refuse(
              "turn",
              "Refused: one side quest per turn, and this turn already used it." +
                " Carry on with your own work; raise the next one in a later turn if it still matters.",
            )
          }

          // A folder with no VCS is the GLOBAL project, whose worktree is the
          // drive root (project/project.ts:217) - quests would land in
          // C:\.origami\sidequests, shared by every non-git folder on the
          // machine and nowhere the drawer looks. The opened directory is.
          const instance = yield* InstanceState.context
          const dir = sidequestsDir(instance.project.vcs ? instance.worktree : instance.directory)
          const written = yield* repoLock(dir).withPermits(1)(
            Effect.gen(function* () {
              const entries = yield* fs
                .readDirectoryEntries(dir)
                .pipe(Effect.catch(() => Effect.succeed([] as FSUtil.DirEntry[])))
              const names = entries
                .filter((entry) => entry.type === "file" && questId(entry.name) !== undefined)
                .map((entry) => entry.name)

              const open: { id: string; title: string; session: string }[] = []
              for (const name of names) {
                const text = yield* fs
                  .readFileStringSafe(path.join(dir, name))
                  .pipe(Effect.catch(() => Effect.succeed(undefined)))
                const fm = text ? splitDoc(text)?.fm : undefined
                // An unreadable or malformed file counts as nothing: it cannot
                // be the duplicate the model is about to file, and refusing on
                // one would wedge the tool until a human tidied the folder.
                if (!fm || fmGet(fm, "status") !== "open") continue
                open.push({
                  id: fmGet(fm, "id") ?? name.replace(/\.md$/, ""),
                  title: fmGet(fm, "title") ?? "",
                  session: fmGet(fm, "session") ?? "",
                })
              }

              // `open` in the metadata is always THIS CHAT's count (t-fijeld): the
              // duplicate SEARCH is workspace-wide, the number reported is not.
              const mine = open.filter((quest) => quest.session === ctx.sessionID).length
              const duplicate = open.find((quest) => normalizeTitle(quest.title) === normalizeTitle(title))
              if (duplicate) return { refusal: "duplicate" as const, id: duplicate.id, open: mine }

              if (mine >= MAX_OPEN_PER_CHAT) return { refusal: "cap" as const, open: mine }

              const created = new Date().toISOString()
              const { id, file } = yield* claimQuestFile(dir, (questID) =>
                questFile({
                  id: questID,
                  title,
                  summary,
                  rationale: params.rationale?.trim() || undefined,
                  instructions,
                  created,
                  session: ctx.sessionID,
                }),
              )
              return { id, file, open: mine + 1 }
            }),
          )

          if ("refusal" in written) {
            return written.refusal === "duplicate"
              ? refuse(
                  "duplicate",
                  `Refused: ${written.id} is already open with the same title. The owner has it; carry on.`,
                  written.open,
                )
              : refuse(
                  "cap",
                  `Refused: this chat already has ${MAX_OPEN_PER_CHAT} open side quests, which is the cap.` +
                    " The owner reviews them before there is room for another one.",
                  written.open,
                )
          }

          return {
            title: `side_quest: ${written.id}`,
            metadata: { id: written.id, file: written.file, open: written.open },
            output:
              `Side quest recorded: ${written.id} ${title}.` +
              " Continue your own work; do not wait for or reference it.",
          }
        }).pipe(Effect.orDie),
    }
  }),
)
