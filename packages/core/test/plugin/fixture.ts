import { AgentV2 } from "@origami/core/agent"
import { AISDK } from "@origami/core/aisdk"
import { Catalog } from "@origami/core/catalog"
import { CommandV2 } from "@origami/core/command"
import { Credential } from "@origami/core/credential"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNodePlatform } from "@origami/core/effect/app-node-platform"
import { LayerNode } from "@origami/core/effect/layer-node"
import { EventV2 } from "@origami/core/event"
import { FileSystem } from "@origami/core/filesystem"
import { FSUtil } from "@origami/core/fs-util"
import { Integration } from "@origami/core/integration"
import { Location } from "@origami/core/location"
import { Npm } from "@origami/core/npm"
import { PluginV2 } from "@origami/core/plugin"
import { Reference } from "@origami/core/reference"
import { SkillV2 } from "@origami/core/skill"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    EventV2.node,
    LayerNodePlatform.httpClient,
    PluginV2.node,
    AgentV2.node,
    AISDK.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    Reference.node,
    SkillV2.node,
  ]),
  [
    [Location.node, tempLocationLayer],
    [Npm.node, npmLayer],
  ],
)
