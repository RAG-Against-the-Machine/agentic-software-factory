import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { VertexCheckResult } from '@asf/shared/ui';
import type { SettingsStore } from './ui';
import { aiQ } from './questions';
import { initialVertexDraft, vertexDraftProblem, type VertexDraft } from './vertex';

const result = (over: Partial<VertexCheckResult> = {}): VertexCheckResult => ({
  ok: true, login: { ok: true },
  models: [{ id: 'claude-sonnet-5', tier: 'balanced', ok: true }],
  claudeCode: { ok: true, model: 'claude-sonnet-5' }, checkedAt: '2026-01-01T00:00:00.000Z', ...over,
});
const draft = (over: Partial<VertexDraft> = {}): VertexDraft => ({
  projectId: 'my-team-ai', region: 'global', selected: ['claude-sonnet-5'],
  checked: { projectId: 'my-team-ai', region: 'global', result: result() }, ...over,
});

test('vertexDraftProblem: empty or invalid project id', () => {
  assert.match(vertexDraftProblem(draft({ projectId: '  ' }), false)!, /Type your Google Cloud project id/);
  assert.match(vertexDraftProblem(draft({ projectId: 'My Project' }), false)!, /isn’t a project id/);
  assert.match(vertexDraftProblem(draft({ projectId: 'abc' }), true)!, /isn’t a project id/, 'savedOk does not excuse a bad id');
});

test('vertexDraftProblem: a bad region', () => {
  assert.match(vertexDraftProblem(draft({ region: 'mars' }), false)!, /region global/);
  assert.match(vertexDraftProblem(draft({ region: '' }), false)!, /region global/);
});

test('vertexDraftProblem: not checked and not saved asks for the check', () => {
  assert.match(vertexDraftProblem(draft({ checked: null }), false)!, /Check which Claude models work/);
  // a check done for a different project or region does not count
  assert.match(vertexDraftProblem(draft({ checked: { projectId: 'other-proj', region: 'global', result: result() } }), false)!, /Check which Claude models work/);
  assert.match(vertexDraftProblem(draft({ checked: { projectId: 'my-team-ai', region: 'us-east5', result: result() } }), false)!, /Check which Claude models work/);
});

test('vertexDraftProblem: a check whose Claude Code step failed blocks saving', () => {
  const failed = result({ ok: false, claudeCode: { ok: false, code: 'claude_code_failed', reason: 'boom' } });
  assert.match(vertexDraftProblem(draft({ checked: { projectId: 'my-team-ai', region: 'global', result: failed } }), false)!, /check didn’t pass/);
  assert.match(vertexDraftProblem(draft({ checked: { projectId: 'my-team-ai', region: 'global', result: failed } }), true)!, /check didn’t pass/, 'a fresh failing check blocks even when saved');
});

test('vertexDraftProblem: nothing selected, and the all-good case', () => {
  assert.match(vertexDraftProblem(draft({ selected: [] }), false)!, /Tick at least one model/);
  assert.equal(vertexDraftProblem(draft(), false), null);
  assert.equal(vertexDraftProblem(draft({ projectId: ' my-team-ai ', region: ' global ' }), false), null, 'surrounding spaces are ignored');
});

test('vertexDraftProblem: savedOk bypasses the check requirement (editing an already-working setup)', () => {
  assert.equal(vertexDraftProblem(draft({ checked: null }), true), null);
  assert.match(vertexDraftProblem(draft({ checked: null, selected: [] }), true)!, /Tick at least one model/);
});

test('initialVertexDraft reads project, region (default global) and the allowlist from settings', () => {
  const b = (v: Record<string, string>) => Object.fromEntries(Object.entries(v).map(([k, value]) => [k, { key: k, value }])) as never;
  assert.deepEqual(initialVertexDraft(b({ ANTHROPIC_VERTEX_PROJECT_ID: 'my-team-ai', CLOUD_ML_REGION: 'us-east5', MODEL_ALLOWLIST: 'claude-sonnet-5, claude-haiku-4-5@20251001' })),
    { projectId: 'my-team-ai', region: 'us-east5', selected: ['claude-sonnet-5', 'claude-haiku-4-5@20251001'], checked: null });
  assert.deepEqual(initialVertexDraft({}), { projectId: '', region: 'global', selected: [], checked: null });
});

const withSettings = (v: Record<string, string>, pinned = false): SettingsStore => ({
  byKey: Object.fromEntries(Object.entries(v).map(([k, value]) => [k, { key: k, value, ...(pinned && k === 'AGENT_AUTH_MODE' ? { envPinned: true } : {}) }])) as never,
  loaded: true, err: null, saveMany: async () => null, reload: () => {},
});

test('the AI question with AGENT_AUTH_MODE=vertex shows the project field and the check button', () => {
  const html = renderToStaticMarkup(<aiQ.Body store={withSettings({ AGENT_AUTH_MODE: 'vertex', ANTHROPIC_VERTEX_PROJECT_ID: 'my-team-ai', CLOUD_ML_REGION: 'global' })} actions={() => null} />);
  assert.match(html, /Google Cloud project id/);
  assert.match(html, /value="my-team-ai"/);
  assert.match(html, /Check which Claude models work/);
  assert.ok(!html.includes('set this up as'), 'not locked');
});

test('the AI question with AGENT_AUTH_MODE=bedrock is locked to the admin\'s setup', () => {
  const html = renderToStaticMarkup(<aiQ.Body store={withSettings({ AGENT_AUTH_MODE: 'bedrock' })} actions={() => null} />);
  assert.match(html, /Your admin set this up as <b>Claude on AWS Bedrock<\/b>/);
  assert.ok(!html.includes('Check which Claude models work'));
  assert.ok(!html.includes('Google Cloud project id'));
});

test('an env-pinned vertex setup is locked too: no editable project field', () => {
  const html = renderToStaticMarkup(<aiQ.Body store={withSettings({ AGENT_AUTH_MODE: 'vertex', ANTHROPIC_VERTEX_PROJECT_ID: 'my-team-ai' }, true)} actions={() => null} />);
  assert.match(html, /Your admin set this up as <b>Claude on Google Cloud \(Vertex AI\)<\/b>/);
  assert.ok(!html.includes('Check which Claude models work'));
});

test('the Settings list summary names the Vertex project and region, and flags a missing project', () => {
  const by = (v: Record<string, string>) => withSettings(v).byKey;
  const summary = renderToStaticMarkup(<>{aiQ.summary!(by({ AGENT_AUTH_MODE: 'vertex', ANTHROPIC_VERTEX_PROJECT_ID: 'my-team-ai', CLOUD_ML_REGION: 'us-east5' }))}</>);
  assert.match(summary, /project my-team-ai/);
  assert.match(summary, /us-east5/);
  assert.equal(aiQ.attention!(by({ AGENT_AUTH_MODE: 'vertex' })), true);
  assert.equal(aiQ.attention!(by({ AGENT_AUTH_MODE: 'vertex', ANTHROPIC_VERTEX_PROJECT_ID: 'my-team-ai' })), false);
});
