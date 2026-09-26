<script lang="ts">
  // t-xsufpe: "Review as plan" under a plan-mode answer with no plan_exit.
  // Rules: reviewAsPlan.ts. Minimal on purpose: lane R2 (t-yyz5qi) owns the
  // look of the plan review surface.
  import { planAnswer, reviewAsPlanPrompt, type PlanRow } from './reviewAsPlan';

  let { sessionId, rows, inFlight, onSend }: {
    sessionId: string;
    rows: readonly PlanRow[];
    inFlight: boolean;
    onSend: (text: string) => void;
  } = $props();

  // The chat's mode, from the same host messages the composer reads.
  let mode = $state('default');
  $effect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || (msg.sessionId != null && msg.sessionId !== sessionId)) return; // as InputBar's forThisSession
      if (msg.type === 'modeUpdate' && typeof msg.mode === 'string') mode = msg.mode;
      if (msg.type === 'modeOptions' && typeof msg.current === 'string') mode = msg.current;
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });

  let answer = $derived(planAnswer(rows, mode, inFlight));
</script>

{#if answer}
  <div class="review-as-plan">
    <button type="button" onclick={() => onSend(reviewAsPlanPrompt(answer!))}>Review as plan</button>
  </div>
{/if}

<style>
  .review-as-plan { padding: 4px 12px; }
</style>
