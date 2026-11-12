"""Build a platform-native mobile gateway; shipped customers do not need Python."""
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import sysconfig
from importlib.metadata import distribution
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'mobile-bridge'
PLATFORMS = {'windows-x86_64', 'windows-aarch64', 'macos-x86_64', 'macos-aarch64',
             'linux-x86_64', 'linux-aarch64'}
MACHO_MAGIC = {b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf',
               b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca',
               b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca'}


def version_tuple(version):
    if not re.fullmatch(r'\d+(?:\.\d+){0,2}', version):
        raise ValueError('Invalid macOS version: ' + version)
    values = tuple(map(int, version.split('.')))
    return values + (0,) * (3 - len(values))


def minimum_macos_versions(load_commands):
    """Read OS load commands, excluding SDK and dylib compatibility versions."""
    versions = []
    for block in re.split(r'(?m)^Load command \d+\s*$', load_commands):
        if re.search(r'(?m)^\s*cmd LC_VERSION_MIN_MACOSX\s*$', block):
            match = re.search(r'(?m)^\s*version (\d+(?:\.\d+){0,2})\s*$', block)
        elif re.search(r'(?m)^\s*cmd LC_BUILD_VERSION\s*$', block):
            # otool prints either the numeric platform or its symbolic name.
            if not re.search(r'(?m)^\s*platform (?:1|MACOS)\s*$', block):
                continue
            match = re.search(r'(?m)^\s*minos (\d+(?:\.\d+){0,2})\s*$', block)
        else:
            continue
        if match:
            versions.append(match.group(1))
    return versions


def macos_runtime_metadata(build_dir, architecture, requested_target=None):
    """Check actual Mach-O slices; setting a target cannot lower prebuilt libraries."""
    requirements = []
    checked = 0
    for directory, _, files in os.walk(build_dir, followlinks=False):
        for name in sorted(files):
            binary = Path(directory) / name
            if binary.is_symlink():
                continue
            with binary.open('rb') as stream:
                if stream.read(4) not in MACHO_MAGIC:
                    continue
            result = subprocess.run(['otool', '-arch', architecture, '-l', str(binary)],
                                    check=True, capture_output=True, text=True)
            versions = minimum_macos_versions(result.stdout)
            if not versions:
                raise RuntimeError('Cannot determine macOS minimum for ' + str(binary))
            checked += 1
            requirements.append((max(versions, key=version_tuple), binary.relative_to(build_dir).as_posix()))
    if not requirements:
        raise RuntimeError('No Mach-O binaries found in the macOS gateway')
    minimum = max((version for version, _ in requirements), key=version_tuple)
    if requested_target and version_tuple(minimum) > version_tuple(requested_target):
        incompatible = ', '.join(name + ' (' + version + ')' for version, name in requirements
                                 if version_tuple(version) > version_tuple(requested_target))
        raise RuntimeError('Gateway requires macOS ' + minimum + ', exceeding requested ' +
                           requested_target + ': ' + incompatible)
    print('Verified macOS gateway minimum: ' + minimum + ' (' + str(checked) + ' Mach-O files)')
    return {'minimumSystemVersion': minimum,
            'pythonDeploymentTarget': sysconfig.get_config_var('MACOSX_DEPLOYMENT_TARGET') or None,
            'requestedDeploymentTarget': requested_target,
            'machoFilesChecked': checked}


def publish_runtime(root, platform_id):
    """Replace only the explicit platform output, preserving POSIX framework links."""
    if platform_id not in PLATFORMS:
        raise ValueError('Unsupported runtime output: ' + platform_id)
    root = root.resolve(strict=True)
    build_dir = root / 'mobile-bridge' / '.tmp' / 'dist' / 'gaoge-mobile-gateway'
    parent = root / 'resources' / 'mobile-bridge'
    output = parent / platform_id
    # Resolve before any recursive delete. Reject redirected ancestors, final links,
    # junctions and files, even if they happen to point somewhere inside this repo.
    if build_dir.resolve(strict=True) != build_dir or not build_dir.is_dir():
        raise ValueError('Build product must be the dedicated runtime directory')
    if parent.resolve() != parent or output.resolve() != output:
        raise ValueError('Runtime output must not traverse symlinks or junctions')
    if output.is_symlink() or output.is_junction() or (output.exists() and not output.is_dir()):
        raise ValueError('Runtime output must be a regular directory')
    parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        shutil.rmtree(output)
    shutil.copytree(build_dir, output, symlinks=True)
    return output


def main():
    import certifi

    platform_name = {'win32': 'windows', 'darwin': 'macos', 'linux': 'linux'}[sys.platform]
    arch = {'amd64': 'x86_64', 'x86_64': 'x86_64', 'arm64': 'aarch64',
            'aarch64': 'aarch64'}[platform.machine().lower()]
    helper = None
    if sys.platform == 'win32':
        helper = SOURCE / '.tmp' / 'client-helpers' / 'codex-quit-helper.exe'
        helper.parent.mkdir(parents=True, exist_ok=True)
        framework = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Microsoft.NET/Framework64/v4.0.30319'
        subprocess.run([str(framework / 'csc.exe'), '/nologo', '/target:exe', '/platform:x64', '/out:' + str(helper),
                        *['/reference:' + str(framework / 'WPF' / name) for name in
                          ('UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll')],
                        str(SOURCE / 'bridge/platforms/windows/codex-quit-helper.cs')], check=True)
        subprocess.run([str(helper), '--self-check'], check=True)
    command = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
               '--name', 'gaoge-mobile-gateway', '--distpath', str(SOURCE / '.tmp' / 'dist'),
               '--workpath', str(SOURCE / '.tmp' / 'pyinstaller'), '--specpath', str(SOURCE / '.tmp'),
               '--add-data', str(SOURCE / 'web') + ':web', '--collect-all', 'aiohttp',
               '--collect-all', 'keyring', '--collect-all', 'paramiko',
               '--add-data', certifi.where() + ':bridge/features/auth',
               '--add-data', str(SOURCE / 'LICENSE') + ':licenses/codex-mobile-bridge',
               '--add-data', str(SOURCE / 'UPSTREAM.md') + ':licenses/codex-mobile-bridge']
    for relative in json.loads((SOURCE / 'scripts/gateway-resources.json').read_text(encoding='utf-8')):
        command += ['--add-data', str(SOURCE / relative) + ':' + str(Path(relative).parent)]
    for name in ('certifi', 'aiohttp', 'paramiko', 'keyring', 'cryptography'):
        package = distribution(name)
        for item in package.files or []:
            if item.name.upper().startswith(('LICENSE', 'COPYING', 'NOTICE')):
                command += ['--add-data', str(package.locate_file(item)) + ':licenses/' + name]
    if sys.platform == 'darwin':
        command += ['--target-arch', platform.machine()]
        crypto_record = os.environ.get('GAOGE_MACOS_CRYPTO_RECORD')
        if crypto_record:
            record_path = Path(crypto_record).resolve(strict=True)
            command += ['--add-data', str(record_path) + ':licenses/openssl',
                        '--add-data', str(record_path.with_name('LICENSE.txt')) + ':licenses/openssl']
    if helper:
        command += ['--add-binary', str(helper) + ':client-helpers']
    command.append(str(SOURCE / 'gaoge_mobile.py'))
    # Resource manifests can exceed Windows' command-line length limit in a
    # managed worktree. This script is already an isolated build process; use
    # PyInstaller's CLI entry point directly with the same argument list.
    from PyInstaller.__main__ import run as run_pyinstaller
    previous_directory = Path.cwd()
    try:
        os.chdir(SOURCE)
        run_pyinstaller(command[3:])
    finally:
        os.chdir(previous_directory)
    build_dir = SOURCE / '.tmp' / 'dist' / 'gaoge-mobile-gateway'
    metadata = {'platform': platform_name, 'architecture': arch, 'pythonVersion': platform.python_version()}
    if sys.platform == 'darwin':
        metadata['macos'] = macos_runtime_metadata(build_dir, platform.machine(),
                                                    os.environ.get('MACOSX_DEPLOYMENT_TARGET') or None)
    (build_dir / 'runtime-manifest.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    # Publishing happens only after a successful build and platform validation.
    output = publish_runtime(ROOT, platform_name + '-' + arch)
    print('Mobile gateway ready: ' + str(output))


if __name__ == '__main__':
    main()
