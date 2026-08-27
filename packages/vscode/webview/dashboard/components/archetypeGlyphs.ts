// Agent Manager - archetypeGlyphs.ts (S11): brand-menagerie glyphs for the typed
// archetypes, harvested from Desktop/origami-trailer/origami-svgs (the same
// low-poly origami family the crane comes from). Each source SVG is a 64x64
// viewBox of currentColor polygons with per-polygon opacity plus a root
// style="color:..." brand tint; we STRIP the tint (the glyph inherits the card's
// text colour) and keep only polygons + opacity. Group-level opacity (the leg /
// shadow <g opacity=".45"> in some source files) is flattened INTO each child
// polygon's opacity, which is visually identical at glyph size and lets the
// renderer stay a flat polygon list. Data-only + no vscode import so it is shared
// by AgentCard and the create form; ArchetypeGlyph.svelte draws it.
//
// One glyph per agent-type id: tsuru=crane (the brand default wears the crane
// sigil itself), architect=elephant, ask=cat, debug=fox, orchestrator=wolf,
// plan=dragon (Passing's call after the Kami retirement - the dragon moved to
// the engine's built-in plan mode), cartographer=deer (S15). Everything else
// (the engine default / an unharvested type) maps to null - no glyph, since a
// mystery animal on an unknown type would only mislead.
//
// W9 MADE THIS A MENAGERIE. Nine marks cannot answer "which one is mine, at a
// glance, in a list", so twenty-six more creatures were drawn in the same
// language and the seven type-named sets above gained ANIMAL names as aliases.
// This file is now the composition and the two lookups; the parts live next
// door, and all three neighbours import `type GlyphPoly` back from here, which
// is erased at compile time and so is not a runtime cycle:
//   collabGlyphs.ts     HERON + SCOUT, the art drawn for this board
//   menagerieGlyphs.ts  the twenty-six, all of them
//   glyphNames.ts       the alias table, `glyphKey`, and which keys are OFFERED
import { HERON, SCOUT } from './collabGlyphs';
import { MENAGERIE } from './menagerieGlyphs';
import { glyphKey, offeredGlyphKeys } from './glyphNames';

export interface GlyphPoly {
  pts: string;
  op: number;
}

