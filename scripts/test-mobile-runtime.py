"""Smoke-test a frozen mobile supervisor without Codex, accounts, or networking."""
import argparse
import hashlib
import hmac
import json
import os
import secrets
import subprocess
import sys
import tempfile
from pathlib import Path


RELAY_URL = 'https://mobile-runtime-smoke.invalid/mobile'


class SmokeFailure(Exception):
    """Only fixed, non-sensitive messages may be presented to CI logs."""


def require(condition, message):
    if not condition:
        raise SmokeFailure(message)


def isolated_environment(root):
    env = os.environ.copy()
    # Do not inherit authentication or Python injection settings from the runner.
    for key in list(env):
        if key.upper().startswith(('CODEX_', 'OPENAI_', 'ANTHROPIC_', 'PYTHON')):
            env.pop(key, None)
    home = root / 'home'
    home.mkdir(mode=0o700)
    directories = {
        'HOME': home, 'USERPROFILE': home,
        'APPDATA': root / 'appdata', 'LOCALAPPDATA': root / 'localappdata',
        'XDG_CONFIG_HOME': root / 'config', 'XDG_DATA_HOME': root / 'data',
        'XDG_CACHE_HOME': root / 'cache', 'XDG_STATE_HOME': root / 'state',
        'TMPDIR': root / 'tmp', 'TEMP': root / 'tmp', 'TMP': root / 'tmp',
    }
    for key, directory in directories.items():
        directory.mkdir(mode=0o700, exist_ok=True)
        env[key] = str(directory)
    env.update(CODEX_HOME=str(root / 'absent-codex'), PYTHONUTF8='1',
               PYTHONUNBUFFERED='1', PYINSTALLER_RESET_ENVIRONMENT='1')
    return env


def exchange(binary, directory, root, env, actions, password):
    messages = [{'id': index, 'action': action, 'request': request}
                for index, (action, request) in enumerate(actions, 1)]
    payload = ''.join(json.dumps(item) + '\n' for item in messages).encode('utf-8')
    kwargs = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    process = subprocess.Popen(
        [str(binary), 'supervise', '--data-dir', str(directory)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=root, env=env, **kwargs)
    try:
        # communicate closes stdin, exercising the parent-exit/EOF shutdown path.
        stdout, stderr = process.communicate(payload, timeout=45)
    except BaseException:
        process.kill()
        process.communicate(timeout=10)
        raise SmokeFailure('supervisor did not finish within the smoke-test deadline') from None
    require(process.returncode == 0, 'supervisor failed to exit cleanly after EOF')
    require(len(stdout) <= 1024 * 1024 and len(stderr) <= 1024 * 1024,
            'supervisor produced unexpected output volume')
    require(password.encode('utf-8') not in stdout + stderr,
            'supervisor exposed the test password in process output')
    lines = stdout.splitlines()
    require(len(lines) == len(messages), 'supervisor did not return one JSONL reply per request')
    results = []
    for expected, line in zip(messages, lines):
        try:
            reply = json.loads(line)
        except (ValueError, UnicodeError):
            raise SmokeFailure('supervisor returned a non-JSON response') from None
        require(isinstance(reply, dict) and reply.get('id') == expected['id'],
                'supervisor response identifier did not match its request')
        require(reply.get('ok') is True and isinstance(reply.get('result'), dict),
                'supervisor rejected an offline smoke-test operation')
        result = reply['result']
        require(result.get('runtimeAvailable') is True and result.get('state') == 'stopped',
                'offline operations unexpectedly started a connection')
        require(result.get('relayConfigured') is False and result.get('hasEnrollmentToken') is False,
                'offline operations unexpectedly registered a device')
        require(result.get('publicUrl') is None and result.get('pairing') is None
                and result.get('devices') == [] and not result.get('_secrets'),
                'offline operations unexpectedly returned relay authorization')
        results.append(result)
    require(not (root / 'absent-codex').exists(), 'smoke test unexpectedly created Codex data')
    return results


def check_imports(binary, root, env):
    kwargs = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    completed = subprocess.run([str(binary), 'self-check'], stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               cwd=root, env=env, timeout=45, **kwargs)
    require(completed.returncode == 0, 'frozen runtime dependency/resource self-check failed')
    try:
        result = json.loads(completed.stdout)
    except (ValueError, UnicodeError):
        raise SmokeFailure('frozen runtime self-check returned an invalid response') from None
    require(result == {'ok': True, 'check': 'mobile-runtime-imports-and-resources'},
            'frozen runtime did not confirm its dependency/resource self-check')
    require(not (root / 'absent-codex').exists(), 'self-check unexpectedly created Codex data')


def saved_auth(directory, password):
    path = directory / 'mobile-settings.json'
    require(path.is_file(), 'supervisor did not persist its local settings')
    raw = path.read_bytes()
    require(password.encode('utf-8') not in raw, 'settings contain the plaintext test password')
    try:
        settings = json.loads(raw)
        auth = settings['auth']
        require(auth['mode'] == 'password' and auth['algorithm'] == 'pbkdf2-sha256'
                and auth['iterations'] == 600000, 'saved password record has an unexpected format')
        salt = bytes.fromhex(auth['salt'])
        digest = bytes.fromhex(auth['hash'])
        require(len(salt) == 16 and len(digest) == 32, 'saved password record is incomplete')
        expected = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt,
                                       auth['iterations'], dklen=32)
        require(hmac.compare_digest(expected, digest), 'saved password hash cannot verify its password')
        require(settings['relayUrl'] == RELAY_URL, 'offline relay address was not preserved')
    except (KeyError, TypeError, ValueError):
        raise SmokeFailure('settings are not a valid password-hash record') from None
    if os.name != 'nt':
        require(path.stat().st_mode & 0o077 == 0, 'settings permissions permit other users to read them')
    return auth


