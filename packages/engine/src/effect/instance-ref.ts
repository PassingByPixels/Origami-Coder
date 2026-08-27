import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@origami/core/workspace"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~origami/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~origami/WorkspaceRef", {
  defaultValue: () => undefined,
})
