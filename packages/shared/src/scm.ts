import { z } from 'zod';
import type { Preflight } from './ticket.js';

export const repoSchema = z.object({
  id: z.string(),
  path: z.string(),          // "owner/repo" or "group/sub/repo", as the provider spells it
  url: z.string(),           // provider web URL, copied
  defaultBranch: z.string(),
  cloneUrl: z.string(),
});
export type Repo = z.infer<typeof repoSchema>;

export const changeRequestSchema = z.object({
  id: z.string(),
  number: z.number().int(),  // PR number / MR iid — only unique per repo
  repoId: z.string(),
  url: z.string(),
  title: z.string(),
  state: z.enum(['open', 'merged', 'closed']),
  draft: z.boolean(),
  headBranch: z.string(),
  baseBranch: z.string(),
  reviewState: z.enum(['pending', 'approved', 'changes_requested']).nullable(),
  ciState: z.enum(['success', 'failed', 'running', 'pending']).nullable(),
  updatedAt: z.string(),
});
export type ChangeRequest = z.infer<typeof changeRequestSchema>;

export const reviewCommentSchema = z.object({
  id: z.string(),
  author: z.string(),
  body: z.string(),
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  resolved: z.boolean().nullable(),
  createdAt: z.string(),
});
export type ReviewComment = z.infer<typeof reviewCommentSchema>;

export const scmProviderKindSchema = z.enum(['mock', 'gitlab', 'github']);
export type ScmProviderKind = z.infer<typeof scmProviderKindSchema>;

/** Branches no run may ever push to, regardless of provider. */
export const FORBIDDEN_BRANCHES = ['main', 'master', 'production', 'prod', 'release', 'develop'] as const;
export function isForbiddenBranch(name: string): boolean {
  return (FORBIDDEN_BRANCHES as readonly string[]).includes(name.trim().toLowerCase());
}

export interface ScmProvider {
  readonly kind: ScmProviderKind;
  preflight(): Promise<Preflight>;
  searchRepos(q: string): Promise<Repo[]>;
  getRepo(idOrPath: string): Promise<Repo>;
  /** What the worker uses to clone and push. Never handed to an agent. */
  cloneCredential(repo: Repo): Promise<{ url: string; header?: string }>;
  openChangeRequest(repo: Repo, input: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<ChangeRequest>;
  listChangeRequests(repo: Repo, q: { ticketKeys?: string[]; since?: string }): Promise<ChangeRequest[]>;
  getChangeRequest(repo: Repo, number: number): Promise<ChangeRequest & { diffRefs: unknown }>;
  listReviewComments(repo: Repo, number: number): Promise<ReviewComment[]>;
  comment(repo: Repo, number: number, body: string, anchor?: { path: string; line: number }): Promise<void>;
  /** Only ever called after the `before_change_request` gate resolves. */
  markReady(repo: Repo, number: number): Promise<void>;
  /** Only ever called after the `before_merge` gate resolves. */
  merge(repo: Repo, number: number, opts: { method: 'merge' | 'squash' | 'rebase' }): Promise<void>;
}
