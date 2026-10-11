import { useTheme } from '../useTheme';
import { memberName } from '../theme-view';

/**
 * A crew member's picture from the active theme (M12). `slot` is a role or
 * 'orchestrator'. With no picture: the small size falls back to the status dot it
 * always was; the large size renders nothing (the working line has its own dots).
 * The name rides along as a tooltip for anyone who wonders who the bee is.
 * Without a plain picture, a member with state pictures shows its idle one.
 */
export function MemberAvatar({ slot, state, size = 'sm' }: { slot: string; state?: string; size?: 'sm' | 'lg' }) {
  const { theme, pictureFor, hasStatePictures } = useTheme();
  const url = pictureFor(slot);
  if (!url) return size === 'sm' ? <span className={`dot ${state ?? ''}`} /> : null;
  const name = memberName(theme, slot);
  // A member with idle / working / done pictures (M13) is shown whole on white, like everywhere else they appear.
  const whole = hasStatePictures(slot) ? ' whole' : '';
  return <img className={`avatar ${size}${whole} ${state ?? ''}`} src={url} alt="" aria-hidden="true" title={name ?? undefined} />;
}
