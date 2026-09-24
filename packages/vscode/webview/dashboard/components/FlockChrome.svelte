<script lang="ts">
  // THE PANE'S CHROME: one icon family, one type scale, drawn and declared once.
  //
  // THREE TEXT SIZES AND NOTHING ELSE — 10px small caps for a tile head, 11.5
  // for every sentence, 26 for the one number a reader takes away — on one 8px
  // spacing scale, with one button, one pill and one row. Written here as
  // `:global` rules under `.flock-pane` rather than restated in eleven leaves
  // that would drift the first time one of them was edited on its own. It
  // cannot leak: every selector is prefixed by the pane's own root class.
  //
  // It lives beside the sprite rather than in the pane because they are the
  // same job — the shared visual language — and because a component with a
  // `<style>` block and no markup is a component whose CSS a compiler is
  // entitled to consider unused.
  //
  // ONE ICON FAMILY, DRAWN ONCE.
  //
  // 24-unit box, 1.5 stroke, round caps, currentColor, no fills — the family
  // the pane mocks fixed. Drawn as an SVG sprite at the top of the pane and
  // used by reference (`<use href="#fk-…">`), so a leaf cannot invent a second
  // stroke weight and eleven copies of the same path cannot drift apart.
  //
  // The ids carry an `fk-` prefix because a webview document holds the whole
  // board: an id called `i-users` would be a collision waiting for the next
  // pane that wants a users glyph.
</script>

<svg class="fk-sprite" width="0" height="0" aria-hidden="true" focusable="false"><defs>
  <symbol id="fk-id" viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="14" rx="2"/><circle cx="8.5" cy="11" r="2.2"/><path d="M5 16.5a3.8 3.8 0 0 1 7 0M14.5 10h4M14.5 13.5h4"/></symbol>
  <symbol id="fk-inbox" viewBox="0 0 24 24"><path d="M3 13h5l1.6 2.6h4.8L16 13h5"/><path d="M4.6 5h14.8l1.6 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z"/></symbol>
  <symbol id="fk-users" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5.6a3.2 3.2 0 0 1 0 6.3M17.5 14.4A6 6 0 0 1 21 20"/></symbol>
  <symbol id="fk-send" viewBox="0 0 24 24"><path d="M3.5 12h13M11 6.5l5.5 5.5L11 17.5"/><path d="M20 4v16"/></symbol>
  <symbol id="fk-shield" viewBox="0 0 24 24"><path d="M12 3l7 3v6c0 4.2-3 7.4-7 8.5-4-1.1-7-4.3-7-8.5V6z"/><path d="M9.5 12l1.8 1.8L15 10"/></symbol>
  <symbol id="fk-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="fk-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h9"/></symbol>
  <symbol id="fk-seal" viewBox="0 0 24 24"><circle cx="12" cy="9.5" r="5.5"/><path d="M9.5 14.2L8.5 21l3.5-2 3.5 2-1-6.8"/></symbol>
  <symbol id="fk-relay" viewBox="0 0 24 24"><rect x="6" y="8" width="12" height="8" rx="2" stroke-dasharray="3 2"/><path d="M2 12h4M18 12h4M20 12l-2-2M20 12l-2 2"/></symbol>
  <symbol id="fk-chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></symbol>
  <symbol id="fk-search" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></symbol>
</defs></svg>

