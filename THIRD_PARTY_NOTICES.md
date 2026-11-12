# Third-party notices

This file supplements, and does not replace, the original license and notice files
retained beside third-party components. Licenses apply to their actual scope;
software licensing does not automatically cover artwork or trademarks.

## CodexPlusPlus — AGPL-3.0-only

Project: https://github.com/BigPizzaV3/CodexPlusPlus

The upstream workspace `Cargo.toml` at both revisions below expressly declares
`AGPL-3.0-only`. The complete license is retained at
`src-tauri/src/third_party/codex-plus-plus/LICENSE`, and the unchanged upstream and
local attribution details are in that directory's `NOTICE.md`.

- `ce1767a1a24ac9dc6b9c0f95bed1648d944c89e1`: retained native Fast injection files,
  `plugin_market.rs`, locale prelude and locale settings source. The local plugin
  marketplace and locale adapters derive from this revision. Local wrappers add
  lifecycle management, validation, recovery and bounded retries.
- `38033bf98325a32bbb80842441e2e0e2b3c9d7bd`: 19 model metadata JSONs and transformed
  provider presets. The original paths, hashes and transformations are retained in
  `src-tauri/src/third_party/codex-plus-plus/model-metadata/NOTICE.md`,
  `source-manifest.json` and `provider-presets-source.json`.
- The local multi-protocol implementation and referenced upstream strategy are
  described in `src-tauri/src/aggregate_protocol.NOTICE.md`. Its existing terms
  remain intact. This notice does not claim every compatibility feature was copied.

## Mobile bridge — MIT and retained component notices

`mobile-bridge/` vendors try2love/codex-mobile-bridge at
`929516c85401819d560065a006467669f4748f93` (v2.1.1). Preserve
`mobile-bridge/LICENSE`, `mobile-bridge/UPSTREAM.md`, and the individual web/client
license notices. The optional runtime is built separately; its source and build
instructions remain included. Gaoge modifications are described by `UPSTREAM.md`.

## Theme software and visual assets

Preserve all files under `theme-resources/licenses/`. In particular:

- `codex-qq-2007-LICENSE.txt`, `codex-qq-2007-NOTICE.md`, and
  `codex-qq-2007-ASSET-PROVENANCE.md` cover the pinned QQ structural adapter and
  distinguish MIT software from independently reviewed artwork.
- `heige-LICENSE.txt`, `heige-NOTICE.md`, `heige-ASSET_PROVENANCE.md`,
  `qq-LICENSE.txt`, and `qq-NOTICE.md` preserve other theme attribution and the
  upstream limits on image and character rights.

These notices are not proof that every picture is cleared for distribution.
Unverified pictures, customer logos, locale payloads and proprietary native-code
fixtures are tracked in `scripts/public-source-audit.json`; they cannot be silently
relicensed as AGPL by adding this file.

## Version 1.7.1 owner-directed release disclosure

The project owner requested that the complete tested version, including current
themes and other resources, be retained for the 1.7.1 open-source release. The
record at `scripts/public-source-docs/owner-release-decision-1.7.1.md` includes the
owner's theme-design statement and the subsequent clarification that theme assets
may be internet-sourced. It preserves the exact 50 original unresolved audit
entries; neither this instruction nor an internet-source disclaimer establishes
third-party permission or legal clearance.

The export report records those version/hash-bound decisions in
`rightsDisclosures`, retaining each original unverified status and reason.
`releaseReady` is not a claim that these rights were verified. Existing licenses,
provenance notices, warnings, trademark ownership and non-endorsement statements
remain unchanged. No additional rights are granted or implied by this release
record, and no known third-party restriction is waived by owner direction.

## Dependency packages

`package-lock.json` and `src-tauri/Cargo.lock` record the dependency resolutions
used to build the desktop application. Dependencies retain their own licenses and
copyright notices. Install dependencies from those lockfiles and retain their
licenses in any redistributed package containing them. The release-source export
does not redistribute `node_modules/`, Cargo build caches, private signing keys,
provider credentials, or Git history. Platform SDKs, Rust, Node.js and other system
tools are obtained separately; this project does not claim ownership of them.
