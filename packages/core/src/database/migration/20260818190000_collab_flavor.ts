import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260818190000_collab_flavor",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`collab\` ADD \`flavor\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
