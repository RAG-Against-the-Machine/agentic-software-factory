#!/usr/bin/env node
/**
 * M2 done-when: a live worker claims a real role task, spawns the runtime in an
 * isolated worktree of the mock repo, the hooks report telemetry, and the
 * outcome lands in the registry.
 *
 * Prereqs: registry on :8788, api on :8787, a worker running, all sharing
 * RUN_EVENT_SECRET, and MOCK_REPO_PATH pointing at a real bare/normal git repo.
 * Creates a single-role (planner) run so it finishes fast.
 *
 *   RUN_EVENT_SECRET=... node scripts/m2-smoke.mjs
 */
const registry = (process.env.REGISTRY_URL ?? 'http://127.0.0.1:8788').replace(/\/+$/, '');
const secret = process.env.RUN_EVENT_SECRET;
if (!secret) { console.error('RUN_EVENT_SECRET required'); process.exit(2); }
const H = { 'content-type': 'application/json', 'x-run-secret': secret };
const rpc = async (body) => { const r = await fetch(`${registry}/internal/rpc`, { method: 'POST', headers: H, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok || !j.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`); return j.result; };

const ticket = process.env.MOCK_TICKET_ID ?? 'asf-1';
const { run } = await rpc({ op: 'createRun', input: {
  ticketId: ticket, ticketKey: ticket.toUpperCase(), ticketProvider: 'mock', maxCostUsd: 2, dispatchedBy: 'm2-smoke',
  repoId: '1',
  team: { name: 'plan-only', roles: [{ role: 'planner', output: 'plan.md' }] },
  gates: { after_plan: { mode: 'auto' } } } });
console.log(`created ${run.id} for ${run.ticketKey}, repo ${run.repoId}; waiting for a worker to run it...`);

const deadline = Date.now() + 5 * 60_000;
for (;;) {
  const got = await rpc({ op: 'getRun', id: run.id });
  const evs = await rpc({ op: 'getEvents', runId: run.id, afterSeq: 0, limit: 100 });
  process.stdout.write(`\r  state=${got.run.state} events=${evs.events.map((e) => e.kind).join(',')}          `);
  if (['succeeded', 'failed', 'cancelled', 'halted'].includes(got.run.state)) {
    console.log(`\nfinal: ${got.run.state}  cost $${got.run.costUsd}`);
    const kinds = evs.events.map((e) => e.kind);
    const sawHookOrSegment = kinds.some((k) => k === 'tool:pre' || k === 'segment:started');
    console.log('hook/segment telemetry present:', sawHookOrSegment);
    // M2 succeeds if the loop ran the segment; the agent itself may fail on auth.
    process.exit(sawHookOrSegment ? 0 : 1);
  }
  if (Date.now() > deadline) { console.log('\ntimed out'); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1000));
}
