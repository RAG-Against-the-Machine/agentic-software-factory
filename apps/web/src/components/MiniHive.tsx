import { isThemeSlot, THEME_ROLE_SLOTS, type ThemeManifest, type ThemeSlot } from '@asf/shared/ui';
import type { RunningRunWire } from '@asf/shared';
import { useTheme } from '../useTheme';
import { hiveFocus, pictureState } from '../hive-focus';
import { memberName } from '../theme-view';
import { stageLabel } from '../words';
import { StillImage, usePrefersReducedMotion } from './StillImage';
import { initialOf } from './HiveStage';

/** What each stage is called while it is happening, for "Builder is writing code". */
const DOING: Record<string, string> = {
  planner: 'planning', implementer: 'writing code', tester: 'testing', reviewer: 'reviewing',
};

/**
 * "Builder is writing code", "The Queen is delivering", "Planning". Plain text
 * from the theme's names. Classic's names are the stage names themselves, so
 * there it reads like the plain stage ("Writing code").
 */
export function miniHiveLine(theme: ThemeManifest, activeRole: string | null): string {
  if (!activeRole) return `${memberName(theme, 'orchestrator') ?? 'Coordinator'} is lining up the next step`;
  if (activeRole.startsWith('publish:')) return `${memberName(theme, 'orchestrator') ?? 'Coordinator'} is delivering`;
  const doing = DOING[activeRole] ?? stageLabel(activeRole).toLowerCase();
  const name = memberName(theme, activeRole);
  const plain = isThemeSlot(activeRole) && theme.id === 'classic';
  if (!name || plain) return doing[0].toUpperCase() + doing.slice(1);
  return `${name} is ${doing}`;
}

/**
 * The mini-Hive on a "Working on now" row (M12 WP5): a 20px strip of the
 * coordinator and the four members. Whoever is on the task is animated with
 * the accent ring; done members are grey, not-started ones faded. A member
 * with its own idle / working / done pictures shows the one it is in instead
 * (still, unless it has the work). Uses the
 * same immutable picture URLs as everywhere else, so a page full of rows costs
 * one download per picture. No pictures at all: the running dot it replaced.
 */
export function MiniHive({ run }: { run: Pick<RunningRunWire, 'state' | 'activeRole' | 'activeSince' | 'roleStates'> }) {
  const { theme, pictureFor, hasStatePictures } = useTheme();
  const reduced = usePrefersReducedMotion();
  const slots: ThemeSlot[] = ['orchestrator', ...THEME_ROLE_SLOTS];
  const hasPictures = slots.some((s) => pictureFor(s));
  const roleStates = run.roleStates ?? {};
  const tasks = Object.entries(roleStates).map(([role, state]) => ({ role, state, startedAt: role === run.activeRole ? run.activeSince : null }));
  const f = hiveFocus({ run, tasks });
  const { focus } = f;
  const line = miniHiveLine(theme, run.activeRole ?? null);

  if (!hasPictures) return <span className="mini-hive-line"><span className="dot running" />{line}</span>;
  return (
    <span className="mini-hive-line">
      <span className="mini-hive" aria-hidden="true">
        {slots.map((slot) => {
          const state = slot === 'orchestrator' ? null : roleStates[slot] ?? 'pending';
          const pic = pictureState(slot, f, state ?? undefined);
          const url = pictureFor(slot, pic);
          const own = hasStatePictures(slot);
          const on = focus === slot;
          const cls = ['mini-member', on ? 'on' : '', state ? `st-${state}` : '', slot === 'orchestrator' ? 'lead' : '', own ? 'own-states' : ''].filter(Boolean).join(' ');
          return (
            <span key={slot} className={cls} title={memberName(theme, slot) ?? slot} data-picture={pic}>
              {url
                ? <StillImage src={url} animate={on && !reduced} className={`mini-img${own ? ' whole' : ''}`} />
                : <span className="mini-img mini-initial">{initialOf(memberName(theme, slot) ?? slot)}</span>}
            </span>
          );
        })}
      </span>
      <span>{line}</span>
    </span>
  );
}
