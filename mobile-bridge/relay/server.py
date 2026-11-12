"""Headless HTTPS-edge relay. Devices execute tasks; this service only routes."""
import asyncio
import base64
import hmac
import hashlib
import json
import ipaddress
import re
import time
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import web, WSMsgType
from bridge.api.html_preview import SHELL_PATH, SHELL_FILE, SHELL_CSP
from .protocol import MAX_BODY, MAX_FRAME, origin, validate, decode, content_type, download_headers
from .registry import Registry, token, PHONE_LIFETIME
from .stream import WINDOW, unpack
from .accounts import AccountVerifier, account_owner

# Same host-only cookie name as the existing native clients; relay token space
# is independent and the connector never forwards this cookie to the computer.
COOKIE = 'codex_mobile_session'
ROOT = Path(__file__).resolve().parents[1]


def security_headers(origin, scope=''):
    return {'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
            'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src " + origin + scope + SHELL_PATH + "; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"}


class Relay:
    def __init__(self, directory, public_origin, test_http=False, timeout=90, account_verifier=None):
        self.base_url = origin(public_origin, test_http)
        parsed = urlsplit(self.base_url)
        self.prefix = parsed.path
        self.origin = parsed.scheme + '://' + parsed.netloc
        self.host = urlsplit(self.origin).netloc
        self.secure = self.origin.startswith('https://')
        self.registry = Registry(directory)
        self.devices = {}
        self.protocols = {}
        self.auth_revisions = {}
        self.discovery = {}
        self.pending = {}
        self.timeout = timeout
        self.attempts = {}
        self.buffered = 0
        if account_verifier is not None and not test_http:
            raise ValueError('Custom account verifier is only available to loopback tests')
        self.account_verifier = account_verifier or AccountVerifier()

    def same_origin(self, request):
        if request.headers.get('Origin') != self.origin:
            raise PermissionError('Same-origin request required')

    def rate_limit(self, request):
        now = time.monotonic()
        self.attempts = {k: v for k, v in self.attempts.items() if v[0] > now - 60}
        key = self.client_address(request)
        start, count = self.attempts.get(key, (now, 0))
        if count >= 30 or (key not in self.attempts and len(self.attempts) >= 4096):
            raise web.HTTPTooManyRequests()
        self.attempts[key] = start, count + 1

    def client_address(self, request):
        # Production service binds loopback; nginx overwrites X-Real-IP.
        peer = ipaddress.ip_address(request.remote or '127.0.0.1')
        supplied = request.headers.get('X-Real-IP')
        if peer.is_loopback and supplied:
            return str(ipaddress.ip_address(supplied))
        return str(peer)

    def online(self, identifier):
        return identifier in self.devices and identifier in self.auth_revisions

    async def body(self, request):
        if request.content_length is None or request.content_length > 4096:
            raise ValueError('Invalid control request size')
        value = await request.json()
        if not isinstance(value, dict):
            raise ValueError('JSON object required')
        return value

    def device_auth(self, request):
        authorization = request.headers.get('Authorization', '')
        if not authorization.startswith('Bearer '):
            raise PermissionError('Device token required')
        return self.registry.device(authorization[7:])

    def phone_auth(self, request):
        scope = request.match_info.get('device')
        # Browsers can send a legacy root cookie alongside a scoped cookie of
        # the same name. Inspect each, never let the root cookie select a device.
        row = None
        for part in request.headers.get('Cookie', '')[:8192].split(';'):
            name, _, secret = part.strip().partition('=')
            if name != COOKIE:
                continue
            try:
                candidate = self.registry.phone(secret)
            except (PermissionError, ValueError):
                continue
            if not scope or candidate['device'] == scope:
                row = candidate
                request['phone_token'] = secret
                break
        if row is None:
            raise PermissionError('Phone authorization expired or belongs to another computer')
        if request.method != 'GET':
            self.same_origin(request)
            if not hmac.compare_digest(request.headers.get('X-CSRF-Token', '').encode(), row['csrf'].encode()):
                raise PermissionError('CSRF validation failed')
        return row

    def scope(self, request):
        identifier = request.match_info.get('device')
        return self.prefix + ('/d/' + identifier if identifier else '')

    def api_path(self, request):
        return request.path_qs[len(self.scope(request)):]

    def renew(self, request, response, phone):
        if not self.registry.renew_phone(phone) and not self.api_path(request).startswith('/api/auth'):
            return response
        response.set_cookie(COOKIE, request['phone_token'], httponly=True, secure=self.secure,
                            samesite='Strict', path=self.scope(request) + '/',
                            max_age=phone.get('lifetime', PHONE_LIFETIME) if phone.get('persistent', True) else None)
        return response

    def fail(self, device, phone=None):
        for item in list(self.pending.values()):
            if item['device'] == device and (phone is None or item['phone'] == phone):
                if not item['future'].done():
                    item['future'].set_exception(ConnectionError('Device disconnected'))
                if item.get('queue') is not None:
                    item['failed'] = True
                    try:
                        item['queue'].put_nowait(None)
                    except asyncio.QueueFull:
                        pass

    async def register(self, request):
        self.rate_limit(request)
        value = await self.body(request)
        if set(value) != {'invitation', 'name'}:
            raise ValueError('Invitation and device name required')
        return web.json_response(self.registry.register(value['invitation'], value['name']), status=201)

    async def register_account(self, request):
        self.rate_limit(request)
        value = await self.body(request)
        authorization = request.headers.get('Authorization', '')
        if (not authorization.startswith('Bearer ') or not 16 <= len(authorization[7:]) <= 8192
                or any(c.isspace() for c in authorization[7:]) or set(value) != {'name'}):
            raise PermissionError('请先登录电脑软件。')
        verified = await self.account_verifier(authorization[7:])
        owner = account_owner(verified)
        return web.json_response(self.registry.register_account(owner, value['name']), status=201)

    async def action(self, request):
        device = self.device_auth(request)
        value = await self.body(request)
        action = value.get('action')
        result = {'ok': True}
        if action == 'status':
            result = {'deviceName': device['name'], 'online': self.online(device['id']),
                      'pending': self.registry.pending(device['id']), 'phones': self.registry.phones(device['id'])}
        elif action == 'pair':
            if not self.online(device['id']):
                raise web.HTTPServiceUnavailable(reason='电脑尚未连接，请稍后刷新二维码。')
            result = self.registry.pair(device['id'])
            result['url'] = self.base_url + '/d/' + device['id'] + '/#pair=' + result.pop('token')
        elif action == 'approve':
            self.registry.approve(device['id'], value.get('id'), value.get('approved'))
        elif action == 'revoke-phone':
            self.registry.revoke_phone(device['id'], value.get('id'))
            self.fail(device['id'], value.get('id'))
        elif action == 'revoke-all':
            self.registry.revoke_all(device['id'])
            self.fail(device['id'])
        elif action == 'revoke':
            self.registry.revoke(device['id'])
            self.fail(device['id'])
            ws = self.devices.get(device['id'])
            if ws is not None:
                await ws.close()
        else:
            raise ValueError('Unknown device action')
        return web.json_response(result)

    async def claim(self, request):
        self.same_origin(request)
        self.rate_limit(request)
        value = await self.body(request)
        return web.json_response(self.registry.claim(value.get('token'), value.get('name')))

    async def claim_status(self, request):
        self.same_origin(request)
        value = await self.body(request)
        result, secret = self.registry.consume(value.get('claim'), request.match_info.get('device'))
        result['base'] = self.scope(request) + '/'
        response = web.json_response(result)
        if secret:
            response.set_cookie(COOKIE, secret, httponly=True, secure=self.secure,
                                samesite='Strict', path=self.scope(request) + '/', max_age=PHONE_LIFETIME)
        return response

    async def auth(self, request):
        try:
            phone = self.phone_auth(request)
        except PermissionError:
            identifier = request.match_info.get('device', '')
            return web.json_response({'authenticated': False, 'relay': True, 'passwordRequired': True,
                                      'passwordless': False, 'instanceId': 'relay:' + identifier,
                                      'online': self.online(identifier)})
        return self.renew(request, web.json_response({'authenticated': True, 'csrf': phone['csrf'], 'relay': True,
                                  'trustedDevice': True, 'passwordless': False, 'instanceId': 'relay:' + phone['device'],
                                  'computer': {'name': phone['computer_name']},
                                  'transport': 'poll', 'deviceId': phone['device'],
                                  'draftIdentity': hashlib.sha256(('relay:' + phone['device'] + ':' + phone['id']).encode()).hexdigest(),
                                  'listCacheIdentity': hashlib.sha256(('relay-list:' + phone['device'] + ':' + phone['id']).encode()).hexdigest(),
                                  'online': self.online(phone['device'])}), phone)

    def login_response(self, request, result, secret):
        response = web.json_response(result)
        phone = self.registry.phone(secret)
        response.set_cookie(COOKIE, secret, httponly=True, secure=self.secure, samesite='Strict',
                            path=self.scope(request) + '/', max_age=phone['lifetime'] if phone['persistent'] else None)
        return response

    async def pair(self, request):
        self.same_origin(request)
        self.rate_limit(request)
        device = request.match_info['device']
        if not self.online(device):
            raise web.HTTPServiceUnavailable(reason='电脑离线，请在电脑上开启手机连接。')
        value = await self.body(request)
        if set(value) - {'token', 'name'}:
            raise ValueError('Invalid pairing request')
        result, secret = self.registry.exchange_pair(device, value.get('token'), value.get('name', '我的手机'))
        return self.login_response(request, result, secret)

    async def login(self, request):
        self.same_origin(request)
        self.rate_limit(request)
        value = await self.body(request)
        if set(value) - {'username', 'password', 'remember'} or type(value.get('remember', False)) is not bool:
            raise ValueError('Invalid login request')
        username, password = value.get('username'), value.get('password')
        if (not isinstance(username, str) or not 1 <= len(username) <= 200
                or not isinstance(password, str) or not 1 <= len(password) <= 1000):
            raise ValueError('请输入用户名和密码。')
        device = request.match_info['device']
        if not self.online(device):
            raise web.HTTPServiceUnavailable(reason='电脑离线，请在电脑上开启手机连接。')
        if len(self.pending) >= 64 or sum(i['device'] == device for i in self.pending.values()) >= 12:
            raise web.HTTPTooManyRequests()
        ws, revision = self.devices[device], self.auth_revisions[device]
        identifier = token()
        future = asyncio.get_running_loop().create_future()
        item = {'device': device, 'phone': None, 'ws': ws, 'future': future,
                'response_size': 0, 'stream': False}
        self.pending[identifier] = item
        try:
            await asyncio.wait_for(ws.send_json({'type': 'authenticate', 'id': identifier, 'username': username,
                'password': password, 'address': self.client_address(request), 'revision': revision}), timeout=10)
            status, body, mime, _, _ = await asyncio.wait_for(future, timeout=self.timeout)
            if status != 200:
                return web.Response(status=status, body=body, content_type='application/json')
            verified = json.loads(body)
            if (verified.get('authenticated') is not True or verified.get('revision') != revision
                    or self.auth_revisions.get(device) != revision or self.devices.get(device) is not ws
                    or not self.registry.active(device)):
                raise PermissionError('电脑登录设置已变化，请重新登录。')
            agent = request.headers.get('User-Agent', '')
            name = 'iPhone' if 'iPhone' in agent else 'Android 手机' if 'Android' in agent else '手机浏览器'
            result, secret = self.registry.password_phone(device, name, value.get('remember', False))
            return self.login_response(request, result, secret)
        except (asyncio.TimeoutError, ConnectionError, OSError):
            raise web.HTTPServiceUnavailable(reason='电脑连接中断，请稍后重新登录。') from None
        finally:
            self.pending.pop(identifier, None)
            self.buffered -= item['response_size']
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                future.exception()

    async def logout(self, request):
        phone = self.phone_auth(request)
        self.registry.revoke_phone(phone['device'], phone['id'])
        self.fail(phone['device'], phone['id'])
        response = web.json_response({'ok': True})
        response.del_cookie(COOKIE, path=self.scope(request) + '/')
        return response

    async def discover(self, request):
        # Opaque read-only capability. Never accepts a phone login cookie as a
        # discovery key, and never discloses endpoints without a valid grant.
        identifier = request.match_info['device']
        value = self.discovery.get(identifier)
        supplied = request.headers.get('X-Discovery-Key', '')
        if (len(supplied) != 64 or identifier not in self.devices or not self.registry.active(identifier)
                or value is None or hashlib.sha256(supplied.encode()).hexdigest() not in value['grants']):
            raise PermissionError('Address discovery unavailable')
        return web.json_response({'deviceId': identifier, 'endpoints': value['endpoints'],
                                  'relay': self.base_url + '/d/' + identifier})

    async def websocket(self, request):
        device = self.device_auth(request)
        if request.headers.get('Origin'):
            raise PermissionError('Device connection cannot originate in a browser')
        if len(self.devices) >= 200 and device['id'] not in self.devices:
            raise web.HTTPServiceUnavailable(reason='Online device limit reached')
        ws = web.WebSocketResponse(heartbeat=25, max_msg_size=MAX_FRAME, compress=False)
        await ws.prepare(request)
        old = self.devices.get(device['id'])
        self.devices[device['id']] = ws
        self.auth_revisions.pop(device['id'], None)
        self.discovery.pop(device['id'], None)
        self.protocols[device['id']] = request.query.get('protocol') == '2'
        if old is not None:
            self.fail(device['id'])
            await old.close()
        try:
            async for msg in ws:
                if msg.type not in (WSMsgType.TEXT, WSMsgType.BINARY):
                    break
                if not self.registry.active(device['id']):
                    break
                try:
                    if msg.type == WSMsgType.BINARY:
                        identifier, chunk = unpack(msg.data)
                        item = self.pending.get(identifier)
                        if item is None:
                            continue
                        if item['device'] != device['id'] or item['ws'] is not ws or item.get('queue') is None or item.get('ended'):
                            raise ValueError('Unexpected download chunk')
                        item['received'] += len(chunk)
                        if item['received'] > item['length']:
                            raise ValueError('Download exceeds declared length')
                        item['queue'].put_nowait(chunk)
                        continue
                    value = json.loads(msg.data)
                    if value.get('type') == 'auth-state':
                        revision = value.get('revision')
                        if not isinstance(revision, str) or not re.fullmatch('[a-f0-9]{64}', revision):
                            raise ValueError('Invalid desktop authentication identity')
                        if self.registry.set_auth_revision(device['id'], revision):
                            self.fail(device['id'])
                        self.auth_revisions[device['id']] = revision
                        continue
                    if value.get('type') == 'discovery':
                        endpoints, grants = value.get('endpoints'), value.get('grants')
                        if not isinstance(endpoints, list) or len(endpoints) > 16 or not isinstance(grants, list) or len(grants) > 512:
                            raise ValueError('Invalid discovery metadata')
                        for endpoint in endpoints:
                            p = urlsplit(endpoint)
                            if len(endpoint) > 2048 or p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password or p.path or p.query or p.fragment:
                                raise ValueError('Invalid discovery endpoint')
                        if any(not isinstance(g, str) or not re.fullmatch('[a-f0-9]{64}', g) for g in grants):
                            raise ValueError('Invalid discovery grant')
                        self.discovery[device['id']] = {'endpoints': endpoints, 'grants': set(grants)}
                        continue
                    item = self.pending.get(value.get('id'))
                    if item is None or item['device'] != device['id'] or item['ws'] is not ws:
                        continue
                    if value.get('type') == 'abort' and item.get('queue') is not None:
                        item['failed'] = True
                        item['queue'].put_nowait(None)
                        continue
                    if value.get('type') == 'end':
                        if item.get('queue') is None or item.get('ended') or item['received'] != item['length']:
                            raise ValueError('Incomplete download')
                        item['ended'] = True
                        item['queue'].put_nowait(None)
                        continue
                    if item['future'].done():
                        continue
                    status = value.get('status')
                    if type(status) is not int or not 200 <= status <= 599 or 300 <= status < 400:
                        raise ValueError('Invalid upstream status')
                    streaming = value.get('type') == 'start'
                    if streaming:
                        length = value.get('length')
                        if not item['stream'] or type(length) is not int or not 0 <= length <= 9007199254740991:
                            raise ValueError('Invalid download length')
                        item.update(queue=asyncio.Queue(maxsize=WINDOW + 1), length=length, received=0)
                    body = b'' if streaming else decode(value.get('body'))
                    mime = content_type(value.get('contentType'))
                    if self.buffered + len(body) > 128 * 1024 * 1024:
                        raise ValueError('Relay response buffer is full')
                    self.buffered += len(body)
                    item['response_size'] = len(body)
                    disposition = value.get('disposition', '')
                    if not isinstance(disposition, str) or len(disposition) > 4096 or '\r' in disposition or '\n' in disposition:
                        raise ValueError('Invalid download header')
                    headers = download_headers(value.get('headers', {}), response=True)
                    item['future'].set_result((status, body, mime, disposition, headers))
                except (ValueError, TypeError, AttributeError, asyncio.QueueFull):
                    break
        finally:
            if self.devices.get(device['id']) is ws:
                del self.devices[device['id']]
                self.protocols.pop(device['id'], None)
                self.auth_revisions.pop(device['id'], None)
                self.discovery.pop(device['id'], None)
                self.fail(device['id'])
            await ws.close()
        return ws

    async def forward(self, request):
        phone = self.phone_auth(request)
        length = request.content_length or 0
        path = self.api_path(request)
        try:
            validate(request.method, path, length)
        except PermissionError as exc:
            # A valid login does not expire when a capability is unavailable.
            raise web.HTTPForbidden(reason=str(exc)) from None
        if request.headers.get('Transfer-Encoding') or (request.method == 'POST' and request.content_length is None):
            raise ValueError('A bounded Content-Length is required')
        ws = self.devices.get(phone['device'])
        if ws is None or not self.online(phone['device']):
            return web.json_response({'error': '电脑离线，请保持 Codex 和电脑网关运行。', 'code': 'device_offline'}, status=503)
        if len(self.pending) >= 64 or sum(i['device'] == phone['device'] for i in self.pending.values()) >= 12:
            raise web.HTTPTooManyRequests()
        if self.buffered + length > 128 * 1024 * 1024:
            raise web.HTTPTooManyRequests()
        identifier = token()
        future = asyncio.get_running_loop().create_future()
        item = {'device': phone['device'], 'phone': phone['id'], 'ws': ws, 'future': future, 'response_size': 0}
        item['stream'] = request.method == 'GET' and self.protocols.get(phone['device'], False)
        self.pending[identifier] = item
        self.buffered += length
        try:
            body = await request.read()
            mime = content_type(request.headers.get('Content-Type', 'application/json'))
            headers = download_headers({key: ','.join(request.headers.getall(key)) for key in
                                        ('Range', 'If-Range') if key in request.headers})
            await asyncio.wait_for(ws.send_json({'id': identifier, 'phone': phone['id'], 'method': request.method,
                                                'phones': [p['id'] for p in self.registry.phones(phone['device'])],
                                                'path': path, 'body': base64.b64encode(body).decode(),
                                                'contentType': mime, 'headers': headers, 'stream': item['stream']}), timeout=10)
            status, response, mime, disposition, range_headers = await asyncio.wait_for(future, timeout=self.timeout)
            # Revocation also applies to a response already in flight.
            self.phone_auth(request)
            headers = {'Content-Type': mime, **range_headers}
            if disposition:
                headers['Content-Disposition'] = disposition
            if item.get('queue') is not None:
                result = web.StreamResponse(status=status, headers={**headers, 'Content-Length': str(item['length']),
                                            **security_headers(self.origin, self.scope(request))})
                self.renew(request, result, phone)
                await result.prepare(request)
                try:
                    while True:
                        chunk = await asyncio.wait_for(item['queue'].get(), timeout=self.timeout)
                        self.phone_auth(request)
                        if item.get('failed'):
                            raise ConnectionError('Device disconnected')
                        if chunk is None:
                            break
                        await result.write(chunk)
                        await asyncio.wait_for(ws.send_json({'type': 'ack', 'id': identifier}), timeout=10)
                    await result.write_eof()
                except (asyncio.TimeoutError, ConnectionError, OSError, PermissionError):
                    # Never append a JSON error to a partially delivered file.
                    if request.transport is not None:
                        request.transport.close()
                return result
            return self.renew(request, web.Response(status=status, body=response, headers=headers), phone)
        except (asyncio.TimeoutError, ConnectionError, OSError):
            unknown = request.method == 'POST'
            return web.json_response({'error': '连接中断，操作结果待确认，请先查看状态，勿重复提交。' if unknown else '电脑连接中断，请稍后刷新。',
                                      'code': 'outcome_unknown' if unknown else 'device_offline'}, status=504 if unknown else 503)
        finally:
            self.pending.pop(identifier, None)
            if item['stream'] and not ws.closed:
                try:
                    await asyncio.wait_for(ws.send_json({'type': 'cancel', 'id': identifier}), timeout=2)
                except (asyncio.TimeoutError, ConnectionError, OSError):
                    pass
            self.buffered -= length + item['response_size']
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                future.exception()

    async def page(self, request):
        scope = self.scope(request)
        path = request.path[len(scope):]
        if path == SHELL_PATH:
            if request.query_string:
                raise web.HTTPNotFound()
            self.phone_auth(request)
            return web.Response(body=(ROOT/'web'/SHELL_FILE).read_bytes(), content_type='text/html',
                                headers={'Content-Security-Policy': SHELL_CSP, 'X-Frame-Options': 'SAMEORIGIN'})
        if path == '/relay/admin':
            raise web.HTTPFound(self.prefix + '/relay/admin/')
        if path in ('/relay/', '/relay/pair.js', '/relay/mode.js'):
            name = {'/relay/': 'index.html', '/relay/pair.js': 'pair.js', '/relay/mode.js': 'mode.js'}[path]
            mime = 'text/html' if name.endswith('.html') else 'text/javascript'
            contents = (ROOT/'relay'/'web'/name).read_text(encoding='utf-8')
            if name.endswith('.html'):
                contents = self.html_paths(contents)
            return web.Response(text=contents, content_type=mime)
        # Serve the same v2 web assets; execution and authentication stay on devices.
        from bridge.api.assets import STATIC, FONT_ROUTE, PDF_CMAP_ROUTE, PDF_FONT_ROUTE, asset_bytes
        if path in ('/', '/index.html'):
            if not request.match_info.get('device'):
                return web.Response(text='请使用电脑软件生成的手机连接地址。', content_type='text/plain')
            html = (ROOT/'web/index.html').read_text(encoding='utf-8')
            html = html.replace('<head>', '<head><script src="/relay/mode.js"></script>', 1)
            html = self.html_paths(html).replace('href="' + self.prefix + '/manifest.webmanifest"',
                                                'href="' + scope + '/manifest.webmanifest"')
            return web.Response(text=html, content_type='text/html')
        if path == '/manifest.webmanifest':
            manifest = json.loads((ROOT/'web/manifest.webmanifest').read_text(encoding='utf-8'))
            manifest.update(id=scope + '/', start_url=scope + '/', scope=scope + '/')
            for icon in manifest.get('icons', []):
                icon['src'] = self.prefix + '/' + icon['src'].lstrip('/')
            return web.json_response(manifest, content_type='application/manifest+json')
        if path in STATIC:
            _, mime = STATIC[path]
            body = asset_bytes(ROOT/'web', path)
            etag = '"' + hashlib.sha256(body).hexdigest() + '"'
            headers = {'Content-Type': mime, 'ETag': etag, 'Cache-Control': 'public, max-age=0, must-revalidate'}
            if request.headers.get('If-None-Match') == etag:
                return web.Response(status=304, headers=headers)
            response = web.Response(body=body, headers=headers)
            if len(body) > 1024 and mime.startswith(('text/', 'application/javascript', 'application/json')):
                response.enable_compression()
            return response
        match = FONT_ROUTE.fullmatch(path)
        if match:
            return web.FileResponse(ROOT/'web/vendor/katex/fonts'/match[1])
        cmap = PDF_CMAP_ROUTE.fullmatch(path)
        if cmap:
            file = ROOT/'web/vendor/pdfjs/cmaps'/cmap[1]
            if file.is_file():
                return web.FileResponse(file, headers={'Content-Type': 'application/octet-stream'})
        pdf_font = PDF_FONT_ROUTE.fullmatch(path)
        if pdf_font:
            file = ROOT/'web/vendor/pdfjs/standard_fonts'/pdf_font[1]
            if file.is_file():
                return web.FileResponse(file, headers={'Content-Type': 'font/ttf' if file.suffix == '.ttf' else 'application/octet-stream'})
        raise web.HTTPNotFound()

    def html_paths(self, html):
        # Assets are public and shared; APIs/cookies remain scoped to one device.
        return re.sub(r'((?:src|href)=(["\']))/(?!/)', lambda match: match[1] + self.prefix + '/', html)

    async def maintenance(self):
        while True:
            await asyncio.sleep(5)
            for identifier, ws in list(self.devices.items()):
                if not self.registry.active(identifier):
                    self.fail(identifier)
                    await ws.close()


STATE = web.AppKey('relay', Relay)


def create_app(directory, public_origin, test_http=False, timeout=90, account_verifier=None):
    state = Relay(directory, public_origin, test_http, timeout, account_verifier)

    @web.middleware
    async def boundary(request, handler):
        try:
            if request.host != state.host:
                raise PermissionError('Unrecognized relay host')
            supplied = request.headers.get('Origin')
            if supplied and supplied != state.origin:
                raise PermissionError('Unrecognized origin')
            if request.headers.get('Sec-Fetch-Site') == 'cross-site':
                raise PermissionError('Cross-site access denied')
            if any(value.strip().lower() != 'identity' for value in request.headers.getall('Content-Encoding', [])):
                raise web.HTTPUnsupportedMediaType(reason='Compressed request bodies are not supported')
            response = await handler(request)
        except PermissionError as exc:
            response = web.json_response({'error': str(exc)}, status=401)
        except (ValueError, TypeError, KeyError) as exc:
            response = web.json_response({'error': str(exc)}, status=400)
        except web.HTTPException as exc:
            if 300 <= exc.status < 400:
                response = exc
            else:
                response = web.json_response({'error': exc.reason}, status=exc.status)
        if not response.prepared:
            defaults = security_headers(state.origin, state.scope(request))
            for key, value in defaults.items():
                response.headers.setdefault(key, value)
        return response

    # Content-Length and the shared buffer budget must describe the same bytes.
    # Disable decompression before parsing, including unauthenticated requests.
    app = web.Application(middlewares=[boundary], client_max_size=MAX_BODY + 1,
                          handler_args={'auto_decompress': False})
    app[STATE] = state
    from .admin import Admin
    Admin(state).routes(app)
    prefix = state.prefix
    app.router.add_post(prefix + '/relay/register', state.register)
    app.router.add_post(prefix + '/relay/register-account', state.register_account)
    app.router.add_post(prefix + '/relay/device', state.action)
    app.router.add_get(prefix + '/relay/device/ws', state.websocket)
    app.router.add_post(prefix + '/relay/claim', state.claim)
    app.router.add_post(prefix + '/relay/claim-status', state.claim_status)
    app.router.add_get(prefix + '/relay/discover/{device:[a-f0-9]{32}}', state.discover)
    scope = prefix + '/d/{device:[a-f0-9]{32}}'
    app.router.add_post(scope + '/relay/claim', state.claim)
    app.router.add_post(scope + '/relay/claim-status', state.claim_status)
    app.router.add_get(scope + '/api/auth', state.auth)
    app.router.add_post(scope + '/api/login', state.login)
    app.router.add_post(scope + '/api/pair', state.pair)
    app.router.add_post(scope + '/api/logout', state.logout)
    app.router.add_route('*', scope + '/api/{path:.*}', state.forward)
    app.router.add_get(scope + '/{path:.*}', state.page)
    async def health(request):
        return web.json_response({'ok': True, 'service': 'codex-bridge-relay'})
    app.router.add_get(prefix + '/health', health)
    app.router.add_get(prefix + '/{path:.*}', state.page)

    async def shutdown(app):
        for identifier, ws in list(state.devices.items()):
            state.fail(identifier)
            await ws.close()

    async def lifecycle(app):
        task = asyncio.create_task(state.maintenance())
        yield
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        for ws in list(state.devices.values()):
            await ws.close()
        state.registry.close()

    app.cleanup_ctx.append(lifecycle)
    app.on_shutdown.append(shutdown)
    return app
