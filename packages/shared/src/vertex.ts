import { z } from 'zod';
import { MODELS, type ModelInfo, type ModelTier } from './models.js';

/**
 * Claude on Google Cloud Vertex AI (M9).
 *
 * A Vertex org can call only the Claude models enabled on its GCP project,
 * under Vertex model ids that sometimes differ from Anthropic's
 * (`claude-haiku-4-5@20251001`). The setup question asks for the project and
 * region, then has a WORKER (the only process that holds the Google login) try
 * each candidate model with one tiny request. The ones that answer become the
 * factory's model list (MODEL_CATALOG_EXTRA + MODEL_ALLOWLIST).
 */

/** The model ids the check tries, strongest first within each tier. The first
 * one that works in a tier becomes that tier's default. */
export const VERTEX_CANDIDATES: ReadonlyArray<{ id: string; tier: ModelTier }> = [
  { id: 'claude-opus-5-5', tier: 'max' },
  { id: 'claude-opus-5', tier: 'max' },
  { id: 'claude-opus-4-8', tier: 'max' },
  { id: 'claude-opus-4-7', tier: 'max' },
  { id: 'claude-opus-4-6', tier: 'max' },
  { id: 'claude-sonnet-5-5', tier: 'balanced' },
  { id: 'claude-sonnet-5', tier: 'balanced' },
  { id: 'claude-sonnet-4-6', tier: 'balanced' },
  { id: 'claude-haiku-4-5@20251001', tier: 'fast' },
];

export const VERTEX_DEFAULT_REGION = 'global';

/** The tier of a Claude model id from its family name (opus/sonnet/haiku); balanced when unknown. */
export function vertexTier(id: string): ModelTier {
  if (/opus|fable/i.test(id)) return 'max';
  if (/haiku/i.test(id)) return 'fast';
  return 'balanced';
}

/** The id Vertex knows: Claude Code's `[1m]` (1M-token context) suffix is a client-side option. */
export function vertexWireId(id: string): string {
  return id.replace(/\[1m\]$/i, '');
}

/** A GCP project id: 6–30 chars, lowercase letters, digits, hyphens; starts with a letter. */
export function isGcpProjectId(s: string): boolean {
  return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(s);
}

/** `global`, or a region such as us-east5 / europe-west1. */
export function isVertexRegion(s: string): boolean {
  return s === 'global' || /^[a-z]+-[a-z]+\d+$/.test(s);
}

/** The Vertex endpoint for one model (rawPredict, Anthropic Messages body). */
export function vertexModelUrl(projectId: string, region: string, model: string): string {
  const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${projectId}/locations/${region}/publishers/anthropic/models/${encodeURIComponent(vertexWireId(model)).replace(/%40/g, '@')}:rawPredict`;
}

// ── The check: requested in the UI, carried out by a worker ─────────────────

export const vertexCheckRequestSchema = z.object({
  projectId: z.string().min(1),
  region: z.string().min(1),
  models: z.array(z.string().min(1)).min(1).max(30),
});
export type VertexCheckRequest = z.infer<typeof vertexCheckRequestSchema>;

/** Why one step failed, in a form the UI turns into a plain fix. */
export const VERTEX_CHECK_CODES = [
  'no_login', 'login_expired', 'unsupported_login', 'no_permission', 'api_disabled', 'bad_project',
  'not_enabled', 'quota', 'unreachable', 'claude_code_failed', 'no_worker', 'other',
] as const;
export type VertexCheckCode = typeof VERTEX_CHECK_CODES[number];

const stepSchema = z.object({ ok: z.boolean(), code: z.enum(VERTEX_CHECK_CODES).optional(), reason: z.string().optional() });
export const vertexCheckResultSchema = z.object({
  ok: z.boolean(),
  worker: z.string().optional(),
  login: stepSchema.extend({ account: z.string().optional(), kind: z.string().optional() }),
  models: z.array(stepSchema.extend({ id: z.string(), tier: z.enum(['fast', 'balanced', 'max']) })),
  claudeCode: stepSchema.extend({ model: z.string().optional(), skipped: z.boolean().optional() }),
  checkedAt: z.string(),
});
export type VertexCheckResult = z.infer<typeof vertexCheckResultSchema>;

export type VertexCheckState =
  | { id: string; state: 'queued' | 'running'; worker?: string; since: string }
  | { id: string; state: 'done'; result: VertexCheckResult };

/**
 * The model the check runs Claude Code itself on: the first working balanced
 * model, else the first working one. Null when nothing worked.
 */
export function vertexCheckModel(models: ReadonlyArray<{ id: string; tier: ModelTier; ok: boolean }>): string | null {
  return (models.find((m) => m.ok && m.tier === 'balanced') ?? models.find((m) => m.ok))?.id ?? null;
}

// ── Saving the answer ────────────────────────────────────────────────────────

/**
 * MODEL_CATALOG_EXTRA after adding the chosen Vertex ids that the built-in
 * catalogue lacks. Existing extra entries are kept; an id already present is
 * left as the operator defined it.
 */
export function vertexCatalogueExtra(selected: readonly string[], existing: unknown, builtIns: ReadonlyArray<Pick<ModelInfo, 'id'>> = MODELS): { models: Array<Partial<ModelInfo> & { id: string }>; providers?: unknown } {
  const base = (existing && typeof existing === 'object' ? existing : {}) as { models?: unknown; providers?: unknown };
  const models = (Array.isArray(base.models) ? base.models : []).filter((m): m is Partial<ModelInfo> & { id: string } => !!m && typeof (m as { id?: unknown }).id === 'string');
  for (const id of selected) {
    if (builtIns.some((m) => m.id === id) || models.some((m) => m.id === id)) continue;
    models.push({ id, label: `${id} (Vertex AI)`, tier: vertexTier(id), providerId: 'anthropic', runtimes: ['claude-code'] });
  }
  return { ...(base.providers !== undefined ? { providers: base.providers } : {}), models };
}

/**
 * Everything the Vertex answer writes, except the role defaults (the caller adds
 * teamAiWrites against the narrowed catalogue so every role lands on an allowed model).
 */
export function vertexWrites(a: { projectId: string; region: string; selected: readonly string[]; existingExtra: unknown }): Array<[string, unknown]> {
  return [
    ['ANTHROPIC_VERTEX_PROJECT_ID', a.projectId.trim()],
    ['CLOUD_ML_REGION', a.region.trim() || VERTEX_DEFAULT_REGION],
    ['MODEL_CATALOG_EXTRA', vertexCatalogueExtra(a.selected, a.existingExtra)],
    ['MODEL_ALLOWLIST', a.selected.join(', ')],
    ['AGENT_AUTH_MODE', 'vertex'],
  ];
}
