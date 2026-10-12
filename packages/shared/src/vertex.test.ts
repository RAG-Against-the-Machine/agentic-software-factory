import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VERTEX_CANDIDATES, isGcpProjectId, isVertexRegion, vertexTier, vertexWireId, vertexModelUrl,
  vertexCheckModel, vertexCatalogueExtra, vertexWrites,
} from './vertex.js';

test('isGcpProjectId: lowercase id of 6–30 chars; display names, uppercase, spaces, short ids are not ids', () => {
  for (const ok of ['my-team-ai', 'abcdef', 'a12345', 'project-123456', 'a' + 'b'.repeat(28) + 'c']) assert.equal(isGcpProjectId(ok), true, ok);
  for (const bad of ['My Project', 'my project', 'MyProject', 'my-team-AI', 'abcde', '1my-project', '-my-project', 'my-project-', 'my_project', '', 'a' + 'b'.repeat(29) + 'c', '123456789012']) {
    assert.equal(isGcpProjectId(bad), false, JSON.stringify(bad));
  }
});

test('isVertexRegion: global or a geo-region like us-east5', () => {
  for (const ok of ['global', 'us-east5', 'europe-west1', 'asia-southeast1']) assert.equal(isVertexRegion(ok), true, ok);
  for (const bad of ['', 'Global', 'us', 'us-east', 'us east5', 'east5', 'us-east5-a', 'https://x']) assert.equal(isVertexRegion(bad), false, bad);
});

test('vertexTier: by family name, balanced when unknown', () => {
  assert.equal(vertexTier('claude-opus-4-8'), 'max');
  assert.equal(vertexTier('claude-fable-5-1'), 'max');
  assert.equal(vertexTier('claude-haiku-4-5@20251001'), 'fast');
  assert.equal(vertexTier('claude-sonnet-5'), 'balanced');
  assert.equal(vertexTier('something-else'), 'balanced');
  assert.equal(vertexTier('CLAUDE-OPUS-5'), 'max');
});

test('vertexWireId strips the client-side [1m] suffix only at the end', () => {
  assert.equal(vertexWireId('claude-sonnet-4-6[1m]'), 'claude-sonnet-4-6');
  assert.equal(vertexWireId('claude-sonnet-4-6[1M]'), 'claude-sonnet-4-6');
  assert.equal(vertexWireId('claude-haiku-4-5@20251001'), 'claude-haiku-4-5@20251001');
  assert.equal(vertexWireId('claude-sonnet-5'), 'claude-sonnet-5');
});

test('vertexModelUrl: global host vs regional host, location path, [1m] stripped, @ version kept', () => {
  assert.equal(
    vertexModelUrl('my-proj', 'global', 'claude-sonnet-5'),
    'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/publishers/anthropic/models/claude-sonnet-5:rawPredict',
  );
  assert.equal(
    vertexModelUrl('my-proj', 'us-east5', 'claude-sonnet-5'),
    'https://us-east5-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-east5/publishers/anthropic/models/claude-sonnet-5:rawPredict',
  );
  assert.ok(vertexModelUrl('p', 'global', 'claude-sonnet-4-6[1m]').endsWith('/models/claude-sonnet-4-6:rawPredict'));
  // The @ of a dated Vertex id stays literal (as Google's own clients send it; valid in a path).
  const u = vertexModelUrl('p', 'us-east5', 'claude-haiku-4-5@20251001');
  assert.ok(u.endsWith('/models/claude-haiku-4-5@20251001:rawPredict'), u);
  assert.equal(decodeURIComponent(new URL(u).pathname).split('/models/')[1], 'claude-haiku-4-5@20251001:rawPredict');
});

test('vertexCheckModel: first working balanced model, else the first working one, else null', () => {
  const m = (id: string, tier: 'fast' | 'balanced' | 'max', ok: boolean) => ({ id, tier, ok });
  assert.equal(vertexCheckModel([m('o', 'max', true), m('s1', 'balanced', false), m('s2', 'balanced', true), m('s3', 'balanced', true)]), 's2');
  assert.equal(vertexCheckModel([m('o', 'max', false), m('h', 'fast', true), m('o2', 'max', true)]), 'h');
  assert.equal(vertexCheckModel([m('o', 'max', false), m('s', 'balanced', false)]), null);
  assert.equal(vertexCheckModel([]), null);
});

