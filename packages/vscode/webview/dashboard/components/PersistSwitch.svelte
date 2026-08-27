<script lang="ts">
  // PersistSwitch — the loop's "keep running when the chat closes" setting.
  //
  // Replaces a button whose CAPTION was the current fact ("Dies with chat" /
  // "Persistent"). That control failed the only two questions a control has to
  // answer on sight: it read as a status label, so nothing said it was
  // clickable, and its text named the STATE rather than the SETTING, so the
  // one word on screen changed meaning depending on a state you could only
  // discover by clicking it. Passing looked straight at it and did not see a
  // toggle.
  //
  // So: a real switch. The name is fixed ("Persistent" — the setting, never the
  // fact), the state is printed BESIDE it in words as well as being carried by
  // the track, and the whole thing is a native checkbox so keyboard and screen
  // readers get switch semantics for free rather than by imitation.
  interface Props {
    checked: boolean;
    onchange: () => void;
  }
  const { checked, onchange }: Props = $props();
</script>

<label class="ps" class:on={checked} title="Persistent: keep this loop running after its chat is closed. It still stops when VS Code closes.">
  <!-- aria-label wins over the wrapping label's text, so the accessible name is
       the SETTING and the state rides on aria-checked (implicit from `checked`)
       — the state word below is not repeated into the name. -->
  <input class="ps-input" type="checkbox" role="switch" aria-label="Persistent" {checked} onchange={() => onchange()} />
  <span class="ps-track" aria-hidden="true"><span class="ps-knob"></span></span>
  <span class="ps-name">Persistent</span>
  <span class="ps-state" aria-hidden="true">{checked ? 'on' : 'off'}</span>
</label>

<style>
  .ps {
    flex-shrink: 0; display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
    border: 1px solid var(--og-border); border-radius: 4px; padding: 1px 7px 1px 5px;
    background: var(--og-btn-bg); font-size: 10px; color: var(--og-text-secondary);
  }
  .ps:hover { background: var(--og-btn-hover); }
  /* Visible-but-not-seen: the native control keeps focus, keyboard and AT
     behaviour; the track below is only its picture. */
  .ps-input { position: absolute; width: 1px; height: 1px; opacity: 0; margin: 0; }
  .ps-track {
    position: relative; width: 20px; height: 11px; border-radius: 6px; flex-shrink: 0;
    background: var(--og-input-bg); border: 1px solid var(--og-border); transition: background 0.12s;
  }
  .ps-knob {
    position: absolute; top: 1px; left: 1px; width: 7px; height: 7px; border-radius: 50%;
    background: var(--og-text-muted); transition: left 0.12s, background 0.12s;
  }
  .ps.on .ps-track { background: var(--og-accent); border-color: var(--og-accent); }
  .ps.on .ps-knob { left: 10px; background: var(--og-bg); }
  .ps.on { color: var(--og-text); border-color: var(--og-accent); }
  .ps-name { font-weight: 600; letter-spacing: 0.01em; }
  .ps-state { color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .ps.on .ps-state { color: var(--og-accent); }
  /* The focus ring has to be drawn on the LABEL — the input it belongs to is
     the invisible one. */
  .ps:focus-within { outline: 1px solid var(--og-accent); outline-offset: 1px; }
</style>
