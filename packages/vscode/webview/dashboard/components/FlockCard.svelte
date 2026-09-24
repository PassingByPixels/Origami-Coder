<script lang="ts">
  // THE SPECIALTY CARD — what a friend's model reads when it decides whom to
  // ask. It is the second half of the IDENTITY tile, under a hairline rather
  // than in a tile of its own: it is this Origami advertising itself, and the
  // availability line under it is generated from the same policy the desk
  // answers under, so a card that promised more than the budget allows cannot
  // be written here.
  //
  // The draft is re-seeded only when the ENGINE's value changes, so a re-read
  // triggered by some other button does not wipe a half-typed list.

  interface Props {
    specialties: string[];
    /** The one-line "what asking this Origami gets you", built engine-side. */
    availability: string;
    onsave: (specialties: string[]) => void;
  }
  let { specialties, availability, onsave }: Props = $props();

  let draft = $state('');
  let seeded: string | null = $state(null);

  $effect(() => {
    const joined = specialties.join(', ');
    if (joined === seeded) return;
    seeded = joined;
    draft = joined;
  });

  function save(): void {
    onsave(draft.split(',').map((s) => s.trim()).filter(Boolean));
  }

  let dirty = $derived(draft !== (seeded ?? ''));
</script>

<div class="fc-card">
  <span class="fk-caps">Your specialty card</span>
  <div class="fc-row">
    <input
      class="fk-inp grow"
      placeholder="WordPress, vehicle diagnostics, UK MOT rules"
      aria-label="Specialties"
      bind:value={draft}
      onkeydown={(e) => { if (e.key === 'Enter') save(); }}
    />
    <button class="fk-btn" disabled={!dirty} onclick={save}>Save</button>
  </div>
  <p class="fk-muted">
    What your contacts' models read when they choose whom to ask — comma-separated, in your own words.
    Published as: <span class="fk-sec">{availability}</span>
  </p>
</div>

<style>
  /* A hairline, not a head row: the card belongs to the identity above it. */
  .fc-card { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--og-border); padding-top: 8px; }
  .fc-row { display: flex; gap: 8px; align-items: center; flex-wrap: nowrap; }
  .grow { flex: 1; min-width: 0; }
</style>
