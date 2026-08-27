export * as PublicEventManifest from "./public-event-manifest"

import { Event } from "@origami/schema/event"
import { EventManifest } from "@origami/schema/event-manifest"

export const Definitions = EventManifest.ServerDefinitions
export const Latest = Event.latest(Definitions)
