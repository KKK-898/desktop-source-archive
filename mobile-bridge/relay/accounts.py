"""Verify a software login at an administrator-configured, fixed HTTPS endpoint."""
import json
import os
from urllib.parse import urlsplit

import aiohttp


def account_owner(value):
    if not isinstance(value, dict):
        raise PermissionError('软件账号校验失败，请重新登录软件。')
    if 'success' in value:
        if value['success'] is not True:
            raise PermissionError('软件账号校验失败，请重新登录软件。')
        value = value.get('data')
    elif 'code' in value:
        if type(value['code']) is not int or value['code'] != 0:
            raise PermissionError('软件账号校验失败，请重新登录软件。')
        value = value.get('data')
    if (not isinstance(value, dict) or type(value.get('id')) is not int or not 0 < value['id'] <= 2**63 - 1
            or value.get('status') != 'active'):
        raise PermissionError('软件账号不可用，请确认账号正常并重新登录。')
    return 'gaoge:' + str(value['id'])


class AccountVerifier:
    def __init__(self):
        self.url = os.environ.get('GAOGE_ACCOUNT_VERIFY_URL', '').strip()
        if self.url:
            parsed = urlsplit(self.url)
            if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                    or parsed.query or parsed.fragment or parsed.port == 0):
                raise ValueError('GAOGE_ACCOUNT_VERIFY_URL must be a fixed HTTPS URL')

    async def __call__(self, secret):
        if not self.url:
            raise PermissionError('此中继尚未启用软件账号连接，请联系管理员。')
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8),
                    cookie_jar=aiohttp.DummyCookieJar(), auto_decompress=False) as client:
                async with client.get(self.url, allow_redirects=False,
                        headers={'Authorization': 'Bearer ' + secret, 'Accept': 'application/json',
                                 'Accept-Encoding': 'identity'}) as response:
                    if response.status != 200 or response.headers.get('Content-Encoding', 'identity') != 'identity':
                        raise PermissionError('软件登录已失效，请重新登录。')
                    data = bytearray()
                    async for chunk in response.content.iter_chunked(4096):
                        data.extend(chunk)
                        if len(data) > 32768:
                            raise PermissionError('软件账号校验响应无效。')
                    return json.loads(data)
        except (aiohttp.ClientError, TimeoutError, OSError, ValueError):
            raise PermissionError('暂时无法校验软件账号，请稍后重试。') from None
