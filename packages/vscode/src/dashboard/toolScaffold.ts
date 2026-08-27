// The scaffold's naming + starter-file text. Extracted out of toolsPane.ts
// (t-kgtaac round 3) so the host file stays under its architecture cap — this
// pair was already named as the reason that file sat near its cap before the
// load/unload override was added, and a second self-contained unit landing on
// top of it is exactly the case the cap exists to catch.
//
// Pure: no `vscode` import, no I/O. `toolsPane.ts` is the only caller.

/** Where a scaffolded tool has to land for the engine to glob it: the registry
 *  scans `{tool,tools}/*.{js,ts}` under each config directory. */
export const TOOL_DIR = ['.origami', 'tool'];

/**
 * A tool name the engine can actually register, or null.
 *
 * The engine derives the tool id from the FILENAME (`<basename>` for a default
 * export), and that id goes straight into a JSON tool schema, so anything a
 * model could not name — spaces, dots, path separators, leading digits — has to
 * be refused here rather than written and then silently ignored.
 */
export function toolFileName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return /^[a-z][a-z0-9_]{0,39}$/.test(name) ? name : null;
}

/**
 * A real, runnable tool — and, above all, one that LOADS UNEDITED.
 *
 * NO IMPORTS, deliberately. This used to open with
 * `import { tool } from "@origami/plugin"`, which can never resolve from a
 * workspace `.origami/tool/` folder: that package is workspace-internal and
 * unpublished — `npm view` answers 404. The engine used to npm-install it into
 * every config dir; that never once succeeded and it failed the whole install
 * with it, so the dir's own dependencies did not land either. The add is gone
 * (engine config.ts's `waitForDependencies` note). The import is not needed
 * anyway: the engine recognises a tool by SHAPE (`isPluginTool` in
 * engine/src/tool/registry.ts wants only `description`, `args`, `execute`).
 */
export function toolTemplate(name: string): string {
  return `// This file IS the tool: the engine globs .origami/tool/*.ts at startup and
// registers the default export under this file's name — "${name}". Rename the
// file to rename the tool. A named export becomes "${name}_<exportName>".
//
// No imports on purpose — this file loads as-is. \`args\` is plain JSON Schema.
// With "@origami/plugin" installed in this .origami folder you can instead
// \`import { tool }\` from it and wrap this object in \`tool({ ... })\` for
// Zod-validated arguments.
//
// Reload the window (or start a new session) after editing: tools are read
// once when the engine starts.
export default {
  description: "Describe what this tool does, in the words the model should match on.",
  args: {
    subject: { type: "string", description: "What to act on." },
  },
  async execute(args: { subject: string }, context: { directory: string }) {
    // context gives you sessionID, agent, directory, worktree, abort, and ask()
    // for a permission prompt. Return a string, or { title, output, metadata }.
    return \`${name} ran against \${args.subject} in \${context.directory}\`;
  },
};
`;
}
