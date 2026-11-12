#!/usr/bin/env python3
"""One-time, rollback-safe Nginx migration for Gaoge update mirrors."""

from __future__ import annotations

import datetime
import shutil
import subprocess
from pathlib import Path


SOURCE = Path("/var/www/gaogeaii/updates")
TARGETS = {
    "com": Path("/var/www/gaogeaii/update-sites/gaogeaii-com"),
    "cc": Path("/var/www/gaogeaii/update-sites/gaogeaii-cc"),
}
SITE_PATHS = {
    "com": Path("/etc/nginx/sites-available/api.gaogeaii.com"),
    "cc": Path("/etc/nginx/sites-available/api.gaogeaii.cc"),
}

COMMON_TAIL = r"""
location ^~ /gaogeaii/codex-locales/ {
    alias /var/www/gaogeaii/codex-locales/;
    autoindex off;
    try_files $uri =404;
}

location ^~ /gaogeaii/proxy/ {
    alias /var/www/gaogeaii/proxy/;
    autoindex off;
    default_type text/yaml;
    types { text/yaml yaml yml; }
    add_header Cache-Control "no-store" always;
    add_header X-Robots-Tag "noindex, nofollow, noarchive" always;
    try_files $uri =404;
}
"""


def snippet(root: Path) -> str:
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
    return "\n".join(sections) + COMMON_TAIL


def main() -> None:
    if not SOURCE.is_dir():
        raise SystemExit(f"Missing source update root: {SOURCE}")
    for path in SITE_PATHS.values():
        if not path.is_file():
            raise SystemExit(f"Missing Nginx site: {path}")

    timestamp = datetime.datetime.now(datetime.UTC).strftime("%Y%m%d%H%M%S")
    backup = Path(f"/root/gaoge-release-nginx-backup-{timestamp}")
    backup.mkdir(mode=0o700)
    for path in SITE_PATHS.values():
        shutil.copy2(path, backup / path.name)
    shared_snippet = Path("/etc/nginx/snippets/gaogeaii-updates.conf")
    shutil.copy2(shared_snippet, backup / shared_snippet.name)

    for target in TARGETS.values():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(SOURCE, target, dirs_exist_ok=True)

    try:
        for key, root in TARGETS.items():
            target_snippet = Path(f"/etc/nginx/snippets/gaogeaii-updates-{key}.conf")
            target_snippet.write_text(snippet(root), encoding="utf-8")
            old_include = "include /etc/nginx/snippets/gaogeaii-updates.conf;"
            new_include = f"include /etc/nginx/snippets/gaogeaii-updates-{key}.conf;"
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

    subprocess.check_call(["chown", "-R", "www-data:www-data", "/var/www/gaogeaii/update-sites"])
    print(f"backup={backup}")
    for key, root in TARGETS.items():
        print(f"{key}={root}")


if __name__ == "__main__":
    main()
