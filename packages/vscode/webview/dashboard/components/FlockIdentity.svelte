<script lang="ts">
  // THE IDENTITY TILE. Who this Origami is, in the three forms it has — and the
  // one place two of them are EDITED.
  //
  // WHAT MOVES AND WHAT DOES NOT, because the tile has to teach it. The display
  // name and the icon are the owner's to change whenever they like: they are
  // what every contact reads, and they reach those contacts on the next thing
  // either side says. The HANDLE is neither of them. It was minted once from the
  // name in force at the time and it never moves again, because it is the string
  // every contact stored and matches on — so the line under the name shows the
  // handle's OWN label, not `name@`, and the two disagreeing after a rename is
  // the truth rather than a bug to hide.
  //
  // The whole digest is on its own line in monospace, and Copy takes the FULL
  // handle, because the label is not the identity and a tile that only ever
  // showed eight characters would teach that it was.
  //
  // The draft is re-seeded only when the ENGINE's value changes, the same rule
  // FlockCard.svelte follows, so a re-read triggered by some other button does
  // not wipe a half-typed name.
  //
  // Save sits directly under the fields it commits and is NOT pinned to the
  // tile floor: the specialty card is under it in the same tile now, and a
  // `margin-top: auto` here would have pushed the card down with it.
  import ArchetypeGlyph from './ArchetypeGlyph.svelte';
  import FlockIconPicker from './FlockIconPicker.svelte';
  import { iconOf } from '../panes/flockRows';
  import type { FlockIdentityRow } from '../panes/flockTypes';

  interface Props {
    identity: FlockIdentityRow;
    oncopy: (text: string) => void;
    /** Only the fields that changed. The engine leaves an absent one alone. */
    onidentity: (patch: { name?: string; icon?: string }) => void;
  }
  let { identity, oncopy, onidentity }: Props = $props();

  let name = $state('');
  let icon = $state('');
  let seeded: string | null = $state(null);

  $effect(() => {
    const wire = JSON.stringify([identity.name, iconOf(identity)]);
    if (wire === seeded) return;
    seeded = wire;
    name = identity.name;
    icon = iconOf(identity);
  });

  let renamed = $derived(name.trim().length > 0 && name.trim() !== identity.name);
  let repicked = $derived(icon !== iconOf(identity));
  let dirty = $derived(renamed || repicked);

  function save(): void {
    if (!dirty) return;
    onidentity({ ...(renamed ? { name: name.trim() } : {}), ...(repicked ? { icon } : {}) });
  }
</script>

<div class="fk-count-row">
  <!-- The mark the owner picked, at the size a contact's row draws it. It is
       their own icon and not a hashed disc: there is one identity on this page,
       and initials would say "one of several" about it. -->
  <span class="fk-avatar big"><ArchetypeGlyph id={icon} size={24} /></span>
  <div class="who">
    <input
      class="fk-inp"
      aria-label="Your display name"
      placeholder="What your contacts call you"
      bind:value={name}
      onkeydown={(e) => { if (e.key === 'Enter') save(); }}
    />
    <div class="fk-mono fk-sec" title="The label your contacts stored. It does not follow a rename.">
      {identity.handleShort}…
    </div>
  </div>
</div>
<FlockIconPicker value={icon} onchange={(picked) => (icon = picked)} />
<code class="fk-fp" title="The whole hash of this Origami's signing key">{identity.fingerprint}</code>
<div class="fk-do">
  <button class="fk-btn primary" disabled={!dirty} onclick={save}>Save</button>
  <button class="fk-btn" onclick={() => oncopy(identity.handle)}>
    <svg class="fk-ico sm" aria-hidden="true"><use href="#fk-copy" /></svg> Copy full handle
  </button>
</div>
<p class="fk-muted">
  Your name and icon are what every contact sees, and they reach them on the next question either
  of you asks. Your handle never changes — it is the label they matched you on.
</p>

<style>
  .who { min-width: 0; flex: 1; }
  .who .fk-inp { width: 100%; }
  .fk-avatar.big { width: 40px; height: 40px; font-size: 14px; background: var(--og-crane); }
</style>
