"""Gaoge's private, parent-owned JSONL controller. No management HTTP port."""
import argparse
import contextlib
import json
import logging
import os
import sys
import threading
from pathlib import Path

from bridge.features.auth.auth import password_record
from bridge.features.network.shared_relay import Controller, Connector
from bridge.features.notifications.channels import read_json, write_json
from bridge.resources import project_root
from relay.protocol import origin

DEFAULT_RELAY = 'https://api.gaogeaii.com/mobile'


def self_check():
    """Import runtime dependencies and inspect bundled data without creating services."""
    import importlib
    from aiohttp import ClientSession
    from bridge.app.service import Bridge
    from bridge.api.httpd import GatewayServer
    from bridge.features.notifications.channels import Notifications
    from bridge.features.auth.tls import client_context
    from bridge.platforms import desktop, discovery

    # These are imports only: never construct Bridge, discover applications,
    # inspect processes, open the IPC socket, or read a user's authentication.
    assert all(callable(value) for value in (Bridge, GatewayServer, Notifications, ClientSession))
    desktop(sys.platform)
    discovery(sys.platform)
    platform_name = {'win32': 'windows', 'darwin': 'macos', 'linux': 'linux'}[sys.platform]
    importlib.import_module('bridge.platforms.' + platform_name + '.codex_daemon_env')
    terminal_platform = 'windows' if sys.platform == 'win32' else 'posix'
    importlib.import_module('bridge.platforms.' + terminal_platform + '.terminal')
    client_context()  # Parse the bundled CA trust roots; makes no network request.

    web = (project_root() / 'web').resolve()
    assets = json.loads((web / 'assets.json').read_text(encoding='utf-8'))
    if not isinstance(assets, dict) or '/' not in assets or '/app.js' not in assets:
        raise ValueError('Invalid web asset index')
    for value in assets.values():
        files = value if isinstance(value, list) else [value]
        for relative in files:
            if not isinstance(relative, str):
                raise ValueError('Invalid web asset path')
            path = (web / relative).resolve()
            if not path.is_relative_to(web) or not path.is_file():
                raise ValueError('Missing web asset')
    return {'ok': True, 'check': 'mobile-runtime-imports-and-resources'}


