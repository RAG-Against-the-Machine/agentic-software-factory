import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { THEME_ROLE_SLOTS, type ThemeManifest, type ThemeMood, type ThemeSlot } from '@asf/shared/ui';
import { useTheme } from '../useTheme';
import { hiveFocus, memberStates, pictureState, type FocusEvent, type FocusGate, type FocusRun, type FocusTask } from '../hive-focus';
import { memberName, moodLine, quipFor } from '../theme-view';
import { StillImage, usePrefersReducedMotion } from './StillImage';

const QUIP_EVERY_MS = 6000;
/** Arc order around the coordinator: two members either side. */
const LEFT: ThemeSlot[] = ['planner', 'implementer'];
const RIGHT: ThemeSlot[] = ['tester', 'reviewer'];
const BURST = 8;
/** A run that finished this recently still gets the delivery burst when its page is opened. */
const FRESH_DELIVERY_MS = 60_000;

/** A short name for the placeholder: "The Queen" → "Q", "Builder" → "B". */
export const initialOf = (name: string) => (name.replace(/^the\s+/i, '').trim()[0] ?? '?').toUpperCase();

export interface HiveStageProps {
  run: FocusRun & { finishedAt?: string | null };
  tasks: readonly FocusTask[];
  gates?: readonly FocusGate[];
  events?: readonly FocusEvent[];
}

/**
 * The Hive stage (M12 WP4): the coordinator in the middle, the four members in
 * an arc, and a caption saying what is going on. The member in the spotlight
 * grows, gets the accent ring and moves; everyone else is a still frame. When
 * the spotlight moves to a member, the theme's handoff glyph flies there from
 * the coordinator. A theme with no pictures at all (classic, out of the box)
 * renders as just the quiet caption line.
 */
export function HiveStage(props: HiveStageProps) {
  const { theme, pictureFor, hasStatePictures } = useTheme();
  const reduced = usePrefersReducedMotion();
  const terminal = ['succeeded', 'failed', 'halted', 'cancelled', 'stale'].includes(props.run.state);
  const now = useNow(terminal ? null : 1000);
  const f = hiveFocus({ ...props, now });
  const states = memberStates(props.tasks);
  const hasPictures = (['orchestrator', ...THEME_ROLE_SLOTS] as ThemeSlot[]).some((s) => pictureFor(s));

  const running = props.tasks.find((t) => t.state === 'running' && t.role === f.member);
  const since = running?.startedAt ? Math.max(0, now - Date.parse(running.startedAt)) : 0;
  const caption = stageCaption(theme, f.mood, f.member, since / QUIP_EVERY_MS);
  const announcement = stageCaption(theme, f.mood, f.member, 0);

  const stage = useRef<HTMLDivElement>(null);
  const flight = useHandoffFlight(stage, f.focus, reduced || !hasPictures);
  const burst = useDeliveryBurst(f.mood, props.run.finishedAt ?? null, reduced || !hasPictures);
  const glyph = theme.handoffGlyph ?? null;

  const live = <span className="sr-only" aria-live="polite">{announcement}</span>;
  if (!hasPictures) {
    return (
      <div className={`hive-quiet mood-${f.mood}`}>
        <span className={`dot ${f.mood === 'failed' ? 'failed' : f.mood === 'delivered' ? 'done' : 'running'}`} />
        <span aria-hidden="true">{caption}</span>
        {live}
      </div>
    );
  }

  const member = (slot: ThemeSlot) => {
    const name = memberName(theme, slot) ?? slot;
    const state = slot === 'orchestrator' ? null : states[slot] ?? 'pending';
    const pic = pictureState(slot, f, state ?? undefined);
    const url = pictureFor(slot, pic);
    const own = hasStatePictures(slot);
    const on = f.focus === slot;
    // A member with its own idle / working / done loops always plays the one it is in (M13). Otherwise only the
    // spotlit member moves (and the coordinator while handing over). A stopped job keeps everyone still.
    const animate = !reduced && f.mood !== 'failed' && (own || on || (slot === 'orchestrator' && f.mood === 'handoff'));
    const cls = ['hive-member', slot === 'orchestrator' ? 'lead' : '', on ? 'on' : '', state ? `st-${state}` : '', own ? 'own-states' : ''].filter(Boolean).join(' ');
    return (
      <div className={cls} key={slot} data-slot={slot} data-picture={pic}>
        <span className="hive-pic">
          {url
            ? <StillImage src={url} animate={animate} className={`hive-img${own ? ' whole' : ''}`} />
            : <span className="hive-img hive-initial" aria-hidden="true">{initialOf(name)}</span>}
        </span>
        <span className="hive-name">{name}</span>
      </div>
    );
  };

  return (
    <div className={`hive-stage mood-${f.mood}${reduced ? ' still' : ''}`} ref={stage}>
      <div className="hive-row">
        {LEFT.map(member)}
        {member('orchestrator')}
        {RIGHT.map(member)}
      </div>
      {flight && (
        <span key={flight.key} className={`hive-glyph${glyph ? '' : ' dot-glyph'}`} aria-hidden="true"
          style={{ left: flight.x0, top: flight.y0, ['--dx' as string]: `${flight.dx}px`, ['--dy' as string]: `${flight.dy}px` }}>
          {glyph}
        </span>
      )}
      {burst !== null && Array.from({ length: BURST }, (_, i) => (
        <span key={`${burst}-${i}`} className={`hive-glyph burst${glyph ? '' : ' dot-glyph'}`} aria-hidden="true"
          style={{ ['--a' as string]: `${(360 / BURST) * i}deg` }}>
          {glyph}
        </span>
      ))}
      <div className="hive-caption" aria-hidden="true">{caption}</div>
      {live}
    </div>
  );
}

