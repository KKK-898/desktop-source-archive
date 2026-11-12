"""Package one native runtime. Never signs or publishes, and never changes app resources."""
import argparse
import json
import os
import tarfile
from pathlib import Path

from mobile_component_release import PLATFORMS, ROOT, platform_metadata, release_config


def package_runtime(source, output, platform):
    source = source.resolve(strict=True)
    output.mkdir(parents=True, exist_ok=True)
    target = output / (platform + '.tar.gz')
    if target.exists():
        raise ValueError('Refusing to overwrite an existing component archive')
    temporary = target.with_suffix(target.suffix + '.partial')
    try:
        with tarfile.open(temporary, 'w:gz', format=tarfile.PAX_FORMAT, dereference=False) as archive:
            for filename in [source, *sorted(source.rglob('*'))]:
                relative = filename.relative_to(source)
                if filename.is_symlink() and not filename.resolve().is_relative_to(source):
                    raise ValueError('Runtime contains a link outside its root')
                name = 'runtime' if relative == Path('.') else 'runtime/' + relative.as_posix()
                info = archive.gettarinfo(str(filename), arcname=name)
                info.uid = info.gid = 0
                info.uname = info.gname = ''
                # Materialize hard links as ordinary files; symbolic framework links stay links.
                if info.islnk():
                    info.type, info.linkname, info.size = tarfile.REGTYPE, '', filename.stat().st_size
                if info.isfile():
                    with filename.open('rb') as stream:
                        archive.addfile(info, stream)
                else:
                    archive.addfile(info)
        config = release_config()
        metadata = platform_metadata(temporary, platform, config)
        os.replace(temporary, target)
        (output / (platform + '.json')).write_text(json.dumps({**config, 'platform': platform, **metadata}, indent=2) + '\n', encoding='utf-8')
        return target, metadata
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', required=True, choices=PLATFORMS)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'release/mobile-component-artifacts')
    args = parser.parse_args()
    filename, metadata = package_runtime(args.source or ROOT / 'resources/mobile-bridge' / args.platform, args.output_dir, args.platform)
    print(json.dumps({'archive': str(filename), **metadata}, indent=2))


if __name__ == '__main__':
    main()
