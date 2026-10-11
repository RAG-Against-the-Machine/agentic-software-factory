import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSpawn } from '@asf/shared';
import { buildCodexArgs, parseCodexStream } from './codex.js';
import { codexAuthArgs } from '../auth/index.js';
import { policyFor } from '../segment.js';

const jsonl = (...events: object[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const started = { type: 'thread.started', thread_id: '01a0ed6c-11ff-78a0-abac-721dc916fc16' };
const turnDone = (input: number, cached: number, output: number) => ({ type: 'turn.completed', usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } });
const message = (text: string) => ({ type: 'item.completed', item: { id: 'item_9', type: 'agent_message', text } });
const command = (command: string, exit_code: number, aggregated_output = '', status = exit_code === 0 ? 'completed' : 'failed') =>
  ({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command, aggregated_output, exit_code, status } });

const spawn = (over: Partial<AgentSpawn> = {}): AgentSpawn => ({
  role: 'implementer', prompt: 'do it', cwd: '/wt', maxCostUsd: 15, policy: policyFor(true),
  env: { ASF_RUN_DIR: '/runs/r1', ASF_TASK_ID: 't1' }, auth: { providerKind: 'openai', mode: 'chatgpt' }, timeoutMs: 1000, ...over,
});

test('success: usage summed over turns (cached split out), last agent_message is the text, tool events emitted', () => {
  const { outcome, events } = parseCodexStream(jsonl(
    started, { type: 'turn.started' },
    { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', status: 'in_progress' } },
    command('bash -lc ls', 0, 'README.md\n'),
    { type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }], status: 'completed' } },
    message('Working on it.'),
    turnDone(1000, 400, 200),
    { type: 'turn.started' }, message('Done. Committed the change.'), turnDone(500, 100, 50),
  ));
  assert.equal(outcome?.outcome, 'done');
  assert.equal(outcome?.text, 'Done. Committed the change.');
  assert.equal(outcome?.costUsd, null, 'codex reports tokens, not dollars');
  assert.deepEqual(outcome?.usage, { inputTokens: 1000, outputTokens: 250, cacheReadTokens: 500, cacheWriteTokens: 0 });
  assert.equal(outcome?.turns, 2);
  assert.deepEqual(events, [
    { kind: 'tool:post', payload: { tool: 'command_execution', summary: 'bash -lc ls', ok: true } },
    { kind: 'tool:post', payload: { tool: 'file_change', summary: 'update src/a.ts', ok: true } },
  ]);
});

