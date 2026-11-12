"""Loopback integration tests: real aiohttp relay, WSS connector and HTTP gateway.

Fixtures never inspect or operate a user's Codex, chats or model credentials.
"""
import asyncio
import base64
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import aiohttp
from aiohttp.test_utils import TestClient, TestServer

from bridge.api.httpd import GatewayServer
from bridge.features.auth.auth import Auth, password_record
from bridge.features.network.shared_relay import Connector, Controller
from relay.protocol import origin, validate
from relay.accounts import account_owner
from relay.server import COOKIE, STATE, create_app

ROOT = Path(__file__).resolve().parents[1]
PASSWORD = 'fixture-phone-pass-2026'
THREAD = '11111111-1111-4111-8111-111111111111'


class PhoneRelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / 'relay', 'http://127.0.0.1:1/mobile', test_http=True, timeout=3)
        self.server = TestServer(self.app)
        await self.server.start_server()
        self.origin = str(self.server.make_url('')).rstrip('/')
        self.base = self.origin + '/mobile'
        self.state = self.app[STATE]
        self.state.origin, self.state.base_url = self.origin, self.base
        self.state.host = self.origin.removeprefix('http://')
        self.client = TestClient(self.server, cookie_jar=aiohttp.DummyCookieJar())
        await self.client.start_server()
        self.connectors, self.gateways, self.created = [], [], []
        self.password_config = {'mode': 'password', 'username': 'phone-user', 'sessionHours': 12,
                                **await asyncio.to_thread(password_record, PASSWORD)}

    async def asyncTearDown(self):
        for connector in self.connectors:
            await asyncio.to_thread(connector.close)
        for gateway in self.gateways:
            gateway.server_close()
        await self.client.close()
        self.temp.cleanup()

    async def wait_online(self, device):
        for _ in range(150):
            if self.state.online(device['deviceId']):
                return
            await asyncio.sleep(.02)
        self.fail('Connector did not finish authenticated handshake')

    async def device(self, name='Fixture'):
        invite = self.state.registry.invite(name)['invitation']
        response = await self.client.post('/mobile/relay/register', json={'name': name, 'invitation': invite})
        self.assertEqual(response.status, 201)
        device = await response.json()
        directory = Path(self.temp.name) / device['deviceId']
        directory.mkdir()
        bridge = SimpleNamespace(host_errors=[])
        bridge.list = lambda **kwargs: ([{'title': name, 'id': THREAD}], [])
        bridge.create_chat = lambda project, title, identifier: self.created.append((name, identifier)) or {'id': identifier}
        bridge.for_host = lambda host: bridge
        bridge.terminal = lambda thread, owner, action, body: {'owner': owner, 'action': action}
        gateway = GatewayServer(('127.0.0.1', 0), bridge, {'auth': dict(self.password_config), 'origins': [],
                                'allowedProviders': ['codex']}, ROOT / 'web')
        self.gateways.append(gateway)
        memory = {**device, 'url': self.base, 'enabled': True}
        connector = Connector(directory, gateway, test_http=True, config=memory)
        self.connectors.append(connector)
        connector.start()
        await self.wait_online(device)
        self.assertFalse((directory / 'shared-relay.json').exists())
        return device, connector

    def scope(self, device):
        return '/mobile/d/' + device['deviceId']

    async def action(self, device, action, **value):
        return await self.client.post('/mobile/relay/device', json={'action': action, **value},
                                      headers={'Authorization': 'Bearer ' + device['deviceToken']})

    async def login(self, device, password=PASSWORD, **extra):
        return await self.client.post(self.scope(device) + '/api/login', json={
            'username': 'phone-user', 'password': password, 'remember': True, **extra}, headers={'Origin': self.origin})

    async def headers(self, response):
        self.assertEqual(response.status, 200, await response.text())
        value = await response.json()
        self.assertIn('HttpOnly', response.headers['Set-Cookie'])
        self.assertIn('SameSite=Strict', response.headers['Set-Cookie'])
        return {'Cookie': COOKIE + '=' + response.cookies[COOKIE].value,
                'Origin': self.origin, 'X-CSRF-Token': value['csrf']}

    async def pair(self, device):
        response = await self.action(device, 'pair')
        self.assertEqual(response.status, 200, await response.text())
        pair = await response.json()
        self.assertTrue(pair['url'].startswith(self.base + '/d/' + device['deviceId'] + '/#pair='))
        return pair['url'].split('#pair=')[1]

    async def exchange(self, device, token):
        return await self.client.post(self.scope(device) + '/api/pair', json={'token': token}, headers={'Origin': self.origin})

    async def test_password_login_real_gateway_read_write_and_isolated_owners(self):
        device, connector = await self.device()
        auth = await (await self.client.get(self.scope(device) + '/api/auth')).json()
        self.assertTrue(auth['passwordRequired'])
        self.assertFalse(auth['authenticated'])
        wrong = await self.login(device, password='wrong-password')
        self.assertEqual(wrong.status, 401)
        self.assertEqual((await wrong.json())['loginStatus']['attemptsRemaining'], 4)
        first = await self.headers(await self.login(device))
        second = await self.headers(await self.login(device))
        self.assertFalse(connector.gateway.auth.sessions, 'Authentication challenge must not leak local sessions')
        response = await self.client.get(self.scope(device) + '/api/sessions', headers=first)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())['sessions'][0]['title'], 'Fixture')
        owners = []
        for headers in (first, second, first):
            response = await self.client.post(self.scope(device) + '/api/sessions/' + THREAD + '/terminal',
                                              json={'action': 'open'}, headers=headers)
            self.assertEqual(response.status, 200, await response.text())
            owners.append((await response.json())['owner'])
        self.assertNotEqual(owners[0], owners[1])
        self.assertEqual(owners[0], owners[2])
        response = await self.client.post(self.scope(device) + '/api/sessions', json={'project': 'fixture', 'id': 'submission'}, headers=first)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.created, [('Fixture', 'submission')])
        dump = '\n'.join(self.state.registry.db.iterdump())
        self.assertNotIn(PASSWORD, dump)
        self.assertNotIn('phone-user', dump)

    async def test_prefix_page_assets_and_no_legacy_login_redirect(self):
        device, _ = await self.device()
        response = await self.client.get(self.scope(device) + '/')
        self.assertEqual(response.status, 200)
        html = await response.text()
        self.assertIn('src="/mobile/relay/mode.js"', html)
        self.assertIn('data-bridge-src="/mobile/app.js', html)
        self.assertIn('id="login-form"', html)
        self.assertIn('href="/mobile/style.css', html)
        self.assertEqual((await self.client.get('/api/auth')).status, 404)
        self.assertEqual((await self.client.get('/mobile/health')).status, 200)
        response = await self.client.get('/mobile/app.js')
        self.assertEqual(response.status, 200)
        self.assertNotIn("location.replace((window.BridgeRelayBase||'')+'/relay/')", await response.text())
        response = await self.login(device)
        self.assertIn('Path=' + self.scope(device) + '/', response.headers['Set-Cookie'])
        self.assertEqual((await self.client.get('/mobile/relay/admin/')).status, 200)
        self.assertIn('href="' + self.scope(device) + '/manifest.webmanifest"', html)
        manifest = await (await self.client.get(self.scope(device) + '/manifest.webmanifest')).json()
        self.assertEqual(manifest['start_url'], self.scope(device) + '/')
        self.assertEqual(manifest['icons'][0]['src'], '/mobile/icon.png')

    async def test_qr_expiry_replay_refresh_and_cross_device(self):
        a, _ = await self.device('A')
        b, _ = await self.device('B')
        qr = await self.pair(a)
        self.assertEqual((await self.exchange(b, qr)).status, 401)
        phone = await self.headers(await self.exchange(a, qr))
        self.assertEqual((await self.exchange(a, qr)).status, 401)
        self.assertEqual((await self.client.get(self.scope(b) + '/api/sessions', headers=phone)).status, 401)
        expired = await self.pair(a)
        self.state.registry.db.execute('UPDATE pairs SET expires=0')
        self.state.registry.db.commit()
        self.assertEqual((await self.exchange(a, expired)).status, 401)
        old = await self.pair(a)
        new = await self.pair(a)
        self.assertEqual((await self.exchange(a, old)).status, 401)
        await self.headers(await self.exchange(a, new))

    async def test_csrf_origin_host_and_auth_challenge_cannot_forward_arbitrary_paths(self):
        device, connector = await self.device()
        phone = await self.headers(await self.login(device))
        path = self.scope(device) + '/api/sessions'
        for headers in ({'Cookie': phone['Cookie'], 'Origin': self.origin},
                        {**phone, 'Origin': 'https://evil.test'}, {**phone, 'X-CSRF-Token': 'bad'},
                        {**phone, 'Host': 'evil.test'}):
            self.assertEqual((await self.client.post(path, json={}, headers=headers)).status, 401)
        self.assertEqual((await self.client.get(self.scope(device) + '/api/accounts', headers=phone)).status, 403)
        no_origin = await self.client.post(self.scope(device) + '/api/login', json={'username': 'phone-user', 'password': PASSWORD})
        self.assertEqual(no_origin.status, 401)
        message = {'id': 'challenge', 'type': 'authenticate', 'username': 'phone-user', 'password': PASSWORD,
                   'address': '127.0.0.1', 'revision': connector.auth_revision(), 'path': '/api/accounts'}
        self.assertEqual((await connector.authenticate(message))['status'], 400)
        with self.assertRaises(PermissionError):
            validate('POST', '/api/login')
        self.assertFalse(self.created)

    async def test_revocation_all_password_change_and_offline_rejects_new_grants(self):
        device, connector = await self.device()
        phone = await self.headers(await self.login(device))
        row = self.state.registry.phones(device['deviceId'])[0]
        await self.action(device, 'revoke-phone', id=row['id'])
        self.assertEqual((await self.client.get(self.scope(device) + '/api/sessions', headers=phone)).status, 401)
        phone = await self.headers(await self.login(device))
        qr = await self.pair(device)
        await self.action(device, 'revoke-all')
        self.assertEqual((await self.exchange(device, qr)).status, 401)
        self.assertEqual((await self.client.get(self.scope(device) + '/api/sessions', headers=phone)).status, 401)
        phone = await self.headers(await self.login(device))
        qr = await self.pair(device)
        old_revision = connector.auth_revision()
        await asyncio.to_thread(connector.close)
        new_config = {**self.password_config, **await asyncio.to_thread(password_record, 'changed-password-2026')}
        connector.gateway.auth = Auth(new_config)
        replacement = Connector(connector.directory, connector.gateway, test_http=True, config=connector.memory_config)
        self.connectors.append(replacement)
        replacement.start()
        for _ in range(150):
            if self.state.auth_revisions.get(device['deviceId']) not in (None, old_revision):
                break
            await asyncio.sleep(.02)
        self.assertEqual((await self.client.get(self.scope(device) + '/api/sessions', headers=phone)).status, 401)
        self.assertEqual((await self.exchange(device, qr)).status, 401)
        await self.headers(await self.login(device, password='changed-password-2026'))
        qr = await self.pair(device)
        await asyncio.to_thread(replacement.close)
        for _ in range(100):
            if not self.state.online(device['deviceId']):
                break
            await asyncio.sleep(.02)
        self.assertEqual((await self.login(device)).status, 503)
        self.assertEqual((await self.exchange(device, qr)).status, 503)
        self.assertFalse(self.state.pending)

    async def test_controller_memory_registration_does_not_write_token(self):
        memory, saves = {}, []
        controller = Controller(Path(self.temp.name) / 'controller', test_http=True, config=memory, save_hook=saves.append)
        invitation = self.state.registry.invite('Controller')['invitation']
        result = await asyncio.to_thread(controller.control, {'action': 'register', 'url': self.base,
            'invitation': invitation, 'name': 'Controller', 'consent': True})
        self.assertTrue(result['registered'])
        self.assertIn('deviceToken', memory)
        self.assertNotIn('deviceToken', result)
        self.assertEqual(saves[-1], memory)
        self.assertFalse((controller.directory / 'shared-relay.json').exists())
        snapshot = await asyncio.to_thread(controller.control, {'action': 'status'})
        self.assertTrue(snapshot['phoneUrl'].startswith(self.base + '/d/'))
        self.assertNotIn('deviceToken', snapshot)

    async def test_login_disconnect_fails_closed_without_password_replay(self):
        device, connector = await self.device()
        entered = asyncio.Event()
        original = connector.authenticate
        async def slow(message):
            entered_loop.call_soon_threadsafe(entered.set)
            await asyncio.sleep(30)
            return await original(message)
        entered_loop = asyncio.get_running_loop()
        connector.authenticate = slow
        task = asyncio.create_task(self.login(device))
        await asyncio.wait_for(entered.wait(), 3)
        await asyncio.to_thread(connector.close)
        self.assertEqual((await task).status, 503)
        self.assertEqual(self.state.registry.phones(device['deviceId']), [])
        self.assertEqual(self.state.pending, {})

    async def test_account_registration_checks_active_identity_limit_and_keeps_token_ephemeral(self):
        supplied = []
        async def verify(secret):
            supplied.append(secret)
            if secret == 'disabled-account-token':
                return {'code': 0, 'data': {'id': 42, 'status': 'disabled'}}
            if secret != 'fixture-account-token':
                raise PermissionError('expired')
            return {'code': 0, 'data': {'id': 42, 'status': 'active'}}
        self.state.account_verifier = verify
        async def register(secret, name='PC'):
            return await self.client.post('/mobile/relay/register-account', json={'name': name},
                                          headers={'Authorization': 'Bearer ' + secret})
        self.assertEqual((await register('expired-account-token')).status, 401)
        self.assertEqual((await register('disabled-account-token')).status, 401)
        self.assertEqual(self.state.registry.devices(), [])
        memory = {}
        controller = Controller(Path(self.temp.name) / 'account', test_http=True, config=memory)
        result = await asyncio.to_thread(controller.control, {'action': 'register-account', 'url': self.base,
            'accountToken': 'fixture-account-token', 'name': 'Main PC', 'consent': True})
        self.assertTrue(result['registered'])
        self.assertNotIn('accountToken', memory)
        for i in range(4):
            self.assertEqual((await register('fixture-account-token', 'PC ' + str(i))).status, 201)
        self.assertEqual((await register('fixture-account-token')).status, 400)
        self.assertEqual(len(self.state.registry.devices()), 5)
        self.assertEqual({r['owner'] for r in self.state.registry.devices()}, {'gaoge:42'})
        self.assertNotIn('fixture-account-token', '\n'.join(self.state.registry.db.iterdump()))
        self.assertFalse((controller.directory / 'shared-relay.json').exists())
        self.state.registry.revoke(memory['deviceId'])
        self.assertEqual((await register('fixture-account-token')).status, 201)

    async def test_registration_cannot_choose_verifier_or_forward_account_token_to_other_origin(self):
        calls = []
        async def verify(secret):
            calls.append(secret)
            return {'id': 1, 'status': 'active'}
        self.state.account_verifier = verify
        response = await self.client.post('/mobile/relay/register-account',
            json={'name': 'PC', 'verifyUrl': 'https://evil.test'},
            headers={'Authorization': 'Bearer fixture-account-token'})
        self.assertEqual(response.status, 401)
        self.assertEqual(calls, [])
        controller = Controller(Path(self.temp.name) / 'account', config={})
        with self.assertRaisesRegex(ValueError, '受信任'):
            controller.control({'action': 'register-account', 'url': 'https://evil.test/mobile',
                                'accountToken': 'fixture-account-token', 'name': 'PC', 'consent': True})

    async def test_codex_only_restriction_is_preserved_by_connector_http_server(self):
        device, connector = await self.device()
        calls = []
        connector.server.desktop_sessions = SimpleNamespace(clients_status=lambda: {'clients': [
            {'id': 'codex', 'enabled': True}, {'id': 'claude', 'enabled': False}, {'id': 'deepseek', 'enabled': False}]},
            toggle_client=lambda value: calls.append(value) or {'ok': True})
        phone = await self.headers(await self.login(device))
        response = await self.client.get(self.scope(device) + '/api/clients', headers=phone)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual([r['id'] for r in (await response.json())['clients']], ['codex'])
        response = await self.client.post(self.scope(device) + '/api/clients',
            json={'provider': 'claude', 'enabled': True}, headers=phone)
        self.assertEqual(response.status, 403)
        self.assertEqual(calls, [])

    async def test_password_login_remember_lifetime_and_browser_session_cookie(self):
        device, _ = await self.device()
        response = await self.login(device)
        self.assertIn('Max-Age=604800', response.headers['Set-Cookie'])
        response = await self.login(device, remember=False)
        self.assertNotIn('Max-Age', response.headers['Set-Cookie'])
        phone = await self.headers(response)
        response = await self.client.get(self.scope(device) + '/api/auth', headers=phone)
        self.assertNotIn('Max-Age', response.headers['Set-Cookie'])


