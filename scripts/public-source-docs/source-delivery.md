# Reviewed corresponding-source export

The exporter takes committed Git blobs, not the platform's checkout line-ending
conversions. `--working-tree --review-only` instead inspects current files locally.
Neither mode copies Git history, account data, private release settings, generated
binaries, caches or validation screenshots. No private signing material is read.

The output directory must be new. On rights, secret or completeness failure,
normal mode produces no output. Local review mode returns `releaseReady: false`
and lists unresolved issues; it is not a bypass for publishing.

## Privacy and portable-path gates

Sensitive filename families are excluded before reading source contents: `.env*`,
registry/network credential configurations and their backups, account/credential
JSON/YAML/configuration backups, and credential directories. A name containing
`example` is not a bypass. The existing public release example is permitted only
while its reviewed, placeholder-only content fingerprint remains unchanged;
changing it requires a new content review. Legitimate authentication source
modules, such as `auth.py` and `secrets.py`, remain build inputs.

A second content-set check rejects sensitive paths before any output is created,
including local review mode. The same pre-write gate rejects unsafe portable
paths, reserved Windows device names, trailing dots/spaces, and case-insensitive
or Unicode-normalized collisions across both file and directory names. These
checks prevent filesystem alias overwrites before archive verification.

## Stable metadata

`SOURCE_MANIFEST.json` has `schemaVersion: 1`, `publicationKind`, `version`, `sourceCommit`,
`sourceTree`, and `files: [{path, sha256, size}]`. Paths use `/`, relative to the
snapshot root, and are sorted. File hashes cover exact bytes. The manifest and
`SOURCE_EXPORT_REPORT.json` are excluded from the file list to avoid recursion;
both must additionally match byte-for-byte between the reviewed local snapshot,
public source and actual private build input. The report carries the same source
identity, `publicationKind`, `sourceStatus`, `sourceMode`, `releaseReady`, `checks`, blocking `rightsFindings`,
visible unresolved `rightsDisclosures`, `exclusions`, `replacements` and `filesDigest`.

`filesDigest` is SHA-256 of UTF-8 text formed by concatenating, in manifest order,
`sha256 + "  " + decimal(size) + "  " + path + "\n"` for every file. No wall-clock
timestamp or absolute local path is placed in either JSON document. An optional
ZIP uses fixed entry timestamps and deterministic path ordering. A release-ready
report requires `sourceMode: "git-ref"`, every check `ok: true`, and no rights
findings. `releaseReady` is a technical release-policy result, not a legal-clearance
statement. It may coexist with explicit owner-directed unresolved disclosures
under the narrowly bound 1.7.1 decision described below. The exporter does not
claim that scanning proves legal clearance or exhaustive secret absence.

## Non-release snapshot modes

`releaseReady: false` has three distinct meanings; read `publicationKind`:

| Kind | Purpose and limits |
| --- | --- |
| `review-only` | Local inspection only, possibly with content findings; not publishable. |
| `development-snapshot` | An immutable, unreleased development snapshot. All content/privacy/completeness checks must pass, and unresolved items cannot borrow the historical 1.7.1 release direction. Not corresponding source for an existing binary. |
| `privacy-maintenance` | A narrow privacy cleanup against the independently pinned already-public 1.7.1 snapshot. It preserves historical rights/attribution bytes and disclosures, not a new release or rights authorization. |

Normal release exports use `publicationKind: "release-source"`. Older existing
release metadata may omit that field. Development and maintenance deliberately
record a failed `publication_mode` check and `releaseReady: false`, even when their
content checks succeed. Do not change the flag, drop a check, reuse old metadata,
or pass these artifacts to release verification to approve installer publication.
A retained `version: "1.7.1"` is not evidence that a changed tree corresponds to
an existing 1.7.1 installer.

Both non-review modes require a full immutable `--ref` commit and reject
`--working-tree` / `--review-only`. They cannot be combined with each other.
Examples, with a new output directory and placeholder paths:

```powershell
$commit = (git rev-parse HEAD).Trim()
python scripts/export_public_source.py --ref $commit --development-snapshot --output-directory release/development-source
# Alternative maintenance flow, not a second step:
python scripts/export_public_source.py --ref $commit --privacy-maintenance-baseline release/verified-public-1.7.1-baseline --output-directory release/privacy-maintenance-source
```

