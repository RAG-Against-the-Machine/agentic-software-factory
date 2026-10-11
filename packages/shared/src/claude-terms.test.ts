import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionSharingWarning } from './claude-terms.js';

test('only a subscription token shared by several operators is flagged', () => {
  assert.match(subscriptionSharingWarning('oauth-token', 'header') ?? '', /API key/);
  assert.equal(subscriptionSharingWarning('oauth-token', 'none'), null);
  for (const m of ['api-key', 'vertex', 'bedrock']) assert.equal(subscriptionSharingWarning(m, 'header'), null);
});
