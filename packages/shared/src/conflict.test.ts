import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMergeConflict, parseMergeConflict } from './conflict.js';

test('a merge-conflict reason round-trips, and anything else is not one', () => {
  const r = formatMergeConflict('main', ['apps/web/package.json', 'apps/web/src/api.ts']);
  assert.deepEqual(parseMergeConflict(r), { base: 'main', files: ['apps/web/package.json', 'apps/web/src/api.ts'] });
  assert.deepEqual(parseMergeConflict(formatMergeConflict('develop', [])), { base: 'develop', files: [] });
  assert.equal(parseMergeConflict('nothing to publish: the branch has no changes over its base'), null);
  assert.equal(parseMergeConflict(null), null);
  assert.equal(parseMergeConflict(undefined), null);
});
