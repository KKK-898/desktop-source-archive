#!/usr/bin/env python3
"""One-time, rollback-safe Nginx migration for Gaoge update mirrors."""

from __future__ import annotations

import argparse
import datetime
import json
import re
import shutil
import subprocess
from pathlib import Path


def load_configuration(path):
    """All deployment locations come from an operator-owned JSON file."""
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    required = ("source", "targets", "sites", "sharedSnippet", "backupRoot", "owner")
    if not isinstance(value, dict) or any(key not in value for key in required):
        raise ValueError("Configuration requires source, targets, sites, sharedSnippet, backupRoot and owner")
    targets, sites = value["targets"], value["sites"]
    if not isinstance(targets, dict) or not targets or not isinstance(sites, dict) or set(targets) != set(sites):
        raise ValueError("targets and sites require the same nonempty mirror keys")
    if any(not re.fullmatch(r"[a-zA-Z0-9_-]{1,40}", key) for key in targets):
        raise ValueError("Mirror keys must be simple names")
    for item in (value["source"], value["sharedSnippet"], value["backupRoot"], *targets.values(), *sites.values()):
        if (not isinstance(item, str) or not re.fullmatch(r"/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+", item)
                or any(part in (".", "..") for part in item.split("/"))):
            raise ValueError("Deployment paths must be explicit, safe absolute Linux paths")
    if not isinstance(value["owner"], str) or not re.fullmatch(r"[a-z_][a-z0-9_-]*:[a-z_][a-z0-9_-]*", value["owner"]):
        raise ValueError("owner must be an explicit user:group")
    source = Path(value["source"])
    targets = {key: Path(item) for key, item in targets.items()}
    sites = {key: Path(item) for key, item in sites.items()}
    roots = [source, *targets.values()]
    if any(left == right or left in right.parents or right in left.parents
           for index, left in enumerate(roots) for right in roots[index + 1:]):
        raise ValueError("Each target must be distinct from the source and other targets")
    return source, targets, sites, Path(value["sharedSnippet"]), Path(value["backupRoot"]), value["owner"]


def snippet(root: Path, common_tail: str) -> str:
    sections = []
    for platform in ("win", "mac", "linux", "themes"):
        sections.append(
            f"""location ^~ /gaogeaii/updates/{platform}/ {{
    alias {root}/{platform}/;
    autoindex off;
    add_header Cache-Control "no-store" always;
    try_files $uri =404;
}}
"""
        )
    return "\n".join(sections) + common_tail


def main() -> None:
    parser = argparse.ArgumentParser(description="Explicitly configured update mirror migration")
    parser.add_argument("--config", required=True, help="Private deployment JSON; never include it in source releases")
    args = parser.parse_args()
    SOURCE, TARGETS, SITE_PATHS, shared_snippet, backup_root, owner = load_configuration(args.config)
    if not SOURCE.is_dir():
        raise SystemExit(f"Missing source update root: {SOURCE}")
    for path in SITE_PATHS.values():
        if not path.is_file():
            raise SystemExit(f"Missing Nginx site: {path}")

    shared_original = shared_snippet.read_text(encoding="utf-8")
    marker = "location ^~ /gaogeaii/codex-locales/"
    if shared_original.count(marker) != 1:
        raise ValueError("Expected one locale/proxy tail in the existing shared snippet")
    common_tail = marker + shared_original.split(marker, 1)[1]
    timestamp = datetime.datetime.now(datetime.UTC).strftime("%Y%m%d%H%M%S")
    backup = backup_root / f"update-mirror-backup-{timestamp}"
    backup.mkdir(mode=0o700)
    for path in SITE_PATHS.values():
        shutil.copy2(path, backup / path.name)
    shutil.copy2(shared_snippet, backup / shared_snippet.name)

    for target in TARGETS.values():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(SOURCE, target, dirs_exist_ok=True)

    try:
        for key, root in TARGETS.items():
            target_snippet = shared_snippet.with_name(f"{shared_snippet.stem}-{key}{shared_snippet.suffix}")
            target_snippet.write_text(snippet(root, common_tail), encoding="utf-8")
            old_include = f"include {shared_snippet};"
            new_include = f"include {target_snippet};"
            site_text = SITE_PATHS[key].read_text(encoding="utf-8")
            if new_include in site_text:
                continue
            if site_text.count(old_include) != 1:
                raise RuntimeError(f"Expected one shared update include in {SITE_PATHS[key]}")
            SITE_PATHS[key].write_text(site_text.replace(old_include, new_include), encoding="utf-8")

        shared_text = shared_snippet.read_text(encoding="utf-8")
        update_part = shared_text.split("location ^~ /gaogeaii/codex-locales/", 1)[0]
        if 'add_header Cache-Control "no-store" always;' not in update_part:
            shared_text = shared_text.replace(
                "    autoindex off;\n    try_files $uri =404;",
                '    autoindex off;\n    add_header Cache-Control "no-store" always;\n    try_files $uri =404;',
                3,
            )
            shared_snippet.write_text(shared_text, encoding="utf-8")

        subprocess.check_call(["nginx", "-t"])
        subprocess.check_call(["systemctl", "reload", "nginx"])
    except Exception:
        for path in SITE_PATHS.values():
            saved = backup / path.name
            if saved.exists():
                shutil.copy2(saved, path)
        shutil.copy2(backup / shared_snippet.name, shared_snippet)
        subprocess.call(["nginx", "-t"])
        subprocess.call(["systemctl", "reload", "nginx"])
        raise

    for root in TARGETS.values():
        subprocess.check_call(["chown", "-R", owner, str(root)])
    print(f"backup={backup}")
    for key, root in TARGETS.items():
        print(f"{key}={root}")


if __name__ == "__main__":
    main()
