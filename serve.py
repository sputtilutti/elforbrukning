"""Startar webbverktyget lokalt på http://localhost:8765 utan webbläsarcache.

Användning:
    python3 serve.py          # port 8765
    python3 serve.py 9000     # annan port

Utöver att servera `web/` gör servern två saker, bara för anrop från din egen dator:
  - /data.json läses från $WORKDIR/data.json (standard ./tmp/data.json, skapad av export_data.py)
    om det inte ligger en fil `web/data.json`, så att du slipper välja filen varje gång.
  - /api/state sparar och läser dina inställningar och erbjudanden i $WORKDIR/web-state.json,
    så att de finns kvar nästa gång du kör servern, oavsett webbläsare eller adress.
  - /api/data sparar den datafil du läst in manuellt på sidan (om den inte kom från /data.json)
    i $WORKDIR/web-data.json, så att den också finns kvar.

Filerna i $WORKDIR (tmp/) är utesluten ur git. `python3 -m http.server --directory web` fungerar också,
men då sparas inställningarna bara i webbläsaren och filer kan cachas.
"""
import http.server
import json
import os
import socket
import sys
import tempfile

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(ROOT, 'web')
STATE_DIR = os.path.abspath(os.getenv('WORKDIR') or os.path.join(ROOT, 'tmp'))
MAX_STATE_BYTES = 1_000_000
MAX_DATA_BYTES = 20_000_000
LOOPBACK = {'127.0.0.1', '::1', '::ffff:127.0.0.1'}


def state_path():
    return os.path.join(STATE_DIR, 'web-state.json')


def data_path():
    return os.path.join(STATE_DIR, 'data.json')


def loaded_data_path():
    return os.path.join(STATE_DIR, 'web-data.json')


def is_loopback(address):
    """Sant om anropet kommer från den egna datorn. Servern lyssnar på alla adresser, men dina data ska inte nås från nätverket."""
    return address in LOOPBACK


def _write_json(path, raw, limit, check):
    """Validerar och sparar JSON atomiskt. Returnerar (ok, felmeddelande)."""
    if len(raw) > limit:
        return False, 'för stort'
    try:
        value = json.loads(raw)
    except ValueError:
        return False, 'ogiltig JSON'
    error = check(value)
    if error:
        return False, error
    os.makedirs(STATE_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=STATE_DIR, prefix='.web-', suffix='.tmp')  # mkstemp ger bara ägaren läsrätt
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)
    return True, ''


def _check_state(state):
    ok = isinstance(state, dict) and isinstance(state.get('offers', []), list) and isinstance(state.get('settings', {}), dict)
    return '' if ok else 'förväntade {offers: [...], settings: {...}}'


def _check_data(data):
    ok = isinstance(data, dict) and isinstance(data.get('manader'), list) and isinstance(data.get('spot'), dict)
    return '' if ok else 'förväntade en data.json med manader och spot'


def write_state(raw):
    return _write_json(state_path(), raw, MAX_STATE_BYTES, _check_state)


def write_loaded_data(raw):
    return _write_json(loaded_data_path(), raw, MAX_DATA_BYTES, _check_data)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _send(self, status, body=b'', ctype='application/json; charset=utf-8'):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _send_file(self, path):
        if not os.path.isfile(path):
            return self._send(404, b'{}')
        with open(path, 'rb') as f:
            self._send(200, f.read())

    def do_GET(self):
        if not is_loopback(self.client_address[0]):
            return self._send(403, b'{"error": "bara lokala anrop"}')
        route = self.path.split('?')[0]
        # 204 = servern kan spara men inget är sparat än. Ett vanligt 404 betyder att sidan körs utan serverns API.
        for api, path in (('/api/state', state_path()), ('/api/data', loaded_data_path())):
            if route == api:
                return self._send_file(path) if os.path.isfile(path) else self._send(204)
        if route == '/data.json' and not os.path.isfile(os.path.join(WEB_DIR, 'data.json')):
            return self._send_file(data_path())
        super().do_GET()

    def do_PUT(self):
        if not is_loopback(self.client_address[0]):
            return self._send(403, b'{"error": "bara lokala anrop"}')
        route = self.path.split('?')[0]
        writers = {'/api/state': (write_state, MAX_STATE_BYTES), '/api/data': (write_loaded_data, MAX_DATA_BYTES)}
        if route not in writers:
            return self._send(404, b'{}')
        write, limit = writers[route]
        length = int(self.headers.get('Content-Length') or 0)
        if length > limit:
            return self._send(413, b'{"error": "f\xc3\xb6r stort"}')
        ok, error = write(self.rfile.read(length))
        self._send(200 if ok else 400, json.dumps({'ok': ok, 'error': error}).encode())

    def log_message(self, fmt, *args):
        # /api/* anropas vid varje ändring; hoppa över det i loggen så den förblir läsbar.
        # Avgörs på sökvägen: första argumentet är ibland en HTTPStatus (vid fel), inte en text.
        if not getattr(self, 'path', '').startswith('/api/'):
            super().log_message(fmt, *args)


class Server(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6  # nås via både localhost (::1) och 127.0.0.1

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f'Elpriskollen: http://localhost:{port}  (Ctrl+C avslutar)')
    print(f'Data och inställningar: {STATE_DIR}')
    Server(('::', port), Handler).serve_forever()
