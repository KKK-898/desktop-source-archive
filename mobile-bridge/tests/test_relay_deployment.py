import os
import tempfile
import unittest
from unittest.mock import Mock, patch

from bridge.features.network.deployment import account_relay_url
from relay.protocol import origin
from bridge.features.network.shared_relay import Controller


class RelayDeploymentTests(unittest.TestCase):
    def test_no_deployment_has_no_trusted_default(self):
        with patch.dict(os.environ, {'GAOGE_ACCOUNT_RELAY_URL': ''}):
            self.assertEqual('', account_relay_url())

    def test_canonical_account_trust_matches_user_url(self):
        with patch.dict(os.environ, {'GAOGE_ACCOUNT_RELAY_URL': 'HTTPS://RELAY.EXAMPLE.INVALID:443/Mobile/'}):
            self.assertEqual('https://relay.example.invalid/Mobile', account_relay_url())
            self.assertEqual(account_relay_url(), origin('https://relay.example.invalid/Mobile'))
            self.assertNotEqual(account_relay_url(), origin('https://relay.example.invalid/mobile'))

    def test_invalid_deployment_fails_closed(self):
        for value in ('https://relay.example.invalid:8443/mobile',
                      'https://relay.example.invalid./mobile',
                      'https://user@relay.example.invalid/mobile',
                      'https://relay.example.invalid/mobile?',
                      'https://relay.example.invalid/mobile#',
                      'https://relay.example.invalid/mobile\n',
                      'https://relay.example.invalid/%2e%2e',
                      'http://relay.example.invalid/mobile'):
            with self.subTest(value=value), patch.dict(os.environ, {'GAOGE_ACCOUNT_RELAY_URL': value}):
                with self.assertRaises(ValueError):
                    account_relay_url()

    def test_controller_rejects_account_token_without_trusted_configuration(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'GAOGE_ACCOUNT_RELAY_URL': ''}):
            controller = Controller(directory)
            controller.request = Mock(side_effect=AssertionError('unexpected network'))
            with self.assertRaises(ValueError):
                controller.control({'action': 'register-account', 'consent': True,
                                    'url': 'https://relay.example.invalid/mobile',
                                    'accountToken': 'private-fixture-token'})
            controller.request.assert_not_called()

    def test_custom_https_port_remains_available_for_enrollment(self):
        self.assertEqual('https://relay.example.invalid:8443/mobile',
                         origin('https://RELAY.EXAMPLE.INVALID:8443/mobile/'))

    def test_http_is_only_for_explicit_loopback_tests(self):
        self.assertEqual('http://127.0.0.1:18000/mobile', origin('http://127.0.0.1:18000/mobile', True))
        with self.assertRaises(ValueError):
            origin('http://127.0.0.1:18000/mobile')
        with self.assertRaises(ValueError):
            origin('http://relay.example.invalid/mobile', True)


if __name__ == '__main__':
    unittest.main()