class MobileConnection:
    def __init__(self, directory, *, test_http=False):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.settings_path = self.directory / 'mobile-settings.json'
        self.settings = read_json(self.settings_path, {})
        self.relay_config = {}
        self.secrets_dirty = False
        self.test_http = test_http
        self.controller = Controller(self.directory, test_http=test_http,
                                     config=self.relay_config, save_hook=self.secrets_changed)
        self.gateway = self.bridge = self.notifications = self.connector = None
        self.http_thread = None
        self.pairing = None
        self.error = None

    def secrets_changed(self, _value):
        self.secrets_dirty = True

    def init(self, request):
        cfg = request.get('relayConfig')
        if cfg:
            if not isinstance(cfg, dict) or not all(isinstance(cfg.get(k), str) and cfg[k]
                    for k in ('url', 'deviceToken', 'deviceId', 'deviceName')):
                raise ValueError('已保存的设备接入信息无效，请重新配置。')
            origin(cfg['url'], self.test_http)
            self.relay_config.update(cfg, enabled=False)
        return self.status()

    def status(self):
        remote = {}
        self.error = None
        if self.gateway is not None:
            remote = self.controller.control({'action': 'status'})
            self.error = remote.get('error')
        running = self.gateway is not None
        registered = bool(self.relay_config.get('deviceToken'))
        relay_url = self.relay_config.get('url') or self.settings.get('relayUrl', DEFAULT_RELAY)
        public_url = relay_url + '/d/' + self.relay_config['deviceId'] + '/' if registered else None
        result = {
            'relayConfigured': registered, 'runtimeAvailable': True,
            'state': ('running' if remote.get('online') else 'reconnecting') if running else 'stopped',
            'username': self.settings.get('auth', {}).get('username', ''),
            'hasPassword': bool(self.settings.get('auth', {}).get('hash')),
            'relayUrl': relay_url, 'hasEnrollmentToken': registered,
            'publicUrl': public_url, 'pairing': self.pairing if running and remote.get('online') else None,
            'devices': [{'id': p['id'], 'name': p['name'],
                         'lastSeen': round(p.get('lastSeen', 0) * 1000)} for p in remote.get('phones', [])],
            'error': self.error,
        }
        if self.secrets_dirty:
            result['_secrets'] = dict(self.relay_config) or None
            # Keep offering the private registration until the parent has saved
            # it. A transient OS key-store/disk failure must not consume a one-use
            # enrollment then lose the only device credential on the next query.
        return result

    def save(self, request):
        username = request.get('username', '').strip()
        password = request.get('password') or ''
        if not isinstance(username, str) or not username or len(username) > 200 or any(ord(c) < 32 for c in username):
            raise ValueError('请输入有效的手机登录用户名。')
        if not isinstance(password, str) or (password and not 12 <= len(password) <= 1000):
            raise ValueError('手机登录密码需要至少 12 位。')
        auth = self.settings.get('auth', {})
        if not password and not auth.get('hash'):
            raise ValueError('首次使用请设置手机登录密码。')
        relay_url = origin(request.get('relayUrl') or self.settings.get('relayUrl', DEFAULT_RELAY), self.test_http)
        if self.relay_config.get('deviceToken') and self.relay_config['url'] != relay_url:
            raise ValueError('这台电脑已接入另一手机服务，请先联系管理员迁移设备。')
        enrollment = request.get('enrollmentToken') or ''
        if enrollment and (not isinstance(enrollment, str) or len(enrollment) > 256):
            raise ValueError('设备接入码格式不正确。')
        account_token = request.get('accountToken') or ''
        if account_token and (not isinstance(account_token, str) or len(account_token) > 16384
                              or relay_url != DEFAULT_RELAY):
            raise ValueError('软件账号只能用于高哥官方手机连接服务。')
        changed = bool(password) or username != auth.get('username')
        # Revoke before changing auth. If the server cannot confirm revocation,
        # leave the old credentials intact and do not silently retain grants.
        if changed and self.relay_config.get('deviceToken'):
            self.controller.control({'action': 'revoke-all'})
        self.stop_runtime()
        new_auth = {**auth, 'mode': 'password', 'username': username, 'sessionHours': 12}
        if password:
            new_auth.update(password_record(password))
        next_settings = {'auth': new_auth, 'relayUrl': relay_url}
        write_json(self.settings_path, next_settings)
        self.settings = next_settings
        if enrollment and not self.relay_config.get('deviceToken'):
            self.controller.control({'action': 'register', 'url': relay_url,
                                     'invitation': enrollment, 'name': os.environ.get('COMPUTERNAME') or '我的电脑',
                                     'consent': True})
        elif account_token and not self.relay_config.get('deviceToken'):
            self.controller.control({'action': 'register-account', 'url': relay_url,
                                     'accountToken': account_token,
                                     'name': os.environ.get('COMPUTERNAME') or '我的电脑', 'consent': True})
        self.pairing = None
        return self.status()

    def start(self):
        if self.gateway is not None:
            return self.status()
        if not self.settings.get('auth', {}).get('hash'):
            raise ValueError('请先保存手机登录账号和密码。')
        if not self.relay_config.get('deviceToken'):
            raise ValueError('请先填写手机连接服务地址和设备接入码。')
        from bridge.app.service import Bridge
        from bridge.api.httpd import GatewayServer
        from bridge.features.notifications.channels import Notifications
        codex_home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
        if not codex_home.is_dir():
            raise ValueError('尚未找到 Codex 数据，请先在这台电脑打开 Codex。')
        client_dir = self.directory / 'desktop-sessions'
        client_dir.mkdir(exist_ok=True)
        write_json(client_dir / 'settings.json', {'enabled': {'codex': True, 'claude': False, 'deepseek': False}})
        try:
            self.bridge = Bridge(codex_home, self.directory)
            self.gateway = GatewayServer(('127.0.0.1', 0), self.bridge,
                {'auth': self.settings['auth'], 'origins': [], 'localAccess': True, 'allowedProviders': ['codex']}, project_root() / 'web', self.directory)
            local_origin = 'http://127.0.0.1:' + str(self.gateway.server_port)
            self.gateway.origins.add(local_origin)
            self.gateway.hosts.add(local_origin.removeprefix('http://'))
            self.notifications = Notifications(self.bridge, self.directory,
                lambda: self.gateway.origins, desktop_sessions=self.gateway.desktop_sessions)
            self.gateway.notifications = self.notifications
            self.http_thread = threading.Thread(target=self.gateway.serve_forever, daemon=True)
            self.http_thread.start()
            self.notifications.start()
            self.gateway.desktop_sessions.start()
            self.controller.control({'action': 'enable'})
            self.connector = Connector(self.directory, self.gateway, test_http=self.test_http, config=self.relay_config)
            self.connector.start()
        except Exception:
            self.stop_runtime()
            raise
        return self.status()

    def stop_runtime(self):
        self.pairing = None
        # Stop phone-owned shell jobs before slower native discovery joins.
        # This does not interrupt the Codex desktop's own running conversation.
        if self.bridge is not None:
            self.bridge.terminals.close()
        if self.connector is not None:
            self.connector.close()
            self.connector = None
        if self.gateway is not None:
            if self.http_thread is not None:
                self.gateway.shutdown()
                self.http_thread.join(timeout=5)
            self.gateway.harness.close()
            self.gateway.desktop_sessions.close()
        if self.notifications is not None:
            self.notifications.close()
            self.notifications = None
        if self.bridge is not None:
            self.bridge.accounts.monitor.close()
            self.bridge.close()
            self.bridge = None
        if self.gateway is not None:
            self.gateway.server_close()
            self.gateway = None
        self.http_thread = None

    def stop(self):
        self.stop_runtime()
        if self.relay_config.get('deviceToken'):
            self.controller.control({'action': 'disable'})
        return self.status()

    def pair(self):
        if self.gateway is None:
            raise ValueError('请先开启手机连接。')
        pair = self.controller.control({'action': 'pair'})
        self.pairing = {'url': pair['url'], 'expiresAt': round(pair['expires'] * 1000)}
        return self.status()

    def revoke_device(self, request):
        identifier = request.get('deviceId')
        if not isinstance(identifier, str) or len(identifier) != 32:
            raise ValueError('请选择需要移除的手机。')
        self.controller.control({'action': 'revoke-phone', 'id': identifier})
        return self.status()

    def dispatch(self, action, request):
        if action in ('init', 'save', 'revoke_device'):
            return getattr(self, action)(request)
        if action in ('status', 'start', 'stop', 'pair'):
            return getattr(self, action)()
        raise ValueError('不支持的手机连接操作。')


