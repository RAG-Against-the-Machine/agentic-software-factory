import { z } from 'zod';
import { runSchema, runStateSchema } from './run.js';

/**
 * Recurring tasks (#188): an ad-hoc task the factory creates on a schedule. This
 * module is the schedule model and the pure next-run calculation; storage, the
 * firing loop, the api and the UI build on it.
 *
 * Browser-safe (re-exported from ui.ts): no node built-ins here. Zone offsets
 * come from Intl.DateTimeFormat, so no time-zone library is needed.
 */

/** Wall-clock time of day, 24-hour `HH:MM` (00:00–23:59). */
export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a time as HH:MM (00:00–23:59)');

export const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), time: timeSchema }),
  z.object({
    kind: z.literal('weekly'),
    /** 0 = Sunday … 6 = Saturday; normalised to sorted and deduplicated. */
    weekdays: z.array(z.number().int().min(0).max(6)).min(1, 'Pick at least one weekday')
      .transform((ds) => [...new Set(ds)].sort((a, b) => a - b)),
    time: timeSchema,
  }),
  /** Day 29–31 runs on the last day of shorter months. */
  z.object({ kind: z.literal('monthly'), day: z.number().int().min(1).max(31), time: timeSchema }),
]);
export type Schedule = z.infer<typeof scheduleSchema>;

/** True when `tz` is an IANA time zone this runtime knows (e.g. "Europe/London"). */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const timeZoneSchema = z.string().refine(isValidTimeZone, 'Unknown time zone');

/** What happened the last time the schedule fired. */
export const recurringLastRunSchema = z.object({
  adhocId: z.string(),
  key: z.string(),
  runId: z.string().nullable(),
  state: runStateSchema.nullable(),
  deliveryOutcome: runSchema.shape.deliveryOutcome.removeDefault(),
  /** True when the slot was skipped (e.g. the previous run was still going) rather than fired. */
  skipped: z.boolean(),
  at: z.string(),
});
export type RecurringLastRun = z.infer<typeof recurringLastRunSchema>;

export const recurringTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),               // Markdown
  repoId: z.string(),
  schedule: scheduleSchema,
  timezone: timeZoneSchema,
  paused: z.boolean(),
  nextRunAt: z.string().nullable(),
  lastRun: recurringLastRunSchema.nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});
export type RecurringTask = z.infer<typeof recurringTaskSchema>;

export const createRecurringTaskInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(100_000).default(''),
  repoId: z.string().min(1),
  schedule: scheduleSchema,
  timezone: timeZoneSchema,
  paused: z.boolean().default(false),
});
export type CreateRecurringTaskInput = z.infer<typeof createRecurringTaskInputSchema>;

export const updateRecurringTaskInputSchema = createRecurringTaskInputSchema.partial();
export type UpdateRecurringTaskInput = z.infer<typeof updateRecurringTaskInputSchema>;

// ---------------------------------------------------------------------------
// Next-run calculation

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    // Throws RangeError for an unknown zone.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

function localParts(tz: string, t: number): LocalParts {
  const p: Record<string, number> = {};
  for (const { type, value } of formatter(tz).formatToParts(new Date(t))) {
    if (type !== 'literal') p[type] = Number(value);
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour % 24, minute: p.minute, second: p.second };
}

/** The zone's UTC offset in ms at instant `t` (local = UTC + offset). */
function offsetAt(tz: string, t: number): number {
  const l = localParts(tz, t);
  const asUtc = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/**
 * The instant at which local wall time `wall` (expressed as if it were UTC) occurs
 * in `tz`. An ambiguous time (fall-back overlap) resolves to the earlier instant;
 * a non-existent time (spring-forward gap) resolves to the transition instant,
 * the first valid instant after it.
 */
function wallToInstant(tz: string, wall: number): number {
  const before = offsetAt(tz, wall - DAY);
  const after = offsetAt(tz, wall + DAY);
  const valid = [before, after, offsetAt(tz, wall)]
    .map((o) => wall - o)
    .filter((t) => offsetAt(tz, t) === wall - t);
  if (valid.length > 0) return Math.min(...valid);
  // Gap: the offset changes from `before` to `after` somewhere in [wall - after, wall - before].
  let lo = wall - after;   // still on the old offset
  let hi = wall - before;  // already on the new offset
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000;
    if (mid <= lo) break;
    if (offsetAt(tz, mid) === before) lo = mid; else hi = mid;
  }
  return hi;
}

const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The first instant strictly after `after` at which `schedule` fires in time zone
 * `tz`. Pure. Throws RangeError for an unknown time zone.
 */
export function nextRunAfter(schedule: Schedule, tz: string, after: Date): Date {
  const afterMs = after.getTime();
  const [hh, mm] = schedule.time.split(':').map(Number);
  const start = localParts(tz, afterMs);
  const startDay = Date.UTC(start.year, start.month - 1, start.day);
  // Start a day early in case a slot on the previous local day lands after `after`.
  for (let i = -1; i <= 40; i++) {
    const d = new Date(startDay + i * DAY);
    const year = d.getUTCFullYear(), month = d.getUTCMonth() + 1, day = d.getUTCDate();
    if (schedule.kind === 'weekly' && !schedule.weekdays.includes(d.getUTCDay())) continue;
    if (schedule.kind === 'monthly' && day !== Math.min(schedule.day, daysInMonth(year, month))) continue;
    const t = wallToInstant(tz, Date.UTC(year, month - 1, day, hh, mm));
    if (t > afterMs) return new Date(t);
  }
  throw new RangeError(`No run found for schedule within 40 days of ${after.toISOString()}`);
}

// ---------------------------------------------------------------------------
// Wording

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function clock12(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

function joinAnd(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** e.g. "Every Monday at 9:00 AM", "Every day at 7:30 AM", "Monthly on the 31st (or last day) at 9:00 AM". */
export function describeSchedule(schedule: Schedule): string {
  const at = `at ${clock12(schedule.time)}`;
  switch (schedule.kind) {
    case 'daily':
      return `Every day ${at}`;
    case 'weekly': {
      const days = [...new Set(schedule.weekdays)].sort((a, b) => a - b);
      if (days.length === 7) return `Every day ${at}`;
      return `Every ${joinAnd(days.map((d) => WEEKDAY_NAMES[d]))} ${at}`;
    }
    case 'monthly':
      return `Monthly on the ${ordinal(schedule.day)}${schedule.day >= 29 ? ' (or last day)' : ''} ${at}`;
  }
}
