"""tools/spotify_login.py: PKCE values, the loopback callback and the code exchange, against local fakes."""
import base64
import hashlib
import http.server
import importlib.util
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('spotify_login', ROOT / 'tools' / 'spotify_login.py')
login = importlib.util.module_from_spec(spec)
spec.loader.exec_module(login)

CLIENT = 'a' * 32


def test_pkce_pair_matches_rfc7636():
    verifier, challenge = login.pkce_pair()
    assert 43 <= len(verifier) <= 128
    assert set(verifier) <= set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_')
    expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    assert challenge == expected
    assert login.pkce_pair()[0] != verifier


def test_authorize_url_is_read_only_and_loopback():
    url = urllib.parse.urlparse(login.authorize_url(CLIENT, 'challenge', 'state1'))
    query = urllib.parse.parse_qs(url.query)
    assert url.netloc == 'accounts.spotify.com' and url.path == '/authorize'
    assert query['redirect_uri'] == ['http://127.0.0.1:8898/callback']
    assert query['response_type'] == ['code'] and query['code_challenge_method'] == ['S256']
    assert query['scope'] == ['user-read-currently-playing user-read-playback-state']
    assert 'client_secret' not in query


def _get(path):
    for _ in range(50):
        try:
            return urllib.request.urlopen('http://127.0.0.1:%d%s' % (login.PORT, path), timeout=3).status
        except urllib.error.HTTPError as error:
            return error.code
        except OSError:
            time.sleep(0.05)
    raise AssertionError('callback server did not start')


def test_callback_accepts_only_the_matching_state():
    box = {}
    thread = threading.Thread(target=lambda: box.update(code=login.wait_for_code('good-state')))
    thread.start()
    assert _get('/favicon.ico') == 404          # stray request: keeps waiting
    assert _get('/callback?code=abc123&state=good-state') == 200
    thread.join(5)
    assert box == {'code': 'abc123'}

    failed = {}

    def run():
        try:
            login.wait_for_code('good-state')
        except SystemExit as stop:
            failed['message'] = str(stop)
    thread = threading.Thread(target=run)
    thread.start()
    assert _get('/callback?code=stolen&state=other') == 400
    thread.join(5)
    assert 'state mismatch' in failed['message']


def test_exchange_sends_verifier_and_no_secret(monkeypatch):
    seen = {}

    class Token(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            seen.update(urllib.parse.parse_qs(self.rfile.read(int(self.headers['Content-Length'])).decode()))
            body = json.dumps({'access_token': 'x', 'refresh_token': 'R' * 40}).encode()
            self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = http.server.HTTPServer(('127.0.0.1', 0), Token)
    threading.Thread(target=server.handle_request).start()
    monkeypatch.setattr(login, 'TOKEN', 'http://127.0.0.1:%d/api/token' % server.server_address[1])
    assert login.exchange(CLIENT, 'the-code', 'the-verifier') == 'R' * 40
    server.server_close()
    assert seen['grant_type'] == ['authorization_code'] and seen['code_verifier'] == ['the-verifier']
    assert seen['redirect_uri'] == ['http://127.0.0.1:8898/callback'] and seen['client_id'] == [CLIENT]
    assert 'client_secret' not in seen


def test_rejects_a_wrong_client_id(capsys):
    assert login.main(['spotify_login.py', 'not-a-client-id']) == 2
    assert 'Usage' in capsys.readouterr().out
