Gaoge Free mobile connection runtime payloads

The desktop application selects the directory matching its OS and CPU:
  windows-x86_64/gaoge-mobile-gateway.exe
  macos-aarch64/gaoge-mobile-gateway
  macos-x86_64/gaoge-mobile-gateway

Include the complete runtime directory, including _internal when built with
PyInstaller onedir. Release builds never fall back to a developer's Python.
Development builds prefer mobile-bridge/gaoge_mobile.py with explicitly set
GAOGE_MOBILE_PYTHON or the local .venv. Otherwise they prefer the bundled
runtime and only fall back to source with Python on PATH if no bundle exists.
A missing payload produces a visible
component-unavailable state rather than claiming that the phone is connected.
