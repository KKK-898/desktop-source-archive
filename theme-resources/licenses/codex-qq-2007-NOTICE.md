# Codex QQ 2007 notice

The QQ 2007 structural theme adapter in Gaoge Free is derived from
[zhangjanice66/Codex-QQ-2007](https://github.com/zhangjanice66/Codex-QQ-2007)
at commit `ef88c712c5e919e12bff5c714fe1517e9d3a03a4`.

The upstream software source, CSS, injector and documentation are distributed
under the MIT License. The matching license text is included in
`codex-qq-2007-LICENSE.txt`.

Gaoge Free keeps its existing CDP launcher, opt-in preference, plugin runtime,
session deletion runtime and theme activation flow. The adapter reuses and
modifies the upstream `ds2007-*` structural layout so it can operate against
the Windows and macOS Codex Desktop DOM used by this project. The upstream
skin-switch controls are intentionally omitted.

This integration redistributes three exact PNG files from the pinned upstream
commit. They are embedded in the desktop runtime and are loaded only when the
user enables the `qq-retro` theme:

- `macos/assets/qq2007-icons.png`
- `macos/presets/preset-codex-1907-deep/assistant.png`
- `macos/presets/preset-codex-1907-deep/qq-show.png`

Their local paths, SHA-256 checksums and usage are recorded in
`codex-qq-2007-ASSET-PROVENANCE.md`. The upstream repository describes its
visuals as original or generated fictional assets, but also warns that the MIT
software license does not automatically settle image, character, trademark or
commercial redistribution rights. Public and commercial distributors must
perform their own rights review.

The upstream documentation screenshot is not redistributed.

This is an unofficial customization. It is not affiliated with, endorsed by,
or sponsored by OpenAI, Tencent or QQ. Product names and trademarks belong to
their respective owners.
