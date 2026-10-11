/**
 * Per-role runtime + model choice on the Dispatch page (#69). Pure, so the rules
 * are testable without a browser: the runtime narrows the models a role may use,
 * and only choices that differ from the defaults are sent.
 */
export interface ModelOption { id: string; label: string; runtimes: string[] }

/** The models a role may pick once it runs on `runtime`. */
export const modelsFor = <M extends ModelOption>(models: M[], runtime: string): M[] => models.filter((m) => m.runtimes.includes(runtime));

/** Keep `current` if it fits `runtime`; otherwise switch to the first model that does (or keep it, if none do). */
export function reconcileModel(models: ModelOption[], runtime: string, current: string): string {
  const fit = modelsFor(models, runtime);
  return fit.some((m) => m.id === current) ? current : (fit[0]?.id ?? current);
}

/** What the role's runtime select offers: what the fleet runs, always including the current choice. */
export const runtimeOptions = (fleet: string[], current: string): string[] => (fleet.includes(current) ? fleet : [current, ...fleet]);

/** Only the roles whose choice differs from the default. */
export const overridesDiff = (chosen: Record<string, string>, defaults: Record<string, string | null | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(chosen).filter(([role, v]) => v && v !== defaults[role]));

/** Why a role's on/off switch is locked on this page, or null when the operator may flip it. */
export function roleLock(role: string, orgDisabled: string[]): string | null {
  if (orgDisabled.includes(role)) return 'Switched off for every job in Settings → pipeline stages.';
  if (role === 'implementer') return 'Someone has to write the code: the pull request needs a change to open.';
  return null;
}

/** The `skipRoles` to send: the roles switched off here, minus those the org already has off. */
export const skipRolesPayload = (off: Record<string, boolean>, orgDisabled: string[]): string[] =>
  Object.entries(off).filter(([role, isOff]) => isOff && !orgDisabled.includes(role)).map(([role]) => role);

/** What the page holds for this job, and the defaults it loaded with. */
export interface DispatchChoices {
  models: Record<string, string>; runtimes: Record<string, string>; efforts: Record<string, string>;
  gates: Record<string, string>; off: Record<string, boolean>;
}
export interface DispatchDefaults {
  defaultModels: Record<string, string | null | undefined>; defaultRuntimes: Record<string, string | null | undefined>;
  defaultEfforts: Record<string, string | null | undefined>; gates: Record<string, { mode: string }>; orgDisabledRoles?: string[];
}

/** Whether anything under "Advanced" differs from the defaults, so the collapsed summary can say so. */
export function isCustomised({ models, runtimes, efforts, gates, off }: DispatchChoices, preview: DispatchDefaults): boolean {
  const effortDefaults = Object.fromEntries(Object.entries(preview.defaultEfforts).map(([k, v]) => [k, v ?? '']));
  return Object.keys(overridesDiff(models, preview.defaultModels)).length > 0
    || Object.keys(overridesDiff(runtimes, preview.defaultRuntimes)).length > 0
    || Object.keys(overridesDiff(efforts, effortDefaults)).length > 0
    || Object.entries(gates).some(([g, mode]) => mode !== preview.gates[g]?.mode)
    || skipRolesPayload(off, preview.orgDisabledRoles ?? []).length > 0;
}

/** The check-ins worth asking about: no "after the plan" check-in when nobody writes a plan. */
export const gatesFor = (gates: string[], plannerOff: boolean): string[] => (plannerOff ? gates.filter((g) => g !== 'after_plan') : gates);
