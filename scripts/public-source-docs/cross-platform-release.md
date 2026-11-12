# Cross-platform build and release

Build from one reviewed source snapshot on each matching native operating system.
Install the requirements in the root README, run `npm ci`, then `npm run build`
and `cargo check --locked --manifest-path src-tauri/Cargo.toml`.

- Windows: `npm run dist:win` creates the NSIS installer.
- macOS: `npm run dist:mac` creates the universal app and DMG. Install both Rust
  targets `aarch64-apple-darwin` and `x86_64-apple-darwin`.
- Linux: `npm run dist:linux` creates DEB and AppImage. Install WebKitGTK 4.1,
  AppIndicator and SVG prerequisites. A build does not prove every Linux desktop
  distribution is supported; test the resulting package on the intended systems.

Stable publisher aliases are `Gaoge-Free-latest-windows-x64-setup.exe`,
`Gaoge-Free-latest-macos-universal.dmg`, `Gaoge-Free-latest-linux-x86_64.deb`, and
`Gaoge-Free-latest-linux-x86_64.AppImage`. Generated artifacts live in
`release/<platform>/`; generated files are not source inputs.

The release workflows in `.github/workflows/` record native toolchain setup.
Publisher signing keys, credentials, hosting accounts and `.release.local.json`
are not part of the source and are not needed for a local unsigned debug build.
Use the example configuration with your own infrastructure; never reuse another
publisher's identity or claim their updater signature.

## Deployment configuration and release eligibility

Public source preserves the complete feature implementations and defaults to no
operator deployment. Local unsigned builds do not need production endpoints or
private credentials; remotely backed features require the builder's own service
configuration. Follow `docs/public-release-workflow.md` for the nine allowlisted
`deployment` fields, optional local `.env.local`, CI variable mapping, and the
real `deployment-config.mjs validate|sync` and `one-click-release.ps1` commands.
Backend CI builds never fall back to a local `.env.local`; the release workflow
must supply the selected variables. Never place secrets in `VITE_*` variables.

For an actual binary release, both public and private build snapshots must use
identical reviewed source and metadata, and pass the exact-tag anonymous source
verifier before signing/update promotion. The public repository name is
`desktop-source-archive`. Private development/build history remains private, but
every future covered release still needs its own complete corresponding source;
a one-time simplified or stale public edition is not a substitute.

Read `publicationKind` in the export metadata. `development-snapshot` and
`privacy-maintenance` deliberately set `releaseReady: false`: they may describe
checked, non-release source, but **are not corresponding source for any existing
installer and must not authorize a binary release**. `review-only` also has that
flag and is local-only. Do not reinterpret `false` as a warning that can be
ignored or edit the report to turn it into a release candidate.

Privacy maintenance accepts only the fixed verified existing 1.7.1 public
baseline and preserves its 50 exact historical rights disclosures, assets,
original audit evidence and notices. It neither modifies those rights findings
nor authorizes future versions. Ordinary development snapshots need independent
rights checks instead of borrowing that old release direction. Keep the existing
`v1.7.1-build.2` tag, source ZIP, binaries and checksums unchanged; a branch-tip
cleanup is not a replacement for their matching source.
