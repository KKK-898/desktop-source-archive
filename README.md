# Gaoge Free Desktop

Gaoge Free is an independent Vue 3 / TypeScript / Rust / Tauri 2 desktop client.
The covered project software is licensed **AGPL-3.0-only**. Read `LICENSE`,
`NOTICE.md` and `THIRD_PARTY_NOTICES.md`; separately identified dependencies and
third-party material retain their original terms. No provider keys or accounts
are included, and this project is not endorsed by the products it interoperates with.

## Release source

Public source: https://github.com/KKK-898/Gaoge-Free-Desktop

Use the `v<version>` tag matching the installed application, not an unrelated
branch tip. Exported releases contain `SOURCE_MANIFEST.json` with source revision,
file sizes and SHA-256 hashes, plus `SOURCE_EXPORT_REPORT.json`. A report with
`releaseReady: false` is a **local review snapshot, not an approved release**.
The original development repository remains private; the public repository
contains reviewed release snapshots without its private history.

## Requirements

- Node.js 22 (22.18 or newer for tests using built-in type stripping) and npm.
- Rust stable and Cargo; use `src-tauri/Cargo.lock` (`--locked`).
- Python 3.11+ for release-source and packaging tools. Some optional mobile tests
  use the Python version configured in `.github/workflows/`.
- Git. PowerShell is needed only for the `.ps1` convenience wrappers.
- Native Tauri prerequisites: Windows MSVC build tools/WebView2; macOS Xcode
  command-line tools; Linux WebKitGTK 4.1, AppIndicator, SVG and packaging tools.
  The Linux CI package list is recorded in `.github/workflows/platform-check.yml`.

## Develop and test

```sh
npm ci
npm run build
cargo check --locked --manifest-path src-tauri/Cargo.toml
npm run desktop
```

For isolated unit/regression tests, choose the `test:*` commands in `package.json`.
Browser tests require `npx playwright install chromium`. Tests whose names include
`installed`, `native-fixture` or explicit installed-ASAR checks may need a compatible
locally installed Codex application; they are not a claim of portable smoke-test
coverage. Do not supply real credentials or call paid providers to run unit tests.

## Local unsigned build

```sh
npx tauri build --debug --no-bundle --ci
```

This builds the desktop executable using local dependencies without an updater
signing key, production API access, or private release infrastructure. `dist/` is
created by `npm run build`; Cargo outputs go to `src-tauri/target/` by default.
Installers must be built on the matching operating system. The `dist:win`,
`dist:mac` and `dist:linux` scripts additionally produce release artifacts and
updater manifests; those publisher workflows require an operator's own signing
and hosting configuration. The official private signing key is never included.
For a fork, use a distinct application identifier, update endpoint and signing key.

## Optional components and assets

- `theme-resources/` plus `scripts/build-codex-themes.mjs` are the source inputs for
  the optional theme catalog; `npm run themes:build` writes `release/themes/`.
- `mobile-bridge/` contains the optional mobile runtime source, licenses and Python
  requirements. The lightweight desktop installer does not bundle that runtime.
- `resources/skills/` contains the bundled skill text; `src-tauri/icons/` contains
  the application icons. Other required resources are declared in Tauri configs
  and Rust `include_*` directives and are checked by the source exporter.

## Reproduce a source export

```sh
python scripts/export_public_source.py --ref HEAD --output-directory release/public-source
```

Equivalent Windows wrapper:

```powershell
.\scripts\export-public-source.ps1 -Ref HEAD -OutputDirectory release/public-source
```

The default export refuses blocking rights findings, secret patterns, missing
build inputs, submodules and symlinks. `--working-tree --review-only` is for local
inspection only and cannot produce `releaseReady: true`. The separate 1.7.1
owner-directed decision retains 50 unresolved items as visible `rightsDisclosures`,
not legal clearance; see `scripts/public-source-docs/owner-release-decision-1.7.1.md`.
The output directory
must not exist. See `scripts/public-source-docs/source-delivery.md` for the
manifest format and publisher verification. Before staging a snapshot, set
`git config core.autocrlf false` immediately after `git init`; public and private
build repositories must commit the same snapshot bytes, including both metadata
files, without adding files outside the manifest. Do not upload local review snapshots.
