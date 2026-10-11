import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRecurringTaskInputSchema, describeSchedule, isValidTimeZone, nextRunAfter,
  recurringLastRunSchema, recurringTaskSchema, scheduleSchema, updateRecurringTaskInputSchema, type Schedule,
} from './recurring.js';

const next = (s: Schedule, tz: string, after: string) => nextRunAfter(s, tz, new Date(after)).toISOString();
const daily = (time: string): Schedule => ({ kind: 'daily', time });
const weekly = (weekdays: number[], time: string): Schedule => ({ kind: 'weekly', weekdays, time });
const monthly = (day: number, time: string): Schedule => ({ kind: 'monthly', day, time });

test('daily: later today, else tomorrow', () => {
  assert.equal(next(daily('09:00'), 'UTC', '2026-03-10T08:00:00Z'), '2026-03-10T09:00:00.000Z');
  assert.equal(next(daily('09:00'), 'UTC', '2026-03-10T10:00:00Z'), '2026-03-11T09:00:00.000Z');
  // Local time in the zone, not UTC: 09:00 in Tokyo (UTC+9) is 00:00Z.
  assert.equal(next(daily('09:00'), 'Asia/Tokyo', '2026-03-10T08:00:00Z'), '2026-03-11T00:00:00.000Z');
});

test('after exactly equal to a slot returns the next slot', () => {
  assert.equal(next(daily('09:00'), 'UTC', '2026-03-10T09:00:00Z'), '2026-03-11T09:00:00.000Z');
  assert.equal(next(weekly([1], '09:00'), 'UTC', '2026-03-09T09:00:00Z'), '2026-03-16T09:00:00.000Z');
  assert.equal(next(monthly(10, '09:00'), 'UTC', '2026-03-10T09:00:00Z'), '2026-04-10T09:00:00.000Z');
});

test('weekly with several weekdays, and wrapping Saturday to Sunday', () => {
  const mwf = weekly([1, 3, 5], '09:00'); // 2026-03-09 is a Monday
  assert.equal(next(mwf, 'UTC', '2026-03-09T10:00:00Z'), '2026-03-11T09:00:00.000Z');
  assert.equal(next(mwf, 'UTC', '2026-03-11T10:00:00Z'), '2026-03-13T09:00:00.000Z');
  assert.equal(next(mwf, 'UTC', '2026-03-13T10:00:00Z'), '2026-03-16T09:00:00.000Z');
  assert.equal(next(weekly([0], '08:00'), 'UTC', '2026-03-14T12:00:00Z'), '2026-03-15T08:00:00.000Z');
});

test('monthly basics', () => {
  assert.equal(next(monthly(15, '09:00'), 'UTC', '2026-03-10T00:00:00Z'), '2026-03-15T09:00:00.000Z');
  assert.equal(next(monthly(15, '09:00'), 'UTC', '2026-03-20T00:00:00Z'), '2026-04-15T09:00:00.000Z');
  assert.equal(next(monthly(1, '00:00'), 'UTC', '2026-12-31T23:59:00Z'), '2027-01-01T00:00:00.000Z');
});

test('monthly day 31 runs on the last day of shorter months', () => {
  const m31 = monthly(31, '09:00');
  assert.equal(next(m31, 'UTC', '2026-02-01T00:00:00Z'), '2026-02-28T09:00:00.000Z'); // non-leap
  assert.equal(next(m31, 'UTC', '2028-02-01T00:00:00Z'), '2028-02-29T09:00:00.000Z'); // leap
  assert.equal(next(m31, 'UTC', '2026-04-01T00:00:00Z'), '2026-04-30T09:00:00.000Z');
  assert.equal(next(m31, 'UTC', '2026-06-01T00:00:00Z'), '2026-06-30T09:00:00.000Z');
  assert.equal(next(m31, 'UTC', '2026-03-01T00:00:00Z'), '2026-03-31T09:00:00.000Z');
  assert.equal(next(m31, 'UTC', '2026-02-28T09:00:00Z'), '2026-03-31T09:00:00.000Z');
  assert.equal(next(monthly(30, '09:00'), 'UTC', '2026-02-01T00:00:00Z'), '2026-02-28T09:00:00.000Z');
});

