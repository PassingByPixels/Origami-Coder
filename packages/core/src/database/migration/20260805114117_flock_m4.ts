import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260805114117_flock_m4",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`collab_task\` (
          \`id\` text PRIMARY KEY,
          \`collab_id\` text NOT NULL,
          \`title\` text NOT NULL,
          \`owner_slug\` text,
          \`state\` text NOT NULL,
          \`created_by\` text NOT NULL,
          \`result\` text,
          \`note\` text,
          \`origin_seq\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_collab_task_collab_id_collab_id_fk\` FOREIGN KEY (\`collab_id\`) REFERENCES \`collab\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`collab_turn_cost\` (
          \`id\` text PRIMARY KEY,
          \`collab_id\` text NOT NULL,
          \`agent_slug\` text NOT NULL,
          \`model\` text NOT NULL,
          \`tokens_input\` integer NOT NULL,
          \`tokens_output\` integer NOT NULL,
          \`cost\` real NOT NULL,
          \`asked_by\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_collab_turn_cost_collab_id_collab_id_fk\` FOREIGN KEY (\`collab_id\`) REFERENCES \`collab\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`collab_message\` ADD \`kind\` text DEFAULT 'say' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`collab_message\` ADD \`mentions\` text;`)
      yield* tx.run(`ALTER TABLE \`collab_message\` ADD \`task_id\` text;`)
      yield* tx.run(`ALTER TABLE \`collab_message\` ADD \`trace\` text;`)
      yield* tx.run(`ALTER TABLE \`collab\` ADD \`lead_slug\` text;`)
      yield* tx.run(`ALTER TABLE \`collab\` ADD \`objective\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
