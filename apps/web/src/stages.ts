import type { RunTask } from '@asf/shared';

/**
 * A job's tasks folded into one row per stage (#147). A rejected plan or a review
 * loop re-queues a role as a fresh task, so the raw list reads "planner, planner,
 * planner, implementer…" plus skipped placeholder copies. The page shows the stage
 * once; its attempts are there on click. Pure — no React — so it can be tested.
 */
export interface Attempt {
  task: RunTask;
  /** 1-based among the attempts that actually ran. */
  n: number;
  /** What came back on this attempt: the next attempt's note, or 'approved'. */
  feedback: string | null;
  /** How the next attempt was queued (gate_reject | loop_back | retry | …); null for 'approved'. */
  feedbackBy: string | null;
}

export interface Stage {
  role: string;
  /** Highest-seq attempt: drives status, Retry and the live ticker. */
  latest: RunTask;
  /** Attempts that ran (started, or cost money); never-started placeholders dropped. */
  attempts: Attempt[];
  totalCost: number;
  note: string | null;
}

const TIMES = ['', 'once', 'twice'];
const times = (n: number) => TIMES[n] ?? `${n} times`;

function toStage(role: string, all: RunTask[]): Stage {
  const latest = all[all.length - 1];
  const ranTasks = all.filter((t) => t.startedAt != null || t.costUsd > 0);
  const attempts: Attempt[] = ranTasks.map((t, i) => {
    const next = all[all.indexOf(t) + 1];
    if (next) return { task: t, n: i + 1, feedback: next.queuedReason, feedbackBy: next.queuedBy };
    return { task: t, n: i + 1, feedback: t.state === 'done' ? 'approved' : null, feedbackBy: null };
  });
  const totalCost = all.reduce((s, t) => s + t.costUsd, 0);

  let note: string | null = null;
  const ranBefore = ranTasks.some((t) => t !== latest);
  if (ranBefore && (latest.state === 'pending' || latest.state === 'running')) {
    if (latest.queuedBy === 'gate_reject') note = 're-running after your feedback';
    else if (latest.queuedBy === 'loop_back') note = `round ${all.filter((t) => t.queuedBy === 'loop_back').length + 1} after review`;
    else if (latest.queuedBy === 'retry') note = 'retrying';
    else if (latest.queuedBy === 'merge_conflict') note = role === 'implementer' ? 'resolving a merge conflict' : 're-checking after a merge conflict';
  }
  if (note === null && ranTasks.length > 1) note = `revised ${times(ranTasks.length - 1)}`;
  return { role, latest, attempts, totalCost, note };
}

function group(tasks: RunTask[]): Stage[] {
  const byRole = new Map<string, RunTask[]>();
  for (const t of [...tasks].sort((a, b) => a.seq - b.seq)) {
    const role = String(t.role);
    byRole.set(role, [...(byRole.get(role) ?? []), t]);
  }
  return [...byRole].map(([role, all]) => toStage(role, all));
}

export function groupStages(tasks: RunTask[]): { roles: Stage[]; publish: Stage[] } {
  return {
    roles: group(tasks.filter((t) => t.runtime !== 'publish')),
    publish: group(tasks.filter((t) => t.runtime === 'publish')),
  };
}
