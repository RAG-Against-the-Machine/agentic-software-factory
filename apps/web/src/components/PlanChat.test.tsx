import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RunMessageWire } from '@asf/shared';
import { PlanChat } from './PlanChat';

const noop = () => {};
const msg = (author: 'agent' | 'human', body: string) =>
  ({ id: `m_${author}`, runId: 'run_1', taskId: 'task_1', role: 'planner', author, kind: author === 'agent' ? 'question' : 'reply', body, by: null, sessionId: null, createdAt: '' } as unknown as RunMessageWire);
const chat = (messages: RunMessageWire[]) => renderToStaticMarkup(
  <QueryClientProvider client={new QueryClient()}>
    <PlanChat runId="run_1" ticketId="adhoc:abc" ticketKey="ADHOC-ABC" gate={null} plannerTask={null} onDone={noop} messages={messages} />
  </QueryClientProvider>);

test('the planner\'s messages render as markdown', () => {
  const html = chat([msg('agent', '**What changes:**\n- a')]);
  assert.match(html, /<strong>What changes:<\/strong>/);
  assert.match(html, /<li>a<\/li>/);
});

test('your own replies show exactly as typed', () => {
  const html = chat([msg('human', 'make it **x**')]);
  assert.match(html, /make it \*\*x\*\*/);
  assert.doesNotMatch(html, /<strong>/);
});

test('raw HTML in a planner message is not output as a tag', () => {
  const html = chat([msg('agent', 'hi <script>alert(1)</script>')]);
  assert.doesNotMatch(html, /<script/);
});
