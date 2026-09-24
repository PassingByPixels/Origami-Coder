// The scaffold's naming + starter-file text, extracted out of toolsPane.ts to keep it under its
// cap. Pure: no vscode import, no I/O.

/** Where a scaffolded tool has to land for the engine to glob it: the registry
 *  scans `{tool,tools}/*.{js,ts}` under each config directory. */
export const TOOL_DIR = ['.origami', 'tool'];

/** A tool name the engine can actually register, or null. The engine derives the tool id from the
 *  FILENAME, which goes straight into a JSON tool schema — anything a model couldn't name (spaces,
 *  dots, path separators, leading digits) must be refused here rather than silently ignored later.
 */
export function toolFileName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return /^[a-z][a-z0-9_]{0,39}$/.test(name) ? name : null;
}

/**
 * A real, runnable tool that LOADS UNEDITED. No imports, deliberately: an
 * earlier version imported `@origami/plugin`, which can never resolve from a
 * workspace `.origami/tool/` folder (unpublished package) and used to break
 * the whole install. The engine recognises a tool by SHAPE instead
 * (`isPluginTool` wants only `description`, `args`, `execute`).
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
