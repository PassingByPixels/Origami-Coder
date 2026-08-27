import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260805182109_collab_images",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`collab_message\` ADD \`images\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
