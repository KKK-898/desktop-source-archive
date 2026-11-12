"""Fixture-only packaging checks; never builds or launches the user's gateway."""
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('build_mobile_bridge', Path(__file__).with_name('build-mobile-bridge.py'))
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)


class RuntimeCopyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='gaoge-runtime-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / 'mobile-bridge/.tmp/dist/gaoge-mobile-gateway'
        self.source.mkdir(parents=True)
        (self.source / 'gaoge-mobile-gateway').write_text('fixture', encoding='utf-8')
        self.parent = self.root / 'resources/mobile-bridge'
        self.parent.mkdir(parents=True)

    def symlink(self, link, target, directory=False):
        try:
            link.symlink_to(target, target_is_directory=directory)
        except OSError as error:
            self.skipTest('Fixture symlinks unavailable: ' + str(error))

    def test_repeat_copy_preserves_framework_links_and_sibling(self):
        framework = self.source / '_internal/Python.framework'
        version = framework / 'Versions/3.14'
        version.mkdir(parents=True)
        (version / 'Python').write_text('library', encoding='utf-8')
        self.symlink(framework / 'Versions/Current', '3.14', directory=True)
        self.symlink(framework / 'Python', 'Versions/Current/Python')
        sibling = self.parent / 'macos-x86_64'
        sibling.mkdir()
        (sibling / 'keep').write_text('other architecture', encoding='utf-8')
        output = build.publish_runtime(self.root, 'macos-aarch64')
        (output / 'stale-library').write_text('old', encoding='utf-8')
        build.publish_runtime(self.root, 'macos-aarch64')
        self.assertFalse((output / 'stale-library').exists())
        self.assertEqual((sibling / 'keep').read_text(encoding='utf-8'), 'other architecture')
        self.assertTrue((output / '_internal/Python.framework/Versions/Current').is_symlink())
        self.assertTrue((output / '_internal/Python.framework/Python').is_symlink())
        self.assertEqual((output / '_internal/Python.framework/Python').readlink(), Path('Versions/Current/Python'))

    def test_destination_link_rejected_before_removal(self):
        unrelated = self.root / 'unrelated'
        unrelated.mkdir()
        (unrelated / 'keep').write_text('untouched', encoding='utf-8')
        self.symlink(self.parent / 'macos-aarch64', unrelated, directory=True)
        with self.assertRaises(ValueError):
            build.publish_runtime(self.root, 'macos-aarch64')
        self.assertEqual((unrelated / 'keep').read_text(encoding='utf-8'), 'untouched')

    def test_redirected_parent_rejected(self):
        self.parent.rmdir()
        unrelated = self.root / 'unrelated'
        unrelated.mkdir()
        self.symlink(self.parent, unrelated, directory=True)
        with self.assertRaises(ValueError):
            build.publish_runtime(self.root, 'macos-aarch64')
        self.assertEqual(list(unrelated.iterdir()), [])

    def test_unknown_destination_cannot_escape_owned_output(self):
        with self.assertRaises(ValueError):
            build.publish_runtime(self.root, '../../unrelated')


class MacosVersionTests(unittest.TestCase):
    def test_ignores_sdk_and_dylib_versions(self):
        output = '''fixture (architecture arm64):
Load command 0
          cmd LC_BUILD_VERSION
     platform MACOS
        minos 11.0
          sdk 26.0
Load command 1
          cmd LC_LOAD_DYLIB
      current version 999.0.0
compatibility version 99.0.0
Load command 2
          cmd LC_BUILD_VERSION
     platform 2
        minos 15.0
'''
        self.assertEqual(build.minimum_macos_versions(output), ['11.0'])
        self.assertEqual(build.version_tuple('11.0'), build.version_tuple('11.0.0'))

    def test_legacy_macos_load_command(self):
        self.assertEqual(build.minimum_macos_versions('''Load command 4
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version 10.15
      sdk 13.0
'''), ['10.15'])

    def test_real_binary_floor_overrides_requested_target(self):
        with tempfile.TemporaryDirectory(prefix='gaoge-macho-test-') as directory:
            root = Path(directory)
            (root / 'gateway').write_bytes(b'\xcf\xfa\xed\xfe' + b'fixture')
            (root / 'library.dylib').write_bytes(b'\xcf\xfa\xed\xfe' + b'fixture')
            (root / 'assets.json').write_text(json.dumps({'data': True}), encoding='utf-8')

            def otool(args, **kwargs):
                self.assertEqual(args[:4], ['otool', '-arch', 'arm64', '-l'])
                minimum = '12.0' if args[-1].endswith('library.dylib') else '11.0'
                return subprocess.CompletedProcess(args, 0,
                    'Load command 0\n  cmd LC_BUILD_VERSION\n  platform 1\n  minos ' + minimum + '\n')

            with patch.object(build.subprocess, 'run', side_effect=otool):
                with self.assertRaisesRegex(RuntimeError, r'exceeding requested 11\.0.*library\.dylib'):
                    build.macos_runtime_metadata(root, 'arm64', '11.0')
                metadata = build.macos_runtime_metadata(root, 'arm64', '12.0')
            self.assertEqual(metadata['minimumSystemVersion'], '12.0')
            self.assertEqual(metadata['machoFilesChecked'], 2)

    def test_missing_load_command_is_not_claimed_compatible(self):
        with tempfile.TemporaryDirectory(prefix='gaoge-macho-test-') as directory:
            root = Path(directory)
            (root / 'gateway').write_bytes(b'\xcf\xfa\xed\xfe' + b'fixture')
            with patch.object(build.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '')):
                with self.assertRaisesRegex(RuntimeError, 'Cannot determine macOS minimum'):
                    build.macos_runtime_metadata(root, 'arm64', '11.0')


if __name__ == '__main__':
    unittest.main()
