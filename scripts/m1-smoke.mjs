#!/usr/bin/env node
/**
 * M1 smoke: against a running registry, create a run over RPC, act as a fake
 * worker (register -> claim -> finish for every task), and print the events
 * the SSE stream delivered. Exit 0 only if the run ends `succeeded`.
 *
 *   RUN_EVENT_SECRET=... node scripts/m1-smoke.mjs [http://127.0.0.1:8788]
 */
const base = process.argv[2] ?? process.env.REGISTRY_URL ?? 'http://127.0.0.1:8788';
const secret = process.env.RUN_EVENT_SECRET;
if (!secret) { console.error('RUN_EVENT_SECRET is required (the registry logs the generated one at boot)'); process.exit(2); }
const H = { 'content-type': 'application/json', 'x-run-secret': secret };
const rpc = async (body) => { const r = await fetch(`${base}/internal/rpc`, { method: 'POST', headers: H, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`); return j.result; };
const post = async (path, body) => { const r = await fetch(`${base}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body ?? {}) }); const j = await r.json(); if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`); return j; };

const seen = [];
const sse = await fetch(`${base}/internal/events/runs`, { headers: { 'x-run-secret': secret } });
const reader = sse.body.getReader();
(async () => { let buf = ''; for (;;) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value);
  let i; while ((i = buf.indexOf('\n\n')) >= 0) { const frame = buf.slice(0, i); buf = buf.slice(i + 2); const m = /^data: (.*)$/m.exec(frame); if (m && frame.startsWith('event: run:event')) seen.push(JSON.parse(m[1])); } } })().catch(() => {});

const ticket = `smoke-${Date.now().toString(36)}`;
const { run } = await rpc({ op: 'createRun', input: { ticketId: ticket, ticketKey: ticket.toUpperCase(), ticketProvider: 'mock', maxCostUsd: 5, dispatchedBy: 'smoke',
  team: { name: 'standard', roles: [{ role: 'planner', output: 'plan.md' }, { role: 'implementer', writes: true }, { role: 'tester', writes: true }, { role: 'reviewer' }] },
  gates: { after_plan: { mode: 'required' }, before_change_request: { mode: 'required' }, before_merge: { mode: 'required' } } } });
console.log(`run ${run.id} queued for ${run.ticketKey}`);

const wid = `smoke-worker-${process.pid}`;
await post('/workers/register', { id: wid, host: 'smoke', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
// Older queued runs in a shared dev database are claimed first; finish them too, then ours.
for (let guard = 0; guard < 200; guard++) {
  const { claim } = await post(`/workers/${wid}/claim`, { runtimes: ['claude-code'] });
  if (!claim) break;
  const mine = claim.run.id === run.id;
  console.log(`  claimed ${claim.task.role} (seq ${claim.task.seq})${mine ? '' : ` [other run ${claim.run.id}]`}`);
  await post(`/tasks/${claim.task.id}/finish`, { outcome: 'done', outputRef: claim.task.outputRef, costUsd: 0.01 });
}
await post(`/workers/${wid}/deregister`);
await new Promise((r) => setTimeout(r, 300));
reader.cancel().catch(() => {});

const final = await rpc({ op: 'getRun', id: run.id });
const kinds = seen.filter((e) => e.runId === run.id).map((e) => `${e.seq}:${e.kind}`);
console.log('events over SSE:', kinds.join(' '));
console.log(`final state: ${final.run.state}  cost: $${final.run.costUsd}`);
process.exit(final.run.state === 'succeeded' && kinds.some((k) => k.endsWith('run:succeeded')) ? 0 : 1);
