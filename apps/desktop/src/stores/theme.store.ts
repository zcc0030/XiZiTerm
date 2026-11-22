import { create } from 'zustand';
import {
  DEFAULT_THEME_ID,
  getThemeDefinition,
  LEGACY_THEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
  THEMES,
  type ThemeDefinition,
  type ThemeId,
} from '@/theme/themes';

function loadInitialTheme(): ThemeId {
  try {
    const raw =
      window.localStorage.getItem(THEME_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
    if (raw && THEMES.some((t) => t.id === raw)) {
      return raw as ThemeId;
    }
  } catch {
    // ignore storage errors
  }
  return DEFAULT_THEME_ID;
}

export function applyThemeToDom(themeId: ThemeId): void {
  if (typeof document === 'undefined') return;
  const def = getThemeDefinition(themeId);
  document.documentElement.setAttribute('data-theme', def.id);
  document.documentElement.classList.toggle('dark', !def.isLight);
}

const initialThemeId = loadInitialTheme();
applyThemeToDom(initialThemeId);

interface ThemeStoreState {
  themeId: ThemeId;
  theme: ThemeDefinition;
  setTheme: (id: ThemeId) => void;
}

export const useThemeStore = create<ThemeStoreState>((set) => ({
  themeId: initialThemeId,
  theme: getThemeDefinition(initialThemeId),
  setTheme: (id) => {
    const def = getThemeDefinition(id);
    applyThemeToDom(def.id);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, def.id);
    } catch {
      // ignore storage errors
    }
    set({ themeId: def.id, theme: def });
  },
}));
