"""Reject optional phone runtimes accidentally included in completed app installers."""
import argparse
import os
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN = {'mobile-bridge', 'gaoge-mobile-gateway', 'gaoge-mobile-gateway.exe', 'runtime-manifest.json'}


def check_paths(paths, label):
    for name in paths:
        if set(PurePosixPath(str(name).replace('\\', '/').lower()).parts) & FORBIDDEN:
            raise ValueError('Optional mobile runtime leaked into ' + label)


def verify_bundle(platform, bundle):
    verified = []
    if platform == 'win':
        installers = list((bundle / 'nsis').glob('*.exe'))
        seven_zip = shutil.which('7z') or str(Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / '7-Zip/7z.exe')
        if not installers or not Path(seven_zip).is_file():
            raise ValueError('Windows installer or 7-Zip inspection tool is unavailable')
        for installer in installers:
            result = subprocess.run([seven_zip, 'l', '-slt', '-sccUTF-8', str(installer)], check=True,
                                    capture_output=True, text=True, encoding='utf-8', timeout=90)
            entries = [line[7:] for line in result.stdout.splitlines() if line.startswith('Path = ')]
            if len(entries) < 3:
                raise ValueError('NSIS archive listing did not expose installer resources')
            check_paths(entries, installer.name)
            verified.append(installer.name)
    elif platform == 'mac':
        apps = list((bundle / 'macos').glob('*.app'))
        if not apps:
            raise ValueError('Completed Mac app bundle is missing')
        for app in apps:
            check_paths((path.relative_to(app) for path in app.rglob('*')), app.name)
            verified.append(app.name)
        for archive_path in (bundle / 'macos').glob('*.tar.gz'):
            with tarfile.open(archive_path, 'r:gz') as archive:
                check_paths((member.name for member in archive), archive_path.name)
            verified.append(archive_path.name)
    else:
        debs = list((bundle / 'deb').glob('*.deb'))
        images = list((bundle / 'appimage').glob('*.AppImage'))
        if not debs or not images:
            raise ValueError('Completed Linux package or AppImage is missing')
        for deb in debs:
            result = subprocess.run(['dpkg-deb', '--fsys-tarfile', str(deb)], check=True, capture_output=True, timeout=90)
            import io
            with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
                check_paths((member.name for member in archive), deb.name)
            verified.append(deb.name)
        for image in images:
            with tempfile.TemporaryDirectory(prefix='gaoge-appimage-check-') as temporary:
                subprocess.run([str(image.resolve()), '--appimage-extract'], cwd=temporary, check=True, capture_output=True, timeout=90)
                check_paths((path.relative_to(temporary) for path in Path(temporary).rglob('*')), image.name)
            verified.append(image.name)
    return verified


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', required=True, choices=('win', 'mac', 'linux'))
    parser.add_argument('--bundle-dir', type=Path)
    args = parser.parse_args()
    base = ROOT / 'src-tauri/target'
    bundle = args.bundle_dir or (base / 'universal-apple-darwin/release/bundle' if args.platform == 'mac' else base / 'release/bundle')
    verified = verify_bundle(args.platform, bundle)
    print('Lightweight application verified without optional runtime: ' + ', '.join(verified))


if __name__ == '__main__':
    main()
