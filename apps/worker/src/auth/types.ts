import type { ProviderKind, RunAuth } from '@asf/shared';

/**
 * One model provider's auth translation (M8 WP C): the run's resolved RunAuth ->
 * the env a spawned agent gets. Every credential env-var NAME lives under
 * apps/worker/src/auth/ and nowhere else in the worker (a CI grep enforces it for
 * src/runtimes/), so a runtime file can never read or set a credential by name.
 */
export interface AuthTranslator {
  readonly kind: ProviderKind;
  /** Every env var through which the worker's own environment could leak a
   * credential for THIS provider. All are removed before the mode's one is set. */
  readonly credentialEnv: readonly string[];
  /** Non-secret env the mode needs (vertex flag, base URL, ...). */
  modeEnv(auth: RunAuth): Record<string, string>;
  /** The env var the mode's credential is set into, or null if the mode carries none. */
  credentialTarget(auth: RunAuth): string | null;
  /** The setting an operator fills in for the mode's credential (for error messages). */
  credentialSetting(mode: string): string | null;
  /** Static, non-network config problems for a mode (e.g. vertex without a project). */
  configProblem?(auth: RunAuth, env: NodeJS.ProcessEnv): string | null;
}
