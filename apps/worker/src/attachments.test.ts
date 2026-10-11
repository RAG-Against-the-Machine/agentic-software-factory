import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunContext } from '@asf/shared';
import { downloadAttachments } from './segment.js';

const ctx = (attachments: { name: string; mime: string; size: number }[] | undefined) =>
  ({ ticket: { id: 'adhoc:1', key: 'ADHOC-1', title: 't', body: '', url: '', links: [], attachments } }) as unknown as RunContext;

test('downloadAttachments writes each file to <runDir>/attachments and skips one already there', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'asf-att-'));
  const fetched: string[] = [];
  const fetchOne = async (_run: string, name: string) => { fetched.push(name); return Buffer.from(`bytes of ${name}`); };
  const files = [{ name: 'a.png', mime: 'image/png', size: 'bytes of a.png'.length }, { name: 'b.txt', mime: 'text/plain', size: 'bytes of b.txt'.length }];

  await downloadAttachments(runDir, 'run_1', ctx(files), fetchOne);
  assert.deepEqual(fetched, ['a.png', 'b.txt']);
  assert.equal(await readFile(join(runDir, 'attachments', 'a.png'), 'utf8'), 'bytes of a.png');

  await downloadAttachments(runDir, 'run_1', ctx(files), fetchOne);
  assert.deepEqual(fetched, ['a.png', 'b.txt'], 'a later role of the same run does not download again');
  await rm(runDir, { recursive: true, force: true });
});

test('downloadAttachments does nothing without attachments and refuses a path-like name', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'asf-att-'));
  const never = async () => { throw new Error('should not fetch'); };
  await downloadAttachments(runDir, 'run_1', ctx(undefined), never);
  await assert.rejects(downloadAttachments(runDir, 'run_1', ctx([{ name: '../evil', mime: 'text/plain', size: 1 }]), never), /refusing attachment name/);
  await rm(runDir, { recursive: true, force: true });
});
