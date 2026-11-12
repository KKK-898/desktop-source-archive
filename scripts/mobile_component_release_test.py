import importlib.util
import io
import json
import os
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
from mobile_component_release import archive_details, component_base_url, platform_metadata, release_config, validate_archive_links


class ComponentArchiveTests(unittest.TestCase):
    def setUp(self):
        deployment = patch.dict(os.environ, {'GAOGE_MOBILE_COMPONENT_MANIFEST_URL': 'https://components.example.invalid/mobile-components/stable.json'})
        deployment.start()
        self.addCleanup(deployment.stop)
        self.directory = tempfile.TemporaryDirectory(prefix='gaoge-component-fixture-')
        self.addCleanup(self.directory.cleanup)
        self.filename = Path(self.directory.name) / 'runtime.tar.gz'

    def archive(self, platform='windows-x86_64', extra=None, manifest_platform=None):
        system, arch = platform.split('-', 1)
        name = 'gaoge-mobile-gateway.exe' if system == 'windows' else 'gaoge-mobile-gateway'
        manifest = {'platform': manifest_platform or system, 'architecture': arch}
        if system == 'macos':
            manifest['macos'] = {'minimumSystemVersion': '11.0', 'machoFilesChecked': 1}
        files = [('runtime/' + name, b'fixture'), ('runtime/runtime-manifest.json', json.dumps(manifest).encode()),
                 ('runtime/_internal/web/assets.json', b'{}')]
        with tarfile.open(self.filename, 'w:gz') as archive:
            for filename, contents in files:
                item = tarfile.TarInfo(filename)
                item.size, item.mode = len(contents), 0o755
                archive.addfile(item, io.BytesIO(contents))
            for item, contents in (extra if isinstance(extra, list) else [extra] if extra else []):
                archive.addfile(item, io.BytesIO(contents) if item.isfile() else None)
        return sum(len(contents) for _, contents in files)

    def test_metadata_is_bound_to_compressed_and_expanded_bytes(self):
        total = self.archive()
        metadata = platform_metadata(self.filename, 'windows-x86_64', release_config())
        self.assertEqual(total, metadata['unpackedSize'])
        self.assertEqual(self.filename.stat().st_size, metadata['size'])
        self.assertEqual(64, len(metadata['sha256']))
        self.assertTrue(metadata['url'].endswith('/' + release_config()['version'] + '/windows-x86_64.tar.gz'))

    def test_archive_rejects_path_traversal(self):
        self.archive(extra=(tarfile.TarInfo('runtime/../../outside'), b''))
        with self.assertRaisesRegex(ValueError, 'unsafe archive path'):
            archive_details(self.filename, 'windows-x86_64')

    def test_archive_rejects_second_root(self):
        self.archive(extra=(tarfile.TarInfo('other/payload'), b''))
        with self.assertRaisesRegex(ValueError, 'unsafe archive path'):
            archive_details(self.filename, 'windows-x86_64')

    def test_archive_rejects_hard_links(self):
        link = tarfile.TarInfo('runtime/duplicate')
        link.type, link.linkname = tarfile.LNKTYPE, 'runtime/gaoge-mobile-gateway.exe'
        self.archive(extra=(link, b''))
        with self.assertRaisesRegex(ValueError, 'unsupported entry type'):
            archive_details(self.filename, 'windows-x86_64')

    def test_archive_rejects_duplicate_paths(self):
        self.archive(extra=(tarfile.TarInfo('runtime/gaoge-mobile-gateway.exe'), b''))
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            archive_details(self.filename, 'windows-x86_64')

    def test_macos_preserves_safe_links_and_executable_permissions(self):
        link = tarfile.TarInfo('runtime/gateway-link')
        link.type, link.linkname = tarfile.SYMTYPE, 'gaoge-mobile-gateway'
        self.archive('macos-aarch64', extra=(link, b''))
        self.assertEqual(1, archive_details(self.filename, 'macos-aarch64')['symlinks'])

    def test_macos_rejects_link_escape(self):
        link = tarfile.TarInfo('runtime/unsafe-link')
        link.type, link.linkname = tarfile.SYMTYPE, '../outside'
        self.archive('macos-aarch64', extra=(link, b''))
        with self.assertRaisesRegex(ValueError, 'escapes'):
            archive_details(self.filename, 'macos-aarch64')

    def test_macos_framework_link_resolves_current_directory_alias(self):
        binary = tarfile.TarInfo('runtime/_internal/Python.framework/Versions/3.14/Python')
        binary.size = 3
        current = tarfile.TarInfo('runtime/_internal/Python.framework/Versions/Current')
        current.type, current.linkname = tarfile.SYMTYPE, '3.14'
        alias = tarfile.TarInfo('runtime/_internal/Python.framework/Python')
        alias.type, alias.linkname = tarfile.SYMTYPE, 'Versions/Current/Python'
        self.archive('macos-aarch64', extra=[(binary, b'bin'), (current, b''), (alias, b'')])
        self.assertEqual(2, archive_details(self.filename, 'macos-aarch64')['symlinks'])

    def test_macos_rejects_link_cycle(self):
        a, b = tarfile.TarInfo('runtime/a'), tarfile.TarInfo('runtime/b')
        a.type = b.type = tarfile.SYMTYPE
        a.linkname, b.linkname = 'b', 'a'
        self.archive('macos-aarch64', extra=[(a, b''), (b, b'')])
        with self.assertRaisesRegex(ValueError, 'cycle'):
            archive_details(self.filename, 'macos-aarch64')

    def test_macos_rejects_escape_after_intermediate_link_expansion(self):
        # Lexically deep/alias/../../outside appears inside runtime, but alias
        # points at runtime itself, so the first following '..' actually escapes.
        alias, escape = tarfile.TarInfo('runtime/deep/alias'), tarfile.TarInfo('runtime/escape')
        alias.type = escape.type = tarfile.SYMTYPE
        alias.linkname, escape.linkname = '..', 'deep/alias/../../outside'
        self.archive('macos-aarch64', extra=[(alias, b''), (escape, b'')])
        with self.assertRaisesRegex(ValueError, 'escapes'):
            archive_details(self.filename, 'macos-aarch64')

    def test_macos_rejects_non_directory_intermediate_target(self):
        alias = tarfile.TarInfo('runtime/bad')
        alias.type, alias.linkname = tarfile.SYMTYPE, 'gaoge-mobile-gateway/child'
        self.archive('macos-aarch64', extra=(alias, b''))
        with self.assertRaisesRegex(ValueError, 'non-directory'):
            archive_details(self.filename, 'macos-aarch64')

    def test_link_graph_rejects_growing_cycle(self):
        with self.assertRaisesRegex(ValueError, 'cycle'):
            validate_archive_links({'runtime/a': 'symlink'}, {'runtime/a': 'a/child'})

    def test_rejects_wrong_native_platform(self):
        self.archive(manifest_platform='macos')
        with self.assertRaisesRegex(ValueError, 'does not match'):
            archive_details(self.filename, 'windows-x86_64')

    def test_rejects_truncated_gzip(self):
        self.archive()
        contents = self.filename.read_bytes()
        self.filename.write_bytes(contents[:-8])
        with self.assertRaises((EOFError, OSError, tarfile.TarError)):
            archive_details(self.filename, 'windows-x86_64')

    def test_packager_materializes_hard_links_under_one_runtime_root(self):
        spec = importlib.util.spec_from_file_location('package_mobile_component', SCRIPTS / 'package-mobile-component.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        source = Path(self.directory.name) / 'source'
        assets = source / '_internal/web/assets.json'
        assets.parent.mkdir(parents=True)
        assets.write_text('{}')
        executable = source / 'gaoge-mobile-gateway.exe'
        executable.write_bytes(b'fixture')
        os.link(executable, source / 'same-inode.dll')
        (source / 'runtime-manifest.json').write_text(json.dumps({'platform': 'windows', 'architecture': 'x86_64'}))
        output = Path(self.directory.name) / 'packaged'
        target, metadata = module.package_runtime(source, output, 'windows-x86_64')
        with tarfile.open(target) as archive:
            members = archive.getmembers()
            self.assertTrue(all(member.name == 'runtime' or member.name.startswith('runtime/') for member in members))
            self.assertFalse(any(member.islnk() for member in members))
        self.assertEqual(archive_details(target, 'windows-x86_64')['unpackedSize'], metadata['unpackedSize'])
        with self.assertRaisesRegex(ValueError, 'overwrite'):
            module.package_runtime(source, output, 'windows-x86_64')


class MainBundleTests(unittest.TestCase):
    def test_mac_postbuild_gate_finds_nested_runtime(self):
        spec = importlib.util.spec_from_file_location('verify_main_bundle', SCRIPTS / 'verify-main-bundle.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temporary:
            bundle = Path(temporary)
            resources = bundle / 'macos/Gaoge Free.app/Contents/Resources'
            resources.mkdir(parents=True)
            self.assertEqual(['Gaoge Free.app'], module.verify_bundle('mac', bundle))
            leaked = resources / '_up_/resources/mobile-bridge/macos-aarch64'
            leaked.mkdir(parents=True)
            with self.assertRaisesRegex(ValueError, 'leaked'):
                module.verify_bundle('mac', bundle)


class ComponentDeploymentTests(unittest.TestCase):
    def test_release_requires_explicit_trusted_manifest(self):
        with patch.dict(os.environ, {'GAOGE_MOBILE_COMPONENT_MANIFEST_URL': ''}):
            with self.assertRaisesRegex(ValueError, 'explicitly configured'):
                component_base_url()

    def test_trusted_directory_is_canonical_and_retains_path_case(self):
        with patch.dict(os.environ, {'GAOGE_MOBILE_COMPONENT_MANIFEST_URL': 'HTTPS://COMPONENTS.EXAMPLE.INVALID:443/Mobile/stable.json'}):
            self.assertEqual('https://components.example.invalid/Mobile', component_base_url())

    def test_unsafe_manifest_cannot_define_component_trust(self):
        for value in ('http://components.example.invalid/mobile/stable.json',
                      'https://components.example.invalid:444/mobile/stable.json',
                      'https://user@components.example.invalid/mobile/stable.json',
                      'https://components.example.invalid/mobile/stable.json?query=1',
                      'https://components.example.invalid/mobile/stable.json#fragment',
                      'https://components.example.invalid/mobile/stable.json?',
                      'https://components.example.invalid/stable.json',
                      'https://components.example.invalid/mobile/',
                      'https://components.example.invalid/mobile/../stable.json',
                      'https://components.example.invalid/mobile/%2e%2e/stable.json',
                      'https://components.example.invalid./mobile/stable.json',
                      ' https://components.example.invalid/mobile/stable.json',
                      'https://components.example.invalid/mobile/stable.json\n'):
            with self.subTest(value=value), patch.dict(os.environ, {'GAOGE_MOBILE_COMPONENT_MANIFEST_URL': value}):
                with self.assertRaises(ValueError):
                    component_base_url()


if __name__ == '__main__':
    unittest.main()