class RelayURLTests(unittest.TestCase):
    def test_https_prefix_validation(self):
        self.assertEqual(origin('https://api.example.test/mobile/'), 'https://api.example.test/mobile')
        for value in ('https://x/mobile/../api', 'https://x//mobile', 'https://x/%6dobile',
                      'https://user:pass@x/mobile', 'https://x/mobile?query=1', 'http://x/mobile',
                      'https://x/mobile#pair', 'https://x/mobile\\api'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                origin(value)

    def test_account_envelopes_reject_missing_active_status_and_error_envelopes(self):
        for value in ({'id': 1, 'status': 'active'}, {'success': True, 'data': {'id': 1, 'status': 'active'}},
                      {'code': 0, 'data': {'id': 1, 'status': 'active'}}):
            self.assertEqual(account_owner(value), 'gaoge:1')
        for value in ({'id': 1}, {'id': True, 'status': 'active'}, {'id': '1', 'status': 'active'},
                      {'id': 1, 'status': 'disabled'}, {'success': False, 'data': {'id': 1, 'status': 'active'}},
                      {'code': 401, 'data': {'id': 1, 'status': 'active'}}, {'code': False, 'data': {'id': 1, 'status': 'active'}}):
            with self.subTest(value=value), self.assertRaises(PermissionError):
                account_owner(value)


if __name__ == '__main__':
    unittest.main()
