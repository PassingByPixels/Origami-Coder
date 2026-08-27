import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260818153000_collab_concurrency",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`collab\` ADD \`concurrency\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
