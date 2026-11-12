"""Deployment-only trusted relay configuration; no bundled operator endpoint."""
import os
from urllib.parse import urlsplit

from relay.protocol import origin


def account_relay_url(test_http=False):
    value = os.environ.get('GAOGE_ACCOUNT_RELAY_URL', '')
    if not value:
        return ''
    normalized = origin(value, test_http)
    p = urlsplit(normalized)
    if p.hostname.endswith('.') or (not test_http and p.port not in (None, 443)):
        raise ValueError('Trusted account relay requires HTTPS on port 443')
    return normalized
