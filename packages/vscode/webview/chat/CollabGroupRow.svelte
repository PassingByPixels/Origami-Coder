<script lang="ts">
  // ONE SPEAKER'S run: the avatar column, one header, and every bubble under it.
  //
  // Extracted from CollabStream.svelte at W5-L2, which stood at 246 lines
  // against a 250-line cap when the council's ROUND row needed a branch of its
  // own — and the ratchet's remedy for that is a module, not a raise.
  //
  // The extraction is the better file either way: with the run out, the stream
  // is a ROUTER over row kinds (a bookkeeping line, a council round, a speaker's
  // run) plus the three standing rows at its foot, and each kind's markup now
  // sits with the CSS that draws it.
  //
  // GROUPING IS THE POINT, and it is `buildStreamRows`'s decision, not this
  // file's: an agent that answers in four paragraphs used to print four
  // identical author/time headers, which reads as four people. This draws what
  // that leaf decided.
  //
  // The avatar comes down as a SNIPPET, the same way CollabLivePill takes it:
  // one agent must not be a brand animal in the transcript and a letter disc
  // here.
  import type { Snippet } from 'svelte';
  import CollabMessageBubble from './CollabMessageBubble.svelte';
  import { kindLabel, kindTone } from './collabKinds';
  import { fmtTime } from './collabStreamMarks';
  import type { CollabMessage as Message } from '../../src/acpExtTypes';

  interface Props {
    authorId: string;
    authorKind: 'human' | 'agent';
    msgs: Message[];
    /** What this surface calls the speaker: 'You' for a human, else its short name. */
    name: string;
    /** The full text the short name was mined from — the header's tooltip. Only
     *  meaningful for an agent, and only used for one. */
    fullName: string;
    /** Resolves any OTHER slug, for the `A → B` flow rail inside a bubble's label. */
    shortOf: (slug: string) => string;
    avatar: Snippet<[string, 'human' | 'agent']>;
  }
  let { authorId, authorKind, msgs, name, fullName, shortOf, avatar }: Props = $props();
</script>

<div class="cs-group" class:human={authorKind === 'human'}>
  <div class="cs-avatar" aria-hidden="true">{@render avatar(authorId, authorKind)}</div>
  <div class="cs-body">
    <div class="cs-head">
      <span class="cs-author" title={authorKind === 'agent' ? fullName : undefined}>{name}</span>
      <span class="cs-time">{fmtTime(msgs[0].createdAt)}</span>
    </div>
    {#each msgs as m (m.seq)}
      <CollabMessageBubble
        msg={m}
        {authorKind}
        tone={kindTone(m)}
        label={kindLabel(m, shortOf, name)}
        time={fmtTime(m.createdAt)}
      />
    {/each}
  </div>
</div>

<style>
  /* One row per SPEAKER, not per message: avatar column + a body that stacks
     the header and every bubble in the run. Capped below full width and
     pinned to a SIDE — agent left/avatar-left, human right/icon-right — so
     "who is on which side" reads from position alone, the way a real chat
     client does. M4.2: 84% -> 94% (a collab bubble carries code blocks, not
     chat one-liners); a gutter REMAINS, which is what keeps the two sides
     apart and why this is not 100%. CollabLivePill.svelte repeats the number
     and must move with it. */
  .cs-group {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    max-width: 94%;
    padding: 2px;
    border-radius: 6px;
  }
  .cs-group.human {
    align-self: flex-end;
    flex-direction: row-reverse;
  }

  .cs-avatar {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: 1px;
  }
  /* flex+gap, not a sibling margin on the bubble itself: each bubble is a
     SEPARATE component instance now, and Svelte's per-component CSS scoping
     cannot see across instances to apply a `+` sibling rule there. */
  .cs-body { display: flex; flex-direction: column; gap: 4px; flex: 1 1 auto; min-width: 0; }
  .cs-head {
    display: flex;
    align-items: baseline;
    gap: 7px;
    margin-bottom: 1px;
  }
  .cs-author { font-size: 11px; font-weight: 600; color: var(--og-text); }
  .cs-time {
    font-size: 10px;
    color: var(--og-text-muted);
    font-family: var(--vscode-editor-font-family, monospace);
  }
</style>
