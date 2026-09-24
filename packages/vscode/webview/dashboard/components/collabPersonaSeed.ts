// collabPersonaSeed.ts: the default persona a new bot's body arrives pre-filled with.
//
// An empty box gave no sign of what a persona looks like or how long it
// should be, so agents ended up with one-line personas saying less than
// their own slug already did. A seed is a starting point to edit, not a
// default to keep, so it's not written by the serialiser: a def on disk
// with an empty body means the user meant it empty.
//
// The text opens as an identity ("You are the bot Scout"), since a persona
// composes on top of the base agent prompt and re-announcing being a coding
// assistant would spend context saying what had just been said. No room
// language: this one file seeds a bot that runs alone, in a collab room,
// and as a sub-agent — the room's rules are injected by the runner at turn
// time. One seed, not one per preset, since a new bot is born ticked on
// every tool. What's left is generic agentic habits, phrased for a
// workspace this build has never seen, since this text ships to strangers.

/** Addressed when the name box is still the bare `collab-` default, so the seed
 *  never reads "You are the bot ." in the half-second before the user types. */
const UNNAMED = 'Agent';

/** The name a seed addresses the agent by: the slug without its `collab-`
 *  prefix, capitalised — filing, not identity. */
export function seedName(slug: string): string {
  // `vision-` joins `collab-`: both are filing prefixes on the same
  // directory. Anchored, so only a leading prefix goes.
  const bare = slug.replace(/^(?:collab|vision)-/, '').trim();
  if (!bare) return UNNAMED;
  return bare[0]!.toUpperCase() + bare.slice(1);
}

/** The seed, addressed to `slug`'s name. Short on purpose: a persona is a
 *  role card, not a rulebook. Workspace-agnostic on purpose, since this
 *  text ships to strangers. */
export function personaSeed(slug: string): string {
  return `You are the bot ${seedName(slug)}.

Read before you write: open the real files first, and name every one you touch by its full path. A change built on a guess about what the code looks like costs more turns than it saves.

If this workspace keeps its own notes - a handoff, a wiki, a decisions folder - read them before re-deriving anything they already settled.

Make small, surgical changes that match the style around them. Touch only what the task needs, and do not describe an edit you could simply make.

Prove what you claim. Run the test, the build or the command that shows it works, and report what you ran and what it printed. Never call something done that you have not seen work; a red result reported honestly beats a green one you invented.

When you are genuinely unsure - a decision that is not yours, a permission you lack, a tool that failed twice - ask, or stop and say exactly where you are. Do not guess quietly.`;
}
