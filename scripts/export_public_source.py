#!/usr/bin/env python3
"""Export a reviewed source snapshot. Does not publish, sign or contact a server."""
from __future__ import annotations
import argparse
import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import unicodedata
import zipfile

METADATA = {"SOURCE_MANIFEST.json", "SOURCE_EXPORT_REPORT.json", "DEVELOPMENT_SNAPSHOT.md", "PRIVACY_MAINTENANCE.md"}
ALLOWED_ROOT_FILES = {"AGENTS.md", "LICENSE", "NOTICE.md", "THIRD_PARTY_NOTICES.md", "README.md", ".gitignore", ".gitattributes", ".release.local.example.json", "package.json", "package-lock.json", "index.html", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "vite.config.ts"}
SOURCE_ROOTS = {".github", "src", "src-tauri", "scripts", "public", "resources", "theme-resources", "mobile-bridge"}
REPLACEMENTS = {
    "docs/cross-platform-release.md": "scripts/public-source-docs/cross-platform-release.md",
    "docs/remote-updates.md": "scripts/public-source-docs/remote-updates.md",
    "docs/release-1.7.1.md": "scripts/public-source-docs/release-1.7.1.md",
    "scripts/publish-update.ps1": "scripts/public-source-docs/publish-update.ps1",
}
# Operator-only entry points. Not used by desktop builds or the mobile runtime.
# Their complete service/runtime sources, templates and packaging remain public.
PRIVATE_OPERATIONAL_SCRIPTS = {"scripts/deploy-mobile-relay.py", "scripts/deploy-mobile-components.py"}
KEEP_DOCS = {"docs/public-release-workflow.md", "docs/login-company-logo-sources.md", "docs/login-university-logo-sources.md", "docs/login-university-logo-sources-extra.md"}
REQUIRED = ["LICENSE", "NOTICE.md", "THIRD_PARTY_NOTICES.md", "README.md", "package.json", "package-lock.json", "index.html", "vite.config.ts", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/build.rs", "src-tauri/tauri.conf.json", "src-tauri/src/lib.rs", "scripts/export_public_source.py", "scripts/export-public-source.ps1", "scripts/public-source-audit.json", "scripts/public-source-docs/source-delivery.md", "src-tauri/src/third_party/codex-plus-plus/LICENSE", "src-tauri/src/third_party/codex-plus-plus/NOTICE.md", "docs/cross-platform-release.md", "docs/remote-updates.md"]
# These floors cannot be disabled merely by removing an audit-list entry.
RIGHTS_PATTERNS = ["resources/codex-locales/*", "theme-resources/sources/*", "theme-resources/vendor/codex-qq-2007-assets/*", "src/assets/customer-logos/*", "src/assets/provider-logos/*", "scripts/fixtures/codex-ultra-query-*.js", "scripts/fixtures/codex-aggregate-selection-26.1103.js", "scripts/fixtures/codex-model-filter-26.1007.js", "scripts/fixtures/codex-model-filter-26.901.js", "scripts/fixtures/codex-service-tier-gate-26.915.js", "scripts/codex-plugin-patch.cjs"]


# The existing public example has been reviewed as placeholder-only. Content changes
# invalidate this exception; names containing "example" never receive a general bypass.
# Normalize CRLF only for this review fingerprint; exported bytes remain untouched.
REVIEWED_PUBLIC_TEMPLATES = {
    ".release.local.example.json": "c14fcb0fc2d0d4dbe95ee5adc554ad06f1104a6425c96c53cb42df7c0ee9ec63",
}
SOURCE_MODULE_SUFFIXES = {".py", ".rs", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".vue", ".css", ".scss"}
SENSITIVE_STEMS = {"auth", "credential", "credentials", "secret", "secrets", "token", "tokens"}

# Do not silently rewrite runtime sources while exporting. Reject deployment
# information here; the same neutral source must feed public and private builds.
# Construct suffixes so this guard is itself safe to distribute.
OPERATOR_DOMAIN_SUFFIXES = tuple(
    label + "." + suffix
    for label, suffixes in (("gaogeaii", ("com", "cc")), ("gaogeai", ("com", "cloud")))
    for suffix in suffixes
)
OPERATOR_DOMAIN_PATTERN = re.compile(
    r"(?i)(?<![a-z0-9_-])(?:[a-z0-9_-]+\.)*(?:"
    + "|".join(re.escape(value) for value in OPERATOR_DOMAIN_SUFFIXES)
    + r")(?![a-z0-9_.-])"
)
PRIVATE_CONTACT_ASSETS = {
    "contact-wechat-qr", "contact-qq-qr", "contact-qq-group-qr",
}


def operator_deployment_issues(paths):
    """Return file/type findings without logging endpoint or credential values."""
    issues = []
    for path, data in paths.items():
        if PurePosixPath(path).stem.lower() in PRIVATE_CONTACT_ASSETS:
            issues.append(path + " -> bundled operator contact asset")
        content = text(data)
        if content is not None and OPERATOR_DOMAIN_PATTERN.search(content):
            issues.append(path + " -> operator production domain")
    return sorted(set(issues))


OWNER_RELEASE_DECISION_ID = "gaoge-1.7.1-2026-11-12"
OWNER_RELEASE_VERSION = "1.7.1"
OWNER_RELEASE_EVIDENCE_PATH = "scripts/public-source-docs/owner-release-decision-1.7.1.md"
OWNER_RELEASE_EVIDENCE_SHA256 = "a95d09b14f963a65fe2a07e6cd3929a85c83a10185fc7afda4538f2b94f05704"
OWNER_RELEASE_SCOPE_COUNT = 50


def owner_release_scope(paths):
    data = paths.get(OWNER_RELEASE_EVIDENCE_PATH)
    if data is None or sha(data) != OWNER_RELEASE_EVIDENCE_SHA256:
        return {}, ["Owner release decision evidence missing or changed"]
    blocks = re.findall(r"```json\s*\n(.*?)\n```", text(data) or "", re.S)
    try:
        scope = json.loads(blocks[0]) if len(blocks) == 1 else {}
    except json.JSONDecodeError:
        scope = {}
    items = scope.get("items", [])
    if (scope.get("decisionId") != OWNER_RELEASE_DECISION_ID or scope.get("version") != OWNER_RELEASE_VERSION
            or not isinstance(items, list) or len(items) != OWNER_RELEASE_SCOPE_COUNT
            or any(not isinstance(i, dict) or not isinstance(i.get("path"), str) for i in items)
            or len({i["path"] for i in items}) != OWNER_RELEASE_SCOPE_COUNT):
        return {}, ["Owner release decision scope is invalid"]
    return {i["path"]: i for i in items}, []


def owner_release_decision_issues(path, item, paths, version, scope):
    issues = []
    original = scope.get(path)
    if original is None:
        return ["File is outside the explicit owner release decision scope"]
    if {k: v for k, v in item.items() if k != "releaseDecision"} != original:
        issues.append("Owner release decision must preserve the original unresolved audit fields")
    actual = sha(paths[path])
    expected = {"type": "owner-directed-publication", "decisionId": OWNER_RELEASE_DECISION_ID,
                "version": OWNER_RELEASE_VERSION, "sha256": actual,
                "evidence": [{"path": OWNER_RELEASE_EVIDENCE_PATH, "sha256": OWNER_RELEASE_EVIDENCE_SHA256}],
                "acknowledgesUnverifiedRights": True}
    if item.get("releaseDecision") != expected or item.get("releaseDecision", {}).get("acknowledgesUnverifiedRights") is not True:
        issues.append("Owner release decision fields, version, asset hash or evidence binding are invalid")
    if version != OWNER_RELEASE_VERSION:
        issues.append("Owner release decision does not apply to this release version")
    if item.get("sha256") != actual:
        issues.append("Owner release decision asset hash changed")
    if any(e not in paths for e in original.get("evidence", [])):
        issues.append("Original provenance evidence must remain in the snapshot")
    return issues


def portable_path(path):
    if not isinstance(path, str) or not path or re.search(r'[\\\x00-\x1f\x7f<>:"|?*]', path):
        raise ValueError("Unsafe source path: " + repr(path))
    parts = path.split("/")
    if any(not part or part in {".", ".."} or part.lower() == ".git" or part.endswith((".", " "))
           or re.match(r"^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)", part, re.I)
           for part in parts):
        raise ValueError("Unsafe source path: " + path)
    return path


def portable_source_issues(paths):
    issues, seen = [], {}
    for path in sorted(paths):
        try:
            portable_path(path)
        except ValueError as error:
            issues.append(str(error)); continue
        parts = path.split("/")
        for end in range(1, len(parts) + 1):
            entry = "/".join(parts[:end])
            kind = "file" if end == len(parts) else "directory"
            key = unicodedata.normalize("NFC", entry).casefold()
            prior = seen.get(key)
            if prior is not None and prior != (entry, kind):
                issues.append("Portable source path collision: " + prior[0] + " <-> " + entry)
            else:
                seen[key] = (entry, kind)
    return sorted(set(issues))


def sensitive_path_reason(path):
    parts = PurePosixPath(path).parts
    lower = [part.lower() for part in parts]
    if any(part in {".ssh", ".aws", ".gnupg", ".azure", ".kube"} for part in lower):
        return "private credential directory"
    for index, name in enumerate(lower):
        if name.startswith(".env") or name.startswith(".release.local"):
            return "local environment or release configuration family"
        if any(name == base or name.startswith(base + suffix)
               for base in (".npmrc", ".pypirc", ".yarnrc", ".netrc", "_netrc", ".git-credentials", "pip.conf", "pip.ini", "nuget.config")
               for suffix in (".", "-", "_", "~")):
            return "registry or network credential configuration family"
        candidate = name.lstrip(".")
        if index == len(lower) - 1 and re.match(r"^(?:auth|credentials?|secrets?|tokens?)(?:$|[._~\-])", candidate):
            # auth.py and secrets.py are source modules, not account-state files.
            if not any(candidate == stem + suffix for stem in SENSITIVE_STEMS for suffix in SOURCE_MODULE_SUFFIXES):
                return "account, credential or secret data/backup family"
    if lower[-1].endswith((".local", ".log", ".pyc", ".pfx", ".p12", ".pem", ".key")):
        return "local configuration, credential or build diagnostic"
    return None


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.PIPE)


