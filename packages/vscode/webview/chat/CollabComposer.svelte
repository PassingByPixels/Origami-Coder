<script lang="ts">
  // The collab's composer, and the C14 preview under it (W3 wave 3, report 2.5).
  //
  // The BOX itself is the chat's InputBar in bare mode, exactly as CollabPane
  // mounted it before — one box, one set of habits, in both surfaces. What is
  // new is the line beneath it: who this draft would wake, evaluated live.
  //
  // WHY THIS IS ITS OWN COMPONENT. CollabPane was at 437 of its 440-line cap,
  // and the preview is not one line — it is a debounced driver, a wire call, a
  // reply filter and a row. Extraction before addition. It also keeps the whole
  // preview concern in one file: the pane never learns that a draft exists.
  //
  // HOW THE DRAFT IS OBSERVED, and why it is not a prop. InputBar owns its own
  // text and exposes no draft callback; adding one would be a change to the
  // chat composer for a collab-only feature. `input` events bubble, so the
  // wrapper below hears every keystroke of the ONLY textarea inside it. That is
  // the whole coupling: no reach into InputBar's internals, and nothing to keep
  // in step if its markup changes.
  //
  // WHAT MAKES THE SEND SAFE. The driver holds a timer and a memo of the last
  // question, and nothing else — no acknowledgement, no in-flight flag (see
  // collabPreview.ts). `submit` below calls the parent and returns its answer
  // synchronously; there is no await anywhere on this path, so a pending
  // preview cannot hold a message back even by accident.
  import { onMount } from 'svelte';
  import { getVsCodeApi } from '../shared/vscodeApi';
  import CollabPreviewRow from './CollabPreviewRow.svelte';
  import InputBar from '../dashboard/components/InputBar.svelte';
  import { COLLAB_COMMANDS } from './collabSlash';
  import { collabShortName } from './collabNames';
  import { makeCollabPreview, previewText, type CollabPreviewResult } from './collabPreview';

  const vscode = getVsCodeApi();

  interface Props {
    collabId: string;
    archived: boolean;
    /** The ACTIVE roster — what `@` may name, and how a slug becomes a name. */
    roster: Array<{ slug: string; name: string }>;
    canExport: boolean;
    /** The pane's parse-and-post. FALSE is its refusal, and the only case the
     *  draft is kept — so it is also the only case the preview line survives. */
    onSend: (text: string, mode?: string, images?: { dataUrl: string; name: string }[]) => boolean;
    onExport: () => void;
  }
  let { collabId, archived, roster, canExport, onSend, onExport }: Props = $props();

  let result = $state<CollabPreviewResult | null>(null);

  const preview = makeCollabPreview({
    request: (mentions) => {
      if (!collabId) return;
      // OMITTED when empty, exactly as collab_post does it: an unaddressed
      // draft is a real question about the lead, not one addressed to nobody.
      vscode.postMessage({ type: 'collabPreview', collabId, ...(mentions.length ? { mentions } : {}) });
    },
  });

  const nameOf = (slug: string): string =>
    collabShortName(slug, roster.find((r) => r.slug === slug)?.name);
  const line = $derived(previewText(result, nameOf));

  /** Every keystroke of the one textarea in here. Anything else that bubbles an
   *  `input` (there is nothing today) is not a draft and is ignored. */
  function onInput(e: Event) {
    const el = e.target as HTMLElement | null;
    if (el?.tagName !== 'TEXTAREA') return;
    preview.draft((el as HTMLTextAreaElement).value);
  }

  function submit(text: string, mode?: string, images?: { dataUrl: string; name: string }[]): boolean {
    const accepted = onSend(text, mode, images);
    // The box clears on an accepted line WITHOUT firing an input event, so the
    // draft the preview last saw is gone and its answer describes a message
    // that has already been sent. A REFUSED line keeps its draft, and with it
    // the line that is still true.
    if (accepted) {
      preview.reset();
      result = null;
    }
    return accepted;
  }

  onMount(() => {
    const onMsg = (ev: MessageEvent) => {
      const msg = (ev.data || {}) as Record<string, unknown>;
      // `post` fans every reply out to EVERY attached webview — a preview
      // answered for another room would say who a message this room never saw
      // would wake.
      if (msg.type !== 'collabPreviewData' || msg.collabId !== collabId) return;
      result = {
        wake: Array.isArray(msg.wake) ? (msg.wake as string[]) : [],
        ...(msg.notice === 'no-lead' ? { notice: 'no-lead' as const } : {}),
        ...(Array.isArray(msg.unknown) && msg.unknown.length ? { unknown: msg.unknown as string[] } : {}),
      };
    };
    window.addEventListener('message', onMsg);
    return () => {
      window.removeEventListener('message', onMsg);
      // A pane going away must not leave a timer that posts into it.
      preview.stop();
    };
  });
</script>

<!-- The wrapper is the DRAFT OBSERVER and nothing else — see the header. It
     holds only InputBar, so the textarea it hears is always the composer's. -->
<div class="cc-box" oninput={onInput}>
  <InputBar
    bare
    passthroughSlash
    allowImages
    commands={COLLAB_COMMANDS}
    inFlight={false}
    disabled={archived}
    placeholder={archived
      ? 'This collab is archived — hit Resume above to post again.'
      : 'Say something to the collab… (Enter to send, Shift+Enter for a new line, / for commands)'}
    agentName=""
    modelName=""
    onSend={submit}
    onCancel={() => {}}
    {onExport}
    {canExport}
    participants={roster}
  />
</div>

<CollabPreviewRow text={line} />

<style>
  /* A pass-through box: it exists to hear events, and must not change how the
     composer lays out. */
  .cc-box { display: contents; }
</style>