<style>
  /* Out of the flow entirely: a zero-size SVG still takes a line box otherwise,
     and the banner below it would sit 4px lower than the mock draws it. */
  .fk-sprite { position: absolute; }

  :global(.flock-pane .fk-caps) { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-muted); font-weight: 600; }
  :global(.flock-pane .fk-display) { font-size: 26px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
  :global(.flock-pane .fk-sec) { color: var(--og-text-secondary); }
  :global(.flock-pane .fk-muted) { color: var(--og-text-muted); margin: 0; }
  :global(.flock-pane .fk-empty) { color: var(--og-text-muted); font-style: italic; margin: 0; }
  :global(.flock-pane .fk-mono) { font-family: var(--vscode-editor-font-family, monospace); }
  :global(.flock-pane .fk-bottom) { margin-top: auto; }
  :global(.flock-pane .fk-ico) { width: 16px; height: 16px; flex: 0 0 auto; stroke: currentColor; fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  :global(.flock-pane .fk-ico.sm) { width: 13px; height: 13px; }
  :global(.flock-pane .fk-ico.lg) { width: 24px; height: 24px; }
  :global(.flock-pane .fk-btn) { font: inherit; background: var(--og-btn-bg); color: var(--og-btn-text); border: 1px solid var(--og-border); border-radius: 5px; padding: 5px 12px; white-space: nowrap; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
  :global(.flock-pane .fk-btn:hover:not(:disabled)) { background: var(--og-btn-hover); }
  :global(.flock-pane .fk-btn:disabled) { opacity: 0.45; cursor: default; }
  :global(.flock-pane .fk-btn.sm) { padding: 1px 8px; font-size: 10px; }
  /* ONE primary per view: the accent fill is reserved for it. */
  :global(.flock-pane .fk-btn.primary) { background: var(--og-accent); border-color: var(--og-accent); color: var(--og-text); font-weight: 600; }
  :global(.flock-pane .fk-btn.danger) { border-color: var(--og-error); color: var(--og-error-text); }
  :global(.flock-pane .fk-inp) { font: inherit; background: var(--og-input-bg); color: var(--og-text); border: 1px solid var(--og-input-border); border-radius: 5px; padding: 5px 8px; min-width: 0; }
  :global(.flock-pane .fk-do) { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  :global(.flock-pane .fk-field) { display: flex; flex-direction: column; gap: 4px; }
  :global(.flock-pane .fk-count-row) { display: flex; align-items: center; gap: 16px; }
  :global(.flock-pane .fk-fp) { display: block; font-size: 10px; color: var(--og-text-secondary); background: var(--og-input-bg); border: 1px solid var(--og-border); border-radius: 4px; padding: 4px 8px; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family, monospace); }
  /* A dot carries the tone, so a pill is still readable where two soft fills
     sit close together in value. */
  :global(.flock-pane .fk-pill) { display: inline-flex; align-items: center; gap: 8px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--og-border); background: var(--og-surface-alt); color: var(--og-text-secondary); white-space: nowrap; }
  :global(.flock-pane .fk-pill b) { color: var(--og-text); font-weight: 600; }
  :global(.flock-pane .fk-dot) { width: 7px; height: 7px; border-radius: 50%; background: var(--og-text-muted); flex: 0 0 auto; }
  :global(.flock-pane .fk-dot.amber) { background: var(--og-accent-2); }
  :global(.flock-pane .fk-pill.ok) { background: var(--og-success-soft); border-color: transparent; color: var(--og-success-text); }
  :global(.flock-pane .fk-pill.ok .fk-dot) { background: var(--og-success); }
  :global(.flock-pane .fk-pill.err) { background: var(--og-error-soft); border-color: transparent; color: var(--og-error-text); }
  :global(.flock-pane .fk-pill.err .fk-dot) { background: var(--og-error); }
  :global(.flock-pane .fk-pill.wait) { border-color: var(--og-status-waiting); color: var(--og-text); }
  :global(.flock-pane .fk-pill.wait .fk-dot) { background: var(--og-status-waiting); }
  :global(.flock-pane .fk-row) { display: flex; align-items: center; gap: 8px; padding: 8px; border: 1px solid var(--og-border); border-radius: 5px; background: var(--og-surface-alt); flex-wrap: wrap; }
  :global(.flock-pane .fk-grow) { flex: 1; min-width: 0; }
  :global(.flock-pane .fk-name) { font-weight: 600; }
  :global(.flock-pane .fk-meta) { color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  :global(.flock-pane .fk-chip) { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--og-text-secondary); background: var(--og-input-bg); border: 1px solid var(--og-border); border-radius: 4px; padding: 1px 5px; cursor: pointer; }
  :global(.flock-pane .fk-chip.static) { cursor: default; }
  :global(.flock-pane .fk-chip:hover) { color: var(--og-chat); border-color: var(--og-chat); }
  :global(.flock-pane .fk-avatar) { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: 10px; font-weight: 700; color: var(--og-bg); flex: 0 0 auto; }
  :global(.flock-pane .fk-check) { display: flex; gap: 8px; align-items: center; padding: 2px 0; cursor: pointer; min-width: 0; }
  :global(.flock-pane .fk-check input) { accent-color: var(--og-accent); }
  :global(.flock-pane .fk-check span) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The wall of prose is one line until it is asked for. */
  :global(.flock-pane .fk-disc) { border-top: 1px solid var(--og-border); padding-top: 8px; }
  :global(.flock-pane .fk-disc > summary) { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px; color: var(--og-text-secondary); }
  :global(.flock-pane .fk-disc > summary::-webkit-details-marker) { display: none; }
  :global(.flock-pane .fk-disc > summary .chev) { width: 13px; height: 13px; transition: transform 0.15s; }
  :global(.flock-pane .fk-disc[open] > summary .chev) { transform: rotate(90deg); }
</style>