def smoke(binary):
    require(binary.is_file(), 'frozen supervisor binary was not found')
    password = secrets.token_urlsafe(32)
    username = 'runtime-smoke-' + secrets.token_hex(6)
    with tempfile.TemporaryDirectory(prefix='gaoge-mobile-runtime-smoke-') as temporary:
        root = Path(temporary).resolve()
        if os.name != 'nt':
            root.chmod(0o700)
        directory = root / 'private-controller'
        directory.mkdir(mode=0o700)
        env = isolated_environment(root)
        check_imports(binary, root, env)
        first = exchange(binary, directory, root, env, [
            ('init', {}), ('status', {}),
            ('save', {'username': username, 'password': password, 'relayUrl': RELAY_URL}),
            ('status', {}), ('stop', {}),
        ], password)
        require(first[0].get('hasPassword') is False and first[1].get('hasPassword') is False,
                'fresh isolated runtime unexpectedly contained credentials')
        require(all(item.get('hasPassword') is True and item.get('username') == username
                    for item in first[2:]), 'saved credentials were not reported consistently')
        initial_auth = saved_auth(directory, password)
        restarted = exchange(binary, directory, root, env, [
            ('init', {}), ('status', {}),
            ('save', {'username': username, 'password': '', 'relayUrl': RELAY_URL}),
            ('stop', {}),
        ], password)
        require(all(item.get('hasPassword') is True and item.get('username') == username
                    for item in restarted), 'restarted supervisor did not restore saved credentials')
        require(saved_auth(directory, password) == initial_auth,
                'saving a blank password after restart replaced the existing password hash')
    print('PASS: frozen imports/resources, supervisor JSONL, offline settings, password hash, restart, and EOF shutdown.')
    print('No Codex process, account registration, or public relay connection was requested.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path, help='path to the platform-native frozen gateway executable')
    args = parser.parse_args()
    try:
        smoke(args.binary.expanduser().resolve())
    except SmokeFailure as exc:
        print('FAIL: ' + str(exc), file=sys.stderr)
        return 1
    except Exception as exc:
        # Never print child output, exception payloads, request bodies, or secrets.
        print('FAIL: runtime smoke test could not complete (' + type(exc).__name__ + ').', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
