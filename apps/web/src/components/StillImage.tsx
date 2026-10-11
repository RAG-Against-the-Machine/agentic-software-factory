import { useEffect, useRef, useState } from 'react';

/**
 * A crew picture that moves only when it should (M12 WP4). `animate` shows the
 * live <img> (an animated GIF/WebP plays); otherwise the first frame is drawn
 * once onto a <canvas>, which freezes it. Theme pictures are same-origin, so the
 * canvas is never tainted; if drawing fails anyway, the live image is shown.
 */
export function StillImage({ src, animate, className, alt = '' }: { src: string; animate: boolean; className?: string; alt?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    if (animate || drawn === src || broken) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled || !canvas.current) return;
      try {
        const c = canvas.current;
        c.width = img.naturalWidth || 96;
        c.height = img.naturalHeight || 96;
        const ctx = c.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0);
        setDrawn(src);
      } catch {
        setBroken(true);
      }
    };
    img.onerror = () => { if (!cancelled) setBroken(true); };
    img.src = src;
    return () => { cancelled = true; };
  }, [src, animate, drawn, broken]);

  if (animate || broken) return <img className={className} src={src} alt={alt} aria-hidden={alt ? undefined : true} />;
  return <canvas ref={canvas} className={className} role={alt ? 'img' : undefined} aria-label={alt || undefined} aria-hidden={alt ? undefined : true} />;
}

/** True when the visitor asked the system for less motion; follows changes live. */
export function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}