const GLYPHS: Record<string, GlyphPoly[]> = {
  // the twenty-six (W9); data in menagerieGlyphs.ts.
  ...MENAGERIE,
  // heron - the collab seed pair's second bird (M2); data in collabGlyphs.ts.
  heron: HERON,
  // scout - the read-only recon archetype (Folds Board D7); data in collabGlyphs.ts.
  scout: SCOUT,
  // crane.svg (the brand sigil - Tsuru is the crane)
  tsuru: [
    { pts: '30,40 47,40 52,11', op: 0.45 },
    { pts: '26,40 48,40 43,7', op: 0.92 },
    { pts: '44,40 62,29 47,48', op: 0.72 },
    { pts: '28,39 48,41 36,55', op: 1 },
    { pts: '21,44 28,39 36,55', op: 0.7 },
    { pts: '9,12 15,13 28,41 22,44', op: 0.85 },
    { pts: '9,12 15,13 14,19 2,17', op: 1 },
  ],
  // dragon.svg
  plan: [
    { pts: '26,30 52.5,17.5 46,34', op: 0.45 },
    { pts: '6,15.5 8,8.5 9.5,14', op: 0.65 },
    { pts: '8.5,14.5 17.5,7 11.5,17', op: 0.9 },
    { pts: '19,26 54,10 27,32.5', op: 1 },
    { pts: '54,10 43,32.5 27,32.5', op: 0.8 },
    { pts: '27,32.5 43,32.5 34,40.5', op: 0.5 },
    { pts: '9.5,40 13.5,42 11.5,54 5.5,54', op: 0.62 },
    { pts: '23,42 27.5,43.5 32,54 25.5,54', op: 0.5 },
    { pts: '2.5,17 10,13 13,20 6,18.5', op: 1 },
    { pts: '6,18.5 13,20 9,21.5 4.5,20.5', op: 0.7 },
    { pts: '13,20 19,26 13,29 9,21.5', op: 0.85 },
    { pts: '9,21.5 13,29 12,46 6.5,36', op: 1 },
    { pts: '13,29 19,26 27,32.5 28,46 12,46', op: 0.75 },
    { pts: '27,32.5 34,40.5 28,46', op: 0.6 },
    { pts: '28,46 34,40.5 45,40 38,46.5', op: 0.85 },
    { pts: '45,40 53,43.5 38,46.5', op: 0.6 },
    { pts: '45,40 62,36.5 53,43.5', op: 0.95 },
  ],
  // elephant.svg
  architect: [
    { pts: '24,39 29.5,39 28.5,57 23.5,57', op: 0.45 },
    { pts: '41,39 47,39 46,57 40.5,57', op: 0.45 },
    { pts: '25,8.5 48,10 57,16.5 50,19.5 27,17', op: 0.6 },
    { pts: '50,19.5 57,16.5 59.5,32 49,39', op: 0.95 },
    { pts: '27,17 50,19.5 49,39 22,39', op: 0.78 },
    { pts: '11,17.5 25,8.5 27,17 22,39 13,26', op: 0.68 },
    { pts: '49,39 59.5,32 57,58 51.5,58', op: 0.82 },
    { pts: '13,26 22,39 20.5,58 14.5,58', op: 0.78 },
    { pts: '6.5,11.5 8.5,7 17,4.5 25,8.5 11,17.5', op: 0.78 },
    { pts: '14.5,6.5 34,11.5 23.5,35.5', op: 1 },
    { pts: '6.5,11.5 11,17.5 8.5,31 4,29', op: 0.66 },
    { pts: '4,29 8.5,31 6,45.5 3.5,45', op: 0.9 },
  ],
  // cat.svg
  ask: [
    { pts: '20,35.5 24.5,41.5 23.5,56 19.5,56', op: 0.45 },
    { pts: '47,56 48,52.5 59,53.5 59,56', op: 0.7 },
    { pts: '59,53.5 62,46.5 59,56', op: 0.88 },
    { pts: '43,34 40,56 47,56 50,45', op: 0.5 },
    { pts: '43,34 27,47 31,56 40,56', op: 0.85 },
    { pts: '29,51 24.5,56 31,56', op: 0.65 },
    { pts: '16,30 43,34 27,47', op: 0.75 },
    { pts: '16,30 25,26 43,34', op: 1 },
    { pts: '13,23.5 23,18 25,26 16,30', op: 0.85 },
    { pts: '5.5,5 3.5,13.5 10.5,11', op: 0.8 },
    { pts: '20.5,5.5 14.5,10 21.5,13', op: 0.55 },
    { pts: '3,18 3.5,13.5 10.5,11 14.5,10 21.5,13 23,18', op: 1 },
    { pts: '3,18 23,18 13,23.5', op: 0.6 },
    { pts: '16,30 21,32 19,51.5 13.5,51.5', op: 0.9 },
    { pts: '13.5,51.5 19,51.5 19.5,56 8.5,56', op: 0.65 },
  ],
  // fox.svg
  debug: [
    { pts: '10,3.5 10,19.5 19.5,13.5', op: 0.7 },
    { pts: '8,21 19.5,13.5 22.5,15', op: 0.95 },
    { pts: '16,32.5 8,21 22.5,15', op: 0.58 },
    { pts: '22.5,15 34.5,25.5 16,32.5', op: 1 },
    { pts: '22.5,15 40.5,7 34.5,25.5', op: 0.8 },
    { pts: '34.5,25.5 16,32.5 19.5,31', op: 0.74 },
    { pts: '19.5,31 16.5,44 34.5,25.5', op: 0.9 },
    { pts: '34.5,25.5 25,51 16.5,44', op: 0.62 },
    { pts: '34.5,25.5 32.5,31 25,51', op: 0.76 },
    { pts: '34.5,25.5 34.5,33 32.5,31', op: 0.68 },
    { pts: '16.5,44 20,53 21.5,48', op: 0.82 },
    { pts: '16.5,44 21.5,48 25,51', op: 0.7 },
    { pts: '32.5,31 34.5,33 28.5,54.5 25,51', op: 0.7 },
    { pts: '28.5,54.5 20.5,63.5 25,51', op: 0.5 },
    { pts: '20,53 20.5,63.5 25,51 21.5,48', op: 0.88 },
    { pts: '34.5,33 44.5,42.5 28.5,54.5', op: 0.55 },
    { pts: '31,57 28.5,54.5 44.5,42.5', op: 0.66 },
    { pts: '31,57 25,63.5 38.5,63.5', op: 0.85 },
    { pts: '38.5,63.5 45.5,64 44.5,42.5 31,57', op: 0.48 },
    { pts: '44.5,42.5 45.5,58.5 45.5,64', op: 0.45 },
    { pts: '44.5,42.5 46,50.5 45.5,58.5', op: 0.5 },
    { pts: '44.5,42.5 46,50.5 47.5,42.5', op: 0.52 },
    { pts: '46,50.5 48.5,61 45.5,64 45.5,58.5', op: 0.6 },
    { pts: '48.5,61 54,52.5 47.5,42.5 46,50.5', op: 0.72 },
    { pts: '47.5,42.5 57.5,31.5 56,50.5 54,52.5', op: 0.42 },
  ],
  // wolf.svg
  orchestrator: [
    { pts: '19,36 23,36 26.5,50 22,50', op: 0.45 },
    { pts: '41,41.5 45.5,41 43.5,50 39.5,50', op: 0.45 },
    { pts: '16.5,16 19.5,8 20.5,15', op: 0.55 },
    { pts: '13.5,16 15.5,8 18,16', op: 0.85 },
    { pts: '3.5,20 13.5,15.5 20.5,15 17.5,21.5', op: 1 },
    { pts: '3.5,20 17.5,21.5 11,27.5', op: 0.7 },
    { pts: '17.5,21.5 20.5,15 24,21.5', op: 0.6 },
    { pts: '11,27.5 17.5,21.5 19,36 14.5,36', op: 0.92 },
    { pts: '17.5,21.5 24,21.5 26,35.5 19,36', op: 0.7 },
    { pts: '24,21.5 38,25.5 39,42 26,35.5', op: 0.88 },
    { pts: '38,25.5 42.5,27 45.5,41 39,42', op: 0.68 },
    { pts: '42.5,27 57,41.5 50.5,45 45.5,41', op: 0.78 },
    { pts: '14.5,36 19,36 23.5,51 19,51', op: 0.7 },
    { pts: '39,42 45.5,41 37.5,51 33,51', op: 0.55 },
  ],
  // deer.svg (the <g opacity=".45"> legs flattened into each child's opacity)
  cartographer: [
    { pts: '36.5,45.5 39,45 38,59.5 36,59.5', op: 0.45 },
    { pts: '20.5,44.5 24.5,45 22,59.5 19.5,59.5', op: 0.45 },
    { pts: '43,16.5 41,9.5 43,2 43.5,9.5 45.5,16', op: 0.6 },
    { pts: '46,15.5 45,9 46.5,2 47.5,7.5 51.5,4.5 48.5,9.5 48.5,14.5', op: 0.85 },
    { pts: '44,18 38.5,14.5 42,21', op: 0.55 },
    { pts: '14,40 9.5,37.5 13,44.5', op: 0.55 },
    { pts: '12.5,40.5 17,52 14.5,57.5 15,61 12,61', op: 0.85 },
    { pts: '40,45.5 43.5,45 43,57.5 44.5,61 41.5,61', op: 0.8 },
    { pts: '43.5,18 48.5,25 45.5,38 36.5,33.5', op: 0.95 },
    { pts: '18,34.5 36.5,33.5 34,47 24,46.5', op: 0.88 },
    { pts: '18,34.5 24,46.5 17,52 12.5,40.5', op: 0.72 },
    { pts: '36.5,33.5 45.5,38 43,47.5 34,47', op: 0.6 },
    { pts: '43.5,18 48.5,14.5 58,21.5', op: 1 },
    { pts: '43.5,18 58,21.5 48.5,25', op: 0.7 },
  ],
};

/** The glyph polygons for an agent-type id OR a collab agent slug, or null when
 *  neither has a brand animal (the engine default, any unharvested id). The key
 *  is normalised first — see collabGlyphs.glyphKey — so `collab-crane` resolves
 *  to the tsuru sigil without a second copy of it in the table above. */
export function archetypeGlyph(id: string): GlyphPoly[] | null {
  return GLYPHS[glyphKey(id)] ?? null;
}

/** Every glyph the PICKER offers, sorted — derived from the table, never a
 *  hand-kept list. CollabAgentForm.svelte held one of those until W9, and it had
 *  already fallen a glyph behind the table it was supposed to describe: `scout`
 *  shipped and nothing offered it. A drawing nobody can choose is not shipped. */
export function glyphKeys(): string[] {
  return offeredGlyphKeys(Object.keys(GLYPHS));
}
