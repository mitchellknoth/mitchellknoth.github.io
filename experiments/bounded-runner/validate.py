"""Independent acceptance checks; mounted outside the writable workspace."""
import sys
sys.path.insert(0, '/workspace')
from pricing import total

assert total([]) == 0, 'empty cart must total zero'
assert total([3, 7]) == 10, 'multiple prices must be added'
assert total([0]) == 0, 'zero is a valid total'
print('PASS: empty, multiple-item, and zero-price carts')
