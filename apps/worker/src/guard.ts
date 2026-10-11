import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Workspace } from './git.js';

const exec = promisify(execFile);

/**
 * The runtime-agnostic guard layer (M8 WP A). Claude Code enforces scope, cancel
 * and no-push through its PreToolUse hook; a runtime without hooks cannot. These
 * checks run in the WORKER, around any runtime, so the invariants hold whether or
 * not the agent cooperated:
 *
 *  - no push: the worktree's origin carries no credential (git.ts ensureWorkspace);
 *  - scope:   auditWorktree reverts a read-only role's edits to the worktree after the fact;
 *  - cancel:  watchCancel aborts the runtime's RunControl signal; the adapter kills the process tree.
 */

export interface AuditResult {
  /** A read-only role changed or deleted a TRACKED file — source it was not allowed to touch. */
  violated: boolean;
  /** Tracked paths it changed (the violation). */
  paths: string[];
  /** Untracked files it left behind (test caches, scratch files) — reverted, not a violation. */
  untracked: string[];
}

/**
 * Post-hoc scope audit. A writing role may change the worktree (the worker commits
 * it); a read-only role may not. If a read-only role left the tree dirty, revert
 * every change — tracked edits and untracked files — and report them. For a
 * writing role this is a no-op: its scope is the whole worktree.
 *
 * Only a TRACKED change is a violation. A reviewer that runs the tests legitimately
 * leaves `__pycache__/` or `.pytest_cache/` behind when the repo does not ignore
 * them; that is swept (so the next writer does not commit it) but does not fail the
 * role — the Claude hook never blocked it either, and WP A must not change Claude's
 * behavior. Ignored files are left alone (`clean -fd`, not `-fdx`).
 */
export async function auditWorktree(ws: Pick<Workspace, 'worktreePath'>, writes: boolean): Promise<AuditResult> {
  const clean: AuditResult = { violated: false, paths: [], untracked: [] };
  if (writes) return clean;
  const git = (args: string[]) => exec('git', args, { cwd: ws.worktreePath, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout);
  const status = await git(['status', '--porcelain', '--untracked-files=all']);
  const lines = status.split('\n').filter(Boolean);
  if (!lines.length) return clean;
  const pathOf = (l: string) => l.slice(3).replace(/^.* -> /, '');
  const untracked = lines.filter((l) => l.startsWith('??')).map(pathOf);
  const paths = lines.filter((l) => !l.startsWith('??')).map(pathOf);
  // Unborn HEAD (empty repo, nothing committed yet): there is nothing to check out,
  // so only the untracked sweep applies.
  const born = await git(['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
  if (born) {
    await git(['reset', '-q', 'HEAD', '--', '.']).catch(() => {});
    await git(['checkout', '--', '.']);
  } else {
    await git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.']).catch(() => {});
  }
  await git(['clean', '-fdq']);
  return { violated: paths.length > 0, paths, untracked };
}

export interface CancelWatch { signal: AbortSignal; stop(): void }

/**
 * Poll `isCancelled` every `intervalMs` and abort the returned signal the first
 * time it answers true. A thrown/rejected poll is ignored (fail open: an api
 * restart must not cancel the fleet's work). `stop()` ends polling; call it when
 * the runtime returns.
 */
export function watchCancel(isCancelled: () => Promise<boolean>, intervalMs = 5000): CancelWatch {
  const ctl = new AbortController();
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight || ctl.signal.aborted) return;
    inFlight = true;
    isCancelled()
      .then((yes) => { if (yes && !ctl.signal.aborted) ctl.abort(new Error('run cancelled by the operator')); })
      .catch(() => {})
      .finally(() => { inFlight = false; });
  }, intervalMs);
  // Deliberately NOT unref'd: the caller always stop()s it (segment.ts, in a finally),
  // and an unref'd poll lets the event loop drain before a pending abort resolves.
  return { signal: ctl.signal, stop: () => clearInterval(timer) };
}
