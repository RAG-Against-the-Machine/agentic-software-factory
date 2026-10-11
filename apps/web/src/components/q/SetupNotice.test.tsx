import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noticeContent } from './SetupNotice';
import type { SetupItem } from '../../api';

const it = (id: string, o: Partial<SetupItem> = {}): SetupItem => ({ id, title: id, done: true, link: `/settings#${id}`, ...o });
const REJECTED = 'GitHub rejected the saved access token (401). It was revoked, has expired, or was mistyped: create a new one and paste it in Settings.';

test('everything done: no notice', () => {
  assert.equal(noticeContent([it('ticket'), it('scm'), it('agent-auth'), it('worker'), it('pipeline', { done: false, optional: true }), it('first-run', { done: false })]), null);
});

test('unconfigured items: the "setup isn’t finished" notice, as before', () => {
  const c = noticeContent([it('ticket', { done: false }), it('scm', { done: false }), it('agent-auth'), it('worker')])!;
  assert.equal(c.title, 'Setup isn’t finished');
  assert.equal(c.detail, 'Still needed: a real work tracker and a real code host.');
  assert.equal(c.to, '/setup');
});

test('one rejected GitHub token breaking tracker + code host: named once, linked to the fix', () => {
  const c = noticeContent([
    it('ticket', { done: false, problem: 'credential-rejected', reason: REJECTED, link: '/settings#tickets' }),
    it('scm', { done: false, problem: 'credential-rejected', reason: REJECTED, link: '/settings#code' }),
    it('agent-auth'), it('worker'),
  ])!;
  assert.equal(c.title, 'Saved token rejected: your work tracker and code host are disconnected');
  assert.equal(c.detail, REJECTED, 'the shared reason appears once');
  assert.equal(c.action, 'Fix in Settings');
  assert.equal(c.to, '/settings#tickets');
  assert.doesNotMatch(c.title + c.detail, /Setup isn’t finished|Still needed/);
});

test('a broken connection plus something unconfigured: both said', () => {
  const c = noticeContent([
    it('ticket', { done: false, problem: 'connection-failed', reason: 'Jira can’t find project ABC.' }),
    it('scm'), it('agent-auth'), it('worker', { done: false }),
  ])!;
  assert.equal(c.title, 'Your work tracker isn’t connected');
  assert.equal(c.detail, 'Jira can’t find project ABC. Also still needed: a worker online.');
});
