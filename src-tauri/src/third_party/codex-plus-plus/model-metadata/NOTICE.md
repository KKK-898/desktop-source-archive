# CodexPlusPlus model metadata

Source: https://github.com/BigPizzaV3/CodexPlusPlus

Pinned revision: 38033bf98325a32bbb80842441e2e0e2b3c9d7bd

Commit timestamp: 2026-11-10T19:29:03Z. Imported on 2026-11-11.

These 19 JSON files (69 exact model identifiers) are copied without modification from the upstream assets/ directory. Their complete original contents, including fields not consumed by this integration, are retained. source-manifest.json records original paths and SHA-256 checksums.

The upstream project declares GNU Affero General Public License version 3. The complete upstream LICENSE is retained in this directory. This data remains under the upstream license; importing it does not relicense the upstream work.

The local model_metadata.rs adapter parses a restricted set of model capability fields. It does not import upstream system instructions, conversation defaults, authentication, provider endpoints, or routing rules. Explicit user values and matching native cache metadata take precedence over these static declarations. A source declaration is not proof of an account entitlement or a provider's live capabilities. Missing models remain unresolved; no vendor-wide context window or Fast capability is inferred.

Claude is absent from this upstream metadata collection. The separate Anthropic provider preset is not a Claude context/capability table and is not copied here. The existing local verified Claude fallback, if used, is maintained separately from this upstream data.

## Provider presets

provider-presets.json is derived from static literal entries in the same revision's apps/codex-plus-manager/src/presets.ts (PRESETS) and gateway-model.ts (GATEWAY_EXTRA_PRESETS). provider-presets-source.json records original source hashes, array line ranges, the transformation, and the resulting file hash. These are editable connection defaults, not fetched model availability. Empty upstream model lists remain empty; no capability-table entries are silently appended.
