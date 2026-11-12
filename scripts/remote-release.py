#!/usr/bin/env python3
"""Remote, transactional publisher used by one-click-release.ps1.

The GitHub token is accepted only on stdin during the stage action. Configuration
contains public release metadata and is passed as base64 JSON.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import stat
import sys
import tempfile
import time
import urllib.parse
import urllib.error
import urllib.request
import zipfile
from pathlib import Path


PLATFORMS = ("win", "mac", "linux")
ARTIFACT_NAMES = {
    "win": "gaoge-free-win",
    "mac": "gaoge-free-mac",
    "linux": "gaoge-free-linux",
}
MUTABLE_PREFIX = "Gaoge-Free-latest-"


def decode_config(value: str) -> dict:
    return json.loads(base64.b64decode(value).decode("utf-8"))


def stage_root(config: dict) -> Path:
    version = config["version"]
    return Path(f"/tmp/gaoge-release-{version}")


def state_path(config: dict) -> Path:
    return stage_root(config) / "state.json"


def api_json(url: str, token: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "gaoge-release-publisher",
        },
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def download(url: str, target: Path, token: str) -> None:
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "gaoge-release-publisher",
        },
    )

    last_error: Exception | None = None
    for attempt in range(1, 4):
        temp = target.with_name(f"{target.name}.attempt-{attempt}.part")
        if temp.exists():
            temp.unlink()
        try:
            try:
                response = urllib.request.build_opener(NoRedirect()).open(request, timeout=120)
            except urllib.error.HTTPError as error:
                if error.code not in (301, 302, 303, 307, 308):
                    raise
                location = error.headers.get("Location")
                if not location:
                    raise RuntimeError("Artifact redirect did not contain Location") from error
                response = urllib.request.urlopen(
                    urllib.request.Request(location, headers={"User-Agent": "gaoge-release-publisher"}),
                    timeout=300,
                )

            content_type = str(response.headers.get("Content-Type") or "").strip()
            content_length = str(response.headers.get("Content-Length") or "").strip()
            with response, temp.open("wb") as output:
                shutil.copyfileobj(response, output)

            if not zipfile.is_zipfile(temp):
                head = temp.read_bytes()[:16].hex()
                raise RuntimeError(
                    "Downloaded artifact is not a valid zip "
                    f"(attempt {attempt}, content-type={content_type or 'unknown'}, "
                    f"content-length={content_length or 'unknown'}, size={temp.stat().st_size}, head={head})"
                )

            temp.replace(target)
            return
        except Exception as error:
            last_error = error
            if temp.exists():
                temp.unlink()
            if attempt < 3:
                time.sleep(attempt)
    raise RuntimeError(f"Failed to download valid GitHub artifact zip from {url}") from last_error


def safe_extract(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    resolved = destination.resolve()
    try:
        with zipfile.ZipFile(archive) as bundle:
            for info in bundle.infolist():
                target = (destination / info.filename).resolve()
                if target != resolved and resolved not in target.parents:
                    raise RuntimeError(f"Unsafe artifact path: {info.filename}")
            bundle.extractall(destination)
    except zipfile.BadZipFile as error:
        raise RuntimeError(f"Invalid artifact archive: {archive}") from error


def artifact_source(directory: Path) -> Path:
    manifests = list(directory.rglob("latest.json"))
    if len(manifests) != 1:
        raise RuntimeError(f"Expected one latest.json in {directory}, found {len(manifests)}")
    return manifests[0].parent


def platform_segment(key: str) -> str:
    if key.startswith("windows-"):
        return "win"
    if key.startswith("darwin-"):
        return "mac"
    if key.startswith("linux-"):
        return "linux"
    raise RuntimeError(f"Unsupported updater platform key: {key}")


def mirror_manifest(source: dict, base_url: str, version: str, minimum_version: str) -> dict:
    output = dict(source)
    output["version"] = version
    output["minimumVersion"] = minimum_version
    platforms = {}
    for key, entry in source.get("platforms", {}).items():
        signature = str(entry.get("signature") or "").strip()
        if not signature:
            raise RuntimeError(f"Manifest platform {key} has no signature")
        file_name = urllib.parse.unquote(Path(urllib.parse.urlparse(entry["url"]).path).name)
        if not file_name:
            raise RuntimeError(f"Manifest platform {key} has no artifact filename")
        platform = platform_segment(key)
        artifact_url = f"{base_url.rstrip('/')}/{platform}/{urllib.parse.quote(file_name)}"
        platforms[key] = {"signature": signature, "url": artifact_url}
    if not platforms:
        raise RuntimeError("Manifest has no signed platforms")
    output["platforms"] = platforms
    return output


def versioned_manifest_artifacts(manifest: dict, directory: Path, base_url: str, version: str) -> dict:
    """Point updater manifests at immutable, versioned copies instead of CDN-prone stable aliases."""
    output = dict(manifest)
    platforms = {}
    for key, entry in manifest["platforms"].items():
        signature = entry["signature"].strip()
        current_name = urllib.parse.unquote(Path(urllib.parse.urlparse(entry["url"]).path).name)
        current_artifact = directory / current_name
        current_signature = directory / f"{current_name}.sig"
        if not current_artifact.exists() or not current_signature.exists():
            raise RuntimeError(f"Missing updater artifact before versioning: {current_artifact}")

        candidates = []
        for signature_path in directory.glob("*.sig"):
            artifact_path = Path(str(signature_path)[:-4])
            if not artifact_path.exists():
                continue
            if signature_path.read_text(encoding="utf-8").strip() != signature:
                continue
            if version in artifact_path.name and not artifact_path.name.startswith(MUTABLE_PREFIX):
                candidates.append(artifact_path)
        if candidates:
            selected = sorted(candidates, key=lambda item: (len(item.name), item.name))[0]
        else:
            if current_name.endswith(".app.tar.gz"):
                versioned_name = f"{current_name[:-len('.app.tar.gz')]}_{version}.app.tar.gz"
            elif current_name.endswith(".tar.gz"):
                versioned_name = f"{current_name[:-len('.tar.gz')]}_{version}.tar.gz"
            else:
                suffix = current_artifact.suffix
                versioned_name = f"{current_artifact.stem}_{version}{suffix}"
            selected = directory / versioned_name
            shutil.copy2(current_artifact, selected)
            shutil.copy2(current_signature, Path(f"{selected}.sig"))

        platform = platform_segment(key)
        platforms[key] = {
            "signature": signature,
            "url": f"{base_url.rstrip('/')}/{platform}/{urllib.parse.quote(selected.name)}",
        }
    output["platforms"] = platforms
    return output


def copy_platform_files(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for child in source.iterdir():
        if child.is_file():
            shutil.copy2(child, destination / child.name)


def validate_staged_platform(path: Path, version: str) -> None:
    manifest_path = path / "latest.json"
    if not manifest_path.exists():
        raise RuntimeError(f"Missing staged manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("version") != version:
        raise RuntimeError(f"Bad staged version in {manifest_path}")
    files = [item for item in path.iterdir() if item.is_file()]
    if not any(item.suffix.lower() in {".exe", ".dmg", ".appimage", ".deb"} or item.name.endswith(".tar.gz") for item in files):
        raise RuntimeError(f"No installer in staged directory: {path}")
    for entry in manifest.get("platforms", {}).values():
        file_name = urllib.parse.unquote(Path(urllib.parse.urlparse(entry["url"]).path).name)
        installer = path / file_name
        signature = path / f"{file_name}.sig"
        if not installer.exists() or installer.stat().st_size <= 0:
            raise RuntimeError(f"Missing manifest installer: {installer}")
        if not signature.exists() or not signature.read_text(encoding="utf-8").strip():
            raise RuntimeError(f"Missing manifest signature: {signature}")


def action_stage(config: dict) -> None:
    token_b64 = sys.stdin.read().lstrip("\ufeff").strip()
    if not token_b64:
        raise RuntimeError("GitHub token was not provided on stdin")
    token = base64.b64decode(token_b64).decode("utf-8")
    root = stage_root(config)
    if root.exists():
        shutil.rmtree(root)
    downloads = root / "downloads"
    extracted = root / "artifacts"
    mirrors_root = root / "mirrors"
    downloads.mkdir(parents=True)
    extracted.mkdir(parents=True)
    mirrors_root.mkdir(parents=True)

    repository = config["buildRepo"]
    run_id = config["runId"]
    payload = api_json(f"https://api.github.com/repos/{repository}/actions/runs/{run_id}/artifacts", token)
    artifacts = {
        item["name"]: item
        for item in payload.get("artifacts", [])
        if not item.get("expired")
    }
    missing = sorted(set(ARTIFACT_NAMES.values()) - set(artifacts))
    if missing:
        raise RuntimeError(f"Missing GitHub artifacts: {missing}")

    sources = {}
    for platform, name in ARTIFACT_NAMES.items():
        archive = downloads / f"{name}.zip"
        target = extracted / name
        try:
            download(artifacts[name]["archive_download_url"], archive, token)
            safe_extract(archive, target)
        except Exception as error:
            raise RuntimeError(f"Failed to stage artifact {name} for {platform}") from error
        sources[platform] = artifact_source(target)

    for mirror in config["mirrors"]:
        mirror_root = mirrors_root / mirror["id"]
        for platform in PLATFORMS:
            destination = mirror_root / platform
            copy_platform_files(sources[platform], destination)
            source_manifest = json.loads((sources[platform] / "latest.json").read_text(encoding="utf-8"))
            generated = mirror_manifest(
                source_manifest,
                mirror["publicBaseUrl"],
                config["version"],
                config["minimumVersion"],
            )
            generated = versioned_manifest_artifacts(
                generated,
                destination,
                mirror["publicBaseUrl"],
                config["version"],
            )
            (destination / "latest.json").write_text(
                json.dumps(generated, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            validate_staged_platform(destination, config["version"])

    state_path(config).write_text(json.dumps({"promoted": False, "backups": []}, indent=2), encoding="utf-8")
    token = ""
    print(json.dumps({"ok": True, "action": "stage", "stageRoot": str(root)}))


def mutable_files(platform_root: Path) -> list[Path]:
    if not platform_root.exists():
        return []
    return [
        child for child in platform_root.iterdir()
        if child.is_file() and (child.name == "latest.json" or child.name.startswith(MUTABLE_PREFIX))
    ]


def restore_from_state(config: dict, state: dict) -> None:
    for item in reversed(state.get("backups", [])):
        target = Path(item["target"])
        backup_value = item.get("backup")
        if target.exists():
            target.unlink()
        if backup_value:
            backup = Path(backup_value)
        else:
            backup = None
        if backup is not None and backup.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(backup, target)


def action_promote(config: dict) -> None:
    root = stage_root(config)
    state_file = state_path(config)
    if not state_file.exists():
        raise RuntimeError("Release was not staged")
    state = json.loads(state_file.read_text(encoding="utf-8"))
    backup_root = Path("/var/www/gaogeaii/release-backups") / f"{config['version']}-{int(time.time())}"
    backups = []
    try:
        for mirror in config["mirrors"]:
            live_root = Path(mirror["remoteRoot"])
            staged_root = root / "mirrors" / mirror["id"]
            for platform in PLATFORMS:
                live_platform = live_root / platform
                staged_platform = staged_root / platform
                live_platform.mkdir(parents=True, exist_ok=True)
                for staged_mutable in mutable_files(staged_platform):
                    current = live_platform / staged_mutable.name
                    backup_value = ""
                    if current.exists():
                        backup = backup_root / mirror["id"] / platform / current.name
                        backup.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(current, backup)
                        backup_value = str(backup)
                    backups.append({"target": str(current), "backup": backup_value})
                for child in staged_platform.iterdir():
                    if child.is_file() and child.name != "latest.json":
                        shutil.copy2(child, live_platform / child.name)

        state["backups"] = backups
        state_file.write_text(json.dumps(state, indent=2), encoding="utf-8")

        for mirror in config["mirrors"]:
            live_root = Path(mirror["remoteRoot"])
            staged_root = root / "mirrors" / mirror["id"]
            for platform in PLATFORMS:
                source = staged_root / platform / "latest.json"
                target = live_root / platform / "latest.json"
                temporary = target.with_suffix(".json.next")
                shutil.copy2(source, temporary)
                os.replace(temporary, target)

        state["promoted"] = True
        state_file.write_text(json.dumps(state, indent=2), encoding="utf-8")
    except Exception:
        restore_from_state(config, {"backups": backups})
        raise

    for mirror in config["mirrors"]:
        for platform in PLATFORMS:
            path = Path(mirror["remoteRoot"]) / platform
            for child in path.iterdir():
                if child.is_dir():
                    child.chmod(0o755)
                elif child.is_file():
                    child.chmod(0o644)
    print(json.dumps({"ok": True, "action": "promote", "backupRoot": str(backup_root)}))


def action_rollback(config: dict) -> None:
    state_file = state_path(config)
    if state_file.exists():
        state = json.loads(state_file.read_text(encoding="utf-8"))
        restore_from_state(config, state)
        state["promoted"] = False
        state_file.write_text(json.dumps(state, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "action": "rollback"}))


def action_cleanup(config: dict) -> None:
    root = stage_root(config)
    if root.exists():
        shutil.rmtree(root)
    print(json.dumps({"ok": True, "action": "cleanup"}))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("stage", "promote", "rollback", "cleanup"))
    parser.add_argument("--config-b64", required=True)
    args = parser.parse_args()
    config = decode_config(args.config_b64)
    {
        "stage": action_stage,
        "promote": action_promote,
        "rollback": action_rollback,
        "cleanup": action_cleanup,
    }[args.action](config)


if __name__ == "__main__":
    main()
