<script lang="ts">
  // STORAGE — the Nests view's per-desk storage card (t-s9jr6u, mock round 4
  // section 2; round 5 "edit, then Apply"). It replaces Insights' "Session
  // store" card: storage now lives in the Nests view only (owner, round 6).
  //
  // Desk tabs, one stacked bar, five classes with a Keep window each. This
  // desk is editable; the mother base keeps "Everything"; another desk is
  // read-only, because its windows belong to that desk. Measuring is a BUTTON:
  // the scan reads every row of a multi-gigabyte store.
  //
  // The host half is nestStoragePane.ts over L4a's nest_storage / nest_retention.
  // Until L4a is in the engine the reply is `pending` and the card stays in its
  // measuring state with the host's one-line reason under it.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { tip } from '../../shared/WarmTooltip.svelte';
  import { ago, deskLabel, HOME_WORD, type NestDesk } from './nestsStatus';
  import {
    CLASSES, WINDOWS, dirtySummary, sizeLabel as formatBytes, dirtyWindows, readStats, readWindows, totalBytes, windowFromOption, windowOption,
    type NestStorageStats, type NestWindowClass, type NestWindows,
  } from './nestStorageModel';
  import { NO_ANSWER, RETAIN_NOTE, answerClock, measuringLabel, readProgress } from './nestStorageSettle';

  // selfName: this desk's host name before it is in any nest (no desk list yet).
  let { desks, selfName = 'This desk' }: { desks: NestDesk[]; selfName?: string } = $props();
  const vscode = getVsCodeApi();

  let shut = $state(false);
  let measuring = $state(true);
  let pending: string | null = $state(null);
  let error: string | null = $state(null);
  let stats: NestStorageStats | null = $state(null);
  let stored: NestWindows | null = $state(null);
  let chosen: Partial<NestWindows> = $state({});
  let frees: number | null = $state(null);
  let confirming = $state(false);
  let sel = $state('');
  let progress: number | null = $state(null);
  // t-vb87lt: after a failed dry run or Apply, Retry sends that call again.
  let redo: (() => void) | null = $state(null);
  // t-vbivj4: silence after a request ends the measure with an error and Retry (nestStorageSettle.ts).
  const clock = answerClock(() => { measuring = false; pending = null; progress = null; error = NO_ANSWER; });

  let solo = $derived(desks.length < 2);
  let self = $derived(desks.find((d) => d.self) ?? null);
  let home = $derived(desks.find((d) => d.motherBase) ?? null);
  let tabs = $derived(solo ? [self ?? { id: '', name: selfName, self: true, online: true, motherBase: false, os: '' as const, lastSeen: 0 }] : desks);
  let current = $derived(tabs.find((d) => d.id === sel) ?? tabs.find((d) => d.self) ?? tabs[0]!);
  let kind = $derived(!solo && current.motherBase ? 'home' : current.self ? 'self' : 'other');
  // t-xum9go: Held sizes are this desk's own scan; show them whenever current IS
  // this desk, home or not ("home" only fixes the Keep column to "Everything").
  let isSelf = $derived(current.self);
  let dirty = $derived(stored ? dirtyWindows(stored, chosen) : {});
  let nDirty = $derived(Object.keys(dirty).length);

  function measure(): void {
    measuring = true;
    error = null;
    redo = null;
    clock.wait();
    vscode.postMessage({ type: 'requestNestStorage' });
  }
  function choose(k: NestWindowClass, raw: string): void {
    chosen = { ...chosen, [k]: windowFromOption(raw) };
    frees = null;
    retain(true); // A dry run names what Apply would free before anything is removed.
  }
  function retain(dryRun: boolean): void {
    if (!stored) return;
    error = null;
    redo = () => retain(dryRun);
    vscode.postMessage({ type: 'nestRetentionSet', windows: $state.snapshot({ ...stored, ...chosen }), dryRun });
  }

  $effect(() => {
    const onMsg = (event: MessageEvent) => {
      const msg = event.data || {};
      if (msg.type === 'nestStorageData') {
        pending = typeof msg.pending === 'string' ? msg.pending : null;
        error = typeof msg.error === 'string' ? msg.error : null;
        redo = null;
        progress = readProgress(msg);
        measuring = pending !== null || progress !== null;
        if (progress !== null) clock.wait(); else clock.answered();
        if (msg.stats) stats = readStats(msg.stats, msg.measuredAt);
        const w = readWindows(msg.retention);
        if (w) stored = w;
      } else if (msg.type === 'nestRetentionData') {
        error = typeof msg.error === 'string' ? msg.error : typeof msg.pending === 'string' ? msg.pending : null;
        frees = typeof msg.frees === 'number' ? msg.frees : null;
        if (msg.dryRun === false && !msg.error && !msg.pending) {
          const w = readWindows(msg.retention);
          if (w) stored = w;
          chosen = {};
          confirming = false;
        }
      }
    };
    window.addEventListener('message', onMsg);
    measure();
    return () => { window.removeEventListener('message', onMsg); clock.answered(); };
  });

  const skeleton = $derived(measuring && isSelf && !stats);
  const total = $derived(stats ? totalBytes(stats) : 0);
