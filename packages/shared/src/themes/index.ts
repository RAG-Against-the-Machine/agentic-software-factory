import type { ThemeManifest } from '../theme.js';
import { CLASSIC_THEME } from './classic.js';
import { HIVE_THEME } from './hive.js';

export { CLASSIC_THEME, HIVE_THEME };

/** Themes that ship with the factory. Custom themes may not reuse these ids. */
export const BUILT_IN_THEMES: readonly ThemeManifest[] = [CLASSIC_THEME, HIVE_THEME];
export const DEFAULT_THEME_ID = CLASSIC_THEME.id;
export const builtInTheme = (id: string): ThemeManifest | undefined => BUILT_IN_THEMES.find((t) => t.id === id);