def main():
    parser = argparse.ArgumentParser(description='Gaoge private mobile connection supervisor')
    parser.add_argument('action', choices=['supervise', 'self-check'])
    parser.add_argument('--data-dir')
    args = parser.parse_args()
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    os.umask(0o077)
    logging.basicConfig(level=logging.ERROR)
    if args.action == 'self-check':
        try:
            with contextlib.redirect_stdout(sys.stderr):
                result = self_check()
        except Exception:
            print(json.dumps({'ok': False, 'error': 'Mobile runtime self-check failed'}))
            return 1
        print(json.dumps(result))
        return 0
    if not args.data_dir:
        parser.error('--data-dir is required for supervise')
    runtime = MobileConnection(args.data_dir)
    output = sys.stdout
    try:
        for line in sys.stdin:
            identifier = None
            try:
                if len(line) > 32768:
                    raise ValueError('请求过大。')
                message = json.loads(line)
                identifier = message.get('id')
                request = message.get('request') or {}
                if not isinstance(request, dict):
                    raise ValueError('请求格式不正确。')
                with contextlib.redirect_stdout(sys.stderr):
                    result = runtime.dispatch(message.get('action'), request)
                response = {'id': identifier, 'ok': True, 'result': result}
            except ValueError as exc:
                response = {'id': identifier, 'ok': False, 'error': str(exc)}
            except Exception:
                response = {'id': identifier, 'ok': False, 'error': '手机连接操作失败，请检查服务配置和网络后重试。'}
            output.write(json.dumps(response, ensure_ascii=False) + '\n')
            output.flush()
    finally:
        # EOF is the parent-death signal. No detached gateway survives the app.
        runtime.stop_runtime()


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--terminal-child':
        if sys.platform == 'win32':
            from bridge.platforms.windows.terminal import child_main
        else:
            from bridge.platforms.posix.terminal import child_main
        child_main(sys.argv[2])
    else:
        raise SystemExit(main())