def exclusion(path):
    portable_path(path)
    p = PurePosixPath(path)
    if any(x in {".git", ".codex", ".codex-validation", "node_modules", "target", "dist", "release", "__pycache__", ".venv", ".local", ".tmp"} or x.startswith("target-") for x in p.parts):
        return "private metadata, generated output, cache or local validation"
    if path in METADATA:
        return "export metadata is regenerated"
    if path == "src-tauri/tauri-update.key.pub":
        return "private signing configuration"
    reason = sensitive_path_reason(path)
    if reason and path not in REVIEWED_PUBLIC_TEMPLATES:
        return reason
    if path.startswith("resources/codex-offline/") or re.match(r"resources/mobile-bridge/(windows|macos|linux)-", path):
        return "external installer or optional generated runtime"
    if path in PRIVATE_OPERATIONAL_SCRIPTS:
        return "private operator deployment entry point; not a build/runtime dependency"
    if path == "mobile-bridge/DEPLOYMENT.txt":
        return "private deployment record; source/build instructions retained separately"
    if path.startswith("docs/"):
        if path in REPLACEMENTS or path in KEEP_DOCS:
            return None
        return "internal operational or validation notes; not a build input"
    if path == "build/icon-source/gaoge-logo-transparent.png":
        return None
    if len(p.parts) == 1:
        return None if path in ALLOWED_ROOT_FILES else "non-build local root artifact"
    if p.parts[0] not in SOURCE_ROOTS:
        return "local tooling, preview or development-only artifact"
    return None


