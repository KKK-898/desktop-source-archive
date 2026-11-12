"""Aggregate native component artifacts and sign stable.json locally; never uploads."""
import argparse
import base64
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from mobile_component_release import PLATFORMS, ROOT, platform_metadata, release_config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir', required=True, type=Path, help='Recursively searches downloaded CI artifacts')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'release/mobile-components')
    parser.add_argument('--key-path', type=Path, default=os.environ.get('GAOGE_MOBILE_SIGNING_KEY_PATH'))
    args = parser.parse_args()
    key = args.key_path or Path.home() / '.codex/secrets/gaoge-mobile-component.key'
    if not key.is_file():
        parser.error('Signing key is unavailable; use --key-path or GAOGE_MOBILE_SIGNING_KEY_PATH')
    if args.output_dir.exists():
        parser.error('Output directory must not already exist; immutable release versions cannot be overwritten')
    config = release_config()
    artifacts = {}
    platforms = {}
    for platform in PLATFORMS:
        candidates = list(args.input_dir.rglob(platform + '.tar.gz'))
        if len(candidates) != 1:
            raise ValueError('Expected exactly one archive for ' + platform)
        filename = candidates[0]
        platforms[platform] = platform_metadata(filename, platform, config)
        metadata_file = filename.with_name(platform + '.json')
        metadata = json.loads(metadata_file.read_text(encoding='utf-8-sig'))
        if metadata != {**config, 'platform': platform, **platforms[platform]}:
            raise ValueError('Component metadata, version or archive integrity mismatch: ' + platform)
        artifacts[platform] = filename
    payload = json.dumps({**config, 'platforms': platforms}, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    with tempfile.TemporaryDirectory(prefix='gaoge-component-sign-') as temporary:
        signing_file = Path(temporary) / 'manifest.json'
        signing_file.write_bytes(payload)
        # Capture both streams: Tauri prints signing information that must not reach logs.
        env = dict(os.environ, TAURI_SIGNING_PRIVATE_KEY_PASSWORD='')
        env.pop('TAURI_SIGNING_PRIVATE_KEY', None)
        env.pop('TAURI_SIGNING_PRIVATE_KEY_PATH', None)
        result = subprocess.run(['node', str(ROOT / 'node_modules/@tauri-apps/cli/tauri.js'), 'signer', 'sign',
                                 '--private-key-path', str(key.resolve()), str(signing_file)], cwd=ROOT,
                                env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
        if result.returncode:
            raise RuntimeError('Component manifest signing failed; signer output withheld')
        signature = signing_file.with_suffix('.json.sig').read_text(encoding='utf-8').strip()
        decoded = base64.b64decode(signature, validate=True).decode('utf-8')
        if not decoded.startswith('untrusted comment:'):
            raise ValueError('Signer returned an unsupported signature format')
    # Tauri's .sig text is already base64; preserve it exactly, do not encode it twice.
    envelope = {'payload': base64.b64encode(payload).decode('ascii'), 'signature': signature}
    catalog = (json.dumps(envelope, indent=2) + '\n').encode('utf-8')
    checked = subprocess.run(['node', str(ROOT / 'scripts/verify-mobile-component-signature.mjs')],
                             input=catalog, capture_output=True, timeout=30)
    if checked.returncode:
        raise RuntimeError('Component catalog does not verify against the application public key; nothing was published')
    args.output_dir.mkdir(parents=True)
    version_dir = args.output_dir / config['version']
    version_dir.mkdir()
    for platform, source in artifacts.items():
        shutil.copy2(source, version_dir / (platform + '.tar.gz'))
    (args.output_dir / 'stable.json').write_bytes(catalog)
    print(json.dumps({'version': config['version'], 'outputDirectory': str(args.output_dir), 'platforms': list(platforms)}, indent=2))


if __name__ == '__main__':
    main()
