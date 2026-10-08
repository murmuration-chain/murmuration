import test from 'node:test';
import assert from 'node:assert/strict';
import { VECTORS, checkVectors } from '../client/vectors.mjs';
import { canonicalJson } from '../common/canon.mjs';

test('conformance vectors re-derive byte-for-byte', () => {
  const res = checkVectors();
  const bad = res.filter((r) => !r.ok);
  assert.deepEqual(bad, []);
  assert.ok(res.length >= 15);
});

test('canonicalJson rejects non-canonical numbers and types; sorts keys', () => {
  assert.throws(() => canonicalJson({ a: 1e21 }));
  assert.throws(() => canonicalJson({ a: NaN }));
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  assert.equal(canonicalJson(VECTORS.canonical_json.input), VECTORS.canonical_json.output);
});
