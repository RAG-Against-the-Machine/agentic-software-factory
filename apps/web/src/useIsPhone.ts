import { useEffect, useState } from 'react';

/** The phone breakpoint, matching the `max-width: 639px` block in styles.css. */
export const PHONE_QUERY = '(max-width: 639px)';

/**
 * True below 640px. The bell and status chips render in exactly one place (top
 * bar on phones, sidebar footer otherwise) so their polling isn't doubled.
 */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return phone;
}
