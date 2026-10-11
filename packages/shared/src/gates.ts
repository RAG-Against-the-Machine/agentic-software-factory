import type { GateConfig, GateMode, TeamTemplate } from './team.js';
import { DEFAULT_GATES } from './team.js';

/**
 * Resolving the gate config for a run, and the one rule that is a policy
 * surface: `before_merge` — the gate that lets an agent land code on the
 * default branch — may be relaxed from `required` ONLY by a project-level
 * setting, never by a per-dispatch request. A dispatch that tries is refused
 * with a reason, so a control that looks live is one the server will accept.
 */
export class GatePolicyError extends Error {}

export interface GateOverrides {
  /** Set by a project admin; may relax any gate including before_merge. */
  project?: Partial<Record<string, GateConfig>>;
  /** Chosen in the dispatch modal; may relax every gate EXCEPT before_merge. */
  request?: Partial<Record<string, GateConfig>>;
}

export function resolveGates(team: TeamTemplate, overrides: GateOverrides = {}): Record<string, GateConfig> {
  const withProject: Record<string, GateConfig> = { ...DEFAULT_GATES, ...team.gates };
  for (const [name, cfg] of Object.entries(overrides.project ?? {})) if (cfg) withProject[name] = cfg;

  for (const [name, cfg] of Object.entries(overrides.request ?? {})) {
    if (!cfg) continue;
    if (name === 'before_merge' && cfg.mode !== 'required') {
      const relaxedByProject = overrides.project?.before_merge && overrides.project.before_merge.mode !== 'required';
      if (!relaxedByProject) {
        throw new GatePolicyError(
          'before_merge can only be relaxed from "required" by a project-level setting, not from a dispatch. ' +
            'Committing to the default branch without a person is a project policy, not a per-run choice.',
        );
      }
    }
    withProject[name] = cfg;
  }
  return withProject;
}

export function gateMode(gates: Record<string, GateConfig>, name: string): GateMode {
  return gates[name]?.mode ?? 'auto';
}

/** The gate that fires after a given role finishes, by convention. */
export function gateAfterRole(role: string): string {
  return role === 'planner' ? 'after_plan' : `after_role:${role}`;
}

/**
 * A reviewer writes APPROVE / REQUEST_CHANGES / ESCALATE on the first line of
 * review.md. ESCALATE (M11 WP4) is the reviewer saying "the implementer and I
 * disagree and I'm repeating myself — a human should decide", handled like a
 * needs-human checkpoint rather than another loop.
 */
export function reviewVerdict(reviewText: string | null | undefined): 'approve' | 'request_changes' | 'escalate' | null {
  if (!reviewText) return null;
  const first = reviewText.trim().split('\n')[0]?.toUpperCase() ?? '';
  if (first.includes('REQUEST_CHANGES')) return 'request_changes';
  if (first.includes('ESCALATE')) return 'escalate';
  if (first.includes('APPROVE')) return 'approve';
  return null;
}

/**
 * The "blocking" content of a review, normalised for comparison (M11 WP4): the
 * verdict line plus any must-fix/blocking bullets, lowercased, markdown and
 * punctuation stripped, collapsed to a token set. Two reviews with the same
 * blockers compare equal even through reformatting.
 */
export function blockingTokens(reviewText: string | null | undefined): Set<string> {
  if (!reviewText) return new Set();
  // Only REQUEST_CHANGES / ESCALATE reviews have blockers to compare; an APPROVE
  // has none, so two APPROVEs are never "a repeat".
  const verdict = reviewVerdict(reviewText);
  if (verdict !== 'request_changes' && verdict !== 'escalate') return new Set();
  const lines = reviewText.split('\n').map((l) => l.trim()).filter(Boolean);
  const keep = lines.filter((l) =>
    /(must[- ]?fix|blocking|blocker)/i.test(l) || /^[-*]\s/.test(l));
  const text = (keep.length ? keep : lines).join(' ').toLowerCase();
  const tokens = text.replace(/[^a-z0-9_\s]/g, ' ').split(/\s+/).filter((t) => t.length > 3);
  return new Set(tokens);
}

/**
 * Whether a new review repeats the previous one's blockers — Jaccard overlap of
 * their blocking token sets at/above `threshold` (default 0.8). "Dumb", no LLM,
 * unit-testable. Used to stop the reviewer↔implementer loop early when the same
 * finding recurs and the implementer's changes did not resolve it.
 */
export function reviewsRepeat(prev: string | null | undefined, next: string | null | undefined, threshold = 0.8): boolean {
  const a = blockingTokens(prev);
  const b = blockingTokens(next);
  if (a.size === 0 || b.size === 0) return false;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 && inter / union >= threshold;
}