The maintenance baseline argument is a **local complete snapshot directory**,
not a Git checkout or just a manifest. The exporter does no network fetching. It
requires the exact independently pinned public commit/tree represented by the
existing 1.7.1 build.2 source; recomputes the Git tree; validates all file hashes,
metadata and disclosures; and requires the 50 scoped historical files, audit,
original decision, licenses, third-party notices and provenance to remain byte
identical. An arbitrary self-authored baseline cannot grant an exception.

Maintenance adds `PRIVACY_MAINTENANCE.md` and a `maintenanceBaseline` record to
both JSON metadata files. Development adds `DEVELOPMENT_SNAPSHOT.md`. The privacy
maintenance direction does **not** amend the historical owner decision, clear
unverified rights, or authorize a later version. Future releases must satisfy
fresh release rights/completeness gates and publish their own exact corresponding
source. No existing tag, source ZIP, binary or checksum is replaced by either mode.

## Publication without changing the build source

For a formal binary release, create the public snapshot repository and the private build snapshot from this
**same directory**, not from a fresh full archive of the private development repo.
Before adding files, run `git init` followed immediately by
`git config core.autocrlf false` (or configure it globally before `git init`).
Do not edit line endings, generate new files, or add files absent from the manifest.
Commit all snapshot source and both metadata JSONs, then use the matching release
tag. This preserves the same Git tree in the public and private build snapshots.
The public tag must resolve and its anonymous archive must match every manifest
entry before signing or update promotion. Never make the original development
repository public as a shortcut. The public repository is now named
`desktop-source-archive`; use its current direct URL for strict verification.
Updating its branch with a non-release maintenance snapshot never changes the
meaning or contents of the existing `v1.7.1-build.2` release tag.

## Rights audit and explicit publication direction

`scripts/public-source-audit.json` records exact paths, SHA-256 values, original
review statuses, reasons and evidence. True clearance still uses only `cleared`
or `replaced-original`, with reviewer, date, license, rationale and retained
evidence. Merely writing “verified” or adding a disclaimer does not confer rights.

For version **1.7.1 only**, the owner explicitly directed a complete open-source
release with the tested functionality and assets retained. The pinned record
`scripts/public-source-docs/owner-release-decision-1.7.1.md` preserves the original
50 unresolved audit entries and accurately records the owner's theme statement
and subsequent clarification that assets may be internet-sourced. It is not a
third-party license, proof of ownership, or legal clearance.

Each scoped audit item adds `releaseDecision` without changing its original
status/reason/hash/evidence. Its exact shape is:

```json
{
  "type": "owner-directed-publication",
  "decisionId": "gaoge-1.7.1-2026-11-12",
  "version": "1.7.1",
  "sha256": "<exact scoped asset SHA-256>",
  "evidence": [{
    "path": "scripts/public-source-docs/owner-release-decision-1.7.1.md",
    "sha256": "<exact pinned evidence SHA-256>"
  }],
  "acknowledgesUnverifiedRights": true
}
```

A valid decision moves that original unresolved finding into the report's
`rightsDisclosures`, with `path`, original `status`, original `reason`, actual
`sha256`, and `releaseDecision`. These are **unverified disclosures**, not cleared
findings. All 50 original scoped files, audit entries, provenance evidence, and
disclosures must remain present. Removing a disclosure, changing status to
“verified”, adding an unknown decision field, changing file/evidence bytes,
applying the decision to a new file, or reusing it for another version blocks
publication. Other unresolved items remain blocking `rightsFindings`.

No product functionality or material is silently removed or relicensed by this
mechanism. Upstream licenses, attribution and rights warnings remain in force;
owner direction does not override any applicable third-party restriction. Secret,
privacy, portable-path, source-completeness and exact-public-build-source checks
remain mandatory. Public documentation replacements continue to be reported by
source path and hash, and retain the instructions required to build and test.

## Operator-only deployment exclusions

The original `scripts/deploy-mobile-relay.py` and
`scripts/deploy-mobile-components.py` are private operator entry points and are
not desktop build inputs or mobile runtime dependencies. They are omitted, not
replaced with scripts that silently target different infrastructure. The full
mobile client/relay source, requirements, deployment templates, packaging tools
and signature validation remain available. Exporter tests check that retained
executable/configuration source does not refer to the excluded entry points.

`docs/release-1.7.1.md` is replaced by its public counterpart in
`scripts/public-source-docs/`; internal acceptance logs and operator release
procedures are not published. Replacement bytes and their hashes are recorded
in `SOURCE_EXPORT_REPORT.json` just like the public build and update guides.
