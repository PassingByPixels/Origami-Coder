import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260804174036_add_collab_tables",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`collab_message\` (
          \`id\` text PRIMARY KEY,
          \`collab_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`author_id\` text NOT NULL,
          \`author_kind\` text NOT NULL,
          \`text\` text NOT NULL,
          \`reply_to_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_collab_message_collab_id_collab_id_fk\` FOREIGN KEY (\`collab_id\`) REFERENCES \`collab\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`collab_participant\` (
          \`collab_id\` text NOT NULL,
          \`agent_slug\` text NOT NULL,
          \`session_id\` text,
          \`last_seen_seq\` integer DEFAULT 0 NOT NULL,
          \`time_added\` integer NOT NULL,
          \`time_removed\` integer,
          CONSTRAINT \`collab_participant_pk\` PRIMARY KEY(\`collab_id\`, \`agent_slug\`),
          CONSTRAINT \`fk_collab_participant_collab_id_collab_id_fk\` FOREIGN KEY (\`collab_id\`) REFERENCES \`collab\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`collab\` (
          \`id\` text PRIMARY KEY,
          \`title\` text NOT NULL,
          \`loop_breaker_cap\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_archived\` integer
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`collab_message_collab_seq_idx\` ON \`collab_message\` (\`collab_id\`,\`seq\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