test('VERTEX_CANDIDATES: ids are unique and each tier is represented', () => {
  const ids = VERTEX_CANDIDATES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const t of ['fast', 'balanced', 'max']) assert.ok(VERTEX_CANDIDATES.some((c) => c.tier === t), t);
  for (const c of VERTEX_CANDIDATES) assert.equal(vertexTier(c.id), c.tier, `${c.id} tier matches its name`);
});

test('vertexCatalogueExtra: keeps existing entries and providers, skips built-ins, adds Vertex-only ids once', () => {
  const existing = {
    providers: [{ id: 'deepseek', kind: 'openai-compatible' }],
    models: [{ id: 'my-model', label: 'Mine', tier: 'fast' }, { id: 'claude-haiku-4-5@20251001', label: 'Operator label', tier: 'fast' }],
  };
  const out = vertexCatalogueExtra(['claude-sonnet-5', 'claude-haiku-4-5@20251001', 'claude-sonnet-4-6[1m]', 'claude-sonnet-4-6[1m]'], existing);
  assert.deepEqual(out.providers, existing.providers);
  const ids = out.models.map((m) => m.id);
  assert.deepEqual(ids, ['my-model', 'claude-haiku-4-5@20251001', 'claude-sonnet-4-6[1m]']);
  assert.equal(out.models[1]!.label, 'Operator label', 'an id already present is left as the operator defined it');
  assert.ok(!ids.includes('claude-sonnet-5'), 'built-in ids are not duplicated');
  assert.deepEqual(existing.models.length, 2, 'input is not mutated');
});

test('vertexCatalogueExtra: a new Vertex id gets tier, anthropic provider and the claude-code runtime', () => {
  const out = vertexCatalogueExtra(['claude-haiku-4-5@20251001'], undefined);
  assert.deepEqual(out.models, [{
    id: 'claude-haiku-4-5@20251001', label: 'claude-haiku-4-5@20251001 (Vertex AI)', tier: 'fast', providerId: 'anthropic', runtimes: ['claude-code'],
  }]);
  assert.ok(!('providers' in out), 'no providers key when none existed');
});

test('vertexCatalogueExtra: garbage existing values are ignored', () => {
  for (const garbage of [null, 'nope', 42, [], { models: 'x' }, { models: [null, 3, { nope: 1 }, { id: 7 }] }]) {
    const out = vertexCatalogueExtra(['claude-haiku-4-5@20251001'], garbage);
    assert.deepEqual(out.models.map((m) => m.id), ['claude-haiku-4-5@20251001'], JSON.stringify(garbage));
  }
  // valid entries survive next to garbage ones
  const mixed = vertexCatalogueExtra([], { models: [null, { id: 'keep' }, { id: 7 }] });
  assert.deepEqual(mixed.models, [{ id: 'keep' }]);
});

test('vertexWrites: auth mode, project, region, allowlist and catalogue in order', () => {
  const w = vertexWrites({ projectId: ' my-proj ', region: ' us-east5 ', selected: ['claude-sonnet-5', 'claude-haiku-4-5@20251001'], existingExtra: undefined });
  assert.deepEqual(w.map(([k]) => k), ['ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION', 'MODEL_CATALOG_EXTRA', 'MODEL_ALLOWLIST', 'AGENT_AUTH_MODE']);
  const get = (k: string) => w.find(([key]) => key === k)![1];
  assert.equal(get('ANTHROPIC_VERTEX_PROJECT_ID'), 'my-proj');
  assert.equal(get('CLOUD_ML_REGION'), 'us-east5');
  assert.equal(get('MODEL_ALLOWLIST'), 'claude-sonnet-5, claude-haiku-4-5@20251001');
  assert.equal(get('AGENT_AUTH_MODE'), 'vertex');
  assert.deepEqual((get('MODEL_CATALOG_EXTRA') as { models: Array<{ id: string }> }).models.map((m) => m.id), ['claude-haiku-4-5@20251001']);
});

test('vertexWrites: a blank region means global', () => {
  const w = vertexWrites({ projectId: 'my-proj', region: '   ', selected: ['claude-sonnet-5'], existingExtra: null });
  assert.equal(w.find(([k]) => k === 'CLOUD_ML_REGION')![1], 'global');
});
