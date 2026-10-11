import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReportMarkdown, runReportSummary, type RunReportInput } from './report.js';
import { STANDARD_TEAM, DEFAULT_GATES } from './team.js';
import type { Run, RunTask, RunEvent } from './run.js';

const run: Run = {
  id: 'run_1', ticketId: 't-1', ticketKey: 'ASF-9', ticketProvider: 'mock', state: 'failed',
  teamName: 'standard', team: STANDARD_TEAM, gates: DEFAULT_GATES, repoId: 'r1',
  worktreePath: null, branchName: null, changeRequestUrl: null, changeRequestNumber: null,
  changeRequestState: null, deliveryOutcome: null, costUsd: 4.99, maxCostUsd: 15,
  reviewIterations: 2, dispatchedBy: 'jon', createdAt: '2026-09-20T23:00:00Z', startedAt: null,
  lastEventAt: null, cancelRequestedAt: null, finishedAt: null,
} as unknown as Run;

const task = (over: Partial<RunTask>): RunTask => ({
  id: 't', runId: 'run_1', role: 'planner', seq: 0, state: 'done', attempt: 1, inputRef: null,
  outputRef: null, workerId: 'w', runtime: 'claude-code', model: 'claude-sonnet-5', costUsd: 0.5,
  gateChecked: true, startedAt: null, finishedAt: null, reason: null, queuedBy: 'plan', queuedReason: null, ...over,
} as RunTask);

const ev = (kind: string, taskId: string | null, payload: Record<string, unknown>): RunEvent =>
  ({ id: 1, runId: 'run_1', taskId, seq: 1, kind, source: 'orchestrator', payload, at: '2026-09-20T23:01:00Z' } as unknown as RunEvent);

test('runReportSummary names the loop/cost story for a failed run', () => {
  const input: RunReportInput = {
    run, tasks: [task({ id: 'p', role: 'planner' }), task({ id: 'i', role: 'implementer', state: 'failed', reason: 'hit the 40-turn ceiling' })],
    events: [ev('review:loop', null, { iteration: 1 }), ev('review:loop', null, { iteration: 2 })],
    artifacts: [],
  };
  const s = runReportSummary(input);
  assert.match(s, /ASF-9: failed/);
  assert.match(s, /2 review cycles/);
  assert.match(s, /implementer failed: hit the 40-turn ceiling/);
  assert.match(s, /\$4\.99 of \$15\.00/);
});

test('runReportMarkdown includes timeline, verdict, and a cost table with % of cap', () => {
  const input: RunReportInput = {
    run: { ...run, state: 'succeeded' } as Run,
    tasks: [
      task({ id: 'p', role: 'planner', costUsd: 0.6 }),
      task({ id: 'i', role: 'implementer', costUsd: 1.6, outputRef: null }),
      task({ id: 'r', role: 'reviewer', costUsd: 0.2 }),
    ],
    events: [
      ev('segment:result', 'i', { turns: 12, text: 'Implemented the endpoint.' }),
      ev('segment:diff', 'i', { filesChanged: 3, insertions: 40, deletions: 5, commit: 'abcdef12' }),
    ],
    artifacts: [{ name: 'review.md', taskId: 'r', attempt: 1, source: 'agent', content: 'APPROVE\nlgtm' }],
  };
  const md = runReportMarkdown(input);
  assert.match(md, /# Run report — ASF-9/);
  assert.match(md, /## Timeline/);
  assert.match(md, /changed: 3 files \(\+40 −5\)/);
  assert.match(md, /verdict: \*\*APPROVE\*\*/);
  assert.match(md, /## Cost/);
  assert.match(md, /\*\*total\*\*.*16% of cap/); // (0.6+1.6+0.2)=2.4 / 15
});

test('tolerates a pre-M11 run with no provenance/result/diff events', () => {
  const input: RunReportInput = { run, tasks: [task({ id: 'p' })], events: [], artifacts: [] };
  const md = runReportMarkdown(input);
  assert.match(md, /# Run report/);
  assert.match(md, /## Cost/);   // still renders
});
