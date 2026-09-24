<script lang="ts">
  // THE PICTURE THE RELAY CARD IS FOR: phone — sealed — relay — sealed —
  // desktop, with the middle box drawn blind.
  //
  // A person deciding whose relay to trust is deciding one thing: can the
  // operator read any of this. Three tiles and two padlocks answer it in the
  // time it takes to look, which no paragraph does — and the caption under each
  // tile carries the same claim as TEXT, so a screen reader gets the answer too
  // and the diagram itself stays aria-hidden.
  //
  // Its own leaf, and capped at 520px: at the full width of a 1900px pane the
  // same five columns become a wire fence with three postage stamps on it.
  import {
    REMOTE_ICON_CHECK, REMOTE_ICON_DESKTOP, REMOTE_ICON_KEY, REMOTE_ICON_LOCK, REMOTE_ICON_PHONE,
    REMOTE_ICON_SERVER,
  } from './remoteIcons';
</script>

<div class="hdia">
  <span class="htile lit" aria-hidden="true">
    <svg class="hglyph" viewBox="0 0 24 24">{@html REMOTE_ICON_PHONE}</svg>
    <span class="hbadge"><svg viewBox="0 0 24 24">{@html REMOTE_ICON_KEY}</svg></span>
  </span>
  <span class="hwire" aria-hidden="true">
    <i></i><span class="hlock"><svg viewBox="0 0 24 24">{@html REMOTE_ICON_LOCK}</svg></span><i></i>
  </span>
  <span class="htile blind" aria-hidden="true">
    <svg class="hglyph" viewBox="0 0 24 24">{@html REMOTE_ICON_SERVER}</svg>
  </span>
  <span class="hwire" aria-hidden="true">
    <i></i><span class="hlock"><svg viewBox="0 0 24 24">{@html REMOTE_ICON_LOCK}</svg></span><i></i>
  </span>
  <span class="htile lit" aria-hidden="true">
    <svg class="hglyph" viewBox="0 0 24 24">{@html REMOTE_ICON_DESKTOP}</svg>
    <span class="hbadge"><svg viewBox="0 0 24 24">{@html REMOTE_ICON_CHECK}</svg></span>
  </span>

  <span class="hcap"><b>Your phone</b><span>key in the chip</span></span>
  <span class="hseal">sealed</span>
  <span class="hcap"><b>Relay</b><span>cannot open them</span></span>
  <span class="hseal">sealed</span>
  <span class="hcap"><b>Your desktop</b><span>checks the key</span></span>
</div>

<style>
  .hdia {
    display: grid; grid-template-columns: minmax(0, 1fr) 34px minmax(0, 1fr) 34px minmax(0, 1fr);
    align-items: center; row-gap: 6px; width: 100%; max-width: 520px; margin: 0 auto; padding: 4px 0 2px;
  }
  .htile {
    position: relative; width: 40px; height: 40px; border-radius: 12px; background: var(--og-surface-alt);
    border: 1px solid var(--og-border); display: grid; place-items: center; justify-self: center;
  }
  .htile.lit { border-color: var(--og-accent); }
  .hglyph {
    width: 21px; height: 21px; color: var(--og-accent-2); stroke: currentColor; fill: none;
    stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round;
  }
  /* The middle box is drawn DIMMER than the ends, because that is the fact: it
     is the one thing in the picture that knows nothing. */
  .htile.blind .hglyph { color: var(--og-text-muted); }
  .hbadge {
    position: absolute; right: -5px; bottom: -5px; width: 18px; height: 18px; border-radius: 50%;
    background: var(--og-accent); border: 2px solid var(--og-surface); display: grid; place-items: center;
  }
  .hbadge svg {
    width: 10px; height: 10px; color: var(--og-text); stroke: currentColor; fill: none; stroke-width: 2;
    stroke-linecap: round; stroke-linejoin: round;
  }
  .hwire { display: flex; align-items: center; justify-self: stretch; }
  .hwire i { flex: 1; border-top: 1px dashed var(--og-border); }
  .hlock {
    flex: 0 0 auto; width: 20px; height: 20px; border-radius: 6px; background: var(--og-input-bg);
    border: 1px solid var(--og-border); display: grid; place-items: center;
  }
  .hlock svg {
    width: 11px; height: 11px; color: var(--og-success); stroke: currentColor; fill: none;
    stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round;
  }
  .hcap { text-align: center; min-width: 0; padding: 0 1px; }
  .hcap b { display: block; color: var(--og-text); font-weight: 600; }
  .hcap span { display: block; color: var(--og-text-secondary); }
  .hseal {
    align-self: start; text-align: center; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--og-text-muted); font-weight: 600;
  }
</style>
