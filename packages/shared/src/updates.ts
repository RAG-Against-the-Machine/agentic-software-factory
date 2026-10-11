import { z } from 'zod';

/** Whether a newer ASF release is published (GET /api/updates). */
export const updateStatusSchema = z.object({
  /** This build's version (`git describe --tags`), or `dev` when unknown. */
  current: z.string(),
  /** The highest published vX.Y.Z tag, or null when not checked yet / none found. */
  latest: z.string().nullable(),
  available: z.boolean(),
  checkedAt: z.string().nullable(),
  error: z.string().nullable(),
  canApply: z.boolean(),
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;
