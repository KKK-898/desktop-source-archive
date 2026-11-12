# Update artifacts and operator configuration

This public guide deliberately contains no private hosting address, key path or
operator account. Read the root README for a local build without update publishing.

Each native platform writes `release/<platform>/latest.json`, its installer and the
updater signature required by its configured Tauri updater. Publisher aliases are:

- `Gaoge-Free-latest-windows-x64-setup.exe`
- `Gaoge-Free-latest-macos-universal.dmg`
- `Gaoge-Free-latest-linux-x86_64.AppImage`
- `Gaoge-Free-latest-linux-x86_64.deb`

For your own fork, provide your own HTTPS update endpoint, signing key and runtime
server directory. `.release.local.example.json` documents the operator settings;
copy it to the ignored `.release.local.json` only in your private environment.
Do not publish signing keys, SSH credentials, provider tokens or real user data.

The release tooling validates version, artifact existence, updater signatures,
platform aliases and public corresponding-source availability before promotion.
The public source tag and private build tree must contain the same reviewed source
snapshot. No deployment credentials or paid service are needed to reproduce the
source manifest, frontend build or unsigned desktop build.
