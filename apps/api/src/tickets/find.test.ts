import test from 'node:test';
import assert from 'node:assert/strict';
import type { Ticket } from '@asf/shared';
import { findTicketsByRef } from './find.js';

const mk = (key: string): Ticket => ({ id: key, key, title: `t ${key}`, body: '', status: 'Done', bucket: 'done', labels: [] } as unknown as Ticket);

test('finds a ticket by key or bare number, skipping ids the tracker does not have', async () => {
  const have = new Set(['DCP-1234', 'WEB-1234']);
  const asked: string[] = [];
  const get = async (id: string) => { asked.push(id); if (!have.has(id)) throw new Error('404'); return mk(id); };
  assert.deepEqual((await findTicketsByRef(get, 'dcp-1234', [])).map((t) => t.key), ['DCP-1234']);
  assert.deepEqual((await findTicketsByRef(get, '1234', ['DCP', 'OPS', 'WEB'])).map((t) => t.key), ['DCP-1234', 'WEB-1234']);
  assert.deepEqual(await findTicketsByRef(get, '999', ['DCP']), []);
  asked.length = 0;
  assert.deepEqual(await findTicketsByRef(get, 'login button', ['DCP']), []);
  assert.deepEqual(asked, [], 'a text search never calls the tracker');
});
