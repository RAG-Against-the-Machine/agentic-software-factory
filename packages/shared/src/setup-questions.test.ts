import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS } from './settings.js';
import { resolvePipeline } from './pipeline.js';
import {
  QUESTIONS, UI_ENV_ONLY, questionFor, detectApprovalPreset, applyApprovalPreset, setFactoryMerges, effectiveStages,
  detectBudgetPreset, APPROVAL_PRESETS, detectTeamAi, teamAiWrites, TEAM_AI_MODELS,
} from './setup-questions.js';
import { MODELS } from './models.js';

const orgSettable = Object.entries(SETTINGS).filter(([, d]) => (d.tiers as readonly string[]).includes('org')).map(([k]) => k);

test('every org-settable key is either asked by exactly one question or explicitly env-only in the UI', () => {
  for (const key of orgSettable) {
    const asked = QUESTIONS.filter((q) => q.keys.includes(key)).length;
    const envOnly = key in UI_ENV_ONLY;
    assert.ok(asked + (envOnly ? 1 : 0) === 1, `${key}: asked by ${asked} question(s), envOnly=${envOnly} — add it to exactly one of QUESTIONS / UI_ENV_ONLY`);
  }
});

test('questions and the env-only list only name real org-settable keys (the UI cannot write an env-only key)', () => {
  for (const q of QUESTIONS) for (const k of q.keys) assert.ok(orgSettable.includes(k), `${q.id}: ${k} is not org-settable`);
  for (const k of Object.keys(UI_ENV_ONLY)) assert.ok(orgSettable.includes(k), `UI_ENV_ONLY: ${k} is not org-settable`);
  assert.equal(questionFor('ORG_MAX_COST_USD')?.id, 'spending');
});

test('an empty PIPELINE_STAGES (fresh install) reads as "start and end": talk the plan through, then the team just goes', () => {
  assert.equal(detectApprovalPreset({}), 'start-and-end');
  assert.equal(detectApprovalPreset(null), 'start-and-end');
  const eff = effectiveStages({});
  assert.deepEqual(Object.fromEntries(Object.entries(eff).map(([k, v]) => [k, v.gate])),
    { plan: 'required', implement: 'auto', test: 'auto', review: 'auto', create_mr: 'notify', merge: 'required' });
});

test('each preset round-trips through apply -> detect and is accepted by resolvePipeline', () => {
  const team = { name: 't', roles: [{ role: 'planner' }, { role: 'implementer' }, { role: 'tester' }, { role: 'reviewer' }] } as never;
  for (const p of Object.keys(APPROVAL_PRESETS) as (keyof typeof APPROVAL_PRESETS)[]) {
    const s = applyApprovalPreset({}, p);
    assert.equal(detectApprovalPreset(s), p);
    assert.doesNotThrow(() => resolvePipeline(team, s));
  }
});

test('applying a preset preserves which stages are on (merge off stays off)', () => {
  const s = applyApprovalPreset({ merge: { enabled: false, gate: 'required' }, test: { enabled: false, gate: 'auto' } }, 'start-and-end');
  assert.equal(s.merge.enabled, false);
  assert.equal(s.test.enabled, false);
  assert.equal(s.plan.gate, 'required');
  // a skipped stage's gate doesn't stop the preset being recognised
  assert.equal(detectApprovalPreset({ ...s, test: { enabled: false, gate: 'required' } }), 'start-and-end');
});

test('a mix that matches no preset is custom', () => {
  assert.equal(detectApprovalPreset({ plan: { enabled: true, gate: 'notify' } }), 'custom');
});

test('setFactoryMerges keeps the server invariants (merge on => create_mr on => implement on)', () => {
  const off = setFactoryMerges({}, false);
  assert.equal(off.merge.enabled, false);
  assert.equal(off.create_mr.enabled, true);
  const on = setFactoryMerges({ create_mr: { enabled: false, gate: 'auto' }, merge: { enabled: false, gate: 'required' }, implement: { enabled: false, gate: 'auto' } }, true);
  assert.equal(on.merge.enabled, true);
  assert.equal(on.create_mr.enabled, true);
  assert.equal(on.implement.enabled, true);
  assert.equal(effectiveStages(on).plan.enabled, true);
});

