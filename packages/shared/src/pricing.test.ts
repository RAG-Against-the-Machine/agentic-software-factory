import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceUsage, rateFor } from './pricing.js';

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
