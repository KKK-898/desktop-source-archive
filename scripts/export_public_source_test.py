"""Isolated source-export tests; no network, private configuration or publication."""
from pathlib import Path
import importlib.util
import contextlib
import copy
import io
import sys
from unittest import mock
import json
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("public_source_export", Path(__file__).with_name("export_public_source.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class PublicSourceExportTests(unittest.TestCase):
    def minimal(self):
        paths = {path: b"" for path in mod.REQUIRED}
        paths["package.json"] = mod.json_bytes({"version": "1.7.1", "license": "AGPL-3.0-only"})
        paths["package-lock.json"] = mod.json_bytes({"version": "1.7.1", "packages": {"": {"version": "1.7.1", "license": "AGPL-3.0-only"}}})
        paths["src-tauri/Cargo.toml"] = b'[package]\nversion = "1.7.1"\nlicense = "AGPL-3.0-only"\n'
        paths["src-tauri/tauri.conf.json"] = mod.json_bytes({"version": "1.7.1", "bundle": {"resources": []}})
        paths["scripts/public-source-audit.json"] = mod.json_bytes({"schemaVersion": 1, "items": []})
        return paths

    def failed(self, paths, name):
        _, checks, _, _ = mod.inspect(paths, [])
        return not next(x for x in checks if x["name"] == name)["ok"]

    def test_private_deployment_entry_points_are_excluded(self):
        for name in mod.PRIVATE_OPERATIONAL_SCRIPTS:
            self.assertIn("private operator", mod.exclusion(name))
        for name in ("mobile-bridge/relay/__main__.py", "mobile-bridge/requirements-relay.txt",
                     "mobile-bridge/deploy/gaoge-mobile-relay.service", "mobile-bridge/deploy/nginx-mobile.conf",
                     "scripts/package-mobile-component.py", "scripts/prepare-mobile-component-release.py",
                     "scripts/verify-mobile-component-signature.mjs"):
            self.assertIsNone(mod.exclusion(name), name)

    def test_build_and_runtime_sources_do_not_depend_on_private_deployers(self):
        root = Path(__file__).resolve().parents[1]
        # Check the real retained project, including the exported copy. Walk only
        # dependency-bearing source/config extensions and prune generated trees.
        import os
        extensions = {".py", ".ps1", ".mjs", ".cjs", ".js", ".rs", ".ts", ".tsx", ".vue", ".json", ".yml", ".yaml", ".toml"}
        allowed_mentions = {"scripts/export_public_source.py", "scripts/export_public_source_test.py"}
        names = {Path(name).name.encode() for name in mod.PRIVATE_OPERATIONAL_SCRIPTS}
        candidates = [root / "package.json", root / "package-lock.json"]
        for directory in ("src", "src-tauri", "scripts", "mobile-bridge", ".github"):
            for base, directories, files in os.walk(root / directory):
                directories[:] = [name for name in directories
                                   if mod.exclusion((Path(base) / name / "candidate.py").relative_to(root).as_posix()) is None]
                candidates.extend(Path(base) / name for name in files)
        for candidate in candidates:
            name = candidate.relative_to(root).as_posix()
            if candidate.suffix not in extensions or name in allowed_mentions or mod.exclusion(name) is not None:
                continue
            data = candidate.read_bytes()
            self.assertFalse(any(deployer in data for deployer in names), name)

    def test_public_release_notes_replace_private_operational_notes(self):
        target = "docs/release-1.7.1.md"
        source = "scripts/public-source-docs/release-1.7.1.md"
        self.assertEqual(mod.REPLACEMENTS[target], source)
        paths = self.minimal()
        for replacement in mod.REPLACEMENTS.values():
            paths[replacement] = b"Public build/release documentation\n"
        paths[target] = b"INTERNAL_VALIDATION_LOG_AND_OPERATOR_PROCESS\n"
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "source"
            with mock.patch.object(mod, "read_source", return_value=(paths, [], [], {}, "a" * 40, "b" * 40)):
                mod.export(temp, output)
            self.assertEqual((output / target).read_bytes(), paths[source])
            self.assertNotIn(b"INTERNAL_VALIDATION", (output / target).read_bytes())
            report = json.loads((output / "SOURCE_EXPORT_REPORT.json").read_text(encoding="utf-8"))
            self.assertIn({"path": target, "from": source, "sha256": mod.sha(paths[source])}, report["replacements"])

    def test_sensitive_filename_families_excluded_without_token_prefixes(self):
        for path in ["mobile-bridge/.env.production", "scripts/.ENV.local", "mobile-bridge/.env.example",
                     "scripts/.npmrc", "scripts/.NPMRC", "scripts/.npmrc.backup", "scripts/.pypirc",
                     "scripts/.yarnrc.yml", "scripts/.netrc", "scripts/_netrc", "scripts/.git-credentials",
                     "scripts/pip.conf", "scripts/nuget.config", "resources/auth.json.bak",
                     "resources/Auth.JSON.old", "resources/credentials.json~", "resources/credentials.backup.json",
                     "resources/secret.yaml", "resources/.secrets.toml", "resources/token.txt",
                     "scripts/.release.local.json.bak", "resources/.ssh/id_ed25519", "resources/.aws/config"]:
            self.assertIsNotNone(mod.exclusion(path), path)

    def test_sensitive_filenames_are_rejected_by_inspection_too(self):
        for path in ["mobile-bridge/.env.production", "scripts/.npmrc", "resources/auth.json.bak"]:
            paths = self.minimal()
            paths[path] = b"DATABASE_URL=postgres://fixture:synthetic-only@db.invalid/db\npassword=fixture-only\n"
            self.assertTrue(self.failed(paths, "sensitive_source_paths"), path)

    def test_authentication_source_modules_are_retained(self):
        for path in ["mobile-bridge/bridge/features/auth/auth.py", "mobile-bridge/bridge/features/accounts/secrets.py",
                     "src/auth.ts", "src/credentials.ts", "src/env.d.ts", "src-tauri/src/codex_official_auth_verification.rs"]:
            self.assertIsNone(mod.exclusion(path), path)

    def test_placeholder_filename_does_not_imply_safe_content(self):
        paths = self.minimal()
        paths[".release.local.example.json"] = b'{"password":"synthetic-not-a-template"}'
        self.assertTrue(self.failed(paths, "sensitive_source_paths"))
        self.assertIsNotNone(mod.exclusion("scripts/.env.example"))
        self.assertIsNotNone(mod.exclusion("resources/auth.example.json"))

    def test_portable_path_names_rejected(self):
        for path in ["src/CON", "src/nul.txt", "src/LPT1.png", "src/com\u00b9.txt", "src/trailing.",
                     "src/trailing ", "src//a.txt", "src/./a.txt", "src/quo?te", "src/a\x00b", "src/.GIT/config"]:
            with self.assertRaisesRegex(ValueError, "Unsafe source path", msg=repr(path)):
                mod.exclusion(path)

    def test_portable_file_and_directory_collisions_rejected(self):
        for names in [["src/A.txt", "src/a.txt"], ["src/\u00e9.txt", "src/e\u0301.txt"],
                      ["src/Dir/a.txt", "src/dir/b.txt"], ["src/A", "src/a/b.txt"],
                      ["source_manifest.json"]]:
            paths = self.minimal()
            paths.update({name: b"synthetic" for name in names})
            self.assertTrue(self.failed(paths, "portable_source_paths"), names)

    def test_unsafe_inputs_block_review_before_any_output(self):
        for additions in [{"src/A.txt": b"a", "src/a.txt": b"b"},
                          {"src/CON": b"synthetic"}, {"scripts/.npmrc": b"password=synthetic"},
                          {".release.local.example.json": b'{"password":"synthetic"}'}]:
            paths = self.minimal()
            paths.update(additions)
            for source in mod.REPLACEMENTS.values():
                paths[source] = b"public synthetic replacement"
            with tempfile.TemporaryDirectory() as temp:
                output = Path(temp) / "source"
                archive = Path(temp) / "source.zip"
                with mock.patch.object(mod, "read_source", return_value=(paths, [], [], {}, "a" * 40, "b" * 40)):
                    with self.assertRaisesRegex(ValueError, "Unsafe source export blocked"):
                        mod.export(temp, output, review_only=True, archive_path=archive)
                self.assertFalse(output.exists())
                self.assertFalse(archive.exists())

    def test_committed_sensitive_files_are_omitted_in_real_export(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "repo"
            root.mkdir()
            paths = self.minimal()
            for source in mod.REPLACEMENTS.values():
                paths[source] = b"public synthetic replacement"
            sensitive = ["mobile-bridge/.env.production", "scripts/.npmrc", "resources/auth.json.bak", *sorted(mod.PRIVATE_OPERATIONAL_SCRIPTS)]
            for name in sensitive:
                paths[name] = b"DATABASE_URL=postgres://fixture:synthetic-only@db.invalid/db\npassword=fixture-only\n"
            paths["mobile-bridge/bridge/features/auth/auth.py"] = b"# synthetic authentication source\n"
            for name, data in paths.items():
                destination = root / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "config", "core.autocrlf", "false"], check=True)
            subprocess.run(["git", "-C", str(root), "add", "."], check=True)
            subprocess.run(["git", "-C", str(root), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "synthetic fixture"], check=True)
            result = mod.export(root, Path(temp) / "out")
            self.assertTrue(result["ReleaseReady"])
            out = Path(result["SourceDirectory"])
            report = json.loads((out / "SOURCE_EXPORT_REPORT.json").read_bytes())
            excluded = {item["path"] for item in report["exclusions"]}
            for name in sensitive:
                self.assertFalse((out / name).exists(), name)
                self.assertIn(name, excluded)
            self.assertTrue((out / "mobile-bridge/bridge/features/auth/auth.py").exists())

    def test_stdout_json_is_ascii_and_roundtrips_unicode_paths(self):
        expected = {"SourceDirectory": "D:/\u4ee3\u7801/\u6d4b\u8bd5", "ReleaseReady": False}
        output = io.StringIO()
        with mock.patch.object(sys, "argv", ["export_public_source.py", "--output-directory", "unused"]):
            with mock.patch.object(mod, "export", return_value=expected):
                with contextlib.redirect_stdout(output):
                    self.assertEqual(mod.main(), 0)
        self.assertTrue(output.getvalue().isascii())
        self.assertEqual(json.loads(output.getvalue()), expected)

    def owner_decision_fixture(self):
        paths = self.minimal()
        target = "theme-resources/sources/synthetic.png"
        paths[target] = b"synthetic-only test asset"
        paths["theme-resources/licenses/synthetic.md"] = b"Synthetic provenance; no third-party artwork."
        original = {"path": target, "sha256": mod.sha(paths[target]), "status": "unverified-third-party-artwork",
                    "reason": "Synthetic unresolved audit for this test only",
                    "evidence": ["theme-resources/licenses/synthetic.md"]}
        scope = {"decisionId": mod.OWNER_RELEASE_DECISION_ID, "version": "1.7.1", "items": [original]}
        evidence = b"Synthetic test decision only.\n```json\n" + mod.json_bytes(scope) + b"```\n"
        evidence_hash = mod.sha(evidence)
        paths[mod.OWNER_RELEASE_EVIDENCE_PATH] = evidence
        item = copy.deepcopy(original)
        item["releaseDecision"] = {"type": "owner-directed-publication", "decisionId": mod.OWNER_RELEASE_DECISION_ID,
            "version": "1.7.1", "sha256": item["sha256"],
            "evidence": [{"path": mod.OWNER_RELEASE_EVIDENCE_PATH, "sha256": evidence_hash}],
            "acknowledgesUnverifiedRights": True}
        paths["scripts/public-source-audit.json"] = mod.json_bytes({"schemaVersion": 1, "items": [item]})
        return paths, target, evidence_hash

    def inspect_owner_fixture(self, paths, evidence_hash):
        with mock.patch.object(mod, "OWNER_RELEASE_SCOPE_COUNT", 1), mock.patch.object(mod, "OWNER_RELEASE_EVIDENCE_SHA256", evidence_hash):
            return mod.inspect(paths, [])

    def test_owner_decision_retains_unverified_disclosure(self):
        paths, target, evidence_hash = self.owner_decision_fixture()
        _, checks, findings, disclosures = self.inspect_owner_fixture(paths, evidence_hash)
        self.assertTrue(all(x["ok"] for x in checks))
        self.assertEqual(findings, [])
        self.assertEqual(len(disclosures), 1)
        self.assertEqual(disclosures[0]["path"], target)
        self.assertEqual(disclosures[0]["status"], "unverified-third-party-artwork")
        self.assertTrue(disclosures[0]["releaseDecision"]["acknowledgesUnverifiedRights"])

    def test_owner_decision_invalid_bindings_block(self):
        cases = ["missing-evidence", "changed-evidence", "wrong-decision-version", "wrong-project-version", "changed-asset",
                 "changed-decision-hash", "missing-decision", "missing-acknowledgement", "false-verified-field", "fake-verified-status", "fake-cleared-status", "changed-original-reason"]
        for case in cases:
            paths, target, evidence_hash = self.owner_decision_fixture()
            audit = json.loads(paths["scripts/public-source-audit.json"])
            item = audit["items"][0]
            if case == "missing-evidence": del paths[mod.OWNER_RELEASE_EVIDENCE_PATH]
            elif case == "changed-evidence": paths[mod.OWNER_RELEASE_EVIDENCE_PATH] += b"changed"
            elif case == "wrong-decision-version": item["releaseDecision"]["version"] = "1.7.2"
            elif case == "wrong-project-version":
                for name in ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"]:
                    paths[name] = paths[name].replace(b"1.7.1", b"1.7.2")
            elif case == "changed-asset": paths[target] += b"changed"
            elif case == "changed-decision-hash": item["releaseDecision"]["sha256"] = "0" * 64
            elif case == "missing-decision": del item["releaseDecision"]
            elif case == "missing-acknowledgement": del item["releaseDecision"]["acknowledgesUnverifiedRights"]
            elif case == "false-verified-field": item["releaseDecision"]["verified"] = True
            elif case == "fake-verified-status": item["status"] = "verified"
            elif case == "fake-cleared-status": item["status"] = "cleared"
            elif case == "changed-original-reason": item["reason"] = "All rights verified"
            paths["scripts/public-source-audit.json"] = mod.json_bytes(audit)
            _, checks, findings, disclosures = self.inspect_owner_fixture(paths, evidence_hash)
            self.assertTrue(any(not x["ok"] for x in checks), case)
            self.assertTrue(findings, case)
            self.assertEqual(disclosures, [], case)

    def test_owner_decision_cannot_hide_or_expand_scope(self):
        for case in ["missing-asset", "missing-audit", "new-asset"]:
            paths, target, evidence_hash = self.owner_decision_fixture()
            audit = json.loads(paths["scripts/public-source-audit.json"])
            if case == "missing-asset": del paths[target]
            elif case == "missing-audit": audit["items"] = []
            else:
                new_path = "theme-resources/sources/not-authorized.png"
                paths[new_path] = b"synthetic out-of-scope asset"
                item = copy.deepcopy(audit["items"][0]); item["path"] = new_path
                item["sha256"] = item["releaseDecision"]["sha256"] = mod.sha(paths[new_path])
                audit["items"].append(item)
            paths["scripts/public-source-audit.json"] = mod.json_bytes(audit)
            _, checks, _, _ = self.inspect_owner_fixture(paths, evidence_hash)
            self.assertTrue(any(not x["ok"] for x in checks), case)

    def test_export_records_disclosures_without_claiming_clearance(self):
        paths, target, evidence_hash = self.owner_decision_fixture()
        for source in mod.REPLACEMENTS.values():
            paths[source] = b"Synthetic public build documentation"
        with tempfile.TemporaryDirectory() as temp:
            with mock.patch.object(mod, "OWNER_RELEASE_SCOPE_COUNT", 1), mock.patch.object(mod, "OWNER_RELEASE_EVIDENCE_SHA256", evidence_hash):
                with mock.patch.object(mod, "read_source", return_value=(paths, [], [], {}, "a" * 40, "b" * 40)):
                    result = mod.export(temp, Path(temp) / "out")
            report = json.loads(Path(result["ReportPath"]).read_bytes())
            self.assertTrue(result["ReleaseReady"])
            self.assertEqual(report["rightsFindings"], [])
            self.assertEqual(report["rightsDisclosures"][0]["status"], "unverified-third-party-artwork")
            self.assertEqual(report["rightsDisclosures"][0]["path"], target)

    def test_real_owner_document_preserves_all_original_audit_fields(self):
        root = Path(__file__).resolve().parent.parent
        doc = (root / mod.OWNER_RELEASE_EVIDENCE_PATH).read_bytes()
        self.assertEqual(mod.sha(doc), mod.OWNER_RELEASE_EVIDENCE_SHA256)
        scope, issues = mod.owner_release_scope({mod.OWNER_RELEASE_EVIDENCE_PATH: doc})
        self.assertEqual(issues, [])
        self.assertEqual(len(scope), 50)
        audit = json.loads((root / "scripts/public-source-audit.json").read_bytes())
        self.assertEqual(set(scope), {i["path"] for i in audit["items"]})
        for item in audit["items"]:
            self.assertEqual({k: v for k, v in item.items() if k != "releaseDecision"}, scope[item["path"]])
            self.assertNotIn(item["status"], {"verified", "cleared", "replaced-original"})

    def test_minimal_structural_checks(self):
        _, checks, findings, disclosures = mod.inspect(self.minimal(), [])
        self.assertTrue(all(x["ok"] for x in checks))
        self.assertEqual(findings, [])
        self.assertEqual(disclosures, [])

    def test_private_paths_excluded(self):
        for path in [".release.local.json", "src-tauri/tauri-update.key", ".codex-validation/a.png", "node_modules/a.js", "src-tauri/target/a", "docs/balance-backend-validation-status.md", "mobile-bridge/DEPLOYMENT.txt"]:
            self.assertIsNotNone(mod.exclusion(path), path)

    def test_notices_and_required_docs_retained(self):
        for path in ["AGENTS.md", "LICENSE", "theme-resources/licenses/NOTICE.md", "mobile-bridge/LICENSE", "docs/remote-updates.md", "docs/cross-platform-release.md"]:
            self.assertIsNone(mod.exclusion(path), path)

    def test_path_traversal_rejected(self):
        for path in ["../secret", "/absolute", "src/../../secret", "src\\bad"]:
            with self.assertRaises(ValueError):
                mod.exclusion(path)

    def test_missing_embedded_source_blocks(self):
        paths = self.minimal()
        paths["src-tauri/src/lib.rs"] = b'const X: &str = include_str!("missing.js");'
        self.assertTrue(self.failed(paths, "rust_embedded_source_inputs"))

    def test_missing_frontend_resource_blocks(self):
        paths = self.minimal()
        paths["src/test.ts"] = b'new URL("./missing.png", import.meta.url)'
        self.assertTrue(self.failed(paths, "frontend_relative_imports_and_assets"))

    def test_missing_tauri_resource_blocks(self):
        paths = self.minimal()
        paths["src-tauri/tauri.conf.json"] = mod.json_bytes({"version": "1.7.1", "bundle": {"resources": ["../missing.pak"]}})
        self.assertTrue(self.failed(paths, "tauri_resources_or_locked_dependencies"))

    def test_secret_pattern_detected(self):
        paths = self.minimal()
        paths["src/test.ts"] = ("ghp_" + "A" * 36).encode()
        self.assertTrue(self.failed(paths, "high_confidence_secret_patterns"))

    def test_unreviewed_art_blocked_even_without_manifest_entry(self):
        paths = self.minimal()
        paths["theme-resources/sources/example.png"] = b"test bytes"
        self.assertTrue(self.failed(paths, "rights_audit"))

    def test_approval_requires_evidence_and_matching_hash(self):
        paths = self.minimal()
        target = "theme-resources/sources/example.png"
        paths[target] = b"synthetic original test art"
        item = {"path": target, "sha256": mod.sha(paths[target]), "status": "replaced-original"}
        paths["scripts/public-source-audit.json"] = mod.json_bytes({"schemaVersion": 1, "items": [item]})
        self.assertTrue(self.failed(paths, "rights_audit"))
        paths["theme-resources/licenses/test-origin.md"] = b"Synthetic evidence for a synthetic-only fixture."
        item.update({"reviewer": "fixture", "reviewDate": "2026-11-12", "license": "MIT", "reason": "Test-only synthetic fixture", "evidence": ["theme-resources/licenses/test-origin.md"]})
        paths["scripts/public-source-audit.json"] = mod.json_bytes({"schemaVersion": 1, "items": [item]})
        self.assertFalse(self.failed(paths, "rights_audit"))
        paths[target] += b" changed"
        self.assertTrue(self.failed(paths, "rights_audit"))

    def test_git_blob_export_ignores_archive_substitutions(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "config", "core.autocrlf", "false"], check=True)
            (root / "src").mkdir()
            content = b"$Format:%H$\nexact source bytes\n"
            (root / "src/test.ts").write_bytes(content)
            (root / ".gitattributes").write_text("src/test.ts export-ignore export-subst\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(root), "add", "."], check=True)
            subprocess.run(["git", "-C", str(root), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "synthetic fixture"], check=True)
            paths, _, _, _, _, _ = mod.read_source(root, "HEAD", False)
            self.assertEqual(paths["src/test.ts"], content)

    def test_working_tree_cannot_publish(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError, "WorkingTree requires ReviewOnly"):
                mod.export(temp, Path(temp) / "output", working_tree=True)

    def test_existing_directory_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError, "new directory"):
                mod.export(temp, temp)


if __name__ == "__main__":
    unittest.main()
