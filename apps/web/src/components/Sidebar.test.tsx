import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINKS } from './Sidebar';

test('every primary nav link has a short label for the phone tab bar', () => {
  for (const l of LINKS) {
    assert.ok(l.short && l.short.trim(), `${l.to} needs a short label`);
    assert.ok(l.short.length <= 10, `${l.to}: "${l.short}" is too long for a tab`);
  }
});
