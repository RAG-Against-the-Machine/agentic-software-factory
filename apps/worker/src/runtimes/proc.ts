import type { ChildProcess } from 'node:child_process';

/**
 * Kill an agent's whole process tree. Adapters spawn the agent `detached: true`
 * so it leads its own process group; signalling `-pid` reaches every descendant
 * (Bash-tool children, test runners, dev servers) — killing only the parent leaves
 * them orphaned and still writing to the worktree. SIGTERM first, SIGKILL after
 * `graceMs` if the group is still alive. Falls back to the single child when the
 * group signal fails (not detached, or already gone).
 */
export function killTree(child: ChildProcess, graceMs = 10_000): void {
  const send = (sig: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* already gone */ } }
  };
  send('SIGTERM');
  const t = setTimeout(() => send('SIGKILL'), graceMs);
  t.unref?.();
}
