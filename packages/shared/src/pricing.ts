import type { AgentUsage } from './runtime.js';
import { MODELS, type ModelInfo } from './models.js';

export interface ModelRate { inputPerM: number; outputPerM: number; cacheReadPerM?: number; cacheWritePerM?: number }

/**
 * USD per 1M tokens for older families still seen in run history. A prefix
 * match, so dated snapshots resolve to the family. Current models carry their
 * price on the catalogue entry (models.ts `rate`), not here.
 */
export const MODEL_RATES: Record<string, ModelRate> = {
  'claude-opus-5': { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 },
  'claude-opus-4': { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 },
  'claude-sonnet-4': { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
  'claude-3-5-haiku': { inputPerM: 0.8, outputPerM: 4, cacheReadPerM: 0.08, cacheWritePerM: 1 },
  'claude-haiku': { inputPerM: 1, outputPerM: 5 },
};

/** The catalogue entry's own rate on an exact id match, else the legacy prefix table. */
export function rateFor(model: string | null | undefined, catalogue: ModelInfo[] = MODELS): ModelRate | null {
  if (!model) return null;
  const exact = catalogue.find((m) => m.id === model)?.rate;
  if (exact) return exact;
  const key = Object.keys(MODEL_RATES).find((k) => model.startsWith(k));
  return key ? MODEL_RATES[key] : null;
}

/**
 * Cost from usage when the runtime does not report its own. Returns null when
 * the model is unknown — a guessed price is worse than an honest gap, and the
 * runtime's own figure is preferred anyway.
 */
export function priceUsage(model: string | null | undefined, usage: AgentUsage | null, catalogue: ModelInfo[] = MODELS): number | null {
  const rate = rateFor(model, catalogue);
  if (!rate || !usage) return null;
  const m = (n: number, per: number) => (n / 1_000_000) * per;
  return (
    m(usage.inputTokens, rate.inputPerM) +
    m(usage.outputTokens, rate.outputPerM) +
    m(usage.cacheReadTokens ?? 0, rate.cacheReadPerM ?? rate.inputPerM) +
    m(usage.cacheWriteTokens ?? 0, rate.cacheWritePerM ?? rate.inputPerM)
  );
}