test('turn.failed is a failed segment carrying the error message', () => {
  const { outcome } = parseCodexStream(jsonl(
    started, { type: 'turn.started' },
    { type: 'error', message: 'Reconnecting... 1/5 (unexpected status 401 Unauthorized)' },
    { type: 'error', message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' },
    { type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' } },
  ));
  assert.equal(outcome?.outcome, 'failed');
  assert.match(outcome!.text, /401 Unauthorized/);
  assert.equal(outcome?.terminalReason, 'turn.failed');
});

test('a transient error codex recovered from does not fail the segment; a trailing one does', () => {
  const recovered = parseCodexStream(jsonl(started, { type: 'error', message: 'Reconnecting... 1/5' }, message('ok'), turnDone(10, 0, 5)));
  assert.equal(recovered.outcome?.outcome, 'done');
  const fatal = parseCodexStream(jsonl(started, { type: 'error', message: 'stream disconnected before completion' }));
  assert.equal(fatal.outcome?.outcome, 'failed');
  assert.equal(fatal.outcome?.text, 'stream disconnected before completion');
});

test('NEEDS_HUMAN in the final agent_message -> needs_human with every question', () => {
  const { outcome } = parseCodexStream(jsonl(started, message('Read the repo.'), message('Looked around.\nNEEDS_HUMAN: which repo holds billing?\n2. which branch?'), turnDone(10, 0, 5)));
  assert.equal(outcome?.outcome, 'needs_human');
  assert.equal(outcome?.text, 'which repo holds billing?\n2. which branch?');
  const dispute = parseCodexStream(jsonl(started, message('DISPUTE: "rename foo" contradicts the plan'), turnDone(10, 0, 5)));
  assert.equal(dispute.outcome?.outcome, 'needs_human');
  assert.match(dispute.outcome!.text, /^DISPUTE: "rename foo"/);
});

test('sandbox denial is recorded as tool:denied only; the outcome is the agent\'s own', () => {
  const { outcome, events } = parseCodexStream(jsonl(
    started,
    command('bash -lc "touch /etc/x"', 1, 'touch: /etc/x: Operation not permitted\n'),
    { type: 'item.completed', item: { id: 'item_3', type: 'file_change', changes: [{ path: '/outside/y', kind: 'add' }], status: 'declined' } },
    command('bash -lc "npm test"', 1, '1 failing\n'),
    message('Could not write outside the worktree; finished inside it.'), turnDone(10, 0, 5),
  ));
  assert.equal(outcome?.outcome, 'done');
  assert.deepEqual(events.map((e) => e.kind), ['tool:denied', 'tool:denied', 'tool:post']);
  assert.match(String(events[0].payload.reason), /Operation not permitted/);
  assert.equal(events[2].payload.ok, false, 'an ordinary failing command is a tool:post, not a denial');
});

test('usage: cache writes (codex 0.158+) are split out of input so they price at the cache-write rate', () => {
  const { outcome } = parseCodexStream(jsonl(
    message('ok'),
    { type: 'turn.completed', usage: { input_tokens: 14857, cached_input_tokens: 1792, cache_write_input_tokens: 3000, output_tokens: 5 } },
  ));
  assert.deepEqual(outcome?.usage, { inputTokens: 10065, outputTokens: 5, cacheReadTokens: 1792, cacheWriteTokens: 3000 });
});

test('no events at all is no result (the caller reports stderr)', () => {
  assert.equal(parseCodexStream('WARNING: something\n').outcome, null);
});

test('argv: openai — sandbox, run dir, ephemeral, -o, effort mapped, extra args, prompt on stdin', () => {
  const s = spawn({ model: 'gpt-5.5', effort: 'max' });
  const args = buildCodexArgs(s, '/runs/r1/last.md', codexAuthArgs(s.auth), ['--color', 'never']);
  assert.deepEqual(args, [
    '-a', 'never', 'exec', '--json', '-m', 'gpt-5.5', '-s', 'workspace-write', '-C', '/wt', '--skip-git-repo-check',
    '--add-dir', '/runs/r1', '--ephemeral', '-o', '/runs/r1/last.md', '-c', 'model_reasoning_effort=high',
    '--color', 'never', '-',
  ]);
  assert.ok(!args.includes('do it'), 'the prompt never goes on argv');
});

test('argv: sandbox off (a container worker) = no nested sandbox, no approval prompt, no --add-dir', () => {
  const s = spawn({ model: 'gpt-5.5' });
  const args = buildCodexArgs(s, '/runs/r1/last.md', codexAuthArgs(s.auth), [], 'off');
  assert.deepEqual(args, [
    'exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-5.5', '-C', '/wt', '--skip-git-repo-check',
    '--ephemeral', '-o', '/runs/r1/last.md', '-',
  ]);
  assert.ok(!args.includes('-s') && !args.includes('-a'), 'the bypass flag replaces both; codex rejects combining them');
});

test('argv: a read-only role still gets the writable sandbox (the post-run audit holds it read-only)', () => {
  const args = buildCodexArgs(spawn({ role: 'reviewer', policy: policyFor(false) }), '/runs/r1/last.md', [], []);
  assert.deepEqual(args.slice(args.indexOf('-s'), args.indexOf('-s') + 2), ['-s', 'workspace-write']);
});

test('argv: openai-compatible points codex at a generated asf provider', () => {
  const s = spawn({ model: 'deepseek-chat', effort: 'low', auth: { providerKind: 'openai-compatible', mode: 'api-key', credential: 'x', baseUrl: 'https://api.deepseek.com/v1' } });
  const args = buildCodexArgs(s, '/runs/r1/last.md', codexAuthArgs(s.auth), []);
  const overrides = args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []));
  assert.deepEqual(overrides.slice(0, 2), ['model_reasoning_effort=low', 'model_providers.asf.name=asf']);
  assert.ok(overrides.includes('model_providers.asf.base_url=https://api.deepseek.com/v1'));
  assert.ok(overrides.includes('model_providers.asf.wire_api=responses'));
  assert.ok(overrides.includes('model_provider=asf'));
  assert.ok(overrides.some((o) => o.startsWith('model_providers.asf.env_key=')), 'api-key mode names the env var applyAuth set');
  assert.equal(args.at(-1), '-');
  const keyless = codexAuthArgs({ providerKind: 'openai-compatible', mode: 'none', baseUrl: 'http://llm:8080/v1' });
  assert.ok(!keyless.some((o) => o.includes('env_key')), 'a keyless server gets no env_key');
});
