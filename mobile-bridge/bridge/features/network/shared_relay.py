"""Opt-in outbound relay connector; only talks to its own authenticated gateway."""
import asyncio
import base64
import json
import os
import re
import threading
import urllib.error
import urllib.request
from pathlib import Path

from relay.protocol import MAX_BODY, MAX_FRAME, origin, validate, decode, content_type, download_headers
from relay.stream import CHUNK, WINDOW, frame
from bridge.features.auth.tls import client_context


def read_config(directory):
    path = Path(directory) / 'shared-relay.json'
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}


def save_config(directory, value, name='shared-relay.json'):
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / name
    temporary = path.with_suffix('.tmp')
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False)
    temporary.chmod(0o600)
    temporary.replace(path)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


class RelayError(ValueError):
    def __init__(self, message, status):
        super().__init__(message)
        self.status = status


class Controller:
    def __init__(self, directory, test_http=False, config=None, save_hook=None):
        self.directory = Path(directory)
        self.test_http = test_http
        self.memory_config = config
        self.save_hook = save_hook

    def read(self):
        return dict(self.memory_config) if self.memory_config is not None else read_config(self.directory)

    def save(self, value):
        if self.save_hook:
            self.save_hook(dict(value))
        if self.memory_config is not None:
            self.memory_config.clear()
            self.memory_config.update(value)
        elif self.save_hook is None:
            save_config(self.directory, value)

    def request(self, url, value, secret=None):
        headers = {'Content-Type': 'application/json'}
        if secret:
            headers['Authorization'] = 'Bearer ' + secret
        req = urllib.request.Request(url, json.dumps(value).encode(), headers)
        opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=client_context()))
        try:
            with opener.open(req, timeout=12) as response:
                return json.loads(response.read(65536))
        except urllib.error.HTTPError as exc:
            raise RelayError('中继拒绝请求，请检查邀请码、授权或服务地址（HTTP %s）。' % exc.code, exc.code) from None
        except (OSError, ValueError):
            raise ValueError('无法连接中继，请检查 HTTPS 地址、证书和网络。') from None

    def control(self, value):
        if not isinstance(value, dict):
            raise ValueError('Invalid relay request')
        action = value.get('action', 'status')
        cfg = self.read()
        if action in ('register', 'register-account'):
            if cfg.get('deviceToken'):
                raise ValueError('请先撤销当前设备，再注册其他中继。')
            if value.get('consent') is not True:
                raise ValueError('请确认允许此中继转发电脑操作。')
            url = origin(value.get('url', ''), self.test_http)
            if action == 'register-account':
                secret = value.get('accountToken')
                if not isinstance(secret, str) or not 16 <= len(secret) <= 8192:
                    raise ValueError('请先登录电脑软件。')
                if not self.test_http and url != 'https://api.gaogeaii.com/mobile':
                    raise ValueError('软件账号只能用于官方手机连接服务。')
                result = self.request(url + '/relay/register-account', {'name': value.get('name')}, secret)
            else:
                result = self.request(url + '/relay/register', {'invitation': value.get('invitation'), 'name': value.get('name')})
            if not all(isinstance(result.get(k), str) and result[k] for k in ('deviceId', 'deviceToken', 'deviceName')):
                raise ValueError('中继注册响应无效。')
            self.save({**result, 'url': url, 'enabled': True})
            return {'registered': True, 'url': url, 'deviceName': result['deviceName'], 'online': False}
        if action == 'status' and not cfg.get('deviceToken'):
            return {'registered': False, 'online': False}
        if not cfg.get('deviceToken'):
            raise ValueError('请先注册共享中继。')
        url = origin(cfg['url'], self.test_http)
        if action == 'disable':
            self.save({**cfg, 'enabled': False})
            return {'registered': True, 'enabled': False, 'online': False}
        if action == 'enable':
            self.save({**cfg, 'enabled': True})
            return {'registered': True, 'enabled': True}
        if action not in ('status', 'pair', 'approve', 'revoke-phone', 'revoke-all', 'revoke'):
            raise ValueError('Unknown relay action')
        if action == 'revoke':
            # Close the local gate first even when the remote service is down.
            self.save({**cfg, 'enabled': False})
        try:
            result = self.request(url + '/relay/device', {'action': action, **{k: value[k] for k in ('id', 'approved') if k in value}}, cfg['deviceToken'])
        except ValueError as exc:
            if action == 'status':
                result = {'deviceName': cfg.get('deviceName', ''), 'online': False, 'error': str(exc), 'pending': [], 'phones': []}
            elif action == 'revoke' and isinstance(exc, RelayError) and exc.status == 401:
                # An administrator may already have revoked this device. Allow
                # removing its invalid local token so a new invite can be used.
                result = {'ok': True}
            else:
                raise
        if action == 'revoke':
            self.save({})
        if action == 'status':
            return {**result, 'registered': True, 'enabled': cfg.get('enabled', False), 'url': url,
                    'phoneUrl': url + '/d/' + cfg['deviceId'] + '/'}
        return result


