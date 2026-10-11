import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comingUpText } from './coming-up.js';

const now = new Date('2026-10-02T08:00:00Z');
const item = (title: string, nextRunAt: string) => ({ title, nextRunAt });

test('later the same day reads "at h:mm AM"', () => {
  assert.equal(comingUpText([item('Update deps', '2026-10-02T09:00:00Z')], now, 'UTC'), 'Update deps at 9:00 AM');
});

test('the next local day reads "tomorrow h:mm AM"', () => {
  assert.equal(comingUpText([item('Dead code sweep', '2026-10-03T09:00:00Z')], now, 'UTC'), 'Dead code sweep tomorrow 9:00 AM');
  // 09:00 UTC on the 3rd is still the 2nd in Los Angeles.
  assert.equal(comingUpText([item('Sweep', '2026-10-03T03:00:00Z')], now, 'America/Los_Angeles'), 'Sweep at 8:00 PM');
});

test('an overdue task reads "any moment"', () => {
  assert.equal(comingUpText([item('Update deps', '2026-10-02T07:59:00Z')], now, 'UTC'), 'Update deps any moment');
});

test('empty is empty; several join with " · "', () => {
  assert.equal(comingUpText([], now, 'UTC'), '');
  assert.equal(comingUpText([item('Update deps', '2026-10-02T09:00:00Z'), item('Dead code sweep', '2026-10-03T09:00:00Z')], now, 'UTC'),
    'Update deps at 9:00 AM · Dead code sweep tomorrow 9:00 AM');
});
