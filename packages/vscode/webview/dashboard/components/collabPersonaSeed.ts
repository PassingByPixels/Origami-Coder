// Collabs M4.2 - collabPersonaSeed.ts: the default persona a NEW bot's body
// arrives pre-filled with.
//
// WHY A SEED AT ALL. The box used to open EMPTY. An empty box is the worst
// thing a form can ask a system prompt for: it gives no sign of what one looks
// like, or of how long one should be, so the agents that got made carried
// one-line personas that said less than their own slug already did. A seed is
// a starting point to EDIT, not a default to keep.
//
// WHY IT IS NOT WRITTEN BY THE SERIALISER. A seed belongs to the FORM, never to
// the file format. A def on disk with an empty body means the user meant it
// empty, and seeding at write time would put words in their mouth on every
// save - including on saves of files they never opened this box for.
//
// W9 OWNER RULING REWROTE THE TEXT, on three counts:
//
//  1. IT OPENS AS AN IDENTITY. "You are the bot Scout." A persona composes ON
//     TOP of the base agent prompt (the engine's own prompt matrix: a bot
//     session is base prompt + persona), so a seed that re-announced being a
//     coding assistant spent context saying what had just been said.
//  2. NO ROOM LANGUAGE, at all. This one file seeds a bot that will run alone
//     in a chat, in a collab room, and as somebody's sub-agent - the same def
//     in all three. The room's rules are injected by the runner at turn time
//     (collab/collab-agent-base.txt), so a persona that named the room was
//     wrong two times in three. The seed no longer even POINTS at that manual:
//     a solo bot has no manual to be pointed at.
//  3. ONE SEED, NOT ONE PER PRESET. The Worker/Observer buttons went with W9,
//     and a new bot is born ticked on every tool - so there is no preset for a
//     seed to follow. What is left is a set of generic agentic habits, phrased
//     for a workspace this build has never seen, because this text ships to
//     strangers and their repo is not ours.

/** Addressed when the name box is still the bare `collab-` default, so the seed
 *  never reads "You are the bot ." in the half-second before the user types. */
const UNNAMED = 'Agent';

/**
 * The name a seed addresses the agent by: the slug without its `collab-`
 * prefix, capitalised. The prefix is dropped for the same reason the glyph disc
 * drops it - it is filing, not identity, and an agent introduced to a room as
 * "collab-crane" is being introduced by its filename.
 */
export function seedName(slug: string): string {
  // `vision-` joins `collab-` (t-kgtr6c): both are FILING prefixes on the same
  // directory, and a card headed "Vision-eye" reads as a name somebody chose
  // rather than a folder it lives in. Anchored, so only a leading prefix goes —
  // `collab-precollab-thing` keeps its second one, and so would `vision-vision`.
  const bare = slug.replace(/^(?:collab|vision)-/, '').trim();
  if (!bare) return UNNAMED;
  return bare[0]!.toUpperCase() + bare.slice(1);
}

/**
 * The seed, addressed to `slug`'s name.
 *
 * SHORT ON PURPOSE. A persona is a role card; the rulebook is the base prompt
 * underneath it. Six habits is the most a starting point can carry and still
 * read as something to edit rather than something to obey.
 *
 * WORKSPACE-AGNOSTIC ON PURPOSE. "If this workspace keeps its own notes" is
 * conditional because this text ships to strangers: naming a file that only
 * exists in one repo would teach every bot everywhere to go looking for it.
 */
export function personaSeed(slug: string): string {
  return `You are the bot ${seedName(slug)}.

Read before you write: open the real files first, and name every one you touch by its full path. A change built on a guess about what the code looks like costs more turns than it saves.

If this workspace keeps its own notes - a handoff, a wiki, a decisions folder - read them before re-deriving anything they already settled.

Make small, surgical changes that match the style around them. Touch only what the task needs, and do not describe an edit you could simply make.

Prove what you claim. Run the test, the build or the command that shows it works, and report what you ran and what it printed. Never call something done that you have not seen work; a red result reported honestly beats a green one you invented.

When you are genuinely unsure - a decision that is not yours, a permission you lack, a tool that failed twice - ask, or stop and say exactly where you are. Do not guess quietly.`;
}
