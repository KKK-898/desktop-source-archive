import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from gaoge_mobile import MobileConnection, DEFAULT_RELAY


class MobileControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.runtime = MobileConnection(self.directory)

    def tearDown(self):
        self.runtime.stop_runtime()
        self.temp.cleanup()

    def test_status_does_not_start_or_register_and_init_keeps_token_off_disk(self):
        self.runtime.controller.request = Mock(side_effect=AssertionError('unexpected network'))
        status = self.runtime.init({'relayConfig': {'url': DEFAULT_RELAY, 'deviceId': 'a' * 32,
                                  'deviceName': 'PC', 'deviceToken': 'private-device-token'}})
        self.assertEqual(status['state'], 'stopped')
        self.assertTrue(status['relayConfigured'])
        self.assertIsNone(self.runtime.gateway)
        self.assertNotIn('private-device-token', json.dumps(status))
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_password_hash_only_and_blank_password_preserves_hash(self):
        password = 'controller-fixture-password'
        first = self.runtime.save({'username': 'phone', 'password': password})
        self.assertTrue(first['hasPassword'])
        saved = self.runtime.settings['auth'].copy()
        self.runtime.save({'username': 'phone'})
        self.assertEqual(saved, self.runtime.settings['auth'])
        self.assertNotIn(password, self.runtime.settings_path.read_text())
        self.assertNotIn(password, json.dumps(first))

    def test_bad_input_never_overwrites_settings(self):
        self.runtime.save({'username': 'phone', 'password': 'controller-fixture-password'})
        previous = self.runtime.settings_path.read_bytes()
        for value in ({'username': 'phone', 'password': 'short'},
                      {'username': 'phone', 'relayUrl': 'http://example.com'},
                      {'username': 'phone', 'relayUrl': 'https://other.example/mobile', 'accountToken': 'sensitive'}):
            with self.assertRaises(ValueError):
                self.runtime.save(value)
            self.assertEqual(previous, self.runtime.settings_path.read_bytes())

    def test_password_change_fails_closed_if_remote_revocation_fails(self):
        self.runtime.save({'username': 'phone', 'password': 'controller-fixture-password'})
        previous = self.runtime.settings_path.read_bytes()
        self.runtime.relay_config.update(deviceToken='private', url=DEFAULT_RELAY)
        self.runtime.controller.control = Mock(side_effect=ValueError('offline'))
        with self.assertRaisesRegex(ValueError, 'offline'):
            self.runtime.save({'username': 'phone', 'password': 'changed-fixture-password'})
        self.assertEqual(previous, self.runtime.settings_path.read_bytes())
        self.runtime.controller.control.assert_called_once_with({'action': 'revoke-all'})

    def test_start_without_registration_cannot_claim_online(self):
        self.runtime.save({'username': 'phone', 'password': 'controller-fixture-password'})
        with self.assertRaises(ValueError):
            self.runtime.start()
        self.assertEqual(self.runtime.status()['state'], 'stopped')


if __name__ == '__main__':
    unittest.main()
