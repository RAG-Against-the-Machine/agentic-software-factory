import type { TeamTemplate, Role, EffortLevel, ModelCatalogue, ModelInfo } from '@asf/shared';
import { isKnownModel, modelIds, isKnownEffort, EFFORT_LEVELS, mergeCatalogue } from '@asf/shared';
import { cfg } from './settings.js';

export class BadModelError extends Error {}
export class BadEffortError extends Error {}

/** Org-tier defaults keyed by role (from MODEL_DEFAULT_<ROLE>); blank/absent = use the template. */
export type OrgRoleModels = Partial<Record<Role, string | null | undefined>>;
/** Org-tier per-role effort (from EFFORT_DEFAULT_<ROLE>); blank/absent = use the template. */
export type OrgRoleEfforts = Partial<Record<Role, string | null | undefined>>;
/** Org-tier per-role runtime (from RUNTIME_DEFAULT_<ROLE>); blank/absent = use the template. */
export type OrgRoleRuntimes = Partial<Record<Role, string | null | undefined>>;

/**
 * The model catalogue a dispatch validates against: the built-ins merged with
 * MODEL_CATALOG_EXTRA. Read on every call, so an /admin edit applies to the next
 * dispatch with no restart.
 */
export function catalogue(): ModelCatalogue {
  return mergeCatalogue(cfg('MODEL_CATALOG_EXTRA'));
}

/** Per-role runtime inputs, and the catalogue to validate against (default: catalogue()). */
export interface RuntimeInputs {
  org?: OrgRoleRuntimes;
  request?: Partial<Record<Role, string>>;
  models?: ModelInfo[];
}

/**
 * The model, effort AND runtime each role runs with: request override > org
 * setting > template default, resolved together into a NEW template (the shared
 * constant is never mutated) so createRun stores the actual choices on each
 * run_task — the audit trail for "why did this cost what it cost".
 *
 * Only catalogue model ids and known effort levels are accepted, from either
 * tier, and each role's model must list that role's runtime; a bad value is
 * refused before any run is created.
 */
export function resolveRoleModels(
  team: TeamTemplate,
  org: OrgRoleModels,
  request: Partial<Record<Role, string>> | undefined,
  orgEfforts: OrgRoleEfforts = {},
  effortRequest: Partial<Record<Role, string>> | undefined = undefined,
  runtimes: RuntimeInputs = {},
): TeamTemplate {
  const models = runtimes.models ?? catalogue().models;
  const pickModel = (role: Role, template: string | null): { id: string | null; source: string } => {
    const fromRequest = request?.[role];
    if (fromRequest) return { id: check(role, fromRequest, 'dispatch', models), source: 'dispatch' };
    const fromOrg = org[role];
    if (fromOrg) return { id: check(role, fromOrg, 'org setting', models), source: 'org setting' };
    return { id: template, source: 'team template' };
  };
  const pickEffort = (role: Role, template: string | null): string | null => {
    const fromRequest = effortRequest?.[role];
    if (fromRequest) return checkEffort(role, fromRequest, 'dispatch');
    const fromOrg = orgEfforts[role];
    if (fromOrg) return checkEffort(role, fromOrg, 'org setting');
    return template;
  };
  const pickRuntime = (role: Role, template: string): string =>
    runtimes.request?.[role] || runtimes.org?.[role] || template;
  return {
    ...team,
    roles: team.roles.map((r) => {
      const model = pickModel(r.role, r.model);
      const runtime = pickRuntime(r.role, r.runtime);
      if (model.id) checkPair(r.role, model.id, model.source, runtime, models);
      return { ...r, model: model.id, effort: pickEffort(r.role, r.effort), runtime };
    }),
  };
}

function check(role: Role, id: string, source: string, models: ModelInfo[]): string {
  if (!isKnownModel(id, models)) {
    throw new BadModelError(`unknown model "${id}" for ${role} (from ${source}); choose one of ${modelIds(models).join(', ')}`);
  }
  return id;
}

function checkPair(role: Role, id: string, source: string, runtime: string, models: ModelInfo[]): void {
  const m = models.find((x) => x.id === check(role, id, source, models))!;
  if (!m.runtimes.includes(runtime)) {
    throw new BadModelError(`model "${id}" for ${role} (from ${source}) cannot run on runtime "${runtime}"; it runs on ${m.runtimes.join(', ')}`);
  }
}

function checkEffort(role: Role, e: string, source: string): EffortLevel {
  if (!isKnownEffort(e)) {
    throw new BadEffortError(`unknown effort "${e}" for ${role} (from ${source}); choose one of ${EFFORT_LEVELS.join(', ')}`);
  }
  return e;
}

/** The per-role defaults a dispatch would use with no request overrides — what the UI pre-selects. */
export function defaultRoleModels(team: TeamTemplate, org: OrgRoleModels, orgEfforts: OrgRoleEfforts = {}, runtimes: Omit<RuntimeInputs, 'request'> = {}): { models: Record<string, string | null>; efforts: Record<string, string | null>; runtimes: Record<string, string> } {
  const resolved = resolveRoleModels(team, org, undefined, orgEfforts, undefined, runtimes);
  const models: Record<string, string | null> = {};
  const efforts: Record<string, string | null> = {};
  const rts: Record<string, string> = {};
  for (const r of resolved.roles) { models[r.role] = r.model; efforts[r.role] = r.effort; rts[r.role] = r.runtime; }
  return { models, efforts, runtimes: rts };
}

/**
 * Fold per-dispatch role skills onto the team roles for THIS run. Free text, so
 * no validation beyond trim; a blank string clears to null. Returns a NEW team
 * (never mutates the shared constant). This is the per-run addition that the
 * worker appends AFTER the org-tier ROLE_SKILL_<ROLE> blob delivered on the
 * RunContext — mirrors how resolveRoleModels sets per-run model/effort.
 */
export function applyRoleSkills(team: TeamTemplate, request: Partial<Record<Role, string>> | undefined): TeamTemplate {
  if (!request) return team;
  return {
    ...team,
    roles: team.roles.map((r) => {
      const raw = request[r.role];
      if (raw === undefined) return r;
      const trimmed = raw.trim();
      return { ...r, skill: trimmed === '' ? null : trimmed };
    }),
  };
}
