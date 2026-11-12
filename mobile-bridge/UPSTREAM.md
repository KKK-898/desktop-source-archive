# Codex Mobile Bridge integration

This directory vendors the gateway, shared web client, and relay from
[try2love/codex-mobile-bridge](https://github.com/try2love/codex-mobile-bridge),
v2.1.1 / commit `929516c85401819d560065a006467669f4748f93`, under the MIT license
in `LICENSE`. Third-party web notices remain alongside their corresponding assets.

Gaoge changes include the current Codex project / pinned / recent sidebar,
the private parent-owned `gaoge_mobile.py` controller, relay password login,
single-use direct QR pairing, path-prefix hosting, and memory-only connector
credentials supplied by the desktop OS-protected store. No model credentials
are copied into the relay. The desktop client continues to own Codex execution.

The relay terminates TLS and can read forwarded content. This is not an
end-to-end encrypted protocol. Deploy it only on an operator-controlled host.

Build the runtime using `scripts/build-mobile-bridge.py` from the parent repo
with `requirements-desktop.txt` installed. Build each OS/architecture separately.
The Windows test machine does not validate macOS native operation.
