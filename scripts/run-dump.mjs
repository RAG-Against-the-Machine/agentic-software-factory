#!/usr/bin/env node
/**
 * Print the full story of a run as Markdown (M11 WP6) — a thin CLI over the api's
 * /api/runs/<id>/report.md. Replaces shelling into the worker container + psql +
 * reading JSON envelopes for a post-mortem.
 *
 *   node scripts/run-dump.mjs <runId>
 *   API_URL=https://host node scripts/run-dump.mjs <runId>
 */
const api = (process.env.API_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const runId = process.argv[2];
if (!runId) { console.error('usage: node scripts/run-dump.mjs <runId>'); process.exit(2); }

const res = await fetch(`${api}/api/runs/${encodeURIComponent(runId)}/report.md`);
if (!res.ok) { console.error(`report ${runId} -> ${res.status} ${res.statusText}`); process.exit(1); }
process.stdout.write(await res.text());
if (!process.stdout.writableEnded) process.stdout.write('\n');
