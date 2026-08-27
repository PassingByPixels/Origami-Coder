<script lang="ts">
  // ONE COUNCIL ROUND, as one block: every member's independent answer, the
  // room's own n-of-m record, and the reconciliation under it.
  //
  // WHY COLLAPSED PER MEMBER. The value of a round is the SPREAD of positions —
  // who agreed, who did not — and three open essays show a reader one of them
  // and a scrollbar. Each member gets a line with the first of its answer on it;
  // clicking opens that member alone. Nothing is hidden that the reader cannot
  // reach in one click, and nothing is unrolled that they did not ask for.
  //
  // WHY THE RECORD IS A LINE AND NOT A BUBBLE. "2 of 3 answered — ibis failed"
  // is the ROOM talking about itself; it is authored by `collab`, which is
  // nobody's slug, and a bubble with an avatar would read as a fourth speaker.
  //
  // THE COUNT IS NEVER COMPUTED HERE. `roundHeadline` reads the engine's record
  // verbatim, because a member that failed or was stopped left no bubble — so
  // counting the rows on screen would quietly turn "2 of 3" into "2 of 2" and
  // delete the one fact the record exists to state.
  import type { Snippet } from 'svelte';
  import CollabMessageBubble from './CollabMessageBubble.svelte';
  import { kindLabel } from './collabKinds';
  import { roundHeadline, type RoundRow } from './collabCouncil';
  import { fmtTime } from './collabStreamMarks';
  import type { CollabMessage as Message } from '../../src/acpExtTypes';

  interface Props {
    round: RoundRow<Message>;
    /** Resolves a slug to the short name this surface shows. */
    shortOf: (slug: string) => string;
    avatar: Snippet<[string, 'human' | 'agent']>;
  }
  let { round, shortOf, avatar }: Props = $props();

  /** Which members the reader has opened. Keyed by SLUG, not by index: a round
   *  grows while it is open, and an index would move an opened panel onto
   *  somebody else's answer as the next answer lands. */
  let opened = $state<Record<string, boolean>>({});
  const toggle = (slug: string) => { opened[slug] = !opened[slug]; };

  /** The first line of an answer, as the collapsed row's preview. */
  const gist = (text: string): string => {
    const line = text.trim().split('\n').find((l) => l.trim().length > 0) ?? '';
    return line.length > 96 ? `${line.slice(0, 95).trimEnd()}…` : line;
  };
  const firstOf = (msgs: Message[]): string => gist(msgs.map((m) => m.text).join('\n'));
</script>

<div class="cr" class:open={round.record === undefined}>
  <div class="cr-head">
    <span class="cr-mark" aria-hidden="true">⚖</span>
    <span class="cr-line">{roundHeadline(round)}</span>
  </div>

  {#each round.opinions as voice (voice.authorId)}
    <div class="cr-voice">
      <button
        class="cr-toggle"
        aria-expanded={opened[voice.authorId] ? 'true' : 'false'}
        onclick={() => toggle(voice.authorId)}
      >
        <span class="cr-chev" aria-hidden="true">{opened[voice.authorId] ? '▾' : '▸'}</span>
        <span class="cr-avatar" aria-hidden="true">{@render avatar(voice.authorId, 'agent')}</span>
        <span class="cr-who">{shortOf(voice.authorId)}</span>
        <span class="cr-gist">{firstOf(voice.msgs)}</span>
      </button>
      {#if opened[voice.authorId]}
        <div class="cr-full">
          {#each voice.msgs as m (m.seq)}
            <CollabMessageBubble msg={m} authorKind="agent" tone="" label="" time={fmtTime(m.createdAt)} />
          {/each}
        </div>
      {/if}
    </div>
  {/each}

  <!-- The reconciliation, INSIDE the round and visibly apart from the answers
       it reconciles: it is the one contribution that read all of them, so it is
       never collapsed. Absent on an open round, and on a round the human
       stopped — a stopped room writes its record and says nothing more. -->
  {#if round.synthesis}
    {@const s = round.synthesis}
    <div class="cr-synth">
      <div class="cr-synth-head">
        <span class="cr-avatar" aria-hidden="true">{@render avatar(s.authorId, 'agent')}</span>
        <span class="cr-who">{shortOf(s.authorId)}</span>
        <span class="cr-verb">{kindLabel(s.msgs[0], shortOf)}</span>
      </div>
      {#each s.msgs as m (m.seq)}
        <CollabMessageBubble msg={m} authorKind="agent" tone="" label="" time={fmtTime(m.createdAt)} />
      {/each}
    </div>
  {/if}
</div>

<style>
  /* A framed block rather than a run of bubbles: a round is ONE thing the room
     did, and the frame is what says the answers inside it were taken together.
     An OPEN round (no record yet) is dashed — the same "not finished" idiom the
     rest of this surface uses for work still in flight. */
  .cr {
    border: 1px solid var(--og-border);
    border-radius: 8px;
    padding: 7px 9px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    max-width: 94%;
  }
  .cr.open { border-style: dashed; }

  .cr-head { display: flex; align-items: baseline; gap: 6px; }
  .cr-mark { font-size: 11px; color: var(--og-accent-2); }
  .cr-line { font-size: 10px; color: var(--og-text-muted); }

  .cr-voice { display: flex; flex-direction: column; gap: 3px; }
  .cr-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 2px 0;
    cursor: pointer;
    font-family: inherit;
    color: var(--og-text);
    min-width: 0;
  }
  .cr-toggle:hover .cr-gist { color: var(--og-text); }
  .cr-chev { font-size: 9px; color: var(--og-text-muted); flex: 0 0 auto; }
  .cr-avatar { width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; }
  .cr-who { font-size: 11px; font-weight: 600; flex: 0 0 auto; }
  .cr-gist {
    font-size: 11px;
    color: var(--og-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .cr-full { padding-left: 24px; display: flex; flex-direction: column; gap: 4px; }

  /* Above the line, not beside it: the synthesis answers the whole round. */
  .cr-synth {
    border-top: 1px solid var(--og-border);
    padding-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .cr-synth-head { display: flex; align-items: center; gap: 6px; }
  .cr-verb { font-size: 10px; color: var(--og-text-muted); }
</style>
