<script lang="ts">
  // SideQuestsDock.svelte — the Side quests drawer's LIVE WIRING (t-f89g49):
  // the one place that asks the host for the list, holds which row is open, and
  // posts the three actions.
  //
  // EXTRACTED from nothing — written here rather than in ChatPane.svelte on the
  // precedent SubagentDock.svelte set: the pane mounts one component and drills
  // two props, and the wire lives with the feature.
  //
  // THE LIST IS A PROJECTION OF A FOLDER, never of webview state. The host reads
  // `.origami/sidequests` on every request and after every action; this file
  // keeps no list of its own beyond the last payload. That is the whole answer to
  // "survives a reload and a chat close": there is nothing to survive.
  //
  // IT ASKS ON MOUNT AND ON FOCUS. The host also watches the folder, but a
  // watcher is a best effort (a workspace whose folder does not exist yet has
  // none, and network drives drop events), so the cheap poll on window focus is
  // the floor under it — the owner comes back to the window before he reads the
  // drawer.
  //
  // FLAG OFF = NOTHING RENDERS. The host never answers `requestSideQuests` when
  // ORIGAMI_EXPERIMENTAL_SIDE_QUESTS is off, so `quests` stays empty, and
  // SideQuestsDrawer.svelte draws no panel and no tab for an empty list.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { isPhoneMount, isSideQuestsData, type SideQuest } from '../panes/sideQuestProps';
  import SideQuestsDrawer from './SideQuestsDrawer.svelte';
  import SideQuestPopup from './SideQuestPopup.svelte';

  interface Props {
    /** The chat cell this drawer floats over — the id `openSideQuestsDrawer`
     *  names, so the host can pull the right one out. */
    sessionId: string;
    open: boolean;
    onToggle: () => void;
  }
  let { sessionId, open, onToggle }: Props = $props();

  const vscode = getVsCodeApi();
  const phone = isPhoneMount();

  let quests = $state<SideQuest[]>([]);
  /** The id whose popup is up, or ''. An ID rather than the record: the list is
   *  replaced wholesale after every action, and a held record would go stale the
   *  moment its own Dismiss landed. */
  let openId = $state('');
  const selected = $derived(quests.find((q) => q.id === openId) ?? null);

  const request = () => vscode.postMessage({ type: 'requestSideQuests' });

  $effect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (isSideQuestsData(data)) quests = data.quests;
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('focus', request);
    request();
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('focus', request);
    };
  });

  /** Every action closes the popup first. The host re-lists straight after the
   *  write, so a popup left up would be showing a row that is already gone. */
  function act(type: 'sideQuestStart' | 'sideQuestExport' | 'sideQuestDismiss', id: string): void {
    openId = '';
    vscode.postMessage({ type, id });
  }
</script>

<SideQuestsDrawer
  {quests}
  {open}
  onToggle={() => {
    // Optimistic locally, and told to the host as well: `openSideQuestsDrawer`
    // is the verb a phone reaches this drawer by (remoteVerbsTable.ts, `watch`),
    // and one verb for both surfaces beats two paths that can disagree. Only the
    // OPEN direction is a verb — shutting a drawer is view state and asks nobody.
    if (!open) vscode.postMessage({ type: 'openSideQuestsDrawer', sessionId });
    onToggle();
  }}
  onOpen={(id) => (openId = id)}
  selectedId={openId}
/>
{#if selected}
  <SideQuestPopup
    quest={selected}
    phoneOnly={phone}
    onClose={() => (openId = '')}
    onStart={() => act('sideQuestStart', selected.id)}
    onExport={() => act('sideQuestExport', selected.id)}
    onDismiss={() => act('sideQuestDismiss', selected.id)}
  />
{/if}
