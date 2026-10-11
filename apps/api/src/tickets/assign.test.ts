import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignTicketTo } from './assign.js';

/** A minimal ticket stub recording assign() calls. */
function stubTickets(opts: { throws?: boolean } = {}) {
  const calls: Array<{ id: string; assignee: string | null }> = [];
  return {
    calls,
    assign: async (id: string, assignee: string | null) => {
      if (opts.throws) throw new Error('cannot assign');
      calls.push({ id, assignee });
    },
  };
}

test('assigns the ticket and returns true', async () => {
  const tk = stubTickets();
  const ok = await assignTicketTo(tk, 'KAN-1', '557058:bot-account-id');
  assert.equal(ok, true);
  assert.deepEqual(tk.calls, [{ id: 'KAN-1', assignee: '557058:bot-account-id' }]);
});

test('trims the configured identity before assigning', async () => {
  const tk = stubTickets();
  await assignTicketTo(tk, 'KAN-1', '  asf-bot  ');
  assert.equal(tk.calls[0]!.assignee, 'asf-bot');
});

test('blank TICKET_ASSIGNEE disables assignment (no call, returns false)', async () => {
  const tk = stubTickets();
  assert.equal(await assignTicketTo(tk, 'KAN-1', ''), false);
  assert.equal(await assignTicketTo(tk, 'KAN-1', '   '), false);
  assert.deepEqual(tk.calls, []);
});

test('a provider that cannot assign is swallowed to false (never fails the run)', async () => {
  const tk = stubTickets({ throws: true });
  assert.equal(await assignTicketTo(tk, 'KAN-1', 'asf-bot'), false);
});
