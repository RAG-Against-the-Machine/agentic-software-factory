import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TicketTransition } from '@asf/shared';
import { transitionTicketTo, pickTransition, parsePreferredStatuses } from './transition.js';

const T = (id: string, name: string, toStatus: string): TicketTransition => ({ id, name, toStatus });

// A workflow the way a tracker's /transitions endpoint returns it.
const JIRA_WORKFLOW = [T('21', 'Start Progress', 'In Progress'), T('31', 'Review', 'In Review'), T('41', 'Done', 'Done')];

/** A minimal ticket stub recording the transition it was asked to make. */
function stubTickets(available: TicketTransition[], opts: { transitionsThrows?: boolean; transitionThrows?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    transitions: async () => { if (opts.transitionsThrows) throw new Error('nope'); return available; },
    transition: async (_id: string, transitionId: string) => { if (opts.transitionThrows) throw new Error('denied'); calls.push(transitionId); },
  };
}

// ------------------------------------------------------------------- pure matcher
test('parsePreferredStatuses splits, trims, drops blanks', () => {
  assert.deepEqual(parsePreferredStatuses('In Progress, Doing , ,inflight'), ['In Progress', 'Doing', 'inflight']);
  assert.deepEqual(parsePreferredStatuses(''), []);
  assert.deepEqual(parsePreferredStatuses('  '), []);
});

test('pickTransition matches by destination status, case-insensitive, first wanted wins', () => {
  const hit = pickTransition(JIRA_WORKFLOW, ['in review']);
  assert.equal(hit?.id, '31');
  // preference order matters: "done" before "in review" picks Done
  assert.equal(pickTransition(JIRA_WORKFLOW, ['done', 'in review'])?.id, '41');
});

test('pickTransition matches by transition NAME when status differs', () => {
  // "Start Progress" is the transition name; its destination is "In Progress".
  assert.equal(pickTransition(JIRA_WORKFLOW, ['start progress'])?.id, '21');
});

test('pickTransition returns null when nothing matches', () => {
  assert.equal(pickTransition(JIRA_WORKFLOW, ['blocked', 'on hold']), null);
});

// ------------------------------------------------------------------- transitionTicketTo
test('moves the ticket and returns the destination status', async () => {
  const tk = stubTickets(JIRA_WORKFLOW);
  const to = await transitionTicketTo(tk, 'KAN-1', ['In Review', 'Review']);
  assert.equal(to, 'In Review');
  assert.deepEqual(tk.calls, ['31']);
});

test('blank preferred list disables the move (no transitions() call, returns null)', async () => {
  let queried = false;
  const tk = { transitions: async () => { queried = true; return JIRA_WORKFLOW; }, transition: async () => {} };
  const to = await transitionTicketTo(tk, 'KAN-1', []);
  assert.equal(to, null);
  assert.equal(queried, false, 'a disabled move must not even read the workflow');
});

test('no matching status is null, not an error, and issues no transition', async () => {
  const tk = stubTickets(JIRA_WORKFLOW);
  const to = await transitionTicketTo(tk, 'KAN-1', ['Blocked']);
  assert.equal(to, null);
  assert.deepEqual(tk.calls, []);
});

test('a transitions() that throws is swallowed to null (never fails the run)', async () => {
  const tk = stubTickets(JIRA_WORKFLOW, { transitionsThrows: true });
  assert.equal(await transitionTicketTo(tk, 'KAN-1', ['Done']), null);
});

test('a transition() the account may not perform is swallowed to null', async () => {
  const tk = stubTickets(JIRA_WORKFLOW, { transitionThrows: true });
  assert.equal(await transitionTicketTo(tk, 'KAN-1', ['Done']), null);
});

test('falls back to the transition name when the destination status is empty', async () => {
  const tk = stubTickets([T('9', 'Close Issue', '')]);
  const to = await transitionTicketTo(tk, 'gh#1', ['close issue']);
  assert.equal(to, 'Close Issue');
  assert.deepEqual(tk.calls, ['9']);
});
