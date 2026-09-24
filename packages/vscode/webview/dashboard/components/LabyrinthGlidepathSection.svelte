<script lang="ts">
  // The Labyrinth pane's HEADER: the two view pills, and the Glidepath view the
  // second one opens.
  //
  // ITS OWN COMPONENT because LabyrinthPane.svelte is at its architecture cap and
  // its cap note says the next thing to land there must extract rather than shave.
  // It is also a clean seam: the whole glide-path feature — its state, its wire
  // and its clock — reaches the pane through ONE callback saying which view is
  // showing, so the pane keeps nothing of it but a boolean.
  import LabyrinthHeaderPills from './LabyrinthHeaderPills.svelte';
  import GlidepathView from './GlidepathView.svelte';
  import type { GlideProviders, LengthOverrides } from './glidepathMath';
  import type { LabyrinthView } from './labyrinthView';
  import { getVsCodeApi } from '../../shared/vscodeApi';

  let { onView }: { onView: (v: LabyrinthView) => void } = $props();

  const vscode = getVsCodeApi();

  // WHICH VIEW, and why it is not persisted. The map's `mode` is webview state
  // too: both are a way of LOOKING at the pane, not a setting, and a pane that
  // reopens on the view the user last left is a pane that reopens on the wrong
  // one whenever they were only glancing.
  let view: LabyrinthView = $state('labyrinth');

  // The recorded plan-usage history, exactly as the host posts it.
  let providers: GlideProviders = $state({});
  let capable: string[] = $state([]);
  // The user's per-provider cadence overrides, resolved host-side and posted
  // with the readings so the view never has to ask for a setting itself.
  let windowLengths: LengthOverrides = $state({});
  // The HOST's clock at the last sampling pass, advanced locally between passes.
  // A 5-hour window is 10% through in the 30 minutes between passes, so drawing
  // NOW where it stood at the last pass would put the marker visibly behind.
  let now = $state(0);
  let base = 0;
  let baseAt = 0;

  function pick(next: LabyrinthView): void {
    view = next;
    onView(next);
    // Opening the view is one of the three sampling triggers. The host applies
    // its own 5-minute per-provider floor, so a user switching back and forth
    // cannot turn this into a poll.
    if (next === 'glidepath') vscode.postMessage({ type: 'glidepathRequest' });
  }

  $effect(() => {
    if (view !== 'glidepath' || baseAt === 0) return;
    const id = setInterval(() => { now = base + (Date.now() - baseAt); }, 60_000);
    return () => clearInterval(id);
  });

  // Its OWN listener, not the pane's. `glidepathData` is posted after EVERY
  // sampling pass, whether or not this view is on screen — the host does not
  // track which pill a webview is showing. Keeping the latest reading means
  // switching to Glidepath draws immediately instead of waiting for a round trip.
  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type !== 'glidepathData') return;
    providers = msg.providers && typeof msg.providers === 'object' ? msg.providers : {};
    capable = Array.isArray(msg.capable) ? msg.capable : [];
    windowLengths = msg.windowLengths && typeof msg.windowLengths === 'object' ? msg.windowLengths : {};
    base = typeof msg.now === 'number' ? msg.now : Date.now();
    baseAt = Date.now();
    now = base;
  });
</script>

<LabyrinthHeaderPills {view} onView={pick} />

{#if view === 'glidepath'}
  <GlidepathView {providers} {now} {capable} {windowLengths} />
{/if}
