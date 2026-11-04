"""Integration matrix requiring Docker; checks observed statuses and artifacts."""
import json
import tempfile
import unittest
from pathlib import Path
from run import run, digest, ROOT

class ExecutionContract(unittest.TestCase):
    def test_matrix(self):
        expected = {'valid': 'accepted', 'invalid': 'rejected_tests',
                    'scope': 'rejected_scope', 'symlink': 'rejected_scope', 'timeout': 'timed_out'}
        with tempfile.TemporaryDirectory() as temporary:
            for mode, status in expected.items():
                with self.subTest(scenario=mode):
                    output = Path(temporary) / mode
                    receipt = run(mode, output, 'python:3.12-alpine', 3 if mode == 'timeout' else 10)
                    self.assertEqual(receipt['status'], status, receipt)
                    self.assertEqual(receipt['cleanup'], 'complete')
                    self.assertTrue(receipt['internal_network'])
                    self.assertEqual(receipt, json.loads((output / 'receipt.json').read_text()))
                    self.assertEqual(receipt['base_sha256'], digest((ROOT / 'fixture/pricing.py').read_bytes()))
                    self.assertIn('credential_mediated', (output / 'gateway.log').read_text())
                    self.assertIn('route_denied', (output / 'gateway.log').read_text())
                    self.assertIn('method_denied', (output / 'gateway.log').read_text())
                    self.assertIn('token absent', (output / 'worker.log').read_text())
                    self.assertIn('upstream port unavailable', (output / 'worker.log').read_text())
                    if mode in ('valid', 'invalid'):
                        patch = (output / 'patch.diff').read_bytes()
                        self.assertEqual(receipt['patch_sha256'], digest(patch))
                        self.assertIn(b'--- a/pricing.py', patch)
                    if mode == 'valid':
                        self.assertIn('PASS:', (output / 'validator.log').read_text())
                    if mode == 'invalid':
                        self.assertIn('AssertionError', (output / 'validator.log').read_text())

if __name__ == '__main__':
    unittest.main()
