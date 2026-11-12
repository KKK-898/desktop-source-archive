"""Verify the actual app bundle before offering a Mac phone-connection test DMG."""
import hashlib
import json
import os
import platform
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / 'src-tauri/target/universal-apple-darwin/release/bundle'
apps = list((BUNDLE / 'macos').glob('*.app'))
dmgs = list((BUNDLE / 'dmg').glob('*.dmg'))
assert len(apps) == len(dmgs) == 1, 'Expected exactly one app and DMG'
app, dmg = apps[0], dmgs[0]
with (app / 'Contents/Info.plist').open('rb') as stream:
    info = plistlib.load(stream)
version = json.loads((ROOT / 'package.json').read_text())['version']
assert info['CFBundleShortVersionString'] == version
executable = app / 'Contents/MacOS' / info['CFBundleExecutable']
architectures = subprocess.check_output(['lipo', '-archs', str(executable)], text=True).split()
assert set(architectures) == {'arm64', 'x86_64'}, architectures
assert b'mobile_connection_start' in executable.read_bytes(), 'Phone supervisor missing'
resources = app / 'Contents/Resources'
subprocess.run([sys.executable, str(ROOT / 'scripts/verify-main-bundle.py'), '--platform', 'mac'], check=True)
subprocess.run(['codesign', '--verify', '--deep', '--strict', '--verbose=2', str(app)], check=True)
subprocess.run(['hdiutil', 'verify', str(dmg)], check=True)
output = ROOT / 'release/mac-mobile-test'
output.mkdir(parents=True, exist_ok=True)
run_id = os.environ.get('GITHUB_RUN_ID', 'local')
target = output / ('Gaoge-Free_' + version + '_Mobile-test_' + run_id + '_universal.dmg')
shutil.copy2(dmg, target)
with target.open('rb') as stream:
    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
report = {
    'version': version, 'file': target.name, 'sha256': digest, 'bytes': target.stat().st_size,
    'buildCommit': os.environ.get('GITHUB_SHA'), 'architectures': architectures,
    'phoneComponent': 'downloaded on demand; excluded from app bundle', 'buildHost': platform.machine(),
    'workflowRun': os.environ.get('GITHUB_SERVER_URL', '') + '/' + os.environ.get('GITHUB_REPOSITORY', '') + '/actions/runs/' + run_id,
    'signing': 'ad-hoc; not Apple notarized',
    'codexOnPhysicalMac': 'not tested', 'relay': 'https://api.gaogeaii.com/mobile',
}
(output / 'build-info.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
(output / 'SHA256SUMS.txt').write_text(digest + '  ' + target.name + '\n', encoding='utf-8')
(output / '测试说明.txt').write_text(
    'Gaoge Free 手机连接 Mac 测试版\n'
    '支持 Apple Silicon 与 Intel。请使用 macOS 11 或更高版本，并满足 Codex 自身的系统要求。\n'
    '安装前退出旧版 Gaoge Free，将应用拖入“应用程序”后启动。\n'
    '登录软件，进入“连接手机”，首次下载并安装手机连接组件。\n'
    '设置用户名和至少12位密码，保存并开启连接。\n'
    '扫码直接登录，或复制专属网址，用设置的用户名和密码登录。\n'
    '连接期间请保持电脑联网、Gaoge Free 和 Codex 运行。\n'
    '已验证轻量主软件双架构构建、不包含可选组件与安装镜像；组件由独立流程构建验证。\n'
    '真实 Mac Codex 对话操作仍待实机确认。\n'
    '本包使用临时签名，未经过 Apple 公证，不属于正式自动更新版本。\n', encoding='utf-8')
print(json.dumps(report, ensure_ascii=False, indent=2))
