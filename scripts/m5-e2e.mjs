#!/usr/bin/env node
/**
 * WP5.3 live E2E driver — the M4 acceptance loop, but the ticket comes from Jira
 * (TICKET_PROVIDER=jira) while the code lands on GitHub (SCM_PROVIDER=github).
 * A Jira ticket has no natural repo (suggestedRepo → null), so repoId is passed
 * explicitly at dispatch. Drives the two human gates (after_plan required →
 * approve; before_merge required → approve) and lets the REAL worker/agent run
 * every role in between. Prints a timeline and the final PR link.
 */
const api = 'http://127.0.0.1:8787';
const TICKET = process.env.E2E_TICKET || 'KAN-1';           // Jira issue key
const REPO = process.env.E2E_REPO || 'acme/asf-e2e-scratch';
const jf = async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`); return j; };
const enc = encodeURIComponent(TICKET);
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

// 1. Dispatch the Jira ticket with the standard team; after_plan + before_merge required,
//    before_change_request auto. repoId is explicit — Jira suggests no repo.
const disp = await fetch(`${api}/api/tickets/${enc}/dispatch`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ repoId: REPO, maxCostUsd: 5, by: 'jon',
    gateOverrides: { after_plan: { mode: 'required' }, before_change_request: { mode: 'auto' }, before_merge: { mode: 'required' } } }),
});
if (disp.status !== 201) { console.error('dispatch failed', disp.status, await disp.text()); process.exit(1); }
const { run } = await disp.json();
console.log(`[${el()}] dispatched Jira ${TICKET} → run ${run.id} (repo ${REPO})`);

const detail = async () => jf(await fetch(`${api}/api/runs/${run.id}`));
const openGate = (d) => d.gates.find((g) => g.state === 'open');
const seen = new Set();
let approvedPlan = false, approvedMerge = false, prUrl = null;

// 2. Poll the run; approve gates as they open; report task transitions.
for (let i = 0; i < 600; i++) { // up to ~20 min
  const d = await detail();
  for (const t of d.tasks ?? []) {
    const tag = `${t.role}:${t.state}`;
    if (!seen.has(tag)) { seen.add(tag); console.log(`[${el()}] task ${tag}${t.costUsd ? ` ($${t.costUsd})` : ''}`); }
  }
  for (const ev of d.events ?? []) {
    if (ev.kind === 'change_request:opened' && ev.payload?.url && !prUrl) { prUrl = ev.payload.url; console.log(`[${el()}] PR opened: ${prUrl}`); }
  }
  const g = openGate(d);
  if (g && g.gateName === 'after_plan' && !approvedPlan) {
    console.log(`[${el()}] after_plan gate open — plan:\n---\n${(g.artifact || '').slice(0, 800)}\n---`);
    await jf(await fetch(`${api}/api/gates/${g.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve', by: 'jon' }) }));
    approvedPlan = true; console.log(`[${el()}] approved after_plan`);
  } else if (g && g.gateName === 'before_merge' && !approvedMerge) {
    console.log(`[${el()}] before_merge gate open — approving merge`);
    await jf(await fetch(`${api}/api/gates/${g.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve', by: 'jon' }) }));
    approvedMerge = true; console.log(`[${el()}] approved before_merge`);
  }
  if (['succeeded', 'failed', 'halted', 'cancelled'].includes(d.run.state)) {
    console.log(`\n[${el()}] FINAL state=${d.run.state} cost=$${(d.run.costUsd ?? 0).toFixed(4)}`);
    console.log(`gates: ${d.gates.map((x) => `${x.gateName}:${x.state}`).join(', ')}`);
    if (prUrl) console.log(`PR: ${prUrl}`);
    process.exit(d.run.state === 'succeeded' ? 0 : 1);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.error(`[${el()}] timed out waiting for the run to settle`);
process.exit(2);