test('America/New_York across both DST changes', () => {
  const ny = 'America/New_York';
  // 2026-03-08 spring forward at 02:00 EST -> 03:00 EDT; 2026-11-01 fall back at 02:00 EDT -> 01:00 EST.
  assert.equal(next(daily('09:00'), ny, '2026-03-07T15:00:00Z'), '2026-03-08T13:00:00.000Z'); // EDT
  assert.equal(next(daily('09:00'), ny, '2026-03-07T12:00:00Z'), '2026-03-07T14:00:00.000Z'); // EST
  // 02:30 does not exist on spring-forward day: runs at the transition, 03:00 EDT.
  assert.equal(next(daily('02:30'), ny, '2026-03-08T05:00:00Z'), '2026-03-08T07:00:00.000Z');
  assert.equal(next(daily('02:30'), ny, '2026-03-08T07:00:00Z'), '2026-03-09T06:30:00.000Z');
  // 01:30 happens twice on fall-back day: the earlier (EDT) instant, then the next day.
  assert.equal(next(daily('01:30'), ny, '2026-11-01T04:00:00Z'), '2026-11-01T05:30:00.000Z');
  assert.equal(next(daily('01:30'), ny, '2026-11-01T05:30:00Z'), '2026-11-02T06:30:00.000Z');
  assert.equal(next(daily('02:30'), ny, '2026-11-01T04:00:00Z'), '2026-11-01T07:30:00.000Z');
  assert.equal(next(daily('09:00'), ny, '2026-11-01T00:00:00Z'), '2026-11-01T14:00:00.000Z'); // EST
});

test('Europe/London across both DST changes', () => {
  const ldn = 'Europe/London';
  // 2026-03-29 spring forward at 01:00 GMT -> 02:00 BST; 2026-10-25 fall back at 02:00 BST -> 01:00 GMT.
  assert.equal(next(daily('09:00'), ldn, '2026-03-28T12:00:00Z'), '2026-03-29T08:00:00.000Z');
  // 01:30 is London's gap hour: runs at 02:00 BST (01:00Z).
  assert.equal(next(daily('01:30'), ldn, '2026-03-28T12:00:00Z'), '2026-03-29T01:00:00.000Z');
  // 02:30 exists in London on spring-forward day.
  assert.equal(next(daily('02:30'), ldn, '2026-03-28T12:00:00Z'), '2026-03-29T01:30:00.000Z');
  // 01:30 is London's overlap hour: the earlier (BST) instant.
  assert.equal(next(daily('01:30'), ldn, '2026-10-24T12:00:00Z'), '2026-10-25T00:30:00.000Z');
  assert.equal(next(daily('01:30'), ldn, '2026-10-25T00:30:00Z'), '2026-10-26T01:30:00.000Z');
  assert.equal(next(daily('02:30'), ldn, '2026-10-24T12:00:00Z'), '2026-10-25T02:30:00.000Z');
  assert.equal(next(daily('09:00'), ldn, '2026-10-25T00:00:00Z'), '2026-10-25T09:00:00.000Z'); // GMT
});

