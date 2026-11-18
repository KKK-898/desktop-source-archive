# CodexPlusPlus integrations

Source: https://github.com/BigPizzaV3/CodexPlusPlus

Pinned revision: ce1767a1a24ac9dc6b9c0f95bed1648d944c89e1

Vendored files: assets/inject/native-fast-unlock.js and assets/inject/native-fast-rspack.js. These files are retained from that base revision, with the following narrowly backported upstream fix.

Native Fast compatibility fix: `e5567301196fbfadd9184d77aea4b4980c5f1f77` (2026-11-13), https://github.com/BigPizzaV3/CodexPlusPlus/commit/e5567301196fbfadd9184d77aea4b4980c5f1f77. `native-fast-unlock.js` now inspects up to 12 entry scripts instead of 4 so Codex 26.1111's fifth-entry Rspack runtime is not missed (issue #3103). The matching regression is adapted in `scripts/codex-native-fast-rspack.test.cjs`; `native-fast-rspack.js` and the other integrations below remain at their independently stated revisions.

The upstream project declares GNU Affero General Public License version 3; its complete license is retained in LICENSE alongside these files. The Gaoge integration wrapper and native startup lifecycle are separate local files.

## Plugin marketplace

`plugin_market.rs` is retained verbatim from `crates/codex-plus-core/src/plugin_market.rs` at the same pinned revision. `../../codex_plugin_market.rs` derives its catalog, Git sparse download, validation, receipt, locking, install and uninstall implementation from this file under the same upstream AGPL-3.0 terms.

Local adaptations use Gaoge's atomic configuration writer and current Codex home, omit the injected native UI adapter, add per-plugin enabled/managed state and toggling, retain missing catalog entries for removal, reject foreign marketplace source paths on uninstall, clean temporary Git download workspaces, and conditionally restore marketplace metadata on configuration publication failure. No plugin is executed or service authorization initiated during installation. Network clients use the platform proxy environment and Git's configured proxy.

## Native Chinese UI

`locale-prelude.upstream.js` and `locale-settings.upstream.js` retain `assets/inject/renderer-inject/00-prelude.js` and `20-menu.js` at the pinned revision. The local `../../codex_locale_runtime.js` adapts its force-Chinese locale setting and Statsig i18n layer/config behavior under the same AGPL-3.0 terms. Local changes add shared runtime lifecycle, verified native settings bindings, preference restoration, bounded retries, and status reporting; no forced page reload is performed.

## Aggregate model metadata and provider presets

The 19 model metadata JSON files (69 exact identifiers) and 29 provider presets
under `model-metadata/` are retained or derived from CodexPlusPlus revision
`38033bf98325a32bbb80842441e2e0e2b3c9d7bd` under the same AGPL-3.0 terms.
`model-metadata/NOTICE.md`, `source-manifest.json`, and
`provider-presets-source.json` record the original paths, transformations, and
SHA-256 hashes. The local adapter projects capability fields only and keeps user
settings and native model declarations ahead of these static declarations.

The local `../../aggregate_protocol.rs` bridge references that revision's
`protocol_proxy.rs` and `anthropic_bridge.rs`, including its signed-thinking and
extra-content envelope strategy, under the same terms. Local differences and
protocol boundaries are documented in `../../aggregate_protocol.NOTICE.md`.
