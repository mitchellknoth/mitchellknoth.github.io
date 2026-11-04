"""Deterministic stand-in for a coding agent; deliberately does not call a model."""
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

assert 'FIXTURE_TOKEN' not in os.environ
try:
    connection = socket.create_connection(('gateway', 9081), timeout=1)
except OSError:
    print('upstream port unavailable outside gateway loopback', flush=True)
else:
    connection.close()
    raise AssertionError('worker reached protected upstream port')
with urllib.request.urlopen('http://gateway:9080/repository/fixture', timeout=3) as response:
    task = json.load(response)
assert task['task'].startswith('Empty carts')
for path, method in [('/other', 'GET'), ('/repository/fixture', 'POST')]:
    try:
        urllib.request.urlopen(urllib.request.Request(
            'http://gateway:9080' + path, method=method), timeout=3)
    except urllib.error.HTTPError as error:
        assert error.code == 403
    else:
        raise AssertionError('gateway accepted an unauthorized request')
print('fixture fetched; token absent; route and method denied', flush=True)
mode = sys.argv[1]
target = Path('/workspace/pricing.py')
if mode == 'timeout':
    time.sleep(120)
elif mode == 'invalid':
    target.write_text('def total(prices):\n    return 0\n')
elif mode == 'scope':
    Path('/workspace/unapproved.py').write_text('# outside approved scope\n')
elif mode == 'symlink':
    target.unlink()
    target.symlink_to('/etc/passwd')
else:
    target.write_text(target.read_text().replace('sum(prices) if prices else None', 'sum(prices)'))
