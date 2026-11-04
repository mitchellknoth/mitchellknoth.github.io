"""Run the fixture in Docker and retain evidence. Python standard library only."""
import argparse
import difflib
import hashlib
import json
import secrets
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def docker(*args, timeout=30):
    return subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)

def checked(*args):
    result = docker(*args)
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return result.stdout.strip()

def digest(data):
    return hashlib.sha256(data).hexdigest()

def run(mode, output, image, deadline):
    output.mkdir(parents=True, exist_ok=False)
    prefix = 'bounded-runner-' + secrets.token_hex(6)
    network, gateway, worker, validator = [prefix + '-' + x for x in ('net', 'gateway', 'worker', 'validator')]
    names = [gateway, worker, validator]
    receipt = {'scenario': mode, 'status': 'error', 'experiment': 'synthetic deterministic worker', 'events': []}
    base = (ROOT / 'fixture/pricing.py').read_bytes()
    receipt['base_sha256'] = digest(base)
    start = time.monotonic()
    common = ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
              '--pids-limit=64', '--memory=128m', '--cpus=0.5',
              '--tmpfs=/tmp:rw,noexec,nosuid,size=16m', '-e', 'PYTHONDONTWRITEBYTECODE=1']
    try:
        receipt['image_id'] = checked('image', 'inspect', image, '--format', '{{.Id}}')
        with tempfile.TemporaryDirectory(prefix=prefix) as temporary:
            workspace = Path(temporary) / 'workspace'
            shutil.copytree(ROOT / 'fixture', workspace)
            workspace.chmod(0o777)
            (workspace / 'pricing.py').chmod(0o666)
            checked('network', 'create', '--internal', network)
            receipt['internal_network'] = json.loads(checked('network', 'inspect', network))[0]['Internal']
            if not receipt['internal_network']:
                raise RuntimeError('network is not internal')
            receipt['events'].append('internal network created; no published ports')
            checked('run', '-d', '--name', gateway, '--network', network, '--network-alias', 'gateway',
                    *common, '--user=65534:65534', '-e', 'FIXTURE_TOKEN=' + secrets.token_hex(32),
                    '-v', f'{ROOT / "gateway.py"}:/gateway.py:ro', image, 'python', '/gateway.py')
            # Poll the gateway's own loopback listener before starting the worker.
            for _ in range(30):
                health = docker('exec', gateway, 'python', '-c',
                                "import socket; socket.create_connection(('127.0.0.1',9080),1).close()")
                if health.returncode == 0:
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError('gateway did not become ready')
            checked('run', '-d', '--name', worker, '--network', network, *common, '--user=65534:65534',
                    '-v', f'{workspace}:/workspace:rw', '-v', f'{ROOT / "worker.py"}:/worker.py:ro',
                    image, 'python', '/worker.py', mode)
            try:
                result = docker('wait', worker, timeout=deadline)
                if result.returncode or result.stdout.strip() != '0':
                    raise RuntimeError('worker exited unsuccessfully')
                receipt['events'].append('worker exited successfully')
            except subprocess.TimeoutExpired:
                checked('kill', worker)
                receipt['status'] = 'timed_out'
                receipt['events'].append('worker deadline exceeded; container killed')
            (output / 'worker.log').write_text(docker('logs', worker).stdout + docker('logs', worker).stderr)
            (output / 'gateway.log').write_text(docker('logs', gateway).stdout)
            if receipt['status'] != 'timed_out':
                entries = list(workspace.iterdir())
                candidate = workspace / 'pricing.py'
                if {p.name for p in entries} != {'pricing.py'} or candidate.is_symlink() or not candidate.is_file():
                    receipt['status'] = 'rejected_scope'
                    receipt['events'].append('host rejected unexpected path or symbolic link')
                elif candidate.stat().st_size > 16384:
                    receipt['status'] = 'rejected_scope'
                else:
                    proposed = candidate.read_bytes()
                    # Freeze the candidate before validation: worker is stopped, no writable mount remains.
                    receipt['candidate_sha256'] = digest(proposed)
                    patch = ''.join(difflib.unified_diff(base.decode().splitlines(True), proposed.decode().splitlines(True),
                                                        fromfile='a/pricing.py', tofile='b/pricing.py'))
                    (output / 'patch.diff').write_text(patch)
                    receipt['patch_sha256'] = digest(patch.encode())
                    checked('create', '--name', validator, '--network=none', *common, '--user=65534:65534',
                            '-v', f'{workspace}:/workspace:ro', '-v', f'{ROOT / "validate.py"}:/validate.py:ro',
                            image, 'python', '-I', '/validate.py')
                    checked('start', validator)
                    result = docker('wait', validator, timeout=deadline)
                    logs = docker('logs', validator)
                    (output / 'validator.log').write_text(logs.stdout + logs.stderr)
                    if result.returncode:
                        raise RuntimeError('validator wait failed')
                    passed = result.stdout.strip() == '0' and logs.stdout.strip() == 'PASS: empty, multiple-item, and zero-price carts'
                    receipt['status'] = 'accepted' if passed else 'rejected_tests'
                    receipt['events'].append('independent fixture tests: ' + receipt['status'])
    except Exception as error:
        receipt['status'] = 'error'
        receipt['error'] = str(error)
    finally:
        cleanup = []
        for name in names:
            # Removal is idempotent: never remove resources not named for this run.
            try:
                removed = docker('rm', '-f', name)
                if removed.returncode and 'No such container' not in removed.stderr:
                    cleanup.append('container removal failed: ' + name)
            except (OSError, subprocess.TimeoutExpired):
                cleanup.append('container removal unavailable: ' + name)
        try:
            removed = docker('network', 'rm', network)
            if removed.returncode and 'not found' not in removed.stderr:
                cleanup.append('network removal failed: ' + network)
        except (OSError, subprocess.TimeoutExpired):
            cleanup.append('network removal unavailable: ' + network)
        receipt['cleanup'] = 'complete' if not cleanup else cleanup
        if cleanup:
            receipt['status'] = 'error'
        receipt['elapsed_seconds'] = round(time.monotonic() - start, 3)
        (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scenario', choices=['valid', 'invalid', 'scope', 'symlink', 'timeout'], default='valid')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--image', default='python:3.12-alpine')
    parser.add_argument('--deadline', type=float, default=10)
    args = parser.parse_args()
    if args.deadline <= 0:
        parser.error('deadline must be positive')
    receipt = run(args.scenario, args.output.resolve(), args.image, args.deadline)
    print(json.dumps(receipt, indent=2))
    raise SystemExit(0 if receipt['status'] == 'accepted' else 1)
