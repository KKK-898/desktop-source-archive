import io
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("remote-release.py")
SPEC = importlib.util.spec_from_file_location("gaoge_remote_release", MODULE_PATH)
REMOTE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REMOTE)


class RemoteReleaseTests(unittest.TestCase):
    def test_mirror_manifest_keeps_signature_and_uses_same_host(self):
        output = REMOTE.mirror_manifest(
            {
                "version": "1.4.2",
                "platforms": {
                    "windows-x86_64": {
                        "signature": "signed",
                        "url": "https://old.example/win/Gaoge Free_1.4.2_x64-setup.exe",
                    }
                },
            },
            "https://updates.example.invalid/gaogeaii/updates",
            "1.4.2",
            "1.4.2",
        )
        entry = output["platforms"]["windows-x86_64"]
        self.assertEqual(entry["signature"], "signed")
        self.assertEqual(
            entry["url"],
            "https://updates.example.invalid/gaogeaii/updates/win/Gaoge%20Free_1.4.2_x64-setup.exe",
        )

    def test_safe_extract_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "bad.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("../outside.txt", "bad")
            with self.assertRaises(RuntimeError):
                REMOTE.safe_extract(archive, Path(directory) / "output")

    def test_safe_extract_wraps_bad_zip_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "bad.zip"
            archive.write_bytes(b"not-a-zip")
            with self.assertRaises(RuntimeError):
                REMOTE.safe_extract(archive, Path(directory) / "output")

    def test_download_retries_until_zip_archive_is_valid(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "artifact.zip"
            invalid_response = io.BytesIO(b"not-a-zip")
            valid_buffer = io.BytesIO()
            with zipfile.ZipFile(valid_buffer, "w") as bundle:
                bundle.writestr("hello.txt", "world")
            valid_response = io.BytesIO(valid_buffer.getvalue())

            class FakeResponse:
                def __init__(self, payload: io.BytesIO):
                    self._payload = payload
                    self.headers = {"Content-Type": "application/zip", "Content-Length": str(len(payload.getvalue()))}

                def __enter__(self):
                    return self

                def __exit__(self, exc_type, exc, tb):
                    return False

                def read(self, size=-1):
                    return self._payload.read(size)

            class FakeOpener:
                def __init__(self):
                    self.calls = 0

                def open(self, request, timeout=120):
                    self.calls += 1
                    if self.calls < 3:
                        return FakeResponse(io.BytesIO(invalid_response.getvalue()))
                    return FakeResponse(io.BytesIO(valid_response.getvalue()))

            opener = FakeOpener()

            with mock.patch.object(REMOTE.urllib.request, "build_opener", return_value=opener), mock.patch.object(
                REMOTE.urllib.request,
                "urlopen",
                side_effect=AssertionError("redirect path should not be used"),
            ):
                REMOTE.download("https://example.invalid/artifact.zip", target, "token")

            self.assertTrue(zipfile.is_zipfile(target))
            self.assertEqual(opener.calls, 3)

    def test_manifest_uses_immutable_versioned_copy_for_stable_updater_name(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "Gaoge Free.app.tar.gz"
            artifact.write_bytes(b"app")
            Path(f"{artifact}.sig").write_text("signed", encoding="utf-8")
            manifest = {
                "version": "1.4.2",
                "minimumVersion": "1.4.2",
                "platforms": {
                    "darwin-aarch64": {
                        "signature": "signed",
                        "url": "https://api.example/updates/mac/Gaoge%20Free.app.tar.gz",
                    }
                },
            }
            output = REMOTE.versioned_manifest_artifacts(
                manifest,
                root,
                "https://api.example/updates",
                "1.4.2",
            )
            url = output["platforms"]["darwin-aarch64"]["url"]
            self.assertTrue(url.endswith("/mac/Gaoge%20Free_1.4.2.app.tar.gz"))
            self.assertTrue((root / "Gaoge Free_1.4.2.app.tar.gz.sig").exists())

    def test_restore_removes_new_mutable_file_and_restores_previous_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target_existing = root / "latest.json"
            target_existing.write_text("new", encoding="utf-8")
            backup = root / "latest.backup"
            backup.write_text("old", encoding="utf-8")
            target_new = root / "Gaoge-Free-latest.exe"
            target_new.write_text("new", encoding="utf-8")
            REMOTE.restore_from_state({}, {
                "backups": [
                    {"target": str(target_existing), "backup": str(backup)},
                    {"target": str(target_new), "backup": ""},
                ]
            })
            self.assertEqual(target_existing.read_text(encoding="utf-8"), "old")
            self.assertFalse(target_new.exists())


if __name__ == "__main__":
    unittest.main()
