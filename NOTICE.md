# Gaoge Free Desktop — copyright and source notice

Copyright (c) 2026 GaogeAI and contributors, for their original contributions.

Gaoge Free Desktop's covered software is distributed under the GNU Affero
General Public License, version 3 only (`AGPL-3.0-only`). See `LICENSE` for the
complete terms. This is not an “or any later version” grant. Dependency licenses,
upstream copyrights and separately identified third-party materials are retained;
this notice does not relicense them or establish ownership of their content.

## Corresponding source

Public release-source repository:
https://github.com/KKK-898/desktop-source-archive

The source for a released build is identified by the immutable `sourceReleaseTag`
in its package metadata (`v<version>` or `v<version>-build.N`).
`SOURCE_MANIFEST.json` in each exported release identifies the originating source
commit, source tree and the SHA-256 and size of each included source file. The
export includes local modifications, build scripts, package lockfiles, runtime
adapters and required resource declarations. See `README.md` for building and
`scripts/public-source-docs/source-delivery.md` for the export and verification
procedure. Public availability must be verified before a release is published;
a local review snapshot is not a public source offer or a completed release.

## Modifications and provenance

The 1.7.1 integration changes dated 2026-11-10 through 2026-11-12 include local
plugin-market installation and toggling adapters, native locale/Fast integration,
aggregate model capability and multi-protocol handling, model selection/recovery,
and login feedback. These are Gaoge changes, not statements by upstream authors.
Individual upstream components and retained notices are listed in
`THIRD_PARTY_NOTICES.md`. Original notices within copied files take precedence
for attribution; do not remove them when distributing this work.

## Rights boundary

The project software license does not grant rights to product names, logos,
character artwork, screenshots, external proprietary application code, or locale
packs whose permission is not established. `scripts/public-source-audit.json`
records unresolved resource and source-provenance findings for publication review.
Unresolved items block public export. An audit entry is not a new license.

This is an independent project. No affiliation, endorsement or sponsorship by
OpenAI, Anthropic, Tencent, or the other named product and trademark owners is
implied. Third-party products and services require their own accounts, applicable
permissions and terms. No provider access, subscription or service key is included.
