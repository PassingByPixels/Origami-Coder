# Third-party notices

This file lists third-party assets that are stored in this source tree, and
their licences. Code dependencies installed from npm are not listed here; their
licences come with each package.

Origami Code is a fork of [OpenCode](https://github.com/anomalyco/opencode).
The MIT licence and copyright of OpenCode are in `LICENSE-UPSTREAM`.

## Fonts

All in `packages/ui/src/assets/fonts/`. The licence texts are next to the fonts.

| File | Source | Licence |
|---|---|---|
| `Inter.ttf` | [Inter](https://github.com/rsms/inter) 4.001, Copyright 2016 The Inter Project Authors | SIL Open Font License 1.1, `Inter-OFL.txt` |
| `JetBrainsMonoNerdFontMono-Regular.woff2` | [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) 2.304, Copyright 2020 The JetBrains Mono Project Authors, patched by [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts) 3.4.0 | SIL Open Font License 1.1, `JetBrainsMono-OFL.txt`. See the Nerd Fonts note below. |

The copyright and licence lines above are the ones in each font's own `name`
table.

Nerd Fonts note: the Nerd Fonts licence (`NerdFonts-LICENSE.txt`) says that
patched fonts are licensed under the SIL Open Font License 1.1, and that the
patcher scripts are under the MIT licence. The patch adds icon glyphs from other
icon sets, each with its own licence; the Nerd Fonts
[license audit](https://github.com/ryanoasis/nerd-fonts/blob/master/license-audit.md)
lists them.

## Icons

| Location | Source | Licence |
|---|---|---|
| `packages/ui/src/assets/icons/file-types/` and the file-icon sprite made from it | [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme), Copyright (c) 2025 Material Extensions | MIT |
| `packages/ui/src/assets/icons/provider/` and the provider-icon sprite | Provider logos as published by [models.dev](https://github.com/anomalyco/models.dev) (repository: MIT, Copyright (c) 2025 models.dev) | Licence of the logo images not recorded. Each logo is a trademark of its owner. |
| `packages/ui/src/assets/icons/app/` and the app-icon sprite | Logos of third-party applications (for example VS Code, Cursor, Zed, Xcode, iTerm2, Warp), imported with OpenCode | Licence not recorded. Each logo is a trademark of its owner. |

## Audio

| Location | Source | Licence |
|---|---|---|
| `packages/ui/src/assets/audio/` (alert, bip-bop, nope, staplebops and yup sounds) | Imported with OpenCode | Licence not recorded beyond the OpenCode MIT licence in `LICENSE-UPSTREAM`. |

## How these were identified

- Font copyright and licence: read from the `name` table of each font file.
- Material Icon Theme: sample icons compared byte for byte with the files in
  the Material Icon Theme repository.
- Provider logos: sample logos compared byte for byte with `https://models.dev/logos/`.
- App icons and audio: added in OpenCode commits before the fork. No separate
  licence file came with them.
