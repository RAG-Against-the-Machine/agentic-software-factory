/**
 * The Conventional Commits type of a delivery, which images.yml turns into a semver
 * bump. The planner and the reviewer each end their artifact with a line
 * `Change-Type: <type>`; the reviewer's wins (it saw the final diff), then the
 * planner's. Neither (or an unknown value): `fix`.
 */
export const CHANGE_TYPES = ['fix', 'feat', 'feat!', 'chore', 'docs', 'refactor', 'test', 'ci'] as const;
export type ChangeType = typeof CHANGE_TYPES[number];

const LINE = /^[ \t*_`]*Change-Type[*_`]*[ \t]*:[ \t*_`]*([a-z]+!?)/gim;

/** The last valid `Change-Type:` value in `md`, or null. */
function readType(md: string | null | undefined): ChangeType | null {
  let found: ChangeType | null = null;
  for (const m of (md ?? '').matchAll(LINE)) {
    const v = m[1].toLowerCase();
    if ((CHANGE_TYPES as readonly string[]).includes(v)) found = v as ChangeType;
  }
  return found;
}

export function changeType(reviewMd: string | null | undefined, planMd: string | null | undefined): ChangeType {
  return readType(reviewMd) ?? readType(planMd) ?? 'fix';
}