</script>

<section class="card storage" class:is-shut={shut} data-name="storage">
  <div class="head">
    <button class="chev" aria-expanded={!shut} aria-label="Collapse Storage" onclick={() => (shut = !shut)}>▾</button>
    <span class="caps">Storage</span><span class="count">{tabs.length}</span>
    <span class="sub">{measuring ? measuringLabel(progress) : stats?.measuredAt ? `measured ${ago(stats.measuredAt, Date.now())}` : ''}</span>
    <span class="grow"></span>
    <button class="btn" disabled={measuring && !pending} onclick={() => (error && redo ? redo() : measure())}>{measuring && !pending ? 'Measuring…' : error ? 'Retry' : 'Measure'}</button>
  </div>
  {#if !shut}
    <div class="mtabs" role="tablist">
      {#each tabs as d (d.id)}
        <button class="mtab" class:is-sel={d.id === current.id} role="tab" aria-selected={d.id === current.id} onclick={() => (sel = d.id)}>
          <span class="dot" class:off={!d.online}></span>
          <span class="mtab-main">
            <span class="mtab-name">{deskLabel(d)}{#if !solo && d.motherBase}<span class="home-mark" use:tip={HOME_WORD}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h8V6.5"/></svg></span>{/if}{#if d.self}<span class="muted">{' · this desk'}</span>{/if}</span>
            <span class="mtab-size">{#if d.self && skeleton}<span class="skel"></span>{:else if d.self && stats}{formatBytes(total)}{:else}—{/if}</span>
          </span>
        </button>
      {/each}
    </div>
    <div class="stack" aria-hidden="true">
      {#each CLASSES as c (c.key)}<i class={`sw-${c.key}`} style:flex={isSelf && stats && total ? String(stats.classes[c.key] / total) : '1'}></i>{/each}
    </div>
    <div class="classes">
      <span class="ch">Class</span><span class="ch right">Held</span><span class="ch right">Keep</span>
      {#each CLASSES as c (c.key)}
        {@const isDirty = c.key !== 'journal' && c.key in dirty}
        <span class="cl" class:is-dirty={isDirty}><span class={`swatch sw-${c.key}`}></span><span>{c.label}</span></span>
        <span class="cs">{#if skeleton}<span class="skel"></span>{:else if isSelf && stats}{formatBytes(stats.classes[c.key])}{:else}—{/if}</span>
        <span class="ck">
          {#if c.key === 'journal'}
            {#if isSelf && stats}<span class="pill" class:ok={stats.journalCompact} class:warn={!stats.journalCompact}
              use:tip={`${stats.perPart.toFixed(1)} events per part. ` + (stats.journalCompact ? 'The journal is the sync base; it follows the chats window.' : 'Every streamed word is a full copy of the part. Compacting keeps one event per part.')}>{stats.journalCompact ? 'compact' : 'not compact'}</span>{/if}
            <span class="fixed">follows chats</span>
          {:else if kind === 'home'}<span class="fixed">Everything</span>
          {:else if kind === 'other' || !stored}<span class="fixed">—</span>
          {:else}
            <select class="sel" class:is-dirty={isDirty} aria-label={`Keep ${c.label}`} value={windowOption(c.key in chosen ? (chosen[c.key as NestWindowClass] ?? null) : stored[c.key as NestWindowClass])}
              onchange={(e) => choose(c.key as NestWindowClass, e.currentTarget.value)}>
              {#each WINDOWS as w (w.label)}<option value={windowOption(w.value)}>{w.label}</option>{/each}
            </select>
          {/if}
        </span>
      {/each}
    </div>
    {#if pending}<p class="foot muted" role="status">{pending}</p>{/if}
    {#if error}<p class="foot err" role="alert">{error}</p>{/if}
    {#if solo}
      <div class="note warn"><span class="dot wait"></span><span>This desk is not in a nest. No other desk holds a copy, so a window here deletes old content for good.</span></div>
    {:else if kind === 'home'}
      <p class="foot">{deskLabel(current)} is the {HOME_WORD}, so it keeps every class in full. To change this, choose another {HOME_WORD} in Desks.</p>
    {:else if kind === 'other'}
      <!-- t-xum9go: no verb sends another desk's figures over the nest wire. -->
      <p class="foot">Set on {deskLabel(current)}. Sizes are not shared between desks; open Storage on {deskLabel(current)} to see them.</p>
    {:else if confirming}
      <div class="pop" role="dialog" aria-label="Apply the new windows">
        <div class="pop-title">Remove {frees === null ? 'the older content' : formatBytes(frees)} from {deskLabel(current)}?</div>
        <p>{RETAIN_NOTE} {home ? `${deskLabel(home)} has a copy of each chat.` : ''}</p>
        <div class="row"><button class="btn danger" onclick={() => retain(false)}>Remove</button><button class="btn quiet" onclick={() => (confirming = false)}>Cancel</button></div>
      </div>
    {:else if nDirty && stored}
      <div class="foot dirty">
        <span>{dirtySummary(stored, dirty)}</span><span class="grow"></span>
        {#if frees !== null}<span>Frees <b class="free">{formatBytes(frees)}</b></span>{/if}
        <button class="link" onclick={() => { chosen = {}; frees = null; }}>Revert</button>
        <button class="btn primary" onclick={() => (confirming = true)}>Apply…</button>
      </div>
    {:else}
      <p class="foot">Past the window a chat keeps its row in the list.{home ? ` Its body comes back from ${deskLabel(home)} when you open it.` : ''}</p>
    {/if}
  {/if}
</section>

<style>
  .card {
    background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 12px 14px;
    display: flex; flex-direction: column; gap: 8px; min-width: 0; color: var(--og-text); font-size: 11.5px; line-height: 1.4;
  }
  .head { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
  .chev { width: 16px; height: 16px; padding: 0; border: 0; background: transparent; cursor: pointer; color: var(--og-text-muted); font-size: 10px; line-height: 16px; transition: transform 160ms ease; }
  .card.is-shut .chev { transform: rotate(-90deg); }
  .caps { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-muted); font-weight: 600; }
  .count { min-width: 16px; padding: 0 5px; border: 1px solid var(--og-border); border-radius: 8px; text-align: center; color: var(--og-text-muted); font-size: 10px; line-height: 14px; }
  .sub { font-size: 10.5px; color: var(--og-text-muted); margin-left: 4px; }
  .grow { flex: 1 1 auto; }
  .muted { color: var(--og-text-muted); font-weight: 400; }
  .btn { font: inherit; font-size: 11px; padding: 4px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap; background: var(--og-btn-bg); color: var(--og-btn-text); border: 1px solid var(--og-border); }
  .btn:hover { background: var(--og-btn-hover); }
  .btn:disabled { opacity: 0.55; cursor: default; }
  .btn.primary { background: var(--og-chat); color: var(--og-bg); border-color: var(--og-chat); font-weight: 600; }
  .btn.quiet { background: transparent; color: var(--og-text-secondary); }
  .btn.danger { color: var(--og-error-text); border-color: color-mix(in srgb, var(--og-error) 60%, var(--og-border)); background: transparent; }
  .link { font: inherit; font-size: 10.5px; background: none; border: 0; padding: 0; cursor: pointer; color: var(--og-text-secondary); }
  .link:hover { color: var(--og-text); text-decoration: underline; }
  .mtabs { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 5px; }
  .mtab { font: inherit; display: flex; align-items: center; gap: 7px; min-width: 0; height: 34px; padding: 0 9px; text-align: left; cursor: pointer; background: var(--og-input-bg); border: 1px solid var(--og-border); border-radius: 6px; color: var(--og-text); }
  .mtab:hover { border-color: color-mix(in srgb, var(--og-chat) 50%, var(--og-border)); }
  .mtab.is-sel { border-color: var(--og-chat); box-shadow: 0 0 0 1px var(--og-chat); }
  .mtab-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
  .mtab-name { font-size: 11.5px; font-weight: 600; display: flex; align-items: center; gap: 5px; white-space: nowrap; overflow: hidden; }
  .mtab-size { font-size: 10px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .home-mark { color: var(--og-accent); width: 10px; height: 10px; flex: 0 0 auto; display: inline-flex; }
  .home-mark svg { width: 10px; height: 10px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; background: var(--og-success); }
  .dot.off { background: transparent; box-shadow: inset 0 0 0 1.5px var(--og-text-muted); }
  .dot.wait { background: var(--og-warning); }
  .stack { display: flex; height: 6px; border-radius: 3px; overflow: hidden; background: var(--og-border); gap: 1px; }
  .stack > i { display: block; height: 100%; min-width: 2px; }
  .sw-chats { background: var(--og-chat); }
  .sw-subagents { background: var(--og-accent); }
  .sw-toolOutput { background: var(--og-warning); }
  .sw-journal { background: var(--og-text-muted); }
  .sw-artifacts { background: var(--og-success); }
  .classes { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; font-size: 11px; }
  .ch { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-muted); font-weight: 600; padding-bottom: 3px; border-bottom: 1px solid var(--og-border); }
  .ch.right { text-align: right; padding-left: 14px; }
  .cl, .cs, .ck { min-height: 26px; display: flex; align-items: center; border-bottom: 1px solid color-mix(in srgb, var(--og-border) 55%, transparent); }
  .cl { gap: 7px; min-width: 0; }
  .cl.is-dirty { box-shadow: inset 2px 0 0 var(--og-chat); padding-left: 6px; }
  .swatch { width: 8px; height: 8px; border-radius: 2px; flex: 0 0 auto; }
  .cs { padding-left: 14px; justify-content: flex-end; font-variant-numeric: tabular-nums; }
  .ck { padding-left: 14px; justify-content: flex-end; gap: 6px; }
  .sel { font: inherit; font-size: 10.5px; padding: 2px 4px; color: var(--og-text); background: var(--og-bg); border: 1px solid var(--og-input-border); border-radius: 5px; min-width: 96px; }
  .sel.is-dirty { border-color: var(--og-chat); }
  .fixed { font-size: 10.5px; color: var(--og-text-muted); min-width: 96px; text-align: right; }
  .pill { display: inline-flex; align-items: center; padding: 0 6px; height: 16px; border-radius: 8px; border: 1px solid var(--og-border); font-size: 9.5px; font-weight: 600; white-space: nowrap; }
  .pill.ok { color: var(--og-success-text); border-color: color-mix(in srgb, var(--og-success) 60%, var(--og-border)); }
  .pill.warn { color: var(--og-warning-text); border-color: color-mix(in srgb, var(--og-warning) 60%, var(--og-border)); }
  .skel { display: inline-block; height: 8px; width: 48px; border-radius: 4px; background: linear-gradient(90deg, var(--og-border), color-mix(in srgb, var(--og-border) 40%, var(--og-surface)), var(--og-border)); background-size: 200% 100%; animation: shim 1.2s linear infinite; }
  @keyframes shim { to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) { .skel { animation: none; } }
  .foot { margin: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 10.5px; color: var(--og-text-muted); }
  .foot.dirty { color: var(--og-text-secondary); }
  .foot.err { color: var(--og-error-text); }
  .free { color: var(--og-text); font-variant-numeric: tabular-nums; }
  .note { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; font-size: 11px; background: var(--og-surface-alt); border: 1px solid var(--og-border); color: var(--og-text-secondary); }
  .note.warn { border-color: color-mix(in srgb, var(--og-warning) 45%, var(--og-border)); }
  .pop { background: var(--og-surface); border: 1px solid color-mix(in srgb, var(--og-warning) 55%, var(--og-border)); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; font-size: 11px; }
  .pop-title { font-weight: 600; font-size: 11.5px; }
  .pop p { margin: 0; color: var(--og-text-secondary); }
  .row { display: flex; gap: 6px; flex-wrap: wrap; }
</style>
