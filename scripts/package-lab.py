"""Package the public lab and a file-hash manifest for static hosting."""
import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parents[1]
lab = root / 'experiments/bounded-runner'
files = [lab / name for name in ['README.md', 'run.py', 'gateway.py', 'worker.py', 'validate.py', 'test_lab.py', 'fixture/pricing.py']]
files += sorted((lab / 'observed').glob('*/*'))
if not (lab / 'observed/valid/receipt.json').is_file():
    raise SystemExit('record the five observed scenarios before packaging')
expected = {'valid': 'accepted', 'invalid': 'rejected_tests', 'scope': 'rejected_scope', 'symlink': 'rejected_scope', 'timeout': 'timed_out'}
for scenario, status in expected.items():
    receipt = json.loads((lab / 'observed' / scenario / 'receipt.json').read_text())
    if receipt['status'] != status or receipt['cleanup'] != 'complete':
        raise SystemExit(f'invalid evidence for {scenario}')
manifest = {str(path.relative_to(lab)): hashlib.sha256(path.read_bytes()).hexdigest() for path in files}
output = root / 'public/downloads/bounded-runner.zip'
output.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for path in files:
        info = ZipInfo('bounded-runner/' + str(path.relative_to(lab)), (2026, 10, 7, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        archive.writestr(info, path.read_bytes())
    info = ZipInfo('bounded-runner/manifest.json', (2026, 10, 7, 0, 0, 0))
    info.compress_type = ZIP_DEFLATED
    archive.writestr(info, json.dumps(manifest, indent=2) + '\n')
print(output)
