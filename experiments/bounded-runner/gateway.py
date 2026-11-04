"""Synthetic upstream + one-route gateway. No real account or GitHub access."""
import hmac
import json
import os
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ['FIXTURE_TOKEN']

class Upstream(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/fixture' or not hmac.compare_digest(
            self.headers.get('Authorization', ''), 'Bearer ' + TOKEN
        ):
            self.send_error(403)
            return
        body = b'{"task":"Empty carts must total zero. Edit pricing.py only."}'
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

class Gateway(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/repository/fixture':
            self.send_error(403)
            print(json.dumps({'event': 'route_denied', 'status': 403}), flush=True)
            return
        # The upstream address is fixed. Client URLs and headers are not forwarded.
        request = urllib.request.Request(
            'http://127.0.0.1:9081/fixture',
            headers={'Authorization': 'Bearer ' + TOKEN},
        )
        with urllib.request.urlopen(request, timeout=2) as response:
            body = response.read(4096)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)
        print(json.dumps({'event': 'credential_mediated', 'status': 200}), flush=True)

    def do_POST(self):
        self.send_error(403)
        print(json.dumps({'event': 'method_denied', 'status': 403}), flush=True)

    def log_message(self, *args):
        pass

upstream = ThreadingHTTPServer(('127.0.0.1', 9081), Upstream)
threading.Thread(target=upstream.serve_forever, daemon=True).start()
print('ready', flush=True)
ThreadingHTTPServer(('0.0.0.0', 9080), Gateway).serve_forever()
