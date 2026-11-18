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

    def current_owner_decision_fixture(self):
        paths, target, _ = self.owner_decision_fixture()
        for name in ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"]:
            paths[name] = paths[name].replace(b"1.7.1", b"1.7.2")
        audit = json.loads(paths["scripts/public-source-audit.json"])
        item = audit["items"][0]
        original = {k: v for k, v in item.items() if k != "releaseDecision"}
        scope = {"decisionId": mod.OWNER_RELEASE_172_DECISION_ID, "version": "1.7.2", "items": [original]}
        evidence = b"Synthetic release direction; not an owner rights acknowledgement.\n```json\n" + mod.json_bytes(scope) + b"```\n"
        evidence_hash = mod.sha(evidence)
        paths[mod.OWNER_RELEASE_172_EVIDENCE_PATH] = evidence
        item["releaseDecision"] = {"type": "owner-directed-publication", "decisionId": mod.OWNER_RELEASE_172_DECISION_ID,
            "version": "1.7.2", "sha256": item["sha256"],
            "evidence": [{"path": mod.OWNER_RELEASE_172_EVIDENCE_PATH, "sha256": evidence_hash}],
            "retainsUnverifiedDisclosures": True}
        paths["scripts/public-source-audit.json"] = mod.json_bytes(audit)
        return paths, target, evidence_hash

    def inspect_current_owner_fixture(self, paths, evidence_hash):
        with mock.patch.object(mod, "OWNER_RELEASE_172_SCOPE_COUNT", 1), mock.patch.object(mod, "OWNER_RELEASE_172_EVIDENCE_SHA256", evidence_hash):
            return mod.inspect(paths, [])

    def test_current_direction_preserves_disclosures_without_inventing_owner_acknowledgement(self):
        paths, target, evidence_hash = self.current_owner_decision_fixture()
        version, checks, findings, disclosures = self.inspect_current_owner_fixture(paths, evidence_hash)
        self.assertEqual(version, "1.7.2")
        self.assertTrue(all(x["ok"] for x in checks))
        self.assertEqual(findings, [])
        self.assertEqual(disclosures[0]["status"], "unverified-third-party-artwork")
        self.assertEqual(disclosures[0]["path"], target)
        self.assertTrue(disclosures[0]["releaseDecision"]["retainsUnverifiedDisclosures"])
        self.assertNotIn("acknowledgesUnverifiedRights", disclosures[0]["releaseDecision"])

    def test_current_direction_rejects_changed_assets_future_versions_or_forged_acknowledgement(self):
        cases = ["changed-asset", "changed-hash", "missing-evidence", "changed-evidence", "missing-disclosure-flag",
                 "false-disclosure-flag", "invented-acknowledgement", "missing-asset", "missing-audit", "new-asset",
                 "changed-reason", "cleared-status", "old-decision", "future-version", "future-decision"]
        for case in cases:
            with self.subTest(case=case):
                paths, target, evidence_hash = self.current_owner_decision_fixture()
                audit = json.loads(paths["scripts/public-source-audit.json"])
                item = audit["items"][0]
                if case == "changed-asset": paths[target] += b"changed"
                elif case == "changed-hash":
                    paths[target] += b"changed"
                    item["sha256"] = mod.sha(paths[target])
                    item["releaseDecision"]["sha256"] = item["sha256"]
                elif case == "missing-evidence": del paths[mod.OWNER_RELEASE_172_EVIDENCE_PATH]
                elif case == "changed-evidence": paths[mod.OWNER_RELEASE_172_EVIDENCE_PATH] += b"changed"
                elif case == "missing-disclosure-flag": del item["releaseDecision"]["retainsUnverifiedDisclosures"]
                elif case == "false-disclosure-flag": item["releaseDecision"]["retainsUnverifiedDisclosures"] = False
                elif case == "invented-acknowledgement": item["releaseDecision"]["acknowledgesUnverifiedRights"] = True
                elif case == "missing-asset": del paths[target]
                elif case == "missing-audit": audit["items"] = []
                elif case == "new-asset": paths["theme-resources/sources/new.png"] = b"outside release scope"
                elif case == "changed-reason": item["reason"] = "invented new permission"
                elif case == "cleared-status": item["status"] = "cleared"
                elif case == "old-decision": item["releaseDecision"]["version"] = "1.7.1"
                elif case == "future-decision": item["releaseDecision"]["version"] = "1.7.3"
                elif case == "future-version":
                    for name in ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"]:
                        paths[name] = paths[name].replace(b"1.7.2", b"1.7.3")
                paths["scripts/public-source-audit.json"] = mod.json_bytes(audit)
                _, checks, findings, _ = self.inspect_current_owner_fixture(paths, evidence_hash)
                self.assertTrue(any(not x["ok"] for x in checks), case)
                if case not in {"missing-asset", "missing-audit"}: self.assertTrue(findings, case)

    def test_current_direction_export_remains_release_ready_with_unresolved_disclosures(self):
        paths, target, evidence_hash = self.current_owner_decision_fixture()
        for source in mod.REPLACEMENTS.values(): paths[source] = b"Synthetic public build documentation"
        with tempfile.TemporaryDirectory() as temp:
            with mock.patch.object(mod, "OWNER_RELEASE_172_SCOPE_COUNT", 1), mock.patch.object(mod, "OWNER_RELEASE_172_EVIDENCE_SHA256", evidence_hash):
                with mock.patch.object(mod, "read_source", return_value=(paths, [], [], {}, "a" * 40, "b" * 40)):
                    result = mod.export(temp, Path(temp) / "out")
            report = json.loads(Path(result["ReportPath"]).read_bytes())
            self.assertTrue(result["ReleaseReady"])
            self.assertEqual(report["version"], "1.7.2")
            self.assertEqual(report["rightsFindings"], [])
            self.assertEqual(report["rightsDisclosures"][0]["path"], target)
            self.assertNotIn("acknowledgesUnverifiedRights", report["rightsDisclosures"][0]["releaseDecision"])

    def test_real_current_direction_is_pinned_and_preserves_exact_previous_unresolved_scope(self):
        root = Path(__file__).resolve().parent.parent
        old_doc = (root / mod.OWNER_RELEASE_EVIDENCE_PATH).read_bytes()
        new_doc = (root / mod.OWNER_RELEASE_172_EVIDENCE_PATH).read_bytes()
        self.assertEqual(mod.sha(new_doc), mod.OWNER_RELEASE_172_EVIDENCE_SHA256)
        old_scope, old_issues = mod.owner_release_scope({mod.OWNER_RELEASE_EVIDENCE_PATH: old_doc})
        scope, issues = mod.owner_release_scope({mod.OWNER_RELEASE_172_EVIDENCE_PATH: new_doc}, "1.7.2")
        self.assertEqual(old_issues + issues, [])
        self.assertEqual(scope, old_scope)
        audit = json.loads((root / "scripts/public-source-audit.json").read_bytes())
        self.assertEqual(set(scope), {item["path"] for item in audit["items"]})
        for item in audit["items"]:
            self.assertEqual({k: v for k, v in item.items() if k != "releaseDecision"}, scope[item["path"]])
            self.assertEqual(mod.sha((root / item["path"]).read_bytes()), item["sha256"])
            self.assertEqual(item["releaseDecision"]["version"], "1.7.2")
            self.assertNotIn("acknowledgesUnverifiedRights", item["releaseDecision"])
        self.assertIsNone(mod.owner_release_record("1.7.3"))
        self.assertIsNone(mod.owner_release_record("2.0.0"))

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

    def test_operator_endpoints_are_rejected_without_reporting_values(self):
        paths = self.minimal()
        domain = "api." + "gaogeaii" + ".com"
        paths["src/endpoint.ts"] = ('export const url = "https://' + domain + '/v1"').encode()
        findings = mod.operator_deployment_issues(paths)
        self.assertEqual(findings, ["src/endpoint.ts -> operator production domain"])
        self.assertNotIn(domain, " ".join(findings))
        _, checks, _, _ = mod.inspect(paths, [])
        self.assertFalse(next(x for x in checks if x["name"] == "operator_deployment_information")["ok"])

    def test_operator_contact_assets_block_even_when_unreferenced(self):
        for filename in ("contact-wechat-qr.png", "contact-qq-qr.png", "contact-qq-group-qr.png"):
            paths = self.minimal()
            paths["src/assets/" + filename] = b"\x89PNG\x00\xff"
            self.assertTrue(mod.operator_deployment_issues(paths))

    def test_generic_and_license_endpoints_remain_valid(self):
        paths = {"src/config.ts": b'const example = "https://relay.example.invalid/v1";',
                 "NOTICE.md": b'https://www.gnu.org/licenses/agpl-3.0.en.html',
                 "README.md": b'https://github.com/example/desktop-source-archive'}
        self.assertEqual(mod.operator_deployment_issues(paths), [])

    def test_operator_privacy_failure_writes_no_review_output(self):
        paths = self.minimal()
        paths["src/endpoint.ts"] = ('const url = "https://api.' + "gaogeaii" + '.com/v1"').encode()
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "review"
            modes = {name: 0o644 for name in paths}
            for target, source in mod.REPLACEMENTS.items():
                paths[source] = b"generic build instructions"
                modes[source] = 0o644
            with mock.patch.object(mod, "read_source", return_value=(paths, [], [], modes, "a" * 40, "b" * 40)):
                with self.assertRaises(ValueError):
                    mod.export(Path(temporary), output, working_tree=True, review_only=True)
            self.assertFalse(output.exists())

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

    def test_development_snapshot_requires_immutable_commit_and_exclusive_mode(self):
        cases = [dict(ref="HEAD"), dict(ref="main"), dict(ref="a" * 40, working_tree=True),
                 dict(ref="a" * 40, review_only=True)]
        for options in cases:
            with self.subTest(options=options), tempfile.TemporaryDirectory() as temp:
                output = Path(temp) / "development"
                with mock.patch.object(mod, "read_source") as reader:
                    with self.assertRaisesRegex(ValueError, "DevelopmentSnapshot"):
                        mod.export(temp, output, development_snapshot=True, **options)
                    reader.assert_not_called()
                self.assertFalse(output.exists())

    def test_development_snapshot_is_explicitly_unreleased_and_not_release_ready(self):
        paths = self.minimal()
        for source in mod.REPLACEMENTS.values():
            paths[source] = b"Synthetic public build documentation"
        original_package = paths["package.json"]
        with tempfile.TemporaryDirectory() as temp:
            with mock.patch.object(mod, "read_source", return_value=(paths, [], [], {}, "a" * 40, "b" * 40)):
                result = mod.export(temp, Path(temp) / "development", ref="a" * 40, development_snapshot=True)
            report = json.loads(Path(result["ReportPath"]).read_bytes())
            manifest = json.loads(Path(result["ManifestPath"]).read_bytes())
            self.assertFalse(result["ReleaseReady"])
            self.assertFalse(report["releaseReady"])
            self.assertEqual(report["publicationKind"], "development-snapshot")
            self.assertEqual(manifest["publicationKind"], "development-snapshot")
            self.assertEqual(report["sourceMode"], "git-ref")
            self.assertEqual(report["version"], "1.7.1")
            self.assertIn("Not the corresponding source", report["sourceStatus"])
            exported = Path(result["SourceDirectory"])
            self.assertEqual((exported / "package.json").read_bytes(), original_package)
            self.assertIn("Unreleased development snapshot", (exported / "DEVELOPMENT_SNAPSHOT.md").read_text())
            self.assertTrue(any(x["path"] == "DEVELOPMENT_SNAPSHOT.md" for x in manifest["files"]))
            self.assertEqual([x["name"] for x in report["checks"] if not x["ok"]], ["publication_mode"])

    def test_development_snapshot_rejects_resolved_revision_mismatch(self):
        with tempfile.TemporaryDirectory() as temp:
            with mock.patch.object(mod, "read_source", return_value=({}, [], [], {}, "b" * 40, "c" * 40)):
                with self.assertRaisesRegex(ValueError, "differs"):
                    mod.export(temp, Path(temp) / "development", ref="a" * 40, development_snapshot=True)

    def test_development_snapshot_does_not_reuse_historical_rights_decision(self):
        paths, target, evidence_hash = self.owner_decision_fixture()
        for source in mod.REPLACEMENTS.values():
            paths[source] = b"Synthetic public build documentation"
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "development"
            with mock.patch.object(mod, "OWNER_RELEASE_SCOPE_COUNT", 1), mock.patch.object(mod, "OWNER_RELEASE_EVIDENCE_SHA256", evidence_hash):
                with mock.patch.object(mod, "read_source", return_value=(paths, [], [], {}, "a" * 40, "b" * 40)):
                    with self.assertRaisesRegex(ValueError, "development_snapshot_rights"):
                        mod.export(temp, output, ref="a" * 40, development_snapshot=True)
            self.assertFalse(output.exists())
            self.assertEqual(len(mod.development_snapshot_rights_issues([{"path": target}])), 1)

    def test_development_snapshot_keeps_privacy_completeness_and_rights_gates(self):
        for case in ("operator-domain", "missing-source", "unreviewed-art", "secret"):
            paths = self.minimal()
            for source in mod.REPLACEMENTS.values():
                paths[source] = b"Synthetic public build documentation"
            if case == "operator-domain": paths["src/endpoint.ts"] = ("https://api." + "gaogeaii" + ".com/v1").encode()
            elif case == "missing-source": del paths["src-tauri/src/lib.rs"]
            elif case == "unreviewed-art": paths["theme-resources/sources/example.png"] = b"unreviewed"
            else: paths["src/secret.ts"] = ("ghp_" + "A" * 36).encode()
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                output = Path(temp) / "development"
                with mock.patch.object(mod, "read_source", return_value=(paths, [], [], {}, "a" * 40, "b" * 40)):
                    with self.assertRaisesRegex(ValueError, "export blocked"):
                        mod.export(temp, output, ref="a" * 40, development_snapshot=True)
                self.assertFalse(output.exists())


    def privacy_fixture(self, temporary):
        paths, target, evidence_hash = self.owner_decision_fixture()
        for source in mod.REPLACEMENTS.values():
            paths[source] = b"Synthetic public build documentation"
        baseline = Path(temporary) / "baseline"
        with mock.patch.object(mod, "OWNER_RELEASE_SCOPE_COUNT", 1), mock.patch.object(mod, "OWNER_RELEASE_EVIDENCE_SHA256", evidence_hash):
            with mock.patch.object(mod, "read_source", return_value=(dict(paths), [], [], {}, "a" * 40, "b" * 40)):
                mod.export(temporary, baseline)
        files = {p.relative_to(baseline).as_posix(): p.read_bytes() for p in baseline.rglob("*") if p.is_file()}
        disclosures = json.loads(files["SOURCE_EXPORT_REPORT.json"])["rightsDisclosures"]
        return paths, target, evidence_hash, baseline, files, disclosures

    @contextlib.contextmanager
    def privacy_pins(self, evidence_hash, files):
        with mock.patch.object(mod, "OWNER_RELEASE_SCOPE_COUNT", 1), mock.patch.object(mod, "OWNER_RELEASE_EVIDENCE_SHA256", evidence_hash):
            with mock.patch.object(mod, "PRIVACY_BASELINE_PUBLIC_TREE", mod.snapshot_git_tree(files)):
                yield

    def test_privacy_baseline_identity_is_explicit_and_fixed(self):
        self.assertEqual(mod.OWNER_RELEASE_SCOPE_COUNT, 50)
        self.assertEqual(mod.OWNER_RELEASE_VERSION, "1.7.1")
        self.assertEqual(mod.PRIVACY_BASELINE_REPOSITORY, "KKK-898/desktop-source-archive")
        self.assertEqual(mod.PRIVACY_BASELINE_COMMIT, "51a064abd7337920435ee5939c00ba83a9277f06")
        self.assertEqual(mod.PRIVACY_BASELINE_PUBLIC_TREE, "c66afb8d71fc36372cd644d36fffb310b82f8de6")

    def test_snapshot_git_tree_matches_git_for_nested_and_non_ascii_paths(self):
        paths = {"a/b.txt": b"nested\n", "a.c": b"file\n", "aa/z": b"\0binary", "z": b"last", "unicode/\u00e9.txt": b"accent"}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, data in paths.items():
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_bytes(data)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "config", "core.autocrlf", "false"], check=True)
            subprocess.run(["git", "-C", str(root), "add", "."], check=True)
            expected = subprocess.check_output(["git", "-C", str(root), "write-tree"], text=True).strip()
            self.assertEqual(mod.snapshot_git_tree(paths), expected)
        for paths in ({"a": b"", "a/b": b""}, {"A": b"", "a": b""}, {"../bad": b""}):
            with self.assertRaisesRegex(ValueError, "snapshot tree paths"):
                mod.snapshot_git_tree(paths)

    def test_privacy_maintenance_requires_baseline_immutable_commit_and_exclusive_mode(self):
        cases = [dict(ref="HEAD"), dict(ref="main"), dict(ref="a" * 40, working_tree=True),
                 dict(ref="a" * 40, review_only=True), dict(ref="a" * 40, development_snapshot=True),
                 dict(ref="a" * 40, privacy_maintenance_baseline_path=""),
                 dict(ref="a" * 40, privacy_maintenance_baseline_path="  ")]
        for options in cases:
            arguments = {"privacy_maintenance_baseline_path": "baseline", **options}
            with self.subTest(options=options), tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary) / "out"
                with mock.patch.object(mod, "read_source") as reader:
                    with self.assertRaisesRegex(ValueError, "PrivacyMaintenance"):
                        mod.export(temporary, output, **arguments)
                    reader.assert_not_called()
                self.assertFalse(output.exists())
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.object(mod, "read_source", return_value=({}, [], [], {}, "b" * 40, "c" * 40)):
                with self.assertRaisesRegex(ValueError, "differs"):
                    mod.export(temporary, Path(temporary) / "out", ref="a" * 40, privacy_maintenance_baseline_path="baseline")

    def test_privacy_maintenance_is_unreleased_and_preserves_historical_disclosures(self):
        with tempfile.TemporaryDirectory() as temporary:
            paths, target, evidence_hash, baseline, files, disclosures = self.privacy_fixture(temporary)
            original_package = paths["package.json"]
            with self.privacy_pins(evidence_hash, files):
                with mock.patch.object(mod, "read_source", return_value=(dict(paths), [], [], {}, "c" * 40, "d" * 40)):
                    result = mod.export(temporary, Path(temporary) / "out", ref="c" * 40, privacy_maintenance_baseline_path=baseline)
            output = Path(result["SourceDirectory"])
            report = json.loads(Path(result["ReportPath"]).read_bytes())
            manifest = json.loads(Path(result["ManifestPath"]).read_bytes())
            self.assertFalse(result["ReleaseReady"])
            self.assertFalse(report["releaseReady"])
            self.assertEqual(result["PublicationKind"], "privacy-maintenance")
            self.assertEqual(report["publicationKind"], manifest["publicationKind"])
            self.assertEqual(report["publicationKind"], "privacy-maintenance")
            self.assertEqual(report["maintenanceBaseline"], manifest["maintenanceBaseline"])
            self.assertEqual(report["maintenanceBaseline"]["publicCommit"], mod.PRIVACY_BASELINE_COMMIT)
            self.assertEqual(report["maintenanceBaseline"]["publicTree"], mod.snapshot_git_tree(files))
            self.assertEqual(report["rightsDisclosures"], disclosures)
            self.assertEqual(report["version"], "1.7.1")
            self.assertEqual(report["sourceMode"], "git-ref")
            self.assertIn("not a new version", report["sourceStatus"])
            self.assertEqual((output / "package.json").read_bytes(), original_package)
            self.assertEqual((output / target).read_bytes(), files[target])
            self.assertEqual((output / mod.OWNER_RELEASE_EVIDENCE_PATH).read_bytes(), files[mod.OWNER_RELEASE_EVIDENCE_PATH])
            self.assertIn("not a new rights license or legal clearance", (output / "PRIVACY_MAINTENANCE.md").read_text())
            self.assertTrue(any(item["path"] == "PRIVACY_MAINTENANCE.md" for item in manifest["files"]))
            self.assertEqual([item["name"] for item in report["checks"] if not item["ok"]], ["publication_mode"])

    def test_privacy_baseline_rejects_arbitrary_directory_before_self_reported_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            paths, target, evidence_hash, baseline, files, disclosures = self.privacy_fixture(temporary)
            with mock.patch.object(mod, "OWNER_RELEASE_SCOPE_COUNT", 1), mock.patch.object(mod, "OWNER_RELEASE_EVIDENCE_SHA256", evidence_hash):
                with self.assertRaisesRegex(ValueError, "public Git tree"):
                    mod.privacy_maintenance_baseline(baseline, paths, "1.7.1", disclosures)
            with self.privacy_pins(evidence_hash, files):
                (baseline / target).write_bytes(b"tampered baseline")
                with self.assertRaisesRegex(ValueError, "public Git tree"):
                    mod.privacy_maintenance_baseline(baseline, paths, "1.7.1", disclosures)

    def test_privacy_baseline_rejects_extra_files_directories_and_missing_paths(self):
        for case in ("extra-file", "empty-directory", "missing-file", "missing-root", "file-root"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                paths, target, evidence_hash, baseline, files, disclosures = self.privacy_fixture(temporary)
                with self.privacy_pins(evidence_hash, files):
                    if case == "extra-file": (baseline / "unexpected.txt").write_bytes(b"extra")
                    elif case == "empty-directory": (baseline / "empty-directory").mkdir()
                    elif case == "missing-file": (baseline / target).unlink()
                    elif case == "missing-root": baseline = Path(temporary) / "does-not-exist"
                    else: baseline = baseline / "package.json"
                    with self.assertRaises(ValueError):
                        mod.privacy_maintenance_baseline(baseline, paths, "1.7.1", disclosures)

    def test_privacy_baseline_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            paths, target, evidence_hash, baseline, files, disclosures = self.privacy_fixture(temporary)
            try:
                (baseline / "symlink.txt").symlink_to(baseline / "package.json")
            except (OSError, NotImplementedError):
                self.skipTest("Creating symlinks is not enabled on this host")
            with self.privacy_pins(evidence_hash, files):
                with self.assertRaisesRegex(ValueError, "symlinks/junctions forbidden"):
                    mod.privacy_maintenance_baseline(baseline, paths, "1.7.1", disclosures)

    def test_privacy_baseline_metadata_is_checked_beyond_public_tree_pin(self):
        cases = ("manifest-hash", "manifest-size", "manifest-duplicate", "manifest-path", "digest", "schema", "source-id", "source-id-type",
                 "mismatched-source", "kind", "not-ready", "mode", "checks", "findings", "unlisted-file", "invalid-json", "array-metadata")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                paths, target, evidence_hash, baseline, files, disclosures = self.privacy_fixture(temporary)
                manifest = json.loads(files["SOURCE_MANIFEST.json"])
                report = json.loads(files["SOURCE_EXPORT_REPORT.json"])
                if case == "manifest-hash": manifest["files"][0]["sha256"] = "0" * 64
                elif case == "manifest-size": manifest["files"][0]["size"] += 1
                elif case == "manifest-duplicate": manifest["files"].append(manifest["files"][0])
                elif case == "manifest-path": manifest["files"][0]["path"] = 123
                elif case == "digest": report["filesDigest"] = "0" * 64
                elif case == "schema": report["schemaVersion"] = 2
                elif case == "source-id": report["sourceCommit"] = "not-a-hash"
                elif case == "source-id-type": report["sourceCommit"] = None
                elif case == "mismatched-source": report["sourceCommit"] = "d" * 40
                elif case == "kind": report["publicationKind"] = "privacy-maintenance"
                elif case == "not-ready": report["releaseReady"] = False
                elif case == "mode": report["sourceMode"] = "working-tree"
                elif case == "checks": report["checks"][0]["ok"] = False
                elif case == "findings": report["rightsFindings"] = [{"path": target}]
                elif case == "unlisted-file": files["unlisted.txt"] = b"extra"
                elif case == "array-metadata": report = []
                files["SOURCE_MANIFEST.json"] = mod.json_bytes(manifest)
                files["SOURCE_EXPORT_REPORT.json"] = b"{invalid" if case == "invalid-json" else mod.json_bytes(report)
                for name, data in files.items(): (baseline / name).write_bytes(data)
                # Re-pin this synthetic fixture to reach the independent metadata checks.
                with self.privacy_pins(evidence_hash, files):
                    with self.assertRaises(ValueError):
                        mod.privacy_maintenance_baseline(baseline, paths, "1.7.1", disclosures)

    def test_privacy_maintenance_does_not_extend_rights_scope_or_change_preserved_bytes(self):
        cases = ("next-version", "missing-disclosure", "changed-disclosure", "duplicate-disclosure", "asset", "audit", "evidence", "license", "notice", "provenance")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                paths, target, evidence_hash, baseline, files, disclosures = self.privacy_fixture(temporary)
                version = "1.7.1"
                if case == "next-version": version = "1.7.2"
                elif case == "missing-disclosure": disclosures.clear()
                elif case == "changed-disclosure": disclosures[0]["reason"] = "changed"
                elif case == "duplicate-disclosure": disclosures.append(disclosures[0])
                else:
                    name = {"asset": target, "audit": "scripts/public-source-audit.json", "evidence": mod.OWNER_RELEASE_EVIDENCE_PATH,
                            "license": "LICENSE", "notice": "NOTICE.md", "provenance": "theme-resources/licenses/synthetic.md"}[case]
                    paths[name] += b"changed"
                with self.privacy_pins(evidence_hash, files):
                    with self.assertRaisesRegex(ValueError, "PrivacyMaintenance baseline blocked"):
                        mod.privacy_maintenance_baseline(baseline, paths, version, disclosures)

    def test_privacy_maintenance_keeps_privacy_completeness_and_rights_gates(self):
        for case in ("operator-domain", "missing-source", "unreviewed-art", "secret"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                paths, target, evidence_hash, baseline, files, disclosures = self.privacy_fixture(temporary)
                if case == "operator-domain": paths["src/endpoint.ts"] = ("https://api." + "gaogeaii" + ".com/v1").encode()
                elif case == "missing-source": del paths["src-tauri/src/lib.rs"]
                elif case == "unreviewed-art": paths["theme-resources/sources/example.png"] = b"unreviewed"
                else: paths["src/secret.ts"] = ("ghp_" + "A" * 36).encode()
                output = Path(temporary) / "out"
                with self.privacy_pins(evidence_hash, files):
                    with mock.patch.object(mod, "read_source", return_value=(paths, [], [], {}, "c" * 40, "d" * 40)):
                        with self.assertRaisesRegex(ValueError, "export blocked"):
                            mod.export(temporary, output, ref="c" * 40, privacy_maintenance_baseline_path=baseline)
                self.assertFalse(output.exists())

    def test_existing_directory_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError, "new directory"):
                mod.export(temp, temp)


if __name__ == "__main__":
    unittest.main()
