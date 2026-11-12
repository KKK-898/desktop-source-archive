# Aggregate protocol bridge reference

`aggregate_protocol.rs` is a local implementation of Responses / Chat Completions /
Anthropic Messages request, response, and SSE adaptation. Its architecture and
signed-thinking/extra-content envelope strategy reference CodexPlusPlus at the
fixed revision `38033bf98325a32bbb80842441e2e0e2b3c9d7bd`:

- `crates/codex-plus-core/src/protocol_proxy.rs`
- `crates/codex-plus-core/src/anthropic_bridge.rs`

Upstream: https://github.com/BigPizzaV3/CodexPlusPlus
License: GNU Affero General Public License v3.0 (AGPL-3.0), retained at
`third_party/codex-plus-plus/LICENSE`. This integration is distributed under the
same terms. Upstream copyright notices remain in that license/notice tree.

Local differences include explicit route protocol selection, strict unsupported
semantic-field errors, request-scoped tool namespaces/custom-tool wrappers,
provider-tagged round-trip envelopes, byte-fragment-safe bounded SSE parsing,
Responses interruption/error events, and no automatic retry, account mutation,
credential logging, or live provider tests.

Opaque encrypted reasoning owned by another provider is intentionally ignored;
user messages and tool calls/results must be translatable or conversion fails.
A custom tool grammar is included verbatim in its function description, but the
Chat/Messages endpoint cannot enforce Responses grammar-constrained decoding.
Non-Responses `/responses/compact` is explicitly unsupported.