test('invalid time zones', () => {
  assert.equal(isValidTimeZone('Europe/London'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Mars/Olympus_Mons'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.throws(() => nextRunAfter(daily('09:00'), 'Mars/Olympus_Mons', new Date()), RangeError);
});

test('schedule schema validates and normalises', () => {
  assert.deepEqual(scheduleSchema.parse({ kind: 'weekly', weekdays: [5, 1, 3, 1], time: '09:00' }),
    { kind: 'weekly', weekdays: [1, 3, 5], time: '09:00' });
  assert.ok(scheduleSchema.safeParse(daily('23:59')).success);
  assert.ok(scheduleSchema.safeParse(daily('00:00')).success);
  for (const bad of [
    daily('24:00'), daily('9:00'), daily('09:60'),
    { kind: 'weekly', weekdays: [], time: '09:00' },
    { kind: 'weekly', weekdays: [7], time: '09:00' },
    monthly(0, '09:00'), monthly(32, '09:00'),
    { kind: 'yearly', time: '09:00' },
  ]) assert.equal(scheduleSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test('create/update input schemas', () => {
  const ok = createRecurringTaskInputSchema.parse({
    title: ' Weekly deps bump ', repoId: 'r1', schedule: daily('09:00'), timezone: 'Europe/London',
  });
  assert.equal(ok.title, 'Weekly deps bump');
  assert.equal(ok.body, '');
  assert.equal(ok.paused, false);
  assert.equal(createRecurringTaskInputSchema.safeParse({ ...ok, timezone: 'Nowhere/Land' }).success, false);
  assert.equal(createRecurringTaskInputSchema.safeParse({ ...ok, title: '' }).success, false);
  assert.deepEqual(updateRecurringTaskInputSchema.parse({ paused: true }), { paused: true });
});

test('recurringLastRun schema accepts a fired slot, a skipped slot, and rejects bad enums', () => {
  const fired = {
    adhocId: 'ADHOC-1', key: '2026-03-10T09:00:00.000Z', runId: 'run_1',
    state: 'succeeded', deliveryOutcome: 'merged', skipped: false, at: '2026-03-10T09:00:00.000Z',
  };
  assert.deepEqual(recurringLastRunSchema.parse(fired), fired);
  const skipped = {
    adhocId: 'ADHOC-1', key: '2026-03-10T09:00:00.000Z', runId: null,
    state: null, deliveryOutcome: null, skipped: true, at: '2026-03-10T09:00:00.000Z',
  };
  assert.deepEqual(recurringLastRunSchema.parse(skipped), skipped);
  assert.equal(recurringLastRunSchema.safeParse({ ...fired, state: 'bogus' }).success, false);
  assert.equal(recurringLastRunSchema.safeParse({ ...fired, deliveryOutcome: 'bogus' }).success, false);
});

test('recurringTask schema round-trips a full task, with and without a lastRun', () => {
  const base = {
    id: 'rt_1', title: 'Weekly deps bump', body: '', repoId: 'r1',
    schedule: weekly([1], '09:00'), timezone: 'Europe/London', paused: false,
    nextRunAt: '2026-03-16T09:00:00.000Z', createdBy: 'user_1', createdAt: '2026-03-01T00:00:00.000Z',
  };
  assert.deepEqual(recurringTaskSchema.parse({ ...base, lastRun: null }), { ...base, lastRun: null });
  const lastRun = {
    adhocId: 'ADHOC-1', key: '2026-03-09T09:00:00.000Z', runId: 'run_1',
    state: 'succeeded', deliveryOutcome: 'merged', skipped: false, at: '2026-03-09T09:00:00.000Z',
  };
  assert.deepEqual(recurringTaskSchema.parse({ ...base, lastRun }), { ...base, lastRun });
  // repoId is required, not nullable.
  assert.equal(recurringTaskSchema.safeParse({ ...base, repoId: undefined, lastRun: null }).success, false);
});

test('describeSchedule wording', () => {
  assert.equal(describeSchedule(weekly([1], '09:00')), 'Every Monday at 9:00 AM');
  assert.equal(describeSchedule(daily('07:30')), 'Every day at 7:30 AM');
  assert.equal(describeSchedule(daily('00:00')), 'Every day at 12:00 AM');
  assert.equal(describeSchedule(daily('12:05')), 'Every day at 12:05 PM');
  assert.equal(describeSchedule(daily('23:59')), 'Every day at 11:59 PM');
  assert.equal(describeSchedule(weekly([1, 3, 5], '17:00')), 'Every Monday, Wednesday and Friday at 5:00 PM');
  assert.equal(describeSchedule(weekly([6, 0], '10:00')), 'Every Sunday and Saturday at 10:00 AM');
  assert.equal(describeSchedule(weekly([0, 1, 2, 3, 4, 5, 6], '09:00')), 'Every day at 9:00 AM');
  assert.equal(describeSchedule(monthly(31, '09:00')), 'Monthly on the 31st (or last day) at 9:00 AM');
  assert.equal(describeSchedule(monthly(1, '09:00')), 'Monthly on the 1st at 9:00 AM');
  assert.equal(describeSchedule(monthly(2, '09:00')), 'Monthly on the 2nd at 9:00 AM');
  assert.equal(describeSchedule(monthly(3, '09:00')), 'Monthly on the 3rd at 9:00 AM');
  assert.equal(describeSchedule(monthly(11, '09:00')), 'Monthly on the 11th at 9:00 AM');
  assert.equal(describeSchedule(monthly(12, '09:00')), 'Monthly on the 12th at 9:00 AM');
  assert.equal(describeSchedule(monthly(21, '09:00')), 'Monthly on the 21st at 9:00 AM');
  assert.equal(describeSchedule(monthly(22, '09:00')), 'Monthly on the 22nd at 9:00 AM');
  assert.equal(describeSchedule(monthly(29, '09:00')), 'Monthly on the 29th (or last day) at 9:00 AM');
});
