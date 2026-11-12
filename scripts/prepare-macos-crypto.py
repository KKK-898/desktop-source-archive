"""Build current cryptography with static OpenSSL for Intel macOS 11 CI bundles.

Run before installing requirements-desktop.txt. Cryptography 49+ no longer ships
Intel macOS wheels; a default source install can link the runner's macOS-15-only
Homebrew libraries. Never reuse those libraries or downgrade cryptography.
"""
import hashlib
import importlib.util
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

CRYPTOGRAPHY_VERSION = '50.0.2'
OPENSSL_VERSION = '4.0.3'
OPENSSL_URL = ('https://github.com/openssl/openssl/releases/download/openssl-' +
               OPENSSL_VERSION + '/openssl-' + OPENSSL_VERSION + '.tar.gz')
# Official release .sha256; also used by pyca/infra/cryptography-linux/openssl-version.sh.
OPENSSL_SHA256 = '325b5c806167c13b40b1ffeadfe0248197c00eccc4cf123ec1e28d2d2fd216d9'
MACOS_TARGET = '11.0'
# Match pyca's static wheel configuration; providers are linked into libcrypto.
OPENSSL_FLAGS = ['no-zlib', 'no-shared', 'no-module', 'no-comp', 'no-apps',
                 'no-docs', 'no-sm2-precomp', 'no-atexit', 'enable-ec_nistp_64_gcc_128']


def main():
    if sys.platform != 'darwin' or platform.machine() != 'x86_64':
        raise RuntimeError('This preparation step is only for native Intel macOS')
    runner_temp = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
    if not runner_temp.is_dir():
        raise RuntimeError('RUNNER_TEMP must be an existing directory')
    # New, uniquely owned directory. No existing toolchain, library or output is deleted.
    work = Path(tempfile.mkdtemp(prefix='gaoge-macos-crypto-', dir=runner_temp)).resolve(strict=True)
    archive = work / ('openssl-' + OPENSSL_VERSION + '.tar.gz')
    subprocess.run(['curl', '--fail', '--location', '--retry', '3', '--proto', '=https',
                    '--tlsv1.2', '--output', str(archive), OPENSSL_URL], check=True)
    with archive.open('rb') as stream:
        actual_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
    if actual_hash != OPENSSL_SHA256:
        raise RuntimeError('Official OpenSSL source checksum mismatch; refusing to build')
    with tarfile.open(archive) as source_archive:
        expected = 'openssl-' + OPENSSL_VERSION
        if any(Path(item.name).parts[0] != expected for item in source_archive.getmembers() if item.name):
            raise RuntimeError('Unexpected OpenSSL source archive layout')
        source_archive.extractall(work, filter='data')
    source = work / ('openssl-' + OPENSSL_VERSION)
    prefix = work / 'install'
    env = os.environ.copy()
    for key in list(env):
        if 'OPENSSL' in key.upper():
            env.pop(key)
    env.update(MACOSX_DEPLOYMENT_TARGET=MACOS_TARGET,
               ARCHFLAGS='-arch x86_64', CFLAGS='-mmacosx-version-min=11.0 -march=core2',
               LDFLAGS='-mmacosx-version-min=11.0')
    subprocess.run(['perl', './Configure', 'darwin64-x86_64-cc',
                    '--prefix=' + str(prefix), '--libdir=lib',
                    '--openssldir=' + str(prefix / 'ssl'), *OPENSSL_FLAGS,
                    '-mmacosx-version-min=11.0', '-march=core2'],
                   cwd=source, env=env, check=True)
    subprocess.run(['make', '-j' + str(min(os.cpu_count() or 2, 8))], cwd=source, env=env, check=True)
    subprocess.run(['make', 'install_sw'], cwd=source, env=env, check=True)
    if not all((prefix / 'lib' / name).is_file() for name in ('libssl.a', 'libcrypto.a')):
        raise RuntimeError('Static OpenSSL libraries were not produced')
    if list(prefix.rglob('*.dylib')):
        raise RuntimeError('Static OpenSSL build unexpectedly produced dynamic libraries')
    env.update(OPENSSL_DIR=str(prefix), OPENSSL_LIB_DIR=str(prefix / 'lib'),
               OPENSSL_INCLUDE_DIR=str(prefix / 'include'), OPENSSL_STATIC='1')
    subprocess.run([sys.executable, '-m', 'pip', 'install', '--index-url', 'https://pypi.org/simple',
                    '--no-cache-dir', '--force-reinstall', '--no-binary=cryptography',
                    'cryptography==' + CRYPTOGRAPHY_VERSION], env=env, check=True)

    details = json.loads(subprocess.check_output([sys.executable, '-c',
        'import json, cryptography; '
        'import cryptography.hazmat.bindings._rust as bindings; '
        'from cryptography.hazmat.backends.openssl.backend import backend; '
        'print(json.dumps({"version": cryptography.__version__, '
        '"openssl": backend.openssl_version_text(), "bindings": bindings.__file__}))'],
        env=env, text=True))
    if details['version'] != CRYPTOGRAPHY_VERSION or not details['openssl'].startswith('OpenSSL ' + OPENSSL_VERSION + ' '):
        raise RuntimeError('Installed cryptography did not use the verified OpenSSL build')
    imports = subprocess.check_output(['otool', '-L', details['bindings']], text=True)
    if any(value in imports.lower() for value in ('libssl', 'libcrypto', '/opt/homebrew/', '/usr/local/opt/')):
        raise RuntimeError('Cryptography still imports a shared or Homebrew OpenSSL library')
    spec = importlib.util.spec_from_file_location('mobile_build', Path(__file__).with_name('build-mobile-bridge.py'))
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)
    load_commands = subprocess.check_output(['otool', '-arch', 'x86_64', '-l', details['bindings']], text=True)
    versions = build.minimum_macos_versions(load_commands)
    if not versions or max(map(build.version_tuple, versions)) > build.version_tuple(MACOS_TARGET):
        raise RuntimeError('Built cryptography exceeds the declared macOS minimum')
    record = {
        'cryptographyVersion': CRYPTOGRAPHY_VERSION, 'opensslVersion': OPENSSL_VERSION,
        'opensslSourceUrl': OPENSSL_URL, 'opensslSourceSha256': OPENSSL_SHA256,
        'architecture': 'x86_64', 'linkage': 'static', 'macosDeploymentTarget': MACOS_TARGET,
        'minimumSystemVersion': max(versions, key=build.version_tuple), 'opensslBuildFlags': OPENSSL_FLAGS,
    }
    metadata = work / 'crypto-build.json'
    metadata.write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    shutil.copy2(source / 'LICENSE.txt', work / 'LICENSE.txt')
    if os.environ.get('GITHUB_ENV'):
        with Path(os.environ['GITHUB_ENV']).open('a', encoding='utf-8') as stream:
            stream.write('GAOGE_MACOS_CRYPTO_RECORD=' + str(metadata) + '\n')
    print('Verified Intel macOS cryptography: ' + json.dumps(record))
    print('GAOGE_MACOS_CRYPTO_RECORD=' + str(metadata))


if __name__ == '__main__':
    main()
