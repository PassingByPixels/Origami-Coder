<script lang="ts">
  // BackdropSetting.svelte — Settings › Appearance › "Dot-grid backdrop"
  // (t-s9jr6u). `origamicoder.chat.backdrop` had no control before this row:
  // settings.json only. The host writes it (chatBackdropSetting.ts) and its
  // reply is a BROADCAST, so every open chat pane redraws at once — no reload,
  // hence no "reload" pill on this row.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import OnOffSwitch from './OnOffSwitch.svelte';
  import SettingRow from './SettingRow.svelte';

  let { filter = '' }: { filter?: string } = $props();
  const vscode = getVsCodeApi();
  // ON until the host answers: the setting's own default.
  let enabled = $state(true);
  let error: string | null = $state(null);

  $effect(() => {
    const onMsg = (event: MessageEvent) => {
      const msg = event.data || {};
      if (msg.type !== 'chatBackdropData') return;
      enabled = msg.enabled !== false;
      error = typeof msg.error === 'string' ? msg.error : null;
    };
    window.addEventListener('message', onMsg);
    vscode.postMessage({ type: 'requestChatBackdrop' });
    return () => window.removeEventListener('message', onMsg);
  });
</script>

<SettingRow id="backdrop" {filter}>
  {#snippet control()}
    <OnOffSwitch checked={enabled} label="Dot-grid backdrop" onchange={(next) => vscode.postMessage({ type: 'chatBackdropSet', enabled: next })} />
  {/snippet}
  {#snippet extra()}{#if error}<div class="bd-error">{error}</div>{/if}{/snippet}
</SettingRow>

<style>
  .bd-error { font-size: 10.5px; color: var(--og-error); }
</style>
