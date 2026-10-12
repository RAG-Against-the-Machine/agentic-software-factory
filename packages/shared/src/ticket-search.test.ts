import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketMatches, looksLikeTicketRef, ticketRefCandidates, keyPrefixes } from './ticket-search.js';

const t = { key: 'DCP-1234', title: 'Fix the login button' };

test('search matches the ticket key, the bare number and the title', () => {
  // Part of a key matches too, so typing narrows the list as you go.
  for (const q of ['DCP-1234', 'dcp-1234', '1234', '#1234', 'dcp-12', '123', 'login', '  LOGIN ', '']) assert.equal(ticketMatches(t, q), true, q);
  for (const q of ['DCP-999', '#999', '5', 'logout']) assert.equal(ticketMatches(t, q), false, q);
  assert.equal(ticketMatches({ key: 'acme/web#42', title: 'x' }, '42'), true);
});

test('only number-like searches trigger a direct lookup', () => {
  for (const q of ['DCP-1234', 'dcp-7', '1234', '#1234', 'acme/web#42']) assert.equal(looksLikeTicketRef(q), true, q);
  for (const q of ['login', 'fix 1234', '', 'DCP-']) assert.equal(looksLikeTicketRef(q), false, q);
});

test('lookup candidates: the key itself, or the number under each project prefix (capped)', () => {
  assert.deepEqual(ticketRefCandidates('dcp-1234', []), ['DCP-1234']);
  assert.deepEqual(ticketRefCandidates('1234', ['DCP', 'web', 'DCP']), ['DCP-1234', 'WEB-1234']);
  assert.deepEqual(ticketRefCandidates('#9', ['A', 'B', 'C', 'D', 'E', 'F'], 3), ['A-9', 'B-9', 'C-9']);
  assert.deepEqual(ticketRefCandidates('1234', []), []);
  assert.deepEqual(ticketRefCandidates('acme/web#42', []), ['acme/web#42']);
  assert.deepEqual(ticketRefCandidates('login', ['DCP']), []);
  assert.deepEqual(ticketRefCandidates('1234', ['bad key', '"x"']), []);
  assert.deepEqual(keyPrefixes(['DCP-1', 'dcp-2', 'WEB-3', 'adhoc:x']), ['DCP', 'WEB']);
});
