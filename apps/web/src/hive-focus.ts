import { isThemeSlot, type ThemeMood, type ThemePictureState, type ThemeSlot } from '@asf/shared/ui';

/**
 * Who the Hive stage puts in the spotlight, and in what mood (M12 WP4). Pure:
 * run state in, { focus, mood } out. First match wins:
 *
 *   run succeeded                                 orchestrator  delivered
 *   run failed / halted / cancelled / stale       orchestrator  failed
 *   an open gate                                  orchestrator  gate
 *   a task needs_human                            that role     question
 *   a running publish:* task                      orchestrator  delivering
 *   an unresolved publish/merge conflict          orchestrator  conflict
 *   a role task started < HANDOFF_MS ago          that role     handoff
 *   a running role task                           that role     working
 *   otherwise (queued, between tasks)             orchestrator  idle
 */

export const HANDOFF_MS = 4000;

/** Only the fields the focus reads, so tests and callers need not build whole rows. */
export interface FocusRun { state: string }
export interface FocusTask { role: string; state: string; startedAt: string | null; seq?: number }
export interface FocusGate { state: string }
export interface FocusEvent { kind: string }

export interface HiveFocus {
  focus: ThemeSlot;
  mood: ThemeMood;
  /** The role behind the mood, for "{member}" in mood lines (null when it is the orchestrator's own). */
  member: ThemeSlot | null;
}

const FAILED = new Set(['failed', 'halted', 'cancelled', 'stale']);
const CONFLICT_OPEN = new Set(['publish:conflict', 'conflict:merging']);

export function hiveFocus(input: {
  run: FocusRun;
  tasks: readonly FocusTask[];
  gates?: readonly FocusGate[];
  events?: readonly FocusEvent[];
  now?: number;
}): HiveFocus {
  const { run, tasks, gates = [], events = [], now = Date.now() } = input;
  const queen = (mood: ThemeMood): HiveFocus => ({ focus: 'orchestrator', mood, member: null });
  const latestFirst = [...tasks].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));

  if (run.state === 'succeeded') return queen('delivered');
  if (FAILED.has(run.state)) return queen('failed');
  if (gates.some((g) => g.state === 'open')) return queen('gate');

  const asking = latestFirst.find((t) => t.state === 'needs_human' && isThemeSlot(t.role));
  if (asking) return { focus: asking.role as ThemeSlot, mood: 'question', member: asking.role as ThemeSlot };

  const running = latestFirst.filter((t) => t.state === 'running');
  if (running.some((t) => t.role.startsWith('publish:'))) return queen('delivering');

  if (unresolvedConflict(events)) return queen('conflict');

  const working = running.find((t) => isThemeSlot(t.role) && t.role !== 'orchestrator');
  if (working) {
    const slot = working.role as ThemeSlot;
    const started = working.startedAt ? Date.parse(working.startedAt) : NaN;
    const fresh = Number.isFinite(started) && now - started < HANDOFF_MS && now >= started;
    return { focus: slot, mood: fresh ? 'handoff' : 'working', member: slot };
  }
  return queen('idle');
}

/** A conflict was raised (pushing or merging the latest in) and nothing has resolved it since. */
function unresolvedConflict(events: readonly FocusEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const k = events[i].kind;
    if (k === 'conflict:resolved') return false;
    if (CONFLICT_OPEN.has(k)) return true;
  }
  return false;
}

/** Each role's latest task state, for greying out the done and dimming the not-yet-started. */
export function memberStates(tasks: readonly FocusTask[]): Partial<Record<ThemeSlot, string>> {
  const out: Partial<Record<ThemeSlot, string>> = {};
  const bySeq = [...tasks].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const t of bySeq) if (isThemeSlot(t.role)) out[t.role] = t.state;
  return out;
}

/** Moods in which the coordinator itself is busy: handing over, at a check-in, sorting a conflict, delivering. */
const QUEEN_BUSY = new Set<ThemeMood>(['handoff', 'gate', 'conflict', 'delivering']);

/**
 * Which state picture a member shows (M13): `working` while it has the work,
 * `done` once its step is finished, `idle` otherwise (not started, skipped, or
 * a stopped job). The coordinator is `working` while it hands over, holds a
 * check-in, sorts a conflict or delivers, `done` once the job is delivered,
 * and `idle` the rest of the time. `taskState` is the member's latest task
 * state (see memberStates).
 */
export function pictureState(slot: ThemeSlot, f: Pick<HiveFocus, 'focus' | 'mood'>, taskState?: string): ThemePictureState {
  if (slot === 'orchestrator') {
    if (f.mood === 'delivered') return 'done';
    return QUEEN_BUSY.has(f.mood) ? 'working' : 'idle';
  }
  if (f.mood === 'failed') return taskState === 'done' || taskState === 'awaiting_gate' ? 'done' : 'idle';
  if (f.focus === slot) return 'working';
  if (taskState === 'running' || taskState === 'needs_human') return 'working';
  // awaiting_gate: its step is finished and waiting on your go.
  if (taskState === 'done' || taskState === 'awaiting_gate') return 'done';
  return 'idle';
}