def read_source(root, ref, working_tree):
    commit = git(root, "rev-parse", "--verify", ref + "^{commit}").decode().strip()
    tree = git(root, "rev-parse", commit + "^{tree}").decode().strip()
    paths, excluded, invalid, modes = {}, [], [], {}
    if working_tree:
        names = sorted(set(x for x in git(root, "-c", "core.quotepath=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z").decode("utf-8").split("\0") if x))
        for name in names:
            reason = exclusion(name)
            if reason:
                excluded.append({"path": name, "reason": reason}); continue
            p = root / name
            if not p.exists():
                continue
            if p.is_symlink() or not p.is_file() or any(parent.is_symlink() or (hasattr(parent, "is_junction") and parent.is_junction()) for parent in [p, *p.parents] if parent != root.parent):
                invalid.append(name); continue
            paths[name] = p.read_bytes()
            modes[name] = 0o644
    else:
        records = git(root, "ls-tree", "-rz", "--full-tree", commit).split(b"\0")
        for record in records:
            if not record:
                continue
            meta, name = record.split(b"\t", 1)
            mode, kind, _ = meta.decode().split()
            path = name.decode("utf-8")
            if mode == "120000" or kind != "blob":
                invalid.append(path)
            modes[path] = 0o755 if mode == "100755" else 0o644
        # Read exact Git blobs: git archive can apply export-ignore/export-subst.
        objects = []
        for record in records:
            if not record:
                continue
            meta, name = record.split(b"\t", 1)
            mode, kind, oid = meta.decode().split()
            path = name.decode("utf-8")
            reason = exclusion(path)
            if reason:
                excluded.append({"path": path, "reason": reason}); continue
            if mode == "120000" or kind != "blob":
                continue
            objects.append((path, oid))
        result = subprocess.run(["git", "-C", str(root), "cat-file", "--batch"],
                                input="".join(oid + "\n" for _, oid in objects).encode(),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout
        offset = 0
        for path, oid in objects:
            line_end = result.index(b"\n", offset)
            actual_oid, kind, length = result[offset:line_end].decode().split()
            if actual_oid != oid or kind != "blob":
                raise ValueError("Unexpected Git object for " + path)
            offset = line_end + 1
            length = int(length)
            paths[path] = result[offset:offset + length]
            offset += length
            if result[offset:offset + 1] != b"\n":
                raise ValueError("Invalid Git object delimiter for " + path)
            offset += 1
    return paths, sorted(excluded, key=lambda x: x["path"]), sorted(set(invalid)), modes, commit, tree


def normalize_relative(base, relative):
    parts = list(PurePosixPath(base).parts)
    for part in PurePosixPath(relative).parts:
        if part == "..":
            if not parts:
                return None
            parts.pop()
        elif part != ".":
            parts.append(part)
    return "/".join(parts)


def text(data):
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None


def inspect(paths, invalid):
    checks = []
    def check(name, issues):
        checks.append({"name": name, "ok": not issues, "issues": sorted(set(issues))})
    check("no_symlinks_or_submodules", invalid)
    check("portable_source_paths", portable_source_issues([*paths, *METADATA]))
    sensitive = []
    for path, data in paths.items():
        if path in REVIEWED_PUBLIC_TEMPLATES:
            if sha(data.replace(b"\r\n", b"\n")) != REVIEWED_PUBLIC_TEMPLATES[path]:
                sensitive.append(path + " -> reviewed placeholder template changed")
        elif sensitive_path_reason(path):
            sensitive.append(path + " -> sensitive filename family is not publishable")
    check("sensitive_source_paths", sensitive)
    check("operator_deployment_information", operator_deployment_issues(paths))
    check("required_build_and_license_files", [p for p in REQUIRED if p not in paths])
    pkg = json.loads(paths.get("package.json", b"{}"))
    lock = json.loads(paths.get("package-lock.json", b"{}"))
    version = pkg.get("version", "")
    cargo = text(paths.get("src-tauri/Cargo.toml", b"")) or ""
    conf = json.loads(paths.get("src-tauri/tauri.conf.json", b"{}"))
    versions = re.search(r'^version\s*=\s*"([^"]+)"', cargo, re.M)
    check("matching_release_versions", [] if version and lock.get("version") == version and lock.get("packages", {}).get("", {}).get("version") == version and conf.get("version") == version and versions and versions.group(1) == version else ["package, npm lock, Cargo or Tauri version mismatch"])
    check("project_license_metadata", [] if pkg.get("license") == "AGPL-3.0-only" and lock.get("packages", {}).get("", {}).get("license") == "AGPL-3.0-only" and re.search(r'^license\s*=\s*"AGPL-3.0-only"', cargo, re.M) else ["license metadata mismatch"])
    includes, imports, resources, secret_hits = [], [], [], []
    for path, data in paths.items():
        content = text(data)
        if content is None:
            continue
        if re.search(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{40,}", content):
            secret_hits.append(path)
        if path.endswith(".rs"):
            for rel in re.findall(r'include_(?:str|bytes)!\(\s*"([^"\n]+)"\s*\)', content):
                target = normalize_relative(str(PurePosixPath(path).parent), rel)
                if not target or target not in paths:
                    includes.append(path + " -> " + rel)
        if path.startswith("src/") and path.endswith((".ts", ".js", ".vue", ".css")):
            rels = re.findall(r'''(?:from\s*|import\s*|new\s+URL\s*\(\s*)["'](\.{1,2}/[^"']+)["']''', content)
            for rel in rels:
                target = normalize_relative(str(PurePosixPath(path).parent), rel.split("?")[0])
                options = [target] + [target + x for x in [".ts", ".js", ".vue", ".json", "/index.ts", "/index.js"]] if target else []
                if not any(x in paths for x in options):
                    imports.append(path + " -> " + rel)
        if re.match(r"src-tauri/tauri(?:\.[a-z-]+)?\.conf\.json$", path):
            cfg = json.loads(content)
            bundle = cfg.get("bundle", {})
            for rel in list(bundle.get("resources", [])) + list(bundle.get("icon", [])):
                target = normalize_relative("src-tauri", rel)
                if target and target.startswith("node_modules/"):
                    mod = target[len("node_modules/"):].split("/")
                    dep = "/".join(mod[:2]) if mod[0].startswith("@") else mod[0]
                    if "node_modules/" + dep not in lock.get("packages", {}):
                        resources.append(path + " -> unpinned dependency " + dep)
                elif not target or not any(fnmatch.fnmatchcase(x, target) for x in paths):
                    resources.append(path + " -> " + rel)
    check("rust_embedded_source_inputs", includes)
    check("frontend_relative_imports_and_assets", imports)
    check("tauri_resources_or_locked_dependencies", resources)
    check("high_confidence_secret_patterns", secret_hits)
    audit = json.loads(paths.get("scripts/public-source-audit.json", b"{}"))
    entries = {}
    findings, disclosures = [], []
    if audit.get("schemaVersion") != 1:
        findings.append({"path": "scripts/public-source-audit.json", "status": "invalid-audit", "reason": "schemaVersion must be 1", "sha256": sha(paths.get("scripts/public-source-audit.json", b""))})
    for item in audit.get("items", []):
        if item.get("path") in entries:
            findings.append({"path": item["path"], "status": "duplicate-audit", "reason": "duplicate audit path", "sha256": item.get("sha256", "")})
        entries[item.get("path")] = item
    scope, scope_issues = owner_release_scope(paths) if OWNER_RELEASE_EVIDENCE_PATH in paths or any("releaseDecision" in item for item in entries.values()) else ({}, [])
    decision_active = any("releaseDecision" in item for item in entries.values()) or bool(set(scope) & set(paths))
    scope_preservation_issues = list(scope_issues) if decision_active else []
    if decision_active and scope:
        for path, original in scope.items():
            if path not in paths or path not in entries:
                scope_preservation_issues.append(path + " -> scoped asset or audit entry missing")
            elif "releaseDecision" not in entries[path]:
                scope_preservation_issues.append(path + " -> explicit per-file owner decision missing")
            else:
                scope_preservation_issues.extend(path + " -> " + issue for issue in owner_release_decision_issues(path, entries[path], paths, version, scope))
    check("owner_release_scope_preserved", scope_preservation_issues)
    required = set()
    for path, data in paths.items():
        s = text(data) or ""
        if any(fnmatch.fnmatchcase(path, p) for p in RIGHTS_PATTERNS + audit.get("requiredPatterns", [])) or (path.endswith((".js", ".cjs")) and re.search(r"(?:extracted (?:without changes|verbatim|read-only)|native callback kept byte-for-byte|captured from renderer chunk)", s, re.I)):
            required.add(path)
    for path in sorted(required | (set(entries) & set(paths))):
        item = entries.get(path, {})
        actual = sha(paths[path])
        reasons = []
        status = item.get("status", "missing-audit")
        if not item:
            reasons.append("No path-bound rights review exists")
        if item.get("sha256") != actual:
            reasons.append("Audit hash does not match source bytes")
        if status not in {"cleared", "replaced-original"}:
            reasons.append(item.get("reason", "Rights are not cleared"))
        else:
            if any(not isinstance(item.get(k), str) or not item[k].strip() for k in ["reviewer", "reviewDate", "license", "reason"]):
                reasons.append("Clearance lacks reviewer/date/license/rationale")
            evidence = item.get("evidence", [])
            if not evidence or any(not isinstance(e, str) or e not in paths for e in evidence):
                reasons.append("Clearance evidence must be present in the source snapshot")
        if "releaseDecision" in item:
            decision_issues = scope_issues + owner_release_decision_issues(path, item, paths, version, scope)
            if not decision_issues:
                # Publication direction is disclosed, never converted into legal clearance.
                disclosures.append({"path": path, "status": status, "reason": item["reason"], "sha256": actual,
                                    "releaseDecision": item["releaseDecision"]})
                continue
            reasons.extend(decision_issues)
        if reasons:
            findings.append({"path": path, "status": status, "reason": "; ".join(reasons), "sha256": actual})
    check("rights_audit", [x["path"] for x in findings])
    check("owner_release_disclosures_complete", [] if not decision_active or set(x["path"] for x in disclosures) == set(scope) and len(disclosures) == OWNER_RELEASE_SCOPE_COUNT else ["All owner-directed unresolved assets must be disclosed exactly once"])
    return version, checks, findings, disclosures


def development_snapshot_rights_issues(disclosures):
    # A historic release direction is not a general permission for a new public
    # development snapshot, even when package version and asset hashes match.
    return [item["path"] + " -> unresolved rights rely on a historical release-only owner decision"
            for item in disclosures]


# One independently verified public baseline, not the private sourceTree recorded
# inside its manifest. All 1003 public blobs use mode 100644; no mode inference.
PRIVACY_BASELINE_REPOSITORY = "KKK-898/desktop-source-archive"
PRIVACY_BASELINE_COMMIT = "51a064abd7337920435ee5939c00ba83a9277f06"
PRIVACY_BASELINE_PUBLIC_TREE = "c66afb8d71fc36372cd644d36fffb310b82f8de6"


def snapshot_git_tree(paths):
    """Recompute Git's complete public tree from exact regular-file bytes."""
    issues = portable_source_issues(paths)
    if issues:
        raise ValueError("Invalid snapshot tree paths: " + "; ".join(issues))
    tree = {}
    for name, data in paths.items():
        node = tree
        parts = portable_path(name).split("/")
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = data
    def oid(kind, data):
        return hashlib.sha1(kind + b" " + str(len(data)).encode() + b"\0" + data).digest()
    def digest(node):
        entries = []
        for name in sorted(node, key=lambda key: (key + ("/" if isinstance(node[key], dict) else "")).encode("utf-8")):
            value = node[name]
            mode, content = (b"40000", digest(value)) if isinstance(value, dict) else (b"100644", oid(b"blob", value))
            entries.append(mode + b" " + name.encode("utf-8") + b"\0" + content)
        return oid(b"tree", b"".join(entries))
    return digest(tree).hex()


def privacy_maintenance_baseline(directory, current, version, disclosures):
    """Validate a pinned, local-only, already-public baseline without exporting it."""
    def require(condition, reason):
        if not condition:
            raise ValueError("PrivacyMaintenance baseline blocked: " + reason)
    directory = Path(directory)
    require(directory.is_dir() and not directory.is_symlink()
            and not (hasattr(directory, "is_junction") and directory.is_junction()), "real snapshot directory required")
    baseline, directories, total = {}, set(), 0
    for base, folders, files in os.walk(directory, followlinks=False):
        for name in [*folders, *files]:
            entry = Path(base) / name
            relative = entry.relative_to(directory).as_posix()
            portable_path(relative)
            require(not entry.is_symlink() and not (hasattr(entry, "is_junction") and entry.is_junction()), "symlinks/junctions forbidden")
            if name in folders:
                directories.add(relative)
                continue
            require(entry.is_file() and entry.stat().st_size <= 128 * 1024 * 1024, "invalid or oversized file")
            data = entry.read_bytes()
            total += len(data)
            require(total <= 512 * 1024 * 1024 and len(baseline) < 50000, "snapshot size limit exceeded")
            baseline[relative] = data
    require(not portable_source_issues(baseline), "nonportable or colliding paths")
    expected_directories = {str(parent) for name in baseline for parent in PurePosixPath(name).parents if str(parent) != "."}
    require(directories == expected_directories, "extra or missing directory")
    require(snapshot_git_tree(baseline) == PRIVACY_BASELINE_PUBLIC_TREE, "public Git tree does not match the independently verified fixed baseline")
    manifest = json.loads(baseline.get("SOURCE_MANIFEST.json", b"{}"))
    report = json.loads(baseline.get("SOURCE_EXPORT_REPORT.json", b"{}"))
    for metadata in (manifest, report):
        require(isinstance(metadata, dict) and metadata.get("schemaVersion") == 1
                and metadata.get("version") == OWNER_RELEASE_VERSION == version, "fixed 1.7.1 metadata required")
        require(all(isinstance(metadata.get(key), str) and re.fullmatch(r"[a-f0-9]{40}", metadata[key])
                    for key in ("sourceCommit", "sourceTree")), "invalid original source identity")
        require(metadata.get("publicationKind") in (None, "release-source"), "baseline must be a release source, not maintenance/development")
    require(all(manifest[key] == report[key] for key in ("sourceCommit", "sourceTree")), "manifest/report original source identity mismatch")
    require(report.get("releaseReady") is True and report.get("sourceMode") == "git-ref", "release-ready git-ref baseline required")
    require(isinstance(report.get("checks"), list) and report["checks"]
            and all(isinstance(check, dict) and check.get("ok") is True for check in report["checks"]), "baseline checks missing or failed")
    require(report.get("rightsFindings") == [], "baseline has unresolved undisclosed findings")
    entries = manifest.get("files")
    require(isinstance(entries, list) and entries, "manifest file list required")
    seen = set()
    for entry in entries:
        require(isinstance(entry, dict) and set(entry) == {"path", "sha256", "size"}, "invalid manifest entry")
        name = portable_path(entry["path"])
        require(name not in seen and name not in {"SOURCE_MANIFEST.json", "SOURCE_EXPORT_REPORT.json"}, "duplicate or metadata manifest entry")
        seen.add(name)
        require(name in baseline and type(entry["size"]) is int and entry["size"] == len(baseline[name])
                and entry["sha256"] == sha(baseline[name]), "manifest content mismatch: " + name)
    require(set(baseline) == seen | {"SOURCE_MANIFEST.json", "SOURCE_EXPORT_REPORT.json"}, "extra or missing source files")
    require(report.get("filesDigest") == sha("".join(f'{item["sha256"]}  {item["size"]}  {item["path"]}\n' for item in entries).encode()), "filesDigest mismatch")
    prior = report.get("rightsDisclosures")
    require(isinstance(prior, list) and len(prior) == len(disclosures) == OWNER_RELEASE_SCOPE_COUNT, "exact historical disclosure count required")
    require(all(isinstance(item, dict) and isinstance(item.get("path"), str) for item in [*prior, *disclosures]), "invalid rights disclosure")
    require(len({item["path"] for item in prior}) == OWNER_RELEASE_SCOPE_COUNT
            and sorted(prior, key=lambda item: item["path"]) == sorted(disclosures, key=lambda item: item["path"]), "historical disclosure set/content changed")
    scope, issues = owner_release_scope(baseline)
    require(not issues and set(scope) == {item["path"] for item in prior}, "fixed original owner scope mismatch")
    audit_path = "scripts/public-source-audit.json"
    audit = json.loads(baseline[audit_path])
    require(isinstance(audit, dict) and isinstance(audit.get("items"), list)
            and all(isinstance(item, dict) and isinstance(item.get("path"), str) for item in audit["items"]), "baseline rights audit missing or invalid")
    audited = {item["path"]: item for item in audit["items"]}
    require(len(audited) == len(audit["items"]), "duplicate baseline rights audit item")
    preserved = {audit_path, OWNER_RELEASE_EVIDENCE_PATH, "LICENSE", "NOTICE.md", "THIRD_PARTY_NOTICES.md"}
    for item in prior:
        name = item["path"]
        require(name in audited and not owner_release_decision_issues(name, audited[name], baseline, version, scope), "invalid baseline rights decision: " + name)
        require(item == {key: audited[name][key] for key in ("path", "status", "reason", "sha256", "releaseDecision")}, "baseline disclosure/audit mismatch")
        preserved.add(name)
        preserved.update(scope[name].get("evidence", []))
    # Keep third-party notices/licenses verbatim, including nested vendor copies.
    preserved.update(name for name in baseline if re.search(r"(?:^|/)(?:LICENSE(?:\.[^/]+)?|NOTICE(?:\.[^/]+)?|THIRD_PARTY_NOTICES\.md|UPSTREAM\.md)$", name, re.I)
                     or "/licenses/" in name)
    require(all(name in current and name in baseline and current[name] == baseline[name] for name in preserved), "historical asset, audit, evidence, license or attribution bytes changed")
    return {"repository": PRIVACY_BASELINE_REPOSITORY, "publicCommit": PRIVACY_BASELINE_COMMIT,
            "publicTree": PRIVACY_BASELINE_PUBLIC_TREE, "releaseVersion": OWNER_RELEASE_VERSION,
            "rightsDisclosureCount": OWNER_RELEASE_SCOPE_COUNT,
            "preservedFiles": [{"path": name, "sha256": sha(baseline[name])} for name in sorted(preserved)]}


def export(root, output, ref="HEAD", working_tree=False, review_only=False, archive_path=None, development_snapshot=False, privacy_maintenance_baseline_path=None):
    root = Path(root).resolve(); output = Path(output).resolve()
    if output.exists() or output == root:
        raise ValueError("OutputDirectory must be a new directory")
    maintenance = privacy_maintenance_baseline_path is not None
    if maintenance and (working_tree or review_only or development_snapshot):
        raise ValueError("PrivacyMaintenance cannot be combined with WorkingTree, ReviewOnly or DevelopmentSnapshot")
    if maintenance and (not str(privacy_maintenance_baseline_path).strip() or not re.fullmatch(r"[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?", ref)):
        raise ValueError("PrivacyMaintenance requires a baseline path and a full immutable Git commit hash")
    if development_snapshot and (working_tree or review_only):
        raise ValueError("DevelopmentSnapshot cannot be combined with WorkingTree or ReviewOnly")
    if development_snapshot and not re.fullmatch(r"[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?", ref):
        raise ValueError("DevelopmentSnapshot requires a full immutable Git commit hash")
    if working_tree and not review_only:
        raise ValueError("WorkingTree requires ReviewOnly and cannot produce a release-ready snapshot")
    if archive_path and Path(archive_path).exists():
        raise ValueError("ArchivePath already exists")
    paths, exclusions, invalid, modes, commit, tree = read_source(root, ref, working_tree)
    if (development_snapshot or maintenance) and commit.lower() != ref.lower():
        raise ValueError("Immutable snapshot resolved commit differs from the requested immutable revision")
    replacements = []
    for target, source in sorted(REPLACEMENTS.items()):
        if source not in paths:
            raise ValueError("Missing public document/template: " + source)
        paths[target] = paths[source]
        modes[target] = 0o644
        replacements.append({"path": target, "from": source, "sha256": sha(paths[source])})
    version, checks, findings, disclosures = inspect(paths, invalid)
    checks.append({"name": "committed_release_source", "ok": not working_tree, "issues": ["Working-tree review is not a release source revision"] if working_tree else []})
    if development_snapshot:
        issues = development_snapshot_rights_issues(disclosures)
        checks.append({"name": "development_snapshot_rights", "ok": not issues, "issues": issues})
    maintenance_baseline = None
    if maintenance:
        maintenance_baseline = privacy_maintenance_baseline(privacy_maintenance_baseline_path, paths, version, disclosures)
        checks.append({"name": "privacy_maintenance_baseline", "ok": True, "issues": []})
    content_ready = all(x["ok"] for x in checks) and not findings
    # Neither a review nor an unreleased development snapshot is eligible as the
    # corresponding source for a binary release. Do not relax any content gate.
    mode_issues = (["ReviewOnly forbids public release"] if review_only else
                   ["Unreleased development snapshot is not corresponding source for any existing binary"] if development_snapshot else
                   ["Privacy maintenance is not a binary release or corresponding-source replacement"] if maintenance else [])
    checks.append({"name": "publication_mode", "ok": not mode_issues, "issues": mode_issues})
    ready = content_ready and not mode_issues
    if not content_ready and not review_only:
        summary = [{"name": x["name"], "issues": x["issues"]} for x in checks if not x["ok"] and x["name"] != "publication_mode"]
        raise ValueError("Public source export blocked: " + json.dumps(summary, ensure_ascii=False))
    hard_failures = [x["name"] for x in checks if not x["ok"] and x["name"] in {
        "high_confidence_secret_patterns", "sensitive_source_paths", "portable_source_paths", "operator_deployment_information"
    }]
    if hard_failures:
        raise ValueError("Unsafe source export blocked before writing, including review mode: " + ", ".join(hard_failures))
    kind = "privacy-maintenance" if maintenance else "development-snapshot" if development_snapshot else "review-only" if review_only else "release-source"
    source_status = (("Privacy maintenance of existing public source; not a new version, binary release, or corresponding-source replacement.") if maintenance else
                     "Unreleased development snapshot; package version is retained, not a new release. "
                     "Not the corresponding source for any existing binary or update package."
                     if development_snapshot else "Review only; not authorized for publication." if review_only else
                     "Release-source candidate; separate public-source verification is mandatory before binary publication.")
    if development_snapshot:
        paths["DEVELOPMENT_SNAPSHOT.md"] = ("# Unreleased development snapshot\n\n" + source_status +
            "\n\nPublication kind: `development-snapshot`\n\nSource commit: `" + commit +
            "`\n\nRetained package version: `" + version +
            "`\n\nDo not replace an existing release tag or use this snapshot to approve an updater release. "
            "A future binary requires its own exact corresponding-source publication and release verification.\n").encode("utf-8")
        modes["DEVELOPMENT_SNAPSHOT.md"] = 0o644
    if maintenance:
        paths["PRIVACY_MAINTENANCE.md"] = ("# Public-source privacy maintenance\n\n" + source_status +
            "\n\nPublication kind: `privacy-maintenance`\n\nSource commit: `" + commit +
            "`\n\nRetained package version: `" + version + "`\n\nBaseline repository: `" + PRIVACY_BASELINE_REPOSITORY +
            "`\n\nVerified public baseline commit: `" + PRIVACY_BASELINE_COMMIT + "`\n\nVerified public tree: `" + PRIVACY_BASELINE_PUBLIC_TREE +
            "`\n\nThis maintenance follows the current owner's instruction to remove operator information from public source. "
            "It is a maintenance direction, not a new rights license or legal clearance. The existing 50-file unresolved "
            "rights scope, exact assets, audit, provenance, licenses, and disclosures remain unchanged from the pinned "
            "public baseline. No historical decision is amended and no later version inherits this exception. "
            "Existing tags and binary correspondence are not changed. This snapshot must not authorize an updater "
            "release or replace the corresponding source for an existing binary.\n").encode("utf-8")
        modes["PRIVACY_MAINTENANCE.md"] = 0o644
    files = [{"path": p, "sha256": sha(data), "size": len(data)} for p, data in sorted(paths.items())]
    digest = sha("".join(f'{f["sha256"]}  {f["size"]}  {f["path"]}\n' for f in files).encode("utf-8"))
    manifest = {"schemaVersion": 1, "publicationKind": kind, "version": version, "sourceCommit": commit, "sourceTree": tree, "files": files}
    report = {"schemaVersion": 1, "publicationKind": kind, "sourceStatus": source_status, "version": version, "sourceCommit": commit, "sourceTree": tree, "sourceMode": "working-tree" if working_tree else "git-ref", "releaseReady": ready, "exclusions": exclusions, "replacements": replacements, "checks": checks, "rightsFindings": findings, "rightsDisclosures": disclosures, "filesDigest": digest}
    if maintenance:
        manifest["maintenanceBaseline"] = report["maintenanceBaseline"] = maintenance_baseline
    paths["SOURCE_MANIFEST.json"] = json_bytes(manifest)
    paths["SOURCE_EXPORT_REPORT.json"] = json_bytes(report)
    output.mkdir(parents=True)
    for path, data in sorted(paths.items()):
        dest = output / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        if os.name != "nt":
            dest.chmod(modes.get(path, 0o644))
    if archive_path:
        dest = Path(archive_path).resolve()
        dest.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(dest, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for path, data in sorted(paths.items()):
                info = zipfile.ZipInfo(path, (2026, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (0o100000 | modes.get(path, 0o644)) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, data, compresslevel=9)
    return {"SourceDirectory": str(output), "ArchivePath": str(Path(archive_path).resolve()) if archive_path else None, "ManifestPath": str(output / "SOURCE_MANIFEST.json"), "ReportPath": str(output / "SOURCE_EXPORT_REPORT.json"), "SourceCommit": commit, "Version": version, "FileCount": len(files), "ReleaseReady": ready, "PublicationKind": kind}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--ref", default="HEAD")
    p.add_argument("--output-directory", required=True)
    p.add_argument("--archive-path")
    p.add_argument("--working-tree", action="store_true")
    p.add_argument("--review-only", action="store_true")
    p.add_argument("--development-snapshot", action="store_true", help="Unreleased source only; requires an immutable commit and independent rights clearance")
    p.add_argument("--privacy-maintenance-baseline", help="Local exact snapshot of the pinned already-public 1.7.1 baseline; no network")
    p.add_argument("--root", default=str(Path(__file__).resolve().parent.parent))
    args = p.parse_args()
    try:
        result = export(args.root, args.output_directory, args.ref, args.working_tree, args.review_only, args.archive_path, args.development_snapshot, args.privacy_maintenance_baseline)
    except (ValueError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as e:
        print(str(e), file=sys.stderr)
        return 1
    # ASCII JSON is losslessly parsed under both Windows PowerShell and UTF-8 shells.
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