class Connector:
    def __init__(self, directory, gateway, test_http=False, config=None):
        from bridge.api.httpd import GatewayServer
        self.directory = Path(directory)
        self.memory_config = config
        self.test_http = test_http
        self.config = self.read()
        self.gateway = gateway
        self.origin = origin(self.config['url'], test_http)
        config = {'auth': {'mode': 'password', 'sessionHours': 0}, 'origins': [], 'localAccess': True,
                  'allowedProviders': getattr(gateway, 'allowed_providers', None)}
        self.server = GatewayServer(('127.0.0.1', 0), gateway.bridge, config, gateway.web_dir)
        # Share the live file policy while keeping relay authentication private.
        self.server.transfer_directory = getattr(gateway, 'transfer_directory', None)
        self.server.mobile_updates = getattr(gateway, 'mobile_updates', None)
        self.server.notifications = gateway.notifications
        self.server.desktop_sessions = getattr(gateway, 'desktop_sessions', None)
        self.server.desktop_uploads = getattr(gateway, 'desktop_uploads', None)
        self.server.harness = getattr(gateway, 'harness', None)
        self.local_origin = 'http://127.0.0.1:' + str(self.server.server_port)
        self.server.origins.add(self.local_origin)
        self.server.hosts.add(self.local_origin.removeprefix('http://'))
        self.sessions = {}
        self.closed = threading.Event()
        self.thread = None
        self.http_thread = None
        self.task = None
        self.loop = None

    def read(self):
        return dict(self.memory_config) if self.memory_config is not None else read_config(self.directory)

    def auth_revision(self):
        auth = self.gateway.auth
        if auth.config.get('mode', 'password') != 'password' or not auth.config.get('hash'):
            raise ValueError('手机外网连接需要设置用户名和密码。')
        return auth.identity

    async def authenticate(self, message):
        """The only pre-auth request. Never accepts a path, HTTP method or cookies."""
        identifier = message.get('id', '')
        def result(status, body):
            return {'id': identifier, 'status': status, 'body': base64.b64encode(json.dumps(body).encode()).decode(),
                    'contentType': 'application/json'}
        try:
            if set(message) != {'id', 'type', 'username', 'password', 'address', 'revision'}:
                raise ValueError('Invalid authentication challenge')
            if not self.enabled() or message['revision'] != self.auth_revision():
                raise PermissionError('电脑登录设置已变化，请刷新后重试。')
            username, password, address = message['username'], message['password'], message['address']
            if (not isinstance(username, str) or not 1 <= len(username) <= 200
                    or not isinstance(password, str) or not 1 <= len(password) <= 1000
                    or not isinstance(address, str) or len(address) > 64):
                raise ValueError('Invalid credentials')
            def verify():
                secret, _ = self.gateway.auth.login(username, password, address, 'Mobile relay authentication', remember=False)
                self.gateway.auth.logout(secret)
            await asyncio.to_thread(verify)
            return result(200, {'authenticated': True, 'revision': self.auth_revision()})
        except PermissionError as exc:
            body = {'error': str(exc)}
            if getattr(exc, 'status', None):
                body['loginStatus'] = exc.status
            return result(401, body)
        except (ValueError, KeyError, TypeError):
            return result(400, {'error': 'Invalid authentication challenge'})

    def enabled(self):
        try:
            cfg = self.read()
            return (not self.closed.is_set() and cfg.get('enabled') is True
                    and cfg.get('deviceToken') == self.config['deviceToken'] and cfg.get('url') == self.config['url'])
        except (OSError, ValueError):
            return False

    async def forward(self, client, message, stream=None):
        identifier = message.get('id', '')
        streaming = False
        def result(status, body):
            return {'id': identifier, 'status': status, 'body': base64.b64encode(json.dumps(body).encode()).decode(), 'contentType': 'application/json'}
        try:
            phone = message.get('phone')
            if not isinstance(phone, str) or not re.fullmatch('[a-f0-9]{32}', phone):
                raise ValueError('Invalid phone identity')
            phones = message.get('phones')
            if not isinstance(phones, list) or len(phones) > 16 or phone not in phones or any(not isinstance(p, str) or not re.fullmatch('[a-f0-9]{32}', p) for p in phones):
                raise ValueError('Invalid phone authorizations')
            for previous in list(self.sessions):
                if previous not in phones:
                    self.server.auth.logout(self.sessions.pop(previous)[0])
            body = decode(message.get('body'))
            validate(message.get('method'), message.get('path'), len(body))
            mime = content_type(message.get('contentType'))
            range_headers = download_headers(message.get('headers', {}))
            if not self.enabled():
                return result(503, {'error': '本机共享中继已关闭。'})
            if phone not in self.sessions:
                if len(self.sessions) >= 16:
                    raise ValueError('Too many local phone sessions; reconnect the gateway')
                self.sessions[phone] = self.server.auth.new_session('127.0.0.1', 'Shared relay phone')
            secret, session = self.sessions[phone]
            headers = {'Cookie': self.server.auth.cookie_name + '=' + secret,
                       'Origin': self.local_origin, 'X-CSRF-Token': session['csrf'],
                       'Content-Type': mime, 'Accept-Encoding': 'identity', **range_headers}
            async with client.request(message['method'], self.local_origin + message['path'], headers=headers,
                                      data=body if message['method'] == 'POST' else None, allow_redirects=False) as response:
                if (stream and message.get('stream') is True and message['method'] == 'GET'
                        and response.status in (200, 206) and response.content_length is not None
                        and not response.headers.get('Content-Type', '').startswith('application/json')):
                    ws, credit = stream
                    await ws.send_json({'type': 'start', 'id': identifier, 'status': response.status,
                                        'length': response.content_length,
                                        'contentType': response.headers.get('Content-Type', 'application/octet-stream'),
                                        'disposition': response.headers.get('Content-Disposition', ''),
                                        'headers': download_headers({key: response.headers[key] for key in
                                            ('ETag', 'Content-Range', 'Accept-Ranges') if key in response.headers}, response=True)})
                    streaming = True
                    async for chunk in response.content.iter_chunked(CHUNK):
                        await asyncio.wait_for(credit.acquire(), timeout=90)
                        await ws.send_bytes(frame(identifier, chunk))
                    await ws.send_json({'type': 'end', 'id': identifier})
                    return None
                if (range_headers.get('Range') and range_headers.get('If-Range') and response.status == 200
                        and response.headers.get('Accept-Ranges') == 'bytes' and response.headers.get('ETag')
                        and response.headers['ETag'] != range_headers['If-Range']
                        and response.content_length is not None and response.content_length > MAX_BODY):
                    # The standard full 200 fallback cannot fit one relay frame.
                    # Ask clients to restart at zero instead of retrying forever
                    # with the old validator or buffering an oversized response.
                    return result(409, {'error': '文件已变化，请重新下载。', 'code': 'download_changed'})
                data = bytearray()
                async for chunk in response.content.iter_chunked(65536):
                    data.extend(chunk)
                    if len(data) > MAX_BODY:
                        raise ValueError('Response exceeds shared relay limit (20 MiB)')
                return {'id': identifier, 'status': response.status, 'body': base64.b64encode(data).decode(),
                        'contentType': response.headers.get('Content-Type', 'application/octet-stream'),
                        'disposition': response.headers.get('Content-Disposition', ''),
                        'headers': download_headers({key: response.headers[key] for key in
                            ('ETag', 'Content-Range', 'Accept-Ranges') if key in response.headers}, response=True)}
        except (ValueError, PermissionError, KeyError, TypeError) as exc:
            return result(403, {'error': str(exc)})
        except Exception:
            if streaming:
                await stream[0].send_json({'type': 'abort', 'id': identifier})
                return None
            return result(504, {'error': '电脑网关响应中断，请检查操作结果后再继续。', 'code': 'outcome_unknown'})

    async def run(self):
        import aiohttp
        delay = 1
        trace = aiohttp.TraceConfig()
        async def reject_redirect(session, context, params):
            params.response.close()
            raise ValueError('Relay redirects are not permitted')
        trace.on_request_redirect.append(reject_redirect)
        # Local forwarding deliberately ignores proxy environment variables.
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=80), cookie_jar=aiohttp.DummyCookieJar()) as local:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20),
                                             connector=aiohttp.TCPConnector(ssl=client_context()),
                                             cookie_jar=aiohttp.DummyCookieJar(), trust_env=True,
                                             trace_configs=[trace]) as remote:
                while self.enabled():
                    pending = set()
                    try:
                        async with remote.ws_connect(self.origin + '/relay/device/ws?protocol=2',
                                                     headers={'Authorization': 'Bearer ' + self.config['deviceToken']},
                                                     heartbeat=25, max_msg_size=MAX_FRAME, compress=0) as ws:
                            delay = 1
                            await ws.send_json({'type': 'auth-state', 'revision': self.auth_revision()})
                            seen = set()
                            streams = {}
                            async def advertise():
                                previous = None
                                revision = self.auth_revision()
                                while not ws.closed:
                                    current = self.auth_revision()
                                    if current != revision:
                                        for secret, _ in self.sessions.values():
                                            self.server.auth.logout(secret)
                                        self.sessions.clear()
                                        await ws.send_json({'type': 'auth-state', 'revision': current})
                                        revision = current
                                    discovery = getattr(self.gateway, 'connection_discovery', None)
                                    snapshot = discovery.snapshot() if discovery else None
                                    if snapshot is not None and snapshot != previous:
                                        await ws.send_json(snapshot)
                                        previous = snapshot
                                    await asyncio.sleep(5)
                            publication = asyncio.create_task(advertise())
                            pending.add(publication)
                            async def handle(value):
                                credit = streams[value['id']][1]
                                try:
                                    reply = (await self.authenticate(value) if value.get('type') == 'authenticate'
                                             else await self.forward(local, value, (ws, credit)))
                                    if reply is not None and not ws.closed:
                                        await ws.send_json(reply)
                                finally:
                                    streams.pop(value['id'], None)
                            while self.enabled():
                                try:
                                    message = await asyncio.wait_for(ws.receive(), timeout=1)
                                except asyncio.TimeoutError:
                                    continue
                                if message.type != aiohttp.WSMsgType.TEXT:
                                    break
                                value = json.loads(message.data)
                                identifier = value.get('id')
                                if value.get('type') in ('ack', 'cancel'):
                                    transfer = streams.get(identifier)
                                    if transfer:
                                        if value['type'] == 'cancel':
                                            # Cancellation only applies to an explicitly streamed read.
                                            if transfer[2]:
                                                transfer[0].cancel()
                                        else:
                                            transfer[1].release()
                                    continue
                                if not isinstance(identifier, str) or len(identifier) > 128 or identifier in seen:
                                    raise ValueError('Invalid or repeated request ID')
                                # Bounded replay set. Reconnect rather than forget old IDs.
                                if len(seen) >= 100000 or len(streams) >= 12:
                                    break
                                seen.add(identifier)
                                task = asyncio.create_task(handle(value))
                                streams[identifier] = (task, asyncio.BoundedSemaphore(WINDOW), value.get('stream') is True and value.get('method') == 'GET')
                                pending.add(task)
                                def complete(task):
                                    pending.discard(task)
                                    if not task.cancelled():
                                        task.exception()
                                task.add_done_callback(complete)
                    except (aiohttp.ClientError, OSError, ValueError, asyncio.TimeoutError):
                        pass
                    finally:
                        for task in pending:
                            task.cancel()
                        await asyncio.gather(*pending, return_exceptions=True)
                    # No replay of any in-flight request after disconnection.
                    for _ in range(delay):
                        if not self.enabled():
                            break
                        await asyncio.sleep(1)
                    delay = min(30, delay * 2)

    def start(self):
        import aiohttp  # Fail locally before starting a background thread if not installed.
        self.http_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.http_thread.start()
        def worker():
            async def main():
                self.loop = asyncio.get_running_loop()
                self.task = asyncio.current_task()
                try:
                    while not self.closed.is_set():
                        cfg = self.read()
                        if cfg.get('enabled') and cfg.get('deviceToken'):
                            if cfg.get('deviceToken') != self.config.get('deviceToken') or cfg.get('url') != self.config.get('url'):
                                for secret, _ in self.sessions.values():
                                    self.server.auth.logout(secret)
                                self.sessions.clear()
                                self.origin = origin(cfg['url'], self.test_http)
                                self.config = cfg
                            await self.run()
                        await asyncio.sleep(1)
                except asyncio.CancelledError:
                    pass
            asyncio.run(main())
        self.thread = threading.Thread(target=worker, daemon=True)
        self.thread.start()

    def close(self):
        self.closed.set()
        if self.loop and self.loop.is_running() and self.task:
            self.loop.call_soon_threadsafe(self.task.cancel)
        if self.thread:
            self.thread.join(timeout=5)
        if self.http_thread:
            self.server.shutdown()
            self.http_thread.join(timeout=5)
        self.server.server_close()


def start(directory, gateway, test_http=False, config=None):
    if not (config if config is not None else read_config(directory)).get('deviceToken'):
        return None
    connector = Connector(directory, gateway, test_http=test_http, config=config)
    try:
        connector.start()
    except Exception:
        connector.close()
        raise
    return connector
