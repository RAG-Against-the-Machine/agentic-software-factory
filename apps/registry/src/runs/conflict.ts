import { CONFLICT_QUEUED_BY, MAX_CONFLICT_RESOLUTIONS, parseMergeConflict } from '@asf/shared';
import type { RunTask } from '@asf/shared';
import type { Sql, Db } from '../db/pool.js';
import { appendEventTx, getRun } from './store.js';
import { newId } from './ids.js';

/**
 * Merge conflicts at publish time. The worker merges the current base into the run's
 * branch before pushing; when other work merged since the run started touches the same
 * lines, publish:push_open fails with a reason in the shared `formatMergeConflict`
 * format. Rather than failing the run (and throwing away the delivery), the
 * orchestrator hands the conflict back to the implementer — the worker leaves git's
 * conflict markers in the worktree and tells it which files — then the tester and
 * reviewer re-check the result and the publish phase pushes again.
 *
 * Bounded: MAX_CONFLICT_RESOLUTIONS automatic rounds per run, then the run fails as
 * before and a person can start another round from the run page (resolveConflict).
 */

export class ConflictError extends Error {}

/** A failed push step whose reason is a merge conflict (new format, or the pre-#conflict wording). */
export function isConflictFailure(t: Pick<RunTask, 'runtime' | 'role' | 'state' | 'reason'>): boolean {
  if (t.runtime !== 'publish' || String(t.role) !== 'publish:push_open' || t.state !== 'failed') return false;
  return parseMergeConflict(t.reason) !== null || /conflict with work merged since the run started/.test(t.reason ?? '');
}

/** How many conflict rounds this run has had (each re-queues one implementer). */
export async function conflictRounds(tx: Db, runId: string): Promise<number> {
  const [{ n }] = await tx`SELECT count(*)::int AS n FROM run_task WHERE run_id = ${runId} AND role = 'implementer' AND queued_by = ${CONFLICT_QUEUED_BY}`;
  return Number(n);
}

/**
 * Called by the orchestrator for a failed push step. Returns true when it handed the
 * conflict back to the team (the run keeps going), false when the bound is reached
 * and the run should fail as usual.
 */
export async function maybeLoopBackForConflict(tx: Db, runId: string, tasks: RunTask[], failed: RunTask): Promise<boolean> {
  if (!isConflictFailure(failed)) return false;
  const rounds = await conflictRounds(tx, runId);
  if (rounds >= MAX_CONFLICT_RESOLUTIONS) {
    await appendEventTx(tx, { runId, taskId: failed.id, kind: 'publish:conflict', source: 'orchestrator',
      payload: { action: 'gave_up', rounds, max: MAX_CONFLICT_RESOLUTIONS, files: parseMergeConflict(failed.reason)?.files ?? [] } });
    return false;
  }
  await requeueForConflict(tx, runId, tasks, failed, null);
  return true;
}

/**
 * A person asked ASF to resolve the conflict that failed this run (the run page's
 * "Resolve the conflict"). Not bounded by MAX_CONFLICT_RESOLUTIONS: a person decided.
 */
export async function resolveConflict(sql: Sql, runId: string, by: string | null): Promise<void> {
  const cur = await getRun(sql, runId);
  if (!cur) throw new ConflictError(`no run ${runId}`);
  const { run, tasks } = cur;
  if (run.state !== 'failed') throw new ConflictError(`the run is ${run.state}; only a run that failed on a merge conflict can be resolved`);
  const failed = [...tasks].reverse().find((t) => t.state === 'failed');
  if (!failed || !isConflictFailure(failed)) throw new ConflictError('this run did not fail on a merge conflict');
  await sql.begin(async (tx) => {
    await requeueForConflict(tx, runId, tasks, failed, by);
    await tx`UPDATE agent_run SET reason = NULL, finished_at = NULL WHERE id = ${runId}`;
  });
}

async function requeueForConflict(tx: Db, runId: string, tasks: RunTask[], failed: RunTask, by: string | null): Promise<void> {
  const files = parseMergeConflict(failed.reason)?.files ?? [];
  // The latest copy of each role from the implementer onward re-runs, in order.
  const roleTasks = tasks.filter((t) => t.runtime !== 'publish');
  const latest = new Map<string, RunTask>();
  for (const t of [...roleTasks].sort((a, b) => a.seq - b.seq)) latest.set(String(t.role), t);
  const impl = latest.get('implementer');
  if (!impl) throw new ConflictError('this run has no implementer to resolve the conflict');
  const toReplay = [...latest.values()].filter((t) => t.seq >= impl.seq).sort((a, b) => a.seq - b.seq);

  // The failed push is superseded; the next publish pass queues a fresh one.
  await tx`UPDATE run_task SET state = 'skipped', reason = ${`superseded: handed the merge conflict back to the implementer`} WHERE id = ${failed.id}`;
  const [{ next }] = await tx`SELECT coalesce(max(seq),0)+1 AS next FROM run_task WHERE run_id = ${runId}`;
  let seq = Number(next);
  const note = files.length ? `resolve the merge conflict in ${files.join(', ')}` : 'resolve the merge conflict with the current base';
  for (const t of toReplay) {
    const isImpl = t.id === impl.id;
    await tx`INSERT INTO run_task (id, run_id, role, seq, state, attempt, input_ref, output_ref, runtime, model, effort, reason, queued_by, queued_reason)
      VALUES (${newId('task')}, ${runId}, ${t.role}, ${seq}, 'pending', ${Number(t.attempt) + 1}, ${t.inputRef}, ${t.outputRef}, ${t.runtime}, ${t.model}, ${t.effort},
              ${isImpl ? `conflict: ${files.join(', ')}` : null}, ${CONFLICT_QUEUED_BY}, ${isImpl ? note : null})`;
    seq++;
  }
  await tx`UPDATE agent_run SET state = 'running' WHERE id = ${runId}`;
  await appendEventTx(tx, { runId, taskId: failed.id, kind: 'publish:conflict', source: by ? 'human' : 'orchestrator',
    payload: { action: 'resolving', files, by, roles: toReplay.map((t) => String(t.role)) } });
}
