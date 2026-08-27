<script lang="ts">
  // Collabs — one message's bubble, extracted from CollabStream.svelte (close
  // to its architecture cap) so the markdown + bubble/code-block styling below
  // has room to live. The markdown itself is rendered by collabMarkdown.ts,
  // which mirrors MessageRow.svelte's chat pipeline — same escaping, same
  // highlighted code blocks — so a collab bubble and a chat one read
  // identically wherever they carry the same kind of content.
  //
  // Flock M4 renamed the author prop `kind` -> `authorKind`: the wire now has
  // its OWN `kind` (the protocol role — say/ask/answer/…), and two unrelated
  // meanings on one prop name is the collision the contract calls out. The
  // protocol role reaches here already interpreted, as `tone` + `label`, so
  // the vocabulary lives in one leaf (collabKinds.ts) and this file only draws.
  import CollabImages from './CollabImages.svelte';
  import CollabTrace from './CollabTrace.svelte';
  import { renderCollabMessage } from './collabMarkdown';
  import type { CollabMessage } from '../../src/acpExtTypes';

  interface Props {
    msg: CollabMessage;
    /** WHO said it — human or agent. Never the message's protocol kind. */
    authorKind: 'human' | 'agent';
    /** '' for an ordinary message; 'ask'/'handoff' tint the bubble. */
    tone: 'ask' | 'handoff' | '';
    /** One line above the text ('asked @heron'), or '' when there is nothing
     *  a reader could not already see. */
    label: string;
    /** Pre-formatted by the stream, which already owns one clock (the group
     *  header's) — a second formatter here would be a second place for the
     *  two to drift apart. */
    time: string;
  }
  let { msg, authorKind, tone, label, time }: Props = $props();

  const html = $derived(renderCollabMessage(msg.text, authorKind));
  /** An `answer` names the ask it belongs to; anything else with a replyToSeq
   *  keeps today's terser `re #N`. Absent (or null) prints nothing at all. */
  const replyLabel = $derived(
    msg.replyToSeq == null ? '' : msg.kind === 'answer' ? `answer to #${msg.replyToSeq}` : `re #${msg.replyToSeq}`,
  );

  /** Jump to the message this one answers. A real control rather than a bare
   *  label, and guarded because jsdom (and an older webview) has no
   *  scrollIntoView — a missing target must do nothing, never throw. */
  function jumpToReply(): void {
    const el = document.getElementById(`cs-msg-${msg.replyToSeq}`);
    el?.scrollIntoView?.({ block: 'center' });
  }

  // The ONLY interactive part of the rendered markdown: a code block's Copy
  // button. Delegated at the bubble root because {@html} content carries no
  // Svelte event bindings of its own.
  function onClick(e: MouseEvent): void {
    const btn = (e.target as HTMLElement).closest('.copy-btn') as HTMLElement | null;
    if (!btn?.dataset.code) return;
    navigator.clipboard.writeText(btn.dataset.code);
    const prior = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = prior; }, 1200);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div id={`cs-msg-${msg.seq}`} class="cs-msg" class:human={authorKind === 'human'} data-tone={tone} onclick={onClick}>
  {#if replyLabel}<button class="cs-reply" onclick={jumpToReply} title="Show the message this answers">{replyLabel}</button>{/if}
  {#if label}<span class="cs-kind">{label}</span>{/if}
  <div class="msg-text" class:markdown={authorKind === 'agent'}>{@html html}</div>
  <CollabImages images={msg.images} />
  {#if msg.trace && msg.trace.length}<CollabTrace entries={msg.trace} />{/if}
  <span class="cs-msg-time">{time}</span>
</div>

<style>
  /* Bordered, chat-style bubble. HUMAN gets a calm accent tint so the two
     sides read apart at a glance; AGENT stays neutral — agents are told apart
     by their avatar + name (CollabStream), never by a loud per-bubble colour. */
  .cs-msg {
    position: relative;
    border: 1px solid var(--og-border);
    border-radius: 10px;
    background: var(--og-surface);
    padding: 5px 58px 5px 10px;
  }
  .cs-msg.human {
    border-color: color-mix(in srgb, var(--og-accent) 45%, var(--og-border));
    background: color-mix(in srgb, var(--og-accent) 9%, var(--og-surface));
  }

  /* A DIRECTED message is tinted on its border, not its fill: the fill already
     carries human-vs-agent, and two tints on one box read as neither. */
  .cs-msg[data-tone='ask'] { border-color: color-mix(in srgb, var(--og-accent-2) 55%, var(--og-border)); }
  .cs-msg[data-tone='handoff'] { border-color: color-mix(in srgb, var(--og-warning) 55%, var(--og-border)); }

  /* A button, not a span: it jumps to the message it names. */
  .cs-reply { display: block; font-size: 10px; color: var(--og-text-muted); font-family: var(--vscode-editor-font-family, monospace); margin-bottom: 1px; background: none; border: none; padding: 0; cursor: pointer; text-align: left; }
  .cs-reply:hover { color: var(--og-chat); text-decoration: underline; }

  /* The protocol label — what this message DID, above what it said. */
  .cs-kind { display: block; font-size: 10px; font-weight: 600; letter-spacing: 0.02em; color: var(--og-accent-2); margin-bottom: 2px; }
  .cs-msg[data-tone='handoff'] .cs-kind { color: var(--og-warning); }

  .msg-text {
    font-size: 12px;
    color: var(--og-text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  /* Rendered markdown owns its own block spacing (margins on p/ul/h*) — the
     plain-text pre-wrap above would otherwise double up on it. */
  .msg-text.markdown { white-space: normal; }

  /* Every message keeps its own clock, shown on hover/focus rather than
     printed on all of them: the group header carries the one that matters. */
  .cs-msg-time {
    position: absolute;
    right: 10px;
    top: 6px;
    font-size: 10px;
    color: var(--og-text-muted);
    font-family: var(--vscode-editor-font-family, monospace);
    opacity: 0;
    transition: opacity 0.12s;
  }
  .cs-msg:hover .cs-msg-time { opacity: 1; }

  /* --- Markdown rendered content — mirrors MessageRow.svelte's .text rules --- */
  .msg-text :global(p) { margin: 0.3em 0; }
  .msg-text :global(p:first-child) { margin-top: 0; }
  .msg-text :global(p:last-child) { margin-bottom: 0; }
  .msg-text :global(h1), .msg-text :global(h2), .msg-text :global(h3),
  .msg-text :global(h4), .msg-text :global(h5), .msg-text :global(h6) {
    margin: 0.5em 0 0.25em; line-height: 1.3; color: var(--og-text); font-size: 1.05em;
  }
  .msg-text :global(ul), .msg-text :global(ol) { margin: 0.25em 0; padding-left: 1.4em; }
  .msg-text :global(li) { margin: 0.1em 0; }
  .msg-text :global(strong) { color: var(--og-text); }
  .msg-text :global(em) { font-style: italic; }
  .msg-text :global(blockquote) {
    margin: 0.3em 0; padding: 3px 10px; border-left: 3px solid var(--og-text-muted); opacity: 0.85;
  }
  .msg-text :global(a.ext-link) { color: var(--og-chat); text-decoration: underline; text-decoration-style: dotted; }
  .msg-text :global(a.ext-link:hover) { text-decoration-style: solid; }
  .msg-text :global(code) {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    background: var(--og-btn-bg);
    padding: 1px 4px;
    border-radius: 3px;
    color: var(--og-accent-2);
  }

  /* --- Code blocks: same chrome as MessageRow's chat code blocks --- */
  .msg-text :global(.code-block) {
    margin: 0.4em 0; border-radius: 6px; overflow: hidden; border: 1px solid var(--og-border); background: var(--og-bg);
  }
  .msg-text :global(.code-header) {
    display: flex; align-items: center; justify-content: space-between;
    padding: 3px 10px; background: var(--og-surface); border-bottom: 1px solid var(--og-border);
  }
  .msg-text :global(.code-lang) {
    font-size: 10px; font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-muted); text-transform: uppercase; letter-spacing: 0.5px;
  }
  .msg-text :global(.copy-btn) {
    font-size: 10px; padding: 1px 8px; background: transparent; color: var(--og-text-muted);
    border: 1px solid var(--og-border); border-radius: 3px; cursor: pointer; font-family: inherit;
  }
  .msg-text :global(.chart-hint) { font-size: 10px; color: var(--og-warning); margin-right: auto; }
  .msg-text :global(.copy-btn:hover) { color: var(--og-text); background: var(--og-btn-bg); }
  .msg-text :global(pre) { margin: 0; padding: 8px 10px; overflow-x: auto; font-size: 11px; line-height: 1.5; white-space: pre; }
  .msg-text :global(pre code) { background: none; padding: 0; border-radius: 0; color: var(--og-text); font-size: inherit; }

  /* highlight.js token colours — the exact palette MessageRow's chat code
     blocks use, so a snippet looks the same in both surfaces. Fixed rather
     than themed on purpose: code should read like code regardless of theme. */
  .msg-text :global(.hljs-keyword) { color: #c586c0; }
  .msg-text :global(.hljs-built_in) { color: #dcdcaa; }
  .msg-text :global(.hljs-type) { color: #4ec9b0; }
  .msg-text :global(.hljs-literal) { color: #569cd6; }
  .msg-text :global(.hljs-number) { color: #b5cea8; }
  .msg-text :global(.hljs-string) { color: #ce9178; }
  .msg-text :global(.hljs-comment) { color: #6a9955; font-style: italic; }
  .msg-text :global(.hljs-title) { color: #dcdcaa; }
  .msg-text :global(.hljs-params) { color: #9cdcfe; }
  .msg-text :global(.hljs-variable) { color: #9cdcfe; }
  .msg-text :global(.hljs-attr) { color: #9cdcfe; }
  .msg-text :global(.hljs-property) { color: #9cdcfe; }
  .msg-text :global(.hljs-meta) { color: #569cd6; }
</style>
