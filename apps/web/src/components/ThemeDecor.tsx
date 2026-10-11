import { useId } from 'react';
import { useTheme } from '../useTheme';
import { decorOf } from '../theme-view';

/**
 * The theme's faint corner pattern (the Hive's honeycomb). Pure decoration:
 * hidden from screen readers, never takes a click, drawn in the accent colour
 * and fading out from the top-right corner toward the page. A theme's decor
 * picture (`decor.png`) takes its place, in the same spot, fading the same way.
 */

const R = 22; // hexagon radius (centre to corner)
const H = Math.sqrt(3) * R; // flat-top hexagon height
const GAP = 2.5; // drawn a little smaller than the grid, so the cells read as comb

/** [column from the right edge, row from the top, filled]. Columns step 1.5R; odd ones drop half a cell. */
const CELLS: [number, number, boolean][] = [
  [0, 0, true], [0, 1, false], [0, 2, true], [0, 3, false],
  [1, 0, false], [1, 1, true], [1, 2, false],
  [2, 0, false], [2, 1, false],
  [3, 0, false],
];

function hexPoints(cx: number, cy: number, r: number): string {
  return [0, 60, 120, 180, 240, 300]
    .map((deg) => {
      const a = (deg * Math.PI) / 180;
      return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
    })
    .join(' ');
}

const HEXES = CELLS.map(([col, row, filled]) => ({
  points: hexPoints(240 - col * 1.5 * R, 20 + row * H + (col % 2 ? H / 2 : 0), R - GAP),
  filled,
}));

export function ThemeDecor() {
  const { theme, decorImage } = useTheme();
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  if (decorImage) return <img className="theme-decor picture" src={decorImage} alt="" aria-hidden="true" />;
  if (decorOf(theme) !== 'honeycomb') return null;
  const fade = `decor-fade-${id}`;
  const mask = `decor-mask-${id}`;
  return (
    <svg className="theme-decor" viewBox="116 0 144 160" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={fade} x1="1" y1="0" x2="0.15" y2="1">
          <stop offset="0" stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={mask}>
          <rect x="116" width="144" height="160" fill={`url(#${fade})`} />
        </mask>
      </defs>
      <g mask={`url(#${mask})`} stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round">
        {HEXES.map((h, i) => (
          <polygon key={i} points={h.points} fill={h.filled ? 'var(--accent)' : 'none'} />
        ))}
      </g>
    </svg>
  );
}
