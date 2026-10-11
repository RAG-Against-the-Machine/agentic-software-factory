import { SKILL_ENTRY_FILE, SKILL_ROLES } from '@asf/shared/ui';
import type { SkillRole } from '@asf/shared';

/**
 * Pure helpers for Settings → Skills (ADHOC-75B02597 part 4/4). No React, no DOM.
 * The api makes the final call on every link; these only catch the obvious mistakes early.
 */

/**
 * A GitHub folder link (github.com/owner/repo/tree/…) or a GitLab one
 * (host/group/project/-/tree/…, self-hosted too), over https. Trims the input.
 */
export function checkSkillUrl(s: string): { ok: true; url: string } | { ok: false; reason: string } {
  const url = s.trim();
  if (!url) return { ok: false, reason: 'Paste a link to the skill’s folder.' };
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, reason: 'That is not a link.' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'Use an https:// link.' };
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  const github = (host === 'github.com' || host === 'www.github.com') && parts.length >= 4 && (parts[2] === 'tree' || parts[2] === 'blob');
  const dash = parts.indexOf('-');
  const gitlab = !github && dash >= 2 && parts.length >= dash + 3 && (parts[dash + 1] === 'tree' || parts[dash + 1] === 'blob');
  if (!github && !gitlab) {
    return { ok: false, reason: 'Use a GitHub or GitLab folder link, like https://github.com/owner/repo/tree/main/skills/my-skill.' };
  }
  return { ok: true, url };
}

/** Adds or removes a role, in SKILL_ROLES order. The last role stays: a skill needs at least one. */
export function toggleRole(roles: readonly SkillRole[], role: SkillRole): SkillRole[] {
  const has = roles.includes(role);
  if (has && roles.length === 1) return [...roles];
  return SKILL_ROLES.filter((r) => (r === role ? !has : roles.includes(r)));
}

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** The SKILL.md text, or '' if it's missing. */
export function skillEntryText(files: readonly { path: string; content: string }[]): string {
  return files.find((f) => f.path === SKILL_ENTRY_FILE)?.content ?? '';
}

/** The api's reason for a refusal, or a fallback with the status. */
export function refusal(res: { status: number; body: { reason?: string } }): string {
  return res.body.reason?.trim() || `That didn’t work (${res.status}).`;
}
