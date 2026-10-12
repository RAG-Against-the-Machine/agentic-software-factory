import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceUsage, rateFor, baseModelId } from './pricing.js';

test('prices usage against a known model family (prefix match)', () => {
  const cost = priceUsage('claude-sonnet-4-6', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(cost, 3 + 15);
});

test('cache tokens are priced at their own rate', () => {
  const cost = priceUsage('claude-opus-4-8', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 });
  assert.equal(cost, 1.5 + 18.75);
});

test('legacy families still price by prefix; a current model prices by exact catalogue id', () => {
  assert.equal(rateFor('claude-opus-4-1-20250805')?.inputPerM, 15);
  assert.equal(rateFor('claude-3-5-haiku-20241022')?.inputPerM, 0.8);
  assert.equal(rateFor('claude-sonnet-5')?.inputPerM, 3);
});

test('an unknown model returns null rather than a guessed price', () => {
  assert.equal(rateFor('some-other-model'), null);
  assert.equal(priceUsage('some-other-model', { inputTokens: 100, outputTokens: 100 }), null);
  assert.equal(priceUsage('claude-opus-4-8', null), null);
});

test('Vertex and long-context ids price as their base model, cache rates included', () => {
  assert.equal(baseModelId('claude-haiku-4-5@20251001'), 'claude-haiku-4-5');
  assert.equal(baseModelId('claude-sonnet-5[1m]'), 'claude-sonnet-5');
  assert.equal(baseModelId('claude-opus-4-6@20260101[1m]'), 'claude-opus-4-6');
  assert.equal(baseModelId('claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(baseModelId('claude-sonnet-5[1m]@20260101'), 'claude-sonnet-5', 'either suffix order');
  // haiku@date: was the bare 'claude-haiku' prefix with no cache rate (cache read priced 10x)
  assert.equal(priceUsage('claude-haiku-4-5@20251001', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }), 0.1);
  assert.deepEqual(rateFor('claude-sonnet-5[1m]'), rateFor('claude-sonnet-5'));
  assert.deepEqual(rateFor('claude-opus-5-5[1m]'), rateFor('claude-opus-5-5'));
  // not in the built-in catalogue: the family prefix still prices it
  assert.equal(rateFor('claude-sonnet-5-5')?.inputPerM, 3);
  assert.equal(rateFor('claude-opus-4-7[1m]')?.inputPerM, 15);
});
