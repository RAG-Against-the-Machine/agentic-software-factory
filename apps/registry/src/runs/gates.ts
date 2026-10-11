import type { Sql, Db } from '../db/pool.js';
import { appendEventTx, setRunState } from './store.js';
import { getGate, decideGate, saveArtifact } from './gates-store.js';
import { advance } from './orchestrate.js';
import { newId } from './ids.js';
import { applySplit } from './split.js';

export class GateError extends Error {}

/**
 * A human answered a gate. Approve resumes the run (and, if the plan was edited,
 * the edited artifact becomes the one the next role reads). Reject sends the
 * producing role back with the note appended, so the agent revises rather than
 * the run simply failing.
 */
export async function resolveGate(sql: Sql, gateId: string, d: { decision: 'approve' | 'reject'; by: string | null; note: string | null; editedArtifact: string | null }): Promise<void> {
  const runId = await sql.begin(async (tx) => {
    const gate = await getGate(sql, gateId);
    if (!gate) throw new GateError(`no gate ${gateId}`);
    if (gate.state !== 'open') throw new GateError(`gate ${gateId} is ${gate.state}, not open`);

    await decideGate(tx, gateId, { state: d.decision === 'approve' ? 'approved' : 'rejected', decidedBy: d.by, note: d.note, editedArtifact: d.editedArtifact });
    await appendEventTx(tx, { runId: gate.runId, taskId: gate.afterTask, kind: 'gate:resolved', source: 'human',
      payload: { gate: gate.gateName, decision: d.decision, by: d.by, note: d.note, edited: Boolean(d.editedArtifact) } });

    if (d.decision === 'approve') {
      // An edited artifact (e.g. an operator rewrote plan.md) replaces the stored one.
      if (d.editedArtifact && gate.afterTask) {
        const outputRef = await taskOutput(tx, gate.afterTask);
        if (outputRef) { await saveArtifact(tx, gate.runId, outputRef, d.editedArtifact, { taskId: gate.afterTask, source: 'human' });
          await appendEventTx(tx, { runId: gate.runId, taskId: gate.afterTask, kind: 'plan:edited', source: 'human', payload: { artifact: outputRef, by: d.by } }); }
      }
      // An approved plan that proposes a split creates + queues the parts and
      // finishes this run; it does not resume the team. Only the plan gate splits.
      if (gate.gateName === 'after_plan') {
        const plan = d.editedArtifact ?? (gate.afterTask ? await artifactOf(tx, gate.runId, gate.afterTask) : null) ?? gate.artifact;
        const parts = await applySplit(tx, gate.runId, plan, d.by);
        if (parts) return gate.runId;
      }
      await tx`UPDATE agent_run SET state = 'running' WHERE id = ${gate.runId} AND state = 'awaiting_checkpoint'`;
    } else {
      // Reject: send the work back to revise, then re-gate.
      if (gate.afterTask) {
        // A role gate (e.g. after_plan): re-queue the producing role with the note.
        await requeueTask(tx, gate.runId, gate.afterTask, d.note);
      } else {
        // A publish gate (before_change_request / before_merge) has no producing
        // task. Re-queue the LAST role (reviewer) so the team revises, and reset
        // this run's publish tasks so the publish phase runs again after the
        // revision — otherwise the orchestrator sees them 'done' and skips
        // straight past the gate it was just told to reject.
        await requeueLastRole(tx, gate.runId, d.note);
        await tx`UPDATE run_task SET state = 'skipped', reason = 'superseded by gate rejection'
          WHERE run_id = ${gate.runId} AND runtime = 'publish' AND state IN ('pending','done')`;
      }
      await tx`UPDATE agent_run SET state = 'running' WHERE id = ${gate.runId}`;
    }
    return gate.runId;
  });
  await advance(sql, runId);
}

/** The latest content of the artifact a task produced (plan.md for the planner). */
async function artifactOf(tx: Db, runId: string, taskId: string): Promise<string | null> {
  const ref = await taskOutput(tx, taskId);
  if (!ref) return null;
  const rows = await tx`SELECT content FROM latest_run_artifact WHERE run_id = ${runId} AND name = ${ref}`;
  return rows.length ? String(rows[0].content) : null;
}

async function taskOutput(tx: Db, taskId: string): Promise<string | null> {
  const rows = await tx`SELECT output_ref FROM run_task WHERE id = ${taskId}`;
  return rows.length && rows[0].outputRef ? String(rows[0].outputRef) : null;
}

/**
 * Re-queue the run's LAST role (the reviewer in the standard team) so the team
 * revises before the publish phase is attempted again. Used when a publish gate
 * (which has no producing task of its own) is rejected.
 */
async function requeueLastRole(tx: Db, runId: string, note: string | null): Promise<void> {
  const rows = await tx`SELECT id FROM run_task WHERE run_id = ${runId} AND runtime <> 'publish'
    AND state IN ('done','skipped') ORDER BY seq DESC LIMIT 1`;
  if (!rows.length) return;
  await requeueTask(tx, runId, String(rows[0].id), note);
}

