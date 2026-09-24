import { Agent } from "@/agent/agent"
import { AgentSnapshotCache } from "@/agent/snapshot-cache"
import { Command } from "@/command"
import { Config } from "@/config/config"
import * as InstanceState from "@/effect/instance-state"
import { Format } from "@/format"
import { Global } from "@origami/core/global"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ApiVcsApplyError } from "../groups/instance"
import { markInstanceForDisposal } from "../lifecycle"

export const instanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "instance", (handlers) =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const command = yield* Command.Service
    const config = yield* Config.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const skill = yield* Skill.Service
    const vcs = yield* Vcs.Service

    const dispose = Effect.fn("InstanceHttpApi.dispose")(function* () {
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    const getPath = Effect.fn("InstanceHttpApi.path")(function* () {
      const ctx = yield* InstanceState.context
      return {
        home: Global.Path.home,
        state: Global.Path.state,
        config: Global.Path.config,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }
    })

    const getVcs = Effect.fn("InstanceHttpApi.vcs")(function* () {
      const [branch, default_branch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], {
        concurrency: "unbounded",
      })
      return { branch, default_branch }
    })

    const getVcsStatus = Effect.fn("InstanceHttpApi.vcsStatus")(function* () {
      return yield* vcs.status()
    })

    const getVcsDiff = Effect.fn("InstanceHttpApi.vcsDiff")(function* (ctx: {
      query: { mode: Vcs.Mode; context?: number }
    }) {
      return yield* vcs.diff(ctx.query.mode, { context: ctx.query.context })
    })

    const getVcsDiffRaw = Effect.fn("InstanceHttpApi.vcsDiffRaw")(function* () {
      return yield* vcs.diffRaw()
    })

    const applyVcs = Effect.fn("InstanceHttpApi.vcsApply")(function* (ctx: { payload: Vcs.ApplyInput }) {
      return yield* vcs.apply(ctx.payload).pipe(
        Effect.mapError(
          (error) =>
            new ApiVcsApplyError({
              name: "VcsApplyError",
              data: {
                message: error.message,
                reason: error.reason,
              },
            }),
        ),
      )
    })

    const getCommand = Effect.fn("InstanceHttpApi.command")(function* () {
      return yield* command.list()
    })

    // origami_change-start (t-qdc718): answer from the cross-process agent snapshot cache.
    //
    // This route is what `session/new` waits on (ACP `acp.directory.mode.defaultAgent.load`),
    // and building the registry cost ~930 ms in EVERY engine process - i.e. in every new
    // chat - of which ~812 ms is the plugin-runtime wait the registry does to turn
    // configured references into permission allow-globs. The build is a pure function of
    // the inputs `AgentSnapshotCache.key` hashes, so a hit is not "probably still right",
    // it is the same answer. `snapshot-cache.ts` states the one input it cannot see.
    //
    // The JSON projection runs on BOTH paths. A hit and a miss must not differ in shape.
    //
    // On a hit the real registry is still built, but AFTER the chat is interactive: the
    // first prompt boots the plugin runtime anyway, and rebuilding refreshes the cache for
    // the next process. The delay is deliberate - doing it immediately would stall the very
    // `session/new` this cache exists to speed up.
    const getAgent = Effect.fn("InstanceHttpApi.agent")(function* () {
      const directory = yield* InstanceState.directory
      const cacheKey = AgentSnapshotCache.key({
        directory,
        config: yield* config.get(),
        skillDirs: yield* skill.dirs(),
      })
      const cached = AgentSnapshotCache.read(cacheKey)
      if (cached) {
        yield* agent.list().pipe(
          Effect.delay("5 seconds"),
          Effect.tap((fresh) => Effect.sync(() => AgentSnapshotCache.write(cacheKey, fresh))),
          Effect.ignore,
          Effect.forkDetach,
        )
        return cached
      }
      const fresh = yield* agent.list()
      AgentSnapshotCache.write(cacheKey, fresh)
      return AgentSnapshotCache.toSnapshot(fresh)
    })
    // origami_change-end

    const getSkill = Effect.fn("InstanceHttpApi.skill")(function* () {
      return yield* skill.all()
    })

    const getLsp = Effect.fn("InstanceHttpApi.lsp")(function* () {
      return yield* lsp.status()
    })

    const getFormatter = Effect.fn("InstanceHttpApi.formatter")(function* () {
      return yield* format.status()
    })

    return handlers
      .handle("dispose", dispose)
      .handle("path", getPath)
      .handle("vcs", getVcs)
      .handle("vcsStatus", getVcsStatus)
      .handle("vcsDiff", getVcsDiff)
      .handle("vcsDiffRaw", getVcsDiffRaw)
      .handle("vcsApply", applyVcs)
      .handle("command", getCommand)
      .handle("agent", getAgent)
      .handle("skill", getSkill)
      .handle("lsp", getLsp)
      .handle("formatter", getFormatter)
  }),
)
