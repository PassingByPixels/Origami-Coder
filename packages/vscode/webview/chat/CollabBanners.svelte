<script lang="ts">
  // The room's two standing lines — a refusal, and a routing NOTICE. Extracted
  // from CollabPane.svelte, which was one line under its cap when the notice
  // had to be added.
  //
  // They are two different claims and are drawn differently on purpose. An
  // error says something FAILED; the notice says the post succeeded and still
  // reached nobody, which is the engine's `no-lead` answer to an unaddressed
  // message in a room with no lead (report S3). Painting the second one red
  // would tell the user their message was lost — it was not.
  //
  // The WORDING lives here with the markup, the way CollabHopBar owns "hop
  // budget off": the pane carries the engine's code across the wire and never
  // has to know what English it becomes.
  interface Props {
    error?: string;
    /** The engine's `collab_post` notice CODE, not a sentence. A code with no
     *  entry below draws nothing — an unknown notice must not become a blank
     *  banner, and it must not become a guess either. */
    notice?: string;
  }
  let { error = '', notice = '' }: Props = $props();

  const NOTICES: Record<string, string> = {
    'no-lead': 'Nobody is in this collab yet — invite an agent.',
  };
  const noticeText = $derived(NOTICES[notice] ?? '');
</script>

{#if error}
  <div class="banner error-banner">{error}</div>
{/if}

{#if noticeText}
  <div class="banner notice-banner">{noticeText}</div>
{/if}

<style>
  .banner {
    flex-shrink: 0;
    padding: 6px 12px;
    font-size: 11px;
  }
  .error-banner {
    background: color-mix(in srgb, var(--og-error) 16%, transparent);
    color: var(--og-text);
  }
  /* Informational, not a failure — the accent tint the rest of the board uses
     for "read this", never the error red. */
  .notice-banner {
    background: color-mix(in srgb, var(--og-accent) 14%, transparent);
    color: var(--og-text);
  }
</style>