async function requeueTask(tx: Db, runId: string, taskId: string, note: string | null): Promise<void> {
  const rows = await tx`SELECT * FROM run_task WHERE id = ${taskId}`;
  if (!rows.length) return;
  const rejected = rows[0];
  // Skip the rejected task and every still-pending role task after it, then
  // re-append the rejected role followed by fresh copies of the downstream
  // roles — otherwise the re-queued role sits behind pending tasks with a lower
  // seq and the claim query (which requires earlier seq done/skipped) never
  // offers it.
  const downstream = await tx`SELECT * FROM run_task WHERE run_id = ${runId} AND runtime <> 'publish'
    AND seq >= ${Number(rejected.seq)} AND state IN ('pending','done') ORDER BY seq`;
  const [{ next }] = await tx`SELECT coalesce(max(seq),0)+1 AS next FROM run_task WHERE run_id = ${runId}`;
  let seq = Number(next);
  for (const t of downstream) {
    await tx`UPDATE run_task SET state = 'skipped', reason = 'superseded by gate rejection' WHERE id = ${t.id}`;
    const reason = t.id === taskId && note ? `revise: ${note}` : null;
    // The rejected role carries the note + is queued BY the rejection (counts
    // against the review loop bound when it is the loop target); copies ride along.
    const queuedReason = t.id === taskId ? (note ?? null) : null;
    await tx`INSERT INTO run_task (id, run_id, role, seq, state, attempt, input_ref, output_ref, runtime, model, effort, reason, queued_by, queued_reason)
      VALUES (${newId('task')}, ${runId}, ${t.role}, ${seq}, 'pending', ${Number(t.attempt) + 1}, ${t.inputRef}, ${t.outputRef}, ${t.runtime}, ${t.model}, ${t.effort}, ${reason}, 'gate_reject', ${queuedReason})`;
    seq++;
  }
  // A rejection that re-runs the reviewer (or the loop target) will produce another
  // review, so it counts against the review-loop bound — otherwise rejecting a
  // reviewer gate is a free extra cycle the loopBack counter never sees.
  if (['reviewer', 'implementer'].includes(String(rejected.role))) {
    await tx`UPDATE agent_run SET review_iterations = review_iterations + 1 WHERE id = ${runId}`;
  }
}

/**
 * Retry a FAILED run: re-queue the failed role task (and any pending/failed downstream
 * roles) as fresh pending copies, then send the run back to `running`. Unlike a gate
 * reject this starts from a `failed` task, so it must also SKIP that failed row —
 * otherwise `advance` sees it and fails the run again immediately. Human-initiated; the
 * note (if any) rides along as the task's queued_reason. Not for `needs_human`/publish.
 */
export async function retryFailedTask(sql: Sql, runId: string, note: string | null, by: string | null): Promise<void> {
  await sql.begin(async (tx) => {
    const failedRows = await tx`SELECT * FROM run_task WHERE run_id = ${runId} AND runtime <> 'publish'
      AND state = 'failed' ORDER BY seq LIMIT 1`;
    if (!failedRows.length) throw new GateError(`run ${runId} has no failed role task to retry`);
    const failed = failedRows[0];
    // Skip the failed task and every still-pending/failed downstream role, then re-append
    // fresh copies (attempt bumped) after the current max seq — same shape as requeueTask,
    // so the re-queued role isn't stuck behind lower-seq pending tasks the claim query skips.
    const downstream = await tx`SELECT * FROM run_task WHERE run_id = ${runId} AND runtime <> 'publish'
      AND seq >= ${Number(failed.seq)} AND state IN ('pending','done','failed') ORDER BY seq`;
    const [{ next }] = await tx`SELECT coalesce(max(seq),0)+1 AS next FROM run_task WHERE run_id = ${runId}`;
    let seq = Number(next);
    for (const t of downstream) {
      await tx`UPDATE run_task SET state = 'skipped', reason = 'superseded by retry' WHERE id = ${t.id}`;
      const reason = t.id === failed.id ? `retry: ${note ?? ''}`.trim() : null;
      const queuedReason = t.id === failed.id ? (note ?? null) : null;
      await tx`INSERT INTO run_task (id, run_id, role, seq, state, attempt, input_ref, output_ref, runtime, model, reason, queued_by, queued_reason)
        VALUES (${newId('task')}, ${runId}, ${t.role}, ${seq}, 'pending', ${Number(t.attempt) + 1}, ${t.inputRef}, ${t.outputRef}, ${t.runtime}, ${t.model}, ${reason}, 'retry', ${queuedReason})`;
      seq++;
    }
    // Back to running and clear the terminal finish stamp so it reads as live again.
    await tx`UPDATE agent_run SET state = 'running', reason = NULL, finished_at = NULL WHERE id = ${runId}`;
    await appendEventTx(tx, { runId, taskId: failed.id, kind: 'run:retried', source: 'human', payload: { role: failed.role, by, note } });
  });
  await advance(sql, runId);
}

/** Sweeper support: a required gate open past its timeout halts the run. */
export async function abandonExpiredGates(sql: Sql, now: Date, timeoutHoursDefault = 12): Promise<string[]> {
  const halted: string[] = [];
  const open = await sql`SELECT g.id, g.run_id, g.gate_name, g.created_at, r.gates FROM run_gate g JOIN agent_run r ON r.id = g.run_id WHERE g.state = 'open'`;
  for (const row of open) {
    const gates = row.gates as Record<string, { timeoutHours?: number }>;
    const hours = gates[String(row.gateName)]?.timeoutHours ?? timeoutHoursDefault;
    const deadline = new Date(new Date(row.createdAt as string).getTime() + hours * 3_600_000);
    if (now > deadline) {
      await sql.begin(async (tx) => {
        await tx`UPDATE run_gate SET state = 'abandoned', decided_at = now() WHERE id = ${row.id}`;
        await setRunState(tx, String(row.runId), 'halted', `gate ${row.gateName} not answered within ${hours}h`);
        await appendEventTx(tx, { runId: String(row.runId), taskId: null, kind: 'gate:abandoned', source: 'orchestrator', payload: { gate: row.gateName, hours } });
      });
      halted.push(String(row.runId));
    }
  }
  return halted;
}
