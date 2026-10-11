import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adhocBodyLimitBytes, isAdhocId, isAllowedAttachmentMime, safeAttachmentName } from './adhoc.js';

test('isAdhocId matches only the adhoc: prefix', () => {
  assert.equal(isAdhocId('adhoc:0123456789abcdef'), true);
  assert.equal(isAdhocId('asf-123'), false);
});

test('isAllowedAttachmentMime is case-insensitive and ignores a charset parameter, but excludes svg', () => {
  assert.equal(isAllowedAttachmentMime('image/PNG'), true);
  assert.equal(isAllowedAttachmentMime('text/plain; charset=utf-8'), true);
  assert.equal(isAllowedAttachmentMime('image/svg+xml'), false);
  assert.equal(isAllowedAttachmentMime(''), false);
});

test('safeAttachmentName strips directory parts and disallowed characters, and never returns empty', () => {
  assert.equal(safeAttachmentName('../../etc/shot.png'), 'shot.png');
  assert.equal(safeAttachmentName('C:\\Users\\ana\\notes.txt'), 'notes.txt');
  assert.equal(safeAttachmentName('..hidden'), 'hidden');
  assert.equal(safeAttachmentName('a b?c*.png'), 'a_b_c_.png');
  assert.equal(safeAttachmentName(''), 'file');
  assert.equal(safeAttachmentName('...'), 'file');
  assert.equal(safeAttachmentName('a'.repeat(150)), 'a'.repeat(100));
});

test('adhocBodyLimitBytes scales with the configured limits and leaves headroom for JSON framing', () => {
  const small = adhocBodyLimitBytes({ maxFiles: 1, maxFileMb: 1 });
  const large = adhocBodyLimitBytes({ maxFiles: 10, maxFileMb: 10 });
  assert.ok(small > 1024 * 1024, 'at least the 1 MiB framing allowance');
  assert.ok(large > small);
  // base64 (4/3) of 10 files * 10 MB, plus the 1 MiB allowance.
  assert.equal(large, Math.ceil(10 * 10 * 1024 * 1024 * 4 / 3) + 1024 * 1024);
});
