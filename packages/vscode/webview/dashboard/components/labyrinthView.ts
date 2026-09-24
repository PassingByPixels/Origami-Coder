/**
 * Which of the Labyrinth pane's two views is on screen.
 *
 * IN ITS OWN MODULE for the same reason `MapMode` is in labyrinthLayout.ts: the
 * pane owns the value and the pill row renders it, so the type has to be
 * importable by both, and a Svelte component's instance script cannot export one.
 */
export type LabyrinthView = 'labyrinth' | 'glidepath';
