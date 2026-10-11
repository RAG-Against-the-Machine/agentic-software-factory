/**
 * Merge conflicts at publish time (#conflict). A run's branch is cut from main when it
 * starts; by the time it publishes, other PRs may have merged. The worker brings the
 * current base into the branch at push time; when that conflicts, the push step fails
 * with a reason in THIS format, and the orchestrator — instead of failing the run —
 * hands the conflict back to the implementer (bounded), then re-tests, re-reviews and
 * pushes again. The format is the contract between the two; keep it parseable.
 */

/** How many times one run may loop back to resolve a conflict before a person decides. */
export const MAX_CONFLICT_RESOLUTIONS = 2;

/** run_task.queued_by for role copies re-run to resolve a merge conflict. */
export const CONFLICT_QUEUED_BY = 'merge_conflict';

const PREFIX = 'merge conflict with ';

/** The publish step's failure reason when the base moved and the branch no longer merges. */
export function formatMergeConflict(base: string, files: string[]): string {
  const list = files.length ? files.join(', ') : '(unknown files)';
  return `${PREFIX}${base}: work merged since this run started changes the same lines in ${list}`;
}

/** Inverse of formatMergeConflict; null when the reason is anything else. */
export function parseMergeConflict(reason: string | null | undefined): { base: string; files: string[] } | null {
  if (!reason || !reason.startsWith(PREFIX)) return null;
  const m = reason.slice(PREFIX.length).match(/^([^:]+): work merged since this run started changes the same lines in (.*)$/s);
  if (!m) return null;
  const files = m[2] === '(unknown files)' ? [] : m[2].split(', ').map((f) => f.trim()).filter(Boolean);
  return { base: m[1], files };
}
