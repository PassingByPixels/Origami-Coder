<script lang="ts">
  // Activity feed — plain, UNBRANDED cron/ambient stream.
  //
  // Replaces the donor's Diarchy CustodianFeed (Lili/Nyx oversight +
  // sigils + per-custodian tabs — all DELETED). Origami is coder-first
  // single-agent: there is no two-agent surface. This pane just renders
  // the `origami/feedMessage` bus stream (cron job ticks, model
  // load/unload, scheduler heartbeats) as a flat timestamped list so a
  // human can see autonomous activity. No sigils, no custodian names.

  interface FeedRow {
    busKind: string;
    summary: string;
    at: string;
  }

  let rows = $state<FeedRow[]>([]);
  const MAX_ROWS = 200;

  function summarise(busKind: string, payload: Record<string, unknown>): string {
    const tail = (s: unknown) => String(s ?? '').slice(0, 160);
    switch (busKind) {
      case 'tick':
        return `scheduler heartbeat (epoch=${payload['epoch_secs'] ?? '?'})`;
      case 'model_loaded':
        return `model loaded: ${payload['model'] ?? '?'} on ${payload['endpoint'] ?? '?'}`;
      case 'model_unloaded':
        return `model unloaded: ${payload['model'] ?? '?'} from ${payload['endpoint'] ?? '?'}`;
      default: {
        // Cron job start/complete + anything else: show the kind + a
        // short JSON tail. No custodian-specific decoding.
        const job = payload['job_name'];
        if (job) return `${busKind}: ${tail(job)}`;
        return `${busKind}: ${JSON.stringify(payload).slice(0, 160)}`;
      }
    }
  }

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type === 'feedMessage') {
      const busKind = typeof msg.busKind === 'string' ? msg.busKind : 'unknown';
      const payload = (msg.payload ?? {}) as Record<string, unknown>;
      const at = new Date().toLocaleTimeString('en-GB', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      rows = [{ busKind, summary: summarise(busKind, payload), at }, ...rows].slice(0, MAX_ROWS);
    }
  });
</script>

<div class="feed">
  {#if rows.length === 0}
    <div class="feed-empty">No background activity yet. Cron ticks, model loads, and scheduler events appear here.</div>
  {:else}
    <ul class="feed-list">
      {#each rows as r, i (i)}
        <li class="feed-row">
          <span class="feed-at">{r.at}</span>
          <span class="feed-kind">{r.busKind}</span>
          <span class="feed-summary">{r.summary}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .feed { height: 100%; overflow-y: auto; padding: 6px 8px; }
  .feed-empty {
    padding: 16px;
    text-align: center;
    font-size: 12px;
    color: var(--og-text-muted);
    font-style: italic;
  }
  .feed-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .feed-row {
    display: flex;
    gap: 8px;
    font-size: 11px;
    padding: 3px 4px;
    border-bottom: 1px solid var(--og-border);
    align-items: baseline;
  }
  .feed-at { color: var(--og-text-muted); flex: 0 0 auto; font-variant-numeric: tabular-nums; }
  .feed-kind { color: var(--og-chat); flex: 0 0 auto; font-weight: 600; }
  .feed-summary { color: var(--og-text-secondary); flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; }
</style>
