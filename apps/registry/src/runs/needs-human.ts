import type { Sql, Db } from '../db/pool.js';
import { appendEventTx, getRun } from './store.js';
import { saveArtifact } from './gates-store.js';
import { advance } from './orchestrate.js';
import { newId } from './ids.js';

export class NeedsHumanError extends Error {}

/**
 * A human answered (or chose to skip) a task parked at needs_human — the M6 WP6.4
 * inbox. Answering saves the reply as the run artifact `human-reply.md` (so the
 * worker can surface it to the re-run role as {{prior.humanReply}}) and re-queues
 * the SAME role as a fresh pending task (attempt+1), returning the run to running.
 * Skipping marks the task skipped so the orchestrator moves on to the next role.
 */
export async function answerNeedsHuman(sql: Sql, runId: string, reply: string, by: string | null): Promise<void> {
  const parked = await getParkedTask(sql, runId);
  await saveArtifact(sql, runId, 'human-reply.md', reply);
  await sql.begin(async (tx) => {
    await requeueSameRole(tx, runId, parked, reply);
    await tx`UPDATE agent_run SET state = 'running' WHERE id = ${runId} AND state = 'awaiting_checkpoint'`;
    await appendEventTx(tx, { runId, taskId: parked.id, kind: 'needs_human:answered', source: 'human', payload: { role: parked.role, by } });
  });
  await advance(sql, runId);
}

export async function skipNeedsHuman(sql: Sql, runId: string, by: string | null): Promise<void> {
  const parked = await getParkedTask(sql, runId);
  await sql.begin(async (tx) => {
    await tx`UPDATE run_task SET state = 'skipped', reason = 'skipped by operator' WHERE id = ${parked.id}`;
    await tx`UPDATE agent_run SET state = 'running' WHERE id = ${runId} AND state = 'awaiting_checkpoint'`;
    await appendEventTx(tx, { runId, taskId: parked.id, kind: 'needs_human:skipped', source: 'human', payload: { role: parked.role, by } });
  });
  await advance(sql, runId);
}

interface ParkedTask { id: string; role: string; seq: number; attempt: number; inputRef: string | null; outputRef: string | null; runtime: string | null; model: string | null; effort: string | null; }

async function getParkedTask(sql: Sql, runId: string): Promise<ParkedTask> {
  const cur = await getRun(sql, runId);
  if (!cur) throw new NeedsHumanError(`no run ${runId}`);
  const t = cur.tasks.find((x) => x.state === 'needs_human');
  if (!t) throw new NeedsHumanError(`run ${runId} has no task awaiting a human answer`);
  return { id: t.id, role: String(t.role), seq: t.seq, attempt: t.attempt, inputRef: t.inputRef, outputRef: t.outputRef, runtime: t.runtime, model: t.model, effort: t.effort };
}

/**
 * Re-queue the parked role the same way a gate rejection does: skip the parked
 * task and every still-pending/done downstream role, then re-append the role and
 * its downstream copies at fresh seqs so the claim query (which needs every
 * earlier seq done/skipped) will actually offer the re-run.
 */
async function requeueSameRole(tx: Db, runId: string, parked: ParkedTask, reply: string): Promise<void> {
  const downstream = await tx`SELECT * FROM run_task WHERE run_id = ${runId} AND runtime <> 'publish'
    AND seq >= ${parked.seq} AND state IN ('pending','done','needs_human') ORDER BY seq`;
  const [{ next }] = await tx`SELECT coalesce(max(seq),0)+1 AS next FROM run_task WHERE run_id = ${runId}`;
  let seq = Number(next);
  for (const t of downstream) {
    await tx`UPDATE run_task SET state = 'skipped', reason = 'superseded by human answer' WHERE id = ${t.id}`;
    const reason = String(t.id) === parked.id ? `human answer: ${reply.slice(0, 200)}` : null;
    const queuedReason = String(t.id) === parked.id ? reply.slice(0, 300) : null;
    await tx`INSERT INTO run_task (id, run_id, role, seq, state, attempt, input_ref, output_ref, runtime, model, effort, reason, queued_by, queued_reason)
      VALUES (${newId('task')}, ${runId}, ${t.role}, ${seq}, 'pending', ${Number(t.attempt) + 1}, ${t.inputRef}, ${t.outputRef}, ${t.runtime}, ${t.model}, ${t.effort}, ${reason}, 'needs_human_answer', ${queuedReason})`;
    seq++;
  }
}
