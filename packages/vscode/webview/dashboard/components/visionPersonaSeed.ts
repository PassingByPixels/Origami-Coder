// t-kgtr6c round 3 — visionPersonaSeed.ts: the body a NEW VISION PROFILE is
// born with.
//
// WHY IT IS NOT A THIRD BRANCH OF collabPersonaSeed.ts. That module seeds a
// COLLAB agent, and round 2 seeded a profile out of it: a new profile arrived
// carrying the OBSERVER text — "a reviewer in this collab", "find what is wrong
// before it costs anyone an afternoon", "attack proposals". A vision profile is
// in no collab and reviews nothing. It is shown one picture and one question,
// and its whole job is to say what is there. The reviewer seed instructed it to
// do the opposite of its job, which is the defect this file exists to fix.
//
// WHAT THE TEXT HAS TO SAY, and why each part earns its place:
//  - the QUESTION first. The asking model writes a specific question
//    (tool/vision-request.ts) and pays for one answer; a profile that opens with
//    an essay makes it hunt for the sentence it asked for.
//  - FULL detail, with the specifics NAMED — layout, text verbatim, colours,
//    counts, positions. "Describe the image" gets two sentences of gist, and the
//    thing the caller usually needs is the exact string in the error dialog.
//  - say what is UNREADABLE. A confident description of a blurred region is the
//    one failure the asking model cannot detect, because all it ever sees is
//    text that reads exactly like a good answer.
//  - report, do not judge. Stated in words the reviewer seed never used, so the
//    guard in visionPersonaSeed.test.ts can assert the review vocabulary is
//    ABSENT rather than trying to tell two uses of it apart.
//
// LAYERS, not copies. This is the PERSONA: on disk, in the def, editable, and
// the user's to change. Round 4 reads it straight off the def file and makes it
// the SYSTEM prompt of one direct model call. The engine keeps a shorter floor
// of its own in `tool/vision-request.ts` (`DESCRIBE_PERSONA`) underneath it,
// which rides every request and so also covers profiles written before this
// seed existed, and profiles the user has since rewritten. Neither text is a
// copy of the other, so neither owes the other a drift guard.

import { seedName } from './collabPersonaSeed';

/** The seed for a vision profile, addressed to `slug`'s name. `seedName` already
 *  drops the `vision-` filing prefix, so `vision-eye` is addressed as "Eye". */
export function visionPersonaSeed(slug: string): string {
  const name = seedName(slug);
  return `You are ${name}. You are shown an image and one question about it. You are the eyes for another agent, whose own model cannot see pictures at all.

Sometimes you are given a FILE PATH instead of the picture itself. Open that file first, then answer about what it holds. If you are asked about a path you cannot open, say so plainly and stop; do not describe a file you never saw.

Answer the question first, from the image alone. Then set out what the image contains, in full: the layout, every piece of text spelled out verbatim, the colours, the counts, and where each thing sits in relation to the others.

State only what is actually there. If part of the image is blurred, cut off or unreadable, say which part — the agent asking has no way to check a confident guess.

Your job is to report, not to judge: no opinions, no advice, no proposed changes. What is needed back is the picture itself, put into words.`;
}
