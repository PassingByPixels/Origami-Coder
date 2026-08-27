// Block-glyph wordmark, drawn cell by cell by three renderers: component/logo.tsx
// (TUI home screen), util/presentation.ts (session epilogue) and
// packages/engine/src/cli/ui.ts (CLI banner). They share one mark alphabet:
//
//   _  interior counter  - a space painted on the shadow background
//   ^  interior top edge - ▀ painted on the shadow background
//   ~  open-bottom foot  - ▀ drawn in the shadow colour only
//   ,  shadow ▄          - component/logo.tsx ONLY; the other two renderers
//                          print it literally, so keep it out of this mark
//
// Row 0 is blank headroom. It keeps the mark 4 rows tall so the home-screen
// block height does not move. left = "ORI" (muted), right = "GAMI" (bright);
// the renderers join the halves with a single column of gap.
export const logo = {
  left: ["             ", "█▀▀█ █▀▀█ ▀█▀", "█__█ █^^▄  █ ", "▀▀▀▀ ▀~~▀ ▀▀▀"],
  right: ["                   ", "█▀▀▀ █▀▀█ █▀▄▀█ ▀█▀", "█_^█ █^^█ █___█  █ ", "▀▀▀▀ ▀~~▀ ▀~~~▀ ▀▀▀"],
}

// Single-letter mark for the compact run splash. Same row count as `logo`, so
// consumers that skip the headroom row read it as `badge.slice(1)`.
export const badge = ["    ", "█▀▀█", "█__█", "▀▀▀▀"]

export const marks = "_^~,"
