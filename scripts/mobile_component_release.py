"""Shared, dependency-free validation for independently distributed phone components."""
import hashlib
import json
import os
import re
import tarfile
from collections import deque
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
PLATFORMS = ('windows-x86_64', 'macos-aarch64', 'macos-x86_64')
def component_base_url():
    """Use the same explicit manifest trust boundary as the desktop runtime."""
    raw = os.environ.get('GAOGE_MOBILE_COMPONENT_MANIFEST_URL', '')
    if not raw:
        raise ValueError('GAOGE_MOBILE_COMPONENT_MANIFEST_URL must be explicitly configured')
    try:
        p = urlsplit(raw)
        port = p.port
    except ValueError as error:
        raise ValueError('Invalid component manifest URL') from error
    if (any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in raw)
            or any(c in raw for c in ('\\', '%', '?', '#', '@'))
            or p.scheme != 'https' or not p.hostname or p.hostname.endswith('.')
            or port not in (None, 443) or p.username is not None or p.password is not None
            or not re.fullmatch(r'/(?:[A-Za-z0-9._~-]+/)+[A-Za-z0-9._~-]+', p.path)
            or any(part in ('.', '..') for part in p.path.split('/'))):
        raise ValueError('Component manifest requires a clean HTTPS URL in a dedicated trusted directory')
    host = '[' + p.hostname + ']' if ':' in p.hostname else p.hostname
    return 'https://' + host + p.path.rsplit('/', 1)[0]



def release_config():
    value = json.loads((ROOT / 'mobile-bridge/component-release.json').read_text(encoding='utf-8-sig'))
    if value.get('schemaVersion') != 1 or value.get('component') != 'mobile-connection':
        raise ValueError('Unsupported component release schema')
    if not re.fullmatch(r'\d+\.\d+\.\d+', value.get('version', '')):
        raise ValueError('Component version must use major.minor.patch')
    if not re.fullmatch(r'\d+\.\d+\.\d+', value.get('minAppVersion', '')) or value.get('protocolVersion') != 1:
        raise ValueError('Invalid application/protocol compatibility constraints')
    return value


def digest_file(filename):
    with Path(filename).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def executable_name(platform):
    if platform not in PLATFORMS:
        raise ValueError('Unsupported component platform: ' + platform)
    return 'gaoge-mobile-gateway.exe' if platform.startswith('windows-') else 'gaoge-mobile-gateway'


def validate_archive_links(entries, links):
    """Resolve links like a filesystem, including links in intermediate components.

    Targets stay relative to each link's resolved parent; processing ``..`` only
    after expanding preceding links prevents lexical normalization from hiding
    an escape. No archive is extracted during this validation.
    """
    graph = dict(entries)
    for name in entries:
        for parent in PurePosixPath(name).parents:
            if str(parent) != '.':
                graph.setdefault(str(parent), 'directory')
    for name in entries:
        for parent in PurePosixPath(name).parents:
            if str(parent) != '.' and graph[str(parent)] != 'directory':
                raise ValueError('Component entry has a non-directory archive parent')
    for name in links:
        resolved = ['runtime']
        pending = deque(PurePosixPath(name).parts[1:])
        expansions = 0
        seen = set()
        while pending:
            part = pending.popleft()
            if part in ('', '.'):
                continue
            if part == '..':
                if len(resolved) <= 1:
                    raise ValueError('Component link escapes runtime directory')
                resolved.pop()
                continue
            candidate = '/'.join([*resolved, part])
            kind = graph.get(candidate)
            if kind is None:
                raise ValueError('Component contains a broken symbolic link')
            if kind == 'symlink':
                expansions += 1
                state = (candidate, tuple(pending))
                if state in seen or expansions > 40:
                    raise ValueError('Component contains a symbolic link cycle or excessive chain')
                seen.add(state)
                target = links[candidate]
                if not target or target.startswith('/') or '\\' in target or ':' in target:
                    raise ValueError('Component contains an unsafe link')
                pending.extendleft(reversed(target.split('/')))
            else:
                resolved.append(part)
                if pending and kind != 'directory':
                    raise ValueError('Component link traverses a non-directory target')
        if graph.get('/'.join(resolved)) not in ('file', 'directory'):
            raise ValueError('Component link does not resolve to a file or directory')


def archive_details(filename, platform):
    """Validate without extraction, including links, payload and expanded size."""
    executable = 'runtime/' + executable_name(platform)
    names = set()
    entries = {}
    links = {}
    total = 0
    count = 0
    runtime_manifest = None
    with tarfile.open(filename, 'r:gz') as archive:
        for member in archive:
            name = member.name
            parts = PurePosixPath(name).parts
            if not parts or parts[0] != 'runtime' or any(p in ('..', '.') for p in parts) or '\\' in name or name.startswith('/') or ':' in name:
                raise ValueError('Component contains an unsafe archive path')
            if name in names:
                raise ValueError('Component contains duplicate archive paths')
            names.add(name)
            count += 1
            if count > 10000 or member.size < 0:
                raise ValueError('Component archive exceeds file limits')
            if member.isfile():
                entries[name] = 'file'
                total += member.size
                if total > 512 * 1024 * 1024:
                    raise ValueError('Component archive exceeds expanded size limit')
                if name == executable and not platform.startswith('windows-') and not member.mode & 0o111:
                    raise ValueError('Mac executable permissions are missing')
                if name == 'runtime/runtime-manifest.json':
                    if member.size > 32768:
                        raise ValueError('Runtime manifest is oversized')
                    runtime_manifest = json.load(archive.extractfile(member))
                else:
                    # Consume all file data so truncated gzip members cannot pass.
                    stream = archive.extractfile(member)
                    while stream.read(1024 * 1024):
                        pass
            elif member.issym():
                entries[name] = 'symlink'
                if platform.startswith('windows-'):
                    raise ValueError('Windows components must not contain symbolic links')
                target = member.linkname
                if not target or target.startswith('/') or '\\' in target or ':' in target:
                    raise ValueError('Component contains an unsafe link')
                links[name] = target
            elif member.isdir():
                entries[name] = 'directory'
            else:
                raise ValueError('Component archive contains an unsupported entry type')
        # tar may stop at zero blocks before gzip validates its trailing CRC.
        while archive.fileobj.read(1024 * 1024):
            pass
    required = {executable, 'runtime/runtime-manifest.json', 'runtime/_internal/web/assets.json'}
    if not required <= names or runtime_manifest is None:
        raise ValueError('Component executable, web assets or build manifest is missing')
    validate_archive_links(entries, links)
    expected_system, expected_arch = platform.split('-', 1)
    if runtime_manifest.get('platform') != expected_system or runtime_manifest.get('architecture') != expected_arch:
        raise ValueError('Runtime manifest does not match requested component platform')
    if platform.startswith('macos-'):
        minimum = runtime_manifest.get('macos', {}).get('minimumSystemVersion', '')
        version = tuple(int(n) for n in minimum.split('.'))
        if (version + (0, 0, 0))[:3] > (11, 0, 0):
            raise ValueError('Mac component requires a newer system than macOS 11')
        if not links:
            raise ValueError('Mac runtime framework symbolic links were lost')
    return {'unpackedSize': total, 'files': count, 'symlinks': len(links)}


def platform_metadata(filename, platform, config):
    base_url = component_base_url()
    details = archive_details(filename, platform)
    return {
        'url': f"{base_url}/{config['version']}/{platform}.tar.gz",
        'sha256': digest_file(filename), 'size': Path(filename).stat().st_size,
        'unpackedSize': details['unpackedSize'], 'executable': executable_name(platform),
    }
