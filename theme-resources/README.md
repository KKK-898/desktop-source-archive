# Codex theme resources

This directory contains source assets and metadata used to generate the remote
Codex theme catalog. Source images are not imported by the Vue application.
The licensed structural CSS under `vendor/` may be embedded in the desktop
runtime when a theme needs a dedicated DOM compatibility layer.

Run:

```powershell
npm run themes:build
npm run themes:verify
```

Generated files are written to `release/themes/`:

- `catalog.json`
- `packages/*.zip`
- `previews/*.webp`

The client resolves these files relative to the active runtime server's
`downloadBaseUrl`. A typical published path is:

```text
/gaogeaii/updates/themes/catalog.json
```

Publish to each configured server explicitly:

```powershell
.\scripts\publish-codex-themes.ps1 -Server user@example-host
```

Community source images are pinned in `themes.json` by repository, commit and
original path. Keep the matching license, notice and provenance files when
updating an asset.

The `qq-retro` runtime uses the MIT-licensed structural layout adapted from
`zhangjanice66/Codex-QQ-2007`; its pinned source commit and redistribution
notices live in `licenses/`.
