"""Read-only configuration tests; never invoke nginx, copy, chown or servers."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("mirrors", Path(__file__).with_name("setup-update-mirrors.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class MirrorConfigurationTests(unittest.TestCase):
    def config(self):
        return {"source": "/srv/updates", "targets": {"main": "/srv/mirror-main"},
                "sites": {"main": "/etc/nginx/sites-available/api.example.invalid"},
                "sharedSnippet": "/etc/nginx/snippets/updates.conf",
                "backupRoot": "/srv/backups", "owner": "www-data:www-data"}

    def read(self, config):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            return mod.load_configuration(path)

    def test_explicit_configuration(self):
        source, targets, sites, snippet, backups, owner = self.read(self.config())
        self.assertEqual(source.as_posix(), "/srv/updates")
        self.assertEqual(set(targets), {"main"})
        self.assertEqual(set(sites), {"main"})
        self.assertEqual(owner, "www-data:www-data")

    def test_missing_configuration_never_defaults_to_production(self):
        with self.assertRaises(ValueError):
            self.read({})

    def test_unsafe_destinations_and_mismatched_keys_rejected(self):
        for target in ("/", "relative/path", "/srv/updates", "/srv/updates/child", "/srv", "/srv/../bad", "/srv/bad;directive", "/srv/bad path", "/srv/bad#comment", "/srv/bad\\path", "/srv/./target", "//srv/target"):
            config = self.config()
            config["targets"]["main"] = target
            with self.assertRaises(ValueError, msg=target):
                self.read(config)
        config = self.config()
        config["sites"] = {"other": "/etc/nginx/sites-available/api.example.invalid"}
        with self.assertRaises(ValueError):
            self.read(config)

    def test_targets_must_not_overlap_each_other(self):
        config = self.config()
        config["targets"]["nested"] = "/srv/mirror-main/nested"
        config["sites"]["nested"] = "/etc/nginx/sites-available/nested.example.invalid"
        with self.assertRaises(ValueError):
            self.read(config)

    def test_snippet_preserves_existing_locale_proxy_tail(self):
        tail = "location ^~ /locales/ { alias /srv/existing/; }\n"
        result = mod.snippet(Path("/srv/mirror"), tail)
        self.assertTrue(result.endswith(tail))
        self.assertIn("/gaogeaii/updates/win/", result)


if __name__ == "__main__":
    unittest.main()
