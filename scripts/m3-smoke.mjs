#!/usr/bin/env node
/**
 * M3 done-when: exercise the web API surface exactly as the browser does —
 * dispatch a ticket, watch the run park at the required after_plan gate,
 * approve it, and see the run resume. A fake worker (registry-side, no real
 * Claude) drives the role tasks so the flow is deterministic.
 *
 *   RUN_EVENT_SECRET=... node scripts/m3-smoke.mjs
 * Requires the api (:8787) and registry (:8788) running with mock providers.
 */
const api = (process.env.API_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const registry = (process.env.REGISTRY_URL ?? 'http://127.0.0.1:8788').replace(/\/+$/, '');
const secret = process.env.RUN_EVENT_SECRET;
if (!secret) { console.error('RUN_EVENT_SECRET required'); process.exit(2); }
const RH = { 'content-type': 'application/json', 'x-run-secret': secret };
const jf = async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`); return j; };
const rpc = async (b) => (await jf(await fetch(`${registry}/internal/rpc`, { method: 'POST', headers: RH, body: JSON.stringify(b) }))).result;

// 1. Browser: list tickets, dispatch the first one. This flow exercises exactly
// two human checkpoints — after_plan and before_merge — so every OTHER gate must
// be auto. The default pipeline (empty PIPELINE_STAGES) makes every stage gate
// `required`, INCLUDING the inter-role after_role:* gates; dispatch would then
// park at after_role:implementer and the tester would never be claimable. So the
// override must relax the inter-role gates too, not just before_change_request.
// 0. A fresh install has no repository, so nothing can start: prove the refusal, then
// connect one the way the Settings page does. The fake worker below never clones, so
// the mock repository's path only has to be set, not real.
const ready0 = await jf(await fetch(`${api}/api/start-readiness`));
if (ready0.ok) { console.error('a fresh install should not be able to start work with no repository', ready0); process.exit(1); }
console.log(`no repository yet: ${ready0.code} (start refused, as it should be)`);
await jf(await fetch(`${api}/api/settings/MOCK_REPO_PATH`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: '/tmp/m3-practice.git' }) }));
const ready1 = await jf(await fetch(`${api}/api/start-readiness`));
if (!ready1.ok) { console.error('still blocked after connecting a repository', ready1); process.exit(1); }

const { tickets } = await jf(await fetch(`${api}/api/tickets`));
const ticket = tickets[0];
console.log(`dispatching ${ticket.key}: ${ticket.title}`);
const disp = await fetch(`${api}/api/tickets/${ticket.id}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ repoId: '1', maxCostUsd: 5, by: 'operator', gateOverrides: {
    after_plan: { mode: 'required' },
    'after_role:implementer': { mode: 'auto' },
    'after_role:tester': { mode: 'auto' },
    'after_role:reviewer': { mode: 'auto' },
    before_change_request: { mode: 'auto' },
    before_merge: { mode: 'required' },
  } }) });
if (disp.status !== 201) { console.error('dispatch failed', await disp.text()); process.exit(1); }
const { run } = await disp.json();
console.log(`run ${run.id} created`);

// A fake worker to run the role/publish tasks (no real agent).
const wid = `m3-worker-${process.pid}`;
await jf(await fetch(`${registry}/workers/register`, { method: 'POST', headers: RH, body: JSON.stringify({ id: wid, host: 'm3', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] }) }));
async function claim() { const j = await jf(await fetch(`${registry}/workers/${wid}/claim`, { method: 'POST', headers: RH, body: JSON.stringify({ runtimes: ['claude-code'] }) })); return j.claim; }
async function finish(taskId, outputRef, artifact) {
  if (artifact) await rpc({ op: 'saveArtifact', runId: run.id, name: outputRef, content: artifact });
  await jf(await fetch(`${registry}/tasks/${taskId}/finish`, { method: 'POST', headers: RH, body: JSON.stringify({ outcome: 'done', outputRef, costUsd: 0.02 }) }));
}

// 2. Run the planner, expect the run to park at after_plan.
const planner = await claim();
if (planner?.task.role !== 'planner') throw new Error(`expected planner, got ${planner?.task.role}`);
await finish(planner.task.id, 'plan.md', '# Plan\n\nDo the thing carefully.');
let detail = await jf(await fetch(`${api}/api/runs/${run.id}`));
console.log(`after planner: state=${detail.run.state}  openGate=${detail.gates.find((g) => g.state === 'open')?.gateName}`);
if (detail.run.state !== 'awaiting_checkpoint') throw new Error('expected the run to PARK at the plan gate');
const gate = detail.gates.find((g) => g.state === 'open');
if (gate.artifact !== '# Plan\n\nDo the thing carefully.') throw new Error('gate should carry the plan for review');

// Nothing claimable while parked.
if (await claim()) throw new Error('a task was claimable while parked at a required gate');

// 3. Browser: approve the gate (editing the plan).
await jf(await fetch(`${api}/api/gates/${gate.id}`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ decision: 'approve', by: 'operator', editedArtifact: '# Plan (edited)\n\nDo it, and add tests.' }) }));
detail = await jf(await fetch(`${api}/api/runs/${run.id}`));
console.log(`after approve: state=${detail.run.state}  plan now: ${JSON.stringify(detail.artifacts.find((a) => a.name === 'plan.md')?.content.slice(0, 24))}`);
if (detail.run.state !== 'running') throw new Error('approval should resume the run');

// 4. Drive the rest: implementer, tester, reviewer (APPROVE), then publish through before_merge gate.
for (const expect of ['implementer', 'tester', 'reviewer']) {
  const c = await claim();
  if (!c || c.task.role !== expect) throw new Error(`expected ${expect}, got ${c?.task.role}`);
  await finish(c.task.id, c.task.outputRef, c.task.role === 'reviewer' ? 'APPROVE\nlgtm' : (c.task.outputRef ? 'ok' : undefined));
}
// push_open (auto before_change_request), then park at before_merge.
const pushOpen = await claim();
if (pushOpen?.task.role !== 'publish:push_open') throw new Error(`expected publish:push_open, got ${pushOpen?.task.role}`);
await jf(await fetch(`${registry}/tasks/${pushOpen.task.id}/finish`, { method: 'POST', headers: RH, body: JSON.stringify({ outcome: 'done', costUsd: 0 }) }));
detail = await jf(await fetch(`${api}/api/runs/${run.id}`));
const mergeGate = detail.gates.find((g) => g.state === 'open' && g.gateName === 'before_merge');
console.log(`after push_open: state=${detail.run.state}  before_merge gate open=${Boolean(mergeGate)}`);
if (!mergeGate) throw new Error('expected the run to park at before_merge');

// 5. Approve the merge gate; the merge task runs; the run succeeds.
await jf(await fetch(`${api}/api/gates/${mergeGate.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve', by: 'operator' }) }));
const mergeTask = await claim();
if (mergeTask?.task.role !== 'publish:merge') throw new Error(`expected publish:merge, got ${mergeTask?.task.role}`);
await jf(await fetch(`${registry}/tasks/${mergeTask.task.id}/finish`, { method: 'POST', headers: RH, body: JSON.stringify({ outcome: 'done', costUsd: 0 }) }));

detail = await jf(await fetch(`${api}/api/runs/${run.id}`));
await fetch(`${registry}/workers/${wid}/deregister`, { method: 'POST', headers: RH, body: '{}' });
console.log(`\nFINAL: state=${detail.run.state}  gates=${detail.gates.map((g) => `${g.gateName}:${g.state}`).join(', ')}`);
process.exit(detail.run.state === 'succeeded' ? 0 : 1);