test('budget presets', () => {
  assert.equal(detectBudgetPreset(25, 500), 'standard');
  assert.equal(detectBudgetPreset('10', '200'), 'small');
  assert.equal(detectBudgetPreset(25, 0), 'custom');
});

test('the whole team moves between Claude and ChatGPT/OpenAI: runtimes + models that can run there', () => {
  const claude: Record<string, string> = { RUNTIME_DEFAULT_IMPLEMENTER: 'claude-code', MODEL_DEFAULT_PLANNER: 'claude-opus-4-8', MODEL_DEFAULT_IMPLEMENTER: 'claude-opus-4-8', MODEL_DEFAULT_TESTER: 'claude-sonnet-5', MODEL_DEFAULT_REVIEWER: 'claude-haiku-4-5' };
  assert.equal(detectTeamAi((k) => claude[k]), 'claude');
  assert.equal(detectTeamAi(() => undefined), 'claude', 'a fresh install runs on Claude');
  const toOpenai = Object.fromEntries(teamAiWrites('openai', (k) => claude[k] ?? 'claude-code', MODELS));
  for (const r of ['PLANNER', 'IMPLEMENTER', 'TESTER', 'REVIEWER']) {
    assert.equal(toOpenai[`RUNTIME_DEFAULT_${r}`], 'codex');
    assert.equal(toOpenai[`MODEL_DEFAULT_${r}`], TEAM_AI_MODELS.openai[r as 'PLANNER']);
    assert.ok(MODELS.find((m) => m.id === toOpenai[`MODEL_DEFAULT_${r}`])?.runtimes.includes('codex'));
  }
  const openai: Record<string, string> = { ...toOpenai, MODEL_DEFAULT_TESTER: 'gpt-6-luna' };
  assert.equal(detectTeamAi((k) => openai[k]), 'openai');
  assert.deepEqual(teamAiWrites('openai', (k) => openai[k], MODELS), [], 'already on OpenAI: nothing to write, a picked GPT model is kept');
  const back = Object.fromEntries(teamAiWrites('claude', (k) => openai[k], MODELS));
  assert.equal(back.RUNTIME_DEFAULT_IMPLEMENTER, 'claude-code');
  assert.equal(back.MODEL_DEFAULT_IMPLEMENTER, 'claude-opus-4-8');
  assert.equal(back.MODEL_DEFAULT_TESTER, 'claude-sonnet-5');
});

test('teamAiWrites never writes a model the (allowlisted) catalogue hides', () => {
  const narrowed = MODELS.filter((m) => ['claude-haiku-4-5', 'claude-sonnet-5'].includes(m.id));
  const openai: Record<string, string> = { RUNTIME_DEFAULT_IMPLEMENTER: 'codex', MODEL_DEFAULT_PLANNER: 'gpt-6-astra', MODEL_DEFAULT_TESTER: 'gpt-6-sol' };
  const writes = Object.fromEntries(teamAiWrites('claude', (k) => openai[k] ?? '', narrowed));
  assert.equal(writes.MODEL_DEFAULT_PLANNER, 'claude-sonnet-5', 'opus-4-8 hidden: nearest allowed tier');
  assert.equal(writes.MODEL_DEFAULT_TESTER, 'claude-sonnet-5');
  for (const v of Object.entries(writes).filter(([k]) => k.startsWith('MODEL_')).map(([, v]) => v)) assert.ok(narrowed.some((m) => m.id === v), v);
  // nothing runnable on codex: the model write is skipped, the runtime still moves
  const toOpenai = Object.fromEntries(teamAiWrites('openai', () => '', narrowed));
  assert.equal(toOpenai.RUNTIME_DEFAULT_PLANNER, 'codex');
  assert.equal(toOpenai.MODEL_DEFAULT_PLANNER, undefined);
});
