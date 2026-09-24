<script lang="ts">
  // THE ENROLLED DEVICE KEY, shown so the owner can CHECK it.
  //
  // The pairing is anonymous on the wire, so until now the only handle the pane
  // could show was the rendezvous id. A phone running the Origami Remote app
  // mints a P-256 key at scan time and sends its fingerprint on every hello; the
  // desktop enrols the first one it sees and refuses every other. That makes the
  // fingerprint the one value that answers "is the phone reading my session the
  // phone in my hand" — but only if the owner can COMPARE it, which needs the
  // FULL 43 characters (the app's Settings screen shows the same string) and a
  // copy button, not a truncated chip.
  //
  // IT IS A FOLD, OPEN BY DEFAULT. Comparing 43 characters is a thing you do
  // once per phone, and the fold's own summary says so while it is open ("fold
  // after you have compared it"). Open is the default because a fingerprint
  // nobody ever opened is a fingerprint nobody ever compared; the answer is
  // remembered per pairing, so the NEXT phone's key arrives unfolded again.
  //
  // Its own component rather than more markup in RemoteDeviceRow.svelte: that
  // file is the NAME (an inline edit with a commit/abandon rule) and this is a
  // read-only identity block with a clipboard. Neither wants the other's state.
  import { REMOTE_ICON_CHECK, REMOTE_ICON_COPY } from './remoteIcons';

  interface Props {
    device: { name: string; fp: string; platform: string; app: string; backend: string };
    /** Whether the fingerprint fold stands open. Owned by the pane, which is
     *  where the webview's persisted state bag is written. */
    open: boolean;
    onfold: (open: boolean) => void;
  }
  let { device, open, onfold }: Props = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** `navigator.clipboard` is not guaranteed in a webview, and a copy button
   *  that silently does nothing is worse than one that is not there — so the
   *  execCommand path stays as the fallback and the tick only shows on success. */
  async function copy(): Promise<void> {
    let ok = false;
    try {
      await navigator.clipboard.writeText(device.fp);
      ok = true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = device.fp;
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
    }
    if (!ok) return;
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 1600);
  }

  // "software key" rather than "software": the phone's own word is `software`,
  // and a badge reading just that names a category, not a risk.
  let backend = $derived(device.backend === 'secure-enclave' ? 'Secure Enclave' : 'software key');
  let enclave = $derived(device.backend === 'secure-enclave');
  let meta = $derived([device.platform, device.app].filter((s) => s.trim()).join(' · '));
</script>

<div class="key">
  <div class="head">
    <span class="who">{device.name.trim() || 'Paired device'}</span>
    {#if meta}<span class="meta">{meta}</span>{/if}
    <span class="badge" class:enclave>{backend}</span>
  </div>
  <details class="fpd" {open} ontoggle={(e) => onfold(e.currentTarget.open)}>
    <summary>
      <span class="caps">Key fingerprint</span>
      <span class="fold-hint">fold after you have compared it</span>
    </summary>
    <div class="fp-row">
      <code class="fp">{device.fp}</code>
      <button class="icon-btn" title="Copy the fingerprint" aria-label="Copy the fingerprint" onclick={copy}>
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">{@html copied ? REMOTE_ICON_CHECK : REMOTE_ICON_COPY}</svg>
      </button>
      <span class="said" aria-live="polite">{copied ? 'Copied' : ''}</span>
    </div>
    <p class="note">
      Compare this with the fingerprint in the app's Settings screen. Only this key is served: a
      second phone holding a copy of the pairing gets the handshake and nothing else.
    </p>
  </details>
</div>

<style>
  .key { display: flex; flex-direction: column; gap: 4px; padding: 8px; border: 1px solid var(--og-border); border-radius: 5px; background: var(--og-bg); }
  .head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .who { font-size: 11.5px; font-weight: 600; }
  .meta { color: var(--og-text-secondary); }
  .badge {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; padding: 1px 6px;
    border-radius: 4px; border: 1px solid var(--og-border); color: var(--og-text-muted); background: var(--og-input-bg);
  }
  .badge.enclave { color: var(--og-success); border-color: var(--og-success); }
  .fpd summary { display: flex; align-items: center; gap: 8px; cursor: pointer; list-style: none; }
  .fpd summary::-webkit-details-marker { display: none; }
  .fpd summary::before { content: '\25BE'; font-size: 10px; color: var(--og-text-muted); }
  .fpd:not([open]) summary::before { content: '\25B8'; }
  /* The instruction only makes sense while the thing it names is on screen. */
  .fold-hint { font-size: 10px; color: var(--og-text-muted); }
  .fpd:not([open]) .fold-hint { display: none; }
  .caps { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-muted); font-weight: 600; }
  .fp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
  /* The WHOLE fingerprint, wrapping rather than truncated: it is only useful
     when every character can be compared with the one on the phone. */
  .fp {
    font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; line-height: 1.5; color: var(--og-text);
    background: var(--og-input-bg); border: 1px solid var(--og-border); border-radius: 4px; padding: 2px 6px;
    word-break: break-all; min-width: 0; flex: 1 1 120px; max-width: 300px;
  }
  .said { color: var(--og-success); font-size: 10px; }
  .icon-btn { display: inline-flex; padding: 2px; border: none; background: none; cursor: pointer; color: var(--og-text-muted); border-radius: 4px; flex: 0 0 auto; }
  .icon-btn:hover { color: var(--og-text); background: var(--og-btn-hover); }
  .ico { width: 13px; height: 13px; stroke: currentColor; fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .note { margin: 0; margin-top: 4px; color: var(--og-text-secondary); }
</style>
