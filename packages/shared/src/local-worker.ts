import { z } from 'zod';

/**
 * The self-host compose worker container, as the supervisor sidecar sees it (#135).
 * `missing` = no container labelled as the asf worker exists (e.g. host-worker mode,
 * or `compose down`): the UI cannot create one, only point at `./scripts/asf up`.
 */
export const localWorkerStateSchema = z.enum(['running', 'restarting', 'exited', 'missing']);
export type LocalWorkerState = z.infer<typeof localWorkerStateSchema>;

/** What the supervisor's GET /status (and POST /start) answer. */
export const supervisorStatusSchema = z.object({
  state: localWorkerStateSchema,
  exitCode: z.number().nullable(),
  restartCount: z.number().nullable(),
});
export type SupervisorStatus = z.infer<typeof supervisorStatusSchema>;

/**
 * GET /api/workers/local. `available:false` when ASF_LOCAL_SUPERVISOR is off or
 * the supervisor is unreachable — the UI then only shows the `./scripts/asf up` hint.
 */
export const localWorkerStatusSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), reason: z.string() }),
  supervisorStatusSchema.extend({ available: z.literal(true) }),
]);
export type LocalWorkerStatus = z.infer<typeof localWorkerStatusSchema>;