/** Working shows the member's rotating quip; every other mood its mood line. */
export function stageCaption(theme: ThemeManifest, mood: ThemeMood, member: ThemeSlot | null, tick: number): string {
  if (mood === 'working' && member) return `${quipFor(theme, member, tick)}…`;
  return moodLine(theme, mood, { member: member ? memberName(theme, member) ?? member : undefined });
}

/** A clock that ticks every `everyMs` (or stands still when null, e.g. a finished run). */
function useNow(everyMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (everyMs == null) return;
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

interface Flight { key: number; x0: number; y0: number; dx: number; dy: number }

/**
 * When the spotlight moves from the coordinator (or another member) to a member,
 * one glyph flies from the coordinator's picture to theirs. Measured from the
 * DOM after layout, so it follows whatever arrangement the CSS chose (arc or the
 * stacked mobile row). Not on first render: opening a page is not a handoff.
 */
function useHandoffFlight(stage: React.RefObject<HTMLDivElement | null>, focus: ThemeSlot, off: boolean): Flight | null {
  const prev = useRef<ThemeSlot | null>(null);
  const [flight, setFlight] = useState<Flight | null>(null);
  useLayoutEffect(() => {
    const was = prev.current;
    prev.current = focus;
    if (off || was === null || was === focus || focus === 'orchestrator' || !stage.current) return;
    const root = stage.current.getBoundingClientRect();
    const pic = (slot: string) => stage.current?.querySelector(`[data-slot="${slot}"] .hive-pic`)?.getBoundingClientRect();
    const from = pic('orchestrator');
    const to = pic(focus);
    if (!from || !to) return;
    const c = (r: DOMRect) => ({ x: r.left + r.width / 2 - root.left, y: r.top + r.height / 2 - root.top });
    const a = c(from), b = c(to);
    setFlight({ key: Date.now(), x0: a.x, y0: a.y, dx: b.x - a.x, dy: b.y - a.y });
    const id = setTimeout(() => setFlight(null), 900);
    return () => clearTimeout(id);
  }, [focus, off, stage]);
  return flight;
}

/** One burst of glyphs when the job is delivered: on the transition, or on opening a just-finished run. */
function useDeliveryBurst(mood: ThemeMood, finishedAt: string | null, off: boolean): number | null {
  const prev = useRef<ThemeMood | null>(null);
  const [burst, setBurst] = useState<number | null>(null);
  useEffect(() => {
    const was = prev.current;
    prev.current = mood;
    if (off || mood !== 'delivered' || was === 'delivered') return;
    const fresh = was !== null || (finishedAt != null && Date.now() - Date.parse(finishedAt) < FRESH_DELIVERY_MS);
    if (!fresh) return;
    setBurst(Date.now());
    const id = setTimeout(() => setBurst(null), 1600);
    return () => clearTimeout(id);
  }, [mood, finishedAt, off]);
  return burst;
}
