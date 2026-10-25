import contextlib
import http.client
import io
import json
import os
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import serve  # noqa: E402


class ServeState(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.old_dir = serve.STATE_DIR
        serve.STATE_DIR = cls.tmp.name
        cls.server = serve.Server(('::1', 0), serve.Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        serve.STATE_DIR = cls.old_dir
        cls.tmp.cleanup()

    def request(self, method, path, body=None):
        conn = http.client.HTTPConnection('::1', self.port, timeout=5)
        conn.request(method, path, body=body, headers={'Content-Type': 'application/json'} if body else {})
        resp = conn.getresponse()
        data = resp.read()
        headers = dict(resp.getheaders())
        conn.close()
        return resp.status, data, headers

    def test_state_roundtrip_and_no_cache(self):
        state = {'version': 1, 'offers': [{'id': 'a', 'namn': 'Åäö-erbjudande', 'paslag': '1,70'}], 'settings': {'year': '2025'}}
        status, _, _ = self.request('PUT', '/api/state', json.dumps(state))
        self.assertEqual(status, 200)
        status, data, headers = self.request('GET', '/api/state')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data), state)
        self.assertEqual(headers.get('Cache-Control'), 'no-store')
        self.assertTrue(os.path.isfile(os.path.join(self.tmp.name, 'web-state.json')))

    def test_invalid_state_is_rejected_and_keeps_the_previous_one(self):
        good = {'offers': [{'id': 'x'}], 'settings': {}}
        self.request('PUT', '/api/state', json.dumps(good))
        self.assertEqual(self.request('PUT', '/api/state', '{inte json')[0], 400)
        self.assertEqual(self.request('PUT', '/api/state', json.dumps({'offers': 'fel'}))[0], 400)
        self.assertEqual(json.loads(self.request('GET', '/api/state')[1]), good)

    def test_missing_state_gives_204_so_the_page_can_tell_the_api_exists(self):
        path = os.path.join(self.tmp.name, 'web-state.json')
        if os.path.isfile(path):
            os.remove(path)
        self.assertEqual(self.request('GET', '/api/state')[0], 204)

    def test_manually_loaded_data_is_saved_and_validated(self):
        path = os.path.join(self.tmp.name, 'web-data.json')
        if os.path.isfile(path):
            os.remove(path)
        self.assertEqual(self.request('GET', '/api/data')[0], 204)
        data = {'manader': [{'manad': '2025-01', 'kwh': 1}], 'spot': {'2025-01': 50.0}, 'anlaggningar': ['A']}
        self.assertEqual(self.request('PUT', '/api/data', json.dumps(data))[0], 200)
        status, body, _ = self.request('GET', '/api/data')
        self.assertEqual((status, json.loads(body)), (200, data))
        self.assertEqual(self.request('PUT', '/api/data', json.dumps({'manader': 'fel'}))[0], 400)
        self.assertEqual(json.loads(self.request('GET', '/api/data')[1]), data)   # oförändrad efter avvisad skrivning
        self.assertEqual(oct(os.stat(path).st_mode & 0o777), '0o600')             # bara ägaren kan läsa

    def test_data_json_is_served_from_workdir(self):
        self.assertEqual(self.request('GET', '/data.json')[0], 404)
        with open(os.path.join(self.tmp.name, 'data.json'), 'w', encoding='utf-8') as f:
            json.dump({'manader': []}, f)
        status, data, _ = self.request('GET', '/data.json')
        self.assertEqual((status, json.loads(data)), (200, {'manader': []}))

    def test_only_loopback_clients_are_allowed(self):
        self.assertTrue(all(serve.is_loopback(a) for a in ('127.0.0.1', '::1', '::ffff:127.0.0.1')))
        self.assertFalse(any(serve.is_loopback(a) for a in ('192.168.1.20', '10.0.0.5', '2001:db8::1')))

    def test_missing_file_gives_404_and_is_logged_without_crashing(self):
        # Regression: log_error skickar en HTTPStatus som första argument, och loggfunktionen krashade på det
        log = io.StringIO()
        with contextlib.redirect_stderr(log):
            status, _, _ = self.request('GET', '/favicon.ico')
            self.request('GET', '/finns-inte.js')
        self.assertEqual(status, 404)
        self.assertNotIn('Traceback', log.getvalue())
        self.assertIn('404', log.getvalue())
        self.assertEqual(self.request('GET', '/')[0], 200)   # servern lever vidare

    def test_api_calls_are_not_logged(self):
        log = io.StringIO()
        with contextlib.redirect_stderr(log):
            self.request('GET', '/api/state')
        self.assertNotIn('/api/state', log.getvalue())

    def test_static_files_still_served(self):
        status, data, _ = self.request('GET', '/')
        self.assertEqual(status, 200)
        self.assertIn(b'Elpriskollen', data)


if __name__ == '__main__':
    unittest.main()
