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
