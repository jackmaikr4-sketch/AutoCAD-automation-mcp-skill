import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/contracts.mjs';
test('Dimensions must be finite and positive', () => {
  for (const length of [-1, 0, NaN, Infinity])
    assert.throws(() =>
      validate('create_3d_box', { origin: [0, 0, 0], length, width: 1, height: 1 }),
    );
});
test('File overwrite requires explicit selection', () =>
  assert.equal(validate('save_drawing', { path: 'output/a.dwg' }).overwrite, false));
test('Reject malformed handles and unknown input keys', () => {
  assert.throws(() => validate('delete_entities', { handles: ['not-a-handle'] }));
  assert.throws(() => validate('draw_circle', { center: [0, 0, 0], radius: 1, typo: 2 }));
});
test('Reject missing repair action and out-of-range colour', () => {
  assert.throws(() => validate('repair_entity', { handle: 'AB' }));
  assert.throws(() => validate('set_color', { handles: ['AB'], color: 257 }));
});
